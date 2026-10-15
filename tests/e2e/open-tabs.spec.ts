import { test as base, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Bootstrap, Tab } from '../../shared/types';
import { calculateTab, money } from '../../shared/money';

// These tests close an entire day. Keep their ledger separate from other browser suites.
const test = base.extend<{}, { closingServer: string }>({
  closingServer: [async ({}, use) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lagustosa-closing-browser-'));
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    const port = address.port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const cli = (action: string) => spawnSync(process.execPath, ['scripts/safe-test.mjs', action, '--root', root, '--port', String(port), '--no-browser'], { encoding: 'utf8', windowsHide: true, timeout: 35000 });
    try {
      const started = cli('start');
      expect(started.status, started.stdout + started.stderr).toBe(0);
      await use(`http://127.0.0.1:${port}`);
    } finally {
      const stopped = cli('stop');
      expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
      if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(root).startsWith('lagustosa-closing-browser-')) throw new Error('Invalid cleanup directory');
      await rm(root, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
  baseURL: async ({ closingServer }, use) => use(closingServer),
});

test.describe.configure({ mode: 'serial' });

async function post<T>(page: Page, path: string, data: Record<string, unknown>): Promise<T> {
  const response = await page.request.post(`/api/v1${path}`, { data: { key: randomUUID(), ...data } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
const snapshot = async (page: Page): Promise<Bootstrap> => (await page.request.get('/api/v1/bootstrap')).json();
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Personal', { exact: true }).selectOption('admin');
  await page.getByLabel('PIN-kod', { exact: true }).fill('1234');
  await page.getByText('Enhet och testprofiler', { exact: true }).click();
  await page.getByLabel('Enhetskod', { exact: true }).fill('LAGUSTOSA-TEST');
  await page.getByRole('button', { name: 'Börja servicen', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Huvudmeny' })).toBeVisible();
  if (!(await snapshot(page)).currentDay) await post(page, '/business-days', { floatOre: 0 });
}
const create = (page: Page) => post<Tab>(page, '/tabs', { tableId: null, guestCount: 2, serviceMode: 'dine_in' });
const command = (page: Page, tab: Tab, input: Record<string, unknown>) => post<Tab>(page, `/tabs/${tab.id}/commands`, { version: tab.version, ...input });
const row = (page: Page, tab: Tab) => page.getByRole('article', { name: `${tab.label} · nota ${tab.number}`, exact: true });
async function reports(page: Page) {
  await page.getByRole('navigation', { name: 'Huvudmeny' }).getByRole('button', { name: 'Dagsöversikt', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Oavslutade notor', exact: true })).toBeVisible();
}

test('dagsavslut leder till öppna notor, delbetalning och journalfört avslut av tomma notor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const empty = await create(page);
  let removed = await create(page);
  removed = await command(page, removed, { action: 'add', itemId: 'bread' });
  removed = await command(page, removed, { action: 'remove', lineId: removed.lines[0].id });
  let partial = await create(page);
  partial = await command(page, partial, { action: 'add', itemId: 'bread', quantity: 2 });
  partial = await command(page, partial, { action: 'send' });
  const half = calculateTab(partial).grossOre / 2;
  await post(page, `/tabs/${partial.id}/payments`, { version: partial.version, method: 'card', amountOre: half, tipOre: 0, simulation: 'approved' });
  await reports(page);
  await expect(row(page, partial)).toContainText('Delbetald');
  await expect(row(page, partial).locator('.open-tab-amount strong')).toHaveText(money(half));
  await page.getByRole('button', { name: 'Avsluta dagen', exact: true }).click();
  const closeDay = page.getByRole('dialog', { name: 'Avsluta verksamhetsdagen' });
  await expect(closeDay.getByRole('button', { name: 'Bekräfta dagsavslut' })).toBeDisabled();
  await closeDay.getByRole('button', { name: 'Visa 3 öppna notor' }).click();
  await expect(closeDay).not.toBeVisible();
  await expect(page.getByRole('region', { name: 'Oavslutade notor', exact: true })).toBeFocused();
  await page.getByLabel('Sök oavslutade notor').fill(partial.label);
  await expect(page.locator('.open-tab-row')).toHaveCount(1);
  await page.getByLabel('Sök oavslutade notor').fill('');
  await expect(row(page, empty).getByRole('button', { name: 'Avsluta tom nota', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('region', { name: 'Oavslutade notor', exact: true }).screenshot({ path: 'artifacts/open-tabs-mobile.png' });
  await row(page, partial).getByRole('button', { name: 'Ta betalt', exact: true }).click();
  const payment = page.getByRole('dialog', { name: 'Ta betalt', exact: true });
  await expect(payment.locator('.pay-amount strong')).toHaveText(money(half));
  await payment.getByRole('button', { name: /^Simulera betalning/ }).click();
  await expect(payment.getByText('Notan är helt betald.', { exact: true })).toBeVisible();
  await payment.getByRole('button', { name: 'Klart', exact: true }).click();
  await expect(row(page, partial)).not.toBeVisible();
  await page.getByRole('button', { name: 'Avsluta alla tomma (2)', exact: true }).click();
  const bulk = page.getByRole('dialog', { name: 'Avsluta tomma notor', exact: true });
  await expect(bulk).toContainText(empty.label);
  await expect(bulk).toContainText(removed.label);
  await bulk.getByRole('button', { name: 'Avsluta 2 tomma notor', exact: true }).click();
  await expect(bulk.getByRole('status')).toHaveText('2 notor avslutade.');
  await bulk.getByRole('button', { name: 'Klart', exact: true }).click();
  await expect(page.getByText('Inga öppna notor kvar', { exact: true })).toBeVisible();
  const after = await snapshot(page);
  expect(after.tabs.find(tab => tab.id === partial.id)?.status).toBe('paid');
  expect(after.tabs.filter(tab => [empty.id, removed.id].includes(tab.id)).map(tab => tab.status)).toEqual(['void', 'void']);
  expect(after.payments).toHaveLength(2);
  await page.getByRole('button', { name: 'Avsluta dagen', exact: true }).click();
  await expect(closeDay.getByRole('button', { name: 'Bekräfta dagsavslut' })).toBeEnabled();
  await closeDay.getByRole('button', { name: 'Bekräfta dagsavslut' }).click();
  await expect(closeDay).not.toBeVisible();
  expect((await snapshot(page)).currentDay).toBeNull();
});

test('oskickat, väntande, nollpris och osäkra betalningar får rätt åtgärder', async ({ page }) => {
  await login(page);
  let draft = await create(page);
  draft = await command(page, draft, { action: 'add', itemId: 'bread' });
  let held = await create(page);
  held = await command(page, held, { action: 'add', itemId: 'bread', hold: true });
  let free = await create(page);
  free = await command(page, free, { action: 'add', itemId: 'bread' });
  free = await command(page, free, { action: 'discount', discountBps: 10000, reason: 'Kostnadsfri testartikel' });
  free = await command(page, free, { action: 'send' });
  let unknown = await create(page);
  unknown = await command(page, unknown, { action: 'add', itemId: 'bread' });
  unknown = await command(page, unknown, { action: 'send' });
  await post(page, `/tabs/${unknown.id}/payments`, { version: unknown.version, method: 'card', tipOre: 0, simulation: 'unknown' });
  await reports(page);
  await expect(row(page, draft)).toContainText('1 oskickad rad');
  await expect(row(page, held)).toContainText('1 väntande rad');
  await expect(row(page, unknown)).toContainText('Betalning behöver kontrolleras');
  await expect(row(page, unknown).getByRole('button', { name: 'Kontrollera status', exact: true })).toBeEnabled();
  for (const tab of [draft, held, unknown]) {
    await expect(row(page, tab).getByRole('button', { name: 'Ta betalt', exact: true })).toHaveCount(0);
    await expect(row(page, tab).getByRole('button', { name: 'Avsluta tom nota', exact: true })).toHaveCount(0);
  }
  await expect(row(page, free).getByRole('button', { name: 'Avsluta tom nota', exact: true })).toHaveCount(0);
  await expect(row(page, free).getByRole('button', { name: 'Ta betalt', exact: true })).toBeEnabled();
  await page.getByLabel('Filtrera oavslutade notor').selectOption('empty');
  await expect(page.locator('.open-tab-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Visa alla', exact: true }).click();
  await page.getByRole('region', { name: 'Oavslutade notor', exact: true }).screenshot({ path: 'artifacts/open-tabs-desktop.png' });
  await page.setViewportSize({ width: 820, height: 1180 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await row(page, draft).getByRole('button', { name: 'Öppna nota', exact: true }).click();
  await expect(page.getByLabel('Öppna notor', { exact: true })).toHaveValue(draft.id);
  await reports(page);
  await row(page, free).getByRole('button', { name: 'Ta betalt', exact: true }).click();
  const payment = page.getByRole('dialog', { name: 'Ta betalt', exact: true });
  await payment.getByRole('button', { name: /^Simulera betalning/ }).click();
  await expect(payment.getByText('Notan är helt betald.', { exact: true })).toBeVisible();
  await payment.getByRole('button', { name: 'Klart', exact: true }).click();
  await expect(row(page, free)).not.toBeVisible();
});

test('gemensamt avslut skyddar en tom nota som ändras från en annan enhet', async ({ page }) => {
  await login(page);
  const changed = await create(page);
  const untouched = await create(page);
  await reports(page);
  await page.getByRole('button', { name: 'Avsluta alla tomma (2)', exact: true }).click();
  // The dialog keeps the versions reviewed by the cashier, while another device adds an order.
  await command(page, changed, { action: 'add', itemId: 'bread' });
  const modal = page.getByRole('dialog', { name: 'Avsluta tomma notor', exact: true });
  await modal.getByRole('button', { name: 'Avsluta 2 tomma notor', exact: true }).click();
  await expect(modal.getByRole('status')).toHaveText('1 nota avslutad.');
  await expect(modal.getByRole('alert')).toContainText(changed.label);
  await modal.getByRole('button', { name: 'Klart', exact: true }).click();
  await expect(row(page, changed)).toContainText('1 oskickad rad');
  await expect(row(page, untouched)).not.toBeVisible();
  const state = await snapshot(page);
  expect(state.tabs.find(tab => tab.id === changed.id)?.status).toBe('open');
  expect(state.tabs.find(tab => tab.id === changed.id)?.lines.filter(line => line.status !== 'void')).toHaveLength(1);
  expect(state.tabs.find(tab => tab.id === untouched.id)?.status).toBe('void');
});
