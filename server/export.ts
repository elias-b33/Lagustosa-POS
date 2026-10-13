import type { AuditEntry, BusinessDay, DayReport, OrderLine, Receipt, Settings, Tab } from '../shared/types';
import { calculateTab } from '../shared/money';
import { Store } from './db';
import { demand } from './errors';

const instance = 'http://xmls.skatteverket.se/se/skatteverket/td/instans/utredningsstod/1.0';
const component = 'http://xmls.skatteverket.se/se/skatteverket/td/komponent/utredningsstod/1.0';
const controlSerial = 'TEST-000000000001';
const xmlTextLimits: Record<string, number> = Object.fromEntries(['Artikelnummer', 'Artikelnamn', 'Kassabeteckning', 'ForetagetsNamn', 'DenAdressDarForsaljningSker', 'InloggadAnvandare', 'InloggadAnvandareVidExportAvDataFranJournalminnet', 'OrsakTillAndring', 'IdentitetsbeteckningForRegistreringAvArtiklar', 'NamnPaHuvudgrupp', 'NamnPaOvrigRapport'].map(name => [name, 72]));
xmlTextLimits.Sokparameter = 256;
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
function article(line: OrderLine, grossOre: number, vatOre: number): string {
  return element('IdentitetsbeteckningForRegistreringAvArtiklar', line.id) + element('TypAvArtikel', 'VARA') + (line.category ? element('NamnPaHuvudgrupp', line.category) : '') + element('Artikelnummer', line.itemId) + element('Artikelnamn', line.name) + element('AntalAvRegistreradArtikel', line.quantity) + element('PrisPerEnhet', decimal(line.unitPriceOre)) + element('PrisPaRegistreradArtikel', decimal(grossOre)) + element('MervardesskattesatsForRegistreradArtikel', decimal(line.vatBps)) + element('MervardesskattPaRegistreradArtikel', decimal(vatOre));
}
function trainingReceipt(receipt: Receipt, dayNumber: number): string {
  const payment = receipt.payment;
  const sign = receipt.kind === 'sale' ? 1 : -1;
  const totals = calculateTab(receipt.tab);
  const rows = payment.allocations.map(allocation => {
    const line = receipt.tab.lines.find(candidate => candidate.id === allocation.lineId);
    demand(line, 'Kvittots artikel saknas i den sparade ögonblicksbilden.', 409, 'JOURNAL_RECEIPT_DATA');
    const fullLine = allocation.grossOre === totals.lines.find(candidate => candidate.lineId === line.id)?.grossOre;
    // Monetary splits do not record a sold quantity. Keep these explicitly marked
    // as training portions until a fiscal, quantity-aware split model is designed.
    const title = fullLine ? line.name : `Delbelopp av ${line.quantity} × ${line.name}`;
    return group('SaldArtikel', element('IdentitetsbeteckningForRegistreringAvArtiklar', line.id) + element('TypAvArtikel', 'VARA') + (line.category ? element('NamnPaHuvudgrupp', line.category) : '') + element('Artikelnummer', line.itemId) + element('Artikelnamn', title) + element('AntalAvSaldArtikel', sign * (fullLine ? line.quantity : 1)) + element('PrisPaSaldArtikel', decimal(sign * allocation.grossOre)) + element('MervardesskattesatsForSaldArtikel', decimal(allocation.vatBps)) + element('MervardesskattPaSaldArtikel', decimal(sign * allocation.vatOre)) + element('ArtikelnsRegistreringstidpunkt', xmlTime(line.createdAt)));
  }).join('');
  return group('Ovningskvitto', element('ForetagetsNamn', receipt.company.name) + element('OrganisationsnummerEllerPersonnummer', receipt.company.organizationNumber) + element('DenAdressDarForsaljningSker', `${receipt.company.address}, ${receipt.company.city}`) + element('DatumOchKlockslagNarKvittoFramstalls', xmlTime(receipt.createdAt)) + element('LopnummerForOvningskvitto', receipt.number) + element('Kassabeteckning', receipt.registerId) + element('IdentitetsbeteckningPaParkering', receipt.tab.id) + group('SaldaArtiklarLISTA', rows) + element('TotaltForsaljningsbeloppISvenskaKronor', decimal(sign * payment.amountOre)) + element('MervardesskattPaForsaljningsbeloppet', decimal(sign * payment.allocations.reduce((sum, allocation) => sum + allocation.vatOre, 0))) + methods(sign * payment.amountOre, { card: 'Kort', cash: 'Kontanter', swish: 'Swish' }[payment.method]) + vatList(payment.allocations, sign) + element('LopnummerForZDagrapportPaKvitto', dayNumber) + element('TillverkningsnummerForKontrollenheten', controlSerial));
}
function registerModel(): string {
  return element('TillverkningsnummerForKassaregistret', 'LAGUSTOSA-TRAINING-01') + element('ModellbeteckningForKassaregistret', 'Lagustosa Kassa TRÄNING') + element('ModellEllerProgramForKassaregistret', 'Lagustosa Kassa') + element('VersionsnummerForKassaregistret', '0.1.0');
}
function dayReport(day: BusinessDay, report: DayReport, settings: Settings, receipts: Receipt[], kind: 'X' | 'Z', at: string): string[] {
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
    element('Kassabeteckning', registerId) + (kind === 'Z' ? registerModel() : '') +
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
type JournalDetails = { tab?: Tab; before?: Tab; reason?: string; receipt?: Receipt; day?: BusinessDay; report?: DayReport; previous?: Settings; settings?: Settings; direction?: 'in' | 'out'; amountOre?: number };
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
  if (!details.before || !details.tab) return [];
  const before = details.before;
  const tab = details.tab;
  const oldTotals = calculateTab(before);
  const totals = calculateTab(tab);
  const contents: string[] = [];
  for (const line of tab.lines) {
    const previous = before.lines.find(candidate => candidate.id === line.id);
    const oldTotal = oldTotals.lines.find(candidate => candidate.lineId === line.id);
    const total = totals.lines.find(candidate => candidate.lineId === line.id);
    if (!previous && total) {
      contents.push(group('RegistreraArtikel', article(line, total.grossOre, total.vatOre)));
      contents.push(group('ParkeraRegistreradArtikel', article(line, total.grossOre, total.vatOre) + element('IdentitetsbeteckningPaParkering', tab.id)));
    } else if (previous && oldTotal && !total) {
      contents.push(group('RaderaParkeradArtikel', article(previous, oldTotal.grossOre, oldTotal.vatOre) + element('IdentitetsbeteckningPaParkering', tab.id) + element('UrsprungligRegistreringstidpunkt', xmlTime(previous.createdAt))));
    } else if (previous && oldTotal && total && (line.quantity !== previous.quantity || line.unitPriceOre !== previous.unitPriceOre || oldTotal.grossOre !== total.grossOre || oldTotal.vatOre !== total.vatOre)) {
      contents.push(group('AndraParkeradArtikel', article(line, total.grossOre, total.vatOre) +
        element('TidigareAntalAvRegistreradArtikel', previous.quantity) + element('TidigarePrisPerEnhet', decimal(previous.unitPriceOre)) +
        element('TidigarePrisPaRegistreradArtikel', decimal(oldTotal.grossOre)) + element('TidigareMervardesskattesatsForRegistreradArtikel', decimal(previous.vatBps)) +
        element('TidigareMervardesskattPaRegistreradArtikel', decimal(oldTotal.vatOre)) + element('IdentitetsbeteckningPaParkering', tab.id) +
        element('UrsprungligRegistreringstidpunkt', xmlTime(previous.createdAt)) + (details.reason ? element('OrsakTillAndring', details.reason) : '')));
    }
  }
  return contents;
}

export function exportXml(store: Store, user: string, at: string, from?: string, to?: string): string {
  const settings = store.get<Settings>('settings', 'settings')!;
  const { all, journal } = journalSelection(store, at, from, to);
  const contexts = historicalSettings(all, settings);
  for (const entry of journal) demand(contexts.get(entry.id), 'Äldre journalposter saknar historisk kassa-/företagsidentitet. Hämta JSON-underlaget och utred uppgifterna; XML-exporten får inte skriva om historiken.', 409, 'LEGACY_JOURNAL_IDENTITY');
  const selectedSettings = journal.map(entry => contexts.get(entry.id)!);
  demand(new Set(selectedSettings.map(context => context.company.organizationNumber)).size === 1, 'Perioden innehåller flera organisationsnummer. Exportera varje företags period separat.', 409, 'XML_MULTIPLE_COMPANIES');
  const exportCompany = selectedSettings.at(-1)!.company;
  const registerIds = [...new Set(selectedSettings.map(context => context.registerId))];
  const receipts = store.all<Receipt>('receipt');
  const days = store.all<BusinessDay>('day');
  const eventXml = (entry: AuditEntry, content: string, registerId: string) => group('Handelse', element('InloggadAnvandare', journalUser(entry.actor)) + element('Kassabeteckning', registerId) + element('Registreringstidpunkt', xmlTime(entry.at)) + content);
  const events = journal.map(entry => {
    const context = contexts.get(entry.id)!;
    const details = entry.details as JournalDetails;
    let registerId = context.registerId;
    let contents: string[] = [];
    if (entry.action === 'receipt.create') {
      // Use the immutable audit snapshot, not a mutable entity lookup.
      const receipt = details.receipt;
      demand(receipt, 'Kvittots journalögonblicksbild saknas.', 409, 'JOURNAL_RECEIPT_DATA');
      const day = days.find(candidate => candidate.id === receipt.dayId);
      demand(day, 'Kvittots verksamhetsdag saknas.', 409, 'JOURNAL_RECEIPT_DATA');
      registerId = receipt.registerId;
      contents.push(trainingReceipt(receipt, day.number));
      if (receipt.kind === 'sale' && receipt.tab.status === 'paid') contents.push(group('StangaParkering', element('IdentitetsbeteckningPaParkering', receipt.tab.id)));
    } else if (entry.action === 'tab.create') contents.push(group('OppnaParkering', element('IdentitetsbeteckningPaParkering', entry.entityId)));
    else if (entry.action === 'tab.void') contents.push(group('StangaParkering', element('IdentitetsbeteckningPaParkering', entry.entityId)));
    else if (['tab.add', 'tab.remove', 'tab.price', 'tab.discount'].includes(entry.action)) contents = changedArticles(details);
    else if (entry.action === 'drawer.open') contents.push(element('OppnaKassaladaVidNollforsaljning', 'JA'));
    else if (entry.action === 'auth.login') contents.push(element('InloggningIKassaregister', 'JA'));
    else if (entry.action === 'auth.logout') contents.push(element('UtloggningUrKassaregister', 'JA'));
    else if (entry.action === 'server.start') contents.push(element('StartAvKassaregister', 'JA'), element('StallaOmTillOvningslage', 'JA'));
    else if (entry.action === 'day.open' && details.day) contents.push(group('ForandraVaxelkassa', element('ForandringAvVaxelkassaISvenskaKronor', decimal(details.day.floatOre))));
    else if (entry.action === 'cash.move') {
      demand((details.direction === 'in' || details.direction === 'out') && Number.isSafeInteger(details.amountOre) && details.amountOre! > 0, 'Kassaförändringens journaldata är ofullständiga.', 409, 'JOURNAL_CASH_DATA');
      contents.push(group('ForandraVaxelkassa', element('ForandringAvVaxelkassaISvenskaKronor', decimal(details.amountOre! * (details.direction === 'in' ? 1 : -1)))));
    }
    else if ((entry.action === 'day.close' || entry.action === 'report.x') && details.day) {
      const report = entry.action === 'day.close' ? details.day.report : details.report;
      demand(report, 'Dagsrapportens journalögonblicksbild saknas.', 409, 'JOURNAL_REPORT_DATA');
      registerId = report.training?.registerId ?? context.registerId;
      contents = dayReport(details.day, report, context, receipts, entry.action === 'day.close' ? 'Z' : 'X', entry.at);
    }
    // The official schema has no generic settings/event payload. This diagnostic
    // reference is not a claim of complete fiscal event mapping. The companion
    // JSON preserves every detail, original hash and original receipt reference.
    if (!contents.length) contents.push(group('OvrigRapport', element('NamnPaOvrigRapport', `TRÄNING · ${entry.action}`) + element('Sokparameter', `Journal ${entry.id}; objekt ${entry.entityId}; SHA256 ${entry.hash}; fullständiga data i JSON-underlaget`)));
    return contents.map(content => eventXml(entry, content, registerId)).join('\n');
  }).join('\n');
  const body = element('InloggadAnvandareVidExportAvDataFranJournalminnet', user) + element('BeteckningPaDetKassaregisterSomExportAvDataFranJournalminnetSkerIfran', settings.registerId) + element('TidpunktForNarExportAvDataFranJournalminnetSker', xmlTime(at)) + group('ValdPeriodForExportAvDataFranJournalminne', element('ValdStarttidpunktForExportAvDataFranJournalminnet', from ? `${from}T00:00:00` : xmlTime(journal[0].at)) + element('ValdSluttidpunktForExportAvDataFranJournalminnet', to ? `${to}T23:59:59` : xmlTime(at))) + group('BeteckningPaValdaKassaregisterForExportAvDataFranJournalminnenLISTA', registerIds.map(id => element('BeteckningPaValtKassaregisterForExportAvDataFranJournalminnet', id)).join('')) + group('InformationOmForetaget', element('OrganisationsnummerEllerPersonnummer', exportCompany.organizationNumber) + element('ForetagetsNamn', exportCompany.name) + element('NamnPaVerksamheten', 'Lagustosa TRÄNING') + element('DenAdressDarForsaljningSker', `${exportCompany.address}, ${exportCompany.city}`)) + group('KassaregistersystemLISTA', registerIds.map(id => group('Kassaregistersystemet', registerModel() + element('Kassabeteckning', id) + element('TillverkningsnummerForKontrollenheten', controlSerial))).join('')) + group('RegistreringLISTA', events);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ExportAvDataFranJournalminneEnligtSKVFS2021-16 xmlns="${instance}" xmlns:k="${component}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${instance} vendor/skatteverket/xmls/instans/utredningsstod/2021-12-08/ExportAvDataFranJournalminneEnligtSKVFS202116-2021-12-08.xsd">\n${body}\n</ExportAvDataFranJournalminneEnligtSKVFS2021-16>`;
}

function containsCredential(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => /^(pin|pinHash|codeHash|password|secret|accessToken|refreshToken|sessionToken)$/i.test(key) || containsCredential(child));
}
export function exportJournalJson(store: Store, user: string, at: string, from?: string, to?: string): string {
  const { journal } = journalSelection(store, at, from, to);
  demand(!journal.some(entry => containsCredential(entry.details)), 'Journalunderlaget innehåller autentiseringsuppgifter. Exporten är spärrad tills datainnehållet har utretts.', 409, 'JOURNAL_CREDENTIAL_DATA');
  return JSON.stringify({
    format: 'lagustosa-training-journal', version: 1, training: true, exportedBy: user, exportedAt: at,
    period: { from: from ?? null, to: to ?? null, timeZone: 'Europe/Stockholm' },
    integrity: { algorithm: 'SHA-256', firstEntryId: journal[0].id, lastEntryId: journal.at(-1)!.id,
      previousHash: journal[0].previousHash, lastHash: journal.at(-1)!.hash,
      contiguous: journal.every((entry, index) => index === 0 || entry.previousHash === journal[index - 1].hash),
      externallyAttested: false },
    notice: 'Kompletterande övningsunderlag med fullständiga journalposter. Ersätter inte föreskriven XML-export, certifierad kontrollösning eller arkiveringsrutin.',
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
    rows.splice(1, 0, ['Rapport', `ÖVNING · ${details.kind}-DAGRAPPORT`], ['Rapportnummer', details.sequence ?? ''], ['Framställd', xmlTime(details.generatedAt)], ['Företag', details.company.name], ['Organisationsnummer', details.company.organizationNumber], ['Kassa', details.registerId]);
    rows.push([], ['Kontanthändelser i övning', 'SEK'], ['Insättningar', decimal(details.cashDepositsOre ?? 0)], ['Uttag', decimal(details.cashWithdrawalsOre ?? 0)]);
    rows.push([], ['Övningsregistreringar', 'Antal', 'SEK'], ['Övningskvitton', details.trainingReceipts, decimal(report.netOre)], ['Varav testreturer', details.refundReceipts, decimal(report.refundsOre)], ['Kvittokopior', details.receiptCopies, decimal(details.receiptCopiesOre)], ['Simulerade lådöppningar', details.drawerOpenings, ''], ['Rabatt på betalda rader', '', decimal(details.discountsOre)], ['Pris-/radrättelser', details.reductionsCount, decimal(details.reductionsOre)], ['Oavslutade notor, kvar att betala', report.openTabs, decimal(details.openTabAmountOre)], [], ['Huvudgrupp', 'Övningsförsäljning SEK'], ...details.categories.map(category => [category.name, decimal(category.salesOre)]), [], ['Ackumulerade övningsbelopp', 'SEK'], ['Försäljning', decimal(details.cumulativeSalesOre)], ['Returer', decimal(details.cumulativeRefundsOre)], ['Netto', decimal(details.cumulativeNetOre)], [], ['TRÄNING · ej bokföringsunderlag']);
  }
  return '\uFEFF' + rows.map(row => row.map(safeCell).join(';')).join('\r\n');
}
