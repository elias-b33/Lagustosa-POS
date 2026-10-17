import type { Receipt } from '../../shared/types';

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function money(ore: number): string {
  check(Number.isSafeInteger(ore) && ore >= 0, 'Belopp måste vara positiva heltal i ören.');
  return `${Math.trunc(ore / 100)}.${String(ore % 100).padStart(2, '0')}`;
}
// Never round item fractions to fit a remote format: 1/3 remains unsupported.
function exact(numerator: bigint, denominator: bigint): string {
  check(denominator > 0n && numerator >= 0n, 'Ogiltigt exakt antal eller enhetspris.');
  const scale = 100000000n;
  check(numerator * scale % denominator === 0n, 'Värdet kan inte återges exakt med fiskalys åtta decimaler.');
  const value = numerator * scale / denominator;
  check(value / scale < 1000000000000n, 'Värdet överskrider fiskalys intervall.');
  return `${value / scale}.${String(value % scale).padStart(8, '0')}`.replace(/\.?0+$/, '');
}
const creators = [{ type: 'PERSON', label: 'ELEVA-TEST' }];
function vendorTime(at: string): string {
  const date = new Date(at);
  check(Number.isFinite(date.getTime()), 'Kvittots historiska tidpunkt är ogiltig.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${parts.timeZoneName.replace('GMT', '') || '+00:00'}`;
}
export function openingPayload(systemId: string) { return { content: { type: 'INTENTION', system: { id: systemId }, operation: { type: 'OPENING' } } }; }
export function closingPayload(systemId: string) { return { content: { type: 'INTENTION', system: { id: systemId }, operation: { type: 'CLOSING' } } }; }
export function transactionIntentionPayload(systemId: string) { return { content: { type: 'INTENTION', system: { id: systemId }, operation: { type: 'TRANSACTION', details: { creators, training: true } } } }; }
export function duplicateIntentionPayload(systemId: string, originalRecordId: string, reason: string) {
  check(reason.trim().length >= 3 && reason.length <= 128, 'Kopians orsak måste vara 3–128 tecken.');
  return { content: { type: 'INTENTION', system: { id: systemId }, operation: { type: 'DUPLICATE', record: { id: originalRecordId }, number: '1', reason, details: { creators, training: true } } } };
}
export function receiptOperation(receipt: Receipt, original?: Receipt) {
  const payment = receipt.payment;
  check(payment.status === 'approved' && payment.amountOre >= 0, 'Endast godkända övningsbetalningar kan förberedas.');
  check(payment.tipOre === 0, 'Dricks behöver leverantörsverifierad mappning innan överföring.');
  check(receipt.paymentId === payment.id && receipt.registerId === payment.registerId, 'Kvittots betalnings- och kassaidentiteter stämmer inte.');
  check(receipt.kind === payment.kind && ['sale', 'refund'].includes(receipt.kind), 'Kvittots och betalningens transaktionstyp stämmer inte.');
  check(receipt.kind === 'refund' || !original, 'Ett försäljningskvitto får inte ärva en returreferens.');
  if (receipt.kind === 'refund') {
    check(original && original.id === receipt.originalReceiptId && payment.parentId === original.paymentId, 'Returen saknar verifierbart original.');
    check(original.kind === 'sale' && original.payment.kind === 'sale' && Number.isSafeInteger(original.number) && original.number > 0, 'Returen kräver ett ursprungligt försäljningskvitto.');
    check(original.registerId === receipt.registerId, 'Retur över kassagräns behöver leverantörsverifierad originalreferens.');
  }
  const rates = new Map<number, { gross: number; vat: number }>();
  const vat = (bps: number, gross: number, tax: number) => {
    const code = ({ 2500: 'STANDARD', 1200: 'REDUCED_1', 600: 'REDUCED_2' } as Record<number, string>)[bps];
    check(code && tax <= gross, 'Momssatsen eller momsunderlaget saknar verifierad mappning.');
    return { type: 'VAT_RATE', code, percentage: money(bps), amount: money(tax), exclusive: money(gross - tax), inclusive: money(gross) };
  };
  const entries = payment.allocations.map(allocation => {
    const line = receipt.tab.lines.find(row => row.id === allocation.lineId);
    check(line && ['goods', 'services'].includes(line.itemKind ?? ''), 'Historisk artikel och varu-/tjänsteklass krävs.');
    check(line.name.length <= 256, 'Artikelnamnet överskrider leverantörens fält; det får inte kortas av.');
    const q = allocation.quantity;
    check(q && /^\d+$/.test(q.numerator) && /^[1-9]\d*$/.test(q.denominator), 'Historiskt artikelantal krävs.');
    const n = BigInt(q.numerator), d = BigInt(q.denominator);
    check(n > 0n, 'Artikelantal måste vara positivt.');
    const total = rates.get(allocation.vatBps) ?? { gross: 0, vat: 0 };
    total.gross += allocation.grossOre; total.vat += allocation.vatOre; rates.set(allocation.vatBps, total);
    return { type: receipt.kind === 'refund' ? 'RETURN' : 'SALE', details: { concept: line.itemKind === 'goods' ? 'GOOD' : 'SERVICE' },
      data: { type: 'ITEM', text: line.name, unit: { quantity: exact(n, d), price: { inclusive: exact(BigInt(allocation.grossOre) * d, 100n * n), exclusive: exact(BigInt(allocation.grossOre - allocation.vatOre) * d, 100n * n) } },
        value: { base: money(allocation.grossOre - allocation.vatOre) }, vat: vat(allocation.vatBps, allocation.grossOre, allocation.vatOre) } };
  });
  check(entries.length > 0 && entries.length <= 1000, 'Kvittot måste innehålla 1–1000 betalade rader.');
  check([...rates.values()].reduce((sum, row) => sum + row.gross, 0) === payment.amountOre, 'Beloppet stämmer inte med betalningens artikelandelar.');
  const tax = [...rates.values()].reduce((sum, row) => sum + row.vat, 0);
  check(Number.isSafeInteger(receipt.number) && receipt.number > 0, 'Kvittots löpnummer saknas.');
  return { type: 'RECEIPT', document: { number: String(receipt.number), issued_at: vendorTime(receipt.createdAt),
    ...(original ? { references: { preceding_document: { number: String(original.number), issued_at: vendorTime(original.createdAt).slice(0, 10) } } } : {}) },
    entries, breakdown: [...rates].map(([bps, value]) => vat(bps, value.gross, value.vat)), totals: { vat: { amount: money(tax), inclusive: money(payment.amountOre), exclusive: money(payment.amountOre - tax) } },
    // These are SIMULATED methods. Never invent a PAN for the CARD schema.
    payments: [{ type: 'OTHER', name: `ELEVA TEST ${payment.method.toUpperCase()}`, details: { amount: money(payment.amountOre), currency: 'SEK' } }],
    details: { creators, training: true } };
}
export function transactionPayload(intentionRecordId: string, operation: ReturnType<typeof receiptOperation>) {
  return { content: { type: 'TRANSACTION', record: { id: intentionRecordId }, operation } };
}
