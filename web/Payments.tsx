import { useState, useEffect } from 'react';
import { CreditCard, Smartphone, Banknote, CircleCheck, CircleAlert, ReceiptText, Split, Users, RefreshCw } from 'lucide-react';
import type { Payment, PaymentMethod, Receipt, Simulation, Tab } from '../shared/types';
import { calculateTab, distribute, money, parseMoney } from '../shared/money';
import { receiptMethodNames, receiptRows, receiptVat, vatRateLabel } from '../shared/receipts';
import { api, newKey } from './api';
import { Action, Field, Modal, type WorkspaceProps } from './components';
import { usePaymentAttempts } from './usePaymentAttempt';
import { submitPaymentAttempt } from './submitPaymentAttempt';
import type { PaymentAttempt } from './payment-attempts';

export function ReceiptPaper({ receipt }: { receipt: Receipt }) {
  const { payment } = receipt;
  return <div className="receipt-paper">
    <div className="receipt-brand">la gustosa</div>
    <p>{receipt.company.name}<br />{receipt.company.address}<br />{receipt.company.city}<br />Org.nr {receipt.company.organizationNumber}</p>
    <strong className="receipt-type-marker">ÖVNING</strong>
    <p>TEST — inga riktiga betalningar<br />{receipt.kind === 'refund' ? 'Retur · övningskvitto' : 'Övningskvitto'} #{receipt.number} · {receipt.tab.label}<br />{new Date(receipt.createdAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}<br />Kassör: {receipt.cashier}<br />Kassa: {receipt.registerId}</p>
    <div className="receipt-rule" />
    {receiptRows(receipt).map(row => <div key={row.lineId}><div className="receipt-line"><span>{row.label}</span><strong>{money(row.grossOre)}</strong></div><div className="receipt-item-details">{row.details.map((detail, index) => <div key={index}>{detail}</div>)}</div></div>)}
    <div className="receipt-rule" />
    <div className="receipt-line"><strong>{receipt.kind === 'refund' ? 'Återbetalt' : 'Summa'}</strong><strong>{money(payment.amountOre)}</strong></div>
    <div className="receipt-line"><span>{receipt.kind === 'refund' ? 'Återförd moms' : 'Varav moms'}</span><span>{money(payment.allocations.reduce((sum, allocation) => sum + allocation.vatOre, 0))}</span></div>
    {receiptVat(receipt).map(row => <div key={row.vatBps}><div className="receipt-line"><span>Moms {vatRateLabel(row.vatBps)}</span><span>{money(row.vatOre)}</span></div><div className="receipt-line receipt-vat-base"><span>Underlag exkl. moms</span><span>{money(row.netOre)}</span></div></div>)}
    <div className="receipt-line"><span>Dricks</span><span>{money(payment.tipOre)}</span></div>
    <div className="receipt-line"><strong>{receiptMethodNames[payment.method]}</strong><strong>{money(payment.amountOre + payment.tipOre)}</strong></div>
    {payment.tenderedOre !== null && <><div className="receipt-line"><span>Mottaget</span><span>{money(payment.tenderedOre)}</span></div><div className="receipt-line"><span>Tillbaka</span><span>{money(payment.changeOre)}</span></div></>}
    {receipt.originalReceiptId && <p className="receipt-reference">Originalkvittots id:<br />{receipt.originalReceiptId}</p>}
    {payment.reason && <p>Orsak: {payment.reason}</p>}
    <p className="receipt-reference">Kontroll: simulator · ingen certifierad enhet{receipt.controlCode && <><br />Simulerad kontrollkod:<br />{receipt.controlCode}</>}<br />Förhandsvisning · ej giltigt som kundkvitto</p>
    <div className="receipt-thanks">Grazie mille.</div>
  </div>;
}

export function PaymentModal({ tabId, onClose, ...props }: WorkspaceProps & { tabId: string; onClose: () => void }) {
  const { data, busy, run } = props;
  const tab = data.tabs.find(tab => tab.id === tabId)!;
  const [mode, setMode] = useState<'all' | 'guest' | 'items' | 'amount' | 'equal'>('all');
  const [guest, setGuest] = useState(1);
  const [parts, setParts] = useState(tab.guestCount);
  const [lineIds, setLineIds] = useState<string[]>([]);
  const [amount, setAmount] = useState('');
  const [tip, setTip] = useState('0');
  const [tendered, setTendered] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('card');
  const [simulation, setSimulation] = useState<Simulation>('approved');
  const [fiscalUnknown, setFiscalUnknown] = useState(false);
  const [swishVerified, setSwishVerified] = useState(false);
  const [resultId, setResultId] = useState<string | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);
  const { attempts, storageError, remember, forget } = usePaymentAttempts(data.actor, data.testRoundId);
  const attempt = attempts.find((entry): entry is Extract<PaymentAttempt, { kind: 'sale' }> => entry.kind === 'sale' && entry.targetId === tabId);
  const recovered = attempt ? data.payments.find(payment => payment.key === attempt.input.key) : undefined;
  useEffect(() => {
    if (!recovered) return;
    setResultId(recovered.id);
    if (['approved', 'declined', 'cancelled'].includes(recovered.status)) forget(recovered.key);
  }, [recovered?.id, recovered?.status, forget]);
  const totals = calculateTab(tab);
  const reserved = data.payments.filter(payment => payment.tabId === tab.id && payment.kind === 'sale' && ['approved', 'unknown', 'pending'].includes(payment.status));
  const lines = totals.lines.map(line => {
    const orderLine = tab.lines.find(candidate => candidate.id === line.lineId)!;
    const used = reserved.flatMap(payment => payment.allocations).filter(allocation => allocation.lineId === line.lineId).reduce((sum, allocation) => sum + allocation.grossOre, 0);
    return { ...line, line: orderLine, remaining: line.grossOre - used };
  });
  const totalRemaining = lines.reduce((sum, line) => sum + line.remaining, 0);
  const selectedAmount = mode === 'amount' ? parseMoney(amount) : mode === 'equal' ? (Number.isInteger(parts) && parts >= 1 && parts <= 100 ? distribute(totalRemaining, Array<number>(parts).fill(1))[0] : null) : lines.filter(line => mode === 'all' || mode === 'guest' && line.line.guest === guest || mode === 'items' && lineIds.includes(line.lineId)).reduce((sum, line) => sum + line.remaining, 0);
  const tipOre = parseMoney(tip);
  const result = data.payments.find(payment => payment.id === resultId);
  const receipt = data.receipts.find(receipt => receipt.paymentId === resultId);
  const uncertain = data.payments.filter(payment => payment.tabId === tab.id && payment.kind === 'sale' && ['unknown', 'pending'].includes(payment.status));
  const locked = busy || !!attempt || uncertain.length > 0 || !!storageError;
  const canCash = ['admin', 'cashier'].includes(data.actor.staff.role) && data.actor.device.kind === 'main';
  const valid = selectedAmount !== null && selectedAmount >= 0 && selectedAmount <= totalRemaining && (selectedAmount > 0 || totals.grossOre === 0 && tab.status === 'open') && tipOre !== null && (method !== 'cash' || (parseMoney(tendered) ?? -1) >= selectedAmount + tipOre) && (method !== 'swish' || swishVerified) && (mode !== 'items' || lineIds.length > 0);
  const pay = async () => {
    if (!attempt && (selectedAmount === null || tipOre === null)) return;
    const saved: PaymentAttempt = attempt ?? {
      version: 1, kind: 'sale', targetId: tab.id, createdAt: new Date().toISOString(),
      input: { key: newKey(), version: tab.version, method, amountOre: selectedAmount!, tipOre: tipOre!, ...(mode === 'guest' ? { guest } : mode === 'items' ? { lineIds } : {}), ...(method === 'cash' ? { tenderedOre: parseMoney(tendered)! } : {}), swishVerified, simulation, fiscalSimulation: fiscalUnknown ? 'unknown' : 'confirmed' },
    };
    const payment = await run(() => submitPaymentAttempt(saved, remember, forget));
    if (payment) setResultId(payment.id);
  };
  const nextInstallment = () => {
    setResultId(null);
    setTip('0');
    setLineIds([]);
    setAmount('');
    // A new guest's payment needs its own verification and cash tender.
    // Resuming a saved attempt continues to use its original input in pay().
    setSwishVerified(false);
    setTendered('');
    if (mode === 'equal') setParts(current => Math.max(1, current - 1));
  };
  return <Modal title="Ta betalt" subtitle={`${tab.label} · ${tab.guestCount} gäster · träningsbetalning`} onClose={onClose} wide>
    {showReceipt && receipt ? <><ReceiptPaper receipt={receipt} /><Action onClick={onClose}>Klart</Action></> : result?.status === 'approved' ? <div className="payment-success"><span><CircleCheck size={40} /></span><h3>Betalningen är godkänd</h3><strong>{money(result.amountOre + result.tipOre)}</strong><p>{result.tipOre ? `${money(result.tipOre)} är dricks. ` : ''}{tab.status === 'paid' ? 'Notan är helt betald.' : `${money(totalRemaining)} återstår på notan.`}</p>{receipt?.fiscalStatus !== 'confirmed' && <div className="notice warning"><CircleAlert size={18} /><span>Kontrollkodens svar är osäkert. Kontrollera före dagsavslut.</span><button onClick={() => void run(() => api(`/receipts/${receipt!.id}/verify`, {}))} disabled={busy}>Kontrollera</button></div>}<div className="action-row"><Action secondary onClick={() => setShowReceipt(true)} disabled={!receipt || receipt.fiscalStatus !== 'confirmed'}><ReceiptText size={17} />Visa testkvitto</Action>{tab.status === 'open' ? <Action onClick={nextInstallment}>Nästa delbetalning</Action> : <Action onClick={onClose}>Klart</Action>}</div></div> : <>
      {storageError && <p className="form-error" role="alert">{storageError}</p>}
      {attempt && !recovered && <div className="notice warning payment-recovery"><CircleAlert size={18} /><div><strong>Betalningsförsöket är sparat på enheten</strong><span>Kontrollera eller återuppta samma försök med oförändrat belopp. Det går även efter en omladdning.</span><span>{money((attempt.input.amountOre ?? 0) + attempt.input.tipOre)} · {attempt.input.method === 'card' ? 'Kort' : attempt.input.method === 'swish' ? 'Swish' : 'Kontanter'}</span></div></div>}
      {uncertain.map(payment => <div className="notice warning" key={payment.id}><CircleAlert size={18} /><div><strong>Osäker betalning · {money(payment.amountOre)}</strong><span>Kontrollera samma betalning innan du tar betalt igen.</span></div><Action secondary disabled={busy} onClick={async () => { const checked = await run(() => api<Payment>(`/payments/${payment.id}/check`, {})); if (checked) setResultId(checked.id); }}><RefreshCw size={15} />Kontrollera</Action><button disabled={busy} onClick={async () => { const checked = await run(() => api<Payment>(`/payments/${payment.id}/cancel`, {})); if (checked) setResultId(checked.id); }}>Avbryt</button></div>)}
      <fieldset className="payment-fields" disabled={locked}>
      <div className="split-tabs">{([{ id: 'all', label: 'Hela notan', icon: ReceiptText }, { id: 'guest', label: 'Per gäst', icon: Users }, { id: 'items', label: 'Artiklar', icon: Split }, { id: 'amount', label: 'Delbelopp', icon: Banknote }, { id: 'equal', label: 'Dela lika', icon: Split }] as const).map(option => <button key={option.id} className={mode === option.id ? 'active' : ''} onClick={() => setMode(option.id)}><option.icon size={17} />{option.label}</button>)}</div>
      {mode === 'equal' && <Field label="Antal delar som återstår"><input type="number" min={1} max={100} value={parts} onChange={event => setParts(Number(event.target.value))} /><span>Sista delen tar hand om eventuell avrundning i öre.</span></Field>}
      {mode === 'guest' && <Field label="Betala för gäst"><select value={guest} onChange={event => setGuest(Number(event.target.value))}><option value={0}>Gemensamma artiklar</option>{Array.from({ length: tab.guestCount }, (_, index) => <option key={index} value={index + 1}>Gäst {index + 1}</option>)}</select></Field>}
      {mode === 'items' && <div className="payment-items">{lines.filter(line => line.remaining > 0).map(line => <label key={line.lineId}><input type="checkbox" checked={lineIds.includes(line.lineId)} onChange={event => setLineIds(current => event.target.checked ? [...current, line.lineId] : current.filter(id => id !== line.lineId))} /><span>{line.line.name}<small>Gäst {line.line.guest || 'gemensamt'}</small></span><strong>{money(line.remaining)}</strong></label>)}</div>}
      {mode === 'amount' && <Field label="Delbelopp i kronor"><input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0,00" /></Field>}
      <div className="pay-amount"><span>Att betala</span><strong>{selectedAmount === null ? '—' : money(selectedAmount)}</strong><small>Återstår totalt {money(totalRemaining)} · inklusive moms</small></div>
      <div className="payment-methods">{([{ id: 'card', label: 'Kort', icon: CreditCard }, { id: 'swish', label: 'Swish', icon: Smartphone }, { id: 'cash', label: 'Kontanter', icon: Banknote }] as const).map(option => <button className={method === option.id ? 'active' : ''} key={option.id} disabled={option.id === 'cash' && !canCash} onClick={() => setMethod(option.id)}><option.icon size={24} strokeWidth={1.3} />{option.label}</button>)}</div>
      <div className="field-grid"><Field label="Dricks i kronor"><input value={tip} inputMode="decimal" onChange={event => setTip(event.target.value)} /></Field>{method === 'cash' && <Field label="Mottaget kontant i kronor"><input value={tendered} inputMode="decimal" onChange={event => setTendered(event.target.value)} /></Field>}</div>
      {method === 'cash' && <p className="muted">Tillbaka: {money(Math.max(0, (parseMoney(tendered) ?? 0) - (selectedAmount ?? 0) - (tipOre ?? 0)))}</p>}
      {method === 'swish' && <label className="check-row"><input type="checkbox" checked={swishVerified} onChange={event => setSwishVerified(event.target.checked)} /><span>Jag har verifierat testbetalningen på företagets konto.</span></label>}
      <details className="simulation-controls"><summary>Välj testscenario</summary><Field label="Betalningens resultat"><select value={simulation} onChange={event => setSimulation(event.target.value as Simulation)}><option value="approved">Godkänd</option><option value="declined">Nekad</option><option value="cancelled">Avbruten</option><option value="unknown">Förlorat svar · okänd status</option></select></Field><label className="check-row"><input type="checkbox" checked={fiscalUnknown} onChange={event => setFiscalUnknown(event.target.checked)} />Förlorat svar från kontrollenhet</label></details>
      </fieldset>
      {result && ['declined', 'cancelled'].includes(result.status) && <p className="form-error" role="alert">{result.status === 'declined' ? 'Testbetalningen nekades.' : 'Testbetalningen avbröts.'} Ingen betalning har registrerats.</p>}
      <Action disabled={busy || !!storageError || (!!attempt ? !!recovered : !valid || uncertain.length > 0)} onClick={() => void pay()}><CreditCard size={18} />{attempt ? 'Återuppta samma betalningsförsök' : `Simulera betalning · ${money((selectedAmount ?? 0) + (tipOre ?? 0))}`}</Action><p className="receipt-footnote">Inga pengar dras. Betalning och kontrollenhet är simulatorer.</p>
    </>}
  </Modal>;
}
