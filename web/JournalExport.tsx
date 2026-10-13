import { useEffect, useState } from 'react';
import type { JournalExportCoverage } from '../server/export';
import type { Bootstrap } from '../shared/types';
import { api } from './api';
import { Field } from './components';

export function JournalExport({ data }: { data: Bootstrap }) {
  const [registerId, setRegisterId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [coverage, setCoverage] = useState<JournalExportCoverage | null>(null);
  const [error, setError] = useState('');
  const query = new URLSearchParams({ ...(registerId ? { registerId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  // Receipt count also refreshes a coverage snapshot after a new transaction.
  const revision = `${data.receipts.length}:${data.printJobs.length}:${data.days.length}:${data.currentDay?.id ?? ''}`;
  useEffect(() => {
    let active = true; setCoverage(null); setError('');
    api<JournalExportCoverage>(`/journal/coverage?${query}`).then(value => { if (active) setCoverage(value); }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [query, revision]);
  return <article className="card journal-export"><h3>Exportera journal</h3>
    <div className="field-grid">
      <Field label="Kassa för journalexport"><select value={registerId} onChange={event => setRegisterId(event.target.value)}><option value="">Alla kassor och äldre historik</option>{data.registers?.map(register => <option key={register.id} value={register.id}>{data.devices.find(device => device.id === register.deviceId)?.name ?? register.deviceId} · {register.id}</option>)}</select></Field>
      <Field label="Från datum"><input type="date" value={from} onChange={event => setFrom(event.target.value)} /></Field>
      <Field label="Till datum"><input type="date" value={to} onChange={event => setTo(event.target.value)} /></Field>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {coverage && <>
      <p className="muted">{coverage.mappedEntryIds.length} händelser kan återges i XML. {coverage.excludedOperational.length} tekniska händelser bevaras i JSON. {coverage.legacy.length} poster har äldre identitetsunderlag.</p>
      {coverage.unsupportedRegulatory.length > 0 && <div className="notice warning"><div><strong>XML-exporten behöver kompletterat underlag</strong><p>{coverage.unsupportedRegulatory.length} händelser saknar en verifierbar XML-mappning. JSON bevarar journalen och orsakerna.</p><details><summary>Visa vad som saknas</summary><ul>{coverage.unsupportedRegulatory.slice(0, 20).map(issue => <li key={`${issue.entryId}:${issue.code}`}>#{issue.entryId}: {issue.reason}</li>)}</ul></details></div></div>}
      <p className="muted">Kontrollen avser exportens datainnehåll. Träningsversionen är inte tillverkardeklarerad för skarp drift.</p>
    </>}
    <div className="action-row compact">
      {coverage?.canExportXml ? <a className="button secondary" href={`/api/v1/journal.xml?${query}`}>Hämta journal XML</a> : <button className="button secondary" disabled>XML kräver komplett underlag</button>}
      {data.actor.staff.role === 'admin' && <a className="button secondary" href={`/api/v1/journal.json?${query}`}>Hämta journalunderlag JSON</a>}
    </div>
  </article>;
}
