export interface PaymentIntegration {
  provider: 'simulator' | 'softpay-sandbox';
  supportsTips: boolean;
  contractTest?: boolean;
  terminals: { deviceId: string; appId: string }[];
}
export interface TerminalPaymentInfo {
  paymentId: string; appId: string; requestId: string | null;
  phase: 'prepared' | 'creating' | 'created' | 'submitted';
  state: string | null; issue: string | null;
}
