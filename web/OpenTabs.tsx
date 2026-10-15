import { useState } from 'react';
import { ArrowRight, Check, CreditCard, ReceiptText, Search } from 'lucide-react';
import type { Tab } from '../shared/types';
import { calculateTab, money, paidOre } from '../shared/money';
import { api, ApiError, newKey } from './api';
import { Action, Modal, type WorkspaceProps } from './components';

interface OpenTabsProps extends WorkspaceProps {
  dayId: string;
  onOpen: (tab: Tab) => void;
  onPay: (tab: Tab) => void;
}

export function OpenTabs({ data, busy, run, dayId, onOpen, onPay }: OpenTabsProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [closing, setClosing] = useState<Tab[] | null>(null);
  const [result, setResult] = useState<{ closed: number; issues: string[] } | null>(null);
  const rows = data.tabs.filter(tab => tab.dayId === dayId && tab.status === 'open')
    .sort((a, b) => a.number - b.number).map(tab => {
      const lines = tab.lines.filter(line => line.status !== 'void');
      const payments = data.payments.filter(payment => payment.tabId === tab.id);
      const uncertain = payments.find(payment => ['pending', 'unknown'].includes(payment.status));
      const fiscalUncertain = data.receipts.find(receipt => receipt.tab.id === tab.id && receipt.fiscalStatus !== 'confirmed');
      const paid = paidOre(payments, tab.id);
      const remaining = Math.max(0, calculateTab(tab).grossOre - paid);
      const drafts = lines.filter(line => line.status === 'draft').length;
      const held = lines.filter(line => line.status === 'held').length;
      const empty = lines.length === 0 && !uncertain && !fiscalUncertain && !payments.some(payment => payment.kind === 'sale' && payment.status === 'approved');
      const payable = lines.length > 0 && !drafts && !held && !uncertain && !fiscalUncertain;
      const status = uncertain ? 'Betalning behöver kontrolleras' : fiscalUncertain ? 'Kontrollkod behöver kontrolleras' : empty ? 'Tom nota' :
        drafts || held ? [drafts ? `${drafts} ${drafts === 1 ? 'oskickad rad' : 'oskickade rader'}` : '', held ? `${held} väntande ${held === 1 ? 'rad' : 'rader'}` : ''].filter(Boolean).join(' · ') :
        paid > 0 ? 'Delbetald' : 'Redo för betalning';
      return { tab, paid, remaining, empty, payable, status, uncertain, fiscalUncertain, attention: !empty && !payable };
    });
  const emptyTabs = rows.filter(row => row.empty).map(row => row.tab);
  const visible = rows.filter(row => `${row.tab.label} #${row.tab.number}`.toLocaleLowerCase('sv-SE').includes(query.trim().toLocaleLowerCase('sv-SE')) &&
    (filter === 'all' || filter === 'empty' && row.empty || filter === 'payable' && row.payable || filter === 'attention' && row.attention));
  const closeEmpty = async (tabs: Tab[]) => {
    const outcome = await run(async () => {
      let closed = 0;
      const issues: string[] = [];
      for (const tab of tabs) {
        // Keep the version the user reviewed. A concurrent order must never be closed or retried automatically.
        try {
          await api<Tab>(`/tabs/${tab.id}/commands`, { action: 'void', key: newKey(), version: tab.version });
          closed++;
        } catch (error) {
          issues.push(`${tab.label} · #${tab.number}: ${(error as Error).message}`);
          // Stop on a lost response; the operator must check the refreshed list before continuing.
          if (!(error instanceof ApiError) || error.status === 0) break;
        }
      }
      return { closed, issues };
    });
    if (outcome) setResult(outcome);
  };

  return <section className="open-tabs-panel" id="open-tabs-panel" tabIndex={-1} aria-label="Oavslutade notor">
    <header className="open-tabs-heading"><div><span className="eyebrow">INFÖR DAGSAVSLUT</span><h3>Oavslutade notor <span className="open-tabs-count">{rows.length}</span></h3>
      <p>{rows.length ? 'Betala kvarvarande beställningar eller avsluta tomma notor här.' : 'Alla notor är avslutade. Kontrollera övriga uppgifter inför dagsavslutet.'}</p></div>
      <div className="open-tabs-total"><span>Kvar att betala</span><strong>{money(rows.reduce((sum, row) => sum + row.remaining, 0))}</strong></div>
    </header>
    {rows.length > 0 ? <>
      <div className="open-tabs-tools"><label className="open-tabs-search"><Search size={17} aria-hidden="true" /><input aria-label="Sök oavslutade notor" placeholder="Sök bord, disk eller notanummer" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <select aria-label="Filtrera oavslutade notor" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Alla ({rows.length})</option><option value="payable">Kan betalas ({rows.filter(row => row.payable).length})</option><option value="empty">Tomma ({emptyTabs.length})</option><option value="attention">Behöver hanteras ({rows.filter(row => row.attention).length})</option></select>
        {emptyTabs.length > 1 && <Action secondary disabled={busy} onClick={() => { setResult(null); setClosing(emptyTabs); }}>Avsluta alla tomma ({emptyTabs.length})</Action>}
      </div>
      <div className="open-tabs-list">{visible.map(({ tab, remaining, paid, empty, payable, status, uncertain, fiscalUncertain, attention }) => <article className="open-tab-row" key={tab.id} aria-label={`${tab.label} · nota ${tab.number}`}>
        <div className="open-tab-info"><strong>{tab.label}<small>Nota #{tab.number}</small></strong><span>{tab.guestCount} {tab.guestCount === 1 ? 'gäst' : 'gäster'} · Öppnad {new Date(tab.openedAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}</span><span className={`open-tab-status ${attention ? 'needs-attention' : ''}`}>{status}</span></div>
        <div className="open-tab-amount"><strong>{money(remaining)}</strong><span>{paid > 0 ? `${money(paid)} redan betalt` : 'Kvar att betala'}</span></div>
        <div className="open-tab-actions"><Action secondary disabled={busy} onClick={() => onOpen(tab)}><ReceiptText size={16} />Öppna nota</Action>
          {empty ? <Action secondary disabled={busy} onClick={() => { setResult(null); setClosing([tab]); }}><Check size={16} />Avsluta tom nota</Action> : payable ? <Action disabled={busy} onClick={() => onPay(tab)}><CreditCard size={16} />Ta betalt</Action> :
            uncertain ? <Action secondary disabled={busy} onClick={() => void run(() => api(`/payments/${uncertain.id}/check`, {}))}>Kontrollera status</Action> :
            fiscalUncertain ? <Action secondary disabled={busy} onClick={() => void run(() => api(`/receipts/${fiscalUncertain.id}/verify`, {}))}>Kontrollera registrering</Action> : <span>Öppna notan för att hantera den.</span>}
        </div>
      </article>)}</div>
      {visible.length === 0 && <p className="open-tabs-no-match">Inga notor matchar sökningen eller filtret. <button className="text-button" onClick={() => { setQuery(''); setFilter('all'); }}>Visa alla</button></p>}
    </> : <p className="open-tabs-complete"><Check size={18} />Inga öppna notor kvar</p>}
    {closing && <Modal title={closing.length === 1 ? 'Avsluta tom nota' : 'Avsluta tomma notor'} subtitle="Notorna avslutas och händelsen sparas i journalen." onClose={() => { if (!busy) setClosing(null); }}>
      {!result ? <><p>{closing.length} {closing.length === 1 ? 'nota utan aktiva orderrader' : 'notor utan aktiva orderrader'}. Ingen betalning registreras.</p><ul className="empty-tabs-confirm">{closing.map(tab => <li key={tab.id}>{tab.label} · nota #{tab.number}</li>)}</ul><Action disabled={busy} onClick={() => void closeEmpty(closing)}>{busy ? 'Avslutar…' : `Avsluta ${closing.length === 1 ? 'notan' : `${closing.length} tomma notor`}`}<ArrowRight size={17} /></Action></> : <><p role="status">{result.closed} {result.closed === 1 ? 'nota avslutad' : 'notor avslutade'}.</p>{result.issues.length > 0 && <div role="alert"><p>Kontrollera dessa notor i den uppdaterade listan:</p><ul>{result.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}<Action onClick={() => setClosing(null)}>Klart<Check size={17} /></Action></>}
    </Modal>}
  </section>;
}
