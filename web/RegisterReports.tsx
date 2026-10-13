import { useState } from 'react';
import type { DayReport } from '../shared/types';
import { money } from '../shared/money';
import { quantityLabel } from '../shared/allocations';
import { reportCoverageExplanation } from '../shared/report-coverage';
import { Field } from './components';

export function RegisterReports({ report }: { report: DayReport }) {
  const [selected, setSelected] = useState('');
  const reports = report.registers ?? [];
  if (!reports.length) return null;
  const id = (index: number) => reports[index].registerId ?? `legacy:${reports[index].legacyRegisterId ?? index}`;
  const chosen = reports.find((_, index) => id(index) === selected) ?? reports[0];
  const totals = chosen.training;
  return <article className="card register-report"><h3>Rapport per kassa</h3>
    <Field label="Kassa för rapport"><select value={id(reports.indexOf(chosen))} onChange={event => setSelected(event.target.value)}>{reports.map((entry, index) => <option key={id(index)} value={id(index)}>{entry.registerId ?? `Äldre historik · ${entry.legacyRegisterId ?? 'utan kassa'}`}</option>)}</select></Field>
    <p className="muted">Övning · {chosen.kind}-rapport{chosen.sequence !== null ? ` #${chosen.sequence}` : ''} · {new Date(chosen.generatedAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}</p>
    <div className="report-grid"><div>
      {[['Försäljning', totals.salesOre], ['Returer', totals.refundsOre], ['Netto', totals.netOre], ['Dricks', totals.tipsOre], ['Rabatter', totals.discountsOre], ['Förväntad kontantkassa', totals.expectedCashOre]].map(([label, amount]) => <div className="report-line" key={label}><span>{label}</span><strong>{money(Number(amount))}</strong></div>)}
      <div className="report-line"><span>Kvitton / returkvitton</span><strong>{totals.receiptCounts.sales} / {totals.receiptCounts.refunds}</strong></div>
      <div className="report-line"><span>Artikelantal / returnerat</span><strong>{quantityLabel(totals.articleCounts.sold)} / {quantityLabel(totals.articleCounts.refunded)}</strong></div>
      <div className="report-line"><span>Ekonomiska artikelandelar</span><strong>{quantityLabel(totals.articleCounts.saleAmountShares)}</strong></div>
      <div className="report-line"><span>Kopior / lådöppningar</span><strong>{totals.receiptCopies} / {totals.drawerOpenings}</strong></div>
    </div><div>
      <h4>Betalsätt</h4>{totals.methods.map(method => <div className="report-line" key={method.method}><span>{method.method === 'card' ? 'Kort' : method.method === 'cash' ? 'Kontanter' : 'Swish'}</span><strong>{money(method.netOre)}</strong></div>)}
      <h4>Moms efter returer</h4>{totals.vat.map(vat => <div className="report-line" key={vat.vatBps}><span>{vat.vatBps / 100} %</span><strong>{money(vat.netVatOre)}</strong><small>Underlag inkl. moms {money(vat.netGrossOre)}</small></div>)}
      <h4>Ackumulerade övningsbelopp</h4><p>{money(chosen.cumulative.training.salesOre)} försäljning · {money(chosen.cumulative.training.refundsOre)} returer</p>
      {chosen.grandTotals && <><h4>Grand totals · övningskvitton</h4><div className="report-line"><span>Försäljning</span><strong>{money(chosen.grandTotals.training.salesOre)}</strong></div><div className="report-line"><span>Returer och efterhandsrättelser</span><strong>{money(chosen.grandTotals.training.returnsOre)}</strong></div><div className="report-line"><span>Netto</span><strong>{money(chosen.grandTotals.training.netOre)}</strong></div>{!chosen.grandTotals.coverage.complete && <ul className="muted">{chosen.grandTotals.coverage.issues.map(issue => <li key={issue}>{reportCoverageExplanation(issue)}</li>)}</ul>}</>}
    </div></div>
    {!chosen.coverage.complete && <details className="notice warning report-coverage"><summary>Rapportens begränsningar ({chosen.coverage.issues.length})</summary><ul>{chosen.coverage.issues.map(issue => <li key={issue}>{reportCoverageExplanation(issue)}</li>)}</ul></details>}
    <p className="muted">Parkerade notor hör till kassan där de öppnades. Betalningar och returer redovisas på kassan som startade dem. Alla belopp är övning.</p>
    <a className="button secondary" href={`/api/v1/business-days/${report.dayId}/register-reports.json${chosen.registerId ? `?registerId=${encodeURIComponent(chosen.registerId)}` : ''}`}>Hämta sparbart rapportunderlag</a>
  </article>;
}
