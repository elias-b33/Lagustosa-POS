import { useState, useEffect, useCallback, useRef } from 'react';
import { LayoutGrid, Utensils, ChefHat, Wine, Printer, ChartNoAxesCombined, Settings, LogOut, Wifi, WifiOff, ShieldCheck, ArrowRight, X, CircleAlert, Check, Bell } from 'lucide-react';
import type { Bootstrap, Tab } from '../shared/types';
import { api, ApiError } from './api';
import { Login } from './Login';
import { Pos } from './Pos';
import { PaymentModal } from './Payments';
import { PrintsView, RefundModal, ReportsView, StationView } from './Operations';
import { Admin } from './Admin';
import { Spinner } from './components';
import { usePaymentAttempts } from './usePaymentAttempt';
import { DesignSwitcher } from './DesignSwitcher';

const navigation = [
  { id: 'pos', label: 'Kassa', icon: Utensils }, { id: 'tables', label: 'Bord', icon: LayoutGrid },
  { id: 'kitchen', label: 'Kök', icon: ChefHat }, { id: 'bar', label: 'Bar', icon: Wine },
  { id: 'prints', label: 'Utskrifter', icon: Printer }, { id: 'reports', label: 'Dagsöversikt', icon: ChartNoAxesCombined },
  { id: 'admin', label: 'Inställningar', icon: Settings },
];

export function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(location.hash.slice(1) || 'tables');
  const [tabId, setTabId] = useState<string | null>(null);
  const [paymentTab, setPaymentTab] = useState<string | null>(null);
  const [recoveryRefund, setRecoveryRefund] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const refreshSequence = useRef(0);
  const lastApplied = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const result = await api<Bootstrap>('/bootstrap');
      if (sequence > lastApplied.current) { lastApplied.current = sequence; setData(result); }
      setOffline(false);
    } catch (issue) {
      if (issue instanceof ApiError && issue.status === 401) setData(null);
      else setOffline(true);
    }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const identity = data ? `${data.actor.staff.id}:${data.actor.device.id}` : null;
  const { attempts: savedAttempts, storageError } = usePaymentAttempts(data?.actor);
  useEffect(() => {
    if (!identity) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const events = new EventSource('/api/v1/events');
    const changed = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void refresh(), 80); };
    events.addEventListener('change', changed);
    events.onopen = () => { setOffline(false); void refresh(); };
    events.onerror = () => setOffline(true);
    const fallback = setInterval(() => void refresh(), 30000);
    return () => { events.close(); clearInterval(fallback); if (timer) clearTimeout(timer); };
  }, [identity, refresh]);
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 30000);
    const changeView = () => setView(location.hash.slice(1) || 'tables');
    window.addEventListener('hashchange', changeView);
    return () => { clearInterval(timer); window.removeEventListener('hashchange', changeView); if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, []);
  const navigate = (id: string) => { location.hash = id; setView(id); };
  const run = async <Result,>(operation: () => Promise<Result>, success?: string): Promise<Result | undefined> => {
    setBusy(true);
    try {
      const result = await operation();
      await refresh();
      if (success) { setToast({ text: success, error: false }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 5000); }
      return result;
    } catch (issue) {
      setToast({ text: (issue as Error).message, error: true });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 12000);
      await refresh();
      return undefined;
    } finally { setBusy(false); }
  };
  const standaloneSwitch = <div className="design-standalone"><DesignSwitcher /></div>;
  if (loading) return <>{standaloneSwitch}<div className="loading-page"><div className="wordmark">la gustosa</div><Spinner /><p>Öppnar kassan…</p></div></>;
  if (!data) return <>{standaloneSwitch}<Login onLogin={refresh} /></>;
  const deviceStation = data.actor.device.kind === 'display' ? data.actor.device.station : null;
  const role = data.actor.staff.role;
  const canManage = role === 'admin' || role === 'cashier';
  const availableNav = navigation.filter(item => deviceStation ? item.id === deviceStation : ['kitchen', 'bar'].includes(role) ? item.id === role : item.id === 'admin' ? role === 'admin' : ['prints', 'reports'].includes(item.id) ? canManage : true);
  const activeView = availableNav.some(item => item.id === view) ? view : availableNav[0].id;
  const common = { data, run, refresh, busy };
  const readyCount = data.tickets.filter(ticket => ticket.status === 'ready').length;
  const livePayment = data.tabs.find(tab => tab.id === paymentTab);
  const liveRefund = data.payments.find(payment => payment.id === recoveryRefund);
  return <div className="app-shell"><aside className="sidebar"><div className="brand-monogram">g<span>•</span></div><nav aria-label="Huvudmeny">{availableNav.map(item => <button className={activeView === item.id ? 'active' : ''} key={item.id} onClick={() => navigate(item.id)} title={item.label}><item.icon size={22} strokeWidth={1.5} /><span>{item.label}</span>{item.id === 'prints' && data.printJobs.some(job => job.status === 'uncertain') && <i className="nav-alert" />}</button>)}</nav><div className="sidebar-bottom"><span className="sidebar-leaf">✦</span><span>LA<br />GUSTOSA</span><small>v0.1 · träning</small></div></aside><div className="app-content"><div className="test-strip"><ShieldCheck size={14} /><span>TEST — inga riktiga betalningar</span><small>Träningsversion</small></div><header className="topbar"><div className="topbar-brand">la gustosa<span>{navigation.find(item => item.id === activeView)?.label}</span></div><div className="topbar-right"><DesignSwitcher /><span className={`connection ${offline ? 'offline' : ''}`}>{offline ? <WifiOff size={15} /> : <Wifi size={15} />}<span>{offline ? 'Anslutningen kontrolleras' : 'Lokalt ansluten'}</span></span><span className="device-name">{data.actor.device.name}</span><span className="topbar-clock">{clock.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}</span><div className="staff-chip"><span>{data.actor.staff.name.charAt(0)}</span><strong>{data.actor.staff.name}</strong></div><button className="icon-button" aria-label="Logga ut" title="Logga ut" disabled={busy} onClick={() => void run(() => api('/auth/logout', {}))}><LogOut size={18} /></button></div></header><main className="workspace">
    {storageError && <div className="notice warning recovery-banner" role="alert"><CircleAlert size={19} /><span>{storageError}</span></div>}
    {savedAttempts.map(attempt => <div className="notice warning recovery-banner" key={attempt.input.key}><CircleAlert size={19} /><div><strong>{attempt.kind === 'sale' ? 'Ett betalningsförsök behöver kontrolleras' : 'Ett returförsök behöver kontrolleras'}</strong><span>{data.tabs.find(tab => tab.id === (attempt.kind === 'sale' ? attempt.targetId : data.payments.find(payment => payment.id === attempt.targetId)?.tabId))?.label ?? 'Sparat försök'} · sparat {new Date(attempt.createdAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}</span></div><button disabled={busy} onClick={() => { if (attempt.kind === 'sale') setPaymentTab(attempt.targetId); else setRecoveryRefund(attempt.targetId); }}>{attempt.kind === 'sale' ? 'Återuppta betalning' : 'Återuppta retur'}<ArrowRight size={16} /></button></div>)}
    {!data.currentDay && !deviceStation && !['reports', 'admin'].includes(activeView) && <div className="notice day-notice"><CircleAlert size={19} /><span>Ingen verksamhetsdag är öppen.</span>{canManage && <button onClick={() => navigate('reports')}>Öppna dagen<ArrowRight size={16} /></button>}</div>}
    {['pos', 'tables'].includes(activeView) && <div className="service-context"><span>{clock.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' })}</span><span>{data.currentDay ? `Verksamhetsdag ${data.currentDay.date}` : 'Redo för nästa service'}</span>{readyCount > 0 && <button onClick={() => navigate('kitchen')}><Bell size={14} />{readyCount} klara beställningar</button>}{busy && <Spinner />}</div>}
    {['pos', 'tables'].includes(activeView) && <Pos {...common} tabId={tabId} setTabId={setTabId} tablesView={activeView === 'tables'} showPos={() => navigate('pos')} pay={(tab: Tab) => setPaymentTab(tab.id)} />}
    {activeView === 'kitchen' && <StationView {...common} station="kitchen" />}
    {activeView === 'bar' && <StationView {...common} station="bar" />}
    {activeView === 'prints' && <PrintsView {...common} />}
    {activeView === 'reports' && <ReportsView {...common} />}
    {activeView === 'admin' && <Admin {...common} />}
  </main><footer className="app-footer"><span>LA GUSTOSA · BORÅS</span><span>En god kväll, från första beställningen till sista kvittot.</span><i /> <span>Träning</span></footer></div>
  {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleAlert size={20} /> : <Check size={20} />}<span>{toast.text}</span><button className="icon-button" onClick={() => setToast(null)} aria-label="Stäng meddelande"><X size={17} /></button></div>}
  {livePayment && <PaymentModal key={livePayment.id} {...common} tabId={livePayment.id} onClose={() => setPaymentTab(null)} />}
  {liveRefund && <RefundModal key={liveRefund.id} {...common} payment={liveRefund} onClose={() => setRecoveryRefund(null)} />}
  </div>;
}
