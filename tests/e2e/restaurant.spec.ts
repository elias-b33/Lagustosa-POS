import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AuditEntry, Bootstrap, Tab } from '../../shared/types';

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

test('en ny testomgång bevarar gamla försök utan att blanda dem med nya betalningar', async ({ browser }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lagustosa-round-browser-'));
  const reservation = createServer();
  await new Promise<void>(resolve => { reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Test port missing');
  const port = address.port;
  await new Promise<void>(resolve => { reservation.close(() => resolve()); });
  const cli = (action: string) => spawnSync(process.execPath, ['scripts/safe-test.mjs', action, '--root', root, '--port', String(port), '--no-browser'], { encoding: 'utf8', windowsHide: true, timeout: 35000 });
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}` });
  try {
    const started = cli('start'); expect(started.status, started.stdout + started.stderr).toBe(0);
    const page = await context.newPage(); await login(page);
    const oldRound: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
    const originalTab = await sentTab(page);
    await page.route(`**/api/v1/tabs/${originalTab.id}/payments`, route => route.abort('failed'));
    const modal = page.getByRole('dialog', { name: 'Ta betalt' });
    await modal.getByRole('button', { name: /^Simulera betalning/ }).click();
    await expect(modal.getByText('Betalningsförsöket är sparat på enheten', { exact: true })).toBeVisible();
    const stored = await page.evaluate(id => Object.entries(localStorage).filter(([key, value]) => key.startsWith('lagustosa.payment-attempts.v1:') && value.includes(id)), originalTab.id);
    expect(stored).toHaveLength(1);
    await modal.getByRole('button', { name: 'Stäng', exact: true }).click();
    const fresh = cli('new-session'); expect(fresh.status, fresh.stdout + fresh.stderr).toBe(0);
    await login(page);
    const freshRound: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
    expect(freshRound.testRoundId).not.toBe(oldRound.testRoundId);
    expect(freshRound.tabs).toEqual([]); expect(freshRound.payments).toEqual([]);
    await expect(page.locator('.recovery-banner')).toHaveCount(0);
    expect(await page.evaluate(keys => keys.map(key => [key, localStorage.getItem(key)]), stored.map(([key]) => key))).toEqual(stored);
    const newTab = await sentTab(page);
    const payment = page.getByRole('dialog', { name: 'Ta betalt' });
    await expect(payment.getByLabel('Dricks i kronor')).toBeEnabled();
    await payment.getByRole('button', { name: /^Simulera betalning/ }).click();
    await expect(payment.getByRole('heading', { name: 'Betalningen är godkänd' })).toBeVisible();
    const results: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
    expect(results.payments).toHaveLength(1); expect(results.payments[0].tabId).toBe(newTab.id); expect(results.receipts).toHaveLength(1);
    expect(await page.evaluate(keys => keys.map(key => [key, localStorage.getItem(key)]), stored.map(([key]) => key))).toEqual(stored);
  } finally {
    await context.close();
    const stopped = cli('stop'); expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
    if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(root).startsWith('lagustosa-round-browser-')) throw new Error('Invalid cleanup directory');
    await rm(root, { recursive: true, force: true });
  }
});

test('inloggningen har synlig startknapp på en mindre datorskärm och mobil', async ({ page }) => {
  await mkdir('artifacts', { recursive: true });
  await page.goto('/');
  await expect(page.getByLabel('Personal', { exact: true })).toBeVisible();
  await expect(page.getByText('SÄKER TESTMILJÖ', { exact: true })).toBeVisible();
  for (const design of ['cotto', 'professional', 'classic'] as const) {
    await page.getByLabel('Utseende', { exact: true }).selectOption(design);
    for (const [name, width, height] of [['compact', 1280, 720], ['phone', 390, 844], ['small-phone', 320, 812]] as const) {
      await page.setViewportSize({ width, height });
      await expect(page.getByRole('button', { name: 'Börja servicen', exact: true })).toBeInViewport();
      const startButton = await page.getByRole('button', { name: 'Börja servicen', exact: true }).boundingBox();
      expect(startButton && startButton.y >= 0 && startButton.y + startButton.height <= height, `${design} login ${name}: the entire start button must fit`).toBe(true);
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
  await add(page, 'Penne manzo e peperoncino');
  await page.getByRole('button', { name: /^Skicka till kök & bar/ }).click();
  await page.getByRole('button', { name: 'Kök', exact: true }).click();
  await expect(page.getByText('1 × Vitlöksbröd', { exact: true })).toBeVisible();
  await expect(page.getByText('1 × Penne manzo e peperoncino', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Bar', exact: true }).click();
  await expect(page.getByText('1 × Husets röda · glas', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Kassa', exact: true }).click();
  await page.getByRole('button', { name: 'Fram huvudrätt', exact: true }).click();
  await mkdir('artifacts', { recursive: true });
  const selectedTab = await page.getByLabel('Öppna notor', { exact: true }).inputValue();
  for (const design of ['classic', 'professional', 'cotto'] as const) {
    await page.getByLabel('Utseende', { exact: true }).selectOption(design);
    await expect(page.getByLabel('Öppna notor', { exact: true })).toHaveValue(selectedTab);
    await expect(page.locator('.order-line')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Ta betalt', exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `artifacts/lagustosa-${design}-order.png` });
  }
  await page.getByRole('button', { name: 'Ta betalt', exact: true }).click();
  const payment = page.getByRole('dialog', { name: 'Ta betalt' });
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await payment.getByRole('button', { name: 'Dela lika', exact: true }).click();
  await page.screenshot({ path: 'artifacts/lagustosa-cotto-payment.png' });
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
  await expect(payment.locator('.receipt-paper')).toContainText('194,50');
  await expect(payment.locator('.receipt-paper')).toContainText('Moms 12 %');
  await expect(payment.locator('.receipt-paper')).toContainText('Moms 25 %');
  await expect(payment.locator('.receipt-paper')).toContainText('Delbelopp · 1/2 ×');
  await expect(payment.locator('.receipt-paper')).toContainText('Antalet är en ekonomisk andel av artikelraden.');
  // Exercise the rendered typography contract across every loaded design and
  // the browser's print stylesheet. The production printer still needs its
  // own adapter/font validation; this checks the training preview only.
  for (const design of ['classic', 'professional', 'cotto'] as const) {
    await page.evaluate(value => { document.documentElement.dataset.design = value; }, design);
    for (const media of ['screen', 'print'] as const) {
      await page.emulateMedia({ media });
      const ratio = await payment.locator('.receipt-paper').evaluate(paper => {
        const markerSize = parseFloat(getComputedStyle(paper.querySelector('.receipt-type-marker')!).fontSize);
        const amountSize = Math.max(...Array.from(paper.querySelectorAll('.receipt-line strong, .receipt-line > span')).map(node => parseFloat(getComputedStyle(node).fontSize)));
        return markerSize / amountSize;
      });
      expect(ratio, `ÖVNING must be at least twice the amount size in ${design}/${media}`).toBeGreaterThanOrEqual(2);
    }
  }
  await page.emulateMedia({ media: 'screen' });
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
  expect(csv).toContain('389.00');
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
    await expect(b.locator('html')).toHaveAttribute('data-design', 'cotto');
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

test('alla utseenden fungerar på skrivbord, platta och mobil och valet sparas', async ({ page }) => {
  await login(page);
  await mkdir('artifacts', { recursive: true });
  for (const design of ['cotto', 'professional', 'classic'] as const) {
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

test('visar anslutna enheter och flyttar en väntande bong med kontrollerad återutskrift', async ({ page }) => {
  await login(page); const tab = await sentTab(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Stäng', exact: true }).click();
  await page.getByRole('navigation', { name: 'Huvudmeny' }).getByRole('button', { name: 'Inställningar', exact: true }).click();
  await page.getByRole('button', { name: 'Enheter', exact: true }).click();
  await expect(page.locator('.list-row')).toHaveCount(8);
  await expect(page.locator('.list-row').filter({ has: page.getByText('Huvudkassa · denna enhet', { exact: true }) })).toContainText('Skärm ansluten');
  await page.screenshot({ path: 'artifacts/lagustosa-device-status.png' });
  await page.getByRole('button', { name: 'Skrivare', exact: true }).click();
  await expect(page.locator('.list-row')).toHaveCount(3);
  await page.getByRole('button', { name: 'Redigera Köksskrivare', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Profilen är aktiv').uncheck();
  await page.getByRole('dialog').getByRole('button', { name: 'Spara skrivarprofil', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ny skrivarprofil', exact: true }).click();
  let modal = page.getByRole('dialog');
  await modal.getByLabel('Skrivarens namn').fill('Kök · ersättare');
  await modal.getByLabel('Utskriftstyp').selectOption('kitchen');
  await modal.getByLabel('Profilen är aktiv').check();
  await modal.getByRole('button', { name: 'Spara skrivarprofil', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/lagustosa-printer-profiles.png' });
  await page.getByRole('navigation', { name: 'Huvudmeny' }).getByRole('button', { name: 'Utskrifter', exact: true }).click();
  await page.locator('.list-row').filter({ has: page.getByText(`Köksbong · ${tab.label}`, { exact: true }) }).click();
  modal = page.getByRole('dialog', { name: 'Utskriftsförhandsvisning' });
  await expect(modal.getByRole('button', { name: 'Simulera utskrift', exact: true })).toBeDisabled();
  await modal.getByLabel('Orsak till byte av skrivare').fill('Tidigare skrivaren ersätts');
  await modal.getByRole('button', { name: 'Tilldela skrivare', exact: true }).click();
  await expect(modal.getByRole('button', { name: 'Simulera utskrift', exact: true })).toBeEnabled();
  await modal.getByLabel('Simulerat skrivarresultat').selectOption('uncertain');
  await modal.getByRole('button', { name: 'Simulera utskrift', exact: true }).click();
  await expect(modal.getByText('Kontrollera först om pappret kom ut.', { exact: true })).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Tilldela skrivare', exact: true })).toHaveCount(0);
  await modal.getByLabel('Vad visade kontrollen?').selectOption('failed');
  await modal.getByLabel('Anteckning om kontrollen').fill('Kontrollerat: inget papper kom ut');
  await modal.getByRole('button', { name: 'Spara kontrollerad status', exact: true }).click();
  await modal.getByLabel('Orsak till återutskrift').fill('Ny kopia efter kontrollerat avbrott');
  await modal.getByRole('button', { name: 'Skapa en märkt kopia', exact: true }).click();
  await expect(modal.locator('.print-paper')).toContainText('KOPIA');
  await modal.getByLabel('Simulerat skrivarresultat').selectOption('printed');
  await modal.getByRole('button', { name: 'Simulera utskrift', exact: true }).click();
  await expect(modal).toContainText('Utskriven');
  const data: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  const ticket = data.tickets.find(ticket => ticket.tabId === tab.id)!;
  const jobs = data.printJobs.filter(job => job.sourceId === ticket.id);
  expect(jobs).toHaveLength(2);
  expect(jobs.find(job => job.reprintOf)?.status).toBe('printed');
  expect(data.printers.find(printer => printer.id === jobs.find(job => job.reprintOf)?.printerId)?.name).toBe('Kök · ersättare');
});

test('handterminalens notaknapp bevarar menyposition och använder samma skicka/betala-flöde', async ({ page }) => {
  await login(page); const tab = await sentTab(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Stäng', exact: true }).click();
  for (const design of ['classic', 'professional', 'cotto'] as const) {
    await page.getByLabel('Utseende', { exact: true }).selectOption(design);
    for (const width of [320, 390, 600]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator('.product-card').filter({ has: page.getByText('Regina Margherita', { exact: true }) }).scrollIntoViewIfNeeded();
      const menuPosition = await page.evaluate(() => window.scrollY);
      expect(menuPosition).toBeGreaterThan(0);
      await expect(page.getByRole('button', { name: 'Visa nota', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (width === 390) await page.screenshot({ path: `artifacts/lagustosa-${design}-handheld.png` });
      await page.getByRole('button', { name: 'Visa nota', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Till menyn', exact: true })).toBeInViewport();
      await expect(page.getByLabel('Öppna notor', { exact: true })).toHaveValue(tab.id);
      await page.getByRole('button', { name: 'Till menyn', exact: true }).click();
      await expect.poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - menuPosition)).toBeLessThan(2);
      await page.getByRole('button', { name: 'Betala aktuell nota', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Ta betalt' })).toBeVisible();
      await expect(page.locator('.mobile-order-bar')).toBeHidden();
      await page.getByRole('dialog').getByRole('button', { name: 'Stäng', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Visa nota', exact: true })).toBeVisible();
    }
  }
  await add(page, 'Cola');
  await page.getByRole('button', { name: 'Skicka beställning', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Betala aktuell nota', exact: true })).toBeVisible();
  const data: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  expect(data.tabs.find(candidate => candidate.id === tab.id)?.lines).toHaveLength(2);
  expect(data.tickets.find(ticket => ticket.tabId === tab.id && ticket.station === 'bar')?.items[0].name).toBe('Cola');
});

test('huvudkassan registrerar insättning och uttag med orsak och stämmer av dagen utan differens', async ({ browser }) => {
  // Use a separate safe-test day so unfinished orders in other workflow tests
  // cannot hide or prevent this complete cash reconciliation.
  const root = await mkdtemp(path.join(tmpdir(), 'lagustosa-cash-browser-'));
  const reservation = createServer();
  await new Promise<void>(resolve => { reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Test port missing');
  const port = address.port;
  await new Promise<void>(resolve => { reservation.close(() => resolve()); });
  const cli = (action: string) => spawnSync(process.execPath, ['scripts/safe-test.mjs', action, '--root', root, '--port', String(port), '--no-browser'], { encoding: 'utf8', windowsHide: true, timeout: 35000 });
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}` });
  try {
    const started = cli('start'); expect(started.status, started.stdout + started.stderr).toBe(0);
    const page = await context.newPage(); await login(page);
    await page.getByRole('navigation', { name: 'Huvudmeny' }).getByRole('button', { name: 'Dagsöversikt', exact: true }).click();
    await page.getByRole('button', { name: 'Öppna dagen', exact: true }).click();
    const open = page.getByRole('dialog', { name: 'Öppna verksamhetsdagen' });
    await open.getByLabel('Växelkassa i kronor').fill('1500');
    await open.getByRole('button', { name: 'Öppna dagen', exact: true }).click();
    await expect(open).toHaveCount(0);
    const cashBalance = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Kontantavstämning', exact: true }) }).locator('.report-line').filter({ has: page.getByText('Förväntad kontantkassa', { exact: true }) });
    await expect(cashBalance).toContainText('1 500 kr');
    const cashKeys: string[] = [];
    await page.route('**/api/v1/cash-movements', async route => {
      cashKeys.push(route.request().postDataJSON().key);
      if (cashKeys.length === 1) {
        // Commit the deposit, then lose only its response. A reload must
        // recover that registration rather than adding the amount again.
        const response = await route.fetch(); expect(response.ok()).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    });
    for (const entry of [
      { direction: 'in', amount: '200', reason: 'Extra växel från kassaskåpet', expected: '1 700 kr' },
      { direction: 'out', amount: '50', reason: 'Kontanter åter till kassaskåpet', expected: '1 650 kr' },
    ]) {
      await page.getByRole('button', { name: 'Insättning eller uttag', exact: true }).click();
      const movement = page.getByRole('dialog', { name: 'Registrera kontanthändelse' });
      await movement.getByLabel('Händelse', { exact: true }).selectOption(entry.direction);
      await movement.getByLabel('Belopp i kronor', { exact: true }).fill(entry.amount);
      const submit = movement.getByRole('button', { name: 'Registrera kontanthändelse', exact: true });
      await expect(submit).toBeDisabled();
      await movement.getByLabel('Orsak', { exact: true }).fill(entry.reason);
      await submit.click();
      if (entry.direction === 'in') {
        await expect(movement.getByText('En kontanthändelse väntar på bekräftelse.', { exact: false })).toBeVisible();
        await expect(movement.getByRole('button', { name: 'Kontrollera samma kontanthändelse', exact: true })).toBeEnabled();
        await page.reload();
        await page.getByRole('navigation', { name: 'Huvudmeny' }).getByRole('button', { name: 'Dagsöversikt', exact: true }).click();
        await page.getByRole('button', { name: 'Insättning eller uttag', exact: true }).click();
        await expect(movement.getByLabel('Händelse', { exact: true })).toBeDisabled();
        await expect(movement.getByLabel('Händelse', { exact: true })).toHaveValue('in');
        await expect(movement.getByLabel('Belopp i kronor', { exact: true })).toBeDisabled();
        await expect(movement.getByLabel('Belopp i kronor', { exact: true })).toHaveValue('200');
        await expect(movement.getByLabel('Orsak', { exact: true })).toBeDisabled();
        await expect(movement.getByLabel('Orsak', { exact: true })).toHaveValue(entry.reason);
        await movement.getByRole('button', { name: 'Kontrollera samma kontanthändelse', exact: true }).click();
      }
      await expect(movement).toHaveCount(0);
      await expect(cashBalance).toContainText(entry.expected);
      if (entry.direction === 'in') {
        expect(cashKeys).toHaveLength(2);
        expect(cashKeys[1]).toBe(cashKeys[0]);
      }
    }
    expect(cashKeys).toHaveLength(3);
    expect(cashKeys[2]).not.toBe(cashKeys[0]);
    await expect(page.locator('.report-line').filter({ has: page.getByText('Kontantinsättningar', { exact: true }) })).toContainText('200 kr');
    await expect(page.locator('.report-line').filter({ has: page.getByText('Kontantuttag', { exact: true }) })).toContainText('50 kr');
    await page.getByRole('button', { name: 'Avsluta dagen', exact: true }).click();
    const close = page.getByRole('dialog', { name: 'Avsluta verksamhetsdagen' });
    await close.getByLabel('Räknad kontantkassa i kronor').fill('1650');
    await close.getByRole('button', { name: 'Bekräfta dagsavslut', exact: true }).click();
    await expect(close).toHaveCount(0);
    await expect(page.locator('.report-line').filter({ has: page.getByText('Differens', { exact: true }) })).toContainText('0 kr');
    await expect(page.getByRole('button', { name: 'Öppna dagen', exact: true })).toBeVisible();
    const closed: Bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
    expect(closed.currentDay).toBeNull();
    expect(closed.days.at(-1)?.report).toMatchObject({ expectedCashOre: 165000, differenceOre: 0, salesOre: 0 });
    const journal: { intact: boolean; entries: AuditEntry[] } = await (await page.request.get('/api/v1/journal')).json();
    expect(journal.intact).toBe(true);
    const movements = journal.entries.filter(entry => entry.action === 'cash.move');
    expect(movements).toHaveLength(2);
    expect(movements[0].details).toMatchObject({ direction: 'in', amountOre: 20000, reason: 'Extra växel från kassaskåpet' });
    expect(movements[1].details).toMatchObject({ direction: 'out', amountOre: 5000, reason: 'Kontanter åter till kassaskåpet' });
  } finally {
    await context.close();
    const stopped = cli('stop'); expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
    await rm(root, { recursive: true, force: true });
  }
});
