import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CreditCard, RefreshCw, Smartphone } from 'lucide-react';
import type { Payment } from '../shared/types';
import type { TerminalPaymentInfo } from '../shared/payment-integration';
import { money } from '../shared/money';
import { api } from './api';
import { Action, type WorkspaceProps } from './components';
import './terminal-payments.css';

export function TerminalProgress({ payment, onResult, ...props }: WorkspaceProps & { payment: Payment; onResult: (payment: Payment) => void }) {
  const [info, setInfo] = useState<TerminalPaymentInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const [paused, setPaused] = useState(false);
  const latest = useRef({ props, onResult });
  latest.current = { props, onResult };
  const inFlight = useRef(false);
  const check = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const poll = async () => {
      if (disposed || document.hidden) return;
      if (inFlight.current) { timer = setTimeout(() => void poll(), 1000); return; }
      inFlight.current = true; setChecking(true);
      try {
        const result = await api<Payment>(`/payments/${payment.id}/check`, {});
        if (disposed) return;
        latest.current.onResult(result);
        setMessage('');
        const terminalInfo = await api<TerminalPaymentInfo | null>(`/payments/${payment.id}/terminal`);
        if (disposed) return;
        setInfo(terminalInfo);
        await latest.current.props.refresh();
        if (['approved', 'declined', 'cancelled'].includes(result.status)) { disposed = true; return; }
      } catch { if (!disposed) setMessage('Svaret kunde inte hämtas. Beloppet är fortsatt reserverat.'); }
      finally {
        inFlight.current = false;
        if (!disposed) {
          setChecking(false);
          polls++;
          if (polls < 60) timer = setTimeout(() => void poll(), 2000);
          else setPaused(true);
        }
      }
    };
    check.current = async () => { clearTimeout(timer); polls = 0; setPaused(false); await poll(); };
    const resume = () => { if (!document.hidden) void check.current(); };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    timer = setTimeout(() => void poll(), 1200);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('focus', resume); };
  }, [payment.id]);
  const cancel = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setChecking(true);
    try {
      const result = await props.run(() => api<Payment>(`/payments/${payment.id}/cancel`, {}));
      if (result) onResult(result);
    } finally { inFlight.current = false; setChecking(false); }
  };
  const simulate = async (action: string) => {
    const result = await props.run(() => api('/contract-test/transaction', { paymentId: payment.id, action }));
    if (result) await check.current();
  };
  const uncertain = payment.status === 'unknown' || Boolean(info?.issue);
  return <section className="terminal-progress" aria-label="Kortterminalens betalningsstatus">
    <div className="terminal-progress-top"><span className="terminal-icon"><Smartphone size={28} /></span><span className="tag">{props.data.paymentIntegration?.contractTest ? 'Lokalt integrationstest' : 'Softpay · sandbox'}</span></div>
    <h3>{uncertain ? 'Betalningssvaret behöver kontrolleras' : payment.kind === 'refund' ? 'Väntar på testkort för retur' : 'Väntar på testkort'}</h3>
    <strong className="terminal-amount">{money(payment.amountOre)}</strong>
    <p>{uncertain ? 'Samma försök kontrolleras. Starta inte en ny betalning innan resultatet är känt.' : props.data.paymentIntegration?.contractTest ? 'Prova betalningsflödet med den lokala terminalsimulatorn nedan.' : 'Slutför i Softpay på den kopplade enheten. Öppna betalappen om den inte visas automatiskt.'}</p>
    {info && <dl className="terminal-reference"><dt>Testenhet</dt><dd>{info.appId}</dd>{info.requestId && <><dt>Betalningsreferens</dt><dd>{info.requestId}</dd></>}</dl>}
    <div className="terminal-check-state" role="status"><RefreshCw size={15} />{message || (paused ? 'Automatisk kontroll är pausad. Kontrollera igen när enheten är redo.' : checking ? 'Kontrollerar betalningsresultatet…' : 'Resultatet kontrolleras automatiskt.')}</div>
    <div className="action-row"><Action secondary disabled={checking || props.busy} onClick={() => void check.current()}>Kontrollera nu</Action><button className="text-button" disabled={checking || props.busy} onClick={() => void cancel()}>Avbryt försöket</button></div>
    {props.data.paymentIntegration?.contractTest && <div className="terminal-lab"><strong>Lokal terminalsimulator</strong><p>Dessa knappar ersätter testkortet. Ingen anslutning till Softpay eller en bank görs.</p><div className="action-row">{([{ action: 'approve', label: 'Simulera blipp' }, { action: 'decline', label: 'Neka testköpet' }, { action: 'approve-lose-response', label: 'Blippa och förlora svaret' }, { action: 'restore-connection', label: 'Återställ förbindelsen' }] as const).map(option => <button key={option.action} disabled={props.busy} className="button secondary" onClick={() => void simulate(option.action)}>{option.label}</button>)}</div></div>}
    <small>{props.data.paymentIntegration?.contractTest ? 'Test av integrationskod med lokalt simulerade API-svar.' : 'Endast testkort. Ingen riktig debitering.'} Kontrollkoppling och kassakvitto är fortfarande simulerade.</small>
  </section>;
}

export function PaymentConnections({ data }: Pick<WorkspaceProps, 'data'>) {
  const integration = data.paymentIntegration;
  const sandbox = integration?.provider === 'softpay-sandbox';
  const local = integration?.contractTest;
  return <div className="payment-connections">
    <article className="card"><div className="section-heading secondary-heading"><div><span className="eyebrow">BETALNING PÅ HANDTERMINALEN</span><h3>{local ? 'Lokalt integrationstest' : sandbox ? 'Softpay sandbox' : 'Betalningskoppling'}</h3></div><CreditCard size={24} /></div>
      <p>{local ? 'Integrationskoden körs mot lokalt simulerade API-svar. Ingen Softpay-app, bank eller fysisk terminal är ansluten.' : sandbox ? 'Testköp skickas till en kopplad Softpay-app. Belopp och resultat kontrolleras av servern.' : 'Kassan använder den lokala betalningssimulatorn. Softpay-kopplingen är förberedd för en separat testinstallation med utvecklarkonto.'}</p>
      <div className="notice warning"><CircleAlert size={18} /><span>{local ? 'Testknapparna i betalningsdialogen ersätter kortet. Dricks är avstängd.' : sandbox ? 'Använd endast leverantörens testkort. Dricks och återbetalning utan närvarande kort är ännu inte aktiverade.' : 'Ingen betalningsleverantör är ansluten i denna övningsmiljö.'}</span></div>
      <p className="muted">Betalningsintegration ersätter inte kassaregistrets kontrollösning och tillverkardeklaration. Produktionsdrift är spärrad.</p>
    </article>
    <div className="list-card hardware-list">{data.devices.filter(device => device.kind !== 'display').map(device => {
      const terminal = integration?.terminals.find(entry => entry.deviceId === device.id);
      return <div className="list-row" key={device.id}><span className="list-icon"><Smartphone size={20} /></span><div><strong>{device.name}</strong><span>{terminal ? `Softpay-app ${terminal.appId}` : sandbox ? 'Ingen testterminal kopplad' : 'Lokal simulator'}</span><small>{data.registers?.find(register => register.deviceId === device.id)?.id}</small></div><span className="tag">{local ? 'Lokalt test' : terminal ? 'Sandbox' : 'Övning'}</span></div>;
    })}</div>
  </div>;
}
