import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import type { Bootstrap } from '../../shared/types';

async function login(page: Page, staff: string, pin: string, device: string) {
  await page.goto('/');
  await expect(page.getByText('HEMTEST · HTTP', { exact: true })).toBeVisible();
  await page.getByLabel('Personal', { exact: true }).selectOption(staff);
  await page.getByLabel('PIN-kod', { exact: true }).fill(pin);
  await page.getByText('Enhet och testprofiler', { exact: true }).click();
  await page.getByLabel('Enhetskod', { exact: true }).fill(device);
  await page.getByRole('button', { name: 'Börja servicen', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Huvudmeny' })).toBeVisible();
}

test('HTTP-hemtest klarar plattbeställning, liveuppdatering och kvitto utan certifikat', async ({ browser }) => {
  const host = Object.values(networkInterfaces()).flat().find(item => item && !item.internal && item.family === 'IPv4' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))?.address;
  test.skip(!host, 'A private interface is required to test a real non-secure browser context.');
  const root = await mkdtemp(path.join(tmpdir(), 'lagustosa-http-browser-'));
  const reservation = createServer();
  await new Promise<void>(resolve => { reservation.listen(0, host, resolve); });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Test port missing');
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const cli = (action: string) => spawnSync(process.execPath, ['scripts/safe-test.mjs', action, '--root', root, '--port', String(port), '--lan', host!, '--http-lan', '--no-browser'], { encoding: 'utf8', windowsHide: true, timeout: 35000 });
  const main = await browser.newContext({ baseURL: `http://${host}:${port}` });
  const tablet = await browser.newContext({ baseURL: `http://${host}:${port}`, viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });
  try {
    const started = cli('start'); expect(started.status, started.stdout + started.stderr).toBe(0);
    const config = JSON.parse(await readFile(path.join(root, 'safe-test.json'), 'utf8'));
    // A previous HTTPS login on the same host must not prevent the HTTP login.
    await main.addCookies([{ name: 'lagustosa_safe_test_' + config.instanceId.replaceAll('-', ''), value: 'previous-https-session', domain: host!, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    const cashier = await main.newPage(); const waiter = await tablet.newPage();
    const errors: string[] = [];
    for (const page of [cashier, waiter]) page.on('pageerror', error => errors.push(error.message));
    await login(cashier, 'admin', '1234', 'LAGUSTOSA-TEST');
    expect(await cashier.evaluate(() => isSecureContext)).toBe(false);
    const day = await cashier.request.post('/api/v1/business-days', { data: { key: randomUUID(), floatOre: 0 } });
    expect(day.ok()).toBe(true);
    await cashier.goto('/#kitchen');
    await login(waiter, 'waiter', '3456', 'SERVERING-1');
    await waiter.getByRole('button', { name: /^Bord 01 / }).click();
    await waiter.getByRole('dialog').getByRole('button', { name: 'Öppna nota', exact: true }).click();
    await waiter.locator('.product-card').filter({ has: waiter.getByText('Vitlöksbröd', { exact: true }) }).click();
    await waiter.getByRole('dialog').getByRole('button', { name: /^Lägg till/ }).click();
    await waiter.getByRole('button', { name: /^Skicka till kök & bar/ }).click();
    await expect(cashier.locator('.ticket:not(.cancel-ticket)').filter({ hasText: 'Bord 01' })).toContainText('Vitlöksbröd');
    const state: Bootstrap = await (await cashier.request.get('/api/v1/bootstrap')).json();
    expect(state.testHttpLan).toBe(true);
    expect(state.tabs).toHaveLength(1);
    await cashier.goto('/#pos');
    await cashier.getByLabel('Öppna notor', { exact: true }).selectOption(state.tabs[0].id);
    await cashier.getByRole('button', { name: 'Ta betalt', exact: true }).click();
    const payment = cashier.getByRole('dialog', { name: 'Ta betalt' });
    await payment.getByRole('button', { name: /^Simulera betalning/ }).click();
    await expect(payment.getByRole('heading', { name: 'Betalningen är godkänd' })).toBeVisible();
    const paid: Bootstrap = await (await cashier.request.get('/api/v1/bootstrap')).json();
    expect(paid.receipts).toHaveLength(1);
    expect(paid.printJobs.some(job => job.kind === 'guest' && job.status === 'queued')).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await main.close(); await tablet.close();
    const stopped = cli('stop'); expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
    if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(root).startsWith('lagustosa-http-browser-')) throw new Error('Invalid cleanup directory');
    await rm(root, { recursive: true, force: true });
  }
});
