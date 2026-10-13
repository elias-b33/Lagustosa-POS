import { describe, expect, it } from 'vitest';
import { Store } from '../server/db';
import { KassaService } from '../server/service';
import { seed } from '../server/seed';
import { seedRestaurantMenu } from '../server/menu-catalog';
import { restaurantMenuSource } from '../server/restaurant-menu';
import type { MenuItem, Receipt, Ticket } from '../shared/types';
import { fixture } from './helpers';

describe('Restaurangens PDF-meny', () => {
  it('har alla 47 rätter i dokumentets ordning och skiljer dem från dryckernas testpriser', () => {
    const f = fixture(); const menu = f.service.menu();
    const food = menu.filter(item => !item.example);
    expect(food).toHaveLength(47); expect(menu.filter(item => item.example)).toHaveLength(4);
    expect(new Set(menu.map(item => item.id)).size).toBe(menu.length);
    expect([...new Set(food.map(item => item.category))]).toEqual(['Antipasti', 'Insalate', 'Pasta', 'Ugnsbakat', 'Risotto', 'Pizza', 'Carne / pesce', 'Bambini', 'Dolce']);
    expect(food.every(item => item.station === 'kitchen' && item.taxClass === 'food')).toBe(true);
    expect(food[0]).toMatchObject({ name: 'Vitlöksbröd', priceOre: 7900 });
    expect(food.at(-1)).toMatchObject({ name: 'Äppelpaj', priceOre: 6500 });
    expect(menu.find(item => item.id === 'pollo-pizza')).toMatchObject({ name: 'Pollo', priceOre: 18900, category: 'Pizza' });
    expect(menu.find(item => item.id === 'pollo')).toMatchObject({ name: 'Pollo alla griglia', priceOre: 22900, category: 'Carne / pesce' });
  });

  it('kräver storlek och räknar Antipasto till 139, 255 och 399 kronor', () => {
    const f = fixture(); f.open(); const tab = f.tab(null);
    expect(() => f.command(tab.id, { action: 'add', itemId: 'antipasto' })).toThrow('Välj');
    for (const [size, price] of [['piccolo', 13900], ['medio', 25500], ['grande', 39900]] as const) {
      f.command(tab.id, { action: 'add', itemId: 'antipasto', modifiers: [size] });
      expect(f.service.tab(tab.id).lines.at(-1)?.unitPriceOre).toBe(price);
    }
    f.command(tab.id, { action: 'send' });
    const ticket = f.store.all<Ticket>('ticket')[0];
    expect(ticket.items.map(item => item.modifiers[0].name)).toEqual(['Piccolo', 'Medio', 'Grande']);
  });

  it('kräver tillbehör, sås och stekning för oxfilén och behåller det inkluderade priset', () => {
    const f = fixture(); f.open(); const tab = f.tab();
    expect(() => f.command(tab.id, { action: 'add', itemId: 'filetto', modifiers: ['fried-potatoes', 'pepper'] })).toThrow('Välj');
    f.command(tab.id, { action: 'add', itemId: 'filetto', modifiers: ['fried-potatoes', 'mushroom', 'medium'], hold: false });
    f.command(tab.id, { action: 'send' });
    const line = f.store.all<Ticket>('ticket')[0].items[0];
    expect(line.unitPriceOre).toBe(35500);
    expect(line.modifiers.map(option => option.name)).toEqual(['Stekt potatis', 'Champinjonsås', 'Medium']);
  });

  it('uppgraderar en befintlig exempelmeny en gång, arkiverar den och bevarar egna artiklar', () => {
    const store = new Store(':memory:');
    try {
      seed(store);
      const bread = store.get<MenuItem>('menu', 'bread')!;
      const wine = { ...store.get<MenuItem>('menu', 'redwine')!, priceOre: 14500, example: false };
      const own = { ...bread, id: 'own-food', name: 'Egen rätt', priceOre: 12300, example: false };
      store.put('menu', wine); store.put('menu', own);
      const service = new KassaService(store);
      expect(store.get<MenuItem>('menu', 'bread')).toMatchObject({ priceOre: 7900, example: false });
      expect(store.get('menu', 'redwine')).toEqual(wine); expect(store.get('menu', 'own-food')).toEqual(own);
      const id = 'menu-catalog-' + restaurantMenuSource.sha256;
      expect(store.get<{ previous: MenuItem[] }>('menu-archive', id)?.previous).toContainEqual(bread);
      const actor = service.login('admin', '1234', 'LAGUSTOSA-TEST', 'local').actor;
      service.saveMenu(actor, { ...store.get<MenuItem>('menu', 'bread')!, priceOre: 8800, available: false });
      new KassaService(store);
      expect(store.get<MenuItem>('menu', 'bread')).toMatchObject({ priceOre: 8800, available: false });
      expect(store.journal().filter(entry => entry.action === 'menu.catalog_imported')).toHaveLength(1);
      expect(store.verifyJournal()).toBe(true);
    } finally { store.close(); }
  });

  it('bevarar gamla orderrader, bongar och kvitton när nya beställningar får den uppdaterade menyn', async () => {
    const f = fixture(); f.open();
    f.service.saveMenu(f.admin, { ...f.store.get<MenuItem>('menu', 'bread')!, priceOre: 6900, example: true });
    const open = f.tab(null); const paid = f.tab(null);
    for (const tab of [open, paid]) { f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' }); }
    await f.pay(paid.id);
    const before = { open: f.service.tab(open.id), paid: f.service.tab(paid.id), receipts: f.store.all<Receipt>('receipt'), tickets: f.store.all<Ticket>('ticket'), payments: f.store.all('payment'), jobs: f.store.all('print') };
    f.store.db.prepare("DELETE FROM entities WHERE kind='meta' AND id=?").run('menu-catalog-' + restaurantMenuSource.sha256);
    expect(seedRestaurantMenu(f.store, f.service.timestamp())).toBe(true);
    expect({ open: f.service.tab(open.id), paid: f.service.tab(paid.id), receipts: f.store.all('receipt'), tickets: f.store.all('ticket'), payments: f.store.all('payment'), jobs: f.store.all('print') }).toEqual(before);
    f.command(open.id, { action: 'add', itemId: 'bread' });
    expect(f.service.tab(open.id).lines.map(line => line.unitPriceOre)).toEqual([6900, 7900]);
    expect(seedRestaurantMenu(f.store, f.service.timestamp())).toBe(false);
    expect(f.store.verifyJournal()).toBe(true);
  });
});
