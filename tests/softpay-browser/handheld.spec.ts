import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Bootstrap, Tab, Payment } from '../../shared/types';

async function prepare(page: Page) {
  await page.goto('/');
  await page.getByLabel('Personal', { exact: true }).selectOption('admin');
  await page.getByLabel('PIN-kod', { exact: true }).fill('1234');
  await page.getByText('Enhet och testprofiler', { exact: true }).click();
  await page.getByLabel('Enhetskod', { exact: true }).fill('LAGUSTOSA-TEST');
  await page.getByRole('button', { name: 'Börja servicen', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Huvudmeny' })).toBeVisible();
  const data: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  expect(data.paymentIntegration).toMatchObject({ provider: 'softpay-sandbox', contractTest: true });
  if (!data.currentDay) expect((await page.request.post('/api/v1/business-days', { data: { key: randomUUID(), floatOre: 0 } })).ok()).toBe(true);
  let tab: Tab = await (await page.request.post('/api/v1/tabs', { data: { key: randomUUID(), tableId: null, guestCount: 1, serviceMode: 'dine_in' } })).json();
  for (const command of [{ action: 'add', itemId: 'bread', quantity: 2 }, { action: 'send' }]) {
    const response = await page.request.post(`/api/v1/tabs/${tab.id}/commands`, { data: { key: randomUUID(), version: tab.version, ...command } });
    expect(response.ok()).toBe(true); tab = await response.json();
  }
  await page.goto('/#pos');
  await page.getByLabel('Öppna notor', { exact: true }).selectOption(tab.id);
  await page.getByRole('button', { name: 'Ta betalt', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Ta betalt', exact: true });
  await expect(modal.getByLabel('Dricks i kronor', { exact: true })).toBeDisabled();
  return { tab, modal };
}
async function latestPayment(page: Page, tabId: string): Promise<Payment> {
  const data: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  return data.payments.filter(payment => payment.tabId === tabId).at(-1)!;
}

test('handterminalen visar vänteläge och skapar ett kvitto först efter verifierat testblipp', async ({ page }) => {
  const { tab, modal } = await prepare(page);
  await modal.getByRole('button', { name: /^Skicka till testterminal/ }).click();
  await expect(modal.getByRole('heading', { name: 'Väntar på testkort', exact: true })).toBeVisible();
  await expect(modal.getByText('Lokal terminalsimulator', { exact: true })).toBeVisible();
  const before: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  expect(before.receipts.filter(receipt => receipt.tab.id === tab.id)).toHaveLength(0);
  await expect(modal.getByRole('button', { name: 'Återuppta samma betalningsförsök', exact: true })).toBeDisabled();
  await page.screenshot({ path: 'artifacts/softpay-handheld-waiting.png' });
  await modal.getByRole('button', { name: 'Simulera blipp', exact: true }).click();
  await expect(modal.getByRole('heading', { name: 'Betalningen är godkänd' })).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: 'artifacts/softpay-handheld-approved.png' });
  const after: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  expect(after.receipts.filter(receipt => receipt.tab.id === tab.id)).toHaveLength(1);
  expect(after.tabs.find(entry => entry.id === tab.id)?.status).toBe('paid');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('förlorat svar och omladdning återupptar samma betalning utan nytt terminalanrop', async ({ page }) => {
  const { tab, modal } = await prepare(page);
  const stats = await (await page.request.get('/api/v1/contract-test/stats')).json();
  await modal.getByRole('button', { name: /^Skicka till testterminal/ }).click();
  await modal.getByRole('button', { name: 'Blippa och förlora svaret', exact: true }).click();
  await expect(modal.getByRole('heading', { name: 'Betalningssvaret behöver kontrolleras' })).toBeVisible({ timeout: 15000 });
  const payment = await latestPayment(page, tab.id);
  expect(payment.status).toBe('unknown');
  await page.reload();
  await page.getByRole('button', { name: 'Återuppta betalning', exact: true }).click();
  const resumed = page.getByRole('dialog', { name: 'Ta betalt', exact: true });
  await expect(resumed.getByRole('heading', { name: 'Betalningssvaret behöver kontrolleras' })).toBeVisible();
  await resumed.getByRole('button', { name: 'Återställ förbindelsen', exact: true }).click();
  await expect(resumed.getByRole('heading', { name: 'Betalningen är godkänd' })).toBeVisible({ timeout: 15000 });
  const after = await (await page.request.get('/api/v1/contract-test/stats')).json();
  expect(after.starts - stats.starts).toBe(1);
  expect((await latestPayment(page, tab.id)).id).toBe(payment.id);
});

test('avbrutet kortförsök frigör beloppet först efter kontroll och kan följas av ett nytt köp', async ({ page }) => {
  const { tab, modal } = await prepare(page);
  await modal.getByRole('button', { name: /^Skicka till testterminal/ }).click();
  await modal.getByRole('button', { name: 'Avbryt försöket', exact: true }).click();
  await expect(modal.getByText('Testbetalningen avbröts. Ingen betalning har registrerats.', { exact: true })).toBeVisible();
  expect((await latestPayment(page, tab.id)).status).toBe('cancelled');
  await modal.getByRole('button', { name: /^Skicka till testterminal/ }).click();
  await modal.getByRole('button', { name: 'Simulera blipp', exact: true }).click();
  await expect(modal.getByRole('heading', { name: 'Betalningen är godkänd' })).toBeVisible({ timeout: 15000 });
});

test('artikelretur på liten skärm går genom samma terminalkontroll', async ({ page }) => {
  const { tab, modal } = await prepare(page);
  await modal.getByRole('button', { name: /^Skicka till testterminal/ }).click();
  await modal.getByRole('button', { name: 'Simulera blipp', exact: true }).click();
  await expect(modal.getByRole('heading', { name: 'Betalningen är godkänd' })).toBeVisible({ timeout: 15000 });
  await modal.getByRole('button', { name: 'Klart', exact: true }).click();
  await page.goto('/#reports');
  await page.locator('.list-row').filter({ hasText: tab.label }).getByRole('button', { name: 'Retur', exact: true }).click();
  const refund = page.getByRole('dialog', { name: 'Gör en testretur', exact: true });
  await refund.getByLabel('Retursätt', { exact: true }).selectOption('items');
  await refund.getByRole('spinbutton', { name: /^Returantal/ }).fill('1');
  await refund.getByLabel('Orsak till returen', { exact: true }).fill('En artikel återlämnad i testet');
  await refund.getByRole('button', { name: 'Skicka retur till testterminal', exact: true }).click();
  await expect(refund.getByRole('heading', { name: 'Väntar på testkort för retur' })).toBeVisible();
  await refund.getByRole('button', { name: 'Simulera blipp', exact: true }).click();
  await expect(refund.getByRole('heading', { name: 'Returen är godkänd' })).toBeVisible({ timeout: 15000 });
  const result = await latestPayment(page, tab.id);
  expect(result.kind).toBe('refund');
  expect(result.allocations[0].quantity).toEqual({ numerator: '1', denominator: '1' });
});
