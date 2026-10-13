import { describe, expect, it } from 'vitest';
import { fixture, key } from './helpers';
import { attemptsKey, forgetAttempt, readAttempts, saveAttempt, type AttemptStorage, type PaymentAttempt } from '../web/payment-attempts';

function memoryStorage(): AttemptStorage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
function sale(targetId = 'test-tab'): Extract<PaymentAttempt, { kind: 'sale' }> {
  return { version: 1, kind: 'sale', targetId, createdAt: '2026-10-13T20:00:00.000Z', input: { key: key(), version: 2, method: 'card', amountOre: 6900, tipOre: 1000, simulation: 'approved', fiscalSimulation: 'confirmed' } };
}

describe('Sparade betalningsförsök', () => {
  it('skiljer testomgångar och bevarar tidigare försök när en ny omgång börjar', () => {
    const f = fixture(); const storage = memoryStorage(); const attempt = sale();
    saveAttempt(f.admin, attempt, storage, 'session-one');
    expect(readAttempts(f.admin, storage, 'session-two')).toEqual([]);
    expect(readAttempts(f.admin, storage)).toEqual([]);
    const fresh = sale(); saveAttempt(f.admin, fresh, storage, 'session-two');
    forgetAttempt(f.admin, fresh.input.key, storage, 'session-two');
    expect(readAttempts(f.admin, storage, 'session-one')).toEqual([attempt]);
    expect(readAttempts(f.admin, storage, 'session-two')).toEqual([]);
    saveAttempt(f.admin, fresh, storage);
    expect(readAttempts(f.admin, storage)).toEqual([fresh]);
    expect(readAttempts(f.admin, storage, 'session-one')).toEqual([attempt]);
  });

  it('behåller samma belopp, dricks och nyckel när en ny sida läser försöket', () => {
    const f = fixture(); const storage = memoryStorage(); const attempt = sale();
    saveAttempt(f.admin, attempt, storage);
    expect(readAttempts(structuredClone(f.admin), storage)).toEqual([attempt]);
    const updated = attempt.kind === 'sale' ? { ...attempt, input: { ...attempt.input, version: 9 } } : attempt;
    saveAttempt(f.admin, updated, storage);
    expect(readAttempts(f.admin, storage)).toEqual([updated]);
  });

  it('skiljer personal, enheter och returer från försäljning', () => {
    const f = fixture(); const storage = memoryStorage(); const attempt = sale();
    const refund: PaymentAttempt = { version: 1, kind: 'refund', targetId: 'original-payment', createdAt: attempt.createdAt, input: { key: key(), amountOre: 2000, reason: 'Fel rätt serverad', simulation: 'unknown', fiscalSimulation: 'confirmed' } };
    saveAttempt(f.admin, attempt, storage); saveAttempt(f.admin, refund, storage);
    expect(readAttempts(f.actor('cashier'), storage)).toEqual([]);
    expect(readAttempts(f.actor('admin', 'SERVERING-1'), storage)).toEqual([]);
    forgetAttempt(f.admin, attempt.input.key, storage);
    expect(readAttempts(f.admin, storage)).toEqual([refund]);
  });

  it('avvisar en ny nyckel eller ändrat belopp medan samma nota har ett sparat försök', () => {
    const f = fixture(); const storage = memoryStorage(); const attempt = sale();
    saveAttempt(f.admin, attempt, storage);
    expect(() => saveAttempt(f.admin, sale(), storage)).toThrow('tidigare försök');
    expect(() => saveAttempt(f.admin, { ...attempt, input: { ...attempt.input, amountOre: 7000 } }, storage)).toThrow('tidigare försök');
    expect(readAttempts(f.admin, storage)).toEqual([attempt]);
  });

  it('stoppar betalningen om webblagringen är full eller ignorerar skrivningen', () => {
    const f = fixture();
    const blocked: AttemptStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    expect(() => saveAttempt(f.admin, sale(), blocked)).toThrow('kunde inte sparas');
    expect(() => saveAttempt(f.admin, sale(), { ...blocked, setItem: () => {} })).toThrow('kunde inte sparas');
  });

  it('behåller skadad historik i stället för att behandla den som ett nytt försök', () => {
    const f = fixture(); const storage = memoryStorage();
    storage.setItem(attemptsKey(f.admin), '{broken');
    expect(() => readAttempts(f.admin, storage)).toThrow('kunde inte läsas');
    expect(() => saveAttempt(f.admin, sale(), storage)).toThrow('kunde inte läsas');
    expect(storage.getItem(attemptsKey(f.admin))).toBe('{broken');
  });
});
