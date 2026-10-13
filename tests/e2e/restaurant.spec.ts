import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

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
  await page.getByRole('button', { name: 'Ta betalt', exact: true }).click();
  const payment = page.getByRole('dialog', { name: 'Ta betalt' });
  await payment.getByRole('button', { name: 'Dela lika', exact: true }).click();
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

test('gränssnittet fungerar på skrivbord, platta och mobil utan vågrät överrullning', async ({ page }) => {
  await login(page);
  await mkdir('artifacts', { recursive: true });
  for (const [name, width, height] of [['desktop', 1440, 1000], ['tablet', 1024, 768], ['phone', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.getByRole('heading', { name: 'Restaurangen', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/lagustosa-${name}.png`, fullPage: true });
  }
});
