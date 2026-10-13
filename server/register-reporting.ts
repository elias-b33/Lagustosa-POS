import type { Allocation, AuditEntry, BusinessDay, Company, Payment, PrintJob, Receipt, Settings, Tab } from '../shared/types';
import { addQuantities, allocationQuantity } from '../shared/allocations';
import { calculateTab } from '../shared/money';
import type { RegisterActivityTotals, RegisterArticleCounts, RegisterCategoryTotals, RegisterReport, ReportRegister } from '../shared/register-reports';

export interface RegisterReportInputs {
  day: BusinessDay; settings: Settings; generatedAt: string; payments: Payment[];
  receipts: Receipt[]; tabs: Tab[]; journal: AuditEntry[]; printJobs: PrintJob[];
  registers: ReportRegister[]; throughJournalId?: number;
  kind?: 'X' | 'Z'; sequenceByRegisterId?: Record<string, number>;
}

type Details = {
  registerId?: string | null; payment?: Payment; receipt?: Receipt; tab?: Tab; before?: Tab;
  day?: BusinessDay; dayId?: string; settings?: Settings; previous?: Settings;
  kind?: string; receiptId?: string; sourceId?: string; originalId?: string;
  direction?: 'in' | 'out'; amountOre?: number;
  status?: Receipt['fiscalStatus'];
};
const detailsOf = (entry: AuditEntry): Details => entry.details && typeof entry.details === 'object' ? entry.details as Details : {};
const zeroQuantity = () => ({ numerator: '0', denominator: '1' });
const zeroCumulative = () => ({ salesOre: 0, refundsOre: 0, netOre: 0 });
const zeroGrandTotal = () => ({ salesOre: 0, returnsOre: 0, netOre: 0, saleReceipts: 0, returnReceipts: 0 });
const sum = (left: number, right: number) => {
  const value = left + right;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || !Number.isSafeInteger(value)) throw new Error('Rapportens belopp överstiger säker heltalsberäkning.');
  return value;
};

function emptyCounts(): RegisterArticleCounts {
  return {
    sold: zeroQuantity(), refunded: zeroQuantity(), goodsSold: zeroQuantity(), servicesSold: zeroQuantity(), unclassifiedSold: zeroQuantity(),
    goodsRefunded: zeroQuantity(), servicesRefunded: zeroQuantity(), unclassifiedRefunded: zeroQuantity(),
    saleAmountShares: zeroQuantity(), refundAmountShares: zeroQuantity(), missingSaleAllocations: 0, missingRefundAllocations: 0,
  };
}
function emptyActivity(): RegisterActivityTotals {
  return {
    salesOre: 0, refundsOre: 0, netOre: 0, tipsOre: 0,
    methods: (['card', 'swish', 'cash'] as const).map(method => ({ method, salesOre: 0, refundsOre: 0, tipsOre: 0, netOre: 0 })),
    vat: [], categories: [], articleCounts: emptyCounts(), receiptCounts: { sales: 0, refunds: 0, total: 0 },
    discountsOre: 0, reductionsCount: 0, reductionsOre: 0, receiptCopies: 0, receiptCopiesOre: 0, drawerOpenings: 0,
    openTabs: 0, openTabAmountOre: 0, floatOre: 0, cashDepositsOre: 0, cashWithdrawalsOre: 0, expectedCashOre: 0, unresolved: 0,
  };
}
function issue(report: RegisterReport, code: string) {
  report.coverage.complete = false;
  if (!report.coverage.issues.includes(code)) report.coverage.issues.push(code);
}
function grandTotalIssue(report: RegisterReport, code: string) {
  const coverage = report.grandTotals!.coverage;
  coverage.complete = false;
  if (!coverage.issues.includes(code)) coverage.issues.push(code);
  issue(report, code);
}

/** Sequence determines inclusion. A changed OS clock never moves a payment across the boundary. */
export function registerLedgerSnapshot(input: Pick<RegisterReportInputs, 'day' | 'journal' | 'throughJournalId'>) {
  const all = [...input.journal].sort((left, right) => left.id - right.id);
  const requested = input.throughJournalId ?? all.at(-1)?.id ?? 0;
  if (!Number.isSafeInteger(requested) || requested < 0) throw new Error('Ogiltig journalgräns för rapport.');
  const close = all.find(entry => entry.action === 'day.close' && entry.entityId === input.day.id);
  const through = Math.min(requested, all.at(-1)?.id ?? 0, close ? close.id - 1 : requested);
  const events = all.filter(entry => entry.id <= through);
  const open = events.find(entry => entry.action === 'day.open' && entry.entityId === input.day.id);
  const from = open?.id ?? 0;
  const receipts = new Map<string, { receipt: Receipt; at: number }>();
  const payments = new Map<string, { payment: Payment; at: number }>();
  const tabs = new Map<string, Tab>();
  const owners = new Map<string, string | null>();
  const fiscal = new Map<string, Receipt['fiscalStatus']>();
  for (const entry of events) {
    const details = detailsOf(entry);
    if (entry.action.startsWith('tab.') && details.tab) {
      tabs.set(details.tab.id, details.tab);
      if (entry.action === 'tab.create') owners.set(details.tab.id, details.registerId ?? null);
    }
    if ((entry.action.startsWith('payment.') || entry.action === 'refund.start') && details.payment) payments.set(details.payment.id, { payment: details.payment, at: entry.id });
    if (entry.action === 'payment.recovered_unknown') {
      const current = payments.get(entry.entityId);
      if (current) payments.set(entry.entityId, { payment: { ...current.payment, status: 'unknown' }, at: entry.id });
    }
    if (entry.action === 'receipt.create' && details.receipt) {
      // Never replace the event's immutable snapshot with a present-day entity.
      const receipt = details.receipt;
      if (!receipts.has(receipt.id)) receipts.set(receipt.id, { receipt, at: entry.id });
      payments.set(receipt.paymentId, { payment: receipt.payment, at: entry.id });
      tabs.set(receipt.tab.id, receipt.tab);
      fiscal.set(receipt.id, receipt.fiscalStatus);
    }
    if (entry.action === 'fiscal.confirmed') fiscal.set(entry.entityId, 'confirmed');
    if (entry.action === 'fiscal.unknown' || entry.action === 'fiscal.recovered_unknown') fiscal.set(entry.entityId, 'unknown');
    if (entry.action === 'fiscal.verify' && details.status) fiscal.set(entry.entityId, details.status);
  }
  return { all, events, open, from, through, receipts, payments, tabs, owners, fiscal };
}

export function historicalReportSettings(settings: Settings, events: AuditEntry[], through: number): Settings | undefined {
  const firstChange = events.find(entry => entry.action === 'settings.save');
  let active = firstChange ? detailsOf(firstChange).previous : settings;
  for (const entry of events) {
    if (entry.id > through) break;
    if (entry.action === 'settings.save') active = detailsOf(entry).settings;
  }
  return active ? structuredClone(active) : undefined;
}

function historicalCompany(input: RegisterReportInputs, events: AuditEntry[], through: number): Company {
  const active = historicalReportSettings(input.settings, events, through);
  if (active) return active.company;
  const receipt = events.filter(entry => entry.id <= through && entry.action === 'receipt.create').map(entry => detailsOf(entry).receipt).filter(receipt => receipt !== undefined).at(-1);
  return structuredClone(receipt?.company ?? { name: '', organizationNumber: '', address: '', city: '', phone: '' });
}

function recordQuantity(report: RegisterReport, category: RegisterCategoryTotals, allocation: Allocation, receipt: Receipt | undefined, sale: boolean) {
  const counts = report.training.articleCounts;
  const quantity = allocationQuantity(allocation);
  if (!quantity) {
    counts[sale ? 'missingSaleAllocations' : 'missingRefundAllocations']++;
    issue(report, 'MISSING_QUANTITY');
    return;
  }
  if (allocation.quantityBasis === 'amount-share') {
    const field = sale ? 'saleAmountShares' : 'refundAmountShares';
    counts[field] = addQuantities(counts[field], quantity);
    category[field] = addQuantities(category[field], quantity);
    issue(report, 'AMOUNT_SHARE_IS_NOT_PHYSICAL_QUANTITY');
    return;
  }
  if (allocation.quantityBasis !== 'items') {
    counts[sale ? 'missingSaleAllocations' : 'missingRefundAllocations']++;
    issue(report, 'MISSING_QUANTITY_BASIS');
    return;
  }
  const field = sale ? 'sold' : 'refunded';
  counts[field] = addQuantities(counts[field], quantity);
  category[field] = addQuantities(category[field], quantity);
  const kind = receipt?.tab.lines.find(line => line.id === allocation.lineId)?.itemKind;
  const classifiedField = sale ? kind === 'goods' ? 'goodsSold' : kind === 'services' ? 'servicesSold' : 'unclassifiedSold'
    : kind === 'goods' ? 'goodsRefunded' : kind === 'services' ? 'servicesRefunded' : 'unclassifiedRefunded';
  counts[classifiedField] = addQuantities(counts[classifiedField], quantity);
  if (!kind) issue(report, 'MISSING_GOODS_SERVICE_CLASSIFICATION');
}

function addPayment(report: RegisterReport, payment: Payment, receipt?: Receipt) {
  const value = report.training;
  const sale = payment.kind === 'sale';
  const moneyField = sale ? 'salesOre' : 'refundsOre';
  value[moneyField] = sum(value[moneyField], payment.amountOre);
  if (sale) value.tipsOre = sum(value.tipsOre, payment.tipOre);
  const method = value.methods.find(total => total.method === payment.method);
  if (!method) throw new Error('Betalningsmedel saknas i rapportmodellen.');
  method[moneyField] = sum(method[moneyField], payment.amountOre);
  if (sale) method.tipsOre = sum(method.tipsOre, payment.tipOre);
  if (receipt) {
    value.receiptCounts[sale ? 'sales' : 'refunds']++;
    value.receiptCounts.total++;
  } else issue(report, 'MISSING_RECEIPT_SNAPSHOT');
  if (payment.allocations.reduce((total, allocation) => sum(total, allocation.grossOre), 0) !== payment.amountOre) issue(report, 'ALLOCATION_TOTAL_MISMATCH');
  for (const allocation of payment.allocations) {
    let vat = value.vat.find(total => total.vatBps === allocation.vatBps);
    if (!vat) {
      vat = { vatBps: allocation.vatBps, salesGrossOre: 0, salesVatOre: 0, refundsGrossOre: 0, refundsVatOre: 0, netGrossOre: 0, netVatOre: 0 };
      value.vat.push(vat);
    }
    const vatGross = sale ? 'salesGrossOre' : 'refundsGrossOre';
    const vatTax = sale ? 'salesVatOre' : 'refundsVatOre';
    vat[vatGross] = sum(vat[vatGross], allocation.grossOre);
    vat[vatTax] = sum(vat[vatTax], allocation.vatOre);
    const line = receipt?.tab.lines.find(line => line.id === allocation.lineId);
    const name = line?.category ?? 'Historisk kategori saknas';
    if (!line?.category) issue(report, 'MISSING_HISTORICAL_CATEGORY');
    let category = value.categories.find(total => total.name === name);
    if (!category) {
      category = { name, salesOre: 0, refundsOre: 0, netOre: 0, sold: zeroQuantity(), refunded: zeroQuantity(), saleAmountShares: zeroQuantity(), refundAmountShares: zeroQuantity() };
      value.categories.push(category);
    }
    category[moneyField] = sum(category[moneyField], allocation.grossOre);
    recordQuantity(report, category, allocation, receipt, sale);
    if (sale) {
      if (Number.isSafeInteger(allocation.discountOre) && allocation.discountOre! >= 0) value.discountsOre = sum(value.discountsOre, allocation.discountOre!);
      else issue(report, 'MISSING_DISCOUNT_ALLOCATION');
    }
  }
}

/**
 * The caller captures this inside the same transaction as the report event and
 * stores the returned snapshot. Re-reading a closed day uses its stored snapshot.
 * This builder neither allocates Z numbers nor turns training into real sales.
 */
export function buildRegisterReports(input: RegisterReportInputs): RegisterReport[] {
  if (input.day.status === 'closed' && input.day.report?.registers) return structuredClone(input.day.report.registers);
  const ledger = registerLedgerSnapshot(input);
  const { events, through, from } = ledger;
  const company = historicalCompany(input, ledger.all, through);
  const kind = input.kind ?? (input.day.status === 'closed' ? 'Z' : 'X');
  const currentRegisters = new Map(input.registers.map(register => [register.id, register]));
  const results = new Map<string, RegisterReport>();
  const getReport = (id: string | null, legacy = false): RegisterReport => {
    const register = id && !legacy ? currentRegisters.get(id) : undefined;
    const stableId = register?.id ?? null;
    const key = stableId ? `register:${stableId}` : `legacy:${id ?? ''}`;
    let report = results.get(key);
    if (!report) {
      const sequence = kind === 'Z' && stableId ? input.sequenceByRegisterId?.[stableId] ?? null : null;
      report = {
        schemaVersion: 1, mode: 'training', dayId: input.day.id, kind, sequence, generatedAt: input.generatedAt,
        company: structuredClone(company), scope: stableId ? 'register' : 'legacy', registerId: stableId,
        legacyRegisterId: stableId ? null : id, deviceId: register?.deviceId ?? null,
        journalFromExclusive: from, journalThroughInclusive: through,
        training: emptyActivity(), real: emptyActivity(), cumulative: { training: zeroCumulative(), real: zeroCumulative() },
        grandTotals: { basis: 'registered-receipts-v1', training: zeroGrandTotal(), real: zeroGrandTotal(), coverage: { complete: true, issues: [] } },
        coverage: { complete: true, issues: [] },
      };
      if (!stableId) grandTotalIssue(report, 'LEGACY_REGISTER_SCOPE');
      if (!ledger.open) issue(report, 'MISSING_DAY_OPEN_EVENT');
      if (!company.name || !company.organizationNumber) issue(report, 'MISSING_HISTORICAL_COMPANY');
      if (kind === 'Z' && stableId && (!Number.isSafeInteger(sequence) || sequence! < 1)) issue(report, 'MISSING_Z_SEQUENCE');
      results.set(key, report);
    }
    return report;
  };
  // Enrolment sequence, not its wall-clock timestamp, decides which devices
  // existed at this snapshot. Empty units are included for the current view.
  for (const register of input.registers) {
    const enrolled = ledger.all.find(entry => entry.action === 'register.enrolled' && entry.entityId === register.id);
    if (enrolled ? enrolled.id <= through : input.throughJournalId === undefined || events.some(entry => detailsOf(entry).registerId === register.id)) {
      const report = getReport(register.id);
      if (!enrolled) grandTotalIssue(report, 'REGISTER_HISTORY_START_UNPROVEN');
    }
  }
  const receiptByPayment = new Map([...ledger.receipts.values()].map(({ receipt }) => [receipt.paymentId, receipt]));
  const paymentReport = (payment: Payment, receipt?: Receipt) => {
    const id = payment.registerId ?? receipt?.registerId ?? null;
    const report = getReport(id);
    if (payment.registerId && receipt?.registerId && payment.registerId !== receipt.registerId) issue(report, 'PAYMENT_RECEIPT_REGISTER_CONFLICT');
    return report;
  };
  const approvedByTab = new Map<string, number>();
  for (const { payment, at } of ledger.payments.values()) {
    const unresolved = payment.dayId === input.day.id && ['pending', 'unknown'].includes(payment.status) && at > from;
    if (payment.status !== 'approved' && !unresolved) continue;
    const receipt = receiptByPayment.get(payment.id);
    const report = paymentReport(payment, receipt);
    if (payment.status === 'approved') {
      const total = report.cumulative.training;
      const field = payment.kind === 'sale' ? 'salesOre' : 'refundsOre';
      total[field] = sum(total[field], payment.amountOre);
      if (!receipt) grandTotalIssue(report, 'APPROVED_PAYMENT_WITHOUT_RECEIPT');
      if (payment.kind === 'sale') approvedByTab.set(payment.tabId, sum(approvedByTab.get(payment.tabId) ?? 0, payment.amountOre));
      if (payment.dayId === input.day.id && at > from) addPayment(report, receipt?.payment ?? payment, receipt);
    } else report.training.unresolved++;
  }
  const returnedByOriginal = new Map<string, number>();
  // SKVFS 2021:17, 2 kap. 4–6, 19–20 §§; SKV M 2012:7, 5.3 (pp. 60–61):
  // https://www.skatteverket.se/download/18.71004e4c133e23bf6db800086195/1708611985904/SKV%20M%202012.07.pdf
  // Grand totals accumulate completed receipt registrations. A correction of
  // a completed sale uses a return receipt, including a later price reduction.
  // Corrections on an unfinished tab are not return posts. Receipt discounts
  // are already part of the recorded sales amount; neither they nor copies,
  // tips, cash movements or declined/pending attempts add another counter post.
  // This is a separate training mirror. Real fiscal counters remain zero.
  for (const { receipt, at } of ledger.receipts.values()) {
    const report = getReport(receipt.registerId);
    const payment = receipt.payment;
    if (receipt.dayId === input.day.id && at > from && ledger.fiscal.get(receipt.id) !== 'confirmed') paymentReport(payment, receipt).training.unresolved++;
    if (ledger.fiscal.get(receipt.id) !== 'confirmed') grandTotalIssue(report, 'UNRESOLVED_RECEIPT_CONTROL');
    if (receipt.paymentId !== payment.id || receipt.kind !== payment.kind || receipt.dayId !== payment.dayId || payment.status !== 'approved'
      || !Number.isSafeInteger(payment.amountOre) || payment.amountOre < 0
      || payment.allocations.some(allocation => !Number.isSafeInteger(allocation.grossOre) || allocation.grossOre < 0)
      || payment.allocations.reduce((amount, allocation) => sum(amount, allocation.grossOre), 0) !== payment.amountOre) {
      grandTotalIssue(report, 'INVALID_GRAND_TOTAL_RECEIPT');
      continue;
    }
    if (payment.registerId && payment.registerId !== receipt.registerId) grandTotalIssue(report, 'PAYMENT_RECEIPT_REGISTER_CONFLICT');
    const totals = report.grandTotals!.training;
    if (receipt.kind === 'sale') {
      totals.salesOre = sum(totals.salesOre, payment.amountOre);
      totals.saleReceipts = sum(totals.saleReceipts, 1);
    } else {
      totals.returnsOre = sum(totals.returnsOre, payment.amountOre);
      totals.returnReceipts = sum(totals.returnReceipts, 1);
      const original = receipt.originalReceiptId ? ledger.receipts.get(receipt.originalReceiptId) : undefined;
      if (!original || original.at >= at || original.receipt.kind !== 'sale' || original.receipt.paymentId !== payment.parentId) grandTotalIssue(report, 'RETURN_ORIGINAL_RECEIPT_UNPROVEN');
      else {
        const returned = sum(returnedByOriginal.get(original.receipt.id) ?? 0, payment.amountOre);
        returnedByOriginal.set(original.receipt.id, returned);
        if (returned > original.receipt.payment.amountOre) grandTotalIssue(report, 'RETURN_EXCEEDS_ORIGINAL_RECEIPT');
      }
    }
  }
  const inDay = (entry: AuditEntry) => entry.id > from && (ledger.open || detailsOf(entry).dayId === input.day.id || detailsOf(entry).tab?.dayId === input.day.id);
  const printMap = new Map(input.printJobs.map(job => [job.id, job]));
  for (const entry of events.filter(inDay)) {
    const details = detailsOf(entry);
    if (['tab.remove', 'tab.price'].includes(entry.action) && details.before && details.tab) {
      const reduction = calculateTab(details.before).grossOre - calculateTab(details.tab).grossOre;
      if (reduction > 0) {
        const report = getReport(details.registerId ?? null);
        report.training.reductionsCount++;
        report.training.reductionsOre = sum(report.training.reductionsOre, reduction);
      }
    } else if (entry.action === 'drawer.open') getReport(details.registerId ?? null).training.drawerOpenings++;
    else if (entry.action === 'cash.move' && details.dayId === input.day.id) {
      const report = getReport(details.registerId ?? null);
      if (details.direction !== 'in' && details.direction !== 'out') { issue(report, 'INVALID_CASH_MOVEMENT'); continue; }
      const field = details.direction === 'in' ? 'cashDepositsOre' : 'cashWithdrawalsOre';
      report.training[field] = sum(report.training[field], details.amountOre ?? 0);
    } else if (entry.action === 'print.reprint') {
      const job = printMap.get(entry.entityId) ?? (details.originalId ? printMap.get(details.originalId) : undefined);
      const receiptId = details.receiptId ?? (details.kind === 'guest' ? details.sourceId : job?.kind === 'guest' ? job.sourceId : undefined);
      if (!receiptId) continue;
      const receipt = ledger.receipts.get(receiptId)?.receipt;
      const report = getReport(details.registerId ?? receipt?.registerId ?? null);
      if (!receipt) { issue(report, 'MISSING_COPY_RECEIPT_SNAPSHOT'); continue; }
      report.training.receiptCopies++;
      report.training.receiptCopiesOre = sum(report.training.receiptCopiesOre, (receipt.kind === 'sale' ? 1 : -1) * receipt.payment.amountOre);
    }
  }
  if (ledger.open) {
    const opening = detailsOf(ledger.open);
    const report = getReport(opening.registerId ?? null);
    report.training.floatOre = opening.day?.floatOre ?? input.day.floatOre;
  }
  for (const tab of ledger.tabs.values()) {
    if (tab.dayId !== input.day.id || tab.status !== 'open') continue;
    const owner = ledger.owners.get(tab.id) ?? null;
    const report = getReport(owner);
    if (!owner) issue(report, 'MISSING_PARKING_REGISTER');
    report.training.openTabs++;
    const paid = approvedByTab.get(tab.id) ?? 0;
    const balance = calculateTab(tab).grossOre - paid;
    if (balance < 0) issue(report, 'NEGATIVE_OPEN_TAB_BALANCE');
    report.training.openTabAmountOre = sum(report.training.openTabAmountOre, balance);
  }
  // An entity without an audit snapshot has no provable sequence position. Do
  // not backdate it using a potentially moved clock or silently call it complete.
  const auditedPayments = new Set(ledger.all.flatMap(entry => { const details = detailsOf(entry); return [details.payment?.id, details.receipt?.paymentId].filter(id => id !== undefined); }));
  const auditedReceipts = new Set(ledger.all.filter(entry => entry.action === 'receipt.create').map(entry => entry.entityId));
  for (const payment of input.payments) if (payment.dayId === input.day.id && !auditedPayments.has(payment.id)) issue(getReport(null), 'PAYMENT_WITHOUT_JOURNAL_SNAPSHOT');
  for (const receipt of input.receipts) if (receipt.dayId === input.day.id && !auditedReceipts.has(receipt.id)) issue(getReport(receipt.registerId, true), 'RECEIPT_WITHOUT_JOURNAL_SNAPSHOT');
  for (const report of results.values()) {
    const value = report.training;
    value.netOre = sum(value.salesOre, -value.refundsOre);
    for (const method of value.methods) method.netOre = sum(method.salesOre, -method.refundsOre);
    for (const vat of value.vat) { vat.netGrossOre = sum(vat.salesGrossOre, -vat.refundsGrossOre); vat.netVatOre = sum(vat.salesVatOre, -vat.refundsVatOre); }
    for (const category of value.categories) category.netOre = sum(category.salesOre, -category.refundsOre);
    const cash = value.methods.find(method => method.method === 'cash')!;
    value.expectedCashOre = [value.floatOre, cash.netOre, cash.tipsOre, value.cashDepositsOre, -value.cashWithdrawalsOre].reduce(sum, 0);
    report.cumulative.training.netOre = sum(report.cumulative.training.salesOre, -report.cumulative.training.refundsOre);
    const grandTotals = report.grandTotals!;
    grandTotals.training.netOre = sum(grandTotals.training.salesOre, -grandTotals.training.returnsOre);
    grandTotals.coverage.issues.sort();
    value.vat.sort((left, right) => left.vatBps - right.vatBps);
    value.categories.sort((left, right) => left.name.localeCompare(right.name, 'sv-SE'));
    report.coverage.issues.sort();
  }
  return [...results.values()].sort((left, right) => `${left.scope}:${left.registerId ?? left.legacyRegisterId ?? ''}`.localeCompare(`${right.scope}:${right.registerId ?? right.legacyRegisterId ?? ''}`));
}
