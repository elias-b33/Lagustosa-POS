import type { AuditEntry, BusinessDay, CashMovement, Payment, PrintJob, Receipt, Settings, Tab, TrainingReportDetails } from '../shared/types';
import { calculateTab, distribute, paidOre } from '../shared/money';
import { historicalReportSettings, registerLedgerSnapshot } from './register-reporting';
export { buildRegisterReports } from './register-reporting';
export type { RegisterReportInputs } from './register-reporting';

interface ReportInputs {
  day: BusinessDay; settings: Settings; generatedAt: string; payments: Payment[];
  receipts: Receipt[]; tabs: Tab[]; journal: AuditEntry[]; printJobs: PrintJob[];
  throughJournalId?: number;
}

// These figures describe the simulator. They must not be substituted for real
// fiscal sales, goods/services counts or grand totals in a certified register.
export function trainingReportDetails({ day, settings, generatedAt, journal, printJobs, throughJournalId }: ReportInputs): TrainingReportDetails {
  if (day.status === 'closed' && day.report?.training) return structuredClone(day.report.training);
  const ledger = registerLedgerSnapshot({ day, journal, throughJournalId });
  const payments = [...ledger.payments.values()].map(value => value.payment);
  const receipts = [...ledger.receipts.values()].map(value => value.receipt);
  const tabs = [...ledger.tabs.values()];
  const historicalSettings = historicalReportSettings(settings, ledger.all, ledger.through);
  const approved = payments.filter(payment => payment.status === 'approved');
  const sales = approved.filter(payment => payment.dayId === day.id && payment.kind === 'sale');
  const dayReceipts = receipts.filter(receipt => receipt.dayId === day.id);
  const dayTabs = tabs.filter(tab => tab.dayId === day.id);
  // Audit sequence, rather than wall clock, separates days closed and opened in
  // the same second and remains correct when the operating-system clock moves.
  const dayEvents = !ledger.open ? [] : ledger.events.filter(entry => entry.id > ledger.from);
  const receiptMap = new Map(receipts.map(receipt => [receipt.id, receipt]));
  const printMap = new Map(printJobs.map(job => [job.id, job]));
  const copies = dayEvents.filter(entry => entry.action === 'print.reprint').flatMap(entry => {
    const details = entry.details as { receiptId?: string; originalId?: string; kind?: string; sourceId?: string };
    const job = printMap.get(entry.entityId);
    const receiptId = details.receiptId ?? (details.kind === 'guest' ? details.sourceId : job?.kind === 'guest' ? job.sourceId : undefined);
    const receipt = receiptId ? receiptMap.get(receiptId) : undefined;
    return receipt ? [receipt] : [];
  });
  const categories = new Map<string, number>();
  for (const receipt of dayReceipts.filter(receipt => receipt.kind === 'sale')) {
    for (const allocation of receipt.payment.allocations) {
      const line = receipt.tab.lines.find(line => line.id === allocation.lineId);
      // Never replace historical categories with today's mutable menu values.
      const category = line?.category ?? 'Historisk kategori saknas';
      categories.set(category, (categories.get(category) ?? 0) + allocation.grossOre);
    }
  }
  let discountsOre = 0;
  for (const tab of dayTabs) {
    const tabSales = sales.filter(payment => payment.tabId === tab.id);
    if (!tabSales.length) continue;
    const allocations = tabSales.flatMap(payment => payment.allocations);
    if (allocations.every(allocation => Number.isSafeInteger(allocation.discountOre) && allocation.discountOre! >= 0)) {
      discountsOre += allocations.reduce((sum, allocation) => sum + allocation.discountOre!, 0);
      continue;
    }
    for (const line of calculateTab(tab).lines) {
      const paid = tabSales.flatMap(payment => payment.allocations).filter(allocation => allocation.lineId === line.lineId).reduce((sum, allocation) => sum + allocation.grossOre, 0);
      // Aggregate split payments first, so cent rounding never counts a rebate
      // twice. A zero-price row is complete only once its tab is paid in full.
      discountsOre += line.grossOre === 0 ? (tab.status === 'paid' ? line.discountOre : 0) : distribute(line.discountOre, [paid, line.grossOre - paid])[0];
    }
  }
  const reductions = dayEvents.filter(entry => ['tab.remove', 'tab.price'].includes(entry.action)).flatMap(entry => {
    const details = entry.details as { before?: Tab; tab?: Tab };
    if (!details.before || !details.tab) return [];
    const reduction = calculateTab(details.before).grossOre - calculateTab(details.tab).grossOre;
    return reduction > 0 ? [reduction] : [];
  });
  const cashMovements = dayEvents.filter(entry => entry.action === 'cash.move').map(entry => entry.details as CashMovement).filter(movement => movement.dayId === day.id);
  const cumulativeSalesOre = approved.filter(payment => payment.kind === 'sale').reduce((sum, payment) => sum + payment.amountOre, 0);
  const cumulativeRefundsOre = approved.filter(payment => payment.kind === 'refund').reduce((sum, payment) => sum + payment.amountOre, 0);
  return {
    kind: 'X', generatedAt, sequence: null,
    company: structuredClone(historicalSettings?.company ?? dayReceipts[0]?.company ?? { name: '', organizationNumber: '', address: '', city: '', phone: '' }),
    registerId: historicalSettings?.registerId ?? dayReceipts[0]?.registerId ?? 'HISTORISK IDENTITET SAKNAS',
    trainingReceipts: dayReceipts.length, refundReceipts: dayReceipts.filter(receipt => receipt.kind === 'refund').length,
    drawerOpenings: dayEvents.filter(entry => entry.action === 'drawer.open').length,
    receiptCopies: copies.length, receiptCopiesOre: copies.reduce((sum, receipt) => sum + (receipt.kind === 'sale' ? 1 : -1) * receipt.payment.amountOre, 0),
    discountsOre, reductionsCount: reductions.length, reductionsOre: reductions.reduce((sum, amount) => sum + amount, 0),
    openTabAmountOre: dayTabs.filter(tab => tab.status === 'open').reduce((sum, tab) => sum + calculateTab(tab).grossOre - paidOre(approved, tab.id), 0),
    categories: [...categories].map(([name, salesOre]) => ({ name, salesOre })).sort((left, right) => left.name.localeCompare(right.name, 'sv-SE')),
    cumulativeSalesOre, cumulativeRefundsOre, cumulativeNetOre: cumulativeSalesOre - cumulativeRefundsOre,
    cashDepositsOre: cashMovements.filter(movement => movement.direction === 'in').reduce((sum, movement) => sum + movement.amountOre, 0),
    cashWithdrawalsOre: cashMovements.filter(movement => movement.direction === 'out').reduce((sum, movement) => sum + movement.amountOre, 0),
  };
}
