import { calculateTab, money } from './money';
import { allocationQuantity, quantityLabel } from './allocations';
import type { Receipt } from './types';

export const receiptMethodNames = { card: 'Kort', swish: 'Swish', cash: 'Kontanter' };
export const vatRateLabel = (rateBps: number): string => `${String(rateBps / 100).replace('.', ',')} %`;

// Amount sharing records exact economic quantities. Legacy records retain
// their saved reference row; their missing allocation history is not invented.
export function receiptRows(receipt: Receipt) {
  const totals = calculateTab(receipt.tab);
  return receipt.payment.allocations.map(allocation => {
    const line = receipt.tab.lines.find(candidate => candidate.id === allocation.lineId);
    const total = totals.lines.find(candidate => candidate.lineId === allocation.lineId);
    if (!line || !total) throw new Error('Kvittots artikelunderlag saknas.');
    const quantity = allocationQuantity(allocation);
    const share = allocation.quantityBasis === 'amount-share';
    const wholeRow = allocation.grossOre === total.grossOre;
    const item = `${line.quantity} × ${line.name}`;
    const label = quantity
      ? `${share ? `${receipt.kind === 'refund' ? 'Delretur' : 'Delbelopp'} · ` : ''}${quantityLabel(quantity)} × ${line.name}`
      : wholeRow ? item : `${receipt.kind === 'refund' ? 'Delretur' : 'Delbelopp'} av ${item}`;
    const allocatedDiscount = allocation.discountOre;
    return {
      lineId: line.id, grossOre: allocation.grossOre, quantity, quantityBasis: allocation.quantityBasis ?? null, label,
      details: [
        quantity && !share || !quantity && wholeRow ? `À ${money(line.unitPriceOre)}` : `Referens: hela raden ${money(total.grossOre)} · ${line.quantity} st · à ${money(line.unitPriceOre)}`,
        ...(share ? ['Antalet är en ekonomisk andel av artikelraden.'] : []),
        ...(!quantity ? ['Äldre kvitto: separat artikelantal per betalning saknas.'] : []),
        ...(allocatedDiscount !== undefined
          ? allocatedDiscount > 0 ? [`Rabatt: ${money(allocatedDiscount)}`] : []
          : total.discountOre > 0 ? [`${wholeRow ? 'Rabatt' : 'Rabatt på referensraden'}: ${money(total.discountOre)}`] : []),
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
