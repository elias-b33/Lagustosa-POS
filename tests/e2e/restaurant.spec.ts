import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Bootstrap, Tab } from '../../shared/types';

test.describe.configure({ mode: 'serial' });
async function login(page: Page, staff = 'admin', pin = '1234', code = 'LAGUSTOSA-TEST') {
  await page.goto('/');
  await page.getByLabel('Personal', { exact: true }).selectOption(staff);
  await page.getByLabel('PIN-kod', { exact: true }).fill(pin);
  await page.getByText('Enhet och testprofiler', { exact: true }).click();
  await page.getByLabel('Enhetskod', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Börja servicen', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Huvudmeny' })).toBeVisible();
}
async function add(page: Page, name: string) {
  await page.locator('.product-card').filter({ has: page.getByText(name, { exact: true }) }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Lägg till/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function sentTab(page: Page): Promise<Tab> {
  const snapshot: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  if (!snapshot.currentDay) {
    expect((await page.request.post('/api/v1/business-days', { data: { key: randomUUID(), floatOre: 0 } })).ok()).toBe(true);
  }
  let tab: Tab = await (await page.request.post('/api/v1/tabs', { data: { key: randomUUID(), tableId: null, guestCount: 1, serviceMode: 'dine_in' } })).json();
  for (const input of [{ action: 'add', itemId: 'bread' }, { action: 'send' }]) {
    const response = await page.request.post(`/api/v1/tabs/${tab.id}/commands`, { data: { key: randomUUID(), version: tab.version, ...input } });
    expect(response.ok()).toBe(true); tab = await response.json();
  }
  await page.goto('/#pos');
  await page.getByLabel('Öppna notor', { exact: true }).selectOption(tab.id);
  await page.getByRole('button', { name: 'Ta betalt', exact: true }).click();
  return tab;
}

test('inloggningen har synlig startknapp på en mindre datorskärm och mobil', async ({ page }) => {
  await mkdir('artifacts', { recursive: true });
  await page.goto('/');
  await expect(page.getByLabel('Personal', { exact: true })).toBeVisible();
  for (const design of ['professional', 'classic'] as const) {
    await page.getByLabel('Utseende', { exact: true }).selectOption(design);
    for (const [name, width, height] of [['compact', 1280, 720], ['phone', 390, 844], ['small-phone', 320, 812]] as const) {
      await page.setViewportSize({ width, height });
      await expect(page.getByRole('button', { name: 'Börja servicen', exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${design} login ${name}`).toBe(true);
      await page.screenshot({ path: `artifacts/lagustosa-${design}-login-${name}.png` });
    }
  }
});

test('hel service: kök/bar, framkallning, osäkra svar, delad nota och dagsavslut', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await page.getByRole('button', { name: 'Dagsöversikt', exact: true }).click();
  await page.getByRole('button', { name: 'Öppna dagen', exact: true }).click();
  const open = page.getByRole('dialog', { name: 'Öppna verksamhetsdagen' });
  await open.getByLabel('Växelkassa i kronor').fill('1500');
  await open.getByRole('button', { name: 'Öppna dagen', exact: true }).click();
  await expect(open).toHaveCount(0);
  await page.getByRole('button', { name: 'Bord', exact: true }).click();
  await page.getByRole('button', { name: /^Bord 01 / }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Öppna nota', exact: true }).click();
  await add(page, 'Vitlöksbröd');
  await page.getByRole('button', { name: 'Gäst 2', exact: true }).click();
  await add(page, 'Husets röda · glas');
  await page.getByRole('button', { name: 'Gäst 1', exact: true }).click();
  await add(page, 'Penne Manzo');
  await page.getByRole('button', { name: /^Skicka till kök & bar/ }).click();
  await page.getByRole('button', { name: 'Kök', exact: true }).click();
  await expect(page.getByText('1 × Vitlöksbröd', { exact: true })).toBeVisible();
  await expect(page.getByText('1 × Penne Manzo', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Bar', exact: true }).click();
  await expect(page.getByText('1 × Husets röda · glas', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Kassa', exact: true }).click();
  await page.getByRole('button', { name: 'Fram huvudrätt', exact: true }).click();
  await mkdir('artifacts', { recursive: true });
  const selectedTab = await page.getByLabel('Öppna notor', { exact: true }).inputValue();
  for (const design of ['classic', 'professional'] as const) {
    await page.getByLabel('Utseende', { exact: true }).selectOption(design);
    await expect(page.getByLabel('Öppna notor', { exact: true })).toHaveValue(selectedTab);
    await expect(page.locator('.order-line')).toHaveCount(3);
    await page.screenshot({ path: `artifacts/lagustosa-${design}-order.png` });
  }
  await page.getByRole('button', { name: 'Ta betalt', exact: true }).click();
  const payment = page.getByRole('dialog', { name: 'Ta betalt' });
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await payment.getByRole('button', { name: 'Dela lika', exact: true }).click();
  await page.screenshot({ path: 'artifacts/lagustosa-professional-payment.png' });
  await payment.getByText('Välj testscenario', { exact: true }).click();
  await payment.getByLabel('Betalningens resultat').selectOption('declined');
  await payment.getByRole('button', { name: /^Simulera betalning/ }).click();
  await expect(payment.getByText('Testbetalningen nekades.', { exact: false })).toBeVisible();
  await payment.getByLabel('Betalningens resultat').selectOption('unknown');
  await payment.getByLabel('Förlorat svar från kontrollenhet').check();
  await payment.getByRole('button', { name: /^Simulera betalning/ }).click();
  await expect(payment.getByText(/Osäker betalning/)).toBeVisible();
  await payment.getByRole('button', { name: 'Kontrollera', exact: true }).click();
  await expect(payment.getByRole('heading', { name: 'Betalningen är godkänd' })).toBeVisible();
  await expect(payment.getByText(/Kontrollkodens svar är osäkert/)).toBeVisible();
  await payment.getByRole('button', { name: 'Kontrollera', exact: true }).click();
  await expect(payment.getByRole('button', { name: 'Visa testkvitto', exact: true })).toBeEnabled();
  await payment.getByRole('button', { name: 'Nästa delbetalning', exact: true }).click();
  await payment.getByText('Välj testscenario', { exact: true }).click();
  await payment.getByLabel('Betalningens resultat').selectOption('approved');
  await payment.getByRole('button', { name: /^Simulera betalning/ }).click();
  await expect(payment.getByText('Notan är helt betald.', { exact: false })).toBeVisible();
  await payment.getByRole('button', { name: 'Kontrollera', exact: true }).click();
  await payment.getByRole('button', { name: 'Visa testkvitto', exact: true }).click();
  await expect(payment.locator('.receipt-paper')).toContainText('189,50');
  await payment.getByRole('button', { name: 'Klart', exact: true }).click();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  await page.getByRole('button', { name: 'Dagsöversikt', exact: true }).click();
  await page.getByRole('button', { name: 'Avsluta dagen', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Bekräfta dagsavslut', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Öppna dagen', exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Hämta CSV', exact: true }).click();
  const download = await downloadPromise;
  const csv = await readFile((await download.path())!, 'utf8');
  expect(csv).toContain('TEST — inga riktiga betalningar');
  expect(csv).toContain('379.00');
  expect(errors).toEqual([]);
});

test('två servitörer kan lägga beställningar på samma bord utan förlust', async ({ browser, request }) => {
  await request.post('/api/v1/auth/login', { data: { staffId: 'admin', pin: '1234', deviceCode: 'LAGUSTOSA-TEST' } });
  const day = await request.post('/api/v1/business-days', { data: { key: randomUUID(), floatOre: 0 } });
  expect(day.ok()).toBe(true);
  const created = await request.post('/api/v1/tabs', { data: { key: randomUUID(), tableId: 'table-2', guestCount: 2, serviceMode: 'dine_in' } });
  expect(created.ok()).toBe(true);
  const first = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const second = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const a = await first.newPage(); const b = await second.newPage();
    await Promise.all([login(a, 'waiter', '3456', 'SERVERING-1'), login(b, 'waiter', '3456', 'SERVERING-2')]);
    await a.getByLabel('Utseende', { exact: true }).selectOption('classic');
    await expect(a.locator('html')).toHaveAttribute('data-design', 'classic');
    await expect(b.locator('html')).toHaveAttribute('data-design', 'professional');
    await Promise.all([a.getByRole('button', { name: /^Bord 02 / }).click(), b.getByRole('button', { name: /^Bord 02 / }).click()]);
    await Promise.all([
      a.locator('.product-card').filter({ has: a.getByText('Vitlöksbröd', { exact: true }) }).click(),
      b.locator('.product-card').filter({ has: b.getByText('Cola', { exact: true }) }).click(),
    ]);
    await Promise.all([a.getByRole('dialog').getByRole('button', { name: /^Lägg till/ }).click(), b.getByRole('dialog').getByRole('button', { name: /^Lägg till/ }).click()]);
    for (const page of [a, b]) {
      await expect(page.locator('.order-line')).toHaveCount(2);
      await expect(page.locator('.order-lines')).toContainText('Vitlöksbröd');
      await expect(page.locator('.order-lines')).toContainText('Cola');
    }
  } finally { await first.close(); await second.close(); }
});

test('båda utseendena fungerar på skrivbord, platta och mobil och valet sparas', async ({ page }) => {
  await login(page);
  await mkdir('artifacts', { recursive: true });
  for (const design of ['professional', 'classic'] as const) {
    await page.getByLabel('Utseende', { exact: true }).selectOption(design);
    await page.reload();
    await expect(page.getByLabel('Utseende', { exact: true })).toHaveValue(design);
    for (const [name, width, height] of [['desktop', 1440, 1000], ['tablet', 1024, 768], ['portrait', 768, 1024], ['phone', 390, 844], ['small-phone', 320, 812]] as const) {
      await page.setViewportSize({ width, height });
      await expect(page.getByRole('heading', { name: 'Restaurangen', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${design} ${name}`).toBe(true);
      await page.screenshot({ path: `artifacts/lagustosa-${design}-${name}.png`, fullPage: true });
    }
    for (const [name, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      for (const [id, label] of [['pos', 'Kassa'], ['kitchen', 'Kök'], ['bar', 'Bar'], ['prints', 'Utskrifter'], ['reports', 'Dagsöversikt'], ['admin', 'Inställningar']] as const) {
        await page.getByRole('navigation', { name: 'Huvudmeny' }).getByRole('button', { name: label, exact: true }).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${design} ${name} ${id}`).toBe(true);
        await page.screenshot({ path: `artifacts/lagustosa-${design}-${id}-${name}.png`, fullPage: true });
      }
    }
    await page.getByRole('navigation', { name: 'Huvudmeny' }).getByRole('button', { name: 'Bord', exact: true }).click();
  }
});

test('återupptar samma osända betalning efter omladdning och tillåter inte ändrat belopp', async ({ page }) => {
  await login(page);
  await page.getByLabel('Utseende', { exact: true }).selectOption('classic');
  const tab = await sentTab(page);
  const keys: string[] = [];
  await page.route(`**/api/v1/tabs/${tab.id}/payments`, async route => {
    keys.push(route.request().postDataJSON().key);
    if (keys.length === 1) await route.abort('failed'); else await route.continue();
  });
  let modal = page.getByRole('dialog', { name: 'Ta betalt' });
  await modal.getByLabel('Dricks i kronor').fill('12');
  await modal.getByRole('button', { name: /^Simulera betalning/ }).click();
  await expect(modal.getByText('Betalningsförsöket är sparat på enheten', { exact: true })).toBeVisible();
  await expect(modal.getByLabel('Dricks i kronor')).toBeDisabled();
  await expect(modal.getByRole('button', { name: 'Återuppta samma betalningsförsök', exact: true })).toBeEnabled();
  await modal.getByRole('button', { name: 'Stäng', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Återuppta betalning', exact: true }).click();
  modal = page.getByRole('dialog', { name: 'Ta betalt' });
  await modal.getByRole('button', { name: 'Återuppta samma betalningsförsök', exact: true }).click();
  await expect(modal.getByRole('heading', { name: 'Betalningen är godkänd' })).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
  const data: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  const payments = data.payments.filter(payment => payment.tabId === tab.id);
  expect(payments).toHaveLength(1); expect(payments[0].tipOre).toBe(1200);
  expect(data.receipts.filter(receipt => receipt.tab.id === tab.id)).toHaveLength(1);
  await expect(page.locator('.recovery-banner')).toHaveCount(0);
});

test('hittar redan godkänd betalning efter förlorat svar utan en ny betalningsbegäran', async ({ page }) => {
  await login(page); const tab = await sentTab(page);
  let blockRefresh = false; let paymentRequests = 0;
  await page.route('**/api/v1/bootstrap', route => blockRefresh ? route.abort('failed') : route.continue());
  await page.route(`**/api/v1/tabs/${tab.id}/payments`, async route => {
    paymentRequests++; blockRefresh = true;
    const response = await route.fetch(); expect(response.ok()).toBe(true);
    await route.abort('failed');
  });
  const modal = page.getByRole('dialog', { name: 'Ta betalt' });
  await modal.getByRole('button', { name: /^Simulera betalning/ }).click();
  await expect(modal.getByText('Betalningsförsöket är sparat på enheten', { exact: true })).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Återuppta samma betalningsförsök', exact: true })).toBeEnabled();
  const registered: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  expect(registered.tabs.find(candidate => candidate.id === tab.id)?.status).toBe('paid');
  blockRefresh = false; await page.reload();
  await page.getByRole('button', { name: 'Återuppta betalning', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Betalningen är godkänd' })).toBeVisible();
  expect(paymentRequests).toBe(1);
  const recovered: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  expect(recovered.payments.filter(payment => payment.tabId === tab.id)).toHaveLength(1);
  expect(recovered.receipts.filter(receipt => receipt.tab.id === tab.id)).toHaveLength(1);
  await expect(page.locator('.recovery-banner')).toHaveCount(0);
});

test('återhämtar en godkänd retur efter förlorat svar utan dubbel återbetalning', async ({ page }) => {
  await login(page); const tab = await sentTab(page);
  await page.getByRole('dialog', { name: 'Ta betalt' }).getByRole('button', { name: /^Simulera betalning/ }).click();
  await expect(page.getByRole('heading', { name: 'Betalningen är godkänd' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Klart', exact: true }).click();
  const before: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  const original = before.payments.find(payment => payment.tabId === tab.id && payment.kind === 'sale')!;
  await page.getByRole('button', { name: 'Dagsöversikt', exact: true }).click();
  await page.locator('.list-row').filter({ has: page.getByRole('button', { name: new RegExp(tab.label) }) }).getByRole('button', { name: 'Retur', exact: true }).click();
  let blockRefresh = false; let refundRequests = 0;
  await page.route('**/api/v1/bootstrap', route => blockRefresh ? route.abort('failed') : route.continue());
  await page.route(`**/api/v1/payments/${original.id}/refunds`, async route => {
    refundRequests++; blockRefresh = true;
    const response = await route.fetch(); expect(response.ok()).toBe(true);
    await route.abort('failed');
  });
  const modal = page.getByRole('dialog', { name: 'Gör en testretur' });
  await modal.getByLabel('Orsak till returen').fill('Övning: fel rätt serverad');
  await modal.getByRole('button', { name: 'Simulera retur', exact: true }).click();
  await expect(modal.getByText('Returförsöket är sparat på enheten', { exact: true })).toBeVisible();
  await expect(modal.getByLabel('Returbelopp i kronor')).toBeDisabled();
  await expect(modal.getByRole('button', { name: 'Återuppta samma returförsök', exact: true })).toBeEnabled();
  blockRefresh = false; await page.reload();
  await page.getByRole('button', { name: 'Återuppta retur', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Returen är godkänd' })).toBeVisible();
  expect(refundRequests).toBe(1);
  const recovered: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  expect(recovered.payments.filter(payment => payment.parentId === original.id)).toHaveLength(1);
  expect(recovered.receipts.filter(receipt => receipt.payment.parentId === original.id)).toHaveLength(1);
  expect(recovered.receipts.find(receipt => receipt.paymentId === original.id)).toBeDefined();
  await expect(page.locator('.recovery-banner')).toHaveCount(0);
});
