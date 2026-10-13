import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../server/app';
import { exportXml, exportJournalJson, xmlTime } from '../server/export';
import { digest } from '../server/db';
import type { AuditEntry, MenuItem } from '../shared/types';
import { fixture as baseFixture, key } from './helpers';

// Classification is an explicit operator choice; production seed data must not
// silently guess whether the restaurant supplies goods or services.
function fixture(...args: Parameters<typeof baseFixture>) {
  const f = baseFixture(...args);
  for (const id of ['bread', 'redwine']) f.service.saveMenu(f.admin, { ...f.store.get<MenuItem>('menu', id)!, itemKind: 'goods' });
  return f;
}

const at = '2026-10-13T22:00:00Z';
function validate(xml: string) {
  const result = spawnSync(process.env.PYTHON ?? 'python', [path.resolve('scripts/validate-journal-xml.py'), '-'], { input: xml, encoding: 'utf8', timeout: 15000 });
  expect(result.error, 'Install Python and scripts/requirements-test.txt for schema validation').toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}
const contents = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<k:${name}>([\\s\\S]*?)</k:${name}>`, 'g'))].map(match => match[1]);
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { for (const context of apps.splice(0)) await context.app.close(); });

describe('Journalexport mot Skatteverkets oförändrade schema', () => {
  it('validerar försäljning, retur och dagsavslut i övningsläge', async () => {
    const f = fixture(); const day = f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' });
    f.command(tab.id, { action: 'send' });
    f.service.takeReport(f.admin, day.id);
    const payment = await f.pay(tab.id);
    await f.service.refund(f.admin, payment.id, { key: key(), amountOre: payment.amountOre / 2, reason: 'Retur i test', simulation: 'approved', fiscalSimulation: 'confirmed' });
    f.service.closeDay(f.admin, day.id, { key: key(), countedCashOre: 150000 });
    const xml = exportXml(f.store, f.admin.staff.name, at);
    validate(xml);
    expect(xml).not.toContain('<k:Kassakvitto>');
    expect(xml).toContain('<k:TotalForsaljningssumma>0.00</k:TotalForsaljningssumma>');
    expect(contents(xml, 'XDagrapport')).toHaveLength(5);
    expect(contents(xml, 'ZDagrapport')).toHaveLength(5);
    expect(contents(xml, 'Ovningskvitto')).toHaveLength(2);
    expect(contents(xml, 'StangaParkering')).toHaveLength(1);
    expect(contents(xml, 'Ovningskvitto')[0]).toContain('<k:Artikelnamn>Vitlöksbröd</k:Artikelnamn>');
    expect(contents(xml, 'Ovningskvitto')[1]).toContain('<k:Artikelnamn>Vitlöksbröd</k:Artikelnamn>');
    expect(contents(xml, 'Ovningskvitto')[1]).toContain('<k:AntalAvSaldArtikel>-0.50</k:AntalAvSaldArtikel>');
  });

  it('bevarar exakta före/efter-belopp för rabatt, prisändring och radering', () => {
    const f = fixture(); f.open(); const tab = f.tab();
    f.service.saveMenu(f.admin, { ...f.store.get<MenuItem>('menu', 'bread')!, priceOre: 6900 });
    f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 2 });
    const added = f.command(tab.id, { action: 'add', itemId: 'redwine' });
    f.command(tab.id, { action: 'discount', discountBps: 1000, reason: 'AW rabatt' });
    f.command(tab.id, { action: 'price', lineId: added.lines[0].id, priceOre: 10000, reason: 'Rätta pris' });
    f.command(tab.id, { action: 'remove', lineId: added.lines[1].id });
    const xml = exportXml(f.store, 'Ansvarig', at);
    validate(xml);
    expect(contents(xml, 'ParkeraRegistreradArtikel')).toHaveLength(2);
    expect(contents(xml, 'AndraParkeradArtikel')).toHaveLength(3);
    expect(contents(xml, 'AndraParkeradArtikel')[0]).toContain('<k:TidigarePrisPaRegistreradArtikel>138.00</k:TidigarePrisPaRegistreradArtikel>');
    expect(contents(xml, 'AndraParkeradArtikel')[0]).toContain('<k:PrisPaRegistreradArtikel>124.20</k:PrisPaRegistreradArtikel>');
    expect(contents(xml, 'RaderaParkeradArtikel')[0]).toContain('<k:PrisPaRegistreradArtikel>85.50</k:PrisPaRegistreradArtikel>');
    expect(xml).toContain('<k:InloggningIKassaregister>JA</k:InloggningIKassaregister>');
    expect(xml).toContain('<k:StallaOmTillOvningslage>JA</k:StallaOmTillOvningslage>');
  });

  it('bevarar den historiska kassaidentiteten efter inställningsbyte', async () => {
    const f = fixture(); const day = f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 3 });
    f.command(tab.id, { action: 'send' }); await f.pay(tab.id);
    f.service.closeDay(f.admin, day.id, { key: key(), countedCashOre: 150000 });
    const original = f.service.settings();
    const originalRegisterId = f.service.registerFor(f.admin).id;
    f.service.saveSettings(f.admin, { ...original, company: { ...original.company, name: 'Framtida namn' }, registerId: 'FRAMTIDA-KASSA' });
    const xml = exportXml(f.store, 'Ansvarig', at);
    validate(xml);
    const receipt = contents(xml, 'Ovningskvitto')[0];
    const zReport = contents(xml, 'ZDagrapport')[0];
    for (const old of [receipt, zReport]) {
      expect(old).toContain(`<k:Kassabeteckning>${originalRegisterId}</k:Kassabeteckning>`);
      expect(old).not.toContain('Framtida namn');
    }
    expect(receipt).toContain('<k:AntalAvSaldArtikel>3</k:AntalAvSaldArtikel>');
    expect(contents(xml, 'BeteckningPaValtKassaregisterForExportAvDataFranJournalminnet')).toEqual(f.store.all<{ id: string }>('register').map(register => register.id));
    expect(contents(xml, 'BeteckningPaValtKassaregisterForExportAvDataFranJournalminnet')).not.toContain('FRAMTIDA-KASSA');
  });

  it.each([['ny personal med UUID', key()], ['personal-ID som innehåller @', 'elin@lagustosa.se']])('exporterar inloggad användare separat från enhet för %s', (_label, staffId) => {
    const f = fixture(); f.open();
    const staff = f.service.saveStaff(f.admin, { id: staffId, name: 'Ny servering', role: 'waiter', active: true, pin: '6789' });
    const device = f.service.saveDevice(f.admin, { name: 'Ny handterminal', kind: 'serving', station: null, active: true });
    const actor = f.service.login(staff.id, '6789', device.code, '127.0.0.1').actor;
    const tab = f.service.createTab(actor, { key: key(), tableId: null, guestCount: 1, serviceMode: 'dine_in' });
    f.command(tab.id, { action: 'add', itemId: 'bread' }, actor);
    // A later display-name change must not rewrite the historical user's ID.
    f.service.saveStaff(f.admin, { ...staff, name: 'Ändrat visningsnamn' });
    const originalActor = `${staff.id}@${device.id}`;
    const journalBeforeExport = f.store.journal();
    const originalEntries = journalBeforeExport.filter(entry => entry.actor === originalActor);
    expect(originalEntries.map(entry => entry.action)).toEqual(['auth.login', 'tab.create', 'tab.add']);
    const xml = exportXml(f.store, 'Ansvarig', at);
    validate(xml);
    const users = contents(xml, 'InloggadAnvandare');
    expect(users.filter(user => user === staff.id)).toHaveLength(4); // Article add includes registration + parking.
    expect(users).not.toContain(originalActor);
    expect(users).not.toContain('Ändrat visningsnamn');
    const json = JSON.parse(exportJournalJson(f.store, 'Ansvarig', at)) as { entries: AuditEntry[] };
    expect(json.entries.filter(entry => entry.actor === originalActor)).toEqual(originalEntries);
    expect(f.store.journal()).toEqual(journalBeforeExport);
  });

  it('skiljer insättning och uttag i schemats kassaförändringar', () => {
    const f = fixture(); const day = f.open();
    f.service.log(f.admin, 'cash.move', key(), { dayId: day.id, direction: 'in', amountOre: 12345, reason: 'Mer växel' });
    f.service.log(f.admin, 'cash.move', key(), { dayId: day.id, direction: 'out', amountOre: 2300, reason: 'Till bank' });
    const xml = exportXml(f.store, 'Ansvarig', at);
    validate(xml);
    expect(contents(xml, 'ForandringAvVaxelkassaISvenskaKronor')).toEqual(['1500.00', '123.45', '-23.00']);
    expect(xml).not.toContain('<k:Kassakvitto>');
  });

  it('stoppar äldre okänd identitet och text som annars skulle kortas eller ändras', () => {
    const legacy = fixture();
    legacy.service.log(legacy.admin, 'settings.save', 'settings', { settings: legacy.service.settings() });
    expect(() => exportXml(legacy.store, 'Ansvarig', at)).toThrow('saknar historisk');
    expect(JSON.parse(exportJournalJson(legacy.store, 'Ansvarig', at)).entries.length).toBeGreaterThan(0);
    const f = fixture(); f.open();
    const menu = f.store.get<MenuItem>('menu', 'bread')!;
    f.service.saveMenu(f.admin, { ...menu, name: 'A'.repeat(73) });
    f.command(f.tab().id, { action: 'add', itemId: 'bread' });
    expect(() => exportXml(f.store, 'Ansvarig', at)).toThrow('överstiger XML-schemats gräns');
    expect(exportJournalJson(f.store, 'Ansvarig', at)).toContain('A'.repeat(73));
    const bad = fixture();
    expect(() => exportXml(bad.store, 'Test\u0000user', at)).toThrow('tecken som XML inte kan återge');
  });

  it('exporterar fullständiga data med kontrollerbara hashvärden utan autentiseringsuppgifter', async () => {
    const f = fixture(); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread', notes: 'Extra vitlök' });
    f.command(tab.id, { action: 'send' }); const payment = await f.pay(tab.id);
    await f.service.refund(f.admin, payment.id, { key: key(), amountOre: 1000, reason: 'Retur utan ändring av original', simulation: 'approved', fiscalSimulation: 'confirmed' });
    f.service.saveStaff(f.admin, { ...f.admin.staff, pin: '9876' });
    f.service.saveDevice(f.admin, { name: 'Extra skärm', kind: 'display', station: 'kitchen', active: true });
    const json = exportJournalJson(f.store, 'Ansvarig', at);
    const data = JSON.parse(json) as { entries: AuditEntry[]; integrity: { lastHash: string; contiguous: boolean; externallyAttested: boolean } };
    expect(data.entries).toEqual(f.store.journal());
    for (const entry of data.entries) expect(entry.hash).toBe(digest(JSON.stringify([entry.at, entry.actor, entry.action, entry.entityId, JSON.stringify(entry.details), entry.previousHash])));
    expect(data.integrity).toMatchObject({ lastHash: data.entries.at(-1)!.hash, contiguous: true, externallyAttested: false });
    expect(json).toContain('originalReceiptId'); expect(json).toContain('Extra vitlök');
    // Check credential fields and the exact PIN value, not a digit sequence
    // that can legitimately occur inside a random UUID or SHA-256 hash.
    expect(json).not.toMatch(/"(?:pinHash|codeHash|pin)"\s*:|:\s*"9876"/);
    f.service.log('system', 'bad.future.event', 'test', { nested: { pinHash: 'should-never-export' } });
    expect(() => exportJournalJson(f.store, 'Ansvarig', at)).toThrow('autentiseringsuppgifter');
  });

  it('validerar kalenderdatum, svensk tidsgräns och sommar-/vintertid', () => {
    const f = fixture({ now: () => new Date('2026-10-13T22:10:00Z') });
    expect(() => exportXml(f.store, 'Ansvarig', '2026-10-14T00:00:00Z', '2026-02-30')).toThrow('kalenderdatum');
    expect(() => exportJournalJson(f.store, 'Ansvarig', at, '2026-10-14', '2026-10-13')).toThrow('Startdatum');
    expect(() => exportJournalJson(f.store, 'Ansvarig', '2026-10-14T00:00:00Z', '2026-10-13', '2026-10-13')).toThrow('inga journalhändelser');
    const data = JSON.parse(exportJournalJson(f.store, 'Ansvarig', '2026-10-14T00:00:00Z', '2026-10-14', '2026-10-14'));
    expect(data.entries.length).toBeGreaterThan(0);
    expect(xmlTime('2026-10-24T22:10:00Z')).toBe('2026-10-25T00:10:00');
    expect(xmlTime('2026-10-25T22:10:00Z')).toBe('2026-10-25T23:10:00');
    expect(() => exportJournalJson(f.store, 'Ansvarig', at)).toThrow('efter exporttidpunkten');
  });

  it('kräver administratör för fullständigt JSON-underlag och avvisar ogiltiga exportdatum', async () => {
    const f = await createApp({ database: ':memory:', now: () => new Date(at) }); apps.push(f);
    expect((await f.app.inject('/api/v1/journal.json')).statusCode).toBe(401);
    for (const [staffId, pin, expected] of [['cashier', '2345', 403], ['admin', '1234', 200]] as const) {
      const login = await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { staffId, pin, deviceCode: 'LAGUSTOSA-TEST' } });
      const headers = { cookie: `lagustosa_session=${login.cookies[0].value}` };
      const response = await f.app.inject({ url: '/api/v1/journal.json', headers });
      expect(response.statusCode).toBe(expected);
      if (expected === 200) {
        expect(response.headers['content-disposition']).toContain('lagustosa-journal-test.json');
        expect(response.json().training).toBe(true);
        expect((await f.app.inject({ url: '/api/v1/journal.xml?from=2026-02-30', headers })).statusCode).toBe(400);
        expect((await f.app.inject({ url: '/api/v1/journal.json?to=2026-11-31', headers })).statusCode).toBe(400);
      }
    }
  });

  it('valideraren använder de fyra oförändrade myndighetsfilerna och avvisar felaktig struktur', () => {
    // SHA-256 compared with the official ZIP downloaded 2026-10-13 from:
    // https://www.skatteverket.se/download/18.5dc1d8b31903014b1bf11b9/1719999713439/xml-schema-kassaregister.zip
    const files = [
      ['instans/utredningsstod/2021-12-08/ExportAvDataFranJournalminneEnligtSKVFS202116-2021-12-08.xsd', '0914013a16a08fb660ac67a81a5ac1cde02ca7ebcd97376d1d44690a5a46e846'],
      ['komponent/utredningsstod/2021-12-08/Utredningsstod-ElementAvEnkelTyp-2021-12-08-COMPONENT.xsd', '51bce82480786310765770599298c3f2d782146f67f472583603de920cdcb5f7'],
      ['komponent/utredningsstod/2021-12-08/Utredningsstod-ElementAvSammansattTyp-2021-12-08-COMPONENT.xsd', '61716203e03d4f14ea422fecfc6c6199e7abb84645899cc54d25dbc3d147d4d6'],
      ['komponent/utredningsstod/2021-12-08/Utredningsstod-GenerellaTypdefinitioner-2021-12-08-TYPELIB.xsd', '89e3977dce1b8c7c585e704416c89c5a49d4b80f2271d3c3a4f029e549199c8d'],
    ];
    for (const [file, expected] of files) {
      const bytes = readFileSync(path.join('vendor/skatteverket/xmls', file));
      // Compare official contents normalized to LF: the upstream ZIP itself has
      // mixed file line endings, and Git may convert them in Windows checkouts.
      const normalizedLineEndings = bytes.toString('utf8').replace(/\r\n/g, '\n');
      expect(createHash('sha256').update(normalizedLineEndings).digest('hex')).toBe(expected);
    }
    const f = fixture();
    const xml = exportXml(f.store, 'Ansvarig', at).replace('<k:StartAvKassaregister>JA</k:StartAvKassaregister>', '<k:InvalidEvent>JA</k:InvalidEvent>');
    const result = spawnSync(process.env.PYTHON ?? 'python', [path.resolve('scripts/validate-journal-xml.py'), '-'], { input: xml, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('InvalidEvent');
  });
});
