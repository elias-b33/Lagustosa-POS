import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Bootstrap, Tab } from '../../shared/types';
import { calculateTab } from '../../shared/money';

async function openSplitPayment(page: Page) {
  await page.goto('/');
  await page.getByLabel('Personal', { exact: true }).selectOption('admin');
  await page.getByLabel('PIN-kod', { exact: true }).fill('1234');
  await page.getByText('Enhet och testprofiler', { exact: true }).click();
  await page.getByLabel('Enhetskod', { exact: true }).fill('LAGUSTOSA-TEST');
  await page.getByRole('button', { name: 'Börja servicen', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Huvudmeny' })).toBeVisible();

  const bootstrapResponse = await page.request.get('/api/v1/bootstrap');
  expect(bootstrapResponse.ok()).toBe(true);
  const snapshot: Bootstrap = await bootstrapResponse.json();
  if (!snapshot.currentDay) {
    const opened = await page.request.post('/api/v1/business-days', { data: { key: randomUUID(), floatOre: 0 } });
    expect(opened.ok()).toBe(true);
  }
  const created = await page.request.post('/api/v1/tabs', { data: { key: randomUUID(), tableId: null, guestCount: 2, serviceMode: 'dine_in' } });
  expect(created.ok()).toBe(true);
  let tab: Tab = await created.json();
  for (const command of [{ action: 'add', itemId: 'bread', quantity: 2, hold: false }, { action: 'send' }]) {
    const response = await page.request.post(`/api/v1/tabs/${tab.id}/commands`, { data: { key: randomUUID(), version: tab.version, ...command } });
    expect(response.ok()).toBe(true);
    tab = await response.json();
  }
  await page.goto('/#pos');
  await page.getByLabel('Öppna notor', { exact: true }).selectOption(tab.id);
  await page.getByRole('button', { name: 'Ta betalt', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Ta betalt', exact: true });
  await modal.getByRole('button', { name: 'Dela lika', exact: true }).click();
  await expect(modal.getByLabel('Antal delar som återstår', { exact: true })).toHaveValue('2');
  return { modal, tab, installmentOre: calculateTab(tab).grossOre / 2 };
}

test('varje Swish-delbetalning kräver en ny verifiering', async ({ page }) => {
  const { modal, tab, installmentOre } = await openSplitPayment(page);
  await modal.getByRole('button', { name: 'Swish', exact: true }).click();
  const verification = modal.getByRole('checkbox', { name: 'Jag har verifierat testbetalningen på företagets konto.', exact: true });
  const submit = modal.getByRole('button', { name: /^Simulera betalning/ });
  await expect(submit).toBeDisabled();
  await verification.check();
  await modal.getByLabel('Dricks i kronor', { exact: true }).fill('5');
  await submit.click();
  await expect(modal.getByRole('heading', { name: 'Betalningen är godkänd', exact: true })).toBeVisible();
  await modal.getByRole('button', { name: 'Nästa delbetalning', exact: true }).click();

  await expect(verification).not.toBeChecked();
  await expect(modal.getByLabel('Dricks i kronor', { exact: true })).toHaveValue('0');
  await expect(modal.getByLabel('Antal delar som återstår', { exact: true })).toHaveValue('1');
  await expect(submit).toBeDisabled();
  const afterFirst: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  expect(afterFirst.payments.filter(payment => payment.tabId === tab.id)).toHaveLength(1);

  await verification.check();
  await submit.click();
  await expect(modal.getByText('Notan är helt betald.', { exact: true })).toBeVisible();
  const complete: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  const payments = complete.payments.filter(payment => payment.tabId === tab.id);
  expect(payments).toHaveLength(2);
  expect(new Set(payments.map(payment => payment.key)).size).toBe(2);
  expect(payments.every(payment => payment.method === 'swish' && payment.status === 'approved' && payment.amountOre === installmentOre)).toBe(true);
  expect(payments.map(payment => payment.tipOre).sort((a, b) => a - b)).toEqual([0, 500]);
});

test('varje kontant delbetalning kräver ett nytt mottaget belopp', async ({ page }) => {
  const { modal, tab, installmentOre } = await openSplitPayment(page);
  await modal.getByRole('button', { name: 'Kontanter', exact: true }).click();
  const tendered = modal.getByLabel('Mottaget kontant i kronor', { exact: true });
  const submit = modal.getByRole('button', { name: /^Simulera betalning/ });
  const firstTenderedOre = installmentOre + 2000;
  const secondTenderedOre = installmentOre + 100;
  await expect(submit).toBeDisabled();
  await tendered.fill(String(firstTenderedOre / 100));
  await submit.click();
  await expect(modal.getByRole('heading', { name: 'Betalningen är godkänd', exact: true })).toBeVisible();
  await modal.getByRole('button', { name: 'Nästa delbetalning', exact: true }).click();

  await expect(tendered).toHaveValue('');
  await expect(submit).toBeDisabled();
  const afterFirst: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  expect(afterFirst.payments.filter(payment => payment.tabId === tab.id)).toHaveLength(1);
  await tendered.fill(String((installmentOre - 1) / 100));
  await expect(submit).toBeDisabled();
  await tendered.fill(String(secondTenderedOre / 100));
  await submit.click();
  await expect(modal.getByText('Notan är helt betald.', { exact: true })).toBeVisible();
  const complete: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  const payments = complete.payments.filter(payment => payment.tabId === tab.id);
  expect(payments).toHaveLength(2);
  expect(payments.every(payment => payment.method === 'cash' && payment.status === 'approved' && payment.amountOre === installmentOre)).toBe(true);
  expect(payments.map(payment => payment.tenderedOre).sort((a, b) => a! - b!)).toEqual([secondTenderedOre, firstTenderedOre]);
  expect(payments.map(payment => payment.changeOre).sort((a, b) => a - b)).toEqual([100, 2000]);
});
