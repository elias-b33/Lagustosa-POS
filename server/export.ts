import type { AuditEntry, BusinessDay, DayReport, OrderLine, Receipt, Settings, Tab } from '../shared/types';
import { calculateTab, roundRatio } from '../shared/money';
import { Store } from './db';
import { demand } from './errors';

const instance = 'http://xmls.skatteverket.se/se/skatteverket/td/instans/utredningsstod/1.0';
const component = 'http://xmls.skatteverket.se/se/skatteverket/td/komponent/utredningsstod/1.0';
const controlSerial = 'TEST-000000000001';
const escapeXml = (value: unknown) => String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const element = (name: string, value: unknown) => `<k:${name}>${escapeXml(value)}</k:${name}>`;
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
  return element('IdentitetsbeteckningForRegistreringAvArtiklar', line.id) + element('TypAvArtikel', 'VARA') + element('Artikelnummer', line.itemId) + element('Artikelnamn', line.name) + element('AntalAvRegistreradArtikel', line.quantity) + element('PrisPerEnhet', decimal(line.unitPriceOre)) + element('PrisPaRegistreradArtikel', decimal(grossOre)) + element('MervardesskattesatsForRegistreradArtikel', decimal(line.vatBps)) + element('MervardesskattPaRegistreradArtikel', decimal(vatOre));
}
function trainingReceipt(receipt: Receipt, dayNumber: number): string {
  const payment = receipt.payment;
  const sign = receipt.kind === 'sale' ? 1 : -1;
  const rows = payment.allocations.map(allocation => {
    const line = receipt.tab.lines.find(candidate => candidate.id === allocation.lineId)!;
    const title = `Delbelopp ${line.quantity} × ${line.name}${receipt.kind === 'refund' ? ' · retur' : ''}`;
    return group('SaldArtikel', element('IdentitetsbeteckningForRegistreringAvArtiklar', line.id) + element('TypAvArtikel', 'VARA') + element('Artikelnummer', line.itemId) + element('Artikelnamn', title.slice(0, 72)) + element('AntalAvSaldArtikel', sign) + element('PrisPaSaldArtikel', decimal(sign * allocation.grossOre)) + element('MervardesskattesatsForSaldArtikel', decimal(allocation.vatBps)) + element('MervardesskattPaSaldArtikel', decimal(sign * allocation.vatOre)) + element('ArtikelnsRegistreringstidpunkt', xmlTime(line.createdAt)));
  }).join('');
  return group('Ovningskvitto', element('ForetagetsNamn', receipt.company.name) + element('OrganisationsnummerEllerPersonnummer', receipt.company.organizationNumber) + element('DenAdressDarForsaljningSker', `${receipt.company.address}, ${receipt.company.city}`) + element('DatumOchKlockslagNarKvittoFramstalls', xmlTime(receipt.createdAt)) + element('LopnummerForOvningskvitto', receipt.number) + element('Kassabeteckning', receipt.registerId) + element('IdentitetsbeteckningPaParkering', receipt.tab.id) + group('SaldaArtiklarLISTA', rows) + element('TotaltForsaljningsbeloppISvenskaKronor', decimal(sign * payment.amountOre)) + element('MervardesskattPaForsaljningsbeloppet', decimal(sign * payment.allocations.reduce((sum, allocation) => sum + allocation.vatOre, 0))) + methods(sign * payment.amountOre, { card: 'Kort', cash: 'Kontanter', swish: 'Swish' }[payment.method]) + vatList(payment.allocations, sign) + element('LopnummerForZDagrapportPaKvitto', dayNumber) + element('TillverkningsnummerForKontrollenheten', controlSerial));
}
function dayClosing(day: BusinessDay, settings: Settings, receipts: Receipt[]): string {
  const report = day.report!;
  const previous = receipts.filter(receipt => receipt.createdAt <= day.closedAt!);
  const totalSales = previous.filter(receipt => receipt.kind === 'sale').reduce((sum, receipt) => sum + receipt.payment.amountOre, 0);
  const totalRefunds = previous.filter(receipt => receipt.kind === 'refund').reduce((sum, receipt) => sum + receipt.payment.amountOre, 0);
  const zeroNames = ['AntalKassakvitton', 'AntalReturer', 'ReturernasBelopp', 'RabatternasBelopp', 'AntalOvrigaRegistreringarSomMinskatDagensForsaljningsbelopp', 'TotaltBeloppAvOvrigaRegistreringarSomMinskatDagensForsaljningsbelopp', 'AntalOavslutadeForsaljningar', 'TotaltBeloppAvOavslutadeForsaljningar', 'GrandTotalForsaljning', 'GrandTotalRetur', 'GrandTotalNetto'];
  return group('ZDagrapport', element('ForetagetsNamn', settings.company.name) + element('OrganisationsnummerEllerPersonnummer', settings.company.organizationNumber) + element('DatumOchKlockslagNarRapportFramstalls', xmlTime(day.closedAt!)) + element('LopnummerForZDagrapport', day.number) + element('Kassabeteckning', settings.registerId) + element('TillverkningsnummerForKassaregistret', 'LAGUSTOSA-TRAINING-01') + element('ModellbeteckningForKassaregistret', 'Lagustosa Kassa TRÄNING') + element('ModellEllerProgramForKassaregistret', 'Lagustosa Kassa') + element('VersionsnummerForKassaregistret', '0.1.0') + element('TotalForsaljningssumma', '0.00') + vatList([{ vatBps: 0, vatOre: 0 }]) + element('VaxelkassansBeloppISvenskaKronor', decimal(day.floatOre)) + element(zeroNames[0], 0) + element('AntalKvittonSomTagitsFramIOvningslage', receipts.filter(receipt => receipt.dayId === day.id).length) + element('TotaltBeloppIOvningslage', decimal(report.netOre)) + methods(0, 'TRÄNING') + zeroNames.slice(1).map(name => element(name, name.startsWith('Antal') ? 0 : '0.00')).join('')) + group('OvrigRapport', element('NamnPaOvrigRapport', 'TRÄNING · ekonomisk avstämning') + element('Sokparameter', `Dag ${day.number}; netto ${decimal(report.netOre)}; dricks ${decimal(report.tipsOre)}; träning grand total försäljning ${decimal(totalSales)}; retur ${decimal(totalRefunds)}`));
}

export function exportXml(store: Store, user: string, at: string, from?: string, to?: string): string {
  const settings = store.get<Settings>('settings', 'settings')!;
  const journal = store.journal().filter(entry => (!from || xmlTime(entry.at).slice(0, 10) >= from) && (!to || xmlTime(entry.at).slice(0, 10) <= to));
  demand(journal.length > 0, 'Det finns inga journalhändelser i perioden.');
  demand(!from || !to || from <= to, 'Startdatum måste komma före slutdatum.');
  demand(store.verifyJournal(), 'Journalens kontrollsumma stämmer inte. Exporten har stoppats.', 409);
  const receipts = store.all<Receipt>('receipt');
  const days = store.all<BusinessDay>('day');
  const eventXml = (entry: AuditEntry, content: string) => group('Handelse', element('InloggadAnvandare', entry.actor.slice(0, 72)) + element('Kassabeteckning', settings.registerId) + element('Registreringstidpunkt', xmlTime(entry.at)) + content);
  const events = journal.map(entry => {
    const details = entry.details as { tab?: Tab; before?: Tab; reason?: string; receipt?: Receipt; day?: BusinessDay };
    let content = '';
    if (entry.action === 'receipt.create') {
      const receipt = receipts.find(candidate => candidate.id === entry.entityId)!;
      content = trainingReceipt(receipt, days.find(day => day.id === receipt.dayId)!.number);
    } else if (entry.action === 'tab.create') content = group('OppnaParkering', element('IdentitetsbeteckningPaParkering', entry.entityId));
    else if (entry.action === 'tab.void') content = group('StangaParkering', element('IdentitetsbeteckningPaParkering', entry.entityId));
    else if (entry.action === 'tab.add' && details.tab && details.before) {
      const line = details.tab.lines.find(candidate => !details.before!.lines.some(before => before.id === candidate.id))!;
      const totals = calculateTab(details.tab).lines.find(candidate => candidate.lineId === line.id)!;
      content = group('RegistreraArtikel', article(line, totals.grossOre, totals.vatOre));
    } else if (entry.action === 'tab.remove' && details.tab && details.before) {
      const line = details.before.lines.find(candidate => candidate.status !== 'void' && details.tab!.lines.find(after => after.id === candidate.id)?.status === 'void')!;
      const grossOre = line.unitPriceOre * line.quantity;
      content = group('RaderaParkeradArtikel', article(line, grossOre, roundRatio(grossOre * line.vatBps, 10000 + line.vatBps)) + element('IdentitetsbeteckningPaParkering', details.tab.id) + element('UrsprungligRegistreringstidpunkt', xmlTime(line.createdAt)));
    } else if (entry.action === 'drawer.open') content = element('OppnaKassaladaVidNollforsaljning', 'JA');
    else if (entry.action === 'day.close' && details.day?.report) {
      const combined = dayClosing(details.day, settings, receipts);
      const splitAt = combined.indexOf('<k:OvrigRapport>');
      return eventXml(entry, combined.slice(0, splitAt)) + eventXml(entry, combined.slice(splitAt));
    }
    if (!content) content = group('OvrigRapport', element('NamnPaOvrigRapport', `TRÄNING · ${entry.action}`.slice(0, 72)) + element('Sokparameter', `Journal ${entry.id}; objekt ${entry.entityId}; SHA256 ${entry.hash}`.slice(0, 256)));
    return eventXml(entry, content);
  }).join('\n');
  const body = element('InloggadAnvandareVidExportAvDataFranJournalminnet', user.slice(0, 72)) + element('BeteckningPaDetKassaregisterSomExportAvDataFranJournalminnetSkerIfran', settings.registerId) + element('TidpunktForNarExportAvDataFranJournalminnetSker', xmlTime(at)) + group('ValdPeriodForExportAvDataFranJournalminne', element('ValdStarttidpunktForExportAvDataFranJournalminnet', from ? `${from}T00:00:00` : xmlTime(journal[0].at)) + element('ValdSluttidpunktForExportAvDataFranJournalminnet', to ? `${to}T23:59:59` : xmlTime(at))) + group('BeteckningPaValdaKassaregisterForExportAvDataFranJournalminnenLISTA', element('BeteckningPaValtKassaregisterForExportAvDataFranJournalminnet', settings.registerId)) + group('InformationOmForetaget', element('OrganisationsnummerEllerPersonnummer', settings.company.organizationNumber) + element('ForetagetsNamn', settings.company.name) + element('NamnPaVerksamheten', 'Lagustosa TRÄNING') + element('DenAdressDarForsaljningSker', `${settings.company.address}, ${settings.company.city}`)) + group('KassaregistersystemLISTA', group('Kassaregistersystemet', element('TillverkningsnummerForKassaregistret', 'LAGUSTOSA-TRAINING-01') + element('ModellbeteckningForKassaregistret', 'Lagustosa Kassa TRÄNING') + element('ModellEllerProgramForKassaregistret', 'Lagustosa Kassa') + element('VersionsnummerForKassaregistret', '0.1.0') + element('Kassabeteckning', settings.registerId) + element('TillverkningsnummerForKontrollenheten', controlSerial))) + group('RegistreringLISTA', events);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ExportAvDataFranJournalminneEnligtSKVFS2021-16 xmlns="${instance}" xmlns:k="${component}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${instance} vendor/skatteverket/xmls/instans/utredningsstod/2021-12-08/ExportAvDataFranJournalminneEnligtSKVFS202116-2021-12-08.xsd">\n${body}\n</ExportAvDataFranJournalminneEnligtSKVFS2021-16>`;
}

export function exportCsv(day: BusinessDay, report: DayReport): string {
  const safeCell = (value: unknown) => {
    const text = String(value);
    return `"${(/^[=+@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
  };
  const rows: unknown[][] = [['TEST — inga riktiga betalningar'], ['Verksamhetsdag', day.date], ['Post', 'SEK'], ['Försäljning', decimal(report.salesOre)], ['Returer', decimal(report.refundsOre)], ['Netto', decimal(report.netOre)], ['Dricks', decimal(report.tipsOre)], ['Moms', decimal(report.vatOre)], ['Växelkassa', decimal(day.floatOre)], ['Förväntad kontantkassa', decimal(report.expectedCashOre)], ['Räknad kontantkassa', day.countedCashOre === null ? '' : decimal(day.countedCashOre)], ['Differens', report.differenceOre === null ? '' : decimal(report.differenceOre)], [], ['Betalsätt', 'Försäljning', 'Returer', 'Dricks', 'Netto'], ...report.methods.map(method => [method.method, decimal(method.salesOre), decimal(method.refundsOre), decimal(method.tipsOre), decimal(method.netOre)]), [], ['Momssats', 'Brutto', 'Moms'], ...report.vat.map(total => [decimal(total.vatBps), decimal(total.grossOre), decimal(total.vatOre)])];
  return '\uFEFF' + rows.map(row => row.map(safeCell).join(';')).join('\r\n');
}
