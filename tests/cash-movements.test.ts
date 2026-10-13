import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import type { CashMovementInput } from '../shared/cash-inputs';
import { ApiError } from '../web/api';
import { cashAttemptKey, readCashAttempt, submitCashMovement } from '../web/cash-movement-attempt';
import { closingText } from '../server/printing';
import { exportCsv } from '../server/export';
import { fixture, key } from './helpers';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { for (const { app } of apps.splice(0)) await app.close(); });

describe('Journalförda kontantinsättningar och uttag', () => {
  it('räknar insättning och uttag med kontant betalning, dricks och retur utan att ändra försäljningen', async () => {
    const f = fixture(); const day = f.open();
    const input = { key: key(), dayId: day.id, direction: 'in' as const, amountOre: 50000, reason: 'Mer växel till kassan' };
    const first = f.service.moveCash(f.admin, input);
    expect(first).toMatchObject({ dayId: day.id, previousCashOre: 150000, expectedCashOre: 200000, staffId: f.admin.staff.id, deviceId: f.admin.device.id });
    expect(f.service.moveCash(f.admin, input)).toEqual(first);
    expect(() => f.service.moveCash(f.admin, { ...input, amountOre: 50001 })).toThrow('Identifieraren');
    const tab = f.tab(); f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const payment = await f.pay(tab.id, { method: 'cash', tenderedOre: 20000, tipOre: 1000 });
    await f.service.refund(f.admin, payment.id, { key: key(), amountOre: 2900, reason: 'Test av delretur', simulation: 'approved', fiscalSimulation: 'confirmed' });
    f.service.moveCash(f.admin, { key: key(), dayId: day.id, direction: 'out', amountOre: 6000, reason: 'Lägg i kassaskåpet' });
    const expected = 200000 + payment.amountOre + 1000 - 2900 - 6000;
    const report = f.service.report(day.id);
    expect(report).toMatchObject({ salesOre: payment.amountOre, refundsOre: 2900, tipsOre: 1000, expectedCashOre: expected });
    expect(report.training).toMatchObject({ cashDepositsOre: 50000, cashWithdrawalsOre: 6000 });
    const closed = f.service.closeDay(f.admin, day.id, { key: key(), countedCashOre: expected });
    expect(closed.report?.differenceOre).toBe(0);
    expect(closingText(closed, closed.report!)).toContain('Kontantinsättningar');
    expect(exportCsv(closed, closed.report!)).toContain('Kontanthändelser i övning');
    const second = f.open();
    f.service.moveCash(f.admin, { ...input, key: key(), dayId: second.id, amountOre: 20000 });
    expect(f.service.report(day.id)).toEqual(closed.report);
    expect(f.service.report(second.id).training).toMatchObject({ cashDepositsOre: 20000, cashWithdrawalsOre: 0 });
    expect(f.store.verifyJournal()).toBe(true);
  });

  it('kräver rätt roll, huvudkassa och öppen rätt dag samt avvisar för stort eller ogiltigt uttag', () => {
    const f = fixture();
    const input: CashMovementInput = { key: key(), dayId: 'missing', direction: 'out', amountOre: 1, reason: 'Testar kontantuttag' };
    expect(() => f.service.moveCash(f.admin, input)).toThrow('Öppna en verksamhetsdag');
    const day = f.open(); input.dayId = day.id;
    expect(() => f.service.moveCash(f.actor('waiter', 'LAGUSTOSA-TEST'), input)).toThrow('behörighet');
    expect(() => f.service.moveCash(f.actor('cashier', 'SERVERING-1'), input)).toThrow('huvudkassan');
    expect(() => f.service.moveCash(f.admin, { ...input, amountOre: 150001 })).toThrow('överstiger');
    expect(() => f.service.moveCash(f.admin, { ...input, amountOre: 0 })).toThrow();
    expect(() => f.service.moveCash(f.admin, { ...input, amountOre: -1 })).toThrow();
    expect(() => f.service.moveCash(f.admin, { ...input, amountOre: 1.5 })).toThrow();
    expect(() => f.service.moveCash(f.admin, { ...input, reason: ' ' })).toThrow();
    expect(f.store.journal().filter(entry => entry.action === 'cash.move')).toHaveLength(0);
    f.service.moveCash(f.admin, { ...input, amountOre: 150000 });
    f.service.closeDay(f.admin, day.id, { key: key(), countedCashOre: 0 });
    const second = f.open();
    expect(() => f.service.moveCash(f.admin, { ...input, key: key() })).toThrow('Verksamhetsdagen har ändrats');
    expect(f.service.report(second.id).expectedCashOre).toBe(150000);
    expect(f.service.moveCash(f.admin, { ...input, amountOre: 150000 }).dayId).toBe(day.id);
    expect(f.service.report(second.id).expectedCashOre).toBe(150000);
  });

  it('återställer både journal och idempotensnyckel när registreringen misslyckas i transaktionen', () => {
    const f = fixture(); const day = f.open();
    const input: CashMovementInput = { key: key(), dayId: day.id, direction: 'in', amountOre: 20000, reason: 'Testar återställning' };
    const originalLog = f.service.log.bind(f.service);
    const log = vi.spyOn(f.service, 'log').mockImplementation((actor, action, entity, details) => {
      originalLog(actor, action, entity, details);
      if (action === 'cash.move') throw new Error('Testfel efter journalskrivning');
    });
    expect(() => f.service.moveCash(f.admin, input)).toThrow('Testfel');
    expect(f.service.report(day.id).expectedCashOre).toBe(150000);
    expect(f.store.journal().some(entry => entry.action === 'cash.move')).toBe(false);
    log.mockRestore();
    expect(f.service.moveCash(f.admin, input).expectedCashOre).toBe(170000);
    expect(f.store.journal().filter(entry => entry.action === 'cash.move')).toHaveLength(1);
  });

  it('validerar API:t och gör samtidiga upprepade anrop till samma kontanthändelse', async () => {
    const context = await createApp({ database: ':memory:' }); apps.push(context);
    const login = await context.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { staffId: 'admin', pin: '1234', deviceCode: 'LAGUSTOSA-TEST' } });
    const cookie = `lagustosa_session=${login.cookies[0].value}`;
    const actor = context.service.session(login.cookies[0].value);
    const day = context.service.openDay(actor, { key: key(), floatOre: 10000 });
    const payload = { key: key(), dayId: day.id, direction: 'out', amountOre: 3000, reason: 'Till kassaskåp' };
    const request = { method: 'POST' as const, url: '/api/v1/cash-movements', headers: { cookie }, payload };
    expect((await context.app.inject({ ...request, headers: {} })).statusCode).toBe(401);
    expect((await context.app.inject({ ...request, payload: { ...payload, amountOre: 0 } })).statusCode).toBe(400);
    expect((await context.app.inject({ ...request, payload: { ...payload, direction: 'unknown' } })).statusCode).toBe(400);
    const [left, right] = await Promise.all([context.app.inject(request), context.app.inject(request)]);
    expect(left.statusCode).toBe(200); expect(right.statusCode).toBe(200);
    expect(left.json()).toEqual(right.json());
    expect(context.service.report(day.id).expectedCashOre).toBe(7000);
    const tooMuch = await context.app.inject({ ...request, payload: { ...payload, key: key(), amountOre: 7001 } });
    expect(tooMuch.statusCode).toBe(409); expect(tooMuch.json().code).toBe('CASH_INSUFFICIENT');
    expect(context.store.journal().filter(entry => entry.action === 'cash.move')).toHaveLength(1);
  });
});

describe('Återhämtning av kontanthändelser på enheten', () => {
  it('återanvänder samma sparade begäran efter förlorat svar och omladdning utan dubbelt kassabelopp', async () => {
    const f = fixture(); const day = f.open(); const storage = memoryStorage();
    const input: CashMovementInput = { key: key(), dayId: day.id, direction: 'in', amountOre: 20000, reason: 'Kontanter från kassaskåpet' };
    await expect(submitCashMovement(input, f.admin, storage, 'round', async request => {
      f.service.moveCash(f.admin, request);
      throw new ApiError('NETWORK', 'Förlorat svar', 0);
    })).rejects.toThrow('Förlorat svar');
    expect(readCashAttempt(f.admin, storage, 'round')).toEqual(input);
    const reloaded = readCashAttempt(f.admin, storage, 'round')!;
    await expect(submitCashMovement({ ...reloaded, amountOre: 30000 }, f.admin, storage, 'round', async request => f.service.moveCash(f.admin, request))).rejects.toThrow('sparade kontanthändelsen');
    const result = await submitCashMovement(reloaded, f.admin, storage, 'round', async request => f.service.moveCash(f.admin, request));
    expect(result.expectedCashOre).toBe(170000);
    expect(f.service.report(day.id).expectedCashOre).toBe(170000);
    expect(f.store.journal().filter(entry => entry.action === 'cash.move')).toHaveLength(1);
    expect(readCashAttempt(f.admin, storage, 'round')).toBeNull();
  });

  it('behåller oklar eller utloggad registrering men frigör uttryckligt avvisat uttag', async () => {
    const f = fixture(); const day = f.open(); const storage = memoryStorage();
    const input: CashMovementInput = { key: key(), dayId: day.id, direction: 'out', amountOre: 160000, reason: 'För stort uttag' };
    await expect(submitCashMovement(input, f.admin, storage, 'round', async () => { throw new ApiError('UNAUTHORIZED', 'Logga in', 401); })).rejects.toThrow('Logga in');
    expect(readCashAttempt(f.admin, storage, 'round')).toEqual(input);
    await expect(submitCashMovement(input, f.admin, storage, 'round', async () => { throw new ApiError('CASH_INSUFFICIENT', 'För stort', 409); })).rejects.toThrow('För stort');
    expect(readCashAttempt(f.admin, storage, 'round')).toBeNull();
  });

  it('skickar ingenting om lagringen är trasig eller inte kan bevara nyckeln', async () => {
    const f = fixture(); const day = f.open(); const send = vi.fn(); const storage = memoryStorage();
    const input: CashMovementInput = { key: key(), dayId: day.id, direction: 'in', amountOre: 20000, reason: 'Testar lagringsfel' };
    const broken = { ...storage, setItem: () => {} };
    await expect(submitCashMovement(input, f.admin, broken, 'round', send)).rejects.toThrow('kunde inte sparas');
    storage.setItem(cashAttemptKey(f.admin, 'round'), '{broken');
    await expect(submitCashMovement(input, f.admin, storage, 'round', send)).rejects.toThrow('kunde inte läsas');
    expect(send).not.toHaveBeenCalled();
  });
});
