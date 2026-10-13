import { useEffect, useState } from 'react';
import { ArrowRight, Delete, ShieldCheck, Wine } from 'lucide-react';
import { api } from './api';
import type { Staff } from '../shared/types';
import { Action, Field, roleNames } from './components';

export function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [staffId, setStaffId] = useState('admin');
  const [pin, setPin] = useState('');
  const [deviceCode, setDeviceCode] = useState(() => localStorage.getItem('lagustosa-device') || new URLSearchParams(location.search).get('device') || 'LAGUSTOSA-TEST');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [safeTest, setSafeTest] = useState(false);
  useEffect(() => { api<{ environment: string }>('/health').then(result => setSafeTest(result.environment === 'safe-test')).catch(() => {}); }, []);
  useEffect(() => { api<Staff[]>('/auth/staff').then(setStaff).catch(() => setError('Kassan kunde inte nås. Kontrollera att servern är igång.')); }, []);
  const login = async () => {
    setBusy(true); setError('');
    try { await api('/auth/login', { staffId, pin, deviceCode }); localStorage.setItem('lagustosa-device', deviceCode); await onLogin(); }
    catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="login-page"><section className="login-story"><div className="wordmark">la gustosa<span>RISTORANTE · BORÅS</span></div><div className="login-art"><Wine size={110} strokeWidth={0.6} /><span className="art-orbit orbit-one" /><span className="art-orbit orbit-two" /><span className="art-dot" /></div><div className="story-copy"><span className="eyebrow">EN GOD KVÄLL BÖRJAR HÄR</span><h1>Mer tid<br />vid bordet.</h1><p>Din restaurang. Ditt flöde.<br />En plats för hela servicen.</p></div><span className="story-footer">SANDWALLSPLATS 7 · LA GUSTOSA</span></section><section className="login-form"><div className="login-box"><span className="tag training-tag"><ShieldCheck size={14} /> {safeTest ? 'SÄKER TESTMILJÖ' : 'TRÄNINGSLÄGE'}</span><h2>Välkommen tillbaka</h2><p className="muted">Välj din profil och ange din personliga PIN.</p><form onSubmit={event => { event.preventDefault(); void login(); }}><Field label="Personal"><select value={staffId} onChange={event => { setStaffId(event.target.value); setPin(''); }}>{staff.map(person => <option key={person.id} value={person.id}>{person.name} · {roleNames[person.role]}</option>)}</select></Field><Field label="PIN-kod"><input value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))} type="password" inputMode="numeric" autoComplete="off" maxLength={8} autoFocus placeholder="••••" aria-label="PIN-kod" /></Field><div className="pin-pad">{['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Rensa', '0', 'delete'].map(value => <button type="button" key={value} onClick={() => setPin(current => value === 'Rensa' ? '' : value === 'delete' ? current.slice(0, -1) : (current + value).slice(0, 8))}>{value === 'delete' ? <Delete size={20} /> : value}</button>)}</div><details className="device-details"><summary>Enhet och testprofiler</summary><Field label="Enhetskod"><input value={deviceCode} onChange={event => setDeviceCode(event.target.value)} /></Field><p>Ansvarig 1234 · Kassa 2345 · Servering 3456<br />Kök 4567 · Bar 5678</p><p>Servering: SERVERING-1 till SERVERING-4<br />Kök: KOK-TEST · Bar: BAR-TEST</p></details>{error && <p className="form-error" role="alert">{error}</p>}<Action type="submit" disabled={busy || pin.length < 4 || !staff.length}>{busy ? 'Loggar in…' : 'Börja servicen'}<ArrowRight size={18} /></Action></form><p className="login-test-note">TEST — inga riktiga betalningar.<br />Meny och testprofiler kan ändras i inställningarna.</p></div></section></div>;
}
