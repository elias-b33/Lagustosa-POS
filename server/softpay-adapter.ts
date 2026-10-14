import type { Payment, PaymentStatus } from '../shared/types';
import type { PaymentIntegration, TerminalPaymentInfo } from '../shared/payment-integration';
import type { PaymentAdapter } from './adapters';
import { SimulatorPaymentAdapter } from './adapters';
import { Store, digest } from './db';
import { demand } from './errors';
import { SoftpayError, SoftpaySandboxClient, type SoftpayResult, type SoftpayTransactionRequest } from './softpay-client';
import type { SoftpaySandboxConfig } from './softpay-config';

export interface SoftpayAttempt {
  id: string; registerId: string; deviceId: string; appId: string; storeId: number; account: string;
  amount: number; action: 'PAYMENT' | 'REFUND'; posReference: string;
  requestId: string | null; phase: TerminalPaymentInfo['phase']; status: PaymentStatus;
  state: string | null; issue: string | null; transactionId: string | null; updatedAt: string;
}
const finalStatuses = new Set<PaymentStatus>(['approved', 'declined', 'cancelled']);

export class SoftpaySandboxAdapter implements PaymentAdapter {
  readonly kind = 'sandbox';
  private simulator: SimulatorPaymentAdapter;
  private account: string;
  private operations = new Map<string, Promise<PaymentStatus>>();
  constructor(private store: Store, private config: SoftpaySandboxConfig, private client = new SoftpaySandboxClient(config)) {
    this.simulator = new SimulatorPaymentAdapter(store);
    this.account = digest(JSON.stringify(['softpay-sandbox', config.clientId, config.merchantReference ?? null]));
    this.store.atomic(() => {
      const previous = store.get<{ account: string }>('meta', 'payment-profile');
      demand(previous ? previous.account === this.account : store.all('payment').length === 0,
        'Softpay sandbox kräver en egen testdatabas och samma handlarkonto vid återstart.', 500, 'PAYMENT_PROFILE_MISMATCH');
      if (!previous) store.put('meta', { id: 'payment-profile', account: this.account, provider: 'softpay-sandbox' });
    });
  }
  integration(): PaymentIntegration {
    return { provider: 'softpay-sandbox', supportsTips: false, terminals: this.config.terminals.map(({ deviceId, appId }) => ({ deviceId, appId })) };
  }
  terminalInfo(id: string): TerminalPaymentInfo | null {
    const attempt = this.store.get<SoftpayAttempt>('softpay-attempt', id);
    return attempt ? { paymentId: id, appId: attempt.appId, requestId: attempt.requestId, phase: attempt.phase, state: attempt.state, issue: attempt.issue } : null;
  }
  // Called inside the payment transaction: both the financial reservation and its destination commit together.
  prepare(payment: Payment): void {
    if (payment.method !== 'card') return;
    const existing = this.store.get<SoftpayAttempt>('softpay-attempt', payment.id);
    if (existing) return;
    const terminal = this.config.terminals.find(entry => entry.deviceId === payment.deviceId);
    demand(terminal, 'Den här kassan saknar koppling till en Softpay-testenhet.', 409, 'TERMINAL_NOT_CONFIGURED');
    demand(payment.tipOre === 0, 'Dricks är avstängd i den första Softpay-kopplingen tills beloppshanteringen verifierats med leverantören.', 409, 'TERMINAL_TIPS_UNSUPPORTED');
    demand(Number.isSafeInteger(payment.amountOre) && payment.amountOre > 0 && payment.amountOre <= 99999999, 'Softpay-testbetalningen måste vara mellan 0,01 och 999 999,99 kr.', 400, 'TERMINAL_AMOUNT');
    demand(!this.store.all<SoftpayAttempt>('softpay-attempt').some(attempt => attempt.appId === terminal.appId && !finalStatuses.has(attempt.status)), 'Testterminalen har redan ett betalningsförsök. Kontrollera eller avbryt det först.', 409, 'TERMINAL_BUSY');
    if (payment.kind === 'refund') {
      const original = payment.parentId && this.store.get<SoftpayAttempt>('softpay-attempt', payment.parentId);
      demand(original && original.status === 'approved' && original.account === this.account, 'Returen måste höra till en godkänd Softpay-testbetalning på samma handlarkonto.', 409, 'TERMINAL_REFUND_ORIGIN');
    }
    const attempt: SoftpayAttempt = { id: payment.id, registerId: payment.registerId!, deviceId: payment.deviceId, appId: terminal.appId, storeId: terminal.storeId, account: this.account, amount: payment.amountOre, action: payment.kind === 'sale' ? 'PAYMENT' : 'REFUND', posReference: payment.id.replaceAll('-', ''), requestId: null, phase: 'prepared', status: 'pending', state: null, issue: null, transactionId: null, updatedAt: new Date().toISOString() };
    this.save(attempt);
  }
  private save(attempt: SoftpayAttempt): SoftpayAttempt {
    attempt.updatedAt = new Date().toISOString();
    this.store.atomic(() => {
      const previous = this.store.get<SoftpayAttempt>('softpay-attempt', attempt.id);
      this.store.put('softpay-attempt', attempt);
      if (!previous || previous.phase !== attempt.phase || previous.status !== attempt.status || previous.state !== attempt.state || previous.issue !== attempt.issue) {
        this.store.audit('system', 'terminal.status', attempt.id, { registerId: attempt.registerId, provider: 'softpay-sandbox', appId: attempt.appId, requestId: attempt.requestId, phase: attempt.phase, status: attempt.status, state: attempt.state, issue: attempt.issue, transactionId: attempt.transactionId }, attempt.updatedAt);
      }
    });
    return attempt;
  }
  private get(id: string): SoftpayAttempt {
    const attempt = this.store.get<SoftpayAttempt>('softpay-attempt', id);
    demand(attempt && attempt.account === this.account, 'Testbetalningens leverantörskoppling saknas.', 409, 'TERMINAL_ATTEMPT_MISSING');
    return attempt;
  }
  private async serial(id: string, operation: () => Promise<PaymentStatus>): Promise<PaymentStatus> {
    const previous = this.operations.get(id);
    // Serialize start/read/abort so late responses cannot overwrite a newer result.
    const pending = (async () => { if (previous) await previous.catch(() => {}); return operation(); })();
    this.operations.set(id, pending);
    try { return await pending; } finally { if (this.operations.get(id) === pending) this.operations.delete(id); }
  }
  private uncertain(attempt: SoftpayAttempt, issue: string): PaymentStatus {
    this.save({ ...attempt, status: 'unknown', issue });
    return 'unknown';
  }
  private observe(attempt: SoftpayAttempt, result: SoftpayResult): PaymentStatus {
    const mismatched = result.requestId !== attempt.requestId
      || result.appId != null && result.appId !== attempt.appId
      || result.storeId != null && result.storeId !== attempt.storeId
      || result.type != null && result.type !== (attempt.action === 'PAYMENT' ? 'PURCHASE' : 'REFUND')
      || result.amountValue != null && result.amountValue !== attempt.amount
      || result.currencyCode != null && result.currencyCode !== 'SEK'
      || result.posReferenceNumber != null && result.posReferenceNumber !== attempt.posReference
      || (result.amountTips ?? 0) !== 0 || (result.amountSurcharge ?? 0) !== 0;
    if (mismatched) return this.uncertain(attempt, 'result_mismatch');
    let status: PaymentStatus = 'unknown';
    if (result.state === 'COMPLETED') {
      if (!result.transactionId || result.responseCode !== 'APPROVED' || result.appId !== attempt.appId || result.storeId !== attempt.storeId || result.amountValue !== attempt.amount || result.currencyCode !== 'SEK' || result.type !== (attempt.action === 'PAYMENT' ? 'PURCHASE' : 'REFUND') || result.posReferenceNumber !== attempt.posReference) return this.uncertain(attempt, 'approval_unverified');
      status = 'approved';
    } else if (result.state === 'DECLINED') status = 'declined';
    else if (['ABORTED', 'CANCELLED'].includes(result.state)) status = 'cancelled';
    else if (['CREATED', 'UNCLAIMED', 'CLAIMED', 'PROCESSING'].includes(result.state)) status = 'pending';
    this.save({ ...attempt, status, state: result.state, issue: status === 'unknown' ? 'provider_state_unknown' : null, transactionId: result.transactionId ?? null });
    return status;
  }
  private async readAttempt(attempt: SoftpayAttempt): Promise<PaymentStatus> {
    if (finalStatuses.has(attempt.status)) return attempt.status;
    if (!attempt.requestId || attempt.phase !== 'submitted') return this.uncertain(attempt, 'not_submitted');
    try { return this.observe(attempt, await this.client.read(attempt.requestId)); }
    catch (error) { return this.uncertain(attempt, error instanceof SoftpayError ? error.code : 'transport'); }
  }
  async start(payment: Payment): Promise<PaymentStatus> {
    if (payment.method !== 'card') return this.simulator.start(payment);
    return this.serial(payment.id, async () => {
      let attempt = this.get(payment.id);
      if (finalStatuses.has(attempt.status)) return attempt.status;
      if (attempt.phase !== 'prepared') return this.readAttempt(attempt);
      try {
        attempt = this.save({ ...attempt, phase: 'creating' });
        const requestId = await this.client.create(attempt.action);
        attempt = this.save({ ...attempt, requestId, phase: 'created' });
        const transaction: SoftpayTransactionRequest = { appId: attempt.appId, amount: attempt.amount, currencyCode: 'SEK', posReferenceNumber: attempt.posReference, options: { tipping: { indicator: 'OFF' }, surcharge: false, dcc: false, suppressAppNotification: false } };
        // Durable before dispatch. After a crash, status/abort will use this same requestId and destination.
        attempt = this.save({ ...attempt, phase: 'submitted' });
        await this.client.start(requestId, transaction);
        return 'pending';
      } catch (error) { return this.uncertain(attempt, error instanceof SoftpayError ? error.code : 'transport'); }
    });
  }
  async status(id: string): Promise<PaymentStatus> {
    if (this.store.get<Payment>('payment', id)?.method !== 'card') return this.simulator.status(id);
    return this.serial(id, () => this.readAttempt(this.get(id)));
  }
  async cancel(id: string): Promise<PaymentStatus> {
    if (this.store.get<Payment>('payment', id)?.method !== 'card') return this.simulator.cancel(id);
    return this.serial(id, async () => {
      const attempt = this.get(id);
      if (finalStatuses.has(attempt.status)) return attempt.status;
      if (attempt.phase !== 'submitted') {
        this.save({ ...attempt, status: 'cancelled', issue: null });
        return 'cancelled'; // No PUT could have happened; serial() waits for any active start.
      }
      // First discover an approval that may have arrived after the caller lost its response.
      const status = await this.readAttempt(attempt);
      if (finalStatuses.has(status)) return status;
      try { await this.client.abort(attempt.requestId!); }
      catch { /* An abort acknowledgement or timeout is not proof of cancellation. */ }
      return this.readAttempt(this.get(id));
    });
  }
  async refund(payment: Payment): Promise<PaymentStatus> { return this.start(payment); }
}
