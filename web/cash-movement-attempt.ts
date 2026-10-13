import type { Actor, CashMovement } from '../shared/types';
import { cashMovementSchema, type CashMovementInput } from '../shared/cash-inputs';
import type { AttemptStorage } from './payment-attempts';
import { api, ApiError } from './api';

export function cashAttemptKey(actor: Actor, scope = 'training'): string {
  return `lagustosa.cash-movement.v1:${encodeURIComponent(scope)}:${encodeURIComponent(actor.staff.id)}:${encodeURIComponent(actor.device.id)}`;
}
export function readCashAttempt(actor: Actor, storage: AttemptStorage, scope?: string): CashMovementInput | null {
  try {
    const raw = storage.getItem(cashAttemptKey(actor, scope));
    return raw === null ? null : cashMovementSchema.parse(JSON.parse(raw));
  } catch { throw new Error('Den sparade kontanthändelsen kunde inte läsas. Kontrollera webblagringen innan du fortsätter.'); }
}
export async function submitCashMovement(input: CashMovementInput, actor: Actor, storage: AttemptStorage, scope?: string, send: (input: CashMovementInput) => Promise<CashMovement> = input => api<CashMovement>('/cash-movements', input)): Promise<CashMovement> {
  const pending = readCashAttempt(actor, storage, scope);
  const validated = cashMovementSchema.parse(input);
  if (pending && JSON.stringify(pending) !== JSON.stringify(validated)) throw new Error('Kontrollera den sparade kontanthändelsen innan en ny registreras.');
  const storageKey = cashAttemptKey(actor, scope);
  const encoded = JSON.stringify(validated);
  try {
    storage.setItem(storageKey, encoded);
    if (storage.getItem(storageKey) !== encoded) throw new Error();
  } catch { throw new Error('Kontanthändelsen kunde inte sparas på enheten. Tillåt webblagring innan registreringen skickas.'); }
  const forget = () => {
    storage.removeItem(storageKey);
    if (storage.getItem(storageKey) !== null) throw new Error('Det bekräftade försöket kunde inte rensas. Kontrollera samma händelse igen.');
  };
  try {
    const result = await send(validated);
    forget();
    return result;
  } catch (error) {
    // Authentication and connection failures cannot prove whether an earlier
    // request committed. Only explicit pre-commit business rejections release it.
    if (error instanceof ApiError && ['CASH_INSUFFICIENT', 'CASH_AMOUNT', 'DAY_CLOSED', 'DAY_MISMATCH'].includes(error.code)) forget();
    throw error;
  }
}
