import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../web/api';
import { createRefreshScheduler, createSnapshotRefresh } from '../web/refresh';
import { submitPaymentAttempt } from '../web/submitPaymentAttempt';
import type { PaymentAttempt } from '../web/payment-attempts';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Uppdatering under belastning', () => {
  it('visar nya order trots en obruten ström av ändringar', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => {});
    const scheduler = createRefreshScheduler(refresh);
    for (let time = 0; time < 2000; time += 40) {
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(20);
    scheduler.stop();
  });

  it('samlar ändringar under en långsam hämtning till en efterföljande hämtning', async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const refresh = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    const scheduler = createRefreshScheduler(refresh);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(80);
    for (let time = 0; time < 1000; time += 100) { scheduler.schedule(); await vi.advanceTimersByTimeAsync(100); }
    expect(refresh).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.advanceTimersByTimeAsync(80);
    expect(refresh).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('stänger väntande uppdateringar när skärmen lämnas', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => {});
    const scheduler = createRefreshScheduler(refresh);
    scheduler.schedule(); scheduler.stop(); scheduler.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('låter inte ett gammalt 401-svar logga ut en ny inloggning', async () => {
    const old = deferred<string>(); const recent = deferred<string>();
    const load = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => recent.promise);
    const apply = vi.fn(); const refresh = createSnapshotRefresh(load, apply);
    const pendingOld = refresh(); const pendingNew = refresh();
    recent.resolve('ny inloggning'); await pendingNew;
    old.reject(new ApiError('SESSION', 'Utloggad', 401)); await pendingOld;
    expect(apply.mock.calls).toEqual([[{ ok: true, value: 'ny inloggning' }]]);
  });

  it('låter inte ett gammalt lyckat svar återställa en utloggad session', async () => {
    const old = deferred<string>(); const recent = deferred<string>();
    const load = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => recent.promise);
    const apply = vi.fn(); const refresh = createSnapshotRefresh(load, apply);
    const pendingOld = refresh(); const pendingNew = refresh();
    const unauthorized = new ApiError('SESSION', 'Utloggad', 401);
    recent.reject(unauthorized); await pendingNew;
    old.resolve('gammal session'); await pendingOld;
    expect(apply.mock.calls).toEqual([[{ ok: false, error: unauthorized }]]);
  });
});

describe('Avbrutna API-svar', () => {
  it('avbryter ett hängande anrop efter 15 sekunder utan att försöka igen', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetcher);
    const failed = vi.fn(); const pending = api('/tabs', { key: 'same-attempt' }).catch(failed);
    await vi.advanceTimersByTimeAsync(15001);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIMEOUT', status: 0 }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await pending;
  });

  it('ger ett begripligt fel när en proxy svarar med HTML', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Gateway unavailable</html>', { status: 502 })));
    await expect(api('/bootstrap')).rejects.toMatchObject({ name: 'Error', code: 'SERVER_ERROR', status: 502 });
  });

  it('begränsar även väntan på en svarskropp som aldrig blir färdig', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
    })));
    const failed = vi.fn(); const pending = api('/bootstrap').catch(failed);
    await vi.advanceTimersByTimeAsync(15001);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIMEOUT', status: 0 }));
    await pending;
  });

  it('bevarar samma betalningsförsök vid timeout och debiterar inte på nytt', async () => {
    vi.useFakeTimers();
    const attempt: PaymentAttempt = { version: 1, kind: 'sale', targetId: 'tab-test', createdAt: '2026-10-13T20:00:00Z', input: { key: 'saved-attempt', version: 1, method: 'card', amountOre: 10000, tipOre: 0, simulation: 'approved', fiscalSimulation: 'confirmed' } };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('null')).mockImplementationOnce((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetcher);
    const remember = vi.fn((value: PaymentAttempt) => value); const forget = vi.fn(); const failed = vi.fn();
    const pending = submitPaymentAttempt(attempt, remember, forget).catch(failed);
    await vi.advanceTimersByTimeAsync(15001);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIMEOUT', status: 0 }));
    expect(remember).toHaveBeenCalledWith(attempt);
    expect(forget).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
      ['/api/v1/payment-attempts/saved-attempt', 'GET'], ['/api/v1/tabs/tab-test/payments', 'POST'],
    ]);
    await pending;
  });

  it('behåller betalningsnyckeln när anslutningen bryts efter svarshuvudet', async () => {
    const attempt: PaymentAttempt = { version: 1, kind: 'sale', targetId: 'tab-test', createdAt: '2026-10-13T20:00:00Z', input: { key: 'saved-attempt', version: 1, method: 'card', amountOre: 10000, tipOre: 0, simulation: 'approved', fiscalSimulation: 'confirmed' } };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('null')).mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.reject(new TypeError('connection closed')) });
    vi.stubGlobal('fetch', fetcher);
    const remember = vi.fn((value: PaymentAttempt) => value); const forget = vi.fn();
    await expect(submitPaymentAttempt(attempt, remember, forget)).rejects.toBeInstanceOf(ApiError);
    expect(remember).toHaveBeenCalledWith(attempt);
    expect(forget).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
