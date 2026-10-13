import { useState } from 'react';
import { Check, Pencil, Plus, Printer, Wifi } from 'lucide-react';
import type { DeviceConnection, PrinterProfile } from '../shared/types';
import { printerDestinationNames } from '../shared/printers';
import { api, newKey } from './api';
import { Action, Field, Modal, type WorkspaceProps } from './components';

export function DeviceStatusLabel({ connection }: { connection: DeviceConnection | undefined }) {
  const online = !!connection?.connections;
  return <span className={`device-status ${online ? 'online' : ''}`}><Wifi size={13} />
    {online ? connection.connections > 1 ? `${connection.connections} flikar anslutna` : 'Skärm ansluten' : 'Ingen skärm ansluten'}
    {!online && connection?.lastSeenAt && <small>Senast {new Date(connection.lastSeenAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}</small>}
  </span>;
}

export function PrinterSettings({ data, busy, run }: WorkspaceProps) {
  const [editing, setEditing] = useState<PrinterProfile | null>(null);
  const printers = data.printers ?? [];
  return <>
    <div className="section-heading secondary-heading"><div><h3>Skrivare & utskrifter</h3><p className="muted">En profil vardera för kök, bar och gästkvitton. Varje utskrift behåller sin tilldelade skrivare.</p></div>
      <Action disabled={busy} onClick={() => setEditing({ id: newKey(), name: '', destination: 'guest', paperWidthMm: 80, active: false })}><Plus size={17} />Ny skrivarprofil</Action>
    </div>
    <div className="notice"><Printer size={18} /><span>Träningsläget använder utskriftsförhandsvisning. Fysisk koppling läggs till när era nya skrivarmodeller har valts.</span></div>
    <div className="list-card hardware-list">{printers.map(printer => {
      const waiting = data.printJobs.filter(job => job.printerId === printer.id && ['queued', 'printing', 'uncertain'].includes(job.status)).length;
      return <div className="list-row" key={printer.id}><span className="list-icon"><Printer size={19} /></span><div><strong>{printer.name}</strong><span>{printerDestinationNames[printer.destination]} · {printer.paperWidthMm} mm</span><span>{waiting} väntande eller pågående kontroller</span></div><span className={`tag ${printer.active ? 'ready' : ''}`}>{printer.active ? 'Profil aktiv' : 'Profil avstängd'}</span><button className="icon-button" disabled={busy} aria-label={`Redigera ${printer.name}`} onClick={() => setEditing(printer)}><Pencil size={17} /></button></div>;
    })}</div>
    {editing && <PrinterForm key={editing.id} initial={editing} printers={printers} busy={busy} onClose={() => setEditing(null)} onSave={async printer => { if (await run(() => api(`/printers/${printer.id}`, printer, 'PUT'), 'Skrivarprofilen är sparad.')) setEditing(null); }} />}
  </>;
}

function PrinterForm({ initial, printers, busy, onClose, onSave }: { initial: PrinterProfile; printers: PrinterProfile[]; busy: boolean; onClose: () => void; onSave: (printer: PrinterProfile) => Promise<void> }) {
  const [printer, setPrinter] = useState({ ...initial });
  const conflict = printer.active && printers.find(candidate => candidate.id !== printer.id && candidate.active && candidate.destination === printer.destination);
  return <Modal title={initial.name ? 'Redigera skrivarprofil' : 'Ny skrivarprofil'} subtitle="En aktiv profil per utskriftstyp. Köade jobb flyttas uttryckligen i utskriftsvyn." onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); void onSave(printer); }}><fieldset className="payment-fields" disabled={busy}>
      <Field label="Skrivarens namn"><input value={printer.name} maxLength={60} required onChange={event => setPrinter({ ...printer, name: event.target.value })} /></Field>
      <Field label="Utskriftstyp"><select value={printer.destination} onChange={event => setPrinter({ ...printer, destination: event.target.value as PrinterProfile['destination'] })}>{Object.entries(printerDestinationNames).map(([value, name]) => <option value={value} key={value}>{name}</option>)}</select></Field>
      <Field label="Pappersbredd"><select value={printer.paperWidthMm} onChange={event => setPrinter({ ...printer, paperWidthMm: Number(event.target.value) as PrinterProfile['paperWidthMm'] })}><option value={80}>80 mm</option><option value={58}>58 mm</option></select></Field>
      <label className="check-row"><input type="checkbox" checked={printer.active} onChange={event => setPrinter({ ...printer, active: event.target.checked })} />Profilen är aktiv</label>
    </fieldset>
    {conflict && <p className="form-error" role="alert">{conflict.name} är redan aktiv för den här utskriftstypen. Spara den nya profilen som avstängd och stäng sedan av den tidigare profilen innan den nya aktiveras.</p>}
    <Action type="submit" disabled={busy || !printer.name.trim() || !!conflict}>Spara skrivarprofil<Check size={17} /></Action></form>
  </Modal>;
}
