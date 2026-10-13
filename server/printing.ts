import type { BusinessDay, DayReport, Receipt, Ticket } from '../shared/types';
import { money } from '../shared/money';

const divider = '────────────────────────────────';
const methodNames = { card: 'Kort', swish: 'Swish', cash: 'Kontanter' };
export function receiptText(receipt: Receipt): string {
  const payment = receipt.payment;
  const rows = payment.allocations.map(allocation => {
    const line = receipt.tab.lines.find(candidate => candidate.id === allocation.lineId)!;
    return `${line.name}\n  Gäst ${line.guest || 'gemensamt'} · ${money(allocation.grossOre)}\n${line.modifiers.map(modifier => `  + ${modifier.name}`).join('\n')}`;
  });
  return [
    'TEST — inga riktiga betalningar', receipt.company.name, receipt.company.address, receipt.company.city,
    `Org.nr ${receipt.company.organizationNumber}`, divider,
    receipt.kind === 'refund' ? 'TESTRETUR' : 'ÖVNINGSKVITTO', `Kvitto ${receipt.number} · ${receipt.tab.label}`,
    new Date(receipt.createdAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }),
    `Kassör: ${receipt.cashier}`, `Kassa: ${receipt.registerId}`, divider, ...rows,
    divider, `${receipt.kind === 'refund' ? 'Återbetalt' : 'Summa'}: ${money(payment.amountOre)}`,
    `Varav moms: ${money(payment.allocations.reduce((sum, allocation) => sum + allocation.vatOre, 0))}`,
    `Dricks: ${money(payment.tipOre)}`, `${methodNames[payment.method]}: ${money(payment.amountOre + payment.tipOre)}`,
    ...(payment.tenderedOre !== null ? [`Mottaget: ${money(payment.tenderedOre)}`, `Tillbaka: ${money(payment.changeOre)}`] : []),
    ...(payment.reason ? [`Orsak: ${payment.reason}`] : []),
    divider, 'Tack för ikväll! · La Gustosa', 'TRÄNING · ej giltigt som kundkvitto',
  ].filter(Boolean).join('\n');
}

export function ticketText(ticket: Ticket): string {
  return [
    'TEST · KÖK / BAR', ticket.kind === 'cancel' ? 'MAKULERING — STOPPA RÄTT' : ticket.station === 'bar' ? 'BARBESTÄLLNING' : 'KÖKSBESTÄLLNING',
    ticket.tabLabel, ...(ticket.movedFrom ? [`FLYTTAT FRÅN ${ticket.movedFrom}`] : []), new Date(ticket.createdAt).toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm' }), divider,
    ...ticket.items.flatMap(line => [
      `${line.quantity} × ${line.name}`, `Gäst ${line.guest || 'gemensamt'} · ${line.course}`,
      ...line.modifiers.map(modifier => `  + ${modifier.name}`), ...(line.notes ? [`! ${line.notes}`] : []), '',
    ]), ...(ticket.reason ? [`Orsak: ${ticket.reason}`] : []), divider,
  ].join('\n');
}

export function closingText(day: BusinessDay, report: DayReport): string {
  return ['TEST · DAGSAVSLUT', `Verksamhetsdag ${day.date}`, divider,
    `Försäljning ${money(report.salesOre)}`, `Returer ${money(report.refundsOre)}`, `Netto ${money(report.netOre)}`,
    `Dricks ${money(report.tipsOre)}`, `Moms ${money(report.vatOre)}`, divider,
    ...report.methods.map(method => `${methodNames[method.method]} ${money(method.netOre)}`),
    `Förväntad kassa ${money(report.expectedCashOre)}`, `Räknad kassa ${money(day.countedCashOre ?? 0)}`, `Differens ${money(report.differenceOre ?? 0)}`,
  ].join('\n');
}
