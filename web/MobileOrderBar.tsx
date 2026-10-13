import { useId } from 'react';
import { ArrowUpLeft, ChevronUp, CreditCard, LoaderCircle, Send } from 'lucide-react';
import { money } from '../shared/money';

export interface MobileOrderBarProps {
  label: string;
  remainingOre: number;
  lineCount: number;
  pendingCount: number;
  heldCount: number;
  busy: boolean;
  onReview: () => void;
  onSend?: () => void;
  onPay?: () => void;
  reviewTargetId?: string;
}

/** The caller supplies the active tab and any permitted business action. */
export function MobileOrderBar({ label, remainingOre, lineCount, pendingCount, heldCount, busy, onReview, onSend, onPay, reviewTargetId }: MobileOrderBarProps) {
  const summaryId = useId();
  const details = [
    `${lineCount} ${lineCount === 1 ? 'rad' : 'rader'}`,
    ...(pendingCount > 0 ? [`${pendingCount} att skicka`] : []),
    ...(heldCount > 0 ? [`${heldCount} väntar`] : []),
  ].join(' · ');
  const action = onSend ? 'send' : onPay ? 'pay' : null;

  return <section className="mobile-order-bar" aria-label="Aktuell nota" aria-busy={busy}>
    <button type="button" className="mobile-order-review" onClick={onReview} aria-label="Visa nota" aria-describedby={summaryId} aria-controls={reviewTargetId}>
      <span className="mobile-order-summary" id={summaryId}>
        <strong className="mobile-order-label" title={label}>{label}</strong>
        <span className="mobile-order-amount"><span className="sr-only">Kvar att betala: </span>{money(remainingOre)}</span>
        <small className="mobile-order-details" title={details}>{details}</small>
      </span>
      <span className="mobile-order-review-label">Visa nota<ChevronUp size={16} aria-hidden="true" /></span>
    </button>
    {action && <button type="button" className="mobile-order-action" disabled={busy} onClick={action === 'send' ? onSend : onPay} aria-label={action === 'send' ? 'Skicka beställning' : 'Betala aktuell nota'}>
      {busy ? <LoaderCircle size={18} className="spin" aria-hidden="true" /> : action === 'send' ? <Send size={18} aria-hidden="true" /> : <CreditCard size={18} aria-hidden="true" />}
      <span>{action === 'send' ? 'Skicka' : 'Betala'}</span>
    </button>}
  </section>;
}

export function MobileMenuReturn({ onReturn }: { onReturn: () => void }) {
  return <button type="button" className="mobile-menu-return" onClick={onReturn}><ArrowUpLeft size={17} aria-hidden="true" />Till menyn</button>;
}
