import { afterEach, describe, expect, it } from 'vitest';
import { createApp, assertTrainingMode } from '../server/app';
import { key } from './helpers';
import type { Bootstrap, PrinterProfile } from '../shared/types';

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { for (const { app } of apps.splice(0)) await app.close(); });
async function api(development = false) {
  const context = await createApp({ database: ':memory:', development }); apps.push(context);
  const login = await context.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { staffId: 'admin', pin: '1234', deviceCode: 'LAGUSTOSA-TEST' } });
  const cookie = `lagustosa_session=${login.cookies[0].value}`;
  return { ...context, cookie, login };
}

describe('API och flera enheter', () => {
  it('håller testmiljöns inloggning separat från utvecklingskassans på samma dator', async () => {
    const development = await api();
    const safe = await createApp({ database: ':memory:', sessionCookieName: 'lagustosa_safe_test_example', safeTest: { instanceId: key(), launchId: key(), sessionId: key() } }); apps.push(safe);
    const login = await safe.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { staffId: 'admin', pin: '1234', deviceCode: 'LAGUSTOSA-TEST' } });
    const safeCookie = `lagustosa_safe_test_example=${login.cookies[0].value}`;
    expect(login.headers['set-cookie']).toContain('lagustosa_safe_test_example=');
    expect((await safe.app.inject({ url: '/api/v1/bootstrap', headers: { cookie: development.cookie } })).statusCode).toBe(401);
    expect((await development.app.inject({ url: '/api/v1/bootstrap', headers: { cookie: safeCookie } })).statusCode).toBe(401);
    const bothCookies = `${development.cookie}; ${safeCookie}`;
    expect((await safe.app.inject({ url: '/api/v1/bootstrap', headers: { cookie: bothCookies } })).json<Bootstrap>().testEnvironment).toBe('safe-test');
    const logout = await safe.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: bothCookies }, payload: {} });
    expect(logout.statusCode).toBe(200); expect(logout.headers['set-cookie']).toContain('lagustosa_safe_test_example=;');
    expect((await safe.app.inject({ url: '/api/v1/bootstrap', headers: { cookie: safeCookie } })).statusCode).toBe(401);
    expect((await development.app.inject({ url: '/api/v1/bootstrap', headers: { cookie: bothCookies } })).statusCode).toBe(200);
    expect(safe.service.bootstrap(safe.service.login('admin', '1234', 'LAGUSTOSA-TEST', 'local').actor).currentDay).toBeNull();
    expect((await safe.app.inject('/api/v1/health')).json()).toMatchObject({ environment: 'safe-test', adapters: { payment: 'simulator', fiscal: 'simulator', print: 'preview' } });
    await expect(createApp({ database: ':memory:', safeTest: { instanceId: key(), launchId: key(), sessionId: key() } })).rejects.toThrow('separat inloggningssession');
  });

  it('har ett tydligt träningsläge och spärrar produktionsinställningar', () => {
    expect(() => assertTrainingMode({ APP_MODE: 'training' })).not.toThrow();
    expect(() => assertTrainingMode({ APP_MODE: 'production' })).toThrow('Produktionsläget är spärrat');
    expect(() => assertTrainingMode({ PAYMENT_ADAPTER: 'live' })).toThrow('simulatorer');
  });

  it('kräver inloggning och validerar ändringar på servern', async () => {
    const f = await api();
    expect((await f.app.inject('/api/v1/bootstrap')).statusCode).toBe(401);
    expect(f.login.headers['set-cookie']).toContain('HttpOnly');
    expect(f.login.headers['set-cookie']).toContain('SameSite=Strict');
    const bad = await f.app.inject({ method: 'POST', url: '/api/v1/tabs', headers: { cookie: f.cookie }, payload: { key: key(), tableId: null, guestCount: -1, serviceMode: 'dine_in' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('VALIDATION');
  });

  it('avvisar anrop från andra webbplatser och tillåter bara uttryckligt utvecklingsläge', async () => {
    const f = await api();
    const input = { method: 'POST' as const, url: '/api/v1/auth/logout', headers: { cookie: f.cookie, origin: 'https://example.invalid' }, payload: {} };
    expect((await f.app.inject(input)).statusCode).toBe(403);
    expect((await f.app.inject({ ...input, headers: { cookie: f.cookie, origin: 'http://127.0.0.1:5173' } })).statusCode).toBe(403);
    const dev = await api(true);
    expect((await dev.app.inject({ ...input, headers: { cookie: dev.cookie, origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-site' } })).statusCode).toBe(200);
  });

  it('begränsar upprepade felaktiga PIN-försök', async () => {
    const f = await api();
    for (let i = 0; i < 5; i++) expect((await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { staffId: 'cashier', pin: '0000', deviceCode: 'LAGUSTOSA-TEST' } })).statusCode).toBe(401);
    const sixth = await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { staffId: 'cashier', pin: '2345', deviceCode: 'LAGUSTOSA-TEST' } });
    expect(sixth.statusCode).toBe(429);
  });

  it('läser samma betalningsförsök utan att ta betalt igen och skyddar andra kassörers nycklar', async () => {
    const f = await api(); const actor = f.service.session(f.cookie.split('=')[1]);
    f.service.openDay(actor, { key: key(), floatOre: 0 });
    let tab = f.service.createTab(actor, { key: key(), tableId: null, guestCount: 1, serviceMode: 'dine_in' });
    tab = f.service.updateTab(actor, tab.id, { key: key(), version: tab.version, action: 'add', itemId: 'bread' });
    tab = f.service.updateTab(actor, tab.id, { key: key(), version: tab.version, action: 'send' });
    const attemptKey = key();
    const payment = await f.service.startPayment(actor, tab.id, { key: attemptKey, version: tab.version, method: 'card', tipOre: 0, simulation: 'approved', fiscalSimulation: 'confirmed' });
    const route = `/api/v1/payment-attempts/${attemptKey}`;
    expect((await f.app.inject(route)).statusCode).toBe(401);
    const response = await f.app.inject({ url: route, headers: { cookie: f.cookie } });
    expect(response.statusCode).toBe(200); expect(response.json().id).toBe(payment.id);
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await f.app.inject({ url: `/api/v1/payment-attempts/${key()}`, headers: { cookie: f.cookie } })).json()).toBeNull();
    const other = await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { staffId: 'cashier', pin: '2345', deviceCode: 'LAGUSTOSA-TEST' } });
    expect((await f.app.inject({ url: route, headers: { cookie: `lagustosa_session=${other.cookies[0].value}` } })).json()).toBeNull();
    expect(f.store.all('payment')).toHaveLength(1); expect(f.store.all('receipt')).toHaveLength(1);
  });

  it('validerar skrivartyper, pappersbredd och administratörens behörighet', async () => {
    const f = await api();
    expect((await f.app.inject('/api/v1/printers')).statusCode).toBe(401);
    const profiles = (await f.app.inject({ url: '/api/v1/printers', headers: { cookie: f.cookie } })).json<PrinterProfile[]>();
    expect(profiles).toHaveLength(3);
    const profile = profiles[0]; const url = `/api/v1/printers/${profile.id}`;
    expect((await f.app.inject({ method: 'PUT', url, headers: { cookie: f.cookie }, payload: { ...profile, paperWidthMm: 42 } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'PUT', url, headers: { cookie: f.cookie }, payload: { ...profile, host: 'unconfigured' } })).statusCode).toBe(400);
    const duplicate = { ...profile, id: key() };
    const conflict = await f.app.inject({ method: 'PUT', url: `/api/v1/printers/${duplicate.id}`, headers: { cookie: f.cookie }, payload: duplicate });
    expect(conflict.statusCode).toBe(409); expect(conflict.json().code).toBe('PRINTER_CONFLICT');
    const login = await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { staffId: 'cashier', pin: '2345', deviceCode: 'LAGUSTOSA-TEST' } });
    expect((await f.app.inject({ method: 'PUT', url, headers: { cookie: `lagustosa_session=${login.cookies[0].value}` }, payload: profile })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'PUT', url, headers: { cookie: f.cookie }, payload: { ...profile, paperWidthMm: 58 } })).json<PrinterProfile>().paperWidthMm).toBe(58);
  });

  it('synkroniserar åtta anslutna enheter när samma order ändras', async () => {
    const f = await api();
    f.service.openDay(f.service.session(f.cookie.split('=')[1]), { key: key(), floatOre: 0 });
    await f.app.listen({ host: '127.0.0.1', port: 0 });
    const address = f.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Server address missing');
    const base = `http://127.0.0.1:${address.port}`;
    const devices = [
      ['admin', '1234', 'LAGUSTOSA-TEST'],
      ...[1, 2, 3, 4].map(index => ['waiter', '3456', `SERVERING-${index}`]),
      ['kitchen', '4567', 'KOK-TEST'], ['bar', '5678', 'BAR-TEST'], ['kitchen', '4567', 'KOK-TEST-2'],
    ];
    const controller = new AbortController();
    try {
      const clients = await Promise.all(devices.map(async ([staffId, pin, deviceCode]) => {
        const login = await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { staffId, pin, deviceCode } });
        const cookie = `lagustosa_session=${login.cookies[0].value}`;
        const response = await fetch(`${base}/api/v1/events`, { headers: { Cookie: cookie }, signal: controller.signal });
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: ready');
        return { reader, cookie, station: ['kitchen', 'bar'].includes(staffId) ? staffId : null };
      }));
      expect(f.service.deviceConnections().every(device => device.connections === 1)).toBe(true);
      const actor = f.service.session(f.cookie.split('=')[1]);
      let tab = f.service.createTab(actor, { key: key(), tableId: 'table-1', guestCount: 2, serviceMode: 'dine_in' });
      for (const input of [{ action: 'add', itemId: 'bread' }, { action: 'add', itemId: 'redwine' }, { action: 'send' }] as const) tab = f.service.updateTab(actor, tab.id, { ...input, key: key(), version: tab.version });
      const updates = await Promise.all(clients.map(client => client.reader.read()));
      expect(updates).toHaveLength(8);
      for (const update of updates) expect(new TextDecoder().decode(update.value)).toContain('event: change');
      const snapshots = await Promise.all(clients.map(client => f.app.inject({ url: '/api/v1/bootstrap', headers: { cookie: client.cookie } })));
      for (let index = 0; index < clients.length; index++) {
        const data = snapshots[index].json<Bootstrap>();
        if (clients[index].station) { expect(data.tabs).toEqual([]); expect(data.tickets).toHaveLength(1); expect(data.tickets[0].station).toBe(clients[index].station); }
        else expect(data.tabs.find(candidate => candidate.id === tab.id)?.lines).toHaveLength(2);
      }
    } finally {
      controller.abort();
      await expect.poll(() => f.service.deviceConnections().reduce((sum, device) => sum + device.connections, 0), { timeout: 3000 }).toBe(0);
    }
  });
});
