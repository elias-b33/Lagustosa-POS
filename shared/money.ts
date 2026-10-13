import type { CalculatedLine, Payment, Tab, TabTotals, TaxClass, TaxRule, ServiceMode } from './types';

export function roundRatio(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) throw new Error('Ogiltig beloppsberäkning');
  return Number((BigInt(numerator) * 2n + BigInt(denominator)) / (BigInt(denominator) * 2n));
}

export function distribute(amount: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(amount) || amount < 0 || weights.some(weight => !Number.isSafeInteger(weight) || weight < 0)) throw new Error('Ogiltig fördelning');
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total === 0) {
    if (amount !== 0) throw new Error('Saknar belopp att fördela');
    return weights.map(() => 0);
  }
  const portions = weights.map((weight, index) => {
    const numerator = BigInt(amount) * BigInt(weight);
    return { index, value: Number(numerator / BigInt(total)), remainder: numerator % BigInt(total) };
  });
  const remainder = amount - portions.reduce((sum, portion) => sum + portion.value, 0);
  const sorted = [...portions].sort((left, right) => left.remainder === right.remainder ? left.index - right.index : left.remainder > right.remainder ? -1 : 1);
  for (let index = 0; index < remainder; index++) sorted[index].value++;
  return portions.map(portion => portion.value);
}

export function calculateTab(tab: Tab): TabTotals {
  const active = tab.lines.filter(line => line.status !== 'void');
  const originals = active.map(line => line.unitPriceOre * line.quantity);
  const originalOre = originals.reduce((sum, amount) => sum + amount, 0);
  const discountOre = roundRatio(originalOre * tab.discountBps, 10000);
  const discounts = distribute(discountOre, originals);
  const lines: CalculatedLine[] = active.map((line, index) => {
    const grossOre = originals[index] - discounts[index];
    return { lineId: line.id, originalOre: originals[index], discountOre: discounts[index], grossOre, vatOre: roundRatio(grossOre * line.vatBps, 10000 + line.vatBps), vatBps: line.vatBps };
  });
  return { originalOre, discountOre, grossOre: originalOre - discountOre, vatOre: lines.reduce((sum, line) => sum + line.vatOre, 0), lines };
}

export function taxRate(rules: TaxRule[], taxClass: TaxClass, mode: ServiceMode, date: string): number {
  const candidates = rules.filter(rule => rule.taxClass === taxClass && rule.mode === mode && rule.from <= date && (!rule.until || rule.until >= date)).sort((left, right) => right.from.localeCompare(left.from));
  if (!candidates.length) throw new Error('Momsregel saknas för artikel och datum');
  return candidates[0].rateBps;
}

export function paidOre(payments: Payment[], tabId: string): number {
  return payments.filter(payment => payment.tabId === tabId && payment.kind === 'sale' && payment.status === 'approved').reduce((sum, payment) => sum + payment.amountOre, 0);
}

export function reservedOre(payments: Payment[], tabId: string): number {
  return payments.filter(payment => payment.tabId === tabId && payment.kind === 'sale' && ['approved', 'pending', 'unknown'].includes(payment.status)).reduce((sum, payment) => sum + payment.amountOre, 0);
}

export function money(amountOre: number): string {
  return new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', minimumFractionDigits: amountOre % 100 === 0 ? 0 : 2 }).format(amountOre / 100);
}

export function parseMoney(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount <= 100000000 ? amount : null;
}
