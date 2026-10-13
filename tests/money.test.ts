import { describe, expect, it } from 'vitest';
import { calculateTab, distribute, parseMoney, taxRate } from '../shared/money';
import { initialSettings } from '../server/seed';
import type { Tab } from '../shared/types';

describe('Belopp och moms', () => {
  it('fördelar varje öre utan att skapa eller tappa pengar', () => {
    for (const amount of [0, 1, 2, 99, 100, 10001, 100000000]) {
      for (const weights of [[1, 1, 1], [5, 0, 9, 1], [12, 25, 6], [99]]) {
        const shares = distribute(amount, weights);
        expect(shares.reduce((sum, share) => sum + share, 0)).toBe(amount);
        expect(shares.every(share => Number.isInteger(share) && share >= 0)).toBe(true);
        weights.forEach((weight, index) => { if (!weight) expect(shares[index]).toBe(0); });
      }
    }
    expect(distribute(1000, [1, 1, 1])).toEqual([334, 333, 333]);
  });

  it('räknar blandad moms och fördelar en rabatt över artiklarna', () => {
    const tab = { discountBps: 1000, lines: [
      { id: 'food', unitPriceOre: 10000, quantity: 1, vatBps: 1200, status: 'sent' },
      { id: 'wine', unitPriceOre: 5000, quantity: 2, vatBps: 2500, status: 'sent' },
      { id: 'void', unitPriceOre: 90000, quantity: 1, vatBps: 2500, status: 'void' },
    ] } as unknown as Tab;
    const result = calculateTab(tab);
    expect(result.originalOre).toBe(20000);
    expect(result.discountOre).toBe(2000);
    expect(result.grossOre).toBe(18000);
    expect(result.lines.map(line => line.grossOre)).toEqual([9000, 9000]);
    expect(result.vatOre).toBe(964 + 1800);
  });

  it.each([
    ['2026-03-31', 'takeaway', 1200], ['2026-04-01', 'takeaway', 600],
    ['2027-12-31', 'takeaway', 600], ['2028-01-01', 'takeaway', 1200],
    ['2026-10-13', 'dine_in', 1200],
  ] as const)('använder datumregeln %s för %s', (date, mode, expected) => {
    expect(taxRate(initialSettings.taxRules, 'food', mode, date)).toBe(expected);
    expect(taxRate(initialSettings.taxRules, 'alcohol', mode, date)).toBe(2500);
  });

  it('tolkar svenska belopp utan flyttalsavrundning och avvisar ogiltiga värden', () => {
    expect(parseMoney('123,45')).toBe(12345);
    expect(parseMoney('0.01')).toBe(1);
    expect(parseMoney(' 12 ')).toBe(1200);
    for (const value of ['', '-1', '1,001', '1e3', 'NaN', '1 000', '1000001']) expect(parseMoney(value)).toBeNull();
  });
});
