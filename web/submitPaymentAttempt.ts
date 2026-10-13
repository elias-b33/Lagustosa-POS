import type { Payment, Tab } from '../shared/types';
import { api, ApiError } from './api';
import type { PaymentAttempt } from './payment-attempts';

export const lookupAttempt = (attempt: PaymentAttempt) => api<Payment | null>(`/payment-attempts/${encodeURIComponent(attempt.input.key)}`);

export async function submitPaymentAttempt(
  attempt: PaymentAttempt,
  remember: (attempt: PaymentAttempt) => PaymentAttempt,
  forget: (key: string) => void,
): Promise<Payment> {
  // Persist before any request can start a charge. A retry first reads its server result.
  remember(attempt);
  const existing = await lookupAttempt(attempt);
  if (existing) return existing;
  const path = attempt.kind === 'sale' ? `/tabs/${attempt.targetId}/payments` : `/payments/${attempt.targetId}/refunds`;
  try {
    try { return await api<Payment>(path, attempt.input); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'VERSION_CONFLICT' || attempt.kind !== 'sale') throw error;
      const latest = await api<Tab>(`/tabs/${attempt.targetId}`);
      attempt = remember({ ...attempt, input: { ...attempt.input, version: latest.version } });
      return await api<Payment>(path, attempt.input);
    }
  } catch (error) {
    // Never discard an uncertain response. For a definite rejection, verify that no
    // server payment exists before letting the operator change the request.
    if (error instanceof ApiError && [400, 404, 409, 415].includes(error.status) && error.code !== 'KEY_REUSED') {
      const saved = await lookupAttempt(attempt);
      if (saved) return saved;
      forget(attempt.input.key);
    }
    throw error;
  }
}
