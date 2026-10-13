import { describe, expect, it } from 'vitest';
import type { Payment, Receipt } from '../shared/types';
import { Store } from '../server/db';
import { KassaService } from '../server/service';
import type { RegisterIdentity } from '../server/registers';
import { fixture, key } from './helpers';

function readyTab(f: ReturnType<typeof fixture>) {
  const tab = f.tab(null);
  f.command(tab.id, { action: 'add', itemId: 'bread' });
  f.command(tab.id, { action: 'send' });
  return tab;
}

describe('Beständiga kassor och kvittoserier', () => {
  it('skiljer fem säljande enheter, men skapar ingen kassa för orderskärmar', async () => {
    const f = fixture(); f.open();
    const registers = f.store.all<RegisterIdentity>('register');
    expect(registers).toHaveLength(5);
    expect(new Set(registers.map(register => register.id)).size).toBe(5);
    expect(registers.every(register => register.id.length <= 40 && !register.deviceId.startsWith('display'))).toBe(true);
    for (const code of ['LAGUSTOSA-TEST', 'SERVERING-1', 'SERVERING-2', 'SERVERING-3', 'SERVERING-4']) {
      const actor = f.actor('admin', code);
      for (let i = 0; i < 2; i++) await f.pay(readyTab(f).id, {}, actor);
    }
    const receipts = f.store.all<Receipt>('receipt');
    for (const register of registers) {
      const series = receipts.filter(receipt => receipt.registerId === register.id);
      expect(series.map(receipt => receipt.number)).toEqual([1, 2]);
      expect(series.every(receipt => receipt.payment.registerId === register.id && receipt.payment.deviceId === register.deviceId)).toBe(true);
    }
    expect(new Set(receipts.map(receipt => receipt.controlCode)).size).toBe(10);
    expect(f.store.verifyJournal()).toBe(true);
  });

  it('behåller betalningskassans identitet och kassör vid kontroll från annan kassa', async () => {
    const f = fixture(); f.open();
    const waiter = f.actor('waiter', 'SERVERING-2');
    const payment = await f.pay(readyTab(f).id, { simulation: 'unknown' }, waiter);
    f.service.saveStaff(f.admin, { id: waiter.staff.id, name: 'Nytt personalnamn', role: 'waiter', active: true });
    const checked = await f.service.checkPayment(f.admin, payment.id);
    expect(checked.status).toBe('approved');
    const receipt = f.store.all<Receipt>('receipt')[0];
    expect(receipt.registerId).toBe(payment.registerId);
    expect(receipt.cashier).toBe('Servering');
    expect(receipt.number).toBe(1);
    const created = f.store.journal().find(entry => entry.action === 'receipt.create')!;
    expect(created.details).toMatchObject({ registerId: payment.registerId });
    expect(f.store.journal().find(entry => entry.action === 'fiscal.confirmed' && entry.entityId === receipt.id)?.details).toMatchObject({ registerId: payment.registerId });
    const uncertain = await f.pay(readyTab(f).id, { fiscalSimulation: 'unknown' }, waiter);
    const uncertainReceipt = f.store.all<Receipt>('receipt').find(receipt => receipt.paymentId === uncertain.id)!;
    await f.service.verifyFiscal(f.admin, uncertainReceipt.id);
    expect(f.store.journal().find(entry => entry.action === 'fiscal.verify' && entry.entityId === uncertainReceipt.id)?.details).toMatchObject({ registerId: uncertain.registerId });
  });

  it('bevarar kassor och nästa kvittonummer vid omstart', async () => {
    const f = fixture({}, true); f.open(); await f.pay(readyTab(f).id);
    const before = f.store.all<RegisterIdentity>('register');
    f.store.close();
    const store = new Store(f.filename);
    try {
      const service = new KassaService(store, { now: () => new Date('2026-10-13T20:05:00Z') });
      expect(store.all('register')).toEqual(before);
      const actor = service.login('admin', '1234', 'LAGUSTOSA-TEST', 'local').actor;
      const tab = service.createTab(actor, { key: key(), tableId: null, guestCount: 1, serviceMode: 'dine_in' });
      service.updateTab(actor, tab.id, { key: key(), version: 1, action: 'add', itemId: 'bread' });
      service.updateTab(actor, tab.id, { key: key(), version: 2, action: 'send' });
      await service.startPayment(actor, tab.id, { key: key(), version: 3, method: 'card', tipOre: 0, simulation: 'approved', fiscalSimulation: 'confirmed' });
      expect(store.all<Receipt>('receipt').map(receipt => receipt.number)).toEqual([1, 2]);
    } finally { store.close(); }
  });

  it('skyddar registeridentiteten och betalningsförsökets ursprung i databasen', async () => {
    const f = fixture(); f.open();
    const register = f.store.all<RegisterIdentity>('register')[0];
    expect(() => f.store.put('register', { ...register, deviceId: 'serving-4' })).toThrow('permanent');
    expect(() => f.store.db.prepare("DELETE FROM entities WHERE kind='register' AND id=?").run(register.id)).toThrow('raderas');
    const payment = await f.pay(readyTab(f).id, { simulation: 'unknown' });
    expect(() => f.store.put<Payment>('payment', { ...payment, registerId: 'ANNAN' })).toThrow('oföränderliga');
    expect(() => f.store.put<Payment>('payment', { ...payment, amountOre: 1 })).toThrow('oföränderliga');
    expect(f.store.verifyJournal()).toBe(true);
  });

  it('låser enhetsrollen under öppen dag och bevarar samma register efter namn-/kodbyte', () => {
    const f = fixture(); const before = f.store.all<RegisterIdentity>('register');
    const device = f.service.publicDevices().find(device => device.id === 'serving-1')!;
    f.service.saveDevice(f.admin, { name: 'Handterminal A', kind: 'serving', station: null, active: true }, device.id);
    expect(JSON.stringify(f.store.journal())).not.toContain('codeHash');
    expect(f.store.all<RegisterIdentity>('register')).toEqual(before);
    f.open();
    expect(() => f.service.saveDevice(f.admin, { name: 'Skärm', kind: 'display', station: 'kitchen', active: true }, device.id)).toThrow('Avsluta verksamhetsdagen');
  });

  it('journalför avstängning av den egna enheten med ursprunglig identitet och utan kodhash', () => {
    const f = fixture();
    const registerId = f.service.registerFor(f.admin).id;
    f.service.saveDevice(f.admin, { name: 'Reservkassa', kind: 'main', station: null, active: true });
    f.service.saveDevice(f.admin, { name: 'Avstängd huvudkassa', kind: 'main', station: null, active: false }, f.admin.device.id);
    expect(f.service.publicDevices().find(device => device.id === f.admin.device.id)?.active).toBe(false);
    const entry = f.store.journal().at(-1)!;
    expect(entry.action).toBe('device.save');
    expect(entry.details).toMatchObject({ registerId, previous: { active: true }, device: { active: false } });
    expect(JSON.stringify(entry)).not.toContain('codeHash');
    expect(f.store.verifyJournal()).toBe(true);
  });

  it('sparar rätt vara-/tjänstklass för servering och avhämtning utan att ändra befintliga rader', () => {
    const f = fixture(); f.open();
    const item = f.service.menu().find(item => item.id === 'bread')!;
    f.service.saveMenu(f.admin, { ...item, itemKind: 'services', takeawayItemKind: 'goods' });
    const dining = f.tab(null);
    const takeaway = f.service.createTab(f.admin, { key: key(), tableId: null, guestCount: 1, serviceMode: 'takeaway' });
    expect(f.command(dining.id, { action: 'add', itemId: item.id }).lines[0].itemKind).toBe('services');
    expect(f.command(takeaway.id, { action: 'add', itemId: item.id }).lines[0].itemKind).toBe('goods');
    f.service.saveMenu(f.admin, { ...item, itemKind: 'goods', takeawayItemKind: 'services' });
    expect(f.service.tab(dining.id).lines[0].itemKind).toBe('services');
    expect(f.service.tab(takeaway.id).lines[0].itemKind).toBe('goods');
  });
});
