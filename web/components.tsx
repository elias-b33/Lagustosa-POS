import { Children, cloneElement, isValidElement, useEffect, useId, useRef, type ReactNode } from 'react';
import { X, LoaderCircle, ArrowRight, Coffee } from 'lucide-react';
import type { Bootstrap } from '../shared/types';

export interface WorkspaceProps {
  data: Bootstrap; busy: boolean;
  run: <T>(operation: () => Promise<T>, success?: string) => Promise<T | undefined>;
  refresh: () => Promise<void>;
}
let openDialogs = 0;
let originalBodyOverflow = '';
export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (openDialogs++ === 0) { originalBodyOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    const previous = document.activeElement as HTMLElement | null;
    const first = dialog.current?.querySelector<HTMLElement>('input:enabled, select:enabled, textarea:enabled, button:enabled');
    first?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key === 'Tab') {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:enabled, input:enabled, select:enabled, textarea:enabled, a[href]') ?? []);
        const firstControl = controls[0];
        const lastControl = controls.at(-1);
        if (event.shiftKey && document.activeElement === firstControl) { event.preventDefault(); lastControl?.focus(); }
        else if (!event.shiftKey && document.activeElement === lastControl) { event.preventDefault(); firstControl?.focus(); }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); if (--openDialogs === 0) document.body.style.overflow = originalBodyOverflow; previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={dialog}><div className="modal-head"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Stäng"><X size={21} /></button></div>{children}</div></div>;
}
export function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Coffee size={30} strokeWidth={1.3} /></span><h3>{title}</h3><p>{text}</p>{children}</div>;
}
export function Action({ children, onClick, disabled, secondary = false, danger = false, type = 'button' }: { children: ReactNode; onClick?: () => void; disabled?: boolean; secondary?: boolean; danger?: boolean; type?: 'button' | 'submit' }) {
  return <button type={type} onClick={onClick} disabled={disabled} className={`button ${secondary ? 'secondary' : ''} ${danger ? 'danger' : ''}`}>{children}</button>;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  const generatedId = useId();
  let controlId: string | undefined;
  const controls = Children.map(children, child => {
    if (!controlId && isValidElement<{ id?: string }>(child) && (typeof child.type === 'function' || ['input', 'select', 'textarea'].includes(String(child.type)))) {
      controlId = child.props.id ?? generatedId;
      return cloneElement(child, { id: controlId });
    }
    return child;
  });
  return <div className="field"><label htmlFor={controlId}>{label}</label>{controls}</div>;
}
export function Spinner() { return <LoaderCircle className="spin" size={18} />; }
export function LinkArrow() { return <ArrowRight size={18} />; }
export const courseNames = { starter: 'Förrätt', main: 'Huvudrätt', dessert: 'Dessert', drink: 'Dryck' };
export const statusNames = { draft: 'Ny', held: 'Väntar', sent: 'Skickad', started: 'Påbörjad', ready: 'Klar', served: 'Serverad', void: 'Makulerad' };
export const roleNames = { admin: 'Administratör', cashier: 'Kassör', waiter: 'Servitör', kitchen: 'Kök', bar: 'Bar' };
export const printStatusNames = { queued: 'I kö', printing: 'Skriver ut', printed: 'Utskriven', failed: 'Misslyckad', uncertain: 'Osäker' };
