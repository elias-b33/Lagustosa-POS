import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/db';
import { KassaService } from '../server/service';
import { SoftpaySandboxAdapter, type SoftpayAttempt } from '../server/softpay-adapter';
import { SoftpaySandboxClient, SOFTPAY_SANDBOX_API, SOFTPAY_SANDBOX_TOKEN, type SoftpayTransport } from '../server/softpay-client';
import type { Payment, Receipt, Actor } from '../shared/types';
import { SoftpayContractHarness, softpayTestConfig } from './fixtures/softpay-cloud';
import { key } from './helpers';

const stores: Store[] = [], directories: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) if (store.db.open) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(persistent = false, transport?: SoftpayTransport) {
  const directory = mkdtempSync(path.join(tmpdir(), 'eleva-softpay-')); directories.push(directory);
  const store = new Store(persistent ? path.join(directory, 'sandbox.sqlite') : ':memory:'); stores.push(store);
  const cloud = new SoftpayContractHarness();
  const client = new SoftpaySandboxClient(softpayTestConfig, transport ?? cloud.fetch);
  const adapter = new SoftpaySandboxAdapter(store, softpayTestConfig, client);
  const service = new KassaService(store, { payment: adapter });
  const actor = (code = 'LAGUSTOSA-TEST') => service.login('admin', '1234', code, '127.0.0.1').actor;
  const admin = actor(); service.openDay(admin, { key: key(), floatOre: 0 });
  function tab(who: Actor = admin) {
    let tab = service.createTab(who, { key: key(), tableId: null, guestCount: 1, serviceMode: 'dine_in' });
    for (const command of [{ action: 'add' as const, itemId: 'bread', quantity: 2 }, { action: 'send' as const }]) tab = service.updateTab(who, tab.id, { key: key(), version: tab.version, ...command });
    return tab;
  }
  const pay = (tabId: string, who = admin, changes = {}) => service.startPayment(who, tabId, { key: key(), version: service.tab(tabId).version, method: 'card', tipOre: 0, simulation: 'approved', fiscalSimulation: 'confirmed', ...changes });
  const requestId = (payment: Payment) => adapter.terminalInfo(payment.id)!.requestId!;
  return { store, cloud, client, adapter, service, admin, actor, tab, pay, requestId };
}

describe('Softpay sandbox: beständiga transaktioner', () => {
  it('skickar rätt belopp/enhet och väntar på ett verifierat GET-resultat innan kvittot skapas', async () => {
    const f = fixture(); f.cloud.startReplyState = 'COMPLETED';
    const tab = f.tab(); const payment = await f.pay(tab.id);
    expect(payment.status).toBe('pending');
    expect(f.store.all('receipt')).toHaveLength(0);
    expect(f.cloud.starts()[0].body).toMatchObject({ appId: 'TST0000000000', amount: payment.amountOre, currencyCode: 'SEK', posReferenceNumber: payment.id.replaceAll('-', ''), options: { tipping: { indicator: 'OFF' }, surcharge: false, dcc: false, suppressAppNotification: false } });
    f.cloud.complete(f.requestId(payment));
    await Promise.all(Array.from({ length: 8 }, () => f.service.checkPayment(f.admin, payment.id)));
    expect(f.store.all<Receipt>('receipt')).toHaveLength(1);
    expect(f.service.tab(tab.id).status).toBe('paid');
    expect(f.cloud.starts()).toHaveLength(1);
    expect(f.store.verifyJournal()).toBe(true);
    expect(f.cloud.calls.every(call => call.redirect === 'error')).toBe(true);
    const stored = JSON.stringify({ journal: f.store.journal(), attempts: f.store.all('softpay-attempt'), bootstrap: f.service.bootstrap(f.admin) });
    for (const secret of ['contract-test-secret', 'contract-access-token', 'partialPan', 'loyaltyToken']) expect(stored).not.toContain(secret);
  });

  it.each([
    ['amountValue', 1], ['currencyCode', 'EUR'], ['appId', 'TST9999999999'], ['storeId', 999],
    ['type', 'REFUND'], ['posReferenceNumber', 'wrong'], ['amountTips', 100], ['amountSurcharge', 100],
    ['responseCode', 'DECLINED'], ['transactionId', null], ['amountValue', null], ['requestId', key()],
  ])('godkänner inte ett svar med fel eller saknat %s', async (field, value) => {
    const f = fixture(); const payment = await f.pay(f.tab().id);
    f.cloud.complete(f.requestId(payment), { [field]: value });
    expect((await f.service.checkPayment(f.admin, payment.id)).status).toBe('unknown');
    expect(f.store.all('receipt')).toHaveLength(0);
    await expect(f.pay(f.tab().id)).rejects.toMatchObject({ code: 'TERMINAL_BUSY' });
  });

  it('återhämtar förlorat PUT-svar efter serveromstart utan nytt köp eller bytt terminal', async () => {
    const f = fixture(true); f.cloud.loseStartReply = true;
    const tab = f.tab(); const payment = await f.pay(tab.id);
    expect(payment.status).toBe('unknown');
    const original = f.store.get<SoftpayAttempt>('softpay-attempt', payment.id)!;
    f.cloud.complete(original.requestId!);
    f.store.close();
    const reopened = new Store(f.store.filename); stores.push(reopened);
    const config = { ...softpayTestConfig, terminals: [{ deviceId: 'main', appId: 'NEW0000000000', storeId: 99 }] };
    const adapter = new SoftpaySandboxAdapter(reopened, config, new SoftpaySandboxClient(config, f.cloud.fetch));
    const service = new KassaService(reopened, { payment: adapter });
    const recoveryActor = service.login('admin', '1234', 'SERVERING-1', '127.0.0.1').actor;
    const checked = await service.checkPayment(recoveryActor, payment.id);
    expect(checked.status).toBe('approved');
    expect(reopened.all<Receipt>('receipt')[0]).toMatchObject({ registerId: payment.registerId, payment: { deviceId: 'main' } });
    expect(adapter.terminalInfo(payment.id)?.appId).toBe(original.appId);
    expect(f.cloud.starts()).toHaveLength(1);
  });

  it('avbryter före blipp och behåller reserveringen när avbrottet inte är bekräftat', async () => {
    const f = fixture(); const tab = f.tab(); const payment = await f.pay(tab.id);
    f.cloud.abortCompletes = false;
    expect((await f.service.checkPayment(f.admin, payment.id, true)).status).toBe('pending');
    await expect(f.pay(f.tab().id)).rejects.toMatchObject({ code: 'TERMINAL_BUSY' });
    f.cloud.abortCompletes = true;
    expect((await f.service.checkPayment(f.admin, payment.id, true)).status).toBe('cancelled');
    expect(f.cloud.calls.some(call => call.url.endsWith('/cancel'))).toBe(false);
    expect((await f.pay(tab.id)).status).toBe('pending');
  });

  it('bevarar ett sent godkännande när kassören försöker avbryta', async () => {
    const f = fixture(); const payment = await f.pay(f.tab().id);
    f.cloud.complete(f.requestId(payment));
    expect((await f.service.checkPayment(f.admin, payment.id, true)).status).toBe('approved');
    expect(f.cloud.calls.some(call => call.url.endsWith('/abort') || call.url.endsWith('/cancel'))).toBe(false);
    expect(f.store.all('receipt')).toHaveLength(1);
  });

  it('skapar ingen ny transaktion på återförsök och låser en upptagen terminal men tillåter fyra andra', async () => {
    const f = fixture(); const tab = f.tab(); const input = { key: key() };
    const [first, replay] = await Promise.all([f.pay(tab.id, f.admin, input), f.pay(tab.id, f.admin, input)]);
    expect(first.id).toBe(replay.id);
    const actors = [1, 2, 3, 4].map(index => f.actor(`SERVERING-${index}`));
    const payments = await Promise.all(actors.map(actor => f.pay(f.tab(actor).id, actor)));
    expect(new Set(payments.map(payment => f.adapter.terminalInfo(payment.id)?.appId)).size).toBe(4);
    expect(f.cloud.calls.filter(call => call.url === SOFTPAY_SANDBOX_TOKEN)).toHaveLength(1);
    expect(f.cloud.starts()).toHaveLength(5);
    await expect(f.pay(f.tab().id)).rejects.toMatchObject({ code: 'TERMINAL_BUSY' });
    expect(f.store.all('payment')).toHaveLength(5);
  });

  it('gör delretur med artikelantal, egen referens och moms från originalet', async () => {
    const f = fixture(); const payment = await f.pay(f.tab().id); f.cloud.complete(f.requestId(payment));
    await f.service.checkPayment(f.admin, payment.id);
    const refund = await f.service.refund(f.admin, payment.id, { key: key(), items: [{ lineId: payment.allocations[0].lineId, quantity: 1 }], reason: 'Testretur av en artikel', simulation: 'approved', fiscalSimulation: 'confirmed' });
    expect(refund.status).toBe('pending');
    expect(f.cloud.transactions.get(f.requestId(refund))?.action).toBe('REFUND');
    expect(refund.amountOre).toBe(payment.amountOre / 2);
    f.cloud.complete(f.requestId(refund));
    expect((await f.service.checkPayment(f.admin, refund.id)).status).toBe('approved');
    const receipts = f.store.all<Receipt>('receipt');
    expect(receipts[1].originalReceiptId).toBe(receipts[0].id);
    expect(receipts[1].payment.allocations[0].quantity).toEqual({ numerator: '1', denominator: '1' });
    await expect(f.service.refund(f.admin, payment.id, { key: key(), amountOre: payment.amountOre, reason: 'För stor retur', simulation: 'approved', fiscalSimulation: 'confirmed' })).rejects.toThrow();
  });

  it('låter HTTP-fel och okända leverantörstillstånd förbli osäkra', async () => {
    const f = fixture(); const payment = await f.pay(f.tab().id); f.cloud.failReads = true;
    expect((await f.service.checkPayment(f.admin, payment.id, true)).status).toBe('unknown');
    expect(f.store.all('receipt')).toHaveLength(0);
    f.cloud.failReads = false; f.cloud.transactions.get(f.requestId(payment))!.state = 'FAILED';
    expect((await f.service.checkPayment(f.admin, payment.id)).status).toBe('unknown');
  });

  it('kan säkert avsluta ett försök som aldrig hann skicka PUT', async () => {
    const f = fixture(false, async () => { throw new Error('No auth connection'); });
    const payment = await f.pay(f.tab().id);
    expect(payment.status).toBe('unknown');
    expect(f.adapter.terminalInfo(payment.id)?.requestId).toBeNull();
    expect((await f.service.checkPayment(f.admin, payment.id, true)).status).toBe('cancelled');
    expect(await f.adapter.start(payment)).toBe('cancelled');
  });

  it('stoppar okopplade enheter och dricks innan en betalning reserveras', async () => {
    const f = fixture(); const tab = f.tab();
    await expect(f.pay(tab.id, f.admin, { tipOre: 100 })).rejects.toMatchObject({ code: 'TERMINAL_TIPS_UNSUPPORTED' });
    const device = f.service.saveDevice(f.admin, { name: 'Ny handterminal', kind: 'serving', station: null, active: true });
    await expect(f.pay(tab.id, f.actor(device.code))).rejects.toMatchObject({ code: 'TERMINAL_NOT_CONFIGURED' });
    expect(f.store.all('payment')).toHaveLength(0);
    expect(f.store.all('softpay-attempt')).toHaveLength(0);
    expect(f.cloud.calls).toHaveLength(0);
  });

  it('låser belopp, terminal, konto och extern referens i databasen', async () => {
    const f = fixture(); const payment = await f.pay(f.tab().id); const attempt = f.store.get<SoftpayAttempt>('softpay-attempt', payment.id)!;
    for (const changed of [{ amount: 1 }, { appId: 'NEW0000000000' }, { requestId: key() }, { account: 'different' }]) expect(() => f.store.put('softpay-attempt', { ...attempt, ...changed })).toThrow();
    expect(() => new SoftpaySandboxAdapter(f.store, { ...softpayTestConfig, clientId: 'different-account' }, f.client)).toThrow();
    expect(f.store.verifyJournal()).toBe(true);
  });
});
