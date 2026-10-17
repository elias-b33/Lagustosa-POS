import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { PrintJob, Receipt } from '../shared/types';
import { exportTrainingJournalXml } from '../server/training-journal-xml';
import { exportJournalJson, exportXml, journalExportCoverage } from '../server/export';
import { createApp } from '../server/app';
import { fixture, key } from './helpers';

function parse(xml: string) {
  return JSON.parse(execFileSync(process.env.PYTHON ?? 'python', ['-c', `
import json,sys
from lxml import etree
r=etree.fromstring(sys.stdin.buffer.read(),etree.XMLParser(resolve_entities=False,no_network=True))
ns={'e':'urn:eleva:training-journal:1'}
def fields(e):
 return {etree.QName(n).localname:json.loads(n.text) if n.get('encoding')=='json' else n.text for n in e}
print(json.dumps({'attributes':dict(r.attrib),'copies':[fields(c) for c in r.findall('e:ReceiptCopies/e:ReceiptCopy',ns)],'entries':[dict(id=int(c.get('id')),**fields(c)) for c in r.findall('e:Entries/e:Entry',ns)],'references':json.loads(r.find('e:ReferencedReceipts',ns).text)}))
`], { input: xml, encoding: 'utf8' }));
}
async function receipt(f: ReturnType<typeof fixture>) {
  f.open(); const tab = f.tab(null);
  f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' }); await f.pay(tab.id);
  return f.store.all<PrintJob>('print').find(job => job.kind === 'guest')!;
}
describe('Fullständigt XML-underlag för övningskopior', () => {
  it('återger kopia, belopp och original utan ny försäljning, fabricerade kontrollkoder eller historikändring', async () => {
    const f = fixture(); const job = await receipt(f);
    await f.service.print(f.admin, job.id, 'print', 'printed');
    const copy = await f.service.print(f.admin, job.id, 'reprint', undefined, 'Kunden: <kopia> & "tack"');
    const original = f.store.all<Receipt>('receipt')[0];
    const before = f.store.db.prepare('SELECT * FROM entities ORDER BY rowid').all(); const journal = f.store.journal();
    const result = parse(exportTrainingJournalXml(f.store, 'Ansvarig', '2026-10-13T22:00:00Z'));
    expect(result.attributes).toMatchObject({ training: 'true', skatteverketStandard: 'false', version: '1' });
    expect(result.copies).toHaveLength(1);
    expect(result.copies[0]).toMatchObject({ CopyPrintJobId: copy.id, OriginalReceiptId: original.id, OriginalRegisterId: original.registerId, OriginalReceiptNumber: '1', AmountOre: String(original.payment.amountOre), Reason: 'Kunden: <kopia> & "tack"', OriginalKind: 'sale' });
    expect(result.entries.map((entry: any) => ({ id: entry.id, details: entry.Details, hash: entry.Hash, previousHash: entry.PreviousHash }))).toEqual(journal.map(entry => ({ id: entry.id, details: entry.details, hash: entry.hash, previousHash: entry.previousHash })));
    expect(f.store.journal()).toEqual(journal); expect(f.store.db.prepare('SELECT * FROM entities ORDER BY rowid').all()).toEqual(before);
    expect(f.store.all('receipt')).toHaveLength(1);
    expect(() => exportXml(f.store, 'Ansvarig', '2026-10-13T22:00:00Z')).toThrow(); // no false claim of standard compatibility
  });
  it('tar med original från annan dag och kassa, även för äldre kopiehändelse med enbart sourceId', async () => {
    let now = new Date('2026-10-13T20:00:00Z');
    const f = fixture({ now: () => now }); const job = await receipt(f);
    const original = f.store.all<Receipt>('receipt')[0];
    now = new Date('2026-10-14T20:00:00Z');
    const issuer = f.actor('admin', 'SERVERING-1'), registerId = f.service.registerFor(issuer).id;
    f.service.log(issuer, 'print.reprint', key(), { kind: 'guest', sourceId: original.id, originalId: job.id, amountOre: original.payment.amountOre, reason: 'Historisk testkopia' });
    const result = parse(exportTrainingJournalXml(f.store, 'Ansvarig', now.toISOString(), '2026-10-14', '2026-10-14', registerId));
    expect(result.copies[0]).toMatchObject({ IssuingRegisterId: registerId, OriginalRegisterId: original.registerId, OriginalReceiptId: original.id });
    expect(result.references[0].receipt.id).toBe(original.id);
    expect(result.entries.some((entry: any) => entry.Action === 'receipt.create')).toBe(false);
  });
  it('markerar saknat original och skyddar hemligheter samt ogiltiga XML-tecken', async () => {
    const f = fixture(); await receipt(f);
    f.service.log(f.admin, 'print.reprint', key(), { kind: 'guest', receiptId: 'missing', reason: 'Saknat original' });
    const xml = exportTrainingJournalXml(f.store, 'Ansvarig', '2026-10-13T22:00:00Z');
    expect(xml).toContain('originalAvailable="false"');
    f.service.log(f.admin, 'print.reprint', key(), { kind: 'guest', reason: '\u0001' });
    expect(() => exportTrainingJournalXml(f.store, 'Ansvarig', '2026-10-13T22:00:00Z')).toThrow('XML inte kan återge');
    f.service.log(f.admin, 'test.secret', key(), { secret: 'never-export' });
    expect(() => exportTrainingJournalXml(f.store, 'Ansvarig', '2026-10-13T22:00:00Z')).toThrow('autentiseringsuppgifter');
  });
});

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { for (const f of apps.splice(0)) await f.app.close(); });
it('skyddar API-exporten och journalför rätt exportör utan att blockera senare standardexport', async () => {
  const f = await createApp({ database: ':memory:' }); apps.push(f);
  const endpoint = '/api/v1/journal-training.xml';
  expect((await f.app.inject(endpoint)).statusCode).toBe(401);
  for (const [staffId, pin, expected] of [['cashier', '2345', 403], ['admin', '1234', 200]] as const) {
    const login = await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { staffId, pin, deviceCode: 'LAGUSTOSA-TEST' } });
    const response = await f.app.inject({ url: endpoint, headers: { cookie: `lagustosa_session=${login.cookies[0].value}` } });
    expect(response.statusCode).toBe(expected);
    if (expected === 200) { parse(response.body); expect(response.headers['content-disposition']).toContain('eleva-training-journal.xml'); }
  }
  expect(f.store.journal().at(-1)?.action).toBe('journal.export_training_xml');
  expect(journalExportCoverage(f.store, f.service.timestamp()).unsupportedRegulatory).toEqual([]);
  expect(JSON.parse(exportJournalJson(f.store, 'Ansvarig', f.service.timestamp())).entries).toEqual(f.store.journal());
});
