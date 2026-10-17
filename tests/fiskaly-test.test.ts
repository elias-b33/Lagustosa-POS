import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';
import { FiskalyTestClient } from '../server/fiskaly-test/client';
import { FiskalyTestOutbox } from '../server/fiskaly-test/outbox';
import { parseFiskalyTestConfig, readFiskalyTestConfig } from '../server/fiskaly-test/config';
import { closingPayload, duplicateIntentionPayload, openingPayload, receiptOperation, transactionIntentionPayload, transactionPayload } from '../server/fiskaly-test/payload';
import type { Receipt } from '../shared/types';
import { assertTrainingMode } from '../server/app';
import { fixture, key } from './helpers';
import contract from './fixtures/fiskaly-sign-se-request-schema.json';

const ajv = new Ajv({ strict: false, validateFormats: false, logger: false });
ajv.addSchema({ $id: 'fiskaly-published-request-contract', components: contract.components });
const recordContract = ajv.compile({ $ref: 'fiskaly-published-request-contract#/components/schemas/RecordCreateRequest' });
const tokenContract = ajv.compile({ $ref: 'fiskaly-published-request-contract#/components/schemas/TokenCreateRequest' });
const providerId = () => { const id = randomUUID(); return id.slice(0, 14) + '7' + id.slice(15); }; // test-only UUIDv7-shaped response IDs
const config = () => parseFiskalyTestConfig({ apiKey: 'TEST-key-do-not-export', apiSecret: 'TEST-secret-do-not-export', unitId: providerId(), bindings: [{ registerId: 'main', systemId: providerId() }, { registerId: 'handheld', systemId: providerId() }] });
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function remote() {
  const records = new Map<string, any>();
  const requests: { route: string; headers: Record<string, string>; payload: any }[] = [];
  const request = vi.fn(async (url: any, options: any) => {
    expect(new URL(url).origin).toBe('https://test.api.fiskaly.com'); expect(options.redirect).toBe('error');
    const route = new URL(url).pathname, payload = options.body ? JSON.parse(options.body) : null;
    requests.push({ route, headers: options.headers, payload });
    expect(options.headers['X-Api-Version']).toBe('2026-06-01');
    if (route === '/tokens') {
      expect(tokenContract(payload), JSON.stringify(tokenContract.errors)).toBe(true);
      return jsonResponse({ content: { authentication: { type: 'JWT', bearer: 'test-bearer', expires_at: new Date(Date.now() + 3600_000).toISOString() } } });
    }
    if (route === '/records') {
      expect(recordContract(payload), JSON.stringify(recordContract.errors)).toBe(true);
      const key = options.headers['X-Idempotency-Key'];
      if (!records.has(key)) {
        const parent = [...records.values()].find(item => item.content.id === payload.content.record?.id);
        records.set(key, { content: { id: providerId(), type: payload.content.type, system: payload.content.system ?? parent.content.system, state: 'COMPLETED', mode: 'FINISHED' } });
      }
      return jsonResponse(records.get(key));
    }
    if (route.startsWith('/records/')) return jsonResponse([...records.values()].find(item => item.content.id === route.split('/')[2]));
    return jsonResponse({ code: 'MISSING' }, 404);
  }) as unknown as typeof fetch;
  return { request, requests, records };
}
async function testReceipt() {
  const f = fixture();
  f.service.saveMenu(f.admin, { ...f.service.menu().find(item => item.id === 'bread')!, priceOre: 11200, itemKind: 'services', takeawayItemKind: 'goods' }); f.open();
  const tab = f.tab(null); f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 2 }); f.command(tab.id, { action: 'send' }); await f.pay(tab.id);
  return { f, receipt: f.store.all<Receipt>('receipt')[0] };
}

describe('Fiskaly TEST-only preparation', () => {
  it('låser adress, kassaseparation, nyckelskydd och produktionsspärr', () => {
    const value = config();
    expect(() => parseFiskalyTestConfig({ ...value, bindings: [{ ...value.bindings[0] }, { ...value.bindings[0], registerId: 'other' }] })).toThrow('unika');
    expect(() => readFiskalyTestConfig({ FISKALY_BASE_URL: 'https://live.api.fiskaly.com' })).toThrow('TEST');
    expect(() => readFiskalyTestConfig({ FISKALY_TEST_API_SECRET: 'do-not-echo-me' })).toThrow();
    try { readFiskalyTestConfig({ FISKALY_TEST_API_SECRET: 'do-not-echo-me' }); } catch (error) { expect(String(error)).not.toContain('do-not-echo-me'); }
    expect(() => assertTrainingMode({ APP_MODE: 'production' })).toThrow();
    expect(() => assertTrainingMode({ FISCAL_ADAPTER: 'fiskaly-test' })).toThrow();
  });
  it('validerar publicerade anropsformat för start, slut, köp, retur och kopia utan avrundade antal', async () => {
    const { f, receipt } = await testReceipt(); const systemId = providerId(); const intentionId = providerId();
    const operation = receiptOperation(receipt);
    expect(operation.totals.vat).toEqual({ amount: '24.00', exclusive: '200.00', inclusive: '224.00' });
    expect(operation.entries[0].data.unit.quantity).toBe('2');
    expect(operation.entries[0].details.concept).toBe('SERVICE');
    expect(operation.payments[0]).toMatchObject({ type: 'OTHER', name: 'ELEVA TEST CARD' });
    const refund = await f.service.refund(f.admin, receipt.paymentId, { key: key(), items: [{ lineId: receipt.payment.allocations[0].lineId, quantity: 1 }], reason: 'Testretur', simulation: 'approved', fiscalSimulation: 'confirmed' });
    const returned = f.store.all<Receipt>('receipt').find(item => item.paymentId === refund.id)!;
    const returnOperation = receiptOperation(returned, receipt);
    expect(returnOperation.entries[0].type).toBe('RETURN');
    expect(returnOperation.document.references?.preceding_document.number).toBe(String(receipt.number));
    const bodies = [openingPayload(systemId), closingPayload(systemId), transactionIntentionPayload(systemId), duplicateIntentionPayload(systemId, providerId(), 'Begärd testkopia'), transactionPayload(intentionId, operation), transactionPayload(intentionId, returnOperation)];
    for (const body of bodies) expect(recordContract(body), JSON.stringify(recordContract.errors)).toBe(true);
    expect(() => receiptOperation({ ...receipt, payment: { ...receipt.payment, tipOre: 100 } })).toThrow('Dricks');
    expect(() => receiptOperation({ ...receipt, payment: { ...receipt.payment, allocations: [{ ...receipt.payment.allocations[0], quantity: { numerator: '1', denominator: '3' } }] } })).toThrow('åtta decimaler');
    expect(() => receiptOperation(returned)).toThrow('original');
    expect(() => receiptOperation({ ...receipt, kind: 'refund' })).toThrow('transaktionstyp');
    expect(() => receiptOperation(receipt, receipt)).toThrow('returreferens');
  });
  it('behåller exakt delbetalningsbelopp och klassning från historiska betalningsandelar', async () => {
    const { receipt } = await testReceipt();
    const partial = structuredClone(receipt);
    partial.payment.amountOre = 6900;
    partial.payment.allocations = [{ ...partial.payment.allocations[0], grossOre: 6900, vatOre: 739, quantity: { numerator: '1', denominator: '1' } }];
    expect(receiptOperation(partial).totals.vat).toEqual({ amount: '7.39', exclusive: '61.61', inclusive: '69.00' });
    partial.tab.lines[0].itemKind = undefined;
    expect(() => receiptOperation(partial)).toThrow('varu-/tjänsteklass');
  });
  it('återhämtar förlorat svar efter omstart med samma nyckel och blockerar för gamla försök', async () => {
    const f = fixture(), c = config(), r = remote(); const filename = path.join(f.directory, 'fiskaly-test.sqlite');
    let clock = Date.now(), drop = true;
    const transport: typeof fetch = async (url, init) => {
      const response = await r.request(url, init);
      if (String(url).endsWith('/records') && drop) { drop = false; throw new Error('Lost after receiver saved it'); }
      return response;
    };
    let box = new FiskalyTestOutbox(filename, new FiskalyTestClient(c, transport), () => clock);
    const job = box.intention('same-order', 'main');
    await expect(box.send(job.id)).rejects.toThrow('TRANSPORT');
    expect(box.get(job.id).status).toBe('unknown'); box.close();
    box = new FiskalyTestOutbox(filename, new FiskalyTestClient(c, transport), () => clock);
    try {
      const [a, b] = await Promise.all([box.send(job.id), box.send(job.id)]);
      expect(a.recordId).toBe(b.recordId); expect(a.status).toBe('received-unverified'); expect(r.records.size).toBe(1);
      const posts = r.requests.filter(item => item.route === '/records'); expect(posts).toHaveLength(2);
      expect(posts.map(item => item.headers['X-Idempotency-Key'])).toEqual([job.key, job.key]);
      expect(posts[0].payload).toEqual(posts[1].payload);
      await box.lookup(job.id); expect(r.records.size).toBe(1);
      drop = true; const old = box.opening('old-start', 'handheld'); await expect(box.send(old.id)).rejects.toThrow();
      const before = r.requests.length; clock += 24 * 3600_000;
      await expect(box.send(old.id)).rejects.toThrow('avstämning'); expect(r.requests).toHaveLength(before);
      expect(box.get(old.id).key).toBe(old.key);
      expect(() => box.intention(job.id, 'handheld')).toThrow('annan transaktion');
    } finally { box.close(); }
    expect(readFileSync(filename).includes(Buffer.from(c.apiSecret))).toBe(false);
  });
  it('skiljer två kassor och förbereder ett tvåstegsflöde även för en enda kvittokopia', async () => {
    const { f, receipt } = await testReceipt(); const c = config(), r = remote();
    c.bindings[0].registerId = receipt.registerId;
    const box = new FiskalyTestOutbox(path.join(f.directory, 'fiskaly-test.sqlite'), new FiskalyTestClient(c, r.request));
    try {
      const opening = box.opening('open-main', receipt.registerId), other = box.opening('open-other', 'handheld');
      await Promise.all([box.send(opening.id), box.send(other.id)]);
      expect(box.get(opening.id).systemId).not.toBe(box.get(other.id).systemId);
      const intent = box.intention('sale-intent', receipt.registerId); await box.send(intent.id);
      const job = box.receipt('sale', receipt, intent.id); await box.send(job.id);
      const copy = box.duplicate('copy:sale', receipt.registerId, job.id, 'Kopia i test'); await box.send(copy.id);
      const completed = box.receipt('completion:copy:sale', receipt, copy.id); await box.send(completed.id);
      expect(JSON.parse(completed.payload).content.operation).toEqual(JSON.parse(job.payload).content.operation);
      expect(() => box.duplicate('copy-again', receipt.registerId, job.id, 'Kopia igen')).toThrow('fasta');
      expect(() => box.duplicate('copy:sale', 'handheld', job.id, 'Fel kassa')).toThrow('samma kassa');
    } finally { box.close(); }
  });
  it('vägrar kassadatabas och förändrade organisations-/systemkopplingar', () => {
    const f = fixture({}, true), c = config();
    const before = f.store.journal();
    expect(() => new FiskalyTestOutbox(f.filename, new FiskalyTestClient(c))).toThrow('egen databas');
    expect(f.store.journal()).toEqual(before);
    const filename = path.join(f.directory, 'fiskaly-test.sqlite');
    new FiskalyTestOutbox(filename, new FiskalyTestClient(c)).close();
    expect(() => new FiskalyTestOutbox(filename, new FiskalyTestClient({ ...c, unitId: providerId() }))).toThrow('ändrats');
  });
  it('accepterar inte autentiseringsfel eller felaktigt svar som registrering', async () => {
    const f = fixture(), c = config();
    const request = vi.fn(async (url: any) => String(url).endsWith('/tokens') ? jsonResponse({ secret: c.apiSecret }, 401) : jsonResponse({})) as unknown as typeof fetch;
    const box = new FiskalyTestOutbox(path.join(f.directory, 'fiskaly-test.sqlite'), new FiskalyTestClient(c, request));
    try {
      const job = box.intention('failure', 'main');
      await expect(box.send(job.id)).rejects.toThrow('AUTH');
      expect(box.get(job.id).status).toBe('unknown'); expect(box.get(job.id).recordId).toBeNull();
      expect(JSON.stringify(box.get(job.id))).not.toContain(c.apiSecret);
    } finally { box.close(); }
    const wrong = new FiskalyTestClient(c, async () => new Response('<html>secret</html>', { headers: { 'content-type': 'text/html' } }));
    await expect(wrong.getSystem(c.bindings[0].systemId)).rejects.toThrow('RESPONSE');
    expect(() => wrong.getSystem('https://example.org/')).toThrow();
  });
  it('förnyar utgången autentisering en gång med samma affärsreferens och följer inte omdirigering', async () => {
    const c = config(), r = remote(); let expired = true;
    const transport: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/records') && expired) { expired = false; return jsonResponse({ secret: 'do-not-log' }, 401); }
      return r.request(url, init);
    };
    const client = new FiskalyTestClient(c, transport), operationKey = randomUUID();
    await client.createRecord(openingPayload(c.bindings[0].systemId), operationKey);
    expect(r.requests.filter(item => item.route === '/tokens')).toHaveLength(2);
    expect(r.requests.find(item => item.route === '/records')!.headers['X-Idempotency-Key']).toBe(operationKey);
    const redirect = new FiskalyTestClient(c, async (_url, init) => {
      expect(init?.redirect).toBe('error'); return new Response(null, { status: 302, headers: { location: 'https://example.org' } });
    });
    await expect(redirect.getSystem(c.bindings[0].systemId)).rejects.toThrow('HTTP (302)');
  });
  it('bevarar okänd status vid fel kassa och återskapar aldrig en känd referens efter 404', async () => {
    const f = fixture(), c = config(), r = remote(); let wrongSystem = true, missing = false;
    const transport: typeof fetch = async (url, init) => {
      if (missing && String(url).includes('/records/')) return jsonResponse({}, 404);
      const response = await r.request(url, init);
      if (wrongSystem && String(url).endsWith('/records')) {
        const value = await response.json(); value.content.system.id = c.bindings[1].systemId; return jsonResponse(value);
      }
      return response;
    };
    const box = new FiskalyTestOutbox(path.join(f.directory, 'fiskaly-test.sqlite'), new FiskalyTestClient(c, transport));
    try {
      const job = box.intention('uncertain', 'main'); await expect(box.send(job.id)).rejects.toThrow('RESPONSE');
      expect(box.get(job.id)).toMatchObject({ status: 'unknown', recordId: null });
      wrongSystem = false; await box.send(job.id); const saved = box.get(job.id);
      missing = true; await expect(box.lookup(job.id)).rejects.toThrow('HTTP (404)');
      const count = r.records.size; await box.send(job.id);
      expect(box.get(job.id).recordId).toBe(saved.recordId); expect(r.records.size).toBe(count);
    } finally { box.close(); }
  });
});
