import type { Company, MethodTotals } from './types';
import type { RationalQuantity } from './allocations';

/** A permanent registration-unit identity. A display-only device has none. */
export interface ReportRegister { id: string; deviceId: string; createdAt: string }

export interface RegisterVatTotals {
  vatBps: number;
  salesGrossOre: number; salesVatOre: number;
  refundsGrossOre: number; refundsVatOre: number;
  netGrossOre: number; netVatOre: number;
}

export interface RegisterArticleCounts {
  /** Only allocations explicitly recorded as items count as physical items. */
  sold: RationalQuantity; refunded: RationalQuantity;
  goodsSold: RationalQuantity; servicesSold: RationalQuantity; unclassifiedSold: RationalQuantity;
  goodsRefunded: RationalQuantity; servicesRefunded: RationalQuantity; unclassifiedRefunded: RationalQuantity;
  /** A monetary portion is not an assertion that a physical item was returned. */
  saleAmountShares: RationalQuantity; refundAmountShares: RationalQuantity;
  missingSaleAllocations: number; missingRefundAllocations: number;
}

export interface RegisterCategoryTotals {
  name: string; salesOre: number; refundsOre: number; netOre: number;
  sold: RationalQuantity; refunded: RationalQuantity;
  saleAmountShares: RationalQuantity; refundAmountShares: RationalQuantity;
}

export interface RegisterActivityTotals {
  salesOre: number; refundsOre: number; netOre: number; tipsOre: number;
  methods: MethodTotals[]; vat: RegisterVatTotals[]; categories: RegisterCategoryTotals[];
  articleCounts: RegisterArticleCounts;
  receiptCounts: { sales: number; refunds: number; total: number };
  /** Gross amounts already include item rebates. Refunds do not erase past rebates. */
  discountsOre: number;
  reductionsCount: number; reductionsOre: number;
  receiptCopies: number; receiptCopiesOre: number;
  drawerOpenings: number;
  /** Open tabs belong to the register captured on tab.create until explicit transfer. */
  openTabs: number; openTabAmountOre: number;
  floatOre: number; cashDepositsOre: number; cashWithdrawalsOre: number; expectedCashOre: number;
  unresolved: number;
}

export interface RegisterCumulativeTotals {
  /** Approved payment amounts; kept separate from the receipt-based grand-total model. */
  salesOre: number; refundsOre: number; netOre: number;
}

export interface RegisterGrandTotalValues {
  /** Accumulated gross receipt amounts, after receipt discounts and without tips. */
  salesOre: number;
  /** Absolute return-receipt amounts, including corrections of completed sales. */
  returnsOre: number;
  netOre: number;
  saleReceipts: number; returnReceipts: number;
}

export interface RegisterGrandTotals {
  basis: 'registered-receipts-v1';
  /** Simulation of the receipt-register rules; never real fiscal activity. */
  training: RegisterGrandTotalValues;
  real: RegisterGrandTotalValues;
  /** Covers the counter's receipt evidence, not approval of a fiscal integration. */
  coverage: { complete: boolean; issues: string[] };
}

export interface RegisterReport {
  schemaVersion: 1; mode: 'training'; dayId: string; kind: 'X' | 'Z'; sequence: number | null;
  generatedAt: string; company: Company;
  scope: 'register' | 'legacy'; registerId: string | null; deviceId: string | null;
  /** Original historical designation, never rewritten to one of the new register IDs. */
  legacyRegisterId: string | null;
  journalFromExclusive: number; journalThroughInclusive: number;
  training: RegisterActivityTotals;
  /** The current product cannot record real sales; these values remain zero. */
  real: RegisterActivityTotals;
  cumulative: { training: RegisterCumulativeTotals; real: RegisterCumulativeTotals };
  /** Optional because closed historical reports are never retroactively extended. */
  grandTotals?: RegisterGrandTotals;
  /** Data completeness only. `complete` is not regulatory approval or a readiness flag. */
  coverage: { complete: boolean; issues: string[] };
}
