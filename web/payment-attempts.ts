import { z } from 'zod';
import type { Actor } from '../shared/types';
import { paymentSchema, refundSchema } from '../shared/payment-inputs';

const common = { version: z.literal(1), targetId: z.string().min(1).max(100), createdAt: z.iso.datetime() };
const attemptSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('sale'), input: paymentSchema }).strict(),
  z.object({ ...common, kind: z.literal('refund'), input: refundSchema }).strict(),
]);
const attemptsSchema = z.array(attemptSchema).max(100);
export type PaymentAttempt = z.infer<typeof attemptSchema>;
export interface AttemptStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export const ATTEMPTS_CHANGED = 'lagustosa:payment-attempts';

export class AttemptStorageError extends Error {
  constructor(message = 'Betalningsförsöket kunde inte sparas på enheten. Kontrollera att webblagring är tillåten innan du tar betalt.') { super(message); }
}

export function attemptsKey(actor: Actor, scope?: string): string {
  return `lagustosa.payment-attempts.v1:${encodeURIComponent(actor.staff.id)}:${encodeURIComponent(actor.device.id)}${scope ? ':' + encodeURIComponent(scope) : ''}`;
}

export function readAttempts(actor: Actor, storage: AttemptStorage, scope?: string): PaymentAttempt[] {
  try {
    const value = storage.getItem(attemptsKey(actor, scope));
    return value === null ? [] : attemptsSchema.parse(JSON.parse(value));
  } catch {
    throw new AttemptStorageError('Tidigare betalningsförsök på enheten kunde inte läsas. Kontrollera webblagringen och betalningshistoriken innan du fortsätter.');
  }
}

function writeAttempts(actor: Actor, attempts: PaymentAttempt[], storage: AttemptStorage, scope?: string): void {
  try {
    const key = attemptsKey(actor, scope);
    const value = JSON.stringify(attempts);
    if (attempts.length) storage.setItem(key, value);
    else storage.removeItem(key);
    if (storage.getItem(key) !== (attempts.length ? value : null)) throw new Error('Storage did not retain the attempt');
  } catch { throw new AttemptStorageError(); }
}

export function saveAttempt(actor: Actor, attempt: PaymentAttempt, storage: AttemptStorage, scope?: string): void {
  const validated = attemptSchema.parse(attempt);
  const current = readAttempts(actor, storage, scope);
  const prior = current.find(entry => entry.kind === attempt.kind && entry.targetId === attempt.targetId);
  if (prior) {
    // A version retry may change only the order version, never the financial request or its key.
    const comparable = (entry: PaymentAttempt) => JSON.stringify({ ...entry.input, ...(entry.kind === 'sale' ? { version: 0 } : {}) });
    if (prior.input.key !== attempt.input.key || comparable(prior) !== comparable(validated)) {
      throw new AttemptStorageError('Ett tidigare försök väntar på kontroll. Kontrollera samma försök innan uppgifterna ändras.');
    }
  }
  writeAttempts(actor, [...current.filter(entry => entry.kind !== attempt.kind || entry.targetId !== attempt.targetId), validated], storage, scope);
}

export function forgetAttempt(actor: Actor, key: string, storage: AttemptStorage, scope?: string): void {
  const current = readAttempts(actor, storage, scope);
  if (!current.some(entry => entry.input.key === key)) return;
  writeAttempts(actor, current.filter(entry => entry.input.key !== key), storage, scope);
}
