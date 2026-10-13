import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { Store } from '../server/db';
import { KassaService } from '../server/service';
import type { Actor, Tab } from '../shared/types';
import type { PaymentInput, TabCommand } from '../server/validation';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
export const key = () => randomUUID();
export function fixture(options: ConstructorParameters<typeof KassaService>[1] = {}, persistent = false) {
  const directory = mkdtempSync(path.join(tmpdir(), 'lagustosa-test-'));
  const filename = persistent ? path.join(directory, 'training.sqlite') : ':memory:';
  const store = new Store(filename);
  const service = new KassaService(store, { now: () => new Date('2026-10-13T20:00:00Z'), backupDir: path.join(directory, 'backups'), ...options });
  cleanups.push(() => { if (store.db.open) store.close(); rmSync(directory, { recursive: true, force: true }); });
  const actor = (staff = 'admin', code = 'LAGUSTOSA-TEST'): Actor => service.login(staff, ({ admin: '1234', cashier: '2345', waiter: '3456', kitchen: '4567', bar: '5678' } as Record<string, string>)[staff], code, '127.0.0.1').actor;
  const admin = actor();
  const open = () => service.openDay(admin, { key: key(), floatOre: 150000 });
  const tab = (tableId: string | null = 'table-1', guestCount = 2) => service.createTab(admin, { key: key(), tableId, guestCount, serviceMode: 'dine_in' });
  const command = (id: string, input: Omit<TabCommand, 'key' | 'version'>, who = admin): Tab => service.updateTab(who, id, { ...input, key: key(), version: service.tab(id).version });
  const pay = (id: string, input: Partial<PaymentInput> = {}, who = admin) => service.startPayment(who, id, { key: key(), version: service.tab(id).version, method: 'card', tipOre: 0, simulation: 'approved', fiscalSimulation: 'confirmed', ...input });
  return { store, service, admin, actor, open, tab, command, pay, directory, filename };
}
