import type { Payment, PaymentStatus, Receipt, PrintJob, PrinterProfile } from '../shared/types';
import { Store, digest } from './db';

export interface PaymentAdapter {
  readonly kind: 'simulator' | 'live';
  start(payment: Payment): Promise<PaymentStatus>;
  status(id: string): Promise<PaymentStatus>;
  cancel(id: string): Promise<PaymentStatus>;
  refund(payment: Payment): Promise<PaymentStatus>;
}
export interface FiscalResult { status: 'confirmed' | 'unknown'; controlCode: string | null }
export interface FiscalAdapter {
  readonly kind: 'simulator' | 'live';
  register(receipt: Receipt, simulation?: 'confirmed' | 'unknown'): Promise<FiscalResult>;
  lookup(receiptId: string): Promise<FiscalResult>;
  // Optional recovery only for adapters that can prove an absent registration
  // and idempotently register that same receipt. Unknown live state is not proof.
  recoverMissing?(receipt: Receipt): Promise<FiscalResult>;
}
export interface PrintAdapter {
  readonly kind: 'preview' | 'live';
  print(job: PrintJob, printer: PrinterProfile, outcome: 'printed' | 'failed' | 'uncertain'): Promise<'printed' | 'failed' | 'uncertain'>;
}

export class SimulatorPaymentAdapter implements PaymentAdapter {
  readonly kind = 'simulator';
  constructor(private store: Store) {}
  async start(payment: Payment): Promise<PaymentStatus> {
    const existing = this.store.get<{ id: string; status: PaymentStatus }>('payment-simulator', payment.id);
    if (existing) return payment.simulation === 'unknown' ? 'unknown' : existing.status;
    const status = payment.simulation === 'unknown' ? 'approved' : payment.simulation;
    this.store.put('payment-simulator', { id: payment.id, status });
    return payment.simulation;
  }
  async status(id: string): Promise<PaymentStatus> { return this.store.get<{ status: PaymentStatus }>('payment-simulator', id)?.status ?? 'unknown'; }
  async cancel(id: string): Promise<PaymentStatus> {
    const current = await this.status(id);
    if (current === 'approved') return 'approved';
    this.store.put('payment-simulator', { id, status: 'cancelled' });
    return 'cancelled';
  }
  async refund(payment: Payment): Promise<PaymentStatus> { return this.start(payment); }
}

export class SimulatorFiscalAdapter implements FiscalAdapter {
  readonly kind = 'simulator';
  constructor(private store: Store) {}
  async register(receipt: Receipt, simulation: 'confirmed' | 'unknown' = 'confirmed'): Promise<FiscalResult> {
    const existing = this.store.get<{ id: string; controlCode: string }>('fiscal-simulator', receipt.id);
    const controlCode = existing?.controlCode ?? `TEST-${digest(JSON.stringify([receipt.number, receipt.payment.amountOre, receipt.createdAt])).slice(0, 20).toUpperCase()}`;
    this.store.put('fiscal-simulator', { id: receipt.id, controlCode });
    return simulation === 'unknown' ? { status: 'unknown', controlCode: null } : { status: 'confirmed', controlCode };
  }
  async lookup(receiptId: string): Promise<FiscalResult> {
    const entry = this.store.get<{ controlCode: string }>('fiscal-simulator', receiptId);
    return entry ? { status: 'confirmed', controlCode: entry.controlCode } : { status: 'unknown', controlCode: null };
  }
  async recoverMissing(receipt: Receipt): Promise<FiscalResult> {
    // The simulator's durable store is authoritative; register reuses receipt.id.
    return this.register(receipt);
  }
}

export class PreviewPrintAdapter implements PrintAdapter {
  readonly kind = 'preview';
  async print(_job: PrintJob, _printer: PrinterProfile, outcome: 'printed' | 'failed' | 'uncertain'): Promise<'printed' | 'failed' | 'uncertain'> { return outcome; }
}
