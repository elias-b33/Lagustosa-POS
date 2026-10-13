import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { buildRegisterReports, trainingReportDetails } from '../server/reporting';
import type { RegisterReportInputs } from '../server/reporting';
import { initialSettings } from '../server/seed';
import type { Allocation, AuditEntry, BusinessDay, Payment, PrintJob, Receipt, Tab } from '../shared/types';
import type { RegisterReport } from '../shared/register-reports';
import { Store } from '../server/db';
import { KassaService } from '../server/service';
import { fixture, key } from './helpers';

const timestamp = '2026-10-13T17:00:00.000Z';
const quantity = (numerator: string | number, denominator: string | number = 1) => ({ numerator: String(numerator), denominator: String(denominator) });

function day(id = 'day-1', number = 1): BusinessDay {
  return { id, number, date: '2026-10-13', status: 'open', openedAt: timestamp, closedAt: null, openedBy: 'admin', closedBy: null, floatOre: 100000, countedCashOre: null, report: null };
}

function ledgerFixture() {
  const input: RegisterReportInputs = {
    day: day(), settings: structuredClone(initialSettings), generatedAt: timestamp, payments: [], receipts: [], tabs: [], journal: [], printJobs: [],
    registers: Array.from({ length: 5 }, (_, index) => ({ id: `REGISTER-${index + 1}`, deviceId: `device-${index + 1}`, createdAt: timestamp })),
  };
  const event = (action: string, entityId: string, details: unknown, at = timestamp) => {
    const entry: AuditEntry = { id: input.journal.length + 1, action, entityId, details: structuredClone(details), at, actor: 'admin', hash: 'test', previousHash: 'test' };
    input.journal.push(entry); return entry.id;
  };
  input.registers.forEach(register => event('register.enrolled', register.id, { register, registerId: register.id }));
  event('day.open', input.day.id, { day: input.day, registerId: 'REGISTER-1' });
  const sale = (id: string, registerId: string, amountOre: number, allocation: Partial<Allocation> = {}, options: {
    method?: Payment['method']; kind?: Payment['kind']; tipOre?: number; category?: string; itemKind?: 'goods' | 'services'; status?: Payment['status'];
    paymentDay?: BusinessDay; legacy?: boolean; fiscalStatus?: Receipt['fiscalStatus']; tab?: Tab;
  } = {}) => {
    const paymentDay = options.paymentDay ?? input.day;
    const tab: Tab = options.tab ?? {
      id: `tab-${id}`, dayId: paymentDay.id, number: input.tabs.length + 1, tableId: null, label: id, guestCount: 1, serviceMode: 'dine_in', status: 'paid',
      version: 1, discountBps: 0, discountReason: '', openedAt: timestamp, updatedAt: timestamp, openedBy: 'admin',
      lines: [{ id: `line-${id}`, itemId: `item-${id}`, name: id, quantity: 1, guest: 1, category: options.category ?? 'Mat', itemKind: options.itemKind ?? 'goods',
        unitPriceOre: amountOre, baseUnitOre: amountOre, vatBps: allocation.vatBps ?? 1200, course: 'main', station: 'kitchen', modifiers: [], notes: '', status: 'sent', createdAt: timestamp }],
    };
    const payment: Payment = {
      id, key: id, fingerprint: id, tabId: tab.id, dayId: paymentDay.id, kind: options.kind ?? 'sale', parentId: null,
      method: options.method ?? 'card', status: options.status ?? 'approved', amountOre, tipOre: options.tipOre ?? 0,
      allocations: [{ lineId: tab.lines[0].id, grossOre: amountOre, vatOre: 0, vatBps: 1200, quantity: quantity(1), quantityBasis: 'items', discountOre: 0, ...allocation }],
      tenderedOre: null, changeOre: 0, reason: 'Övning', simulation: 'approved', fiscalSimulation: 'confirmed', createdAt: timestamp, updatedAt: timestamp,
      staffId: 'admin', deviceId: options.legacy ? 'device-1' : input.registers.find(register => register.id === registerId)!.deviceId,
      ...(options.legacy ? {} : { registerId }),
    };
    const receipt: Receipt = {
      id: `receipt-${id}`, paymentId: id, dayId: paymentDay.id, number: input.receipts.length + 1, kind: payment.kind,
      createdAt: timestamp, fiscalStatus: options.fiscalStatus ?? 'confirmed', controlCode: null, originalReceiptId: null,
      payment: structuredClone(payment), tab: structuredClone(tab), company: structuredClone(input.settings.company), cashier: 'Admin', registerId,
    };
    input.payments.push(payment); input.tabs.push(tab);
    event('tab.create', tab.id, { tab: { ...tab, status: 'open' }, registerId: options.legacy ? null : registerId });
    event(payment.kind === 'sale' ? 'payment.start' : 'refund.start', id, { payment: { ...payment, status: 'pending' }, registerId: options.legacy ? null : registerId });
    if (payment.status === 'approved') { input.receipts.push(receipt); event('receipt.create', receipt.id, { receipt, registerId }); }
    event('payment.status', id, { payment, registerId: options.legacy ? null : registerId });
    return { payment, receipt, tab };
  };
  const build = (overrides: Partial<RegisterReportInputs> = {}) => buildRegisterReports({ ...input, ...overrides });
  return { input, event, sale, build };
}

const byRegister = (reports: RegisterReport[], id: number) => reports.find(report => report.registerId === `REGISTER-${id}`)!;

describe('Journalavgränsade rapporter per kassa', () => {
  it('räknar fem kassor med separata betalningsmedel, momssatser, varugrupper och träningstal', () => {
    const f = ledgerFixture();
    f.sale('cash', 'REGISTER-1', 11200, { vatOre: 1200, quantity: quantity(2), discountOre: 800 }, { method: 'cash', tipOre: 500 });
    const bar = f.sale('bar', 'REGISTER-2', 12500, { vatBps: 2500, vatOre: 2500 }, { category: 'Bar', itemKind: 'services' });
    f.sale('takeaway', 'REGISTER-3', 10600, { vatBps: 600, vatOre: 600, quantity: quantity(4) }, { method: 'swish' });
    f.sale('service', 'REGISTER-4', 20000, { vatBps: 2500, vatOre: 4000, quantity: quantity(2), discountOre: 2000 }, { category: 'Servering', itemKind: 'services' });
    f.sale('split', 'REGISTER-5', 5600, { vatOre: 600, quantity: quantity(1, 2), quantityBasis: 'amount-share', discountOre: 400 });
    f.sale('bar-return', 'REGISTER-2', 2500, { vatBps: 2500, vatOre: 500, quantity: quantity(1, 5), quantityBasis: 'amount-share' }, { kind: 'refund', category: 'Bar', itemKind: 'services', tab: bar.tab });
    f.event('cash.move', 'deposit', { dayId: f.input.day.id, direction: 'in', amountOre: 20000, registerId: 'REGISTER-1' });
    f.event('cash.move', 'withdrawal', { dayId: f.input.day.id, direction: 'out', amountOre: 5000, registerId: 'REGISTER-1' });
    f.event('drawer.open', 'drawer-1', { dayId: f.input.day.id, registerId: 'REGISTER-1' });
    f.event('drawer.open', 'drawer-2', { dayId: f.input.day.id, registerId: 'REGISTER-1' });
    f.event('print.reprint', 'copy', { kind: 'guest', receiptId: bar.receipt.id, dayId: f.input.day.id, registerId: 'REGISTER-2' });
    const result = f.build();
    expect(result).toHaveLength(5);
    expect(result.reduce((total, report) => total + report.training.salesOre, 0)).toBe(59900);
    expect(result.reduce((total, report) => total + report.training.refundsOre, 0)).toBe(2500);
    expect(byRegister(result, 1).training).toMatchObject({ salesOre: 11200, netOre: 11200, tipsOre: 500, floatOre: 100000, expectedCashOre: 126700, cashDepositsOre: 20000, cashWithdrawalsOre: 5000, drawerOpenings: 2, discountsOre: 800, articleCounts: { sold: quantity(2), goodsSold: quantity(2) } });
    expect(byRegister(result, 1).training.methods.find(total => total.method === 'cash')).toEqual({ method: 'cash', salesOre: 11200, refundsOre: 0, netOre: 11200, tipsOre: 500 });
    expect(byRegister(result, 2).training).toMatchObject({ salesOre: 12500, refundsOre: 2500, netOre: 10000, receiptCopies: 1, receiptCopiesOre: 12500, receiptCounts: { sales: 1, refunds: 1, total: 2 }, articleCounts: { sold: quantity(1), servicesSold: quantity(1), refunded: quantity(0), refundAmountShares: quantity(1, 5) } });
    expect(byRegister(result, 2).training.vat).toEqual([{ vatBps: 2500, salesGrossOre: 12500, salesVatOre: 2500, refundsGrossOre: 2500, refundsVatOre: 500, netGrossOre: 10000, netVatOre: 2000 }]);
    expect(byRegister(result, 2).training.categories).toMatchObject([{ name: 'Bar', salesOre: 12500, refundsOre: 2500, netOre: 10000 }]);
    expect(byRegister(result, 3).training.methods.find(total => total.method === 'swish')?.salesOre).toBe(10600);
    expect(byRegister(result, 3).training.vat[0]).toMatchObject({ vatBps: 600, salesGrossOre: 10600, salesVatOre: 600 });
    expect(byRegister(result, 4).training.articleCounts.servicesSold).toEqual(quantity(2));
    expect(byRegister(result, 5).training.articleCounts).toMatchObject({ sold: quantity(0), saleAmountShares: quantity(1, 2) });
    expect(byRegister(result, 5).coverage.issues).toEqual(['AMOUNT_SHARE_IS_NOT_PHYSICAL_QUANTITY']);
    expect(byRegister(result, 1).coverage.complete).toBe(true);
    for (const report of result) {
      expect(report.mode).toBe('training'); expect(report.kind).toBe('X'); expect(report.sequence).toBeNull();
      expect(report.real).toMatchObject({ salesOre: 0, refundsOre: 0, netOre: 0, tipsOre: 0, receiptCounts: { total: 0 }, vat: [], categories: [], discountsOre: 0, drawerOpenings: 0 });
      expect(report.cumulative.real).toEqual({ salesOre: 0, refundsOre: 0, netOre: 0 });
      expect(report.training.openTabs).toBe(0);
    }
  });

  it('fryser ett X-uttag efter journalnummer även när framtida belopp och klockslag pekar bakåt', () => {
    const f = ledgerFixture(); f.sale('old', 'REGISTER-1', 11200, { vatOre: 1200, discountOre: 1000 });
    const cutoff = f.input.journal.at(-1)!.id;
    const original = f.build({ throughJournalId: cutoff });
    const originalAggregate = trainingReportDetails({ ...f.input, throughJournalId: cutoff });
    const oldSettings = structuredClone(f.input.settings);
    f.input.settings.company.name = 'Nya företagsnamnet'; f.input.settings.registerId = 'NYTT-PREFIX';
    f.event('settings.save', 'settings', { previous: oldSettings, settings: f.input.settings, registerId: 'REGISTER-1' }, '2025-01-01T00:00:00Z');
    f.sale('future', 'REGISTER-1', 99900, { vatOre: 10704 });
    f.input.journal.slice(cutoff).forEach(entry => entry.at = '2025-01-01T00:00:00Z');
    const lateRegister = { id: 'REGISTER-6', deviceId: 'device-6', createdAt: '2020-01-01T00:00:00Z' };
    f.input.registers.push(lateRegister); f.event('register.enrolled', lateRegister.id, { register: lateRegister, registerId: lateRegister.id });
    f.input.tabs[0].lines[0].category = 'Ändrat i dagens meny';
    f.input.receipts[0].company.name = 'Muterad nutidsvy';
    expect(f.build({ throughJournalId: cutoff })).toEqual(original);
    expect(trainingReportDetails({ ...f.input, throughJournalId: cutoff })).toEqual(originalAggregate);
    expect(originalAggregate).toMatchObject({ cumulativeSalesOre: 11200, discountsOre: 1000, categories: [{ name: 'Mat', salesOre: 11200 }], company: oldSettings.company });
    expect(f.build()).toHaveLength(6);
    expect(byRegister(f.build(), 1).cumulative.training.salesOre).toBe(111100);
  });

  it('låser Z-snapshots och för returer nästa dag till returens kassa utan att minska tidigare försäljning eller försäljningsmoms', () => {
    const f = ledgerFixture(); const sale = f.sale('sale', 'REGISTER-2', 12500, { vatBps: 2500, vatOre: 2500 }, { category: 'Bar' });
    const firstDay = structuredClone(f.input.day);
    const first = f.build({ kind: 'Z', sequenceByRegisterId: Object.fromEntries(f.input.registers.map(register => [register.id, 1])) });
    const aggregate = trainingReportDetails(f.input);
    firstDay.status = 'closed'; firstDay.closedAt = timestamp;
    firstDay.report = { dayId: firstDay.id, salesOre: 12500, refundsOre: 0, netOre: 12500, tipsOre: 0, vatOre: 2500, receipts: 1, methods: [], vat: [], expectedCashOre: 100000, differenceOre: 0, unresolved: 0, openTabs: 0, registers: first, training: { ...aggregate, kind: 'Z', sequence: 1 } };
    f.event('day.close', firstDay.id, { day: firstDay, registerId: null });
    f.input.day = day('day-2', 2); f.event('day.open', f.input.day.id, { day: f.input.day, registerId: 'REGISTER-1' });
    f.sale('return', 'REGISTER-4', 12500, { vatBps: 2500, vatOre: 2500 }, { kind: 'refund', tab: sale.tab, category: 'Bar' });
    const second = f.build();
    expect(byRegister(second, 2).training).toMatchObject({ salesOre: 0, refundsOre: 0 });
    expect(byRegister(second, 2).cumulative.training).toEqual({ salesOre: 12500, refundsOre: 0, netOre: 12500 });
    expect(byRegister(second, 4).training).toMatchObject({ salesOre: 0, refundsOre: 12500, netOre: -12500, receiptCounts: { sales: 0, refunds: 1, total: 1 } });
    expect(byRegister(second, 4).training.vat).toEqual([{ vatBps: 2500, salesGrossOre: 0, salesVatOre: 0, refundsGrossOre: 12500, refundsVatOre: 2500, netGrossOre: -12500, netVatOre: -2500 }]);
    expect(f.build({ day: firstDay, generatedAt: '2099-01-01T00:00:00Z' })).toEqual(first);
    const returned = f.build({ day: firstDay }); returned[0].company.name = 'Försök att ändra sparad rapport';
    expect(firstDay.report.registers).toEqual(first);
    expect(trainingReportDetails({ ...f.input, day: firstDay })).toEqual(firstDay.report.training);
    expect(first.every(report => report.sequence === 1)).toBe(true);
  });

  it('räknar parkerade notor hos skapande kassa och skiljer borttag/prissänkning från rabatt', () => {
    const f = ledgerFixture();
    const source = f.sale('partial', 'REGISTER-2', 1400, { quantity: quantity(1, 6), quantityBasis: 'amount-share' });
    const open = structuredClone(source.tab); open.status = 'open'; open.lines[0].unitPriceOre = 8400;
    f.event('tab.create', open.id, { tab: open, registerId: 'REGISTER-3' });
    f.event('tab.edit', open.id, { tab: open, registerId: 'REGISTER-4' });
    const before = structuredClone(open), after = structuredClone(open); after.lines[0].unitPriceOre = 6400;
    f.event('tab.price', open.id, { before, tab: after, registerId: 'REGISTER-4' });
    const discounted = structuredClone(after); discounted.discountBps = 1000;
    f.event('tab.discount', open.id, { before: after, tab: discounted, registerId: 'REGISTER-4' });
    let reports = f.build();
    expect(byRegister(reports, 3).training).toMatchObject({ openTabs: 1, openTabAmountOre: 4360 });
    expect(byRegister(reports, 2).training.openTabs).toBe(0);
    expect(byRegister(reports, 4).training).toMatchObject({ reductionsCount: 1, reductionsOre: 2000, discountsOre: 0 });
    const voided = structuredClone(discounted); voided.lines[0].status = 'void'; voided.status = 'void';
    f.event('tab.remove', open.id, { before: discounted, tab: voided, registerId: 'REGISTER-5' });
    reports = f.build();
    expect(byRegister(reports, 3).training.openTabs).toBe(0);
    expect(byRegister(reports, 5).training).toMatchObject({ reductionsCount: 1, reductionsOre: 5760 });
  });

  it('återspelar returreservation och osäker fiskalstatus före och efter kontroll', () => {
    const f = ledgerFixture(); const sale = f.sale('paid', 'REGISTER-1', 11200, {}, { fiscalStatus: 'unknown' });
    const pending: Payment = { ...sale.payment, id: 'reserved-return', kind: 'refund', parentId: sale.payment.id, status: 'pending', registerId: 'REGISTER-3', deviceId: 'device-3' };
    f.input.payments.push(pending);
    const cutoff = f.event('refund.start', pending.id, { payment: pending, registerId: pending.registerId });
    expect(byRegister(f.build(), 1).training.unresolved).toBe(1);
    expect(byRegister(f.build(), 3).training.unresolved).toBe(1);
    expect(byRegister(f.build(), 1).grandTotals!.training.salesOre).toBe(11200);
    expect(byRegister(f.build(), 1).grandTotals!.coverage.issues).toContain('UNRESOLVED_RECEIPT_CONTROL');
    expect(byRegister(f.build(), 3).grandTotals!.training.returnsOre).toBe(0);
    f.event('fiscal.verify', sale.receipt.id, { status: 'confirmed', controlCode: 'ÖVNING', registerId: 'REGISTER-1' });
    f.event('payment.status', pending.id, { payment: { ...pending, status: 'cancelled' }, registerId: pending.registerId });
    expect(byRegister(f.build(), 1).training.unresolved).toBe(0);
    expect(byRegister(f.build(), 3).training.unresolved).toBe(0);
    expect(byRegister(f.build(), 1).grandTotals!.training.salesOre).toBe(11200);
    expect(byRegister(f.build(), 1).grandTotals!.coverage.complete).toBe(true);
    expect(byRegister(f.build({ throughJournalId: cutoff }), 1).training.unresolved).toBe(1);
    expect(byRegister(f.build({ throughJournalId: cutoff }), 3).training.unresolved).toBe(1);
  });

  it('märker historiskt gemensamt kassa-ID och saknade antal utan att omfördela eller gissa', () => {
    const f = ledgerFixture();
    const old = f.sale('legacy', 'GEMENSAM-GAMMAL-KASSA', 7900, { quantity: undefined, quantityBasis: undefined, discountOre: undefined }, { legacy: true });
    delete old.receipt.tab.lines[0].itemKind;
    const result = f.build();
    const legacy = result.find(report => report.scope === 'legacy')!;
    expect(legacy).toMatchObject({ registerId: null, legacyRegisterId: 'GEMENSAM-GAMMAL-KASSA', sequence: null, training: { salesOre: 7900, articleCounts: { sold: quantity(0), missingSaleAllocations: 1 } } });
    expect(legacy.coverage.issues).toEqual(['LEGACY_REGISTER_SCOPE', 'MISSING_DISCOUNT_ALLOCATION', 'MISSING_QUANTITY']);
    expect(byRegister(result, 1).training.salesOre).toBe(0);
    expect(byRegister(result, 1).cumulative.training.salesOre).toBe(0);
    const orphan = { ...old.payment, id: 'not-in-journal' }; f.input.payments.push(orphan);
    const unknown = f.build().find(report => report.scope === 'legacy' && report.legacyRegisterId === null)!;
    expect(unknown.training.salesOre).toBe(0);
    expect(unknown.coverage.issues).toContain('PAYMENT_WITHOUT_JOURNAL_SNAPSHOT');
  });

  it('summerar exakta rationella antal och skiljer okänd varu-/tjänstklassificering från noll', () => {
    const f = ledgerFixture();
    f.sale('third-1', 'REGISTER-1', 1, { quantity: quantity(1, 3), quantityBasis: 'amount-share' });
    f.sale('third-2', 'REGISTER-1', 1, { quantity: quantity(1, 3), quantityBasis: 'amount-share' });
    f.sale('third-3', 'REGISTER-1', 1, { quantity: quantity(1, 3), quantityBasis: 'amount-share' });
    const unknown = f.sale('unknown-kind', 'REGISTER-2', 100);
    for (const entry of f.input.journal) {
      const details = entry.details as { receipt?: Receipt };
      if (details.receipt?.id === unknown.receipt.id) delete details.receipt.tab.lines[0].itemKind;
    }
    const reports = f.build();
    expect(byRegister(reports, 1).training.articleCounts).toMatchObject({ sold: quantity(0), saleAmountShares: quantity(1) });
    expect(byRegister(reports, 2).training.articleCounts).toMatchObject({ sold: quantity(1), goodsSold: quantity(0), servicesSold: quantity(0), unclassifiedSold: quantity(1) });
    expect(byRegister(reports, 2).coverage.issues).toContain('MISSING_GOODS_SERVICE_CLASSIFICATION');
  });

  it('behåller antal och sparad rabatt för helt rabatterade artiklar utan att hitta på en intäkt', () => {
    const f = ledgerFixture();
    const sale = f.sale('free', 'REGISTER-1', 0, { quantity: quantity(2), discountOre: 10000 });
    for (const entry of f.input.journal) {
      const details = entry.details as { receipt?: Receipt; tab?: Tab };
      const tab = details.receipt?.id === sale.receipt.id ? details.receipt.tab : details.tab?.id === sale.tab.id ? details.tab : undefined;
      if (tab) { tab.lines[0].quantity = 2; tab.lines[0].baseUnitOre = 5000; tab.lines[0].unitPriceOre = 5000; tab.discountBps = 10000; }
    }
    const report = byRegister(f.build(), 1);
    expect(report.training).toMatchObject({ salesOre: 0, discountsOre: 10000, receiptCounts: { sales: 1, refunds: 0, total: 1 }, articleCounts: { sold: quantity(2), goodsSold: quantity(2) } });
    expect(report.cumulative.training).toEqual({ salesOre: 0, refundsOre: 0, netOre: 0 });
    expect(trainingReportDetails(f.input)).toMatchObject({ discountsOre: 10000, trainingReceipts: 1, cumulativeSalesOre: 0 });
  });

  it('levererar samma separata försäljnings- och returbelopp genom tjänstens sparade X/Z-flöde', async () => {
    const f = fixture(); const opened = f.open();
    const actors = [f.admin, ...Array.from({ length: 4 }, (_, index) => f.actor('cashier', `SERVERING-${index + 1}`))];
    const paymentIds: string[] = [];
    for (let index = 0; index < actors.length; index++) {
      const actor = actors[index];
      const tab = f.service.createTab(actor, { key: key(), tableId: null, guestCount: 1, serviceMode: 'dine_in' });
      f.command(tab.id, { action: 'add', itemId: 'bread', quantity: index + 1 }, actor);
      f.command(tab.id, { action: 'send' }, actor);
      const payment = await f.pay(tab.id, {}, actor); paymentIds.push(payment.id);
    }
    const x = f.service.takeReport(f.admin, opened.id);
    expect(x.registers).toHaveLength(5);
    const amounts = x.registers!.map(report => report.training.salesOre).sort((a, b) => a - b);
    expect(amounts).toEqual([7900, 15800, 23700, 31600, 39500]);
    expect(x.registers!.reduce((total, report) => total + report.training.salesOre, 0)).toBe(118500);
    expect(x.registers!.reduce((total, report) => total + report.grandTotals!.training.salesOre, 0)).toBe(118500);
    expect(x.registers!.every(report => report.grandTotals!.training.saleReceipts === 1 && report.grandTotals!.coverage.complete)).toBe(true);
    expect(x.registers!.every(report => report.training.articleCounts.missingSaleAllocations === 0)).toBe(true);
    const z = f.service.closeDay(f.admin, opened.id, { key: key(), countedCashOre: 150000 });
    const frozen = structuredClone(z.report!);
    expect(z.report!.registers!.every(report => report.kind === 'Z' && report.sequence === 1)).toBe(true);
    const next = f.open();
    await f.service.refund(actors[4], paymentIds[1], { key: key(), amountOre: 7900, reason: 'Retur från föregående dag', simulation: 'approved', fiscalSimulation: 'confirmed' });
    const latest = f.service.report(next.id);
    expect(latest.registers!.reduce((total, report) => total + report.training.refundsOre, 0)).toBe(7900);
    expect(latest.registers!.find(report => report.deviceId === actors[4].device.id)?.training.refundsOre).toBe(7900);
    expect(latest.registers!.find(report => report.deviceId === actors[4].device.id)?.grandTotals!.training).toEqual({ salesOre: 39500, returnsOre: 7900, netOre: 31600, saleReceipts: 1, returnReceipts: 1 });
    expect(latest.registers!.find(report => report.deviceId === actors[1].device.id)?.training.refundsOre).toBe(0);
    expect(f.service.report(opened.id)).toEqual(frozen);
    expect(f.store.journal().filter(entry => entry.action === 'report.register_x')).toHaveLength(5);
    expect(f.store.journal().filter(entry => entry.action === 'report.register_z')).toHaveLength(5);
  });
});

describe('Separat grand-total-modell för registrerade övningskvitton', () => {
  it('tar med efterhandsprisnedsättning på returkvitto men inte öppen notas rättningar, rabatt, dricks, växel eller kopia igen', async () => {
    const f = fixture(); const day = f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' });
    const firstLineId = f.service.tab(tab.id).lines[0].id;
    f.command(tab.id, { action: 'price', lineId: firstLineId, priceOre: 10000, reason: 'Fast testpris' });
    f.command(tab.id, { action: 'add', itemId: 'bread' });
    f.command(tab.id, { action: 'remove', lineId: f.service.tab(tab.id).lines[1].id });
    f.command(tab.id, { action: 'price', lineId: firstLineId, priceOre: 8000, reason: 'Rättelse innan kvittot avslutas' });
    f.command(tab.id, { action: 'discount', discountBps: 1000, reason: 'Rabatt innan kvittot avslutas' });
    f.command(tab.id, { action: 'send' });
    const before = f.service.report(day.id).registers!.find(report => report.deviceId === 'main')!;
    expect(before.grandTotals!.training).toEqual({ salesOre: 0, returnsOre: 0, netOre: 0, saleReceipts: 0, returnReceipts: 0 });
    const payment = await f.pay(tab.id, { method: 'cash', tipOre: 300, tenderedOre: 10000 });
    expect(payment.amountOre).toBe(7200); expect(payment.changeOre).toBe(2500);
    const original = f.store.all<PrintJob>('print').find(job => job.kind === 'guest')!;
    await f.service.print(f.admin, original.id, 'print', 'printed');
    await f.service.print(f.admin, original.id, 'reprint', undefined, 'En kundkopia');
    f.service.drawer(f.admin, 'Räkna växelkassa');
    await f.service.refund(f.admin, payment.id, { key: key(), amountOre: 1440, reason: 'Prisnedsättning efter avslutat köp', simulation: 'approved', fiscalSimulation: 'confirmed' });
    const report = f.service.report(day.id).registers!.find(report => report.deviceId === 'main')!;
    expect(report.grandTotals).toEqual({ basis: 'registered-receipts-v1', training: { salesOre: 7200, returnsOre: 1440, netOre: 5760, saleReceipts: 1, returnReceipts: 1 }, real: { salesOre: 0, returnsOre: 0, netOre: 0, saleReceipts: 0, returnReceipts: 0 }, coverage: { complete: true, issues: [] } });
    expect(report.training).toMatchObject({ discountsOre: 800, reductionsCount: 2, reductionsOre: 9900, receiptCopies: 1, tipsOre: 300, drawerOpenings: 1 });
    expect(report.cumulative.training).toEqual({ salesOre: 7200, refundsOre: 1440, netOre: 5760 });
    expect(() => f.command(tab.id, { action: 'price', lineId: firstLineId, priceOre: 0, reason: 'Otillåten ändring på avslutat kvitto' })).toThrow('retur');
  });

  it('bevarar ackumulerade räknare över Z-avslut, efterföljande dag, byte av inställningar och verifierad backup/återställning', async () => {
    // @ts-expect-error Standalone CLI module.
    const { restoreDatabase } = await import('../scripts/database-tools.mjs');
    const f = fixture({}, true); const firstDay = f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 2 }); f.command(tab.id, { action: 'send' });
    const payment = await f.pay(tab.id);
    const firstClosed = f.service.closeDay(f.admin, firstDay.id, { key: key(), countedCashOre: 150000 });
    const frozen = structuredClone(firstClosed.report!);
    const settings = f.service.settings(); settings.registerId = 'BYTT-NAMNPREFIX'; settings.company.name = 'Ändrat övningsnamn'; f.service.saveSettings(f.admin, settings);
    const secondDay = f.open();
    await f.service.refund(f.admin, payment.id, { key: key(), amountOre: 3900, reason: 'Korrigering efter gårdagens köp', simulation: 'approved', fiscalSimulation: 'confirmed' });
    const expected = f.service.report(secondDay.id).registers!.map(report => ({ id: report.registerId, grandTotals: report.grandTotals }));
    expect(expected.find(report => report.grandTotals!.training.salesOre > 0)?.grandTotals!.training).toEqual({ salesOre: 15800, returnsOre: 3900, netOre: 11900, saleReceipts: 1, returnReceipts: 1 });
    const backup = await f.service.backup(f.admin); f.store.close();
    await restoreDatabase(backup.filename, { dataDir: f.directory, database: f.filename, backupDir: path.join(f.directory, 'backups') });
    const restored = new Store(f.filename);
    try {
      const service = new KassaService(restored, { now: () => new Date('2027-01-01T20:00:00Z') });
      expect(service.report(secondDay.id).registers!.map(report => ({ id: report.registerId, grandTotals: report.grandTotals }))).toEqual(expected);
      expect(service.report(firstDay.id)).toEqual(frozen);
      expect(restored.verifyJournal()).toBe(true);
    } finally { restored.close(); }
  });

  it('skiljer betalningsavstämning från kvittoregister när underlag saknas och utökar aldrig en gammal låst rapport', () => {
    const f = ledgerFixture(); const sale = f.sale('no-receipt-event', 'REGISTER-1', 10000);
    f.input.journal = f.input.journal.filter(entry => entry.entityId !== sale.receipt.id);
    const report = byRegister(f.build(), 1);
    expect(report.cumulative.training.salesOre).toBe(10000);
    expect(report.grandTotals!.training.salesOre).toBe(0);
    expect(report.grandTotals!.coverage).toEqual({ complete: false, issues: ['APPROVED_PAYMENT_WITHOUT_RECEIPT'] });
    const snapshot = f.build(); snapshot.forEach(value => delete value.grandTotals);
    const closed = { ...f.input.day, status: 'closed' as const, report: { dayId: f.input.day.id, salesOre: 10000, refundsOre: 0, netOre: 10000, tipsOre: 0, vatOre: 0, receipts: 1, methods: [], vat: [], expectedCashOre: 100000, differenceOre: 0, unresolved: 0, openTabs: 0, registers: snapshot } };
    expect(f.build({ day: closed })).toEqual(snapshot);
    expect(f.build({ day: closed }).every(value => value.grandTotals === undefined)).toBe(true);
  });
});
