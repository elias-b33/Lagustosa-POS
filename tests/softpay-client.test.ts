import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SoftpaySandboxClient, SoftpayError, SOFTPAY_SANDBOX_API, SOFTPAY_SANDBOX_TOKEN } from '../server/softpay-client';
import { readSoftpaySandboxConfig, softpayTerminalsSchema } from '../server/softpay-config';
import { assertTrainingMode, createApp } from '../server/app';
import { SoftpaySandboxAdapter } from '../server/softpay-adapter';
import { SoftpayContractHarness, softpayTestConfig } from './fixtures/softpay-cloud';
import { key } from './helpers';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });
describe('Softpay klient och konfiguration', () => {
  it('använder sandboxvärdar, OAuth client credentials och valt handlarkonto utan omdirigering', async () => {
    const cloud = new SoftpayContractHarness(); const client = new SoftpaySandboxClient(softpayTestConfig, cloud.fetch);
    await Promise.all([client.create('PAYMENT'), client.create('REFUND')]);
    expect(cloud.calls.filter(call => call.url === SOFTPAY_SANDBOX_TOKEN)).toHaveLength(1);
    expect(cloud.calls[0].body).toBe('grant_type=client_credentials');
    expect(cloud.calls[0].headers.get('Authorization')).toMatch(/^Basic /);
    expect(cloud.calls[1].headers.get('X-Softpay-Merchant-Reference')).toBe(softpayTestConfig.merchantReference);
    expect(cloud.calls.every(call => call.url.startsWith(SOFTPAY_SANDBOX_API) || call.url === SOFTPAY_SANDBOX_TOKEN)).toBe(true);
    expect(cloud.calls.every(call => call.redirect === 'error')).toBe(true);
  });
  it('förnyar token vid utgång och efter 401 men upprepar inte det felande anropet', async () => {
    let now = 0, fail = false; const cloud = new SoftpayContractHarness();
    const client = new SoftpaySandboxClient(softpayTestConfig, (url, init) => fail && url === SOFTPAY_SANDBOX_API ? Promise.resolve(Response.json({}, { status: 401 })) : cloud.fetch(url, init), () => now);
    await client.create('PAYMENT'); now = 3600000; await client.create('PAYMENT');
    expect(cloud.calls.filter(call => call.url === SOFTPAY_SANDBOX_TOKEN)).toHaveLength(2);
    fail = true; await expect(client.create('PAYMENT')).rejects.toMatchObject({ httpStatus: 401 });
    fail = false; await client.create('PAYMENT');
    expect(cloud.calls.filter(call => call.url === SOFTPAY_SANDBOX_TOKEN)).toHaveLength(3);
  });
  it.each([400, 401, 403, 404, 409, 429, 500])('bevarar HTTP %s som osäkert tekniskt fel utan råa felmeddelanden', async status => {
    const cloud = new SoftpayContractHarness();
    const client = new SoftpaySandboxClient(softpayTestConfig, (url, init) => url === SOFTPAY_SANDBOX_TOKEN ? cloud.fetch(url, init) : Promise.resolve(Response.json({ message: 'sensitive provider text' }, { status })));
    try { await client.read(key()); expect.fail('Expected error'); }
    catch (error) { expect(error).toBeInstanceOf(SoftpayError); expect((error as Error).message).not.toContain('sensitive'); }
  });
  it('avvisar för stora, felaktiga och främmande svar', async () => {
    for (const value of ['not json', 'x'.repeat(65537), JSON.stringify({ requestId: key(), state: 'COMPLETED' })]) {
      const cloud = new SoftpayContractHarness();
      const client = new SoftpaySandboxClient(softpayTestConfig, (url, init) => url === SOFTPAY_SANDBOX_TOKEN ? cloud.fetch(url, init) : Promise.resolve(new Response(value)));
      await expect(client.read(key())).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
  it('avvisar dubbla terminaler, godtyckliga värdar och saknade serveruppgifter', () => {
    const terminal = softpayTestConfig.terminals[0];
    expect(softpayTerminalsSchema.safeParse([terminal, { ...terminal, deviceId: 'other' }]).success).toBe(false);
    expect(softpayTerminalsSchema.safeParse([{ ...terminal, appId: '../../escape' }]).success).toBe(false);
    expect(softpayTerminalsSchema.safeParse([{ ...terminal, apiUrl: 'https://other.example' }]).success).toBe(false);
    expect(() => readSoftpaySandboxConfig({})).toThrow();
    const directory = mkdtempSync(path.join(tmpdir(), 'softpay-config-')); directories.push(directory);
    const filename = path.join(directory, 'terminals.json'); writeFileSync(filename, JSON.stringify(softpayTestConfig.terminals));
    const config = readSoftpaySandboxConfig({ SOFTPAY_SANDBOX_CLIENT_ID: 'example', SOFTPAY_SANDBOX_CLIENT_SECRET: 'example-secret', SOFTPAY_SANDBOX_TERMINALS_FILE: filename });
    expect(config.terminals).toEqual(softpayTestConfig.terminals);
  });
  it('behåller produktionsspärr och isolerar den lokala övningsmiljön', () => {
    expect(() => assertTrainingMode({ APP_MODE: 'production', PAYMENT_ADAPTER: 'softpay-sandbox' })).toThrow();
    expect(() => assertTrainingMode({ PAYMENT_ADAPTER: 'softpay-live' })).toThrow();
    expect(() => assertTrainingMode({ PAYMENT_ADAPTER: 'softpay-sandbox', TEST_ENVIRONMENT: 'safe-test' })).toThrow();
    expect(() => assertTrainingMode({ PAYMENT_ADAPTER: 'softpay-sandbox' })).not.toThrow();
  });
  it('kräver inloggning och rätt roll för terminaluppgifter och visar inga hemligheter i bootstrap', async () => {
    const cloud = new SoftpayContractHarness();
    const f = await createApp({ database: ':memory:', paymentFactory: store => new SoftpaySandboxAdapter(store, softpayTestConfig, new SoftpaySandboxClient(softpayTestConfig, cloud.fetch)) });
    try {
      const admin = f.service.login('admin', '1234', 'LAGUSTOSA-TEST', '127.0.0.1');
      const waiter = f.service.login('waiter', '3456', 'SERVERING-1', '127.0.0.1');
      const kitchen = f.service.login('kitchen', '4567', 'KOK-TEST', '127.0.0.1');
      f.service.openDay(admin.actor, { key: key(), floatOre: 0 });
      let tab = f.service.createTab(admin.actor, { key: key(), tableId: null, guestCount: 1, serviceMode: 'dine_in' });
      for (const command of [{ action: 'add' as const, itemId: 'bread' }, { action: 'send' as const }]) tab = f.service.updateTab(admin.actor, tab.id, { key: key(), version: tab.version, ...command });
      const payment = await f.service.startPayment(admin.actor, tab.id, { key: key(), version: tab.version, method: 'card', tipOre: 0, simulation: 'approved', fiscalSimulation: 'confirmed' });
      const url = `/api/v1/payments/${payment.id}/terminal`;
      expect((await f.app.inject(url)).statusCode).toBe(401);
      expect((await f.app.inject({ url, headers: { cookie: `lagustosa_session=${kitchen.token}` } })).statusCode).toBe(403);
      const response = await f.app.inject({ url, headers: { cookie: `lagustosa_session=${admin.token}` } });
      expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ paymentId: payment.id, appId: 'TST0000000000' });
      const bootstrap = f.service.bootstrap(waiter.actor);
      expect(bootstrap.paymentIntegration?.terminals).toHaveLength(1);
      expect(JSON.stringify(bootstrap)).not.toContain('contract-test-secret');
      expect((await f.app.inject('/api/v1/health')).json().adapters.payment).toBe('softpay-sandbox');
    } finally { await f.app.close(); }
  });
});
