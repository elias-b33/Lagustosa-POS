import { useState } from 'react';
import { ArrowRight, CircleAlert, Printer, RefreshCw } from 'lucide-react';
import type { PrinterProfile, PrintJob } from '../shared/types';
import { printerDestination } from '../shared/printers';
import { api } from './api';
import { Action, Empty, Field, Modal, printStatusNames, type WorkspaceProps } from './components';

export function PrintsView({ data, busy, run }: WorkspaceProps) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const selected = data.printJobs.find(job => job.id === jobId);
  const jobs = [...data.printJobs].reverse().filter(job => filter === 'all' || job.status === filter);
  const sourceLabel = (job: PrintJob) => data.tickets.find(ticket => ticket.id === job.sourceId)?.tabLabel
    ?? data.receipts.find(receipt => receipt.id === job.sourceId)?.tab.label
    ?? data.tabs.find(tab => tab.id === job.sourceId)?.label
    ?? data.days.find(day => day.id === job.sourceId)?.date
    ?? data.devices.find(device => device.id === job.sourceId)?.name;
  return <section className="operations"><div className="section-heading"><div><span className="eyebrow">VARJE BONG PÅ RÄTT PLATS</span><h2>Utskrifter</h2></div><span className="tag">{data.printIntegration ? 'Epson-test aktiverat' : 'Förhandsvisning'}</span></div>
    {data.printIntegration && <div className="notice"><Printer size={18} /><span>{data.printers.find(printer => printer.id === data.printIntegration?.printerId)?.name ?? data.printIntegration.printerId} är kopplad till Epson {data.printIntegration.host}. Öppna en bong och välj Skriv ut på Epson. Övriga skrivarprofiler simuleras.</span></div>}
    <div className="category-row">{[['all', 'Alla'], ['queued', 'I kö'], ['printing', 'Pågår'], ['failed', 'Misslyckade'], ['uncertain', 'Osäkra'], ['printed', 'Utskrivna']].map(([value, label]) => <button className={filter === value ? 'active' : ''} onClick={() => setFilter(value)} key={value}>{label}</button>)}</div>
    {jobs.length ? <div className="list-card print-list">{jobs.map(job => <button className="list-row" onClick={() => setJobId(job.id)} key={job.id}><span className="list-icon"><Printer size={19} /></span><div><strong>{job.kind === 'guest' ? 'Gästkvitto' : job.kind === 'kitchen' ? 'Köksbong' : job.kind === 'bar' ? 'Barbong' : job.kind === 'drawer' ? 'Kassalåda' : 'Dagsavslut'}{sourceLabel(job) ? ` · ${sourceLabel(job)}` : ''}{job.reprintOf ? ' · kopia' : ''}</strong><span>{job.printerName ?? 'Skrivare behöver väljas'} · {new Date(job.createdAt).toLocaleString('sv-SE')}</span></div><span className={`tag ${job.status}`}>{printStatusNames[job.status]}</span><ArrowRight size={16} /></button>)}</div> : <Empty title="Ingen utskrift i den här vyn" text="Köksbongar och kvitton sparas i kön när du arbetar i kassan." />}
    {selected && <PrintPreview key={selected.id} job={selected} physical={selected.printerId === data.printIntegration?.printerId} dayOpen={!!data.currentDay} copyExists={data.printJobs.some(job => job.kind === 'guest' && job.sourceId === selected.sourceId && job.reprintOf !== null)} printers={data.printers ?? []} busy={busy} onClose={() => setJobId(null)} onAction={async body => { const job = await run(() => api<PrintJob>(`/print-jobs/${selected.id}/actions`, body)); if (job) setJobId(job.id); }} />}
  </section>;
}

function PrintPreview({ job, physical, dayOpen, copyExists, printers, busy, onClose, onAction }: { job: PrintJob; physical: boolean; dayOpen: boolean; copyExists: boolean; printers: PrinterProfile[]; busy: boolean; onClose: () => void; onAction: (body: unknown) => Promise<void> }) {
  const [outcome, setOutcome] = useState('printed');
  const [reason, setReason] = useState('');
  const [targetId, setTargetId] = useState(job.printerId ?? '');
  const targets = printers.filter(printer => printer.active && printer.destination === printerDestination(job.kind));
  const assigned = targets.find(printer => printer.id === job.printerId);
  const selectedId = targets.some(printer => printer.id === targetId) ? targetId : targets[0]?.id ?? '';
  const receiptCopyBlocked = job.kind === 'guest' && (!!job.reprintOf || copyExists);
  return <Modal title="Utskriftsförhandsvisning" subtitle={`${printStatusNames[job.status]} · ${job.printerName ?? 'Ingen skrivare tilldelad'}`} onClose={onClose}>
    {job.delivery === 'epson-test' && <p className="muted">Fysisk testutskrift · Epson {job.printerAddress}</p>}
    {job.status === 'printed' && job.delivery !== 'epson-test' && <p className="muted">Simulerat utskriftsresultat</p>}
    <pre className="print-paper">{job.reprintOf && <strong className="receipt-type-marker">KOPIA</strong>}{job.kind === 'guest' && <strong className="receipt-type-marker">ÖVNING</strong>}{job.text}</pre>
    {job.status === 'printing' ? <div className="notice">Utskriften pågår. Vänta på resultatet innan du försöker igen.</div> : job.status === 'queued' ? <>
      {!assigned && <div className="notice warning"><CircleAlert size={18} /><span>Välj en aktiv profil för rätt utskriftstyp. Jobbet bevaras i kön tills en skrivare har tilldelats.</span></div>}
      {(targets.length > 1 || !assigned) && <>
        <Field label="Skrivare för den här utskriften"><select value={selectedId} onChange={event => setTargetId(event.target.value)}><option value="">Välj skrivare</option>{targets.map(printer => <option key={printer.id} value={printer.id}>{printer.name} · {printer.paperWidthMm} mm</option>)}</select></Field>
        <Field label="Orsak till byte av skrivare"><input value={reason} onChange={event => setReason(event.target.value)} /></Field>
        <Action secondary disabled={busy || !selectedId || selectedId === job.printerId || reason.trim().length < 3} onClick={() => void onAction({ action: 'route', printerId: selectedId, reason })}>Tilldela skrivare</Action>
      </>}
      {physical ? <div className="notice">Detta skickar en fysisk testutskrift till Epson-skrivaren. Saknas bekräftelse behöver pappret kontrolleras innan en ny utskrift görs.</div> : <Field label="Simulerat skrivarresultat"><select value={outcome} onChange={event => setOutcome(event.target.value)}><option value="printed">Utskriven</option><option value="failed">Avbrott · ingen utskrift</option><option value="uncertain">Förlorat svar · osäker utskrift</option></select></Field>}
      <Action disabled={busy || !assigned || (physical && job.kind === 'drawer')} onClick={() => void onAction({ action: 'print', outcome: physical ? 'printed' : outcome })}><Printer size={17} />{physical ? 'Skriv ut på Epson' : 'Simulera utskrift'}</Action>
    </> : job.status === 'uncertain' ? <>
      <div className="notice warning"><CircleAlert size={18} />Kontrollera först om pappret kom ut.</div>
      <Field label="Vad visade kontrollen?"><select value={outcome} onChange={event => setOutcome(event.target.value)}><option value="printed">Pappret kom ut</option><option value="failed">Pappret kom inte ut</option></select></Field>
      <Field label="Anteckning om kontrollen"><input value={reason} onChange={event => setReason(event.target.value)} /></Field>
      <Action disabled={busy || reason.trim().length < 3} onClick={() => void onAction({ action: 'resolve', outcome, reason })}>Spara kontrollerad status</Action>
    </> : receiptCopyBlocked ? <div className="notice">En märkt kopia har redan skapats för det här gästkvittot. Högst en kopia tillåts, även om utskriften misslyckades.</div> : job.kind === 'guest' && !dayOpen ? <div className="notice">Öppna en verksamhetsdag vid huvudkassan innan en kvittokopia skapas. Kopian ska räknas i dagens rapport.</div> : <>
      <Field label="Orsak till återutskrift"><input value={reason} onChange={event => setReason(event.target.value)} /></Field>
      <Action secondary disabled={busy || reason.trim().length < 3} onClick={() => void onAction({ action: 'reprint', reason })}><RefreshCw size={16} />Skapa en märkt kopia</Action>
    </>}
  </Modal>;
}
