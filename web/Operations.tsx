import { TerminalProgress } from './TerminalPayments';
import { useState, useEffect } from 'react';
import { ChefHat, Wine, Clock3, Check, ArrowRight, Download, Banknote, ShieldCheck, FolderClock, CircleAlert, ReceiptText, Undo2 } from 'lucide-react';
import type { BusinessDay, DayReport, Payment, Station, Ticket } from '../shared/types';
import { money, parseMoney } from '../shared/money';
import { api, newKey } from './api';
import { Action, Empty, Field, Modal, printStatusNames, type WorkspaceProps } from './components';
import { ReceiptPaper } from './Payments';
import { usePaymentAttempts } from './usePaymentAttempt';
import { submitPaymentAttempt } from './submitPaymentAttempt';
import type { PaymentAttempt } from './payment-attempts';
import { CashMovementModal } from './CashMovement';
import { RegisterReports } from './RegisterReports';
import { JournalExport } from './JournalExport';
import { allocateQuantity, allocationQuantity, compareQuantities, rationalQuantity, remainingAllocation } from '../shared/allocations';

export function StationView({ station, ...props }: WorkspaceProps & { station: Station }) {
  const { data, busy, run } = props;
  const [showHistory, setShowHistory] = useState(false);
  const fullyCancelled = (ticket: Ticket) => ticket.kind !== 'cancel' && ticket.items.length > 0 && ticket.items.every(line => line.status === 'void');
  const stationTickets = data.tickets.filter(ticket => ticket.station === station);
  const activeTickets = stationTickets.filter(ticket => ticket.status !== 'served' && !fullyCancelled(ticket));
  const tickets = showHistory ? stationTickets.filter(ticket => ticket.status === 'served' || fullyCancelled(ticket)) : activeTickets;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  return <section className="station-view"><div className="section-heading"><div><span className="eyebrow">{station === 'kitchen' ? 'FRÅN FÖRSTA BONG TILL SISTA RÄTT' : 'DRYCK MED KÄNSLA FÖR TIMING'}</span><h2>{station === 'kitchen' ? 'Kökets beställningar' : 'Barens beställningar'}</h2></div><button className="text-button" onClick={() => setShowHistory(current => !current)}>{showHistory ? 'Visa pågående' : 'Visa historik'}</button></div><div className="station-summary"><span><i className="status-dot" /> {activeTickets.filter(ticket => ticket.status === 'queued').length} nya</span><span>{activeTickets.filter(ticket => ticket.status === 'started').length} påbörjade</span><span className="green-text">{activeTickets.filter(ticket => ticket.status === 'ready').length} klara att servera</span><span className="muted">Uppdateras automatiskt</span></div>{tickets.length ? <div className="ticket-grid">{tickets.map(ticket => {
    const next: Record<Ticket['status'], Ticket['status']> = { queued: 'started', started: 'ready', ready: 'served', served: 'served' };
    const cancelled = fullyCancelled(ticket);
    return <article className={`ticket ${cancelled ? 'void-ticket' : ticket.status} ${ticket.kind === 'cancel' ? 'cancel-ticket' : ''}`} key={ticket.id}>
      <header><div><span className="eyebrow">{ticket.kind === 'cancel' ? 'MAKULERING' : station === 'kitchen' ? 'KÖKSBONG' : 'BARBONG'}</span><h3>{ticket.tabLabel}</h3></div>{station === 'kitchen' ? <ChefHat size={24} /> : <Wine size={24} />}</header>
      {ticket.movedFrom && <p className="kitchen-note">Flyttat från {ticket.movedFrom} till {ticket.tabLabel}</p>}
      <div className="ticket-meta"><span><Clock3 size={13} />{Math.max(0, Math.round((now - Date.parse(ticket.createdAt)) / 60000))} min</span><span>{ticket.createdBy}</span><span>{new Date(ticket.createdAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}</span></div>
      <div className="ticket-lines">{ticket.items.map(line => {
        const lineCancelled = ticket.kind !== 'cancel' && line.status === 'void';
        return <div className={lineCancelled ? 'ticket-line-void' : undefined} key={line.id}>
          <strong>{line.quantity} × {lineCancelled ? <s>{line.name}</s> : line.name}</strong>
          {lineCancelled && <span className="ticket-line-void-label">Makulerad</span>}
          <span>Gäst {line.guest || 'gemensamt'}</span>
          {line.modifiers.map(modifier => <small key={modifier.id}>+ {modifier.name}</small>)}
          {line.notes && <p className="kitchen-note">{line.notes}</p>}
        </div>;
      })}</div>
      {ticket.reason && <p className="kitchen-note">{ticket.reason}</p>}
      <div className="ticket-footer"><span className={`tag ${cancelled ? 'void' : ticket.status}`}>{cancelled ? 'Makulerad' : ticket.status === 'queued' ? 'Ny beställning' : ticket.status === 'started' ? 'Påbörjad' : ticket.status === 'ready' ? 'Klar' : 'Serverad'}</span>{!cancelled && ticket.status !== 'served' && <Action disabled={busy} onClick={() => void run(() => api(`/tickets/${ticket.id}/status`, { status: next[ticket.status] }))}>{ticket.status === 'queued' ? 'Påbörja' : ticket.status === 'started' ? 'Markera klar' : 'Serverad'}{ticket.status === 'started' ? <Check size={16} /> : <ArrowRight size={16} />}</Action>}</div>
    </article>;
  })}</div> : <Empty title={showHistory ? 'Ingen bonghistorik ännu' : 'Lugnt i stationen'} text={showHistory ? 'Serverade och helt makulerade beställningar visas här.' : 'Nya beställningar visas här så fort de skickas från serveringen.'} />}</section>;
}

function TrainingReportSummary({ report }: { report: DayReport }) {
  const details = report.training;
  if (!details) return <p className="muted">Äldre sparad övningsrapport. Detaljerade räknare saknas för denna historiska rapport.</p>;
  return <>
    <p className="muted">{report.registers?.length ? 'Samlad avstämning för restaurangen · övning' : `Äldre övningsrapport · ${details.kind} · ${details.registerId}`} · {details.company.name} · {details.company.organizationNumber}<br />
      {details.kind === 'Z' ? 'Låst vid dagsavslut' : 'Avstämning'} {new Date(details.generatedAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })} · Alla belopp gäller träning.</p>
    <div className="report-grid">
      <article className="card"><h3>Övningsregistreringar</h3>
        <div className="report-line"><span>Övningskvitton inkl. testreturer</span><strong>{details.trainingReceipts}</strong><small>{money(report.netOre)}</small></div>
        <div className="report-line"><span>Varav testreturer</span><strong>{details.refundReceipts}</strong><small>{money(report.refundsOre)}</small></div>
        <div className="report-line"><span>Kvittokopior</span><strong>{details.receiptCopies}</strong><small>{money(details.receiptCopiesOre)}</small></div>
        <div className="report-line"><span>Simulerade lådöppningar</span><strong>{details.drawerOpenings}</strong></div>
        <div className="report-line"><span>Kontantinsättningar</span><strong>{money(details.cashDepositsOre ?? 0)}</strong></div>
        <div className="report-line"><span>Kontantuttag</span><strong>{money(details.cashWithdrawalsOre ?? 0)}</strong></div>
        <div className="report-line"><span>Rabatt på betalda rader</span><strong>{money(details.discountsOre)}</strong></div>
        <div className="report-line"><span>Pris- och radrättelser</span><strong>{details.reductionsCount}</strong><small>{money(details.reductionsOre)}</small></div>
        <div className="report-line"><span>Oavslutade notor</span><strong>{report.openTabs}</strong><small>Kvar {money(details.openTabAmountOre)}</small></div>
      </article>
      <article className="card"><h3>Övningsmoms per skattesats</h3>
        {report.vat.map(total => <div className="report-line" key={total.vatBps}><span>{total.vatBps / 100} %</span><strong>{money(total.vatOre)}</strong><small>Netto inkl. moms {money(total.grossOre)}</small></div>)}
        <h3>Huvudgrupper</h3>{details.categories.map(category => <div className="report-line" key={category.name}><span>{category.name}</span><strong>{money(category.salesOre)}</strong></div>)}
        <h3>Ackumulerade övningsbelopp</h3>
        <div className="report-line"><span>Försäljning</span><strong>{money(details.cumulativeSalesOre)}</strong></div>
        <div className="report-line"><span>Returer</span><strong>{money(details.cumulativeRefundsOre)}</strong></div>
        <div className="report-line"><span>Netto</span><strong>{money(details.cumulativeNetOre)}</strong></div>
      </article>
    </div>
  </>;
}

export function ReportsView(props: WorkspaceProps) {
  const { data, busy, run } = props;
  const [selectedDay, setSelectedDay] = useState('');
  const day = data.days.find(day => day.id === selectedDay) ?? data.currentDay ?? data.days.at(-1);
  const [reportOverride, setReportOverride] = useState<DayReport | null>(null);
  const report = day?.status === 'closed' ? day.report : data.report?.dayId === day?.id ? data.report : reportOverride?.dayId === day?.id ? reportOverride : null;
  const [dayModal, setDayModal] = useState<'open' | 'close' | null>(null);
  const [cashAmount, setCashAmount] = useState('1500');
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [refundId, setRefundId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [cashMovement, setCashMovement] = useState(false);
  const [reason, setReason] = useState('');
  const main = data.actor.device.kind === 'main';
  const uncertain = data.payments.filter(payment => ['pending', 'unknown'].includes(payment.status));
  const fiscalUncertain = data.receipts.filter(receipt => receipt.fiscalStatus !== 'confirmed');
  const receipts = [...data.receipts].reverse().filter(receipt => !day || receipt.dayId === day.id);
  const selectedReceipt = data.receipts.find(receipt => receipt.id === receiptId);
  const refundPayment = data.payments.find(payment => payment.id === refundId);
  return <section className="operations"><div className="section-heading"><div><span className="eyebrow">EN TYDLIG AVSTÄMNING FÖR VARJE KVÄLL</span><h2>Dagsöversikt</h2></div><div className="action-row compact"><select aria-label="Verksamhetsdag" value={day?.id ?? ''} onChange={async event => { setSelectedDay(event.target.value); setReportOverride(null); const result = await run(() => api<DayReport>(`/business-days/${event.target.value}/report`)); if (result) setReportOverride(result); }}>{[...data.days].reverse().map(day => <option key={day.id} value={day.id}>{day.date} · #{day.number} · {day.status === 'open' ? 'Öppen' : 'Avslutad'}</option>)}</select>{main && <Action onClick={() => { setCashAmount(data.currentDay ? String((data.report?.expectedCashOre ?? 0) / 100) : '1500'); setDayModal(data.currentDay ? 'close' : 'open'); }} disabled={busy}>{data.currentDay ? 'Avsluta dagen' : 'Öppna dagen'}<ArrowRight size={17} /></Action>}</div></div>
    {uncertain.map(payment => <div className="notice warning" key={payment.id}><CircleAlert size={20} /><div><strong>Osäker {payment.kind === 'refund' ? 'retur' : 'betalning'} · {money(payment.amountOre)}</strong><span>Beloppet är reserverat tills samma betalning har kontrollerats.</span></div><Action secondary disabled={busy} onClick={() => void run(() => api(`/payments/${payment.id}/check`, {}))}>Kontrollera status</Action></div>)}
    {fiscalUncertain.map(receipt => <div className="notice warning" key={receipt.id}><CircleAlert size={20} /><div><strong>Osäker kontrollkod · kvitto {receipt.number}</strong><span>Fråga efter befintlig registrering innan dagsavslut.</span></div><Action secondary disabled={busy} onClick={() => void run(() => api(`/receipts/${receipt.id}/verify`, {}))}>Kontrollera registrering</Action></div>)}
    {report && day ? <><div className="report-metrics"><div><span>Försäljning</span><strong>{money(report.salesOre)}</strong><small>{report.receipts} testkvitton</small></div><div><span>Netto efter returer</span><strong>{money(report.netOre)}</strong><small>Returer {money(report.refundsOre)}</small></div><div><span>Dricks</span><strong>{money(report.tipsOre)}</strong><small>Redovisas separat</small></div><div><span>Moms</span><strong>{money(report.vatOre)}</strong><small>Datumstyrda momssatser</small></div></div><div className="report-grid"><article className="card"><h3>Betalsätt</h3>{report.methods.map(method => <div className="report-line" key={method.method}><span>{method.method === 'card' ? 'Kort' : method.method === 'swish' ? 'Swish' : 'Kontanter'}</span><strong>{money(method.netOre)}</strong><small>Dricks {money(method.tipsOre)}</small></div>)}</article><article className="card"><h3>Kontantavstämning</h3><div className="report-line"><span>Växelkassa</span><strong>{money(day.floatOre)}</strong></div><div className="report-line"><span>Förväntad kontantkassa</span><strong>{money(report.expectedCashOre)}</strong></div>{day.countedCashOre !== null && <><div className="report-line"><span>Räknad kassa</span><strong>{money(day.countedCashOre)}</strong></div><div className="report-line"><span>Differens</span><strong>{money(report.differenceOre ?? 0)}</strong></div></>}{main && <button className="text-button" onClick={() => { setReason(''); setDrawer(true); }}><Banknote size={17} />Simulera kassalådsöppning</button>}</article></div><div className="report-exports"><a className="button secondary" href={`/api/v1/business-days/${day.id}/report.csv`}><Download size={17} />Hämta CSV</a><span>{report.openTabs} öppna notor · {report.unresolved} osäkra registreringar</span></div></> : <Empty title="Redo för en ny verksamhetsdag" text="Öppna dagen och ange växelkassan innan första beställningen." />}
    {report && <><RegisterReports report={report} /><TrainingReportSummary report={report} /></>}
    <JournalExport data={data} />
    {main && <button className="button secondary" disabled={busy} onClick={() => setCashMovement(true)}><Banknote size={17} />Insättning eller uttag</button>}
    <div className="section-heading secondary-heading"><h3>Kvitton & returer</h3><span className="muted">Historiken sparas även efter dagsavslut</span></div>{receipts.length ? <div className="list-card">{receipts.map(receipt => <div className="list-row" key={receipt.id}><span className="list-icon"><ReceiptText size={19} /></span><button className="receipt-link" onClick={() => setReceiptId(receipt.id)}><strong>#{receipt.number} · {receipt.tab.label}</strong><span>{receipt.registerId} · {receipt.kind === 'refund' ? 'Retur' : 'Försäljning'} · {new Date(receipt.createdAt).toLocaleTimeString('sv-SE')} · {receipt.payment.method}</span></button><strong>{receipt.kind === 'refund' ? '−' : ''}{money(receipt.payment.amountOre)}</strong>{receipt.kind === 'sale' && <button className="text-button" disabled={busy || !data.currentDay} onClick={() => setRefundId(receipt.paymentId)}><Undo2 size={16} />Retur</button>}</div>)}</div> : <p className="muted">Testkvitton visas här när den första betalningen registreras.</p>}
    <div className="backup-card"><span className="list-icon"><FolderClock size={22} /></span><div><strong>Säkerhetskopiering</strong><span>{data.backup.lastAt ? `Senaste kopian ${new Date(data.backup.lastAt).toLocaleString('sv-SE')}` : 'Ingen säkerhetskopia skapad ännu.'}{data.backup.external ? ' · Separat disk' : ' · Lokal testkopia; ange separat disk vid installation'}</span>{data.backup.error && <span className="form-error">{data.backup.error}</span>}</div>{main && <Action secondary disabled={busy} onClick={() => void run(() => api('/backups', {}), 'Säkerhetskopian är sparad.')}><ShieldCheck size={17} />Skapa kopia</Action>}</div>
    {dayModal && <Modal title={dayModal === 'open' ? 'Öppna verksamhetsdagen' : 'Avsluta verksamhetsdagen'} subtitle={dayModal === 'close' ? 'Kontrollera betalningar, returer och kontantkassa.' : 'Dagen avslutas uttryckligen, även om servicen fortsätter efter midnatt.'} onClose={() => setDayModal(null)}><form onSubmit={event => { event.preventDefault(); void (async () => { const result = await run(() => api<BusinessDay>(dayModal === 'open' ? '/business-days' : `/business-days/${data.currentDay!.id}/close`, { key: newKey(), ...(dayModal === 'open' ? { floatOre: parseMoney(cashAmount) } : { countedCashOre: parseMoney(cashAmount) }) })); if (result) { setDayModal(null); setSelectedDay(result.id); setReportOverride(null); } })(); }}><Field label={dayModal === 'open' ? 'Växelkassa i kronor' : 'Räknad kontantkassa i kronor'}><input value={cashAmount} inputMode="decimal" onChange={event => setCashAmount(event.target.value)} /></Field>{dayModal === 'close' && <p className="muted">Förväntat: {money(data.report?.expectedCashOre ?? 0)}<br />Öppna notor: {data.report?.openTabs ?? 0}<br />Osäkra registreringar: {data.report?.unresolved ?? 0}</p>}<Action type="submit" disabled={busy || parseMoney(cashAmount) === null}>{dayModal === 'open' ? 'Öppna dagen' : 'Bekräfta dagsavslut'}<Check size={17} /></Action></form></Modal>}
    {selectedReceipt && <Modal title={`Testkvitto #${selectedReceipt.number}`} onClose={() => setReceiptId(null)}><ReceiptPaper receipt={selectedReceipt} /></Modal>}
    {cashMovement && <CashMovementModal {...props} onClose={() => setCashMovement(false)} />}
    {refundPayment && <RefundModal payment={refundPayment} data={data} busy={busy} run={run} refresh={props.refresh} onClose={() => setRefundId(null)} />}
    {drawer && <Modal title="Simulera kassalådsöppning" subtitle="Öppningen och orsaken journalförs." onClose={() => setDrawer(false)}><Field label="Orsak"><input value={reason} onChange={event => setReason(event.target.value)} /></Field><Action disabled={busy || reason.length < 3} onClick={async () => { if (await run(() => api('/drawer/open', { reason }), 'Kassalådsöppningen är simulerad.')) setDrawer(false); }}>Öppna i simulator</Action></Modal>}
  </section>;
}
export function RefundModal({ payment, onClose, ...props }: WorkspaceProps & { payment: Payment; onClose: () => void }) {
  const sandboxCard = payment.method === 'card' && props.data.paymentIntegration?.provider === 'softpay-sandbox';
  const reserved = props.data.payments.filter(candidate => candidate.parentId === payment.id && ['approved', 'pending', 'unknown'].includes(candidate.status)).reduce((sum, candidate) => sum + candidate.amountOre, 0);
  const remaining = payment.amountOre - reserved;
  const [amount, setAmount] = useState(String(remaining / 100));
  const [selectionMode, setSelectionMode] = useState<'amount' | 'items' | 'rows'>('amount');
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [lineIds, setLineIds] = useState<string[]>([]);
  const [lineAmount, setLineAmount] = useState('');
  const [reason, setReason] = useState('');
  const [simulation, setSimulation] = useState<'approved' | 'declined' | 'unknown'>('approved');
  const [resultId, setResultId] = useState<string | null>(null);
  const { attempts, storageError, remember, forget } = usePaymentAttempts(props.data.actor, props.data.testRoundId);
  const attempt = attempts.find((entry): entry is Extract<PaymentAttempt, { kind: 'refund' }> => entry.kind === 'refund' && entry.targetId === payment.id);
  const recovered = attempt ? props.data.payments.find(candidate => candidate.key === attempt.input.key) : undefined;
  const result = props.data.payments.find(candidate => candidate.id === resultId);
  const receipt = props.data.receipts.find(candidate => candidate.paymentId === resultId);
  const uncertain = props.data.payments.filter(candidate => candidate.parentId === payment.id && ['pending', 'unknown'].includes(candidate.status));
  const amountOre = parseMoney(amount);
  const originalReceipt = props.data.receipts.find(receipt => receipt.paymentId === payment.id);
  const usedAllocations = props.data.payments.filter(candidate => candidate.parentId === payment.id && ['approved', 'pending', 'unknown'].includes(candidate.status)).flatMap(candidate => candidate.allocations);
  const balances = payment.allocations.map(allocation => remainingAllocation(allocation, usedAllocations.filter(used => used.lineId === allocation.lineId)));
  const hasFreeQuantity = (balance: typeof balances[number]) => balance.grossOre === 0 && allocationQuantity(balance) !== null && compareQuantities(allocationQuantity(balance)!, rationalQuantity(0)) > 0;
  const availableRows = balances.filter(balance => balance.grossOre > 0 || hasFreeQuantity(balance));
  const selectedRows = availableRows.filter(balance => lineIds.includes(balance.lineId));
  const rowsMaximum = selectedRows.reduce((sum, balance) => sum + balance.grossOre, 0);
  const rowsAmount = lineAmount.trim() ? parseMoney(lineAmount) : rowsMaximum;
  const rowsValid = selectedRows.length > 0 && rowsAmount !== null && rowsAmount <= rowsMaximum && (rowsAmount > 0 || selectedRows.some(hasFreeQuantity));
  const itemBalances = balances.filter(allocation => allocation.quantityBasis === 'items' && allocationQuantity(allocation) && compareQuantities(allocationQuantity(allocation)!, rationalQuantity(1)) >= 0);
  const selectedItems = itemBalances.flatMap(balance => quantities[balance.lineId] > 0 ? [{ lineId: balance.lineId, quantity: quantities[balance.lineId] }] : []);
  const itemsValid = selectedItems.length > 0 && selectedItems.every(item => Number.isSafeInteger(item.quantity) && item.quantity <= 100 && compareQuantities(rationalQuantity(item.quantity), allocationQuantity(itemBalances.find(balance => balance.lineId === item.lineId)!)!) <= 0);
  const refundAmountOre = selectionMode === 'items' ? itemsValid ? selectedItems.reduce((sum, item) => sum + allocateQuantity(itemBalances.find(balance => balance.lineId === item.lineId)!, rationalQuantity(item.quantity)).grossOre, 0) : null : selectionMode === 'rows' ? rowsValid ? rowsAmount : null : amountOre;
  useEffect(() => {
    if (!recovered) return;
    setResultId(recovered.id);
    if (['approved', 'declined', 'cancelled'].includes(recovered.status)) forget(recovered.key);
  }, [recovered?.id, recovered?.status, forget]);
  const submit = async () => {
    if (!attempt && refundAmountOre === null) return;
    const saved: PaymentAttempt = attempt ?? { version: 1, kind: 'refund', targetId: payment.id, createdAt: new Date().toISOString(), input: { key: newKey(), amountOre: refundAmountOre!, ...(selectionMode === 'items' ? { items: selectedItems } : selectionMode === 'rows' ? { lineIds: selectedRows.map(balance => balance.lineId) } : {}), reason, simulation, fiscalSimulation: 'confirmed' } };
    const result = await props.run(() => submitPaymentAttempt(saved, remember, forget));
    if (result) setResultId(result.id);
  };
  return <Modal title="Gör en testretur" subtitle={`Kan återbetalas: ${money(remaining)} · samma betalsätt som originalet`} onClose={onClose}>
    {result?.status === 'approved' ? <div className="payment-success"><ShieldCheck size={40} /><h3>Returen är godkänd</h3><strong>{money(result.amountOre)}</strong><p>Originalkvittot är bevarat. Returen har ett eget testkvitto.</p>{receipt?.fiscalStatus === 'confirmed' && <ReceiptPaper receipt={receipt} />}<Action onClick={onClose}>Klart</Action></div> : <>
      {storageError && <p className="form-error" role="alert">{storageError}</p>}
      {attempt && !recovered && <div className="notice warning payment-recovery"><CircleAlert size={18} /><div><strong>Returförsöket är sparat på enheten</strong><span>{attempt.input.amountOre === undefined ? "Valda artiklar" : money(attempt.input.amountOre)} · {attempt.input.reason}</span><span>Återuppta samma försök innan du gör en ny retur.</span></div></div>}
      {uncertain.map(candidate => sandboxCard ? <TerminalProgress key={candidate.id} {...props} payment={candidate} onResult={checked => setResultId(checked.id)} /> : <div className="notice warning" key={candidate.id}><CircleAlert size={18} /><div><strong>Osäker retur · {money(candidate.amountOre)}</strong><span>Kontrollera samma registrering.</span></div><Action secondary disabled={props.busy} onClick={async () => { const checked = await props.run(() => api<Payment>(`/payments/${candidate.id}/check`, {})); if (checked) setResultId(checked.id); }}>Kontrollera retur</Action><button disabled={props.busy} onClick={async () => { const checked = await props.run(() => api<Payment>(`/payments/${candidate.id}/cancel`, {})); if (checked) setResultId(checked.id); }}>Avbryt</button></div>)}
      <fieldset className="payment-fields" disabled={props.busy || !!attempt || uncertain.length > 0 || !!storageError}>
        <Field label="Retursätt"><select value={selectionMode} onChange={event => setSelectionMode(event.target.value as typeof selectionMode)}><option value="amount">Belopp från hela betalningen</option><option value="items" disabled={itemBalances.length === 0}>Valda artiklar och antal</option><option value="rows" disabled={availableRows.length === 0}>Valda kvittorader</option></select></Field>
        {selectionMode === 'amount' ? <><Field label="Returbelopp i kronor"><input value={amount} inputMode="decimal" onChange={event => setAmount(event.target.value)} /></Field><p className="muted">En beloppsretur fördelas över betalningens återstående rader. Välj artiklar eller kvittorader för att avgränsa vad som returneras.</p></> : selectionMode === 'rows' ? <>
          <div className="payment-items">{availableRows.map(balance => <label key={balance.lineId}><input type="checkbox" checked={lineIds.includes(balance.lineId)} onChange={event => setLineIds(current => event.target.checked ? [...current, balance.lineId] : current.filter(id => id !== balance.lineId))} /><span>{originalReceipt?.tab.lines.find(line => line.id === balance.lineId)?.name ?? balance.lineId}<small>Moms {balance.vatBps / 100} %</small></span><strong>{money(balance.grossOre)}</strong></label>)}</div>
          <Field label="Del av valda rader i kronor (valfritt)"><input value={lineAmount} inputMode="decimal" placeholder="Hela återstående beloppet" onChange={event => setLineAmount(event.target.value)} /><span>Endast de valda radernas belopp och moms återförs.</span></Field><p>Returbelopp: <strong>{refundAmountOre === null ? 'Kontrollera urval och belopp' : money(refundAmountOre)}</strong></p>
        </> : <>
          {itemBalances.map(balance => <Field key={balance.lineId} label={originalReceipt?.tab.lines.find(line => line.id === balance.lineId)?.name ?? balance.lineId}><input aria-label={`Returantal ${originalReceipt?.tab.lines.find(line => line.id === balance.lineId)?.name ?? balance.lineId}`} type="number" min={0} max={Math.min(100, Number(BigInt(balance.quantity!.numerator) / BigInt(balance.quantity!.denominator)))} step={1} value={quantities[balance.lineId] ?? 0} onChange={event => setQuantities(current => ({ ...current, [balance.lineId]: Number(event.target.value) }))} /></Field>)}
          <p>Returbelopp: <strong>{refundAmountOre === null ? 'Välj antal' : money(refundAmountOre)}</strong></p>
        </>}
        <Field label="Orsak till returen"><textarea value={reason} onChange={event => setReason(event.target.value)} /></Field>
        {!sandboxCard && <Field label="Testscenario"><select value={simulation} onChange={event => setSimulation(event.target.value as typeof simulation)}><option value="approved">Godkänd</option><option value="declined">Nekad</option><option value="unknown">Okänd status</option></select></Field>}
        {sandboxCard && <p className="muted">Testreturen kräver ett testkort vid den kopplade enheten. Returer utan närvarande kort är inte aktiverade.</p>}
      </fieldset>
      {result && ['declined', 'cancelled'].includes(result.status) && <p className="form-error" role="alert">{result.status === 'declined' ? 'Testreturen nekades.' : 'Testreturen avbröts.'} Inget belopp har återbetalats.</p>}
      <Action disabled={props.busy || !!storageError || (!!attempt ? !!recovered : uncertain.length > 0 || reason.trim().length < 3 || refundAmountOre === null || refundAmountOre > remaining || (selectionMode === 'amount' ? refundAmountOre <= 0 : selectionMode === 'rows' ? !rowsValid : !itemsValid))} onClick={() => void submit()}><Undo2 size={17} />{attempt ? 'Återuppta samma returförsök' : sandboxCard ? 'Skicka retur till testterminal' : 'Simulera retur'}</Action>
      <p className="receipt-footnote">Returen skapar en ny registrering. Originalkvittot bevaras.</p>
    </>}
  </Modal>;
}
