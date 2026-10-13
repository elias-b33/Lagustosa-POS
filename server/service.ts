import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Actor, Allocation, Bootstrap, BusinessDay, DayReport, Device, DiningTable, MenuItem, OrderLine, Payment, PaymentStatus, PrintJob, Receipt, Settings, Staff, Station, Tab, Ticket } from '../shared/types';
import { calculateTab, distribute, paidOre, roundRatio, taxRate } from '../shared/money';
import { Store, digest, hashPin, verifyPin } from './db';
import { AppError, demand } from './errors';
import type { PaymentAdapter, FiscalAdapter, PrintAdapter } from './adapters';
import { PreviewPrintAdapter, SimulatorFiscalAdapter, SimulatorPaymentAdapter } from './adapters';
import { seed, type StoredDevice, type StoredStaff } from './seed';
import type { PaymentInput, RefundInput, TabCommand } from './validation';
import { closingText, receiptText, ticketText } from './printing';

interface ServiceOptions {
  now?: () => Date; notify?: () => void; backupDir?: string;
  payment?: PaymentAdapter; fiscal?: FiscalAdapter; printer?: PrintAdapter;
}
interface SessionResult { actor: Actor; token: string; expiresAt: string }
const workingRoles = ['admin', 'cashier', 'waiter'];
const authorizedRoles = ['admin', 'cashier'];
const reservedStatuses = ['approved', 'pending', 'unknown'];

export class KassaService {
  readonly paymentAdapter: PaymentAdapter;
  readonly fiscalAdapter: FiscalAdapter;
  readonly printAdapter: PrintAdapter;
  private now: () => Date;
  private notify: () => void;
  private backupDir: string;
  private backingUp = false;
  private fiscalInFlight = new Set<string>();

  constructor(readonly store: Store, options: ServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.notify = options.notify ?? (() => {});
    this.backupDir = options.backupDir ?? path.resolve('data/backups');
    this.paymentAdapter = options.payment ?? new SimulatorPaymentAdapter(store);
    this.fiscalAdapter = options.fiscal ?? new SimulatorFiscalAdapter(store);
    this.printAdapter = options.printer ?? new PreviewPrintAdapter();
    seed(store);
    this.store.atomic(() => {
      for (const payment of this.store.all<Payment>('payment').filter(entry => entry.status === 'pending')) {
        this.store.put('payment', { ...payment, status: 'unknown', updatedAt: this.timestamp() });
        this.log('system', 'payment.recovered_unknown', payment.id, {});
      }
      for (const receipt of this.store.all<Receipt>('receipt').filter(entry => entry.fiscalStatus === 'pending')) {
        this.store.put('receipt', { ...receipt, fiscalStatus: 'unknown' });
        this.log('system', 'fiscal.recovered_unknown', receipt.id, {});
      }
      for (const job of this.store.all<PrintJob>('print').filter(entry => entry.status === 'printing')) {
        this.store.put('print', { ...job, status: 'uncertain' });
        this.log('system', 'print.recovered_uncertain', job.id, {});
      }
      this.log('system', 'server.start', 'server', { mode: 'training' });
    });
  }
  timestamp(): string { return this.now().toISOString(); }
  date(): string { return this.now().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' }); }
  log(actor: Actor | string, action: string, entityId: string, details: unknown): void {
    this.store.audit(typeof actor === 'string' ? actor : `${actor.staff.id}@${actor.device.id}`, action, entityId, details, this.timestamp());
  }
  settings(): Settings { return this.store.get<Settings>('settings', 'settings')!; }
  publicStaff(): Staff[] { return this.store.all<StoredStaff>('staff').map(({ pinHash: _pinHash, ...staff }) => staff); }
  publicDevices(): Device[] { return this.store.all<StoredDevice>('device').map(({ codeHash: _codeHash, ...device }) => device); }
  require(actor: Actor, roles: string[], main = false): void {
    demand(roles.includes(actor.staff.role), 'Du saknar behörighet för detta.', 403, 'FORBIDDEN');
    if (main) demand(actor.device.kind === 'main', 'Detta görs vid huvudkassan.', 403, 'MAIN_REQUIRED');
  }
  currentDay(): BusinessDay | null { return this.store.all<BusinessDay>('day').find(day => day.status === 'open') ?? null; }
  requireDay(): BusinessDay {
    const day = this.currentDay();
    demand(day, 'Öppna en verksamhetsdag vid huvudkassan först.', 409, 'DAY_CLOSED');
    return day;
  }
  tab(id: string): Tab {
    const tab = this.store.get<Tab>('tab', id);
    demand(tab, 'Notan finns inte.', 404, 'NOT_FOUND');
    return tab;
  }
  version(tab: Tab, version: number): void {
    demand(tab.version === version, 'Notan har ändrats på en annan enhet. Hämta den senaste versionen.', 409, 'VERSION_CONFLICT');
  }
  command<T>(key: string, input: unknown, action: string, actor: Actor, operation: () => T): T {
    const fingerprint = digest(JSON.stringify([action, actor.staff.id, input]));
    const result = this.store.atomic(() => {
      const existing = this.store.db.prepare('SELECT fingerprint,body FROM commands WHERE key=?').get(key) as { fingerprint: string; body: string } | undefined;
      if (existing) {
        demand(existing.fingerprint === fingerprint, 'Identifieraren har redan använts för en annan ändring.', 409, 'KEY_REUSED');
        return JSON.parse(existing.body) as T;
      }
      const value = operation();
      this.store.db.prepare('INSERT INTO commands(key,fingerprint,body) VALUES(?,?,?)').run(key, fingerprint, JSON.stringify(value));
      return value;
    });
    this.notify();
    return result;
  }
  login(staffId: string, pin: string, deviceCode: string, ip: string): SessionResult {
    const key = digest(`${ip}:${staffId}`);
    const attempt = this.store.db.prepare('SELECT attempts,blocked_until AS until FROM login_attempts WHERE key=?').get(key) as { attempts: number; until: string } | undefined;
    demand(!attempt || attempt.attempts < 5 || attempt.until <= this.timestamp(), 'För många PIN-försök. Försök igen om 15 minuter.', 429, 'LOGIN_THROTTLED');
    const staff = this.store.get<StoredStaff>('staff', staffId);
    const device = this.store.all<StoredDevice>('device').find(entry => entry.codeHash === digest(deviceCode.toUpperCase().trim()));
    if (!staff?.active || !device?.active || !verifyPin(pin, staff.pinHash)) {
      const attempts = attempt && attempt.until > this.timestamp() ? attempt.attempts + 1 : 1;
      this.store.db.prepare('INSERT INTO login_attempts(key,attempts,blocked_until) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,blocked_until=excluded.blocked_until').run(key, attempts, new Date(this.now().getTime() + 15 * 60000).toISOString());
      throw new AppError(401, 'LOGIN_FAILED', 'Fel PIN eller enhetskod.');
    }
    if (device.kind === 'display') demand(staff.role === device.station || staff.role === 'admin', 'Använd stationens personalprofil på orderskärmen.', 403, 'STATION_REQUIRED');
    if (staff.role === 'kitchen' || staff.role === 'bar') demand(device.kind === 'display' && device.station === staff.role, 'Använd en orderskärm som hör till din station.', 403, 'STATION_REQUIRED');
    this.store.db.prepare('DELETE FROM login_attempts WHERE key=?').run(key);
    this.store.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(this.timestamp());
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + 16 * 3600000).toISOString();
    this.store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token), staff.id, device.id, expiresAt);
    const { pinHash: _pinHash, ...publicStaff } = staff;
    const { codeHash: _codeHash, ...publicDevice } = device;
    const actor = { staff: publicStaff, device: publicDevice };
    this.log(actor, 'auth.login', staff.id, {});
    return { token, expiresAt, actor };
  }
  session(token: string | undefined): Actor {
    demand(token, 'Logga in för att fortsätta.', 401, 'UNAUTHENTICATED');
    const session = this.store.db.prepare('SELECT staff_id AS staffId,device_id AS deviceId FROM sessions WHERE token_hash=? AND expires_at>?').get(digest(token), this.timestamp()) as { staffId: string; deviceId: string } | undefined;
    demand(session, 'Din session har gått ut. Logga in igen.', 401, 'UNAUTHENTICATED');
    const staff = this.publicStaff().find(candidate => candidate.id === session.staffId);
    const device = this.publicDevices().find(candidate => candidate.id === session.deviceId);
    demand(staff?.active && device?.active, 'Kontot eller enheten är avstängd.', 401, 'UNAUTHENTICATED');
    if (device.kind === 'display') demand(staff.role === device.station || staff.role === 'admin', 'Enhetens station har ändrats. Logga in igen.', 401, 'UNAUTHENTICATED');
    return { staff, device };
  }
  logout(token: string, actor: Actor): void {
    this.store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
    this.log(actor, 'auth.logout', actor.staff.id, {});
  }
  bootstrap(actor: Actor): Bootstrap {
    const station = actor.device.kind === 'display' ? actor.device.station : actor.staff.role === 'kitchen' || actor.staff.role === 'bar' ? actor.staff.role : null;
    const currentDay = this.currentDay();
    const backup = this.store.get<{ lastAt: string | null; error: string | null }>('meta', 'backup') ?? { lastAt: null, error: null };
    return {
      mode: 'training', actor, menu: this.store.all<MenuItem>('menu'), tables: this.store.all<DiningTable>('table'),
      tabs: station ? [] : this.store.all<Tab>('tab'), tickets: this.store.all<Ticket>('ticket').filter(ticket => !station || ticket.station === station),
      payments: station ? [] : this.store.all<Payment>('payment'), receipts: station ? [] : this.store.all<Receipt>('receipt'),
      printJobs: authorizedRoles.includes(actor.staff.role) && !station ? this.store.all<PrintJob>('print') : [],
      days: station ? [] : this.store.all<BusinessDay>('day'), currentDay,
      report: currentDay && authorizedRoles.includes(actor.staff.role) && !station ? this.report(currentDay.id) : null,
      settings: this.settings(), staff: actor.staff.role === 'admin' ? this.publicStaff() : [actor.staff], devices: actor.staff.role === 'admin' ? this.publicDevices() : [actor.device],
      backup: { ...backup, external: path.parse(path.resolve(this.backupDir)).root.toLowerCase() !== path.parse(path.resolve(this.store.filename)).root.toLowerCase() },
    };
  }
  createTab(actor: Actor, input: { key: string; tableId: string | null; guestCount: number; serviceMode: 'dine_in' | 'takeaway' }): Tab {
    this.require(actor, workingRoles);
    demand(actor.device.kind !== 'display', 'Orderskärmar tar inte nya beställningar.', 403);
    return this.command(input.key, input, 'tab.create', actor, () => {
      const day = this.requireDay();
      const table = input.tableId ? this.freeTable(input.tableId) : null;
      demand(!table || input.serviceMode === 'dine_in', 'Avhämtning ska använda en disknota.');
      const number = this.store.next('tab');
      const tab: Tab = { id: randomUUID(), dayId: day.id, number, tableId: input.tableId, label: table?.name ?? `${input.serviceMode === 'takeaway' ? 'Avhämtning' : 'Disk'} ${number}`, guestCount: input.guestCount, serviceMode: input.serviceMode, status: 'open', version: 1, lines: [], discountBps: 0, discountReason: '', openedAt: this.timestamp(), updatedAt: this.timestamp(), openedBy: actor.staff.id };
      this.store.put('tab', tab);
      this.log(actor, 'tab.create', tab.id, { tab });
      return tab;
    });
  }
  freeTable(id: string, ownTabId?: string): DiningTable {
    const table = this.store.get<DiningTable>('table', id);
    demand(table?.active, 'Bordet är inte tillgängligt.');
    demand(!this.store.all<Tab>('tab').some(tab => tab.tableId === id && tab.status === 'open' && tab.id !== ownTabId), 'Bordet har redan en öppen nota.', 409, 'TABLE_OCCUPIED');
    return table;
  }
  updateTab(actor: Actor, id: string, input: TabCommand): Tab {
    this.require(actor, workingRoles);
    demand(actor.device.kind !== 'display', 'Orderskärmar ändrar beställningar genom stationsvyn.', 403);
    const { version: _version, ...fingerprintInput } = input;
    return this.command(input.key, [id, fingerprintInput], 'tab.command', actor, () => {
      this.requireDay();
      const tab = this.tab(id);
      this.version(tab, input.version);
      demand(tab.status === 'open', 'En avslutad nota rättas med en retur.', 409, 'TAB_CLOSED');
      const payments = this.store.all<Payment>('payment').filter(payment => payment.tabId === id && payment.kind === 'sale' && reservedStatuses.includes(payment.status));
      if (!['send', 'fire'].includes(input.action)) demand(payments.length === 0, 'Betalningen har påbörjats. Slutför notan innan fler ändringar görs.', 409, 'TAB_LOCKED');
      const before = structuredClone(tab);
      if (input.action === 'add') {
        demand(input.itemId, 'Välj en artikel.');
        const item = this.store.get<MenuItem>('menu', input.itemId);
        demand(item?.available, 'Artikeln är inte tillgänglig.');
        const chosenIds = input.modifiers ?? [];
        demand(new Set(chosenIds).size === chosenIds.length, 'Ett tillval får bara väljas en gång.');
        const options = item.modifiers.flatMap(group => group.options);
        demand(chosenIds.every(optionId => options.some(option => option.id === optionId)), 'Tillvalet finns inte på artikeln.');
        for (const group of item.modifiers) {
          const count = group.options.filter(option => chosenIds.includes(option.id)).length;
          demand(count >= group.min && count <= group.max, `Välj ${group.min}–${group.max} tillval för ${group.name}.`);
        }
        const guest = input.guest ?? 1;
        demand(guest <= tab.guestCount, 'Gästen finns inte på notan.');
        const modifiers = options.filter(option => chosenIds.includes(option.id));
        const baseUnitOre = tab.serviceMode === 'takeaway' ? item.takeawayPriceOre ?? item.priceOre : item.priceOre;
        const course = input.course ?? item.course;
        const line: OrderLine = { id: randomUUID(), itemId: item.id, name: item.name, quantity: input.quantity ?? 1, guest, baseUnitOre, unitPriceOre: baseUnitOre + modifiers.reduce((sum, modifier) => sum + modifier.priceOre, 0), vatBps: taxRate(this.settings().taxRules, item.taxClass, tab.serviceMode, this.date()), course, station: item.station, modifiers: structuredClone(modifiers), notes: input.notes ?? '', status: input.hold ?? course === 'main' ? 'held' : 'draft', createdAt: this.timestamp() };
        tab.lines.push(line);
        demand(tab.lines.length <= 1000 && calculateTab(tab).grossOre <= 100000000, 'Notan är för stor.');
      } else if (input.action === 'remove') {
        const line = tab.lines.find(candidate => candidate.id === input.lineId);
        demand(line && line.status !== 'void', 'Raden finns inte.');
        if (!['draft', 'held'].includes(line.status)) {
          this.require(actor, authorizedRoles);
          demand(input.reason && input.reason.trim().length >= 3, 'Ange orsak till makuleringen.');
          this.makeTickets(tab, [line], actor, 'cancel', input.reason);
        }
        line.status = 'void';
      } else if (input.action === 'send' || input.action === 'fire') {
        const lines = tab.lines.filter(line => input.action === 'send' ? line.status === 'draft' : line.status === 'held' && line.course === (input.course ?? 'main'));
        demand(lines.length > 0, 'Det finns inga nya rätter att skicka.');
        for (const line of lines) line.status = 'sent';
        this.makeTickets(tab, lines, actor);
      } else if (input.action === 'move') {
        demand(input.tableId !== undefined, 'Välj ett bord.');
        const table = input.tableId ? this.freeTable(input.tableId, tab.id) : null;
        demand(!table || tab.serviceMode === 'dine_in', 'En avhämtningsnota kan inte flyttas till ett bord.');
        tab.tableId = input.tableId;
        tab.label = table?.name ?? `Disk ${tab.number}`;
        if (tab.label !== before.label) {
          const stations = new Set<Station>();
          for (const ticket of this.store.all<Ticket>('ticket').filter(ticket => ticket.tabId === tab.id && ticket.status !== 'served')) {
            ticket.movedFrom = before.label;
            ticket.tabLabel = tab.label;
            ticket.updatedAt = this.timestamp();
            this.store.put('ticket', ticket);
            for (const job of this.store.all<PrintJob>('print').filter(job => job.sourceId === ticket.id && job.status === 'queued')) {
              this.store.put('print', { ...job, text: ticketText(ticket) });
            }
            stations.add(ticket.station);
          }
          for (const station of stations) this.queuePrint(station, tab.id, `TEST · FLYTT AV BORD\n${before.label} → ${tab.label}\nAlla pågående beställningar hör nu till ${tab.label}.`);
          this.log(actor, 'ticket.table_moved', tab.id, { from: before.label, to: tab.label });
        }
      } else if (input.action === 'guests') {
        demand(input.guestCount, 'Ange antal gäster.');
        demand(tab.lines.every(line => line.status === 'void' || line.guest <= input.guestCount!), 'En orderrad tillhör en gäst som då skulle försvinna.');
        tab.guestCount = input.guestCount;
      } else if (input.action === 'discount') {
        this.require(actor, authorizedRoles);
        demand(input.discountBps !== undefined && input.reason && input.reason.trim().length >= 3, 'Ange rabatt och orsak.');
        tab.discountBps = input.discountBps;
        tab.discountReason = input.reason;
      } else if (input.action === 'price') {
        this.require(actor, authorizedRoles);
        const line = tab.lines.find(candidate => candidate.id === input.lineId && candidate.status !== 'void');
        demand(line && input.priceOre !== undefined && input.reason && input.reason.trim().length >= 3, 'Ange nytt pris och orsak.');
        line.unitPriceOre = input.priceOre;
        line.overrideReason = input.reason;
      } else if (input.action === 'void') {
        demand(tab.lines.every(line => line.status === 'void') || tab.lines.length === 0, 'Makulera orderraderna innan notan avslutas.');
        tab.status = 'void';
      }
      tab.version++;
      tab.updatedAt = this.timestamp();
      this.store.put('tab', tab);
      this.log(actor, `tab.${input.action}`, id, { before, tab, reason: input.reason ?? '' });
      return tab;
    });
  }
  makeTickets(tab: Tab, lines: OrderLine[], actor: Actor, kind: 'order' | 'cancel' = 'order', reason = ''): void {
    for (const station of ['kitchen', 'bar'] as Station[]) {
      const items = lines.filter(line => line.station === station);
      if (!items.length) continue;
      const ticket: Ticket = { id: randomUUID(), tabId: tab.id, tabLabel: tab.label, station, kind, status: 'queued', items: structuredClone(items), createdAt: this.timestamp(), updatedAt: this.timestamp(), createdBy: actor.staff.name, reason };
      this.store.put('ticket', ticket);
      this.queuePrint(station, ticket.id, ticketText(ticket));
      this.log(actor, 'ticket.create', ticket.id, { ticket });
    }
  }
  updateTicket(actor: Actor, id: string, status: Ticket['status']): Ticket {
    const ticket = this.store.get<Ticket>('ticket', id);
    demand(ticket, 'Beställningen finns inte.', 404);
    if (actor.device.kind === 'display') demand(actor.device.station === ticket.station, 'Enheten tillhör en annan station.', 403);
    this.require(actor, [...workingRoles, ticket.station]);
    return this.store.atomic(() => {
      const progression = ['queued', 'started', 'ready', 'served'];
      demand(progression.indexOf(status) === progression.indexOf(ticket.status) + 1 || status === ticket.status, 'Uppdatera beställningen ett steg åt gången.', 409);
      ticket.status = status;
      ticket.updatedAt = this.timestamp();
      this.store.put('ticket', ticket);
      if (ticket.kind === 'order') {
        const tab = this.tab(ticket.tabId);
        for (const line of tab.lines) if (line.status !== 'void' && ticket.items.some(item => item.id === line.id)) line.status = status === 'queued' ? 'sent' : status;
        tab.version++;
        tab.updatedAt = this.timestamp();
        this.store.put('tab', tab);
      }
      this.log(actor, 'ticket.status', id, { status });
      this.notify();
      return ticket;
    });
  }
  paymentFingerprint(input: unknown, actor: Actor, context: string): string { return digest(JSON.stringify([context, actor.staff.id, input])); }
  existingPayment(key: string, fingerprint: string): Payment | undefined {
    const payment = this.store.all<Payment>('payment').find(candidate => candidate.key === key);
    if (payment) demand(payment.fingerprint === fingerprint, 'Betalningsidentifieraren har använts med andra uppgifter.', 409, 'KEY_REUSED');
    return payment;
  }
  paymentAttempt(actor: Actor, key: string): Payment | null {
    this.require(actor, workingRoles);
    demand(actor.device.kind !== 'display', 'Betalning kontrolleras på kassa eller serveringsenhet.', 403);
    const payment = this.store.all<Payment>('payment').find(candidate => candidate.key === key && candidate.staffId === actor.staff.id);
    if (payment?.kind === 'refund') this.require(actor, authorizedRoles);
    return payment ?? null;
  }
  allocations(tab: Tab, input: PaymentInput): Allocation[] {
    const totals = calculateTab(tab);
    const reserved = this.store.all<Payment>('payment').filter(payment => payment.tabId === tab.id && payment.kind === 'sale' && reservedStatuses.includes(payment.status));
    if (input.lineIds) demand(input.lineIds.length > 0 && new Set(input.lineIds).size === input.lineIds.length && input.lineIds.every(lineId => totals.lines.some(line => line.lineId === lineId)), 'Välj giltiga orderrader.');
    if (input.guest !== undefined) demand(input.guest <= tab.guestCount, 'Gästen finns inte.');
    const candidates = totals.lines.filter(line => (!input.lineIds || input.lineIds.includes(line.lineId)) && (input.guest === undefined || tab.lines.find(candidate => candidate.id === line.lineId)?.guest === input.guest)).map(line => {
      const used = reserved.flatMap(payment => payment.allocations).filter(allocation => allocation.lineId === line.lineId);
      return { line, usedGross: used.reduce((sum, allocation) => sum + allocation.grossOre, 0), usedVat: used.reduce((sum, allocation) => sum + allocation.vatOre, 0) };
    });
    const weights = candidates.map(candidate => candidate.line.grossOre - candidate.usedGross);
    const maximum = weights.reduce((sum, value) => sum + value, 0);
    const amount = input.amountOre ?? maximum;
    demand(amount <= maximum && amount >= 0, 'Beloppet överstiger den obetalda delen av notan.');
    demand(amount > 0 || totals.grossOre === 0 && reserved.length === 0, 'Den valda delen är redan betald eller reserverad.', 409, 'NO_BALANCE');
    demand(candidates.length > 0, 'Det finns inga artiklar att betala.');
    const portions = distribute(amount, weights);
    return candidates.flatMap(({ line, usedGross, usedVat }, index) => {
      const grossOre = portions[index];
      if (grossOre === 0 && totals.grossOre !== 0) return [];
      return [{ lineId: line.lineId, grossOre, vatOre: line.grossOre === 0 ? 0 : roundRatio(line.vatOre * (usedGross + grossOre), line.grossOre) - usedVat, vatBps: line.vatBps }];
    });
  }
  async startPayment(actor: Actor, tabId: string, input: PaymentInput): Promise<Payment> {
    this.require(actor, workingRoles);
    demand(actor.device.kind !== 'display', 'Betalning görs på kassa eller serveringsenhet.', 403);
    const { version: _version, ...fingerprintInput } = input;
    const fingerprint = this.paymentFingerprint(fingerprintInput, actor, `sale:${tabId}`);
    const existing = this.existingPayment(input.key, fingerprint);
    if (existing) return existing;
    const payment = this.store.atomic(() => {
      const day = this.requireDay();
      const tab = this.tab(tabId);
      this.version(tab, input.version);
      demand(tab.status === 'open', 'Notan är redan avslutad.', 409, 'TAB_CLOSED');
      demand(!tab.lines.some(line => ['draft', 'held'].includes(line.status)), 'Skicka eller makulera alla väntande rätter innan betalning.');
      if (input.method === 'cash') this.require(actor, authorizedRoles, true);
      if (input.method === 'swish') demand(input.swishVerified, 'Bekräfta att Swishbetalningen har verifierats.');
      const allocations = this.allocations(tab, input);
      const amountOre = allocations.reduce((sum, allocation) => sum + allocation.grossOre, 0);
      if (input.method === 'cash') demand(input.tenderedOre !== undefined && input.tenderedOre >= amountOre + input.tipOre, 'Mottaget kontantbelopp är för litet.');
      const payment: Payment = { id: randomUUID(), key: input.key, fingerprint, tabId, dayId: day.id, kind: 'sale', parentId: null, method: input.method, status: 'pending', amountOre, tipOre: input.tipOre, allocations, tenderedOre: input.method === 'cash' ? input.tenderedOre! : null, changeOre: input.method === 'cash' ? input.tenderedOre! - amountOre - input.tipOre : 0, reason: '', simulation: input.simulation, fiscalSimulation: input.fiscalSimulation, createdAt: this.timestamp(), updatedAt: this.timestamp(), staffId: actor.staff.id, deviceId: actor.device.id };
      this.store.put('payment', payment);
      tab.version++;
      this.store.put('tab', tab);
      this.log(actor, 'payment.start', payment.id, { payment });
      return payment;
    });
    this.notify();
    let status: PaymentStatus;
    try { status = await this.paymentAdapter.start(payment); } catch { status = 'unknown'; }
    return this.finishPayment(actor, payment.id, status);
  }
  async finishPayment(actor: Actor, id: string, status: PaymentStatus): Promise<Payment> {
    const payment = this.store.atomic(() => {
      const payment = this.store.get<Payment>('payment', id)!;
      if (['approved', 'declined', 'cancelled'].includes(payment.status)) return payment;
      payment.status = status;
      payment.updatedAt = this.timestamp();
      this.store.put('payment', payment);
      const tab = this.tab(payment.tabId);
      if (payment.kind === 'sale') {
        if (status === 'approved' && paidOre(this.store.all<Payment>('payment'), tab.id) === calculateTab(tab).grossOre) tab.status = 'paid';
        tab.version++;
        tab.updatedAt = this.timestamp();
        this.store.put('tab', tab);
      }
      if (status === 'approved' && !this.store.all<Receipt>('receipt').some(receipt => receipt.paymentId === id)) {
        const settings = this.settings();
        const parent = payment.parentId ? this.store.all<Receipt>('receipt').find(receipt => receipt.paymentId === payment.parentId) : null;
        const receipt: Receipt = { id: randomUUID(), paymentId: id, dayId: payment.dayId, number: this.store.next('receipt'), kind: payment.kind, createdAt: this.timestamp(), fiscalStatus: 'pending', controlCode: null, originalReceiptId: parent?.id ?? null, payment: structuredClone(payment), tab: structuredClone(tab), company: structuredClone(settings.company), cashier: actor.staff.name, registerId: settings.registerId };
        this.store.put('receipt', receipt);
        this.log(actor, 'receipt.create', receipt.id, { receipt });
      }
      this.log(actor, 'payment.status', id, { payment });
      return payment;
    });
    const receipt = this.store.all<Receipt>('receipt').find(candidate => candidate.paymentId === id);
    if (receipt?.fiscalStatus === 'pending' && !this.fiscalInFlight.has(receipt.id)) {
      this.fiscalInFlight.add(receipt.id);
      try {
        let result;
        try { result = await this.fiscalAdapter.register(receipt, payment.fiscalSimulation); } catch { result = { status: 'unknown' as const, controlCode: null }; }
        this.store.atomic(() => {
          const latest = this.store.get<Receipt>('receipt', receipt.id)!;
          if (latest.fiscalStatus !== 'pending') return;
          latest.fiscalStatus = result.status;
          latest.controlCode = result.controlCode;
          this.store.put('receipt', latest);
          if (result.status === 'confirmed') this.queuePrint('guest', latest.id, receiptText(latest));
          this.log(actor, `fiscal.${result.status}`, latest.id, result);
        });
      } finally { this.fiscalInFlight.delete(receipt.id); }
    }
    this.notify();
    return payment;
  }
  async checkPayment(actor: Actor, id: string, cancel = false): Promise<Payment> {
    this.require(actor, workingRoles);
    const payment = this.store.get<Payment>('payment', id);
    demand(payment, 'Betalningen finns inte.', 404);
    if (payment.kind === 'refund') this.require(actor, authorizedRoles);
    if (payment.status !== 'unknown' && payment.status !== 'pending') return payment;
    let status: PaymentStatus;
    try { status = cancel ? await this.paymentAdapter.cancel(id) : await this.paymentAdapter.status(id); } catch { status = 'unknown'; }
    return this.finishPayment(actor, id, status);
  }
  async verifyFiscal(actor: Actor, id: string): Promise<Receipt> {
    this.require(actor, authorizedRoles);
    const receipt = this.store.get<Receipt>('receipt', id);
    demand(receipt, 'Kvittot finns inte.', 404);
    if (receipt.fiscalStatus === 'confirmed') return receipt;
    const result = await this.fiscalAdapter.lookup(id);
    this.store.atomic(() => {
      const latest = this.store.get<Receipt>('receipt', id)!;
      if (latest.fiscalStatus === 'confirmed') return;
      latest.fiscalStatus = result.status;
      latest.controlCode = result.controlCode;
      this.store.put('receipt', latest);
      if (result.status === 'confirmed') this.queuePrint('guest', latest.id, receiptText(latest));
      this.log(actor, 'fiscal.verify', id, result);
    });
    this.notify();
    return this.store.get<Receipt>('receipt', id)!;
  }
  async refund(actor: Actor, parentId: string, input: RefundInput): Promise<Payment> {
    this.require(actor, authorizedRoles);
    const fingerprint = this.paymentFingerprint(input, actor, `refund:${parentId}`);
    const existing = this.existingPayment(input.key, fingerprint);
    if (existing) return existing;
    const payment = this.store.atomic(() => {
      const day = this.requireDay();
      const parent = this.store.get<Payment>('payment', parentId);
      demand(parent?.kind === 'sale' && parent.status === 'approved', 'En godkänd försäljning måste väljas.');
      if (parent.method === 'cash') this.require(actor, authorizedRoles, true);
      const reserved = this.store.all<Payment>('payment').filter(payment => payment.parentId === parentId && reservedStatuses.includes(payment.status));
      const remaining = parent.allocations.map(allocation => {
        const used = reserved.flatMap(payment => payment.allocations).filter(candidate => candidate.lineId === allocation.lineId);
        return { allocation, usedGross: used.reduce((sum, candidate) => sum + candidate.grossOre, 0), usedVat: used.reduce((sum, candidate) => sum + candidate.vatOre, 0) };
      });
      const weights = remaining.map(entry => entry.allocation.grossOre - entry.usedGross);
      demand(input.amountOre > 0 && input.amountOre <= weights.reduce((sum, amount) => sum + amount, 0), 'Returbeloppet överstiger vad som återstår att återbetala.');
      const portions = distribute(input.amountOre, weights);
      const allocations = remaining.flatMap(({ allocation, usedGross, usedVat }, index) => portions[index] ? [{ lineId: allocation.lineId, grossOre: portions[index], vatOre: roundRatio(allocation.vatOre * (usedGross + portions[index]), allocation.grossOre) - usedVat, vatBps: allocation.vatBps }] : []);
      const payment: Payment = { id: randomUUID(), key: input.key, fingerprint, tabId: parent.tabId, dayId: day.id, kind: 'refund', parentId, method: parent.method, status: 'pending', amountOre: input.amountOre, tipOre: 0, allocations, tenderedOre: null, changeOre: 0, reason: input.reason, simulation: input.simulation, fiscalSimulation: input.fiscalSimulation, createdAt: this.timestamp(), updatedAt: this.timestamp(), staffId: actor.staff.id, deviceId: actor.device.id };
      this.store.put('payment', payment);
      this.log(actor, 'refund.start', payment.id, { payment });
      return payment;
    });
    let status: PaymentStatus;
    try { status = await this.paymentAdapter.refund(payment); } catch { status = 'unknown'; }
    return this.finishPayment(actor, payment.id, status);
  }
  queuePrint(kind: PrintJob['kind'], sourceId: string, text: string, reprintOf: string | null = null): PrintJob {
    const job: PrintJob = { id: randomUUID(), kind, sourceId, status: 'queued', text, createdAt: this.timestamp(), reprintOf, attempts: 0 };
    this.store.put('print', job);
    return job;
  }
  async print(actor: Actor, id: string, action: 'print' | 'resolve' | 'reprint', outcome?: 'printed' | 'failed' | 'uncertain', reason = ''): Promise<PrintJob> {
    this.require(actor, authorizedRoles);
    const storedJob = this.store.get<PrintJob>('print', id);
    demand(storedJob, 'Utskriften finns inte.', 404);
    let job: PrintJob = storedJob;
    if (action === 'reprint') {
      demand(['printed', 'failed'].includes(job.status), 'Kontrollera först om den osäkra utskriften kom ut.');
      demand(reason.trim().length >= 3, 'Ange orsak till återutskriften.');
      const copy = this.store.atomic(() => {
        const copy = this.queuePrint(job.kind, job.sourceId, `KOPIA · ${reason}\n${job.text}`, job.id);
        this.log(actor, 'print.reprint', copy.id, { originalId: job.id, reason });
        return copy;
      });
      this.notify();
      return copy;
    }
    demand(outcome, 'Välj ett utskriftsresultat.');
    if (action === 'resolve') {
      demand(job.status === 'uncertain' && outcome !== 'uncertain' && reason.trim().length >= 3, 'Kontrollera utskriften och ange resultat och orsak.');
      job.status = outcome;
    } else {
      job = this.store.atomic(() => {
        const current = this.store.get<PrintJob>('print', id)!;
        demand(current.status === 'queued', 'Den här utskriften har redan hanterats.', 409);
        current.status = 'printing';
        current.attempts++;
        this.store.put('print', current);
        this.log(actor, 'print.started', id, {});
        return current;
      });
      this.notify();
      try { job.status = await this.printAdapter.print(job.text, outcome); }
      catch { job.status = 'uncertain'; }
    }
    this.store.atomic(() => { this.store.put('print', job); this.log(actor, `print.${action}`, id, { status: job.status, reason }); });
    this.notify();
    return job;
  }
  drawer(actor: Actor, reason: string): PrintJob {
    this.require(actor, authorizedRoles, true);
    demand(reason.trim().length >= 3, 'Ange orsak till kassalådsöppningen.');
    const job = this.store.atomic(() => {
      const job = this.queuePrint('drawer', actor.device.id, `TEST · SIMULERAD KASSALÅDSÖPPNING\n${reason}`);
      this.log(actor, 'drawer.open', job.id, { reason });
      return job;
    });
    this.notify();
    return job;
  }
  openDay(actor: Actor, input: { key: string; floatOre: number }): BusinessDay {
    this.require(actor, authorizedRoles, true);
    return this.command(input.key, input, 'day.open', actor, () => {
      demand(!this.currentDay(), 'Det finns redan en öppen verksamhetsdag.', 409);
      const day: BusinessDay = { id: randomUUID(), number: this.store.next('businessday'), date: this.date(), status: 'open', openedAt: this.timestamp(), closedAt: null, openedBy: actor.staff.id, closedBy: null, floatOre: input.floatOre, countedCashOre: null, report: null };
      this.store.put('day', day);
      this.log(actor, 'day.open', day.id, { day });
      return day;
    });
  }
  report(dayId: string): DayReport {
    const day = this.store.get<BusinessDay>('day', dayId);
    demand(day, 'Verksamhetsdagen finns inte.', 404);
    if (day.status === 'closed' && day.report) return day.report;
    const allPayments = this.store.all<Payment>('payment').filter(payment => payment.dayId === dayId);
    const payments = allPayments.filter(payment => payment.status === 'approved');
    const receipts = this.store.all<Receipt>('receipt').filter(receipt => receipt.dayId === dayId);
    const sales = payments.filter(payment => payment.kind === 'sale');
    const refunds = payments.filter(payment => payment.kind === 'refund');
    const methods = (['card', 'swish', 'cash'] as const).map(method => {
      const salesOre = sales.filter(payment => payment.method === method).reduce((sum, payment) => sum + payment.amountOre, 0);
      const refundsOre = refunds.filter(payment => payment.method === method).reduce((sum, payment) => sum + payment.amountOre, 0);
      const tipsOre = sales.filter(payment => payment.method === method).reduce((sum, payment) => sum + payment.tipOre, 0);
      return { method, salesOre, refundsOre, tipsOre, netOre: salesOre - refundsOre };
    });
    const vatMap = new Map<number, { vatBps: number; grossOre: number; vatOre: number }>();
    for (const payment of payments) for (const allocation of payment.allocations) {
      const sign = payment.kind === 'sale' ? 1 : -1;
      const total = vatMap.get(allocation.vatBps) ?? { vatBps: allocation.vatBps, grossOre: 0, vatOre: 0 };
      total.grossOre += sign * allocation.grossOre;
      total.vatOre += sign * allocation.vatOre;
      vatMap.set(allocation.vatBps, total);
    }
    const salesOre = sales.reduce((sum, payment) => sum + payment.amountOre, 0);
    const refundsOre = refunds.reduce((sum, payment) => sum + payment.amountOre, 0);
    const cash = methods.find(method => method.method === 'cash')!;
    const expectedCashOre = day.floatOre + cash.netOre + cash.tipsOre;
    return { dayId, salesOre, refundsOre, netOre: salesOre - refundsOre, tipsOre: sales.reduce((sum, payment) => sum + payment.tipOre, 0), vatOre: [...vatMap.values()].reduce((sum, total) => sum + total.vatOre, 0), receipts: sales.length, methods, vat: [...vatMap.values()].sort((left, right) => left.vatBps - right.vatBps), expectedCashOre, differenceOre: day.countedCashOre === null ? null : day.countedCashOre - expectedCashOre, unresolved: allPayments.filter(payment => ['pending', 'unknown'].includes(payment.status)).length + receipts.filter(receipt => receipt.fiscalStatus !== 'confirmed').length, openTabs: this.store.all<Tab>('tab').filter(tab => tab.dayId === dayId && tab.status === 'open').length };
  }
  closeDay(actor: Actor, dayId: string, input: { key: string; countedCashOre: number }): BusinessDay {
    this.require(actor, authorizedRoles, true);
    return this.command(input.key, [dayId, input], 'day.close', actor, () => {
      const day = this.store.get<BusinessDay>('day', dayId);
      demand(day?.status === 'open', 'Verksamhetsdagen är redan avslutad.', 409);
      const report = this.report(day.id);
      demand(report.openTabs === 0, 'Avsluta alla öppna notor före dagsavslut.', 409, 'OPEN_TABS');
      demand(report.unresolved === 0, 'Kontrollera alla osäkra betalningar och kontrollkoder före dagsavslut.', 409, 'UNRESOLVED');
      day.countedCashOre = input.countedCashOre;
      day.closedAt = this.timestamp();
      day.closedBy = actor.staff.id;
      day.report = { ...report, differenceOre: input.countedCashOre - report.expectedCashOre };
      day.status = 'closed';
      this.store.put('day', day);
      this.queuePrint('closing', day.id, closingText(day, day.report));
      this.log(actor, 'day.close', day.id, { day });
      return day;
    });
  }
  saveMenu(actor: Actor, item: MenuItem): MenuItem {
    this.require(actor, ['admin']);
    demand(new Set(item.modifiers.map(group => group.id)).size === item.modifiers.length, 'Tillvalsgrupperna måste ha olika identifierare.');
    const optionIds = item.modifiers.flatMap(group => group.options.map(option => option.id));
    demand(new Set(optionIds).size === optionIds.length, 'Tillvalen måste ha olika identifierare.');
    for (const group of item.modifiers) demand(group.min <= group.max && group.options.length >= group.min && group.max <= group.options.length, 'Antalet tillval måste stämma med gruppens gränser.');
    this.store.atomic(() => {
      const previous = this.store.get<MenuItem>('menu', item.id);
      this.store.put('menu', item);
      this.log(actor, 'menu.save', item.id, { previous: previous ?? null, item });
    });
    this.notify();
    return item;
  }
  saveTable(actor: Actor, table: DiningTable): DiningTable {
    this.require(actor, ['admin']);
    demand(!this.store.all<DiningTable>('table').some(candidate => candidate.id !== table.id && candidate.name === table.name && candidate.active), 'Bordsnamnet används redan.');
    demand(table.active || !this.store.all<Tab>('tab').some(tab => tab.tableId === table.id && tab.status === 'open'), 'Avsluta bordets nota innan bordet stängs av.');
    this.store.atomic(() => { this.store.put('table', table); this.log(actor, 'table.save', table.id, { table }); });
    this.notify();
    return table;
  }
  saveStaff(actor: Actor, input: Staff & { pin?: string }): Staff {
    this.require(actor, ['admin']);
    const previous = this.store.get<StoredStaff>('staff', input.id);
    demand(previous || input.pin, 'Ange en PIN-kod för den nya medarbetaren.');
    const administrators = this.publicStaff().filter(staff => staff.id !== input.id && staff.role === 'admin' && staff.active);
    demand(input.role === 'admin' && input.active || administrators.length > 0, 'Minst en administratör måste vara aktiv.');
    const { pin, ...staff } = input;
    this.store.atomic(() => {
      this.store.put('staff', { ...staff, pinHash: pin ? hashPin(pin) : previous!.pinHash });
      this.store.db.prepare('DELETE FROM sessions WHERE staff_id=?').run(staff.id);
      this.log(actor, 'staff.save', staff.id, { staff });
    });
    this.notify();
    return staff;
  }
  saveDevice(actor: Actor, input: Omit<Device, 'id'>, id?: string): Device & { code: string } {
    this.require(actor, ['admin']);
    demand(input.kind === 'display' ? input.station !== null : input.station === null, 'Bara orderskärmar ska tillhöra en station.');
    if (id) demand(this.store.get('device', id), 'Enheten finns inte.', 404);
    const device: Device = { ...input, id: id ?? randomUUID() };
    const code = randomBytes(8).toString('hex').toUpperCase();
    this.store.atomic(() => {
      this.store.put('device', { ...device, codeHash: digest(code) });
      this.store.db.prepare('DELETE FROM sessions WHERE device_id=?').run(device.id);
      this.log(actor, 'device.save', device.id, { device });
    });
    this.notify();
    return { ...device, code };
  }
  saveSettings(actor: Actor, settings: Settings): Settings {
    this.require(actor, ['admin']);
    for (const rule of settings.taxRules) {
      demand(new Date(`${rule.from}T12:00:00Z`).toISOString().startsWith(rule.from), 'Momsregelns startdatum är ogiltigt.');
      demand(!rule.until || rule.until >= rule.from && new Date(`${rule.until}T12:00:00Z`).toISOString().startsWith(rule.until), 'Momsregelns slutdatum är ogiltigt.');
    }
    demand(new Set(settings.taxRules.map(rule => rule.id)).size === settings.taxRules.length, 'Momsreglernas identifierare måste vara unika.');
    for (const taxClass of ['food', 'alcohol', 'standard'] as const) for (const mode of ['dine_in', 'takeaway'] as const) {
      demand(settings.taxRules.some(rule => rule.taxClass === taxClass && rule.mode === mode && rule.from <= '2020-01-01' && rule.until === null), 'Varje momsklass behöver en grundregel utan slutdatum från 2020-01-01 eller tidigare.');
      const dates = settings.taxRules.filter(rule => rule.taxClass === taxClass && rule.mode === mode).map(rule => rule.from);
      demand(new Set(dates).size === dates.length, 'Två momsregler för samma försäljningssätt får inte börja samma datum.');
    }
    this.store.atomic(() => { this.store.put('settings', { id: 'settings', ...settings }); this.log(actor, 'settings.save', 'settings', { settings }); });
    this.notify();
    return settings;
  }
  async backup(actor: Actor | 'system'): Promise<{ filename: string; at: string }> {
    demand(!this.backingUp, 'En säkerhetskopia skapas redan.', 409);
    this.backingUp = true;
    try {
      mkdirSync(this.backupDir, { recursive: true });
      const filename = path.join(this.backupDir, `lagustosa-training-${this.timestamp().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.sqlite`);
      await this.store.db.backup(filename);
      const at = this.timestamp();
      this.store.put('meta', { id: 'backup', lastAt: at, error: null });
      this.log(actor, 'backup.created', 'backup', { filename, at });
      this.notify();
      return { filename, at };
    } catch (error) {
      const previous = this.store.get<{ lastAt: string | null }>('meta', 'backup');
      this.store.put('meta', { id: 'backup', lastAt: previous?.lastAt ?? null, error: 'Säkerhetskopian kunde inte sparas. Kontrollera backupdisken.' });
      throw error;
    } finally { this.backingUp = false; }
  }
}
