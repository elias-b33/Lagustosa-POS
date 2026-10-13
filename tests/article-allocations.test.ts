import { describe, expect, it } from 'vitest';
import type { PaymentAdapter } from '../server/adapters';
import { Store } from '../server/db';
import { KassaService } from '../server/service';
import { addQuantities, allocationQuantity, compareQuantities, isTabQuantitySettled, quantityLabel, rationalQuantity, remainingAllocation, sumQuantities } from '../shared/allocations';
import { paymentSchema, refundSchema, type RefundInput } from '../shared/payment-inputs';
import { receiptRows } from '../shared/receipts';
import type { Allocation, Payment, PaymentStatus, Receipt } from '../shared/types';
import { fixture, key } from './helpers';

function refundInput(input: Partial<RefundInput> = {}): RefundInput {
  return { key: key(), reason: 'Test av artikelretur', simulation: 'approved', fiscalSimulation: 'confirmed', ...input };
}

function mixedTab(f: ReturnType<typeof fixture>) {
  f.open(); const tab = f.tab();
  const bread = f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 3, guest: 1 }).lines.at(-1)!;
  f.command(tab.id, { action: 'price', lineId: bread.id, priceOre: 101, reason: 'Öresgränser i test' });
  const wine = f.command(tab.id, { action: 'add', itemId: 'redwine', quantity: 2, guest: 2 }).lines.at(-1)!;
  f.command(tab.id, { action: 'price', lineId: wine.id, priceOre: 103, reason: 'Öresgränser i test' });
  f.command(tab.id, { action: 'discount', discountBps: 1733, reason: 'Ojämn rabattfördelning' });
  f.command(tab.id, { action: 'send' });
  return { tab, breadId: bread.id, wineId: wine.id };
}

function assertExactSettlement(payments: Payment[], expected: { lineId: string; quantity: number; grossOre: number; vatOre: number; discountOre: number }[]) {
  const rows = payments.filter(payment => payment.status === 'approved').flatMap(payment => payment.allocations);
  for (const source of expected) {
    const actual = rows.filter(row => row.lineId === source.lineId);
    expect(actual.reduce((sum, row) => sum + row.grossOre, 0)).toBe(source.grossOre);
    expect(actual.reduce((sum, row) => sum + row.vatOre, 0)).toBe(source.vatOre);
    expect(actual.reduce((sum, row) => sum + row.discountOre!, 0)).toBe(source.discountOre);
    expect(actual.every(row => allocationQuantity(row) !== null)).toBe(true);
    expect(sumQuantities(actual.map(row => allocationQuantity(row)!))).toEqual(rationalQuantity(source.quantity));
    expect(actual.every(row => row.vatOre >= 0 && row.vatOre <= row.grossOre && row.discountOre! >= 0)).toBe(true);
  }
}

describe('Exakta artikelandelar, kronor och moms', () => {
  it('lagrar och summerar rationella antal utan förlust över JavaScripts heltalsgräns', () => {
    const one = rationalQuantity('1', '9007199254740997');
    const rest = rationalQuantity('9007199254740996', '9007199254740997');
    expect(addQuantities(one, rest)).toEqual({ numerator: '1', denominator: '1' });
    expect(quantityLabel(rationalQuantity(14, 21))).toBe('2/3');
    expect(allocationQuantity({ quantity: { numerator: '1.5', denominator: '1' } })).toBeNull();
    expect(allocationQuantity({})).toBeNull();
    expect(() => rationalQuantity(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it('bevarar båda momssatser, rabatt och artikelantal genom många delbelopp', async () => {
    const f = fixture(); const { tab, breadId, wineId } = mixedTab(f);
    // Independent amounts: 303 + 206, discount 88 -> 251 at 12%, 170 at 25%.
    const payments: Payment[] = [];
    for (const amountOre of [1, 7, 19, 53, 101]) payments.push(await f.pay(tab.id, { amountOre }));
    payments.push(await f.pay(tab.id));
    assertExactSettlement(payments, [
      { lineId: breadId, quantity: 3, grossOre: 251, vatOre: 27, discountOre: 52 },
      { lineId: wineId, quantity: 2, grossOre: 170, vatOre: 34, discountOre: 36 },
    ]);
    expect(payments[0].allocations[0].quantityBasis).toBe('amount-share');
    expect(f.service.tab(tab.id).status).toBe('paid');
    expect(f.store.verifyJournal()).toBe(true);
  });

  it('betalar ett av tre exemplar med korrekt antal och sparar sista öret till resterande exemplar', async () => {
    const f = fixture(); const { tab, breadId, wineId } = mixedTab(f);
    const first = await f.pay(tab.id, { items: [{ lineId: breadId, quantity: 1 }] });
    expect(first.allocations).toEqual([{ lineId: breadId, grossOre: 83, vatOre: 9, vatBps: 1200, quantity: rationalQuantity(1), quantityBasis: 'items', discountOre: 18 }]);
    const receipt = f.store.all<Receipt>('receipt').find(row => row.paymentId === first.id)!;
    expect(receiptRows(receipt)[0].label).toBe('1 × Vitlöksbröd');
    expect(receiptRows(receipt)[0].details).toContain('Rabatt: 0,18 kr');
    await expect(f.pay(tab.id, { items: [{ lineId: breadId, quantity: 3 }] })).rejects.toMatchObject({ code: 'QUANTITY_EXCEEDED' });
    await expect(f.pay(tab.id, { items: [{ lineId: breadId, quantity: 1 }], amountOre: 85 })).rejects.toMatchObject({ code: 'ITEM_AMOUNT_MISMATCH' });
    const final = await f.pay(tab.id, { items: [{ lineId: breadId, quantity: 2 }, { lineId: wineId, quantity: 2 }] });
    expect(final.amountOre).toBe(338);
    assertExactSettlement([first, final], [
      { lineId: breadId, quantity: 3, grossOre: 251, vatOre: 27, discountOre: 52 },
      { lineId: wineId, quantity: 2, grossOre: 170, vatOre: 34, discountOre: 36 },
    ]);
  });

  it.each(['declined', 'cancelled'] as const)('frigör exakt antal och moms när ett tidigare samtidighetsförsök blir %s', async status => {
    let finish!: (status: PaymentStatus) => void;
    let calls = 0;
    const adapter: PaymentAdapter = {
      kind: 'simulator', start: async () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : 'approved',
      status: async () => 'unknown', cancel: async () => 'cancelled', refund: async () => 'approved',
    };
    const f = fixture({ payment: adapter }); const { tab, breadId, wineId } = mixedTab(f);
    const pending = f.pay(tab.id, { items: [{ lineId: breadId, quantity: 1 }] });
    const second = await f.pay(tab.id, { items: [{ lineId: breadId, quantity: 1 }] }, f.actor('waiter', 'SERVERING-1'));
    await expect(f.pay(tab.id, { items: [{ lineId: breadId, quantity: 2 }] })).rejects.toMatchObject({ code: 'QUANTITY_EXCEEDED' });
    finish(status); const failed = await pending;
    const third = await f.pay(tab.id, { amountOre: 7 });
    const final = await f.pay(tab.id);
    assertExactSettlement([failed, second, third, final], [
      { lineId: breadId, quantity: 3, grossOre: 251, vatOre: 27, discountOre: 52 },
      { lineId: wineId, quantity: 2, grossOre: 170, vatOre: 34, discountOre: 36 },
    ]);
    expect(f.store.all<Receipt>('receipt').some(row => row.paymentId === failed.id)).toBe(false);
  });

  it('reserverar rätt antal över okänt svar, dubbeltryck och omstart', async () => {
    const f = fixture({}, true); const { tab, breadId } = mixedTab(f);
    const attempt = { key: key(), items: [{ lineId: breadId, quantity: 2 }], simulation: 'unknown' as const };
    const pending = await f.pay(tab.id, attempt);
    expect((await f.pay(tab.id, attempt)).id).toBe(pending.id);
    f.store.close(); const reopened = new Store(f.filename);
    try {
      const restarted = new KassaService(reopened);
      const input = { key: key(), version: restarted.tab(tab.id).version, method: 'card' as const, tipOre: 0, simulation: 'approved' as const, fiscalSimulation: 'confirmed' as const, items: [{ lineId: breadId, quantity: 2 }] };
      await expect(restarted.startPayment(f.admin, tab.id, input)).rejects.toMatchObject({ code: 'QUANTITY_EXCEEDED' });
      await Promise.all([restarted.checkPayment(f.admin, pending.id), restarted.checkPayment(f.admin, pending.id)]);
      expect(reopened.all<Receipt>('receipt').filter(receipt => receipt.paymentId === pending.id)).toHaveLength(1);
      expect(reopened.get<Payment>('payment', pending.id)?.allocations[0].quantity).toEqual(rationalQuantity(2));
    } finally { reopened.close(); }
  });

  it('betalar tre starkt rabatterade exemplar för totalt ett öre utan borttappat antal', async () => {
    const f = fixture(); f.open(); const tab = f.tab();
    const line = f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 3 }).lines[0];
    f.command(tab.id, { action: 'price', lineId: line.id, priceOre: 1, reason: 'Test av gränsöre' });
    f.command(tab.id, { action: 'discount', discountBps: 6667, reason: 'Test av rabattavrundning' });
    f.command(tab.id, { action: 'send' });
    const first = await f.pay(tab.id, { items: [{ lineId: line.id, quantity: 1 }] });
    const second = await f.pay(tab.id, { items: [{ lineId: line.id, quantity: 1 }] });
    expect(f.service.tab(tab.id).status).toBe('open');
    const final = await f.pay(tab.id, { items: [{ lineId: line.id, quantity: 1 }] });
    expect([first.amountOre, second.amountOre, final.amountOre]).toEqual([0, 0, 1]);
    assertExactSettlement([first, second, final], [{ lineId: line.id, quantity: 3, grossOre: 1, vatOre: 0, discountOre: 2 }]);
    expect(f.service.tab(tab.id).status).toBe('paid');
  });
});

describe('Artikelval vid retur', () => {
  it('returnerar just vinet i två omgångar utan att återföra matens moms eller rabatt', async () => {
    const f = fixture(); const { tab, breadId, wineId } = mixedTab(f);
    const sale = await f.pay(tab.id);
    const first = await f.service.refund(f.admin, sale.id, refundInput({ items: [{ lineId: wineId, quantity: 1 }] }));
    expect(first.allocations).toEqual([{ lineId: wineId, grossOre: 85, vatOre: 17, vatBps: 2500, quantity: rationalQuantity(1), quantityBasis: 'items', discountOre: 18 }]);
    const second = await f.service.refund(f.admin, sale.id, refundInput({ lineIds: [wineId] }));
    expect(second.allocations).toEqual(first.allocations);
    await expect(f.service.refund(f.admin, sale.id, refundInput({ items: [{ lineId: wineId, quantity: 1 }] }))).rejects.toMatchObject({ code: 'QUANTITY_EXCEEDED' });
    await expect(f.service.refund(f.admin, sale.id, refundInput({ lineIds: [wineId], amountOre: 1 }))).rejects.toThrow('återstår att återbetala');
    const bread = await f.service.refund(f.admin, sale.id, refundInput({ items: [{ lineId: breadId, quantity: 3 }] }));
    expect(bread.amountOre).toBe(251);
    assertExactSettlement([first, second, bread], [
      { lineId: breadId, quantity: 3, grossOre: 251, vatOre: 27, discountOre: 52 },
      { lineId: wineId, quantity: 2, grossOre: 170, vatOre: 34, discountOre: 36 },
    ]);
    const report = f.service.report(f.service.currentDay()!.id);
    expect(report.netOre).toBe(0); expect(report.vatOre).toBe(0);
  });

  it('begränsar en beloppsretur till valda kvittorader och bevarar exakt artikelandel', async () => {
    const f = fixture(); const { tab, breadId, wineId } = mixedTab(f); const sale = await f.pay(tab.id);
    const first = await f.service.refund(f.admin, sale.id, refundInput({ lineIds: [wineId], amountOre: 10 }));
    expect(first.allocations).toHaveLength(1);
    expect(first.allocations[0]).toMatchObject({ lineId: wineId, grossOre: 10, vatOre: 2, quantity: rationalQuantity(2, 17), quantityBasis: 'amount-share' });
    const rest = await f.service.refund(f.admin, sale.id, refundInput({ lineIds: [wineId] }));
    expect(rest.allocations[0].quantity).toEqual(rationalQuantity(32, 17));
    expect(first.allocations.concat(rest.allocations).some(row => row.lineId === breadId)).toBe(false);
    expect(sumQuantities([first.allocations[0].quantity!, rest.allocations[0].quantity!])).toEqual(rationalQuantity(2));
    await expect(f.service.refund(f.admin, sale.id, refundInput({ items: [{ lineId: breadId, quantity: 1 }], amountOre: 84 }))).rejects.toMatchObject({ code: 'ITEM_AMOUNT_MISMATCH' });
    await expect(f.service.refund(f.admin, sale.id, refundInput({ lineIds: ['annan-nota'], amountOre: 1 }))).rejects.toThrow('originalkvittot');
    await expect(f.service.refund(f.admin, sale.id, refundInput({ lineIds: [breadId, breadId] }))).rejects.toThrow('originalkvittot');
  });

  it('tar med gratisartiklar vid uttryckligt artikelval och kan returnera dem en gång vardera', async () => {
    const f = fixture(); f.open(); const tab = f.tab();
    const line = f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 2 }).lines[0];
    f.command(tab.id, { action: 'discount', discountBps: 10000, reason: 'Alla artiklar bjuds i test' });
    f.command(tab.id, { action: 'send' });
    const first = await f.pay(tab.id, { items: [{ lineId: line.id, quantity: 1 }] });
    expect(first.amountOre).toBe(0);
    expect(f.service.tab(tab.id).status).toBe('open');
    expect(isTabQuantitySettled(f.service.tab(tab.id), [first])).toBe(false);
    const second = await f.pay(tab.id, { items: [{ lineId: line.id, quantity: 1 }] });
    expect(f.service.tab(tab.id).status).toBe('paid');
    expect(first.allocations[0].discountOre).toBe(7900);
    expect(second.allocations[0].quantity).toEqual(rationalQuantity(1));
    const returned = await f.service.refund(f.admin, first.id, refundInput({ items: [{ lineId: line.id, quantity: 1 }] }));
    expect(returned.amountOre).toBe(0);
    expect(returned.allocations[0]).toMatchObject({ quantity: rationalQuantity(1), discountOre: 7900, grossOre: 0, vatOre: 0 });
    await expect(f.service.refund(f.admin, first.id, refundInput({ lineIds: [line.id] }))).rejects.toThrow('återstår att återbetala');
    const last = await f.service.refund(f.admin, second.id, refundInput({ lineIds: [line.id] }));
    expect(last.allocations[0].quantity).toEqual(rationalQuantity(1));
    expect(f.store.verifyJournal()).toBe(true);
  });

  it('förhindrar överretur under parallella försök och frigör antal efter nekat svar', async () => {
    let finish!: (status: PaymentStatus) => void;
    let calls = 0;
    const adapter: PaymentAdapter = {
      kind: 'simulator', start: async () => 'approved', status: async () => 'unknown', cancel: async () => 'cancelled',
      refund: async () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : 'approved',
    };
    const f = fixture({ payment: adapter }); const { tab, breadId } = mixedTab(f); const sale = await f.pay(tab.id);
    const input = refundInput({ items: [{ lineId: breadId, quantity: 2 }] });
    const pending = f.service.refund(f.admin, sale.id, input);
    expect((await f.service.refund(f.admin, sale.id, input)).status).toBe('pending');
    await expect(f.service.refund(f.admin, sale.id, refundInput({ items: [{ lineId: breadId, quantity: 2 }] }))).rejects.toMatchObject({ code: 'QUANTITY_EXCEEDED' });
    const one = await f.service.refund(f.admin, sale.id, refundInput({ items: [{ lineId: breadId, quantity: 1 }] }));
    finish('declined'); await pending;
    const final = await f.service.refund(f.admin, sale.id, refundInput({ items: [{ lineId: breadId, quantity: 2 }] }));
    assertExactSettlement([one, final], [{ lineId: breadId, quantity: 3, grossOre: 251, vatOre: 27, discountOre: 52 }]);
    expect(f.store.all<Receipt>('receipt').filter(receipt => receipt.kind === 'refund')).toHaveLength(2);
  });
});

describe('Äldre kvitton och indata', () => {
  it('hittar inte på saknade mängder när äldre delbetalningar betalas klart eller returneras', async () => {
    const f = fixture(); const { tab, breadId, wineId } = mixedTab(f);
    const legacy: Payment = {
      id: key(), key: key(), fingerprint: 'legacy-fixture', tabId: tab.id, dayId: tab.dayId, kind: 'sale', parentId: null,
      method: 'card', status: 'approved', amountOre: 100, tipOre: 0, allocations: [{ lineId: breadId, grossOre: 100, vatOre: 11, vatBps: 1200 }],
      tenderedOre: null, changeOre: 0, reason: '', simulation: 'approved', fiscalSimulation: 'confirmed',
      createdAt: '2026-10-13T20:00:00Z', updatedAt: '2026-10-13T20:00:00Z', staffId: f.admin.staff.id, deviceId: f.admin.device.id,
    };
    f.store.put('payment', legacy);
    const before = JSON.stringify(f.store.get('payment', legacy.id));
    await expect(f.pay(tab.id, { items: [{ lineId: breadId, quantity: 1 }] })).rejects.toMatchObject({ code: 'QUANTITY_HISTORY_MISSING' });
    await expect(f.service.refund(f.admin, legacy.id, refundInput({ items: [{ lineId: breadId, quantity: 1 }] }))).rejects.toMatchObject({ code: 'QUANTITY_HISTORY_MISSING' });
    const rest = await f.pay(tab.id);
    expect(rest.allocations.find(row => row.lineId === breadId)?.quantity).toBeUndefined();
    expect(rest.allocations.find(row => row.lineId === breadId)?.discountOre).toBeUndefined();
    expect(rest.allocations.find(row => row.lineId === wineId)?.quantity).toEqual(rationalQuantity(2));
    expect(f.service.tab(tab.id).status).toBe('paid');
    const returned = await f.service.refund(f.admin, legacy.id, refundInput({ lineIds: [breadId], amountOre: 100 }));
    expect(returned.allocations[0].quantity).toBeUndefined();
    expect(JSON.stringify(f.store.get('payment', legacy.id))).toBe(before);
    const receipt = f.store.all<Receipt>('receipt').find(receipt => receipt.paymentId === returned.id)!;
    expect(receiptRows(receipt)[0].label).toBe('Delretur av 3 × Vitlöksbröd');
    expect(receiptRows(receipt)[0].details).toContain('Äldre kvitto: separat artikelantal per betalning saknas.');
  });

  it('bevarar okänd historik även om själva ursprungsraden har känt antal', () => {
    const original: Allocation = { lineId: 'a', grossOre: 100, vatOre: 11, vatBps: 1200, quantity: rationalQuantity(2), quantityBasis: 'items', discountOre: 10 };
    const balance = remainingAllocation(original, [{ lineId: 'a', grossOre: 50, vatOre: 6, vatBps: 1200 }]);
    expect(balance).toEqual({ lineId: 'a', grossOre: 50, vatOre: 5, vatBps: 1200 });
    expect(compareQuantities(rationalQuantity(1, 3), rationalQuantity(33, 100))).toBe(1);
  });

  it('kräver unika heltalsartiklar och avvisar tvetydiga urval innan de når betalning', () => {
    const base = { key: key(), version: 1, method: 'card', tipOre: 0, simulation: 'approved' };
    expect(paymentSchema.safeParse({ ...base, items: [{ lineId: 'a', quantity: 1.5 }] }).success).toBe(false);
    expect(paymentSchema.safeParse({ ...base, items: [{ lineId: 'a', quantity: 1 }, { lineId: 'a', quantity: 1 }] }).success).toBe(false);
    expect(paymentSchema.safeParse({ ...base, items: [{ lineId: 'a', quantity: 1 }], guest: 1 }).success).toBe(false);
    expect(refundSchema.safeParse(refundInput({ items: [{ lineId: 'a', quantity: 1 }], lineIds: ['a'] })).success).toBe(false);
    expect(refundSchema.safeParse(refundInput()).success).toBe(false);
    expect(refundSchema.safeParse(refundInput({ items: [{ lineId: 'a', quantity: 1 }], amountOre: 0 })).success).toBe(true);
  });
});
