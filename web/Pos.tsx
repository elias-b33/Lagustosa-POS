import { useState, useRef, useEffect } from 'react';
import { ChefHat, Wine, Pizza, Utensils, Search, Plus, Minus, Users, Send, ArrowUpRight, Trash2, Clock3, CreditCard, MoveRight, Percent, CircleCheck, ShoppingBag, SlidersHorizontal, Pencil } from 'lucide-react';
import type { DiningTable, MenuItem, Tab, Course, OrderLine } from '../shared/types';
import { calculateTab, money, paidOre, parseMoney } from '../shared/money';
import { api, ApiError, newKey } from './api';
import { Action, Empty, Field, Modal, courseNames, statusNames, type WorkspaceProps } from './components';
import { MobileMenuReturn, MobileOrderBar } from './MobileOrderBar';
import { MenuCatalog } from './MenuCatalog';
import { useDesign } from './DesignSwitcher';

interface PosProps extends WorkspaceProps { tabId: string | null; setTabId: (id: string | null) => void; pay: (tab: Tab) => void; tablesView?: boolean; showPos: () => void }

export function Pos(props: PosProps) {
  const { data, run, busy, tabId, setTabId } = props;
  const [category, setCategory] = useState('Alla');
  const [query, setQuery] = useState('');
  const [guest, setGuest] = useState(1);
  const [item, setItem] = useState<MenuItem | null>(null);
  const currentItem = item ? data.menu.find(candidate => candidate.id === item.id) ?? null : null;
  const pendingItemId = useRef<string | null>(null);
  const latestMenu = useRef(data.menu);
  latestMenu.current = data.menu;
  const [newTable, setNewTable] = useState<DiningTable | 'counter' | null>(null);
  const [edit, setEdit] = useState<'move' | 'discount' | 'guests' | null>(null);
  const [lineEdit, setLineEdit] = useState<OrderLine | null>(null);
  const [map, setMap] = useState(false);
  const [area, setArea] = useState('Alla');
  const orderPanel = useRef<HTMLElement>(null);
  const menuPanel = useRef<HTMLElement>(null);
  const menuPosition = useRef(0);
  const openTabs = data.tabs.filter(tab => tab.status === 'open');
  const selected = data.tabs.find(tab => tab.id === tabId) ?? null;
  const canManage = ['admin', 'cashier'].includes(data.actor.staff.role);

  const command = async (tab: Tab, body: Record<string, unknown>) => {
    const key = newKey();
    return run(async () => {
      try { return await api<Tab>(`/tabs/${tab.id}/commands`, { ...body, key, version: tab.version }); }
      catch (issue) {
        if (!(issue instanceof ApiError) || issue.code !== 'VERSION_CONFLICT') throw issue;
        const latest = await api<Tab>(`/tabs/${tab.id}`);
        return api<Tab>(`/tabs/${tab.id}/commands`, { ...body, key, version: latest.version });
      }
    });
  };
  const openNewTab = (table: DiningTable | 'counter', productId: string | null = null) => {
    pendingItemId.current = productId;
    setNewTable(table);
  };
  const closeNewTab = () => { pendingItemId.current = null; setNewTable(null); };
  const openTable = (table: DiningTable) => {
    const tab = openTabs.find(tab => tab.tableId === table.id);
    if (tab) { setTabId(tab.id); props.showPos(); }
    else openNewTab(table);
  };
  const addItem = (product: MenuItem) => {
    if (!selected || selected.status !== 'open') { openNewTab('counter', product.id); return; }
    setItem(product);
  };
  const totals = selected ? calculateTab(selected) : null;
  const paid = selected ? paidOre(data.payments, selected.id) : 0;
  const pending = selected?.lines.filter(line => line.status === 'draft').length ?? 0;
  const held = selected?.lines.filter(line => line.status === 'held').length ?? 0;
  const reviewOrder = () => {
    menuPosition.current = window.scrollY;
    orderPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    orderPanel.current?.focus({ preventScroll: true });
  };
  const returnToMenu = () => {
    window.scrollTo({ top: menuPosition.current, behavior: 'smooth' });
    menuPanel.current?.focus({ preventScroll: true });
  };
  const activeGuest = selected && guest <= selected.guestCount ? guest : 1;
  const locked = selected ? data.payments.some(payment => payment.tabId === selected.id && payment.kind === 'sale' && ['pending', 'unknown', 'approved'].includes(payment.status)) : false;

  return <div className={`service-layout ${props.tablesView ? 'table-mode' : ''}`}><section className="service-main" ref={menuPanel} tabIndex={-1}>
    {props.tablesView ? <><div className="section-heading"><div><span className="eyebrow">EN PLATS FÖR VARJE GÄST</span><h2>Restaurangen</h2></div><div className="segmented"><button className={!map ? 'active' : ''} onClick={() => setMap(false)}>Översikt</button><button className={map ? 'active' : ''} onClick={() => setMap(true)}>Bordskarta</button></div></div><div className="service-stats"><div><span>Öppna bord</span><strong>{openTabs.filter(tab => tab.tableId).length}<small> / {data.tables.filter(table => table.active).length}</small></strong></div><div><span>Gäster just nu</span><strong>{openTabs.filter(tab => tab.tableId).reduce((sum, tab) => sum + tab.guestCount, 0)}</strong></div><div><span>Öppna notor</span><strong>{money(openTabs.reduce((sum, tab) => sum + calculateTab(tab).grossOre - paidOre(data.payments, tab.id), 0))}</strong></div></div><div className="category-row">{['Alla', ...new Set(data.tables.filter(table => table.active).map(table => table.area))].map(name => <button key={name} className={area === name ? 'active' : ''} onClick={() => setArea(name)}>{name}</button>)}<span className="legend"><i /> Ledigt <i className="occupied" /> Upptaget</span></div><div className={map ? 'floor-plan' : 'table-grid'}>{map && <><span className="floor-label">LA GUSTOSA · EXEMPELKARTA</span><div className="floor-divider" /><span className="floor-entrance">ENTRÉ</span></>}{data.tables.filter(table => table.active && (area === 'Alla' || table.area === area)).map(table => {
      const tab = openTabs.find(tab => tab.tableId === table.id);
      const ready = tab?.lines.some(line => line.status === 'ready');
      return <button key={table.id} className={`table-card ${tab ? 'occupied' : ''} ${ready ? 'table-ready' : ''}`} style={map ? { left: `${table.x}%`, top: `${table.y}%` } : undefined} onClick={() => openTable(table)} disabled={busy || !data.currentDay}><div className="table-top"><span>{table.name}</span>{ready ? <CircleCheck size={16} /> : <ArrowUpRight size={16} />}</div><span className="table-number">{table.name.replace('Bord ', '')}</span><div className="table-bottom"><span><Users size={13} /> {tab?.guestCount ?? table.seats}</span><strong>{tab ? money(calculateTab(tab).grossOre - paidOre(data.payments, tab.id)) : 'Ledigt'}</strong></div>{!map && <span className="table-area">{table.area}{ready ? ' · Rätt klar' : ''}</span>}</button>;
    })}</div>{openTabs.some(tab => !tab.tableId) && <div className="counter-tabs"><h3>Disk & avhämtning</h3>{openTabs.filter(tab => !tab.tableId).map(tab => <button className="counter-tab" key={tab.id} onClick={() => { setTabId(tab.id); props.showPos(); }}><ShoppingBag size={17} />{tab.label}<strong>{money(calculateTab(tab).grossOre)}</strong><ArrowUpRight size={15} /></button>)}</div>}</> : <MenuCatalog menu={data.menu} selected={selected} busy={busy} locked={locked} dayOpen={Boolean(data.currentDay)} category={category} setCategory={setCategory} query={query} setQuery={setQuery} onAdd={addItem} onNew={() => openNewTab('counter')} />}
  </section><aside className="order-panel" id="current-order-panel" ref={orderPanel} tabIndex={-1} aria-label="Aktuell nota"><div className="order-heading">{!props.tablesView && <MobileMenuReturn onReturn={returnToMenu} />}<span className="eyebrow">DIN AKTUELLA NOTA</span><div className="order-title-row"><h2>{selected?.label ?? 'Välj en nota'}</h2><span className="order-mark"><Utensils size={19} /></span></div><select aria-label="Öppna notor" value={selected?.id ?? ''} onChange={event => setTabId(event.target.value || null)}><option value="">Välj bland öppna notor</option>{openTabs.map(tab => <option key={tab.id} value={tab.id}>{tab.label} · {money(calculateTab(tab).grossOre)}</option>)}{selected && selected.status !== 'open' && <option value={selected.id}>{selected.label} · Betald</option>}</select></div>
    {selected ? <><div className="order-meta"><span><Users size={15} /> {selected.guestCount} gäster</span><span>{selected.serviceMode === 'takeaway' ? 'Avhämtning' : 'På plats'}</span><button className="icon-button" onClick={() => setEdit('guests')} disabled={busy || locked || selected.status !== 'open'} aria-label="Ändra antal gäster"><Pencil size={15} /></button></div><div className="guest-pills"><button className={activeGuest === 0 ? 'active' : ''} onClick={() => setGuest(0)}>Gemensamt</button>{Array.from({ length: selected.guestCount }, (_, index) => <button className={activeGuest === index + 1 ? 'active' : ''} key={index} onClick={() => setGuest(index + 1)}>Gäst {index + 1}</button>)}</div><div className="order-lines">{selected.lines.filter(line => line.status !== 'void').map(line => <div key={line.id} className={`order-line ${line.status === 'held' ? 'line-held' : ''}`}><div className="line-count">{line.quantity}</div><div className="line-copy"><strong>{line.name}</strong><span>{line.guest ? `Gäst ${line.guest}` : 'Gemensamt'} · {courseNames[line.course]}</span>{line.modifiers.length > 0 && <small>{line.modifiers.map(modifier => modifier.name).join(', ')}</small>}{line.notes && <small className="line-note">{line.notes}</small>}<span className={`line-state ${line.status}`}><i />{statusNames[line.status]}</span></div><div className="line-value"><strong>{money(line.quantity * line.unitPriceOre)}</strong>{selected.status === 'open' && !locked && <div className="line-actions">{canManage && <button className="icon-button" onClick={() => setLineEdit(line)} aria-label={`Ändra pris ${line.name}`}><SlidersHorizontal size={14} /></button>}<button className="icon-button" disabled={busy || !canManage && !['draft', 'held'].includes(line.status)} onClick={() => {
        if (['draft', 'held'].includes(line.status)) void command(selected, { action: 'remove', lineId: line.id });
        else setLineEdit(line);
      }} aria-label={`Ta bort ${line.name}`}><Trash2 size={14} /></button></div>}</div></div>)}{!selected.lines.some(line => line.status !== 'void') && <Empty title="Redo att beställa" text="Välj gäst och lägg till något från menyn." />}</div><div className="order-footer">{selected.status === 'open' && <><div className="order-minor-actions"><button onClick={() => setEdit('move')} disabled={busy || locked}><MoveRight size={14} /> Flytta</button>{canManage && <button onClick={() => setEdit('discount')} disabled={busy || locked}><Percent size={14} /> Rabatt</button>}{!selected.lines.some(line => line.status !== 'void') && <button onClick={() => void command(selected, { action: 'void' })} disabled={busy}>Avsluta tom nota</button>}</div>{pending > 0 && <Action secondary onClick={() => void command(selected, { action: 'send' })} disabled={busy}><Send size={16} /> Skicka till kök & bar <span className="count-chip">{pending}</span></Action>}{held > 0 && <div className="fire-buttons">{(['starter', 'main', 'dessert', 'drink'] as Course[]).filter(course => selected.lines.some(line => line.status === 'held' && line.course === course)).map(course => <Action key={course} secondary onClick={() => void command(selected, { action: 'fire', course })} disabled={busy}><ChefHat size={17} /> Fram {courseNames[course].toLowerCase()}</Action>)}</div>}</>}{totals && <div className="order-totals">{totals.discountOre > 0 && <div><span>Rabatt {selected.discountBps / 100} %</span><span>−{money(totals.discountOre)}</span></div>}<div><span>Varav moms</span><span>{money(totals.vatOre)}</span></div>{paid > 0 && <div><span>Redan betalt</span><span>{money(paid)}</span></div>}<div className="total-row"><span>{selected.status === 'paid' ? 'Betald nota' : 'Kvar att betala'}</span><strong>{money(selected.status === 'paid' ? totals.grossOre : totals.grossOre - paid)}</strong></div></div>}{selected.status === 'open' ? <Action disabled={busy || pending > 0 || held > 0 || !selected.lines.some(line => line.status !== 'void')} onClick={() => props.pay(selected)}><CreditCard size={18} />Ta betalt<ArrowUpRight size={18} /></Action> : <span className="paid-banner"><CircleCheck size={18} /> Notan är betald</span>}<span className="receipt-footnote">Alla belopp inkl. moms · Testförsäljning</span></div></> : <Empty title="Allt börjar med en nota" text="Välj ett bord eller öppna en disknota för att börja beställa."><Action secondary onClick={() => openNewTab('counter')} disabled={busy || !data.currentDay}><Plus size={17} /> Ny disknota</Action></Empty>}
  </aside>
  {!props.tablesView && selected?.status === 'open' && <MobileOrderBar label={selected.label} remainingOre={Math.max(0, (totals?.grossOre ?? 0) - paid)} lineCount={selected.lines.filter(line => line.status !== 'void').length} pendingCount={pending} heldCount={held} busy={busy} onReview={reviewOrder} reviewTargetId="current-order-panel" onSend={pending > 0 ? () => void command(selected, { action: 'send' }) : undefined} onPay={pending === 0 && held === 0 && selected.lines.some(line => line.status !== 'void') ? () => props.pay(selected) : undefined} />}
  {newTable && <NewTab table={newTable} busy={busy} onClose={closeNewTab} onCreate={async (guestCount, serviceMode) => {
    const result = await run(() => api<Tab>('/tabs', { key: newKey(), tableId: newTable === 'counter' ? null : newTable.id, guestCount, serviceMode }));
    if (result) {
      const requested = latestMenu.current.find(product => product.id === pendingItemId.current && product.available);
      setTabId(result.id); setGuest(1); closeNewTab(); props.showPos();
      if (requested) setItem(requested);
    }
  }} />}
  {currentItem && selected && <ItemModal item={currentItem} guest={activeGuest} tab={selected} busy={busy} onClose={() => setItem(null)} onAdd={async input => {
    const result = await command(selected, { action: 'add', itemId: currentItem.id, ...input });
    if (result) setItem(null);
  }} />}
  {edit && selected && <TabEdit tab={selected} kind={edit} tables={data.tables} busy={busy} onClose={() => setEdit(null)} onSave={async input => { if (await command(selected, input)) setEdit(null); }} />}
  {lineEdit && selected && <LineEdit line={lineEdit} busy={busy} onClose={() => setLineEdit(null)} onSave={async input => { if (await command(selected, { lineId: lineEdit.id, ...input })) setLineEdit(null); }} />}
  </div>;
}

function NewTab({ table, busy, onClose, onCreate }: { table: DiningTable | 'counter'; busy: boolean; onClose: () => void; onCreate: (guests: number, mode: 'dine_in' | 'takeaway') => Promise<void> }) {
  const [guests, setGuests] = useState(table === 'counter' ? 1 : table.seats);
  const [mode, setMode] = useState<'dine_in' | 'takeaway'>('dine_in');
  return <Modal title={table === 'counter' ? 'Ny disknota' : table.name} subtitle="Gör plats för en god kväll." onClose={onClose}><form onSubmit={event => { event.preventDefault(); void onCreate(guests, mode); }}><Field label="Antal gäster"><input type="number" min={1} max={100} value={guests} onChange={event => setGuests(Number(event.target.value))} /></Field>{table === 'counter' && <Field label="Försäljningssätt"><select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="dine_in">På plats</option><option value="takeaway">Avhämtning</option></select></Field>}<Action type="submit" disabled={busy || guests < 1}><Plus size={18} />Öppna nota</Action></form></Modal>;
}
function ItemModal({ item, guest, tab, busy, onClose, onAdd }: { item: MenuItem; guest: number; tab: Tab; busy: boolean; onClose: () => void; onAdd: (input: Record<string, unknown>) => Promise<void> }) {
  const cotto = useDesign() === 'cotto';
  const initialItem = useRef(JSON.stringify(item));
  const menuChanged = initialItem.current !== JSON.stringify(item);
  const [quantity, setQuantity] = useState(1);
  const [chosen, setChosen] = useState<string[]>([]);
  const availableOptions = item.modifiers.flatMap(group => group.options);
  const currentChosen = chosen.filter(id => availableOptions.some(option => option.id === id));
  useEffect(() => {
    const ids = new Set(item.modifiers.flatMap(group => group.options.map(option => option.id)));
    setChosen(current => current.every(id => ids.has(id)) ? current : current.filter(id => ids.has(id)));
  }, [item.modifiers]);
  const [notes, setNotes] = useState('');
  const [course, setCourse] = useState<Course>(item.course);
  const [hold, setHold] = useState(item.course === 'main');
  const price = (tab.serviceMode === 'takeaway' ? item.takeawayPriceOre ?? item.priceOre : item.priceOre) + item.modifiers.flatMap(group => group.options).filter(option => chosen.includes(option.id)).reduce((sum, option) => sum + option.priceOre, 0);
  const valid = item.modifiers.every(group => { const count = group.options.filter(option => chosen.includes(option.id)).length; return count >= group.min && count <= group.max; });
  return <Modal title={item.name} subtitle={`${tab.label} · ${guest ? `Gäst ${guest}` : 'Gemensamt'}`} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (valid && item.available && !busy) void onAdd({ quantity, guest, modifiers: currentChosen, notes, course, hold }); }}>{cotto && <p className="item-description">{item.description}</p>}{menuChanged && <p className="notice warning" role="status">Menyn har uppdaterats. Kontrollera aktuellt pris och tillval innan du lägger till rätten.</p>}<div className="quantity-control"><button type="button" className="icon-button" onClick={() => setQuantity(current => Math.max(1, current - 1))} aria-label="Minska antal"><Minus size={18} /></button><strong>{quantity}</strong><button type="button" className="icon-button" onClick={() => setQuantity(current => Math.min(100, current + 1))} aria-label="Öka antal"><Plus size={18} /></button><span>{money(price * quantity)}</span></div>{item.modifiers.map(group => <div className="modifier-group" key={group.id}><h3>{group.name}<small className={group.options.filter(option => chosen.includes(option.id)).length >= group.min && group.min > 0 ? 'modifier-complete' : ''}>{cotto ? group.min > 0 ? group.options.filter(option => chosen.includes(option.id)).length >= group.min ? 'Valt' : group.min === group.max ? `Välj ${group.min}` : `Välj ${group.min}–${group.max}` : `Valfritt · högst ${group.max}` : `${group.min > 0 ? 'Obligatoriskt' : 'Valfritt'} · högst ${group.max}`}</small></h3><div className="modifier-options">{group.options.map(option => <label key={option.id}><input type={group.max === 1 ? 'radio' : 'checkbox'} name={group.id} checked={chosen.includes(option.id)} onChange={event => setChosen(current => event.target.checked ? [...current.filter(id => group.max !== 1 || !group.options.some(candidate => candidate.id === id)), option.id] : current.filter(id => id !== option.id))} /><span>{option.name}</span>{option.priceOre > 0 && <small>+{money(option.priceOre)}</small>}</label>)}</div></div>)}<div className="field-grid"><Field label="Servering"><select value={course} onChange={event => { setCourse(event.target.value as Course); setHold(event.target.value === 'main'); }}>{Object.entries(courseNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></Field><Field label="Till kök / bar"><select value={hold ? 'hold' : 'now'} onChange={event => setHold(event.target.value === 'hold')}><option value="now">Med nästa beställning</option><option value="hold">Vänta på framkallning</option></select></Field></div><Field label="Anteckning till kök eller bar"><textarea maxLength={1000} placeholder="Till exempel: utan lök, välstekt…" value={notes} onChange={event => setNotes(event.target.value)} /></Field><Action type="submit" disabled={busy || !valid || !item.available}><Plus size={18} />Lägg till · {money(price * quantity)}</Action></form></Modal>;
}
function TabEdit({ tab, kind, tables, busy, onClose, onSave }: { tab: Tab; kind: 'move' | 'discount' | 'guests'; tables: DiningTable[]; busy: boolean; onClose: () => void; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const [value, setValue] = useState(kind === 'move' ? tab.tableId ?? '' : kind === 'guests' ? String(tab.guestCount) : String(tab.discountBps / 100));
  const [reason, setReason] = useState(tab.discountReason);
  return <Modal title={kind === 'move' ? 'Flytta nota' : kind === 'discount' ? 'Rabatt på notan' : 'Antal gäster'} subtitle={tab.label} onClose={onClose}><form onSubmit={event => { event.preventDefault(); void onSave(kind === 'move' ? { action: 'move', tableId: value || null } : kind === 'discount' ? { action: 'discount', discountBps: Math.round(Number(value.replace(',', '.')) * 100), reason } : { action: 'guests', guestCount: Number(value) }); }}><Field label={kind === 'move' ? 'Till bord' : kind === 'discount' ? 'Rabatt i procent' : 'Antal gäster'}>{kind === 'move' ? <select value={value} onChange={event => setValue(event.target.value)}><option value="">Disk</option>{tables.filter(table => table.active).map(table => <option key={table.id} value={table.id}>{table.name}</option>)}</select> : <input type="number" min={kind === 'discount' ? 0 : 1} max={100} step={kind === 'discount' ? '0.01' : '1'} value={value} onChange={event => setValue(event.target.value)} />}</Field>{kind === 'discount' && <Field label="Orsak"><input value={reason} onChange={event => setReason(event.target.value)} minLength={3} required /></Field>}<Action type="submit" disabled={busy}>Spara ändring</Action></form></Modal>;
}
function LineEdit({ line, busy, onClose, onSave }: { line: OrderLine; busy: boolean; onClose: () => void; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const [price, setPrice] = useState(String(line.unitPriceOre / 100));
  const [reason, setReason] = useState('');
  return <Modal title={line.name} subtitle="Prisändring och makulering journalförs." onClose={onClose}><Field label="Nytt styckpris i kronor"><input inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} /></Field><Field label="Orsak"><input value={reason} onChange={event => setReason(event.target.value)} minLength={3} /></Field><div className="action-row"><Action disabled={busy || parseMoney(price) === null || reason.length < 3} onClick={() => void onSave({ action: 'price', priceOre: parseMoney(price), reason })}>Ändra pris</Action><Action danger disabled={busy || reason.length < 3} onClick={() => void onSave({ action: 'remove', reason })}><Trash2 size={16} />Makulera rätt</Action></div></Modal>;
}
