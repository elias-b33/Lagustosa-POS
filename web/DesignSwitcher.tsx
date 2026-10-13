import { useId, useSyncExternalStore } from 'react';
import { Palette } from 'lucide-react';

export type Design = 'professional' | 'classic';
const preferenceKey = 'lagustosa-ui-design';
const changedEvent = 'lagustosa-design-change';

function savedDesign(): Design {
  try { return localStorage.getItem(preferenceKey) === 'classic' ? 'classic' : 'professional'; }
  catch { return 'professional'; }
}

let currentDesign: Design = typeof window === 'undefined' ? 'professional' : savedDesign();
if (typeof document !== 'undefined') document.documentElement.dataset.design = currentDesign;

export function setDesign(design: Design) {
  currentDesign = design;
  document.documentElement.dataset.design = design;
  try { localStorage.setItem(preferenceKey, design); }
  catch { /* The current browser session can still switch when storage is unavailable. */ }
  window.dispatchEvent(new Event(changedEvent));
}

function subscribe(onChange: () => void) {
  const syncStorage = (event: StorageEvent) => {
    if (event.key !== preferenceKey && event.key !== null) return;
    currentDesign = savedDesign();
    document.documentElement.dataset.design = currentDesign;
    onChange();
  };
  window.addEventListener(changedEvent, onChange);
  window.addEventListener('storage', syncStorage);
  return () => {
    window.removeEventListener(changedEvent, onChange);
    window.removeEventListener('storage', syncStorage);
  };
}

export function DesignSwitcher() {
  const id = useId();
  const design = useSyncExternalStore(subscribe, () => currentDesign, () => 'professional');
  return <label className="design-switcher" htmlFor={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flexShrink: 0, fontSize: 11 }}>
    <Palette size={15} aria-hidden="true" />
    <span>Utseende</span>
    <select id={id} aria-label="Utseende" value={design} onChange={event => setDesign(event.target.value as Design)} style={{ width: 'auto', minHeight: 36, maxWidth: 136, padding: '7px 10px' }}>
      <option value="professional">Professionell</option>
      <option value="classic">Klassisk</option>
    </select>
  </label>;
}
