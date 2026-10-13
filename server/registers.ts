import type { Device, Receipt, Settings } from '../shared/types';
import { Store } from './db';
import { demand } from './errors';

export interface RegisterIdentity { id: string; deviceId: string; createdAt: string }

// Enrolment only affects future operations. Old shared-register history must
// never be relabelled using today's device configuration.
export function enrolRegister(store: Store, device: Device, at: string): RegisterIdentity | null {
  if (device.kind === 'display') return null;
  return store.atomic(() => {
    const existing = store.all<RegisterIdentity>('register').find(register => register.deviceId === device.id);
    if (existing) return existing;
    const prefix = store.get<Settings>('settings', 'settings')!.registerId.slice(0, 31);
    const historicalIds = new Set(store.all<Receipt>('receipt').map(receipt => receipt.registerId));
    let id: string;
    do {
      const sequence = store.next('register');
      demand(sequence <= 999999, 'Kassornas identitetsserie är full.', 409, 'REGISTER_LIMIT');
      id = `${prefix}-R${String(sequence).padStart(6, '0')}`;
    } while (store.get('register', id) || historicalIds.has(id));
    const register = { id, deviceId: device.id, createdAt: at };
    store.put('register', register);
    store.audit('system', 'register.enrolled', id, { register, registerId: id }, at);
    return register;
  });
}
