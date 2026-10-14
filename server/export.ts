import type { Allocation, AuditEntry, BusinessDay, Company, DayReport, OrderLine, Payment, Receipt, Settings, Tab } from '../shared/types';
import { calculateTab } from '../shared/money';
import type { RegisterReport } from '../shared/register-reports';
import { digest, Store } from './db';
import { AppError, demand } from './errors';

const instance = 'http://xmls.skatteverket.se/se/skatteverket/td/instans/utredningsstod/1.0';
const component = 'http://xmls.skatteverket.se/se/skatteverket/td/komponent/utredningsstod/1.0';
const controlSerial = 'TEST-000000000001';
const xmlTextLimits: Record<string, number> = Object.fromEntries(['Artikelnummer', 'Artikelnamn', 'Kassabeteckning', 'ForetagetsNamn', 'DenAdressDarForsaljningSker', 'InloggadAnvandare', 'InloggadAnvandareVidExportAvDataFranJournalminnet', 'OrsakTillAndring', 'IdentitetsbeteckningForRegistreringAvArtiklar', 'NamnPaHuvudgrupp', 'NamnPaOvrigRapport', 'BenamningPaRabatt', 'TidigareBenamningPaRabatt'].map(name => [name, 72]));
xmlTextLimits.Sokparameter = 256;
xmlTextLimits.BeteckningPaDetKassaregisterSomExportAvDataFranJournalminnetSkerIfran = 72;
xmlTextLimits.BeteckningPaValtKassaregisterForExportAvDataFranJournalminnet = 72;
const escapeXml = (value: unknown) => {
  const text = String(value);
  demand(!/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(text), 'Journalen innehåller tecken som XML inte kan återge. Hämta JSON-underlaget utan att ändra historiken.', 409, 'XML_TEXT_INVALID');
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
};
const element = (name: string, value: unknown) => {
  const maximum = xmlTextLimits[name];
  demand(!maximum || [...String(value)].length <= maximum, `Journalfältet ${name} överstiger XML-schemats gräns (${maximum} tecken). Hämta JSON-underlaget; historiken får inte kortas av.`, 409, 'XML_TEXT_LENGTH');
  return `<k:${name}>${escapeXml(value)}</k:${name}>`;
};
const group = (name: string, contents: string) => `<k:${name}>${contents}</k:${name}>`;
const decimal = (ore: number) => (ore / 100).toFixed(2);
export function xmlTime(at: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(at)).replace(' ', 'T');
}

function methods(amount: number, method: string): string {
  return group('TotalaForsaljningssummorPerBetalningsmedelLISTA', group('TotalForsaljningssummaPerBetalningsmedel', element('Betalningsmedel', method) + element('ForsaljningssummaPerBetalningsmedel', decimal(amount))));
}
function vatList(allocations: { vatBps: number; vatOre: number }[], sign = 1): string {
  const taxes = new Map<number, number>();
  for (const allocation of allocations) taxes.set(allocation.vatBps, (taxes.get(allocation.vatBps) ?? 0) + sign * allocation.vatOre);
  if (!taxes.size) taxes.set(0, 0);
  return group('MervardesskattPaOlikaSkattesatserLISTA', [...taxes].map(([rate, amount]) => group('MervardesskattPerSkattesats', element('Mervardesskattesats', decimal(rate)) + element('TotaltMervardesskattebeloppPerSkattesats', decimal(amount)))).join(''));
}
function articleKind(line: OrderLine): string {
  const kind = (line as OrderLine & { itemKind?: string }).itemKind;
  demand(kind === 'goods' || kind === 'services', 'Artikelns historiska varu-/tjänsteklass saknas. JSON bevarar posten; XML får inte gissa klassificeringen.', 409, 'XML_ARTICLE_KIND_UNKNOWN');
  return kind === 'goods' ? 'VARA' : 'TJANST';
}
function discounts(kind: 'Registrerad' | 'Sald' | 'Tidigare', amountOre: number, reason: string): string {
  if (!amountOre) return '';
  const previous = kind === 'Tidigare';
  const name = previous ? 'TidigareRabattPaRegistreradArtikel' : `RabattPa${kind}Artikel`;
  return group(previous ? 'TidigareRabatterPaRegistreradArtikelLISTA' : `RabatterPa${kind}ArtikelLISTA`,
    group(name, (reason ? element(previous ? 'TidigareBenamningPaRabatt' : 'BenamningPaRabatt', reason) : '') + element(previous ? 'TidigareBeloppPaRabatten' : 'RabattensBelopp', decimal(amountOre))));
}
function article(line: OrderLine, grossOre: number, vatOre: number, discountOre = 0, reason = ''): string {
  return element('IdentitetsbeteckningForRegistreringAvArtiklar', line.id) + element('TypAvArtikel', articleKind(line)) + (line.category ? element('NamnPaHuvudgrupp', line.category) : '') + element('Artikelnummer', line.itemId) + element('Artikelnamn', line.name) + element('AntalAvRegistreradArtikel', line.quantity) + element('PrisPerEnhet', decimal(line.unitPriceOre)) + element('PrisPaRegistreradArtikel', decimal(grossOre)) + discounts('Registrerad', discountOre, reason) + element('MervardesskattesatsForRegistreradArtikel', decimal(line.vatBps)) + element('MervardesskattPaRegistreradArtikel', decimal(vatOre));
}
type QuantityAllocation = Allocation & { quantity?: { numerator: string; denominator: string }; quantityBasis?: 'items' | 'amount-share'; discountOre?: number };
function soldQuantity(allocation: QuantityAllocation, sign: number): string {
  // Even a matching gross amount does not prove a historical item quantity:
  // free or fully discounted rows may have been shared between receipts.
  demand(allocation.quantity, 'Äldre betalning saknar exakt journalfört artikelantal. XML-exporten är spärrad; ursprungliga belopp och referensrad finns i JSON.', 409, 'XML_QUANTITY_UNKNOWN');
  const { numerator, denominator } = allocation.quantity;
  demand(/^\d+$/.test(numerator) && /^[1-9]\d*$/.test(denominator), 'Kvittots exakta artikelantal är ogiltigt.', 409, 'XML_QUANTITY_INVALID');
  const scaled = BigInt(numerator) * 100n;
  const divisor = BigInt(denominator);
  // The official AntalAvSaldArtikelTYPE permits TWO decimal places. Rounding
  // 1/3 (or even 1/8) would silently change the immutable sold quantity.
  demand(scaled % divisor === 0n, 'Artikelantalet kan inte återges exakt med XML-schemats två decimaler. Hämta JSON med den exakta andelen.', 409, 'XML_QUANTITY_PRECISION');
  const value = scaled / divisor;
  demand(value <= (sign < 0 ? 999999999999n : 9999999999999n), 'Artikelantalet överstiger XML-schemats intervall.', 409, 'XML_QUANTITY_RANGE');
  const signed = sign < 0 && value !== 0n ? '-' : '';
  return signed + (value % 100n === 0n ? String(value / 100n) : `${value / 100n}.${String(value % 100n).padStart(2, '0')}`);
}
function trainingReceipt(receipt: Receipt, dayNumber: number): string {
  const payment = receipt.payment;
  const sign = receipt.kind === 'sale' ? 1 : -1;
  const totals = calculateTab(receipt.tab);
  let receiptDiscountOre = 0;
  const rows = payment.allocations.map(allocation => {
    const line = receipt.tab.lines.find(candidate => candidate.id === allocation.lineId);
    demand(line, 'Kvittots artikel saknas i den sparade ögonblicksbilden.', 409, 'JOURNAL_RECEIPT_DATA');
    const fullLine = allocation.grossOre === totals.lines.find(candidate => candidate.lineId === line.id)?.grossOre;
    const quantityAllocation = allocation as QuantityAllocation;
    const discountOre = quantityAllocation.discountOre ?? (fullLine ? totals.lines.find(candidate => candidate.lineId === line.id)!.discountOre : 0);
    demand(quantityAllocation.discountOre !== undefined || fullLine || !receipt.tab.discountBps, 'Äldre delbetalning saknar exakt rabattandel.', 409, 'XML_DISCOUNT_UNKNOWN');
    receiptDiscountOre += discountOre;
    return group('SaldArtikel', element('IdentitetsbeteckningForRegistreringAvArtiklar', line.id) + element('TypAvArtikel', articleKind(line)) + (line.category ? element('NamnPaHuvudgrupp', line.category) : '') + element('Artikelnummer', line.itemId) + element('Artikelnamn', line.name) + element('AntalAvSaldArtikel', soldQuantity(quantityAllocation, sign)) + element('PrisPerEnhet', decimal(line.unitPriceOre)) + element('PrisPaSaldArtikel', decimal(sign * allocation.grossOre)) + discounts('Sald', sign * discountOre, receipt.tab.discountReason) + element('MervardesskattesatsForSaldArtikel', decimal(allocation.vatBps)) + element('MervardesskattPaSaldArtikel', decimal(sign * allocation.vatOre)) + element('ArtikelnsRegistreringstidpunkt', xmlTime(line.createdAt)));
  }).join('');
  return group('Ovningskvitto', element('ForetagetsNamn', receipt.company.name) + element('OrganisationsnummerEllerPersonnummer', receipt.company.organizationNumber) + element('DenAdressDarForsaljningSker', `${receipt.company.address}, ${receipt.company.city}`) + element('DatumOchKlockslagNarKvittoFramstalls', xmlTime(receipt.createdAt)) + element('LopnummerForOvningskvitto', receipt.number) + element('Kassabeteckning', receipt.registerId) + element('IdentitetsbeteckningPaParkering', receipt.tab.id) + group('SaldaArtiklarLISTA', rows) + element('TotaltRabattbeloppPaKvitto', decimal(sign * receiptDiscountOre)) + element('TotaltForsaljningsbeloppISvenskaKronor', decimal(sign * payment.amountOre)) + element('MervardesskattPaForsaljningsbeloppet', decimal(sign * payment.allocations.reduce((sum, allocation) => sum + allocation.vatOre, 0))) + methods(sign * payment.amountOre, { card: 'Kort', cash: 'Kontanter', swish: 'Swish' }[payment.method]) + vatList(payment.allocations, sign) + element('LopnummerForZDagrapportPaKvitto', dayNumber) + element('TillverkningsnummerForKontrollenheten', controlSerial));
}
function registerModel(registerId: string, legacy = false): string {
  const serial = legacy ? 'LAGUSTOSA-TRAINING-01' : `TRAINING-${digest(registerId).slice(0, 32)}`;
  return element('TillverkningsnummerForKassaregistret', serial) + element('ModellbeteckningForKassaregistret', 'Lagustosa Kassa TRÄNING') + element('ModellEllerProgramForKassaregistret', 'Lagustosa Kassa') + element('VersionsnummerForKassaregistret', '0.1.0');
}
function dayReport(day: BusinessDay, report: DayReport, settings: Settings, receipts: Receipt[], kind: 'X' | 'Z', at: string): string[] {
  demand(report.netOre >= 0, 'Träningsrapportens netto är negativt och kan inte återges i schemats fält för övningsbelopp. Exakta försäljnings- och returbelopp bevaras i JSON.', 409, 'XML_TRAINING_NET_NEGATIVE');
  const snapshot = report.training;
  const company = snapshot?.company ?? settings.company;
  const registerId = snapshot?.registerId ?? settings.registerId;
  const zeroNames = ['AntalReturer', 'ReturernasBelopp', 'RabatternasBelopp', 'AntalOvrigaRegistreringarSomMinskatDagensForsaljningsbelopp', 'TotaltBeloppAvOvrigaRegistreringarSomMinskatDagensForsaljningsbelopp', 'AntalOavslutadeForsaljningar', 'TotaltBeloppAvOavslutadeForsaljningar', 'GrandTotalForsaljning', 'GrandTotalRetur', 'GrandTotalNetto'];
  // Real-sale counters stay zero. The economic reconciliation is training data;
  // copying it into real-sale counters would misrepresent simulated payments.
  return [group(`${kind}Dagrapport`,
    element('ForetagetsNamn', company.name) + element('OrganisationsnummerEllerPersonnummer', company.organizationNumber) +
    element('DatumOchKlockslagNarRapportFramstalls', xmlTime(snapshot?.generatedAt ?? at)) +
    (kind === 'Z' ? element('LopnummerForZDagrapport', snapshot?.sequence ?? day.number) : '') +
    element('Kassabeteckning', registerId) + (kind === 'Z' ? registerModel(registerId, true) : '') +
    element('TotalForsaljningssumma', '0.00') + vatList([{ vatBps: 0, vatOre: 0 }]) +
    element('VaxelkassansBeloppISvenskaKronor', decimal(day.floatOre)) + element('AntalKassakvitton', 0) +
    (snapshot ? element('AntalKassaladoppningar', snapshot.drawerOpenings) : '') +
    element('AntalKvittonSomTagitsFramIOvningslage', snapshot?.trainingReceipts ?? receipts.filter(receipt => receipt.dayId === day.id && receipt.createdAt <= at).length) +
    element('TotaltBeloppIOvningslage', decimal(report.netOre)) + methods(0, 'TRÄNING') +
    zeroNames.map(name => element(name, name.startsWith('Antal') ? 0 : '0.00')).join('')),
    group('OvrigRapport', element('NamnPaOvrigRapport', 'TRÄNING · ekonomisk avstämning') + element('Sokparameter', `Dag ${day.number}; netto ${decimal(report.netOre)}; dricks ${decimal(report.tipsOre)}; fullständiga historiska rapportdata finns i JSON-underlaget`))];
}

export function validJournalDate(value: string): boolean {
  if (!/^20[1-9]\d-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function journalSelection(store: Store, at: string, from?: string, to?: string) {
  demand((!from || validJournalDate(from)) && (!to || validJournalDate(to)), 'Välj giltiga kalenderdatum mellan 2010 och 2099.');
  demand(!from || !to || from <= to, 'Startdatum måste komma före slutdatum.');
  const exportTime = new Date(at).getTime();
  demand(Number.isFinite(exportTime), 'Exporttidpunkten är ogiltig.');
  demand(store.verifyJournal(), 'Journalens kontrollsumma stämmer inte. Exporten har stoppats.', 409, 'JOURNAL_INTEGRITY');
  const all = store.journal();
  const journal = all.filter(entry => (!from || xmlTime(entry.at).slice(0, 10) >= from) && (!to || xmlTime(entry.at).slice(0, 10) <= to));
  demand(journal.length > 0, 'Det finns inga journalhändelser i perioden.');
  demand(journal.every(entry => new Date(entry.at).getTime() <= exportTime), 'Journalen innehåller händelser efter exporttidpunkten. Kontrollera kassans klocka.', 409, 'JOURNAL_CLOCK');
  return { all, journal };
}
type JournalDetails = { registerId?: string | null; tab?: Tab; before?: Tab; reason?: string; receipt?: Receipt; payment?: Payment; day?: BusinessDay; dayId?: string; report?: DayReport | RegisterReport; previous?: Settings; settings?: Settings; direction?: 'in' | 'out'; amountOre?: number; kind?: string; receiptId?: string | null };
function historicalSettings(all: AuditEntry[], current: Settings): Map<number, Settings | undefined> {
  const firstChange = all.find(entry => entry.action === 'settings.save');
  let active: Settings | undefined = firstChange ? (firstChange.details as JournalDetails).previous : current;
  const contexts = new Map<number, Settings | undefined>();
  for (const entry of all) {
    const details = entry.details as JournalDetails;
    if (entry.action === 'settings.save') active = details.settings;
    contexts.set(entry.id, active);
  }
  return contexts;
}
function journalUser(actor: string): string {
  // KassaService.log records staffId@deviceId. Device IDs are generated UUIDs
  // or fixed seed IDs without '@'; staff IDs may themselves contain '@'. The
  // XSD field identifies the logged-in user, not the combined audit actor.
  // Keep the stable staff ID instead of looking up a possibly renamed user.
  const boundary = actor.lastIndexOf('@');
  return boundary > 0 ? actor.slice(0, boundary) : actor;
}
function changedArticles(details: JournalDetails): string[] {
  demand(details.before && details.tab, 'Artikeländringens före-/efterbild saknas.', 409, 'XML_ARTICLE_HISTORY');
  const before = details.before;
  const tab = details.tab;
  const oldTotals = calculateTab(before);
  const totals = calculateTab(tab);
  const contents: string[] = [];
  for (const line of [...tab.lines, ...before.lines.filter(old => !tab.lines.some(current => current.id === old.id))]) {
    const previous = before.lines.find(candidate => candidate.id === line.id);
    const oldTotal = oldTotals.lines.find(candidate => candidate.lineId === line.id);
    const total = totals.lines.find(candidate => candidate.lineId === line.id);
    if (!previous && total) {
      contents.push(group('RegistreraArtikel', article(line, total.grossOre, total.vatOre, total.discountOre, tab.discountReason)));
      contents.push(group('ParkeraRegistreradArtikel', article(line, total.grossOre, total.vatOre, total.discountOre, tab.discountReason) + element('IdentitetsbeteckningPaParkering', tab.id)));
    } else if (previous && oldTotal && !total) {
      contents.push(group('RaderaParkeradArtikel', article(previous, oldTotal.grossOre, oldTotal.vatOre, oldTotal.discountOre, before.discountReason) + element('IdentitetsbeteckningPaParkering', tab.id) + element('UrsprungligRegistreringstidpunkt', xmlTime(previous.createdAt))));
    } else if (previous && oldTotal && total && (line.quantity !== previous.quantity || line.unitPriceOre !== previous.unitPriceOre || oldTotal.grossOre !== total.grossOre || oldTotal.vatOre !== total.vatOre || oldTotal.discountOre !== total.discountOre || before.discountReason !== tab.discountReason)) {
      contents.push(group('AndraParkeradArtikel', article(line, total.grossOre, total.vatOre, total.discountOre, tab.discountReason) +
        element('TidigareAntalAvRegistreradArtikel', previous.quantity) + element('TidigarePrisPerEnhet', decimal(previous.unitPriceOre)) +
        element('TidigarePrisPaRegistreradArtikel', decimal(oldTotal.grossOre)) + discounts('Tidigare', oldTotal.discountOre, before.discountReason) + element('TidigareMervardesskattesatsForRegistreradArtikel', decimal(previous.vatBps)) +
        element('TidigareMervardesskattPaRegistreradArtikel', decimal(oldTotal.vatOre)) + element('IdentitetsbeteckningPaParkering', tab.id) +
        element('UrsprungligRegistreringstidpunkt', xmlTime(previous.createdAt)) + (details.reason ? element('OrsakTillAndring', details.reason) : '')));
    }
  }
  return contents;
}

export interface JournalScope { kind: 'register' | 'global' | 'legacy' | 'unknown'; registerId: string | null; source: 'explicit' | 'receipt-snapshot' | 'report-snapshot' | 'historical-settings' | 'unknown' }
export interface JournalCoverageIssue { entryId: number; action: string; registerId: string | null; code: string; reason: string }
export interface JournalExportCoverage {
  mode: 'training'; requestedRegisterId: string | null; registerIds: string[]; canExportXml: boolean; fullComplianceVerified: false;
  selectedEntryIds: number[]; mappedEntryIds: number[]; globalEntryIds: number[];
  excludedOperational: JournalCoverageIssue[]; unsupportedRegulatory: JournalCoverageIssue[];
  legacy: { entryId: number; registerId: string | null; source: JournalScope['source'] }[];
  warnings: { entryId: number; code: string; reason: string }[];
}
function isRegisterReport(report: unknown): report is RegisterReport {
  return !!report && typeof report === 'object' && 'schemaVersion' in report && 'scope' in report;
}
function eventScope(entry: AuditEntry, context?: Settings): JournalScope {
  const details = entry.details as JournalDetails;
  if (isRegisterReport(details.report) && details.report.scope === 'legacy') return { kind: 'legacy', registerId: details.report.legacyRegisterId, source: 'report-snapshot' };
  if (Object.hasOwn(details, 'registerId')) {
    if (details.registerId === null) return { kind: 'global', registerId: null, source: 'explicit' };
    if (typeof details.registerId === 'string' && details.registerId.length) return { kind: 'register', registerId: details.registerId, source: 'explicit' };
    return { kind: 'unknown', registerId: null, source: 'unknown' };
  }
  const receiptId = details.receipt?.registerId;
  if (receiptId) return { kind: 'legacy', registerId: receiptId, source: 'receipt-snapshot' };
  const report = entry.action === 'day.close' ? details.day?.report : details.report;
  if (report && !isRegisterReport(report) && report.training?.registerId) return { kind: 'legacy', registerId: report.training.registerId, source: 'report-snapshot' };
  return context ? { kind: 'legacy', registerId: context.registerId, source: 'historical-settings' } : { kind: 'unknown', registerId: null, source: 'unknown' };
}
const operationalActions = new Set(['terminal.status', 'menu.catalog_imported', 'menu.save', 'settings.save', 'staff.save', 'device.save', 'table.save', 'printer.saved', 'backup.created', 'print.routing_migrated', 'print.routed', 'print.started', 'print.print', 'print.resolve', 'print.recovered_uncertain', 'ticket.create', 'ticket.status', 'ticket.line_cancelled', 'ticket.table_moved', 'tab.send', 'tab.fire', 'tab.move', 'tab.guests', 'payment.start', 'payment.status', 'refund.start', 'payment.recovered_unknown', 'fiscal.confirmed', 'fiscal.unknown', 'fiscal.verify', 'fiscal.recovered_unknown', 'report.z_read', 'journal.export', 'journal.export_json']);
function containsAccountingValue(value: unknown): boolean {
  if (typeof value === 'number') return value !== 0;
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => key === 'numerator' ? child !== '0' : containsAccountingValue(child));
}
function registerDayReport(report: RegisterReport): string[] {
  demand(report.scope === 'register' && report.registerId, 'Rapporten gäller äldre gemensam historik och får inte ges ett nytt kassalöpnummer.', 409, 'XML_LEGACY_REGISTER_REPORT');
  demand(report.kind !== 'Z' || (Number.isSafeInteger(report.sequence) && report.sequence! > 0), 'Z-rapportens kassaspecifika löpnummer saknas.', 409, 'XML_REPORT_SEQUENCE');
  demand(report.mode === 'training' && !containsAccountingValue(report.real) && !containsAccountingValue(report.cumulative.real), 'Träningsjournalen får inte exportera skarpa försäljningsuppgifter.', 409, 'XML_REPORT_MODE');
  const training = report.training;
  demand(training.netOre >= 0, 'Träningsrapportens netto är negativt och kan inte återges i schemats fält för övningsbelopp. Exakta försäljnings- och returbelopp bevaras i JSON.', 409, 'XML_TRAINING_NET_NEGATIVE');
  return [group(`${report.kind}Dagrapport`,
    element('ForetagetsNamn', report.company.name) + element('OrganisationsnummerEllerPersonnummer', report.company.organizationNumber) + element('DatumOchKlockslagNarRapportFramstalls', xmlTime(report.generatedAt)) +
    (report.kind === 'Z' ? element('LopnummerForZDagrapport', report.sequence) : '') + element('Kassabeteckning', report.registerId) + (report.kind === 'Z' ? registerModel(report.registerId) : '') +
    element('TotalForsaljningssumma', '0.00') + vatList([{ vatBps: 0, vatOre: 0 }]) + element('VaxelkassansBeloppISvenskaKronor', '0.00') + element('AntalSaldaVaror', 0) + element('AntalSaldaTjanster', 0) + element('AntalKassakvitton', 0) + element('AntalKassaladoppningar', 0) + element('AntalKvittokopior', 0) + element('TotaltBeloppPaKvittokopior', '0.00') +
    element('AntalKvittonSomTagitsFramIOvningslage', training.receiptCounts.total) + element('TotaltBeloppIOvningslage', decimal(training.netOre)) + methods(0, 'TRÄNING') +
    ['AntalReturer', 'ReturernasBelopp', 'RabatternasBelopp', 'AntalOvrigaRegistreringarSomMinskatDagensForsaljningsbelopp', 'TotaltBeloppAvOvrigaRegistreringarSomMinskatDagensForsaljningsbelopp', 'AntalOavslutadeForsaljningar', 'TotaltBeloppAvOavslutadeForsaljningar', 'GrandTotalForsaljning', 'GrandTotalRetur', 'GrandTotalNetto'].map(name => element(name, name.startsWith('Antal') ? 0 : '0.00')).join('')),
    group('OvrigRapport', element('NamnPaOvrigRapport', `TRÄNING · ${report.kind} avstämning`) + element('Sokparameter', `Dag ${report.dayId}; journal ${report.journalFromExclusive + 1}-${report.journalThroughInclusive}; netto ${decimal(training.netOre)}; detaljer och täckningsbrister i JSON`))];
}
function prepareJournal(store: Store, at: string, from?: string, to?: string, requestedRegisterId?: string) {
  demand(requestedRegisterId === undefined || (requestedRegisterId.length > 0 && [...requestedRegisterId].length <= 72), 'Välj en giltig kassaidentitet.');
  const settings = store.get<Settings>('settings', 'settings')!;
  const { all, journal: periodEntries } = journalSelection(store, at, from, to);
  const contexts = historicalSettings(all, settings);
  const scopes = new Map(all.map(entry => [entry.id, eventScope(entry, contexts.get(entry.id))]));
  // Unattributed historical entries remain visible as context in JSON. They are
  // never silently assigned to the requested register or today's device map.
  const journal = periodEntries.filter(entry => !requestedRegisterId || scopes.get(entry.id)!.registerId === requestedRegisterId || scopes.get(entry.id)!.registerId === null);
  demand(journal.length > 0, 'Det finns inga journalhändelser för kassan i perioden.');
  const coverage: JournalExportCoverage = { mode: 'training', requestedRegisterId: requestedRegisterId ?? null, registerIds: [], canExportXml: false, fullComplianceVerified: false, selectedEntryIds: journal.map(entry => entry.id), mappedEntryIds: [], globalEntryIds: [], excludedOperational: [], unsupportedRegulatory: [], legacy: [], warnings: [] };
  const mapped: { entry: AuditEntry; scope: JournalScope; company: Company; xml: string }[] = [];
  const receipts = all.filter(entry => entry.action === 'receipt.create').map(entry => (entry.details as JournalDetails).receipt).filter((receipt): receipt is Receipt => !!receipt);
  const days = store.all<BusinessDay>('day');
  for (const entry of journal) {
    const details = entry.details as JournalDetails;
    const scope = scopes.get(entry.id)!;
    const context = contexts.get(entry.id);
    const issue = (code: string, reason: string): JournalCoverageIssue => ({ entryId: entry.id, action: entry.action, registerId: scope.registerId, code, reason });
    if (scope.kind === 'global') coverage.globalEntryIds.push(entry.id);
    if (scope.kind === 'legacy' || scope.kind === 'unknown') coverage.legacy.push({ entryId: entry.id, registerId: scope.registerId, source: scope.source });
    const aggregate = entry.action === 'day.close' ? details.day?.report : details.report;
    if (operationalActions.has(entry.action) || (['server.start', 'auth.login', 'auth.logout'].includes(entry.action) && scope.kind === 'global') || (entry.action === 'print.reprint' && details.kind !== 'guest')) {
      coverage.excludedOperational.push(issue('OUTSIDE_XML_EVENT_MODEL', 'Operativ uppgift, inställningshistorik eller sammanställning; ursprungsposten bevaras i JSON och ersätter inte en kassahändelse.'));
      continue;
    }
    try {
      if (aggregate && !isRegisterReport(aggregate) && aggregate.registers) {
        const action = entry.action === 'day.close' ? 'report.register_z' : 'report.register_x';
        // Do not silently discard an aggregate whose corresponding immutable
        // register snapshots were never journalled, or were subsequently lost.
        demand(aggregate.registers.length > 0 && aggregate.registers.every(report => all.some(candidate => candidate.id < entry.id && candidate.action === action && JSON.stringify((candidate.details as JournalDetails).report) === JSON.stringify(report))), 'Sammanställningens kassaspecifika rapporter saknas i journalen.', 409, 'XML_REGISTER_REPORTS_MISSING');
        coverage.excludedOperational.push(issue('REGISTER_REPORT_AGGREGATE', 'Sammanställning med separat journalförda kassaspecifika rapporter. Alla ursprungliga rapportfält finns i JSON.'));
        continue;
      }
      demand(scope.registerId, 'Händelsen saknar historisk kassaidentitet. Den globala eller okända omfattningen får inte skrivas om.', 409, 'LEGACY_JOURNAL_IDENTITY');
      let company = context?.company;
      let contents: string[] = [];
      if (entry.action === 'receipt.create') {
        const receipt = details.receipt;
        demand(receipt, 'Kvittots journalögonblicksbild saknas.', 409, 'JOURNAL_RECEIPT_DATA');
        demand(receipt.registerId === scope.registerId, 'Kvittots kassaidentitet motsäger journalhändelsens identitet.', 409, 'XML_IDENTITY_CONFLICT');
        company = receipt.company;
        const day = days.find(candidate => candidate.id === receipt.dayId);
        const sequence = (receipt as Receipt & { zReportSequence?: number }).zReportSequence ?? (scope.kind === 'legacy' ? day?.number : undefined);
        demand(Number.isSafeInteger(sequence) && sequence! > 0, 'Kvittots historiska referens till kassans Z-rapport saknas.', 409, 'XML_RECEIPT_Z_SEQUENCE');
        contents.push(trainingReceipt(receipt, sequence!));
        if (receipt.payment.allocations.some(allocation => (allocation as QuantityAllocation).quantityBasis === 'amount-share')) coverage.warnings.push({ entryId: entry.id, code: 'ECONOMIC_QUANTITY_SHARE', reason: 'Exakt ekonomisk artikelandel återges. Modellen är fortfarande övning och har inte verifierats mot en verklig kontrollösning.' });
        if (receipt.kind === 'sale' && receipt.tab.status === 'paid') contents.push(group('StangaParkering', element('IdentitetsbeteckningPaParkering', receipt.tab.id)));
      } else if (entry.action === 'tab.create') contents.push(group('OppnaParkering', element('IdentitetsbeteckningPaParkering', entry.entityId)));
      else if (entry.action === 'tab.void') contents.push(group('StangaParkering', element('IdentitetsbeteckningPaParkering', entry.entityId)));
      else if (['tab.add', 'tab.remove', 'tab.price', 'tab.discount'].includes(entry.action)) {
        contents = changedArticles(details);
        if (!contents.length) { coverage.excludedOperational.push(issue('NO_ARTICLE_VALUE_CHANGE', 'Före-/efterbilderna innehåller ingen ändring av föreskrivna artikelvärden. Båda bilderna finns i JSON.')); continue; }
      } else if (entry.action === 'drawer.open') contents.push(element('OppnaKassaladaVidNollforsaljning', 'JA'));
      else if (entry.action === 'auth.login') contents.push(element('InloggningIKassaregister', 'JA'));
      else if (entry.action === 'auth.logout') contents.push(element('UtloggningUrKassaregister', 'JA'));
      else if (entry.action === 'register.enrolled' || entry.action === 'server.start') contents.push(element('StartAvKassaregister', 'JA'), element('StallaOmTillOvningslage', 'JA'));
      else if (entry.action === 'register.restart') contents.push(element('OmstartAvKassaregister', 'JA'));
      else if (entry.action === 'day.open' && details.day) contents.push(group('ForandraVaxelkassa', element('ForandringAvVaxelkassaISvenskaKronor', decimal(details.day.floatOre))));
      else if (entry.action === 'cash.move') {
        demand((details.direction === 'in' || details.direction === 'out') && Number.isSafeInteger(details.amountOre) && details.amountOre! > 0, 'Kassaförändringens journaldata är ofullständiga.', 409, 'JOURNAL_CASH_DATA');
        contents.push(group('ForandraVaxelkassa', element('ForandringAvVaxelkassaISvenskaKronor', decimal(details.amountOre! * (details.direction === 'in' ? 1 : -1)))));
      } else if (entry.action === 'report.register_x' || entry.action === 'report.register_z') {
        demand(isRegisterReport(details.report), 'Kassans rapportögonblicksbild saknas.', 409, 'JOURNAL_REPORT_DATA');
        demand(details.report.scope === 'register', 'Rapporten gäller äldre gemensam historik och får inte ges ett nytt kassalöpnummer.', 409, 'XML_LEGACY_REGISTER_REPORT');
        demand(details.report.registerId === scope.registerId, 'Rapportens kassaidentitet motsäger journalhändelsen.', 409, 'XML_IDENTITY_CONFLICT');
        company = details.report.company;
        contents = registerDayReport(details.report);
        for (const reason of details.report.coverage.issues) coverage.warnings.push({ entryId: entry.id, code: 'REPORT_COVERAGE', reason });
      } else if ((entry.action === 'day.close' || entry.action === 'report.x') && details.day) {
        const report = entry.action === 'day.close' ? details.day.report : details.report;
        demand(report && !isRegisterReport(report) && context, 'Dagsrapportens historiska ögonblicksbild saknas.', 409, 'JOURNAL_REPORT_DATA');
        company = report.training?.company ?? context.company;
        demand((report.training?.registerId ?? context.registerId) === scope.registerId, 'Äldre rapportidentitet motsäger journalhändelsen.', 409, 'XML_IDENTITY_CONFLICT');
        contents = dayReport(details.day, report, context, receipts, entry.action === 'day.close' ? 'Z' : 'X', entry.at);
      } else if (entry.action === 'print.reprint' && details.kind === 'guest') {
        throw new AppError(409, 'XML_TRAINING_COPY_UNSUPPORTED', 'Kopia av övningskvitto saknar verifierad XML-mappning. Originalreferens och kopiehändelse finns i JSON; den får inte utges för skarpt kassakvitto.');
      } else throw new AppError(409, 'XML_EVENT_UNSUPPORTED', `Journalhändelsen ${entry.action} saknar verifierad XML-mappning.`);
      demand(company, 'Äldre journalposter saknar historisk kassa-/företagsidentitet. JSON bevarar historiken.', 409, 'LEGACY_JOURNAL_IDENTITY');
      element('ForetagetsNamn', company.name);
      element('DenAdressDarForsaljningSker', `${company.address}, ${company.city}`);
      demand(/^\d{10}$/.test(company.organizationNumber), 'Journalpostens historiska organisationsnummer är ogiltigt.', 409, 'XML_COMPANY_IDENTITY');
      const xml = contents.map(content => group('Handelse', element('InloggadAnvandare', journalUser(entry.actor)) + element('Kassabeteckning', scope.registerId) + element('Registreringstidpunkt', xmlTime(entry.at)) + content)).join('\n');
      mapped.push({ entry, scope, company, xml });
      coverage.mappedEntryIds.push(entry.id);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      coverage.unsupportedRegulatory.push(issue(error.code, error.message));
    }
  }
  coverage.registerIds = [...new Set(mapped.map(item => item.scope.registerId!))];
  if (new Set(mapped.map(item => item.company.organizationNumber)).size > 1) coverage.unsupportedRegulatory.push({ entryId: mapped[0].entry.id, action: 'export', registerId: null, code: 'XML_MULTIPLE_COMPANIES', reason: 'Perioden innehåller flera organisationsnummer. Exportera varje företags period separat.' });
  coverage.canExportXml = mapped.length > 0 && coverage.unsupportedRegulatory.length === 0;
  return { settings, all, journal, scopes, coverage, mapped };
}
export function journalExportCoverage(store: Store, at: string, from?: string, to?: string, registerId?: string): JournalExportCoverage {
  return prepareJournal(store, at, from, to, registerId).coverage;
}
function exportSource(store: Store, explicit?: string): string {
  // Direct library calls default to the permanent main register. API calls pass
  // the authenticated register explicitly; the selected journal scope is not
  // evidence of where the export took place.
  const main = store.all<{ id: string; kind: string }>('device').find(device => device.kind === 'main');
  const currentMain = main && store.all<{ id: string; deviceId: string }>('register').find(register => register.deviceId === main.id);
  const source = explicit ?? (currentMain ? currentMain.id : store.get<Settings>('settings', 'settings')!.registerId);
  demand(source.length > 0, 'Kassan som exporten görs från saknas.', 409, 'XML_EXPORT_SOURCE');
  return source;
}
export function exportXml(store: Store, user: string, at: string, from?: string, to?: string, registerId?: string, exportingRegisterId?: string): string {
  const { journal, coverage, mapped } = prepareJournal(store, at, from, to, registerId);
  if (!coverage.canExportXml) throw new AppError(409, 'JOURNAL_XML_INCOMPLETE', coverage.unsupportedRegulatory[0]?.reason ?? 'Urvalet innehåller inga kassahändelser som kan återges i XML. Hämta JSON-underlaget.', coverage);
  const exportCompany = mapped.at(-1)!.company;
  const registerIds = coverage.registerIds;
  const source = exportSource(store, exportingRegisterId);
  const body = element('InloggadAnvandareVidExportAvDataFranJournalminnet', user) + element('BeteckningPaDetKassaregisterSomExportAvDataFranJournalminnetSkerIfran', source) + element('TidpunktForNarExportAvDataFranJournalminnetSker', xmlTime(at)) + group('ValdPeriodForExportAvDataFranJournalminne', element('ValdStarttidpunktForExportAvDataFranJournalminnet', from ? `${from}T00:00:00` : xmlTime(journal[0].at)) + element('ValdSluttidpunktForExportAvDataFranJournalminnet', to ? `${to}T23:59:59` : xmlTime(at))) + group('BeteckningPaValdaKassaregisterForExportAvDataFranJournalminnenLISTA', registerIds.map(id => element('BeteckningPaValtKassaregisterForExportAvDataFranJournalminnet', id)).join('')) + group('InformationOmForetaget', element('OrganisationsnummerEllerPersonnummer', exportCompany.organizationNumber) + element('ForetagetsNamn', exportCompany.name) + element('NamnPaVerksamheten', 'Lagustosa TRÄNING') + element('DenAdressDarForsaljningSker', `${exportCompany.address}, ${exportCompany.city}`)) + group('KassaregistersystemLISTA', registerIds.map(id => group('Kassaregistersystemet', registerModel(id, mapped.filter(item => item.scope.registerId === id).every(item => item.scope.kind === 'legacy')) + element('Kassabeteckning', id) + element('TillverkningsnummerForKontrollenheten', controlSerial))).join('')) + group('RegistreringLISTA', mapped.map(item => item.xml).join('\n'));
  // Comments are outside the official data model. They make scope exclusions
  // visible without inventing a register or mislabelling an event OvrigRapport.
  const comment = escapeXml(JSON.stringify({ notice: 'ÖVNINGSJOURNAL. Ingen fullständig regeluppfyllelse verifierad. Orörda poster och omfattning finns i kompletterande JSON.', coverage })).replace(/--/g, '&#45;&#45;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${comment} -->\n<ExportAvDataFranJournalminneEnligtSKVFS2021-16 xmlns="${instance}" xmlns:k="${component}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${instance} vendor/skatteverket/xmls/instans/utredningsstod/2021-12-08/ExportAvDataFranJournalminneEnligtSKVFS202116-2021-12-08.xsd">\n${body}\n</ExportAvDataFranJournalminneEnligtSKVFS2021-16>`;
}

function containsCredential(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => /^(pin|pinHash|codeHash|password|secret|accessToken|refreshToken|sessionToken)$/i.test(key) || containsCredential(child));
}
export function exportJournalJson(store: Store, user: string, at: string, from?: string, to?: string, registerId?: string, exportingRegisterId?: string): string {
  const { all, journal, scopes, coverage } = prepareJournal(store, at, from, to, registerId);
  demand(!journal.some(entry => containsCredential(entry.details)), 'Journalunderlaget innehåller autentiseringsuppgifter. Exporten är spärrad tills datainnehållet har utretts.', 409, 'JOURNAL_CREDENTIAL_DATA');
  const originalIds = new Set(journal.flatMap(entry => {
    const details = entry.details as JournalDetails;
    return [details.receiptId, details.receipt?.originalReceiptId].filter((id): id is string => !!id);
  }));
  const referencedReceipts = all.filter(entry => entry.action === 'receipt.create' && originalIds.has(entry.entityId)).map(entry => ({ entryId: entry.id, receipt: (entry.details as JournalDetails).receipt }));
  demand(!containsCredential(referencedReceipts), 'Journalunderlaget innehåller autentiseringsuppgifter.', 409, 'JOURNAL_CREDENTIAL_DATA');
  return JSON.stringify({
    format: 'lagustosa-training-journal', version: 2, training: true, exportedBy: user, exportedAt: at, exportingRegisterId: exportSource(store, exportingRegisterId),
    period: { from: from ?? null, to: to ?? null, timeZone: 'Europe/Stockholm' },
    scope: { requestedRegisterId: registerId ?? null, includesGlobalContext: true, includesUnattributedHistoricalContext: true,
      entries: journal.map(entry => ({ entryId: entry.id, ...scopes.get(entry.id)! })) },
    coverage,
    integrity: { algorithm: 'SHA-256', firstEntryId: journal[0].id, lastEntryId: journal.at(-1)!.id,
      previousHash: journal[0].previousHash, lastHash: journal.at(-1)!.hash,
      contiguous: journal.every((entry, index) => index === 0 || entry.previousHash === journal[index - 1].hash),
      sourceJournalVerified: true, sourceLastEntryId: all.at(-1)!.id, sourceLastHash: all.at(-1)!.hash, externallyAttested: false },
    notice: 'Kompletterande övningsunderlag med orörda poster i angivet urval. Global och okänd historisk omfattning redovisas separat och tilldelas inte vald kassa. Filtrerade hashkedjor kan ha luckor. Ersätter inte föreskriven XML-export, certifierad kontrollösning eller arkiveringsrutin.',
    referencedReceipts,
    entries: journal,
  }, null, 2);
}

export function exportCsv(day: BusinessDay, report: DayReport): string {
  const safeCell = (value: unknown) => {
    const text = String(value);
    return `"${(/^[\s]*[=+@-]/.test(text) && typeof value !== 'number' && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
  };
  const rows: unknown[][] = [['TEST — inga riktiga betalningar'], ['Verksamhetsdag', day.date], ['Post', 'SEK'], ['Försäljning', decimal(report.salesOre)], ['Returer', decimal(report.refundsOre)], ['Netto', decimal(report.netOre)], ['Dricks', decimal(report.tipsOre)], ['Moms', decimal(report.vatOre)], ['Växelkassa', decimal(day.floatOre)], ['Förväntad kontantkassa', decimal(report.expectedCashOre)], ['Räknad kontantkassa', day.countedCashOre === null ? '' : decimal(day.countedCashOre)], ['Differens', report.differenceOre === null ? '' : decimal(report.differenceOre)], [], ['Betalsätt', 'Försäljning', 'Returer', 'Dricks', 'Netto'], ...report.methods.map(method => [method.method, decimal(method.salesOre), decimal(method.refundsOre), decimal(method.tipsOre), decimal(method.netOre)]), [], ['Momssats', 'Brutto', 'Moms'], ...report.vat.map(total => [decimal(total.vatBps), decimal(total.grossOre), decimal(total.vatOre)])];
  const details = report.training;
  if (details) {
    rows.splice(1, 0, ['Rapport', report.registers?.length ? 'ÖVNING · SAMLAD DAGSAVSTÄMNING' : `ÖVNING · ${details.kind}-DAGRAPPORT`], [report.registers?.length ? 'Verksamhetsdagsnummer' : 'Rapportnummer', details.sequence ?? ''], ['Framställd', xmlTime(details.generatedAt)], ['Företag', details.company.name], ['Organisationsnummer', details.company.organizationNumber], [report.registers?.length ? 'Kassaunderlag' : 'Kassa', report.registers?.length ?? details.registerId]);
    rows.push([], ['Kontanthändelser i övning', 'SEK'], ['Insättningar', decimal(details.cashDepositsOre ?? 0)], ['Uttag', decimal(details.cashWithdrawalsOre ?? 0)]);
    rows.push([], ['Övningsregistreringar', 'Antal', 'SEK'], ['Övningskvitton', details.trainingReceipts, decimal(report.netOre)], ['Varav testreturer', details.refundReceipts, decimal(report.refundsOre)], ['Kvittokopior', details.receiptCopies, decimal(details.receiptCopiesOre)], ['Simulerade lådöppningar', details.drawerOpenings, ''], ['Rabatt på betalda rader', '', decimal(details.discountsOre)], ['Pris-/radrättelser', details.reductionsCount, decimal(details.reductionsOre)], ['Oavslutade notor, kvar att betala', report.openTabs, decimal(details.openTabAmountOre)], [], ['Huvudgrupp', 'Övningsförsäljning SEK'], ...details.categories.map(category => [category.name, decimal(category.salesOre)]), [], ['Ackumulerade övningsbelopp', 'SEK'], ['Försäljning', decimal(details.cumulativeSalesOre)], ['Returer', decimal(details.cumulativeRefundsOre)], ['Netto', decimal(details.cumulativeNetOre)], [], ['TRÄNING · ej bokföringsunderlag']);
  }
  return '\uFEFF' + rows.map(row => row.map(safeCell).join(';')).join('\r\n');
}
