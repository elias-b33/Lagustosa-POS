import { describe, expect, it } from 'vitest';
import type { BusinessDay, MenuItem, PrintJob } from '../shared/types';
import { calculateTab } from '../shared/money';
import { closingText } from '../server/printing';
import { exportCsv } from '../server/export';
import { fixture, key } from './helpers';

describe('Spårbara rapporter för övningsläget', () => {
  it('låser identitet, summering och löpnummer vid avslut även när senare dagar får returer', async () => {
    const f = fixture(); const first = f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const sale = await f.pay(tab.id);
    const closeInput = { key: key(), countedCashOre: 150000 };
    const closed = f.service.closeDay(f.admin, first.id, closeInput);
    const frozen = structuredClone(closed.report!);
    expect(frozen.training).toMatchObject({ kind: 'Z', sequence: 1, generatedAt: closed.closedAt, cumulativeSalesOre: sale.amountOre, cumulativeRefundsOre: 0 });
    expect(f.service.closeDay(f.admin, first.id, closeInput)).toEqual(closed);
    const changed = f.service.settings(); changed.company.name = 'Nytt namn'; changed.registerId = 'ANNAN-TESTKASSA';
    f.service.saveSettings(f.admin, changed);
    const second = f.open();
    await f.service.refund(f.admin, sale.id, { key: key(), amountOre: sale.amountOre, reason: 'Retur nästa dag', simulation: 'approved', fiscalSimulation: 'confirmed' });
    const secondClosed = f.service.closeDay(f.admin, second.id, { key: key(), countedCashOre: 150000 });
    expect(secondClosed.report?.training).toMatchObject({ sequence: 2, registerId: 'ANNAN-TESTKASSA', refundReceipts: 1, cumulativeSalesOre: sale.amountOre, cumulativeRefundsOre: sale.amountOre, cumulativeNetOre: 0 });
    expect(f.service.report(first.id)).toEqual(frozen);
    expect(f.service.takeReport(f.admin, first.id)).toEqual(frozen);
    expect(closingText(closed, f.service.report(first.id))).toContain('ÖVNING · Z-DAGRAPPORT #1');
    expect(closingText(closed, f.service.report(first.id))).not.toContain('Nytt namn');
    expect(f.store.journal().filter(entry => entry.action === 'day.close')).toHaveLength(2);
  });

  it('journalför uttryckliga X-uttag men inte automatiska översiktsuppdateringar', async () => {
    let now = new Date('2026-10-13T20:00:00Z');
    const f = fixture({ now: () => now }); const day = f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const before = f.store.journal().length;
    f.service.report(day.id); f.service.bootstrap(f.admin);
    expect(f.store.journal()).toHaveLength(before);
    const x = f.service.takeReport(f.admin, day.id);
    expect(x.training).toMatchObject({ kind: 'X', sequence: null, generatedAt: '2026-10-13T20:00:00.000Z', openTabAmountOre: calculateTab(f.service.tab(tab.id)).grossOre });
    await f.pay(tab.id); now = new Date('2026-10-13T20:15:00Z');
    const event = f.store.journal().find(entry => entry.action === 'report.x')!;
    expect(event.details).toMatchObject({ day: { id: day.id, status: 'open' }, report: { salesOre: 0, training: x.training } });
    expect(f.service.report(day.id).salesOre).toBeGreaterThan(0);
    expect(x.salesOre).toBe(0);
    expect(() => f.service.takeReport(f.actor('waiter', 'SERVERING-1'), day.id)).toThrow('behörighet');
  });

  it('räknar kopior på uttagsdagen och skiljer dagar med samma klockslag', async () => {
    const f = fixture(); const first = f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const payment = await f.pay(tab.id);
    f.service.drawer(f.admin, 'Första dagens låda');
    const original = f.store.all<PrintJob>('print').find(job => job.kind === 'guest')!;
    await f.service.print(f.admin, original.id, 'print', 'printed');
    const firstClosed = f.service.closeDay(f.admin, first.id, { key: key(), countedCashOre: 150000 });
    const second = f.open();
    await f.service.print(f.admin, original.id, 'reprint', undefined, 'Kopia nästa dag');
    f.service.drawer(f.admin, 'Andra dagens låda');
    f.service.drawer(f.admin, 'Ytterligare öppning');
    expect(f.service.report(second.id).training).toMatchObject({ trainingReceipts: 0, receiptCopies: 1, receiptCopiesOre: payment.amountOre, drawerOpenings: 2 });
    expect(firstClosed.report?.training).toMatchObject({ receiptCopies: 0, drawerOpenings: 1 });
    expect(f.service.report(first.id)).toEqual(firstClosed.report);
  });

  it('behåller artikelgrupp, summerar delbetalningar och skiljer moms och returer', async () => {
    const f = fixture(); const day = f.open(); const tab = f.tab();
    const originalBread = f.store.get<MenuItem>('menu', 'bread')!;
    f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 2 });
    f.command(tab.id, { action: 'add', itemId: 'redwine' });
    f.command(tab.id, { action: 'discount', discountBps: 1733, reason: 'Ojämn testfördelning' });
    f.command(tab.id, { action: 'send' });
    const totals = calculateTab(f.service.tab(tab.id));
    const first = await f.pay(tab.id, { amountOre: 7001 });
    const partial = f.service.report(day.id);
    expect(partial.training!.openTabAmountOre).toBe(totals.grossOre - 7001);
    expect(partial.training!.discountsOre).toBeLessThan(totals.discountOre);
    await f.pay(tab.id);
    f.service.saveMenu(f.admin, { ...originalBread, category: 'Ny kategori', name: 'Nytt artikelnamn' });
    await f.service.refund(f.admin, first.id, { key: key(), amountOre: 3001, reason: 'Delretur i övning', simulation: 'approved', fiscalSimulation: 'confirmed' });
    const report = f.service.report(day.id);
    expect(report.training!.categories.map(category => category.name)).toContain(originalBread.category);
    expect(report.training!.categories.map(category => category.name)).not.toContain('Ny kategori');
    expect(report.training!.categories.reduce((sum, category) => sum + category.salesOre, 0)).toBe(report.salesOre);
    expect(report.training).toMatchObject({ discountsOre: totals.discountOre, openTabAmountOre: 0, trainingReceipts: 3, refundReceipts: 1 });
    expect(report.vat.map(total => total.vatBps).sort()).toEqual([1200, 2500]);
    expect(report.vat.reduce((sum, total) => sum + total.grossOre, 0)).toBe(report.netOre);
    const closed = f.service.closeDay(f.admin, day.id, { key: key(), countedCashOre: 150000 });
    expect(closingText(closed, closed.report!)).toContain('12 %:');
    expect(closingText(closed, closed.report!)).toContain('25 %:');
    expect(exportCsv(closed, closed.report!)).toContain('Övningskvitton');
  });

  it('redovisar makulerade rader och prissänkningar utan att räkna rabatten två gånger', () => {
    const f = fixture(); const day = f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' });
    const line = f.service.tab(tab.id).lines[0];
    f.command(tab.id, { action: 'price', lineId: line.id, priceOre: 6000, reason: 'Test av lägre pris' });
    f.command(tab.id, { action: 'discount', discountBps: 1000, reason: 'Testar rabatt' });
    f.command(tab.id, { action: 'remove', lineId: line.id });
    expect(f.service.report(day.id).training).toMatchObject({ reductionsCount: 2, reductionsOre: line.unitPriceOre - 600, discountsOre: 0 });
  });

  it('kräver öppen dag för lådöppning och förbrukar inte avslutsnummer på en avvisad stängning', async () => {
    const f = fixture();
    expect(() => f.service.drawer(f.admin, 'Ingen dag är öppen')).toThrow('Öppna en verksamhetsdag');
    const day = f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    expect(() => f.service.closeDay(f.admin, day.id, { key: key(), countedCashOre: 150000 })).toThrow('öppna notor');
    await f.pay(tab.id);
    expect(f.service.closeDay(f.admin, day.id, { key: key(), countedCashOre: 150000 }).report?.training?.sequence).toBe(1);
    expect(() => f.service.drawer(f.admin, 'Dagen har stängts')).toThrow('Öppna en verksamhetsdag');
    expect(f.open().number).toBe(2);
  });

  it('bevarar äldre rapporter utan att hitta på saknade historiska räknare', () => {
    const f = fixture();
    const legacyReport = { dayId: 'legacy', salesOre: 12345, refundsOre: 0, netOre: 12345, tipsOre: 0, vatOre: 1323, receipts: 1, methods: [], vat: [], expectedCashOre: 0, differenceOre: 0, unresolved: 0, openTabs: 0 };
    const legacy: BusinessDay = { id: 'legacy', number: 1, date: '2026-10-01', status: 'closed', openedAt: '2026-10-01T10:00:00Z', closedAt: '2026-10-01T20:00:00Z', openedBy: 'admin', closedBy: 'admin', floatOre: 0, countedCashOre: 0, report: legacyReport };
    f.store.put('day', legacy);
    expect(f.service.report('legacy')).toEqual(legacyReport);
    expect(f.service.report('legacy').training).toBeUndefined();
  });

  it('exporterar sparad identitet och skyddar nya textfält från kalkylbladsformler', () => {
    const f = fixture();
    const settings = f.service.settings(); settings.company.name = ' =SUM(1,1)';
    f.service.saveSettings(f.admin, settings);
    const day = f.open();
    const report = f.service.takeReport(f.admin, day.id);
    report.training!.categories = [{ name: '@SUM(1,1)', salesOre: 123 }];
    const csv = exportCsv(day, report);
    expect(csv).toContain('"\' =SUM(1,1)"');
    expect(csv).toContain('"\'@SUM(1,1)"');
    expect(csv).toContain('"ÖVNING · X-DAGRAPPORT"');
  });
});
