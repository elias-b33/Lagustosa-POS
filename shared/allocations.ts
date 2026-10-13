import { calculateTab } from './money';
import type { Allocation, Payment, Tab } from './types';

export type RationalQuantity = NonNullable<Allocation['quantity']>;

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}

/** JSON-safe exact quantities. Fractions are reduced, never rounded to decimals. */
export function rationalQuantity(numerator: bigint | number | string, denominator: bigint | number | string = 1): RationalQuantity {
  if (typeof numerator === 'number' && !Number.isSafeInteger(numerator) || typeof denominator === 'number' && !Number.isSafeInteger(denominator)) throw new Error('Ogiltigt artikelantal.');
  const top = BigInt(numerator), bottom = BigInt(denominator);
  if (top < 0n || bottom <= 0n) throw new Error('Ogiltigt artikelantal.');
  const divisor = greatestCommonDivisor(top, bottom);
  return { numerator: String(top / divisor), denominator: String(bottom / divisor) };
}

export function allocationQuantity(allocation: Pick<Allocation, 'quantity'>): RationalQuantity | null {
  const value = allocation.quantity;
  if (!value || typeof value.numerator !== 'string' || typeof value.denominator !== 'string' || !/^(0|[1-9]\d*)$/.test(value.numerator) || !/^[1-9]\d*$/.test(value.denominator)) return null;
  return rationalQuantity(value.numerator, value.denominator);
}

export function addQuantities(left: RationalQuantity, right: RationalQuantity): RationalQuantity {
  return rationalQuantity(BigInt(left.numerator) * BigInt(right.denominator) + BigInt(right.numerator) * BigInt(left.denominator), BigInt(left.denominator) * BigInt(right.denominator));
}

export function subtractQuantities(left: RationalQuantity, right: RationalQuantity): RationalQuantity {
  return rationalQuantity(BigInt(left.numerator) * BigInt(right.denominator) - BigInt(right.numerator) * BigInt(left.denominator), BigInt(left.denominator) * BigInt(right.denominator));
}

export function compareQuantities(left: RationalQuantity, right: RationalQuantity): number {
  const difference = BigInt(left.numerator) * BigInt(right.denominator) - BigInt(right.numerator) * BigInt(left.denominator);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function scaleQuantity(value: RationalQuantity, numerator: number | bigint, denominator: number | bigint): RationalQuantity {
  const factor = rationalQuantity(numerator, denominator);
  return rationalQuantity(BigInt(value.numerator) * BigInt(factor.numerator), BigInt(value.denominator) * BigInt(factor.denominator));
}

export function sumQuantities(values: RationalQuantity[]): RationalQuantity {
  return values.reduce(addQuantities, rationalQuantity(0));
}

export function quantityLabel(value: RationalQuantity): string {
  const reduced = rationalQuantity(value.numerator, value.denominator);
  return reduced.denominator === '1' ? reduced.numerator : `${reduced.numerator}/${reduced.denominator}`;
}

function validOre(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }

/** Pending/unknown reservations count too. Missing legacy metadata stays unknown. */
export function remainingAllocation(source: Allocation, used: Allocation[]): Allocation {
  const grossOre = source.grossOre - used.reduce((sum, row) => sum + row.grossOre, 0);
  const vatOre = source.vatOre - used.reduce((sum, row) => sum + row.vatOre, 0);
  if (!validOre(grossOre) || !validOre(vatOre) || vatOre > grossOre) throw new Error('Artikelns beloppshistorik stämmer inte.');
  const originalQuantity = allocationQuantity(source);
  const usedQuantities = used.map(allocationQuantity);
  const quantity = originalQuantity && usedQuantities.every(value => value !== null)
    ? subtractQuantities(originalQuantity, sumQuantities(usedQuantities)) : null;
  const quantityBasis = quantity && source.quantityBasis
    ? (source.quantityBasis === 'amount-share' || used.some(row => row.quantityBasis === 'amount-share') ? 'amount-share' : 'items') : undefined;
  const discountOre = validOre(source.discountOre) && used.every(row => validOre(row.discountOre))
    ? source.discountOre - used.reduce((sum, row) => sum + row.discountOre!, 0) : undefined;
  if (discountOre !== undefined && !validOre(discountOre)) throw new Error('Artikelns rabatthistorik stämmer inte.');
  return {
    lineId: source.lineId, grossOre, vatOre, vatBps: source.vatBps,
    ...(quantity ? { quantity } : {}), ...(quantityBasis ? { quantityBasis } : {}),
    ...(discountOre !== undefined ? { discountOre } : {}),
  };
}

function vatPortion(balance: Allocation, grossOre: number): number {
  if (grossOre === 0) return 0;
  // Allocate the *remaining* VAT; a declined reservation may have changed its
  // ratio. BigInt keeps multiplication exact even for very large fractions.
  const numerator = BigInt(balance.vatOre) * BigInt(grossOre);
  return Number((numerator * 2n + BigInt(balance.grossOre)) / (BigInt(balance.grossOre) * 2n));
}

/** The quantity is an economic share when an arbitrary amount is selected. */
export function allocateAmount(balance: Allocation, grossOre: number): Allocation {
  if (!validOre(grossOre) || grossOre > balance.grossOre) throw new Error('Beloppet överstiger artikelns återstående belopp.');
  const available = allocationQuantity(balance);
  const whole = grossOre === balance.grossOre;
  const quantity = available ? whole ? available : scaleQuantity(available, grossOre, balance.grossOre) : null;
  const discountOre = balance.discountOre === undefined ? undefined : whole ? balance.discountOre
    : Number(BigInt(balance.discountOre) * BigInt(grossOre) / BigInt(balance.grossOre));
  return {
    lineId: balance.lineId, grossOre, vatOre: vatPortion(balance, grossOre), vatBps: balance.vatBps,
    ...(quantity ? { quantity, quantityBasis: whole && balance.quantityBasis === 'items' ? 'items' as const : 'amount-share' as const } : {}),
    ...(discountOre !== undefined ? { discountOre } : {}),
  };
}

/** Explicit items take the matching share of the remaining original amounts.
 * Any fractional öre stays with the remaining items, including a one-öre row
 * shared by several items. The final item receives the exact balance. */
export function allocateQuantity(balance: Allocation, quantity: RationalQuantity): Allocation {
  const available = allocationQuantity(balance);
  if (!available || compareQuantities(quantity, rationalQuantity(0)) <= 0 || compareQuantities(quantity, available) > 0) throw new Error('Antalet överstiger artikelns återstående antal.');
  const numerator = BigInt(quantity.numerator) * BigInt(available.denominator);
  const denominator = BigInt(quantity.denominator) * BigInt(available.numerator);
  const grossOre = Number(BigInt(balance.grossOre) * numerator / denominator);
  const discountOre = balance.discountOre === undefined ? undefined
    : Number(BigInt(balance.grossOre + balance.discountOre) * numerator / denominator) - grossOre;
  return {
    lineId: balance.lineId, grossOre, vatOre: vatPortion(balance, grossOre), vatBps: balance.vatBps,
    quantity: rationalQuantity(quantity.numerator, quantity.denominator), quantityBasis: balance.quantityBasis ?? 'amount-share',
    ...(discountOre !== undefined ? { discountOre } : {}),
  };
}

/** A paid amount alone cannot close a tab while free/rounded items remain. */
export function isTabQuantitySettled(tab: Tab, payments: Payment[]): boolean {
  const allocations = payments.filter(payment => payment.tabId === tab.id && payment.kind === 'sale' && payment.status === 'approved').flatMap(payment => payment.allocations);
  return calculateTab(tab).lines.every(total => {
    const line = tab.lines.find(candidate => candidate.id === total.lineId)!;
    const settled = allocations.filter(allocation => allocation.lineId === line.id);
    if (settled.length === 0 || settled.reduce((sum, allocation) => sum + allocation.grossOre, 0) !== total.grossOre) return false;
    const quantities = settled.map(allocationQuantity);
    // Existing receipts are immutable. Do not manufacture quantities during
    // migration; legacy tabs retain their existing amount-based completion.
    return quantities.some(quantity => quantity === null) || compareQuantities(sumQuantities(quantities as RationalQuantity[]), rationalQuantity(line.quantity)) === 0;
  });
}
