import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Bootstrap, MenuItem, Tab } from '../../shared/types';

async function start(page: Page) {
  await page.goto('/');
  await page.getByLabel('Personal', { exact: true }).selectOption('admin');
  await page.getByLabel('PIN-kod', { exact: true }).fill('1234');
  await page.getByText('Enhet och testprofiler', { exact: true }).click();
  await page.getByLabel('Enhetskod', { exact: true }).fill('LAGUSTOSA-TEST');
  await page.getByRole('button', { name: 'Börja servicen', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Huvudmeny' })).toBeVisible();
  const state: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  if (!state.currentDay) expect((await page.request.post('/api/v1/business-days', { data: { key: randomUUID(), floatOre: 0 } })).ok()).toBe(true);
  await page.goto('/#pos');
  return state;
}

async function createTab(page: Page): Promise<Tab> {
  const response = await page.request.post('/api/v1/tabs', { data: { key: randomUUID(), tableId: null, guestCount: 1, serviceMode: 'dine_in' } });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function command(page: Page, tab: Tab, body: Record<string, unknown>): Promise<Tab> {
  const response = await page.request.post(`/api/v1/tabs/${tab.id}/commands`, { data: { key: randomUUID(), version: tab.version, ...body } });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function saveMenu(page: Page, item: MenuItem) {
  const response = await page.request.put(`/api/v1/menu/${item.id}`, { data: item });
  expect(response.ok()).toBe(true);
}

test('en vald rätt följer med när en ny disknota öppnas och kräver fortfarande tillval', async ({ page }) => {
  await start(page);
  await page.getByLabel('Öppna notor', { exact: true }).selectOption('');
  await page.locator('.product-card').filter({ has: page.getByText('Antipasto della casa', { exact: true }) }).click();
  await page.getByRole('dialog', { name: 'Ny disknota', exact: true }).getByRole('button', { name: 'Öppna nota', exact: true }).click();
  const item = page.getByRole('dialog', { name: 'Antipasto della casa', exact: true });
  const add = item.getByRole('button', { name: /^Lägg till/ });
  await expect(item).toBeVisible();
  await expect(add).toBeDisabled();
  await item.getByRole('radio', { name: /^Medio/ }).check();
  await add.click();
  await expect(item).toHaveCount(0);
  const tabId = await page.getByLabel('Öppna notor', { exact: true }).inputValue();
  const tab: Tab = await (await page.request.get(`/api/v1/tabs/${tabId}`)).json();
  expect(tab.lines).toHaveLength(1);
  expect(tab.lines[0]).toMatchObject({ itemId: 'antipasto', unitPriceOre: 25500, modifiers: [{ id: 'medio' }] });
});

test('ett borttaget tillval kräver nytt val utan att tappa anteckningar eller antal', async ({ page }) => {
  const snapshot = await start(page);
  const original = snapshot.menu.find(item => item.id === 'antipasto')!;
  const tab = await createTab(page);
  await page.getByLabel('Öppna notor', { exact: true }).selectOption(tab.id);
  await page.locator('.product-card').filter({ has: page.getByText('Antipasto della casa', { exact: true }) }).click();
  const modal = page.getByRole('dialog', { name: 'Antipasto della casa', exact: true });
  await modal.getByRole('radio', { name: /^Piccolo/ }).check();
  await modal.getByLabel('Anteckning till kök eller bar').fill('Servera på två tallrikar');
  await modal.getByRole('button', { name: 'Öka antal', exact: true }).click();
  try {
    await saveMenu(page, { ...original, modifiers: original.modifiers.map(group => ({ ...group, options: group.options.filter(option => option.id !== 'piccolo') })) });
    await expect(modal.getByText(/Menyn har uppdaterats/)).toBeVisible();
    await expect(modal.getByRole('button', { name: /^Lägg till/ })).toBeDisabled();
    await expect(modal.getByRole('radio', { name: /^Piccolo/ })).toHaveCount(0);
    await modal.getByRole('radio', { name: /^Medio/ }).check();
    await expect(modal.getByLabel('Anteckning till kök eller bar')).toHaveValue('Servera på två tallrikar');
    await modal.getByRole('button', { name: /^Lägg till/ }).click();
    await expect(modal).toHaveCount(0);
    const updated: Tab = await (await page.request.get(`/api/v1/tabs/${tab.id}`)).json();
    expect(updated.lines).toHaveLength(1);
    expect(updated.lines[0]).toMatchObject({ quantity: 2, notes: 'Servera på två tallrikar', modifiers: [{ id: 'medio' }] });
  } finally { await saveMenu(page, original); }
});

test('makulerade rätter försvinner ur köksarbetet men finns kvar i historiken', async ({ page }) => {
  await start(page);
  let tab = await createTab(page);
  for (const input of [{ action: 'add', itemId: 'bread' }, { action: 'add', itemId: 'olives' }, { action: 'send' }]) tab = await command(page, tab, input);
  await page.getByRole('button', { name: 'Kök', exact: true }).click();
  const original = page.locator('.ticket:not(.cancel-ticket)').filter({ has: page.getByRole('heading', { name: tab.label, exact: true }) });
  await expect(original).toBeVisible();
  tab = await command(page, tab, { action: 'remove', lineId: tab.lines.find(line => line.itemId === 'bread')!.id, reason: 'Gästen ändrade sig' });
  await expect(original.locator('.ticket-line-void')).toContainText('Vitlöksbröd');
  await expect(original.getByText('Makulerad', { exact: true })).toBeVisible();
  await expect(original.getByRole('button')).toHaveCount(1);
  tab = await command(page, tab, { action: 'remove', lineId: tab.lines.find(line => line.itemId === 'olives')!.id, reason: 'Gästen ändrade sig' });
  await expect(original).toHaveCount(0);
  const cancels = page.locator('.cancel-ticket').filter({ has: page.getByRole('heading', { name: tab.label, exact: true }) });
  await expect(cancels).toHaveCount(2);
  await expect(cancels.first().getByRole('button')).toBeEnabled();
  await page.getByRole('button', { name: 'Visa historik', exact: true }).click();
  await expect(original).toBeVisible();
  await expect(original.locator('.ticket-line-void')).toHaveCount(2);
  await expect(original.getByRole('button')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/lagustosa-cotto-cancellation-history.png', fullPage: true });
});
