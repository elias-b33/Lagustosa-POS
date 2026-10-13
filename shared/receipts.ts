import { calculateTab, money } from './money';
import type { Receipt } from './types';

export const receiptMethodNames = { card: 'Kort', swish: 'Swish', cash: 'Kontanter' };
export const vatRateLabel = (rateBps: number): string => `${String(rateBps / 100).replace('.', ',')} %`;

// A payment can settle an amount of a row without settling an integer number
// of items. Keep the original quantity as a reference, never as a new sale.
export function receiptRows(receipt: Receipt) {
  const totals = calculateTab(receipt.tab);
  return receipt.payment.allocations.map(allocation => {
    const line = receipt.tab.lines.find(candidate => candidate.id === allocation.lineId);
    const total = totals.lines.find(candidate => candidate.lineId === allocation.lineId);
    if (!line || !total) throw new Error('Kvittots artikelunderlag saknas.');
    const wholeRow = allocation.grossOre === total.grossOre;
    const item = `${line.quantity} × ${line.name}`;
    return {
      lineId: line.id, grossOre: allocation.grossOre,
      label: wholeRow ? item : `${receipt.kind === 'refund' ? 'Delretur' : 'Delbelopp'} av ${item}`,
      details: [
        wholeRow ? `À ${money(line.unitPriceOre)}` : `Referens: hela raden ${money(total.grossOre)} · à ${money(line.unitPriceOre)}`,
        ...(total.discountOre > 0 ? [`${wholeRow ? 'Rabatt' : 'Rabatt på referensraden'}: ${money(total.discountOre)}`] : []),
        `Gäst ${line.guest || 'gemensamt'}`,
        ...line.modifiers.map(modifier => `+ ${modifier.name}`),
      ],
    };
  });
}

export function receiptVat(receipt: Receipt) {
  const rates = new Map<number, { vatBps: number; grossOre: number; vatOre: number; netOre: number }>();
  for (const allocation of receipt.payment.allocations) {
    const row = rates.get(allocation.vatBps) ?? { vatBps: allocation.vatBps, grossOre: 0, vatOre: 0, netOre: 0 };
    row.grossOre += allocation.grossOre;
    row.vatOre += allocation.vatOre;
    row.netOre += allocation.grossOre - allocation.vatOre;
    rates.set(allocation.vatBps, row);
  }
  return [...rates.values()].sort((left, right) => left.vatBps - right.vatBps);
}
