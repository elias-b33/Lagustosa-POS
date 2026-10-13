import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { exportJournalJson, exportXml, journalExportCoverage } from '../server/export';
import type { JournalExportCoverage, JournalScope } from '../server/export';
import type { Actor, AuditEntry, MenuItem, PrintJob, Receipt } from '../shared/types';
import { fixture, key } from './helpers';

const at = '2026-10-13T22:00:00Z';
const contents = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<k:${name}>([\\s\\S]*?)</k:${name}>`, 'g'))].map(match => match[1]);
function validate(xml: string) {
  const result = spawnSync(process.env.PYTHON ?? 'python', [path.resolve('scripts/validate-journal-xml.py'), '-'], { input: xml, encoding: 'utf8', timeout: 15000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}
type JournalData = {
  entries: AuditEntry[]; coverage: JournalExportCoverage;
  scope: { entries: (JournalScope & { entryId: number })[] };
  integrity: { contiguous: boolean; sourceJournalVerified: boolean };
  referencedReceipts: { entryId: number; receipt: Receipt }[];
};
function json(f: ReturnType<typeof fixture>, registerId?: string): JournalData {
  return JSON.parse(exportJournalJson(f.store, 'Ansvarig', at, undefined, undefined, registerId));
}
function classify(f: ReturnType<typeof fixture>, priceOre = 10000, itemKind: 'goods' | 'services' = 'goods') {
  f.service.saveMenu(f.admin, { ...f.store.get<MenuItem>('menu', 'bread')!, priceOre, itemKind });
}
function readyTab(f: ReturnType<typeof fixture>, actor: Actor = f.admin, quantity = 1) {
  const tab = f.service.createTab(actor, { key: key(), tableId: null, guestCount: 2, serviceMode: 'dine_in' });
  f.command(tab.id, { action: 'add', itemId: 'bread', quantity }, actor);
  return f.command(tab.id, { action: 'send' }, actor);
}

describe('Journalens kassaurval och semantiska omfattning', () => {
  it('isolerar samtidiga kvittoserier, behåller globala originalposter och redovisar hashkedjans urvalsluckor', async () => {
    const f = fixture(); classify(f); const day = f.open();
    const secondary = f.actor('admin', 'SERVERING-1');
    const mainId = f.service.registerFor(f.admin).id;
    const secondId = f.service.registerFor(secondary).id;
    await f.pay(readyTab(f).id);
    await f.pay(readyTab(f, secondary, 2).id, {}, secondary);
    f.service.takeReport(f.admin, day.id);
    f.service.closeDay(f.admin, day.id, { key: key(), countedCashOre: 150000 });
    const original = f.store.journal();
    for (const [registerId, expectedAmount] of [[mainId, '100.00'], [secondId, '200.00']]) {
      const xml = exportXml(f.store, 'Ansvarig', at, undefined, undefined, registerId);
      validate(xml);
      expect(contents(xml, 'BeteckningPaValtKassaregisterForExportAvDataFranJournalminnet')).toEqual([registerId]);
      expect(new Set(contents(xml, 'Kassabeteckning'))).toEqual(new Set([registerId]));
      expect(contents(xml, 'Ovningskvitto')).toHaveLength(1);
      expect(contents(xml, 'LopnummerForOvningskvitto')).toEqual(['1']);
      expect(contents(xml, 'TotaltForsaljningsbeloppISvenskaKronor')).toEqual([expectedAmount]);
      expect(contents(xml, 'XDagrapport')).toHaveLength(1);
      expect(contents(xml, 'ZDagrapport')).toHaveLength(1);
      expect(contents(xml, 'TotalForsaljningssumma')).toEqual(['0.00', '0.00']);
      expect(contents(xml, 'TotaltBeloppIOvningslage')).toEqual([expectedAmount, expectedAmount]);
      const data = json(f, registerId);
      expect(data.coverage).toMatchObject({ requestedRegisterId: registerId, canExportXml: true, fullComplianceVerified: false });
      expect(data.scope.entries.every(scope => scope.registerId === registerId || scope.registerId === null)).toBe(true);
      expect(data.coverage.globalEntryIds.length).toBeGreaterThan(0);
      expect(data.integrity).toMatchObject({ contiguous: false, sourceJournalVerified: true });
      expect(data.entries).toEqual(original.filter(entry => data.coverage.selectedEntryIds.includes(entry.id)));
      expect(data.coverage.excludedOperational.some(issue => issue.code === 'REGISTER_REPORT_AGGREGATE')).toBe(true);
    }
    expect(f.store.journal()).toEqual(original);
  });

  it('använder nya kassans första Z-löpnummer även om verksamhetens gemensamma dagnummer är högre', async () => {
    const f = fixture(); classify(f); const first = f.open();
    f.service.closeDay(f.admin, first.id, { key: key(), countedCashOre: 150000 });
    const device = f.service.saveDevice(f.admin, { name: 'Senare installerad kassa', kind: 'serving', station: null, active: true });
    const actor = f.actor('admin', device.code);
    const registerId = f.service.registerFor(actor).id;
    const second = f.open();
    expect(second.number).toBe(2);
    await f.pay(readyTab(f, actor).id, {}, actor);
    f.service.closeDay(f.admin, second.id, { key: key(), countedCashOre: 150000 });
    const xml = exportXml(f.store, 'Ansvarig', at, undefined, undefined, registerId);
    validate(xml);
    expect(contents(xml, 'LopnummerForZDagrapportPaKvitto')).toEqual(['1']);
    expect(contents(xml, 'LopnummerForZDagrapport')).toEqual(['1']);
  });

  it('skiljer exportkassan från de kassor vars journal valts för export', () => {
    const f = fixture();
    const source = f.service.registerFor(f.admin).id;
    const selected = f.service.registerFor(f.actor('admin', 'SERVERING-1')).id;
    const xml = exportXml(f.store, 'Ansvarig', at, undefined, undefined, selected, source);
    validate(xml);
    expect(contents(xml, 'BeteckningPaDetKassaregisterSomExportAvDataFranJournalminnetSkerIfran')).toEqual([source]);
    expect(contents(xml, 'BeteckningPaValtKassaregisterForExportAvDataFranJournalminnet')).toEqual([selected]);
    const data = JSON.parse(exportJournalJson(f.store, 'Ansvarig', at, undefined, undefined, selected, source));
    expect(data.exportingRegisterId).toBe(source);
    expect(data.scope.requestedRegisterId).toBe(selected);
  });

  it('återger bara uttryckligen journalförd kassaomstart och fördelar inte globala serverhändelser retroaktivt', () => {
    const f = fixture();
    const registerId = f.service.registerFor(f.admin).id;
    f.service.log('system', 'server.start', 'server', { mode: 'training', registerId: null });
    f.service.log('system', 'register.restart', registerId, { registerId });
    const xml = exportXml(f.store, 'Ansvarig', at, undefined, undefined, registerId);
    validate(xml);
    expect(contents(xml, 'OmstartAvKassaregister')).toEqual(['JA']);
    expect(contents(xml, 'StartAvKassaregister')).toEqual(['JA']);
    const restart = contents(xml, 'Handelse').find(event => event.includes('OmstartAvKassaregister'))!;
    expect(contents(restart, 'Kassabeteckning')).toEqual([registerId]);
  });

  it('redovisar negativt övningssaldo utan att nolla det eller skapa schemaogiltig dagsrapport', async () => {
    const f = fixture(); classify(f); const day = f.open();
    const payment = await f.pay(readyTab(f).id);
    const returning = f.actor('admin', 'SERVERING-1');
    const returningId = f.service.registerFor(returning).id;
    await f.service.refund(returning, payment.id, { key: key(), amountOre: payment.amountOre, reason: 'Retur i annan kassa', simulation: 'approved', fiscalSimulation: 'confirmed' });
    f.service.takeReport(f.admin, day.id);
    const data = json(f, returningId);
    expect(data.coverage.canExportXml).toBe(false);
    expect(data.coverage.unsupportedRegulatory.map(issue => issue.code)).toContain('XML_TRAINING_NET_NEGATIVE');
    const report = data.entries.find(entry => entry.action === 'report.register_x')!;
    expect(report.details).toMatchObject({ report: { training: { netOre: -10000, salesOre: 0, refundsOre: 10000 } } });
    expect(() => exportXml(f.store, 'Ansvarig', at, undefined, undefined, returningId)).toThrow('netto är negativt');
    // A different register with a positive training balance remains exportable.
    validate(exportXml(f.store, 'Ansvarig', at, undefined, undefined, f.service.registerFor(f.admin).id));
  });

  it('journalnedladdningens revisionsspår gör inte följande export ofullständig', () => {
    const f = fixture();
    for (const action of ['journal.export', 'journal.export_json']) f.service.log(f.admin, action, 'journal', { from: '2026-10-13', to: '2026-10-13' });
    const data = json(f);
    expect(data.coverage.canExportXml).toBe(true);
    for (const action of ['journal.export', 'journal.export_json']) expect(data.coverage.excludedOperational.some(issue => issue.action === action)).toBe(true);
    validate(exportXml(f.store, 'Ansvarig', at));
    expect(data.entries).toEqual(f.store.journal());
  });

  it('skapar ingen påhittad kassahändelse för inloggning på orderskärm eller serverstart', () => {
    const f = fixture();
    const login = f.service.login('kitchen', '4567', 'KOK-TEST', '127.0.0.1');
    const viewer = login.actor;
    f.service.logout(login.token, viewer);
    const viewerEntries = f.store.journal().filter(entry => entry.actor === `${viewer.staff.id}@${viewer.device.id}`);
    const coverage = journalExportCoverage(f.store, at);
    expect(coverage.canExportXml).toBe(true);
    for (const entry of viewerEntries) {
      expect(coverage.globalEntryIds).toContain(entry.id);
      expect(coverage.excludedOperational.map(issue => issue.entryId)).toContain(entry.id);
      expect(coverage.mappedEntryIds).not.toContain(entry.id);
    }
    const xml = exportXml(f.store, 'Ansvarig', at);
    validate(xml);
    expect(contents(xml, 'InloggadAnvandare')).not.toContain('kitchen');
    expect(json(f).entries).toEqual(f.store.journal());
  });

  it('blockerar oidentifierad ekonomisk händelse och okänd framtida händelse i stället för att kalla dem andra rapporter', () => {
    const f = fixture(); const day = f.open();
    f.service.log('system', 'cash.move', key(), { dayId: day.id, direction: 'in', amountOre: 1000, reason: 'Saknad kassa', registerId: null });
    f.service.log(f.admin, 'sale.future_adjustment', key(), { amountOre: 500 });
    const coverage = journalExportCoverage(f.store, at);
    expect(coverage.canExportXml).toBe(false);
    expect(coverage.unsupportedRegulatory.map(issue => issue.code)).toEqual(['LEGACY_JOURNAL_IDENTITY', 'XML_EVENT_UNSUPPORTED']);
    expect(() => exportXml(f.store, 'Ansvarig', at)).toThrow('saknar historisk kassaidentitet');
    expect(json(f).entries).toEqual(f.store.journal());
  });

  it('låter gammal kassaidentitet förbli historisk efter att den nya enhetsmappningen finns', () => {
    const f = fixture();
    const oldId = f.service.settings().registerId;
    const currentId = f.service.registerFor(f.admin).id;
    f.store.audit('admin@main', 'auth.login', 'admin', {}, '2026-10-13T20:05:00Z');
    const old = f.store.journal().at(-1)!;
    const original = f.store.journal();
    const all = json(f);
    expect(all.scope.entries.find(entry => entry.entryId === old.id)).toMatchObject({ kind: 'legacy', registerId: oldId, source: 'historical-settings' });
    expect(json(f, currentId).entries.map(entry => entry.id)).not.toContain(old.id);
    const xml = exportXml(f.store, 'Ansvarig', at, undefined, undefined, oldId);
    validate(xml);
    expect(contents(xml, 'BeteckningPaValtKassaregisterForExportAvDataFranJournalminnet')).toEqual([oldId]);
    expect(f.store.journal()).toEqual(original);
  });

  it('kräver historisk varu-/tjänsteklass och använder schemats faktiska TJANST-värde', async () => {
    const missing = fixture(); missing.open(); await missing.pay(readyTab(missing).id);
    const unsupported = journalExportCoverage(missing.store, at);
    expect(unsupported.canExportXml).toBe(false);
    expect(unsupported.unsupportedRegulatory.map(issue => issue.code)).toContain('XML_ARTICLE_KIND_UNKNOWN');
    expect(json(missing).entries).toEqual(missing.store.journal());
    const f = fixture(); classify(f, 10000, 'services'); f.open(); await f.pay(readyTab(f).id);
    const xml = exportXml(f.store, 'Ansvarig', at);
    validate(xml);
    expect(new Set(contents(xml, 'TypAvArtikel'))).toEqual(new Set(['TJANST']));
  });

  it.each([3, 8])('bevarar exakt 1/%i i JSON och avrundar aldrig artikelantal till XML', async denominator => {
    const priceOre = 100;
    const f = fixture(); classify(f, priceOre * denominator); f.open();
    const tab = readyTab(f);
    await f.pay(tab.id, { amountOre: priceOre });
    const coverage = journalExportCoverage(f.store, at);
    expect(coverage.canExportXml).toBe(false);
    expect(coverage.unsupportedRegulatory.map(issue => issue.code)).toContain('XML_QUANTITY_PRECISION');
    expect(() => exportXml(f.store, 'Ansvarig', at)).toThrow('två decimaler');
    const entry = json(f).entries.find(entry => entry.action === 'receipt.create')!;
    expect((entry.details as { receipt: Receipt }).receipt.payment.allocations[0].quantity).toEqual({ numerator: '1', denominator: String(denominator) });
  });

  it('återger delbetalningens exakta rabatt och artikelandel utan att dubblera referensradens antal', async () => {
    const f = fixture(); classify(f); f.open(); const tab = readyTab(f);
    f.command(tab.id, { action: 'discount', discountBps: 1000, reason: 'AW 10 procent' });
    await f.pay(tab.id, { amountOre: 4500 });
    const xml = exportXml(f.store, 'Ansvarig', at);
    validate(xml);
    const receipt = contents(xml, 'Ovningskvitto')[0];
    expect(contents(receipt, 'AntalAvSaldArtikel')).toEqual(['0.50']);
    expect(contents(receipt, 'PrisPaSaldArtikel')).toEqual(['45.00']);
    expect(contents(receipt, 'RabattensBelopp')).toEqual(['5.00']);
    expect(contents(receipt, 'TotaltRabattbeloppPaKvitto')).toEqual(['5.00']);
    expect(contents(receipt, 'Artikelnamn')).toEqual(['Vitlöksbröd']);
    expect(journalExportCoverage(f.store, at).warnings.map(issue => issue.code)).toContain('ECONOMIC_QUANTITY_SHARE');
  });

  it('behåller kopian och det oförändrade originalkvittot i JSON utan att fabricera skarpa kontrolluppgifter', async () => {
    const f = fixture(); classify(f); f.open(); await f.pay(readyTab(f).id);
    const job = f.store.all<PrintJob>('print').find(job => job.kind === 'guest')!;
    await f.service.print(f.admin, job.id, 'print', 'printed');
    await f.service.print(f.admin, job.id, 'reprint', undefined, 'Kunden bad om kopia');
    const data = json(f);
    expect(data.coverage.canExportXml).toBe(false);
    expect(data.coverage.unsupportedRegulatory.map(issue => issue.code)).toContain('XML_TRAINING_COPY_UNSUPPORTED');
    expect(() => exportXml(f.store, 'Ansvarig', at)).toThrow('Kopia av övningskvitto');
    expect(data.referencedReceipts).toHaveLength(1);
    const original = f.store.journal().find(entry => entry.action === 'receipt.create')!;
    expect(data.referencedReceipts[0]).toEqual({ entryId: original.id, receipt: (original.details as { receipt: Receipt }).receipt });
    expect(data.entries).toEqual(f.store.journal());
  });

  it('spärrar rapportaggregat om dess kassaspecifika historiska delrapporter aldrig journalfördes', () => {
    const f = fixture(); const day = f.open();
    const report = f.service.report(day.id);
    f.service.log(f.admin, 'report.x', day.id, { day, report, registerId: null });
    const coverage = journalExportCoverage(f.store, at);
    expect(coverage.canExportXml).toBe(false);
    expect(coverage.unsupportedRegulatory.map(issue => issue.code)).toContain('XML_REGISTER_REPORTS_MISSING');
    expect(json(f).entries).toEqual(f.store.journal());
  });

  it('låter inte identitetskonflikt mellan kvitto och journal få ett tyst ommärkt kassaurval', async () => {
    const f = fixture(); classify(f); f.open(); await f.pay(readyTab(f).id);
    const original = f.store.all<Receipt>('receipt')[0];
    const conflicting = { ...original, id: key(), registerId: 'ANNAN-HISTORISK-KASSA' };
    f.store.audit('admin@main', 'receipt.create', conflicting.id, { receipt: conflicting, registerId: original.registerId }, '2026-10-13T20:05:00Z');
    const coverage = journalExportCoverage(f.store, at, undefined, undefined, original.registerId);
    expect(coverage.canExportXml).toBe(false);
    expect(coverage.unsupportedRegulatory.map(issue => issue.code)).toContain('XML_IDENTITY_CONFLICT');
    expect((json(f).entries.at(-1)!.details as { receipt: Receipt }).receipt).toEqual(conflicting);
  });

  it('gissar inte artikelantal för äldre kvitto trots att beloppet motsvarar referensradens hela belopp', async () => {
    const f = fixture(); classify(f); f.open(); await f.pay(readyTab(f).id);
    const legacy = structuredClone(f.store.all<Receipt>('receipt')[0]);
    legacy.id = key();
    for (const allocation of legacy.payment.allocations) { delete allocation.quantity; delete allocation.quantityBasis; }
    f.store.audit('admin@main', 'receipt.create', legacy.id, { receipt: legacy }, '2026-10-13T20:05:00Z');
    const coverage = journalExportCoverage(f.store, at);
    expect(coverage.canExportXml).toBe(false);
    expect(coverage.unsupportedRegulatory.map(issue => issue.code)).toContain('XML_QUANTITY_UNKNOWN');
    const entry = json(f).entries.at(-1)!;
    expect((entry.details as { receipt: Receipt }).receipt).toEqual(legacy);
    expect((entry.details as { receipt: Receipt }).receipt.payment.allocations[0]).not.toHaveProperty('quantity');
  });

  it('visar för långt historiskt företagsnamn som exporthinder redan i omfattningskontrollen', () => {
    const f = fixture();
    const settings = f.service.settings();
    f.service.saveSettings(f.admin, { ...settings, company: { ...settings.company, name: 'N'.repeat(73) } });
    f.actor();
    const coverage = journalExportCoverage(f.store, at);
    expect(coverage.canExportXml).toBe(false);
    expect(coverage.unsupportedRegulatory.map(issue => issue.code)).toContain('XML_TEXT_LENGTH');
    expect(exportJournalJson(f.store, 'Ansvarig', at)).toContain('N'.repeat(73));
  });
});
