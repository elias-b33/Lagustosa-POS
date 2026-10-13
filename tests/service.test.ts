import { describe, expect, it } from 'vitest';
import { calculateTab } from '../shared/money';
import type { MenuItem, Payment, PrintJob, Receipt, Ticket } from '../shared/types';
import type { FiscalAdapter, PrintAdapter } from '../server/adapters';
import { Store } from '../server/db';
import { KassaService } from '../server/service';
import { fixture, key } from './helpers';

describe('Restaurangens arbetsflöde', () => {
  it('skickar till rätt station och väntar med huvudrätten till framkallning', () => {
    const f = fixture(); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread', guest: 1 });
    f.command(tab.id, { action: 'add', itemId: 'redwine', guest: 2 });
    f.command(tab.id, { action: 'add', itemId: 'penne', guest: 1 });
    f.command(tab.id, { action: 'send' });
    const first = f.store.all<Ticket>('ticket');
    expect(first.map(ticket => ticket.station).sort()).toEqual(['bar', 'kitchen']);
    expect(first.flatMap(ticket => ticket.items.map(item => item.itemId)).sort()).toEqual(['bread', 'redwine']);
    f.command(tab.id, { action: 'fire', course: 'main' });
    expect(f.store.all<Ticket>('ticket').at(-1)?.items[0].itemId).toBe('penne');
    expect(() => f.command(tab.id, { action: 'send' })).toThrow('inga nya rätter');
  });

  it('bevarar orderradens pris när menyn ändras och kräver obligatoriska tillval', () => {
    const f = fixture(); f.open(); const tab = f.tab();
    expect(() => f.command(tab.id, { action: 'add', itemId: 'filetto' })).toThrow('Välj');
    f.command(tab.id, { action: 'add', itemId: 'filetto', modifiers: ['potatoes', 'pepper'] });
    const item = f.store.get<MenuItem>('menu', 'filetto')!;
    f.service.saveMenu(f.admin, { ...item, priceOre: 50000 });
    expect(f.service.tab(tab.id).lines[0].unitPriceOre).toBe(35500);
  });

  it('skyddar mot förlorade samtidiga beställningar och dubbeltryck', () => {
    const f = fixture(); f.open(); const tab = f.tab(); const commandKey = key();
    const input = { key: commandKey, version: tab.version, action: 'add' as const, itemId: 'bread' };
    f.service.updateTab(f.admin, tab.id, input);
    expect(() => f.service.updateTab(f.admin, tab.id, { ...input, key: key(), itemId: 'cola' })).toThrow('annan enhet');
    f.service.updateTab(f.admin, tab.id, { ...input, version: 2 });
    expect(f.service.tab(tab.id).lines).toHaveLength(1);
    f.command(tab.id, { action: 'add', itemId: 'cola' });
    expect(f.service.tab(tab.id).lines).toHaveLength(2);
  });

  it('flyttar även stationernas bongar och skapar en tydlig ändringsutskrift', () => {
    const f = fixture(); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' });
    f.command(tab.id, { action: 'add', itemId: 'redwine' });
    f.command(tab.id, { action: 'send' });
    f.command(tab.id, { action: 'move', tableId: 'table-2' });
    const tickets = f.store.all<Ticket>('ticket');
    expect(tickets.every(ticket => ticket.tabLabel === 'Bord 02' && ticket.movedFrom === 'Bord 01')).toBe(true);
    const jobs = f.store.all<PrintJob>('print');
    expect(jobs.filter(job => job.sourceId === tab.id)).toHaveLength(2);
    expect(jobs.filter(job => tickets.some(ticket => ticket.id === job.sourceId)).every(job => job.text.includes('Bord 02'))).toBe(true);
  });

  it('begränsar rabatter, kontanter och köksåtgärder efter roll och enhet', async () => {
    const f = fixture(); f.open(); const tab = f.tab(); const waiter = f.actor('waiter', 'SERVERING-1');
    f.command(tab.id, { action: 'add', itemId: 'bread' }, waiter);
    f.command(tab.id, { action: 'send' }, waiter);
    expect(() => f.command(tab.id, { action: 'discount', discountBps: 1000, reason: 'Test' }, waiter)).toThrow('behörighet');
    await expect(f.pay(tab.id, { method: 'cash', tenderedOre: 10000 }, waiter)).rejects.toThrow('behörighet');
    const ticket = f.store.all<Ticket>('ticket')[0];
    expect(() => f.service.updateTicket(f.actor('bar', 'BAR-TEST'), ticket.id, 'started')).toThrow('annan station');
    expect(() => f.service.openDay(f.actor('cashier', 'SERVERING-2'), { key: key(), floatOre: 0 })).toThrow('huvudkassan');
  });
});

describe('Betalning och dagsavslut', () => {
  it('gör en exakt delad nota med blandad moms, rabatt, dricks och retur', async () => {
    const f = fixture(); const day = f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread', guest: 1 });
    f.command(tab.id, { action: 'add', itemId: 'redwine', guest: 2 });
    f.command(tab.id, { action: 'discount', discountBps: 1000, reason: 'Övningsrabatt' });
    f.command(tab.id, { action: 'send' });
    const totals = calculateTab(f.service.tab(tab.id));
    const first = await f.pay(tab.id, { amountOre: 5001, tipOre: 2000 });
    const second = await f.pay(tab.id);
    expect(first.amountOre + second.amountOre).toBe(totals.grossOre);
    expect([...first.allocations, ...second.allocations].reduce((sum, row) => sum + row.vatOre, 0)).toBe(totals.vatOre);
    expect(f.service.tab(tab.id).status).toBe('paid');
    const refund = await f.service.refund(f.admin, first.id, { key: key(), amountOre: first.amountOre, reason: 'Övningsretur', simulation: 'approved', fiscalSimulation: 'confirmed' });
    expect(refund.method).toBe(first.method);
    expect(refund.allocations.reduce((sum, row) => sum + row.vatOre, 0)).toBe(first.allocations.reduce((sum, row) => sum + row.vatOre, 0));
    const report = f.service.report(day.id);
    expect(report.netOre).toBe(second.amountOre);
    expect(report.tipsOre).toBe(2000);
    expect(f.service.closeDay(f.admin, day.id, { key: key(), countedCashOre: 150000 }).status).toBe('closed');
    expect(f.store.verifyJournal()).toBe(true);
  });

  it('skapar bara en betalning och ett kvitto för samma betalningsidentifierare', async () => {
    const f = fixture(); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const input = { key: key(), version: f.service.tab(tab.id).version, method: 'card' as const, tipOre: 0, simulation: 'approved' as const, fiscalSimulation: 'confirmed' as const };
    await Promise.all([f.service.startPayment(f.admin, tab.id, input), f.service.startPayment(f.admin, tab.id, input)]);
    expect(f.store.all<Payment>('payment')).toHaveLength(1);
    expect(f.store.all<Receipt>('receipt')).toHaveLength(1);
    expect(f.store.all<PrintJob>('print').filter(job => job.kind === 'guest')).toHaveLength(1);
  });

  it('reserverar en osäker betalning och kontrollerar samma försök före ett nytt', async () => {
    const f = fixture(); const day = f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const unknown = await f.pay(tab.id, { simulation: 'unknown', fiscalSimulation: 'unknown' });
    expect(unknown.status).toBe('unknown');
    await expect(f.pay(tab.id)).rejects.toThrow('betald eller reserverad');
    expect(() => f.service.closeDay(f.admin, day.id, { key: key(), countedCashOre: 150000 })).toThrow('öppna notor');
    expect((await f.service.checkPayment(f.admin, unknown.id)).status).toBe('approved');
    expect(() => f.service.closeDay(f.admin, day.id, { key: key(), countedCashOre: 150000 })).toThrow('osäkra');
    await f.service.verifyFiscal(f.admin, f.store.all<Receipt>('receipt')[0].id);
    expect(f.service.report(day.id).unresolved).toBe(0);
    expect(f.store.all<Payment>('payment')).toHaveLength(1);
  });

  it('lämnar nekade betalningar obetalda och tillåter ett nytt försök', async () => {
    const f = fixture(); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    expect((await f.pay(tab.id, { simulation: 'declined' })).status).toBe('declined');
    expect(f.service.tab(tab.id).status).toBe('open');
    expect(f.store.all('receipt')).toHaveLength(0);
    expect((await f.pay(tab.id)).status).toBe('approved');
  });

  it('räknar växel och kontant dricks i kassaavstämningen', async () => {
    const f = fixture(); const day = f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const payment = await f.pay(tab.id, { method: 'cash', tenderedOre: 10000, tipOre: 1000 });
    expect(payment.changeOre).toBe(2100);
    expect(f.service.report(day.id).expectedCashOre).toBe(157900);
  });

  it('håller verksamhetsdagen samman efter midnatt', async () => {
    let now = new Date('2026-10-13T20:00:00Z');
    const f = fixture({ now: () => now }); const day = f.open();
    now = new Date('2026-10-14T00:15:00Z');
    const closed = f.service.closeDay(f.admin, day.id, { key: key(), countedCashOre: 150000 });
    expect(closed.date).toBe('2026-10-13');
    expect(closed.closedAt).toBe('2026-10-14T00:15:00.000Z');
  });

  it('skickar en kontrollregistrering en gång vid samtidiga statuskontroller', async () => {
    let release!: (value: { status: 'confirmed'; controlCode: string }) => void;
    let calls = 0;
    const fiscal: FiscalAdapter = { kind: 'simulator', register: async () => { calls++; return new Promise(resolve => { release = resolve; }); }, lookup: async () => ({ status: 'unknown', controlCode: null }) };
    const f = fixture({ fiscal }); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const unknown = await f.pay(tab.id, { simulation: 'unknown' });
    const first = f.service.checkPayment(f.admin, unknown.id);
    const second = f.service.checkPayment(f.admin, unknown.id);
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(1);
    release({ status: 'confirmed', controlCode: 'TEST-ONCE' });
    await Promise.all([first, second]);
    expect(f.store.all<PrintJob>('print').filter(job => job.kind === 'guest')).toHaveLength(1);
  });
});

describe('Utskrifter och återhämtning', () => {
  it('låter bara en enhet ta ett köjobb åt gången', async () => {
    let release!: (value: 'printed') => void;
    const printer: PrintAdapter = { kind: 'preview', print: async () => new Promise(resolve => { release = resolve; }) };
    const f = fixture({ printer }); const job = f.service.queuePrint('kitchen', 'test', 'Testbong');
    const first = f.service.print(f.admin, job.id, 'print', 'printed');
    expect(f.store.get<PrintJob>('print', job.id)?.status).toBe('printing');
    await expect(f.service.print(f.admin, job.id, 'print', 'printed')).rejects.toThrow('redan hanterats');
    release('printed'); await first;
    expect(f.store.get<PrintJob>('print', job.id)?.attempts).toBe(1);
  });

  it('behandlar skrivaravbrott som osäkert och kräver kontroll före återutskrift', async () => {
    const printer: PrintAdapter = { kind: 'preview', print: async () => { throw new Error('connection lost'); } };
    const f = fixture({ printer }); const job = f.service.queuePrint('kitchen', 'test', 'Testbong');
    expect((await f.service.print(f.admin, job.id, 'print', 'printed')).status).toBe('uncertain');
    await expect(f.service.print(f.admin, job.id, 'reprint', undefined, 'Test')).rejects.toThrow('osäkra');
    await f.service.print(f.admin, job.id, 'resolve', 'failed', 'Kontrollerat att pappret inte kom ut');
    const copy = await f.service.print(f.admin, job.id, 'reprint', undefined, 'Ny kontrollerad kopia');
    expect(copy.reprintOf).toBe(job.id);
    expect(copy.text).toContain('KOPIA');
  });

  it('återställer bekräftade order och markerar avbrutna utskrifter efter omstart', () => {
    const f = fixture({}, true); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' });
    const job = f.service.queuePrint('kitchen', tab.id, 'Testbong');
    f.store.put('print', { ...job, status: 'printing' });
    f.store.close();
    const reopened = new Store(f.filename);
    try {
      const restarted = new KassaService(reopened);
      expect(restarted.tab(tab.id).lines[0].itemId).toBe('bread');
      expect(reopened.get<PrintJob>('print', job.id)?.status).toBe('uncertain');
      expect(reopened.verifyJournal()).toBe(true);
    } finally { reopened.close(); }
  });

  it('skapar en återläsbar databasbackup med intakt journal', async () => {
    const f = fixture(); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' });
    const backup = await f.service.backup(f.admin);
    const restored = new Store(backup.filename);
    try {
      expect(restored.get<Ticket>('tab', tab.id)).toBeDefined();
      expect(restored.verifyJournal()).toBe(true);
    } finally { restored.close(); }
  });
});
