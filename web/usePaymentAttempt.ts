import { useCallback, useEffect, useState } from 'react';
import type { Actor } from '../shared/types';
import { ATTEMPTS_CHANGED, AttemptStorageError, forgetAttempt, readAttempts, saveAttempt, type PaymentAttempt } from './payment-attempts';

export function usePaymentAttempts(actor: Actor | undefined, scope?: string) {
  const [attempts, setAttempts] = useState<PaymentAttempt[]>([]);
  const [storageError, setStorageError] = useState<string | null>(null);
  const staffId = actor?.staff.id;
  const deviceId = actor?.device.id;
  const reload = useCallback(() => {
    if (!actor) { setAttempts([]); setStorageError(null); return; }
    try { setAttempts(readAttempts(actor, window.localStorage, scope)); setStorageError(null); }
    catch (error) { setStorageError((error as Error).message); }
  }, [staffId, deviceId, scope]);
  useEffect(() => {
    reload();
    window.addEventListener('storage', reload);
    window.addEventListener(ATTEMPTS_CHANGED, reload);
    return () => { window.removeEventListener('storage', reload); window.removeEventListener(ATTEMPTS_CHANGED, reload); };
  }, [reload]);
  const remember = useCallback((attempt: PaymentAttempt) => {
    if (!actor) throw new AttemptStorageError();
    try { saveAttempt(actor, attempt, window.localStorage, scope); }
    catch (error) { setStorageError((error as Error).message); throw error; }
    window.dispatchEvent(new Event(ATTEMPTS_CHANGED));
    return attempt;
  }, [staffId, deviceId, scope]);
  const forget = useCallback((key: string) => {
    if (!actor) return;
    try { forgetAttempt(actor, key, window.localStorage, scope); window.dispatchEvent(new Event(ATTEMPTS_CHANGED)); }
    catch (error) { setStorageError((error as Error).message); }
  }, [staffId, deviceId, scope]);
  return { attempts, storageError, remember, forget };
}
