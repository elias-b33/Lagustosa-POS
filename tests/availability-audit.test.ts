import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Bootstrap, Payment, Tab } from '../shared/types';

const project = path.resolve(import.meta.dirname, '..');
const roots: string[] = [];
const children: ChildProcess[] = [];
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(check: () => boolean | Promise<boolean>, failure: () => string, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(failure());
    await delay(25);
  }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Only kill a ChildProcess created by this test, never an arbitrary stored PID.
  const stopped = new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  child.kill('SIGKILL');
  await stopped;
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  for (const directory of roots.splice(0)) {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith('lagustosa-availability-')) throw new Error('Unsafe test cleanup');
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function temporary() {
  const root = mkdtempSync(path.join(tmpdir(), 'lagustosa-availability-'));
  roots.push(root);
  writeFileSync(path.join(root, 'empty.env'), '');
  return root;
}

async function freePort() {
  const reservation = net.createServer();
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  return address.port;
}

async function launch(root: string, barrier = false, command = ['server/index.ts']) {
  const port = await freePort();
  const preload = barrier ? ['--import', './tests/fixtures/availability-lock-barrier.mjs'] : [];
  const child = spawn(process.execPath, [...preload, '--import', 'tsx', ...command], {
    cwd: project, windowsHide: true, stdio: 'pipe',
    env: {
      ...process.env, APP_MODE: 'training', PAYMENT_ADAPTER: 'simulator', FISCAL_ADAPTER: 'simulator', PRINT_ADAPTER: 'preview',
      NODE_ENV: 'production', npm_lifecycle_event: 'availability-audit', DOTENV_CONFIG_PATH: path.join(root, 'empty.env'),
      DATA_DIR: root, BACKUP_DIR: path.join(root, 'backups'), HOST: '127.0.0.1', PORT: String(port), TLS_CERT: '', TLS_KEY: '', TEST_ENVIRONMENT: '',
      SESSION_COOKIE_NAME: 'lagustosa_availability',
      ...(barrier ? { AVAILABILITY_LOCK_FILE: path.join(root, 'training.lock'), AVAILABILITY_OBSERVED_FILE: path.join(root, 'observed'), AVAILABILITY_RELEASE_FILE: path.join(root, 'released') } : {}),
    },
  });
  children.push(child);
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk; });
  child.stderr!.on('data', chunk => { output += chunk; });
  let error: Error | undefined;
  child.on('error', value => { error = value; });
  const base = `http://127.0.0.1:${port}`;
  const ready = async () => {
    await waitFor(async () => {
      if (error) throw error;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Test server exited: ${output}`);
      try { return (await fetch(base + '/api/v1/health', { signal: AbortSignal.timeout(500) })).status === 200; } catch { return false; }
    }, () => `Test server did not become ready: ${output}`);
  };
  return { child, base, ready, output: () => output };
}

async function request<T>(base: string, route: string, cookie?: string, body?: unknown) {
  const response = await fetch(base + '/api/v1' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return { response, data: JSON.parse(text) as T };
}

describe('Verkliga serveravbrott och databasägarskap', () => {
  it('bevarar kvitterade beställningar, sessioner och samma osäkra betalningsförsök efter hård processkrasch', async () => {
    const root = temporary();
    const first = await launch(root); await first.ready();
    const login = await request(first.base, '/auth/login', undefined, { staffId: 'admin', pin: '1234', deviceCode: 'LAGUSTOSA-TEST' });
    const cookie = login.response.headers.get('set-cookie')!.split(';')[0];
    await request(first.base, '/business-days', cookie, { key: randomUUID(), floatOre: 150000 });
    let tab = (await request<Tab>(first.base, '/tabs', cookie, { key: randomUUID(), tableId: 'table-1', guestCount: 2, serviceMode: 'dine_in' })).data;
    const add = { key: randomUUID(), version: tab.version, action: 'add', itemId: 'bread' };
    tab = (await request<Tab>(first.base, `/tabs/${tab.id}/commands`, cookie, add)).data;
    const sent = { key: randomUUID(), version: tab.version, action: 'send' };
    tab = (await request<Tab>(first.base, `/tabs/${tab.id}/commands`, cookie, sent)).data;
    const attempt = { key: randomUUID(), version: tab.version, method: 'card', tipOre: 0, simulation: 'unknown', fiscalSimulation: 'confirmed' };
    const payment = (await request<Payment>(first.base, `/tabs/${tab.id}/payments`, cookie, attempt)).data;
    expect(payment.status).toBe('unknown');
    const before = (await request<Bootstrap>(first.base, '/bootstrap', cookie)).data;
    await stop(first.child);

    const restarted = await launch(root); await restarted.ready();
    const after = (await request<Bootstrap>(restarted.base, '/bootstrap', cookie)).data;
    expect(after.tabs).toEqual(before.tabs);
    expect(after.tickets).toEqual(before.tickets);
    expect(after.payments).toEqual(before.payments);
    expect(after.currentDay?.id).toBe(before.currentDay?.id);
    expect((await request<Payment>(restarted.base, `/payment-attempts/${attempt.key}`, cookie)).data.id).toBe(payment.id);
    await request(restarted.base, `/tabs/${tab.id}/commands`, cookie, sent);
    expect((await request<Payment>(restarted.base, `/tabs/${tab.id}/payments`, cookie, attempt)).data.id).toBe(payment.id);
    const checked = (await request<Payment>(restarted.base, `/payments/${payment.id}/check`, cookie, {})).data;
    expect(checked.status).toBe('approved');
    const final = (await request<Bootstrap>(restarted.base, '/bootstrap', cookie)).data;
    expect(final.payments).toHaveLength(1);
    expect(final.receipts).toHaveLength(1);
    expect(final.tickets).toHaveLength(before.tickets.length);
    expect(final.tabs[0].lines).toHaveLength(1);
    expect((await request<{ intact: boolean }>(restarted.base, '/journal', cookie)).data.intact).toBe(true);
    await request(restarted.base, '/backups', cookie, {});
    await stop(restarted.child);
  });

  it('släpper inte in två serverprocesser när en gammal PID-fil återtas samtidigt', async () => {
    const root = temporary();
    // This PID belongs to a terminated child; no unrelated process is probed or killed.
    const first = await launch(root); await first.ready(); await stop(first.child);
    expect(existsSync(path.join(root, 'training.lock'))).toBe(true);
    const paused = await launch(root, true);
    await waitFor(() => existsSync(path.join(root, 'observed')), () => paused.output());
    const contender = await launch(root);
    // With a lifetime OS lock, the contender must fail while the first owns the
    // lock. With the old stale-file algorithm it will incorrectly become ready.
    await waitFor(async () => {
      if (contender.child.exitCode !== null || contender.child.signalCode !== null) return true;
      try { return (await fetch(contender.base + '/api/v1/health', { signal: AbortSignal.timeout(300) })).ok; } catch { return false; }
    }, () => contender.output());
    writeFileSync(path.join(root, 'released'), 'continue');
    await paused.ready();
    await delay(100);
    expect(contender.child.exitCode, 'Concurrent server must fail instead of opening the same database').not.toBeNull();
    expect(contender.child.exitCode).not.toBe(0);
    expect(JSON.parse(readFileSync(path.join(root, 'training.lock'), 'utf8')).pid).toBe(paused.child.pid);
  });

  it('hindrar serverstart under återställning och släpper låset när återställningen är klar', async () => {
    const root = temporary();
    const first = await launch(root); await first.ready();
    const login = await request(first.base, '/auth/login', undefined, { staffId: 'admin', pin: '1234', deviceCode: 'LAGUSTOSA-TEST' });
    const cookie = login.response.headers.get('set-cookie')!.split(';')[0];
    await request(first.base, '/business-days', cookie, { key: randomUUID(), floatOre: 10000 });
    await request(first.base, '/backups', cookie, {});
    const backup = path.join(root, 'backups', readdirSync(path.join(root, 'backups')).find(name => name.endsWith('.sqlite'))!);
    await stop(first.child);

    const restore = await launch(root, true, ['scripts/restore.mjs', backup]);
    await waitFor(() => existsSync(path.join(root, 'observed')), () => restore.output());
    const contender = await launch(root);
    await waitFor(() => contender.child.exitCode !== null, () => contender.output());
    expect(contender.child.exitCode).not.toBe(0);
    expect(contender.output()).toContain('återställning pågår');
    writeFileSync(path.join(root, 'released'), 'continue');
    await waitFor(() => restore.child.exitCode !== null, () => restore.output());
    expect(restore.child.exitCode, restore.output()).toBe(0);
    expect(existsSync(path.join(root, 'training.lock'))).toBe(false);

    const restarted = await launch(root); await restarted.ready();
    expect((await request<Bootstrap>(restarted.base, '/bootstrap', cookie)).data.currentDay?.floatOre).toBe(10000);
    expect((await request<{ intact: boolean }>(restarted.base, '/journal', cookie)).data.intact).toBe(true);
  });

  it('kan starta efter en krasch även om det tidigare PID-numret återanvänds', async () => {
    const root = temporary();
    const first = await launch(root); await first.ready(); await stop(first.child);
    const metadata = path.join(root, 'training.lock');
    const previous = JSON.parse(readFileSync(metadata, 'utf8'));
    expect(previous.ownership).toBe('sqlite-v1');
    // The test runner remains alive; it is never signalled. The free OS lock,
    // rather than a reused numeric PID, is authoritative for the new format.
    writeFileSync(metadata, JSON.stringify({ ...previous, pid: process.pid }));
    const restarted = await launch(root); await restarted.ready();
    expect(JSON.parse(readFileSync(metadata, 'utf8')).pid).toBe(restarted.child.pid);
  });

  it('stänger servern även när en orderskärm håller sin händelseström öppen', async () => {
    const { createApp } = await import('../server/app');
    const context = await createApp({ database: ':memory:' });
    const controller = new AbortController();
    try {
      const login = await context.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { staffId: 'admin', pin: '1234', deviceCode: 'LAGUSTOSA-TEST' } });
      await context.app.listen({ host: '127.0.0.1', port: 0 });
      const address = context.app.server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test port');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`, { headers: { Cookie: `lagustosa_session=${login.cookies[0].value}` }, signal: controller.signal });
      expect((await response.body!.getReader().read()).done).toBe(false);
      const closed = context.app.close().then(() => true);
      expect(await Promise.race([closed, delay(2000).then(() => false)]), 'Open SSE connections must not block graceful shutdown').toBe(true);
    } finally {
      controller.abort();
      await context.app.close();
    }
  });
});
