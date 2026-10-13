import type { MenuItem } from '../shared/types';
import { Store } from './db';
import { restaurantMenu, restaurantMenuSource } from './restaurant-menu';
import { menuSchema } from './validation';

export function seedRestaurantMenu(store: Store, at: string): boolean {
  const migrationId = 'menu-catalog-' + restaurantMenuSource.sha256;
  if (store.get('meta', migrationId)) return false;
  const items = restaurantMenu.map(item => menuSchema.parse(item));
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Restaurangmenyn har dubbla artikelidentifierare.');
  for (const item of items) {
    const options = item.modifiers.flatMap(group => group.options);
    if (new Set(item.modifiers.map(group => group.id)).size !== item.modifiers.length || new Set(options.map(option => option.id)).size !== options.length || item.modifiers.some(group => group.min > group.max || group.max > group.options.length)) throw new Error('Restaurangmenyn har ogiltiga tillval.');
  }
  return store.atomic(() => {
    // Recheck inside the transaction; an existing installation is upgraded once.
    if (store.get('meta', migrationId)) return false;
    const previous = store.all<MenuItem>('menu');
    if (!store.get('menu-archive', migrationId)) store.put('menu-archive', { id: migrationId, at, previous });
    for (const item of items) store.put('menu', item);
    store.put('meta', { id: migrationId, at, source: restaurantMenuSource, itemCount: items.length });
    store.audit('system', 'menu.catalog_imported', restaurantMenuSource.id, { source: restaurantMenuSource, itemCount: items.length, previousCount: previous.length, archiveId: migrationId }, at);
    return true;
  });
}

export function orderedMenu(store: Store): MenuItem[] {
  return store.all<MenuItem>('menu').sort((left, right) => (left.position ?? 100001) - (right.position ?? 100001));
}
