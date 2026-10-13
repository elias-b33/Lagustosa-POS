import { useMemo } from 'react';
import { ArrowUpRight, Plus, Search, Utensils, Wine, Pizza, X } from 'lucide-react';
import type { MenuItem, Tab } from '../shared/types';
import { money } from '../shared/money';
import { Action, Empty } from './components';
import { useDesign } from './DesignSwitcher';

interface CatalogProps {
  menu: MenuItem[];
  selected: Tab | null;
  busy: boolean;
  locked: boolean;
  dayOpen: boolean;
  category: string;
  setCategory: (category: string) => void;
  query: string;
  setQuery: (query: string) => void;
  onAdd: (item: MenuItem) => void;
  onNew: () => void;
}

export function MenuCatalog({ menu, selected, busy, locked, dayOpen, category, setCategory, query, setQuery, onAdd, onNew }: CatalogProps) {
  const cotto = useDesign() === 'cotto';
  const categories = ['Alla', ...new Set(menu.map(item => item.category))];
  const activeCategory = categories.includes(category) ? category : 'Alla';
  const products = useMemo(() => menu.filter(item => (activeCategory === 'Alla' || item.category === activeCategory) && `${item.name} ${item.description}`.toLocaleLowerCase('sv').includes(query.toLocaleLowerCase('sv'))), [menu, activeCategory, query]);
  const testPrices = products.filter(item => item.example).length;
  const groups = cotto && activeCategory === 'Alla'
    ? categories.slice(1).map(name => ({ name, items: products.filter(item => item.category === name) })).filter(group => group.items.length)
    : [{ name: activeCategory === 'Alla' ? 'Restaurangens meny' : activeCategory, items: products }];
  const productButton = (product: MenuItem) => <button
    className={`product-card ${!product.available ? 'unavailable' : ''}`}
    key={product.id}
    onClick={() => onAdd(product)}
    disabled={!product.available || busy || locked || !dayOpen}
    data-course={product.course}
  >
    <span className={`product-icon ${product.station === 'bar' ? 'bar-icon' : ''}`}>{product.station === 'bar' ? <Wine size={24} strokeWidth={1.25} /> : product.category === 'Pizza' ? <Pizza size={24} strokeWidth={1.25} /> : <Utensils size={24} strokeWidth={1.25} />}</span>
    <span className="product-name">{product.name}</span>
    <span className="product-description">{product.description}</span>
    <span className="product-foot"><strong>{product.modifiers.some(group => group.options.some(option => option.priceOre > 0)) && <small>Från </small>}{money(selected?.serviceMode === 'takeaway' ? product.takeawayPriceOre ?? product.priceOre : product.priceOre)}{product.example && <small className="product-test-price">Testpris</small>}</strong><span>{product.available ? <Plus size={18} /> : 'Slut'}</span></span>
  </button>;
  return <div className={cotto ? 'cotto-catalog' : 'catalog'}>
    {cotto && <div className="cotto-menu-heading"><div><span className="eyebrow">LA GUSTOSA / MENY</span><h1>Mat & dryck<span>.</span></h1></div><span className="cotto-menu-count">{menu.length} artiklar<br /><span>À la carte</span></span></div>}
    <div className="pos-tools"><div className="search"><Search size={18} /><input aria-label="Sök i menyn" placeholder="Sök i menyn…" value={query} onChange={event => setQuery(event.target.value)} />{query ? <button className="icon-button" aria-label="Rensa sökning" onClick={() => setQuery('')}><X size={17} /></button> : <kbd>SÖK</kbd>}</div><Action onClick={onNew} disabled={busy || !dayOpen}><Plus size={18} />Ny disknota</Action></div>
    <div className="catalog-body">
      <div className="category-row menu-categories" aria-label="Menykategorier">{cotto && <span className="category-rail-label">KATEGORIER</span>}{categories.map((name, index) => <button key={name} className={activeCategory === name ? 'active' : ''} aria-pressed={activeCategory === name} aria-label={name} onClick={() => setCategory(name)}>{cotto && <span className="category-number" aria-hidden="true">{String(index).padStart(2, '0')}</span>}<span>{name}</span>{cotto && <small aria-hidden="true">{name === 'Alla' ? menu.length : menu.filter(item => item.category === name).length}</small>}</button>)}{cotto && <div className="category-rail-note">Tillagat med omsorg.<br />Serverat med känsla.</div>}</div>
      <div className="catalog-results">
        <div className="catalog-head"><span>{query ? `Sökresultat för ”${query}”` : activeCategory === 'Alla' ? 'Restaurangens meny' : activeCategory}</span><span>{products.length} artiklar{testPrices ? ` · ${testPrices} med testpriser` : ''}</span></div>
        {groups.map(group => <section className="menu-group" key={group.name}>{cotto && activeCategory === 'Alla' && <div className="menu-group-heading"><h2>{group.name}</h2><span>{group.items.length.toString().padStart(2, '0')}</span></div>}<div className="product-grid">{group.items.map(productButton)}</div></section>)}
        {!products.length && <Empty title="Inga träffar" text="Prova ett annat namn eller välj en annan kategori."><button className="text-button" onClick={() => { setQuery(''); setCategory('Alla'); }}>Visa hela menyn <ArrowUpRight size={16} /></button></Empty>}
      </div>
    </div>
  </div>;
}
