import type { BusinessDay, DayReport, Receipt, Ticket } from '../shared/types';
import { money } from '../shared/money';
import { receiptRows, receiptVat, vatRateLabel } from '../shared/receipts';

const divider = '────────────────────────────────';
const methodNames = { card: 'Kort', swish: 'Swish', cash: 'Kontanter' };
export function receiptText(receipt: Receipt): string {
  const payment = receipt.payment;
  const rows = receiptRows(receipt).map(row => `${row.label}\n  ${money(row.grossOre)}\n${row.details.map(detail => `  ${detail}`).join('\n')}`);
  return [
    'ÖVNING', 'TEST — inga riktiga betalningar', receipt.company.name, receipt.company.address, receipt.company.city,
    `Org.nr ${receipt.company.organizationNumber}`, divider,
    receipt.kind === 'refund' ? 'RETUR · ÖVNINGSKVITTO' : 'ÖVNINGSKVITTO', `Kvitto ${receipt.number} · ${receipt.tab.label}`,
    new Date(receipt.createdAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }),
    `Kassör: ${receipt.cashier}`, `Kassa: ${receipt.registerId}`, divider, ...rows,
    divider, `${receipt.kind === 'refund' ? 'Återbetalt' : 'Summa'}: ${money(payment.amountOre)}`,
    `${receipt.kind === 'refund' ? 'Återförd moms' : 'Varav moms'}: ${money(payment.allocations.reduce((sum, allocation) => sum + allocation.vatOre, 0))}`,
    ...receiptVat(receipt).flatMap(row => [`Moms ${vatRateLabel(row.vatBps)}: ${money(row.vatOre)}`, `  Underlag exkl. moms: ${money(row.netOre)}`]),
    `Dricks: ${money(payment.tipOre)}`, `${methodNames[payment.method]}: ${money(payment.amountOre + payment.tipOre)}`,
    ...(payment.tenderedOre !== null ? [`Mottaget: ${money(payment.tenderedOre)}`, `Tillbaka: ${money(payment.changeOre)}`] : []),
    ...(receipt.originalReceiptId ? [`Originalkvittots id: ${receipt.originalReceiptId}`] : []),
    ...(payment.reason ? [`Orsak: ${payment.reason}`] : []),
    divider, 'Kontroll: simulator · ingen certifierad enhet',
    ...(receipt.controlCode ? [`Simulerad kontrollkod: ${receipt.controlCode}`] : []),
    'Tack för ikväll! · La Gustosa', 'TRÄNING · ej giltigt som kundkvitto',
  ].filter(Boolean).join('\n');
}

export function ticketText(ticket: Ticket): string {
  return [
    'TEST · KÖK / BAR', ticket.kind === 'cancel' ? 'MAKULERING — STOPPA RÄTT' : ticket.station === 'bar' ? 'BARBESTÄLLNING' : 'KÖKSBESTÄLLNING',
    ticket.tabLabel, ...(ticket.movedFrom ? [`FLYTTAT FRÅN ${ticket.movedFrom}`] : []), new Date(ticket.createdAt).toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm' }), divider,
    ...ticket.items.flatMap(line => [
      `${line.status === 'void' ? 'MAKULERAD — TILLAGA INTE: ' : ''}${line.quantity} × ${line.name}`, `Gäst ${line.guest || 'gemensamt'} · ${line.course}`,
      ...line.modifiers.map(modifier => `  + ${modifier.name}`), ...(line.notes ? [`! ${line.notes}`] : []), '',
    ]), ...(ticket.reason ? [`Orsak: ${ticket.reason}`] : []), divider,
  ].join('\n');
}

export function closingText(day: BusinessDay, report: DayReport): string {
  const details = report.training;
  return ['TEST — inga riktiga betalningar', details ? `ÖVNING · Z-DAGRAPPORT #${details.sequence}` : 'TEST · DAGSAVSLUT',
    ...(details ? [details.company.name, `Org.nr ${details.company.organizationNumber}`, `Kassa: ${details.registerId}`, new Date(details.generatedAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })] : []),
    `Verksamhetsdag ${day.date} · #${day.number}`, divider,
    `Övningsförsäljning ${money(report.salesOre)}`, `Testreturer ${money(report.refundsOre)}`, `Netto i övning ${money(report.netOre)}`,
    `Testdricks ${money(report.tipsOre)}`, `Övningsmoms ${money(report.vatOre)}`,
    ...report.vat.map(total => `  ${total.vatBps / 100} %: ${money(total.vatOre)} · netto inkl. moms ${money(total.grossOre)}`), divider,
    ...report.methods.flatMap(method => [`${methodNames[method.method]} · försäljning ${money(method.salesOre)}`, `  Retur ${money(method.refundsOre)} · netto ${money(method.netOre)}`, `  Dricks ${money(method.tipsOre)}`]),
    divider, `Ingående växelkassa ${money(day.floatOre)}`,
    ...(details ? [`Kontantinsättningar ${money(details.cashDepositsOre ?? 0)}`, `Kontantuttag ${money(details.cashWithdrawalsOre ?? 0)}`] : []),
    `Förväntad kassa ${money(report.expectedCashOre)}`, `Räknad kassa ${money(day.countedCashOre ?? 0)}`, `Differens ${money(report.differenceOre ?? 0)}`,
    ...(details ? [divider, 'ÖVNINGSREGISTRERINGAR', `Övningskvitton ${details.trainingReceipts} · belopp ${money(report.netOre)}`, `Varav testreturer ${details.refundReceipts} · ${money(report.refundsOre)}`,
      `Kvittokopior ${details.receiptCopies} · ${money(details.receiptCopiesOre)}`, `Simulerade lådöppningar ${details.drawerOpenings}`, `Rabatt på betalda rader ${money(details.discountsOre)}`,
      `Pris-/radrättelser ${details.reductionsCount} · ${money(details.reductionsOre)}`, `Oavslutade notor ${report.openTabs} · kvar ${money(details.openTabAmountOre)}`,
      divider, 'HUVUDGRUPPER · ÖVNINGSFÖRSÄLJNING', ...details.categories.map(category => `${category.name}: ${money(category.salesOre)}`),
      divider, 'ACKUMULERADE ÖVNINGSBELOPP', `Försäljning ${money(details.cumulativeSalesOre)}`, `Returer ${money(details.cumulativeRefundsOre)}`, `Netto ${money(details.cumulativeNetOre)}`] : []),
    divider, 'TRÄNING · ej bokföringsunderlag',
  ].join('\n');
}
