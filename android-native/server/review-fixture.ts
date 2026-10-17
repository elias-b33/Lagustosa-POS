// Explicitly launched, loopback-only, in-memory fixture. Never loaded by the demo server.
import { randomUUID } from 'node:crypto';
import { createNativeApp } from './app';
import type { MenuItem, Tab, Ticket } from '../../shared/types';

const { app, store, service } = await createNativeApp({ database: ':memory:', sessionCookieName: 'native_review_session' });
const { actor } = service.login('admin', '1234', 'LAGUSTOSA-TEST', 'review-fixture');
service.openDay(actor, { key: randomUUID(), floatOre: 0 });
const original = service.menu().find(item => item.available && item.modifiers.length === 0)!;
const food: MenuItem = { ...original, id: 'review-food', name: 'Granskningspasta', priceOre: 10001, course: 'starter', station: 'kitchen', modifiers: [{ id: 'review-modifier', name: 'Pasta', min: 0, max: 1, options: [{ id: 'review-gluten-free', name: 'Glutenfri pasta', priceOre: 0 }] }] };
store.put('menu', food);
let conflictId = '', armed = false, removalAttempts = 0;
app.addHook('preHandler', async request => {
  if (request.method !== 'POST' || request.url !== `/api/v1/tabs/${conflictId}/commands`) return;
  const input = request.body as { action?: string };
  if (input.action !== 'remove') return;
  removalAttempts++;
  if (armed) {
    armed = false;
    const current = service.tab(conflictId);
    // Another device changes the bill after the operator confirmed but before the write arrives.
    service.updateTab(actor, current.id, { key: randomUUID(), version: current.version, action: 'price', lineId: current.lines[0].id, priceOre: 10101, reason: 'Samtidig ändring i isolerat prov' });
  }
});
function create(label: string): Tab {
  const tab = service.createTab(actor, { key: randomUUID(), tableId: null, guestCount: 3, serviceMode: 'dine_in' });
  tab.label = label;
  store.put('tab', tab);
  return tab;
}
function add(tab: Tab, notes = ''): Tab {
  return service.updateTab(actor, tab.id, { key: randomUUID(), version: tab.version, action: 'add', itemId: food.id, quantity: 1, hold: false, modifiers: ['review-gluten-free'], notes });
}
function send(tab: Tab): Tab {
  return service.updateTab(actor, tab.id, { key: randomUUID(), version: tab.version, action: 'send' });
}
app.post('/api/v1/__native_review/prepare', async () => {
  const suffix = randomUUID().slice(0, 6);
  const conflict = add(create('Konflikt ' + suffix));
  conflictId = conflict.id;
  armed = false;
  removalAttempts = 0;
  let kitchen = add(add(create('Köksprov ' + suffix), 'Utan lök — TEST'), 'Ska makuleras');
  kitchen = send(kitchen);
  kitchen = service.updateTab(actor, kitchen.id, { key: randomUUID(), version: kitchen.version, action: 'remove', lineId: kitchen.lines[1].id, reason: 'Felregistrerad provrad' });
  let empty = send(add(create('Tom bong ' + suffix)));
  empty = service.updateTab(actor, empty.id, { key: randomUUID(), version: empty.version, action: 'remove', lineId: empty.lines[0].id, reason: 'Helt makulerad i prov' });
  const split = send(add(create('Delning ' + suffix)));
  const kitchenTicket = store.all<Ticket>('ticket').find(ticket => ticket.tabId === kitchen.id && ticket.kind === 'order')!;
  return { conflict, kitchen, kitchenTicket, empty, split };
});
app.post('/api/v1/__native_review/arm-conflict', async () => { armed = true; return { ok: true }; });
app.post('/api/v1/__native_review/expire-sessions', async () => {
  store.db.prepare('DELETE FROM sessions').run();
  const tab = service.tab(conflictId);
  service.updateTab(actor, tab.id, { key: randomUUID(), version: tab.version, action: 'guests', guestCount: tab.guestCount });
  return { ok: true };
});
app.get('/api/v1/__native_review/state', async () => ({ removalAttempts, tabs: store.all('tab'), tickets: store.all('ticket'), payments: store.all('payment') }));
await app.listen({ host: '127.0.0.1', port: 4202 });
console.log('Isolated in-memory native review fixture: http://127.0.0.1:4202');
process.on('SIGTERM', () => { void app.close(); });
process.on('SIGINT', () => { void app.close(); });
