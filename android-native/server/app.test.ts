import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNativeApp } from './app';
import type { MenuItem, Tab, Ticket, Payment, PrintJob } from '../../shared/types';

test('native quantity changes are atomic, preserve prices, guard roles and replay safely', async () => {
  const { app, store, service } = await createNativeApp({ database: ':memory:', sessionCookieName: 'native_demo_session' });
  try {
    const login = service.login('admin', '1234', 'LAGUSTOSA-TEST', 'test');
    const waiter = service.login('waiter', '3456', 'LAGUSTOSA-TEST', 'waiter');
    const headers = { cookie: 'native_demo_session=' + login.token };
    const waiterHeaders = { cookie: 'native_demo_session=' + waiter.token };
    service.openDay(login.actor, { key: randomUUID(), floatOre: 0 });
    const menu = service.menu().find(item => item.modifiers.length === 0)!;
    const changed = { ...menu, modifiers: [{ id: 'extra', name: 'Extra', min: 0, max: 1, options: [{ id: 'extra-1', name: 'Extra', priceOre: 1000 }] }] } as MenuItem;
    store.put('menu', changed);
    const make = () => {
      let tab = service.createTab(login.actor, { key: randomUUID(), tableId: null, guestCount: 2, serviceMode: 'dine_in' });
      tab = service.updateTab(login.actor, tab.id, { key: randomUUID(), version: tab.version, action: 'add', itemId: menu.id, quantity: 3, modifiers: ['extra-1'], guest: 2, notes: 'Särskild beställning', hold: false });
      tab = service.updateTab(login.actor, tab.id, { key: randomUUID(), version: tab.version, action: 'price', lineId: tab.lines[0].id, priceOre: 12345, reason: 'Testpris' });
      return tab;
    };
    const reduce = (tab: Tab, h = headers, overrides = {}) => {
      const body = { key: randomUUID(), version: tab.version, lineId: tab.lines[0].id, expectedQuantity: tab.lines[0].quantity, reason: 'Felregistrerat antal', ...overrides };
      return { body, url: `/api/v1/native/tabs/${tab.id}/decrement`, send: () => app.inject({ method: 'POST', url: `/api/v1/native/tabs/${tab.id}/decrement`, headers: h, payload: body }) };
    };
    let tab = make();
    const original = structuredClone(tab.lines[0]);
    const first = reduce(tab, waiterHeaders);
    const response = await first.send();
    assert.equal(response.statusCode, 200);
    tab = response.json();
    assert.deepEqual(tab.lines[0], { ...original, quantity: 2 });
    const auditCount = store.journal().length;
    // Simulate a lost response: resend the same durable command and receive the same result.
    assert.deepEqual((await first.send()).json(), tab);
    assert.equal(service.tab(tab.id).lines[0].quantity, 2);
    assert.equal(store.journal().length, auditCount);
    assert.equal((await app.inject({ method: 'POST', url: first.url, headers, payload: { ...first.body, reason: 'Ändrad avsikt' } })).statusCode, 409);
    assert.equal((await reduce(tab, headers, { version: tab.version - 1 }).send()).statusCode, 409);
    assert.equal((await reduce(tab, headers, { expectedQuantity: 3 }).send()).statusCode, 409);
    assert.equal((await reduce(tab, headers, { expectedQuantity: 1 }).send()).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: first.url, payload: first.body })).statusCode, 401);
    // A sent row keeps its preparation state and emits a cancellation for exactly one item.
    tab = service.updateTab(login.actor, tab.id, { key: randomUUID(), version: tab.version, action: 'send' });
    assert.equal((await reduce(tab, waiterHeaders).send()).statusCode, 403);
    const sent = reduce(tab);
    const sentResult = await sent.send();
    assert.equal(sentResult.statusCode, 200);
    tab = sentResult.json();
    assert.equal(tab.lines[0].quantity, 1);
    assert.equal(tab.lines[0].status, 'sent');
    const tickets = store.all<Ticket>('ticket').filter(t => t.tabId === tab.id);
    assert.equal(tickets.find(t => t.kind === 'order')!.items[0].quantity, 1);
    assert.equal(tickets.find(t => t.kind === 'cancel')!.items[0].quantity, 1);
    assert.equal(tickets.filter(t => t.kind === 'cancel').length, 1);
    assert.equal((await sent.send()).statusCode, 200);
    assert.equal(store.all<Ticket>('ticket').filter(t => t.tabId === tab.id && t.kind === 'cancel').length, 1);
    // Payment reservations must block amount changes, including unknown outcomes.
    for (const status of ['pending', 'unknown', 'approved'] as const) {
      const paid = make();
      store.put('payment', { id: randomUUID(), tabId: paid.id, kind: 'sale', status } as Payment);
      const blocked = await reduce(paid).send();
      assert.equal(blocked.json().code, 'TAB_LOCKED');
      assert.equal(service.tab(paid.id).lines[0].quantity, 3);
    }
    // If ticket validation fails, cancellation, print queue, bill and journal all roll back.
    let broken = make();
    broken = service.updateTab(login.actor, broken.id, { key: randomUUID(), version: broken.version, action: 'send' });
    const ticket = store.all<Ticket>('ticket').find(t => t.tabId === broken.id)!;
    ticket.items[0].quantity = 1;
    store.put('ticket', ticket);
    const counts = [store.all<Ticket>('ticket').length, store.all<PrintJob>('print').length, store.journal().length];
    assert.equal((await reduce(broken).send()).json().code, 'TICKET_QUANTITY_CONFLICT');
    assert.equal(service.tab(broken.id).lines[0].quantity, 3);
    assert.deepEqual([store.all<Ticket>('ticket').length, store.all<PrintJob>('print').length, store.journal().length], counts);
    assert.equal(store.verifyJournal(), true);
  } finally { await app.close(); }
});

test('split payments preserve every ore and reject duplicate item selection or stale bills', async () => {
  const { app, store, service } = await createNativeApp({ database: ':memory:', sessionCookieName: 'native_demo_session' });
  try {
    const login = service.login('admin', '1234', 'LAGUSTOSA-TEST', 'split-review');
    const headers = { cookie: 'native_demo_session=' + login.token };
    service.openDay(login.actor, { key: randomUUID(), floatOre: 0 });
    const source = service.menu().find(item => item.modifiers.length === 0)!;
    const item = { ...source, priceOre: 10001 };
    store.put('menu', item);
    function make(quantity = 1) {
      let tab = service.createTab(login.actor, { key: randomUUID(), tableId: null, guestCount: 2, serviceMode: 'dine_in' });
      tab = service.updateTab(login.actor, tab.id, { key: randomUUID(), version: tab.version, action: 'add', itemId: item.id, quantity, guest: 1, hold: false });
      return service.updateTab(login.actor, tab.id, { key: randomUUID(), version: tab.version, action: 'send' });
    }
    const pay = (tab: Tab, choice: object, key = randomUUID()) => {
      const body = { key, version: tab.version, method: 'card', tipOre: 0, swishVerified: false, simulation: 'approved', fiscalSimulation: 'confirmed', ...choice };
      return { body, send: () => app.inject({ method: 'POST', url: `/api/v1/tabs/${tab.id}/payments`, headers, payload: body }) };
    };
    let equal = make();
    for (const amountOre of [3334, 3334, 3333]) {
      const part = pay(equal, { amountOre });
      const result = await part.send();
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().amountOre, amountOre);
      assert.equal((await part.send()).json().id, result.json().id, 'retry returns the same payment');
      equal = service.tab(equal.id);
    }
    assert.equal(equal.status, 'paid');
    assert.equal(store.all<Payment>('payment').filter(p => p.tabId === equal.id).length, 3);
    let perItem = make(3);
    const lineId = perItem.lines[0].id;
    const one = await pay(perItem, { items: [{ lineId, quantity: 1 }] }).send();
    assert.equal(one.statusCode, 200);
    assert.equal(one.json().amountOre, 10001);
    perItem = service.tab(perItem.id);
    assert.equal((await pay(perItem, { items: [{ lineId, quantity: 3 }] }).send()).json().code, 'QUANTITY_EXCEEDED');
    assert.equal((await pay(perItem, { lineIds: [lineId] }).send()).json().amountOre, 20002);
    assert.equal(service.tab(perItem.id).status, 'paid');
    let perGuest = make();
    perGuest = service.updateTab(login.actor, perGuest.id, { key: randomUUID(), version: perGuest.version, action: 'add', itemId: item.id, guest: 2, quantity: 1, hold: false });
    perGuest = service.updateTab(login.actor, perGuest.id, { key: randomUUID(), version: perGuest.version, action: 'send' });
    assert.equal((await pay(perGuest, { guest: 1 }).send()).json().amountOre, 10001);
    perGuest = service.tab(perGuest.id);
    assert.equal((await pay(perGuest, { guest: 1 }).send()).json().code, 'NO_BALANCE');
    assert.equal((await pay(perGuest, { guest: 2 }).send()).json().amountOre, 10001);
    const stale = make();
    service.updateTab(login.actor, stale.id, { key: randomUUID(), version: stale.version, action: 'guests', guestCount: 3 });
    assert.equal((await pay(stale, { amountOre: 10001 }).send()).json().code, 'VERSION_CONFLICT');
    assert.equal(store.all<Payment>('payment').filter(p => p.tabId === stale.id).length, 0);
    assert.equal(store.verifyJournal(), true);
  } finally { await app.close(); }
});
