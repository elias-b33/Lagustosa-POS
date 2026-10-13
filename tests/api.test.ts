import { afterEach, describe, expect, it } from 'vitest';
import { createApp, assertTrainingMode } from '../server/app';
import { key } from './helpers';

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { for (const { app } of apps.splice(0)) await app.close(); });
async function api(development = false) {
  const context = await createApp({ database: ':memory:', development }); apps.push(context);
  const login = await context.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { staffId: 'admin', pin: '1234', deviceCode: 'LAGUSTOSA-TEST' } });
  const cookie = `lagustosa_session=${login.cookies[0].value}`;
  return { ...context, cookie, login };
}

describe('API och flera enheter', () => {
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
      const readers = await Promise.all(devices.map(async ([staffId, pin, deviceCode]) => {
        const login = await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { staffId, pin, deviceCode } });
        const response = await fetch(`${base}/api/v1/events`, { headers: { Cookie: `lagustosa_session=${login.cookies[0].value}` }, signal: controller.signal });
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: ready');
        return reader;
      }));
      const actor = f.service.session(f.cookie.split('=')[1]);
      f.service.createTab(actor, { key: key(), tableId: 'table-1', guestCount: 2, serviceMode: 'dine_in' });
      const updates = await Promise.all(readers.map(reader => reader.read()));
      expect(updates).toHaveLength(8);
      for (const update of updates) expect(new TextDecoder().decode(update.value)).toContain('event: change');
    } finally { controller.abort(); }
  });
});
