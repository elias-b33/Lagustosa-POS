import type { DiningTable, MenuItem, Settings, Staff, Device } from '../shared/types';
import { Store, digest, hashPin } from './db';

export interface StoredStaff extends Staff { pinHash: string }
export interface StoredDevice extends Device { codeHash: string }

const sides = { id: 'sides', name: 'Tillbehör', min: 1, max: 1, options: [{ id: 'potatoes', name: 'Klyftpotatis', priceOre: 0 }, { id: 'vegetables', name: 'Grillade grönsaker', priceOre: 0 }] };
const sauces = { id: 'sauces', name: 'Sås', min: 1, max: 1, options: [{ id: 'pepper', name: 'Pepparsås', priceOre: 0 }, { id: 'mushroom', name: 'Champinjonsås', priceOre: 0 }, { id: 'roquefort', name: 'Roquefortsås', priceOre: 0 }] };

export const exampleMenu: MenuItem[] = [
  { id: 'bread', name: 'Vitlöksbröd', category: 'Antipasti', description: 'Pizzabröd med vitlök', priceOre: 6900, course: 'starter' },
  { id: 'olives', name: 'Gröna oliver', category: 'Antipasti', description: 'En liten början på kvällen', priceOre: 5900, course: 'starter' },
  { id: 'antipasto', name: 'Antipasto della casa', category: 'Antipasti', description: 'Piccolo · ost, chark och oliver', priceOre: 12900, course: 'starter' },
  { id: 'carpaccio', name: 'Carpaccio di Breasola', category: 'Antipasti', description: 'Parmesan, ruccola och citron', priceOre: 12500, course: 'starter' },
  { id: 'penne', name: 'Penne Manzo', category: 'Pasta & risotto', description: 'Oxfilé och krämig pepparsås', priceOre: 21500 },
  { id: 'lasagna', name: 'Lasagna Classica', category: 'Pasta & risotto', description: 'Klassisk lasagne med parmesan', priceOre: 19900 },
  { id: 'risotto', name: 'Risotto Vegetariana', category: 'Pasta & risotto', description: 'Grönsaker och parmesan', priceOre: 19900 },
  { id: 'margherita', name: 'Regina Margherita', category: 'Pizza', description: 'Tomat, mozzarella och basilika', priceOre: 14500 },
  { id: 'sandwalls', name: 'Sandwalls', category: 'Pizza', description: 'Oxfilé, svamp och parmesancreme', priceOre: 19500 },
  { id: 'diavola', name: 'Diavola', category: 'Pizza', description: 'Salami, rödlök och chili', priceOre: 18900 },
  { id: 'filetto', name: 'Filetto di Manzo', category: 'Carne & pesce', description: 'Grillad oxfilé · välj sås och tillbehör', priceOre: 35500, modifiers: [sides, sauces] },
  { id: 'pollo', name: 'Pollo alla Griglia', category: 'Carne & pesce', description: 'Grillad kyckling · välj sås och tillbehör', priceOre: 22900, modifiers: [sides, sauces] },
  { id: 'tiramisu', name: 'Tiramisu', category: 'Dolce', description: 'Ett sött avslut', priceOre: 9900, course: 'dessert' },
  { id: 'pannacotta', name: 'Pannacotta', category: 'Dolce', description: 'Klassisk pannacotta', priceOre: 9900, course: 'dessert' },
  { id: 'redwine', name: 'Husets röda · glas', category: 'Bar & dryck', description: 'Exempelpris för träning', priceOre: 9500, course: 'drink', station: 'bar', taxClass: 'alcohol' },
  { id: 'prosecco', name: 'Prosecco · glas', category: 'Bar & dryck', description: 'Exempelpris för träning', priceOre: 10500, course: 'drink', station: 'bar', taxClass: 'alcohol' },
  { id: 'cola', name: 'Cola', category: 'Bar & dryck', description: 'Exempelpris för träning', priceOre: 3900, course: 'drink', station: 'bar' },
  { id: 'coffee', name: 'Espresso', category: 'Bar & dryck', description: 'Exempelpris för träning', priceOre: 3500, course: 'drink', station: 'bar' },
].map(item => ({ takeawayPriceOre: null, taxClass: 'food', course: 'main', station: 'kitchen', available: true, example: true, modifiers: [], ...item }) as MenuItem);

export const initialSettings: Settings = {
  company: { name: 'Lagustosa · TRÄNING', organizationNumber: '9999999999', address: 'Sandwallsplats 7', city: '50335 Borås', phone: '072-993 99 93' },
  registerId: 'LAGUSTOSA-TEST-01',
  taxRules: [
    ...(['dine_in', 'takeaway'] as const).flatMap(mode => [
      { id: `food-${mode}`, taxClass: 'food' as const, mode, from: '2020-01-01', until: null, rateBps: 1200 },
      { id: `alcohol-${mode}`, taxClass: 'alcohol' as const, mode, from: '2020-01-01', until: null, rateBps: 2500 },
      { id: `standard-${mode}`, taxClass: 'standard' as const, mode, from: '2020-01-01', until: null, rateBps: 2500 },
    ]),
    { id: 'food-takeaway-2026', taxClass: 'food', mode: 'takeaway', from: '2026-04-01', until: '2027-12-31', rateBps: 600 },
  ],
};

export function seed(store: Store): void {
  if (store.get('meta', 'seeded')) return;
  store.atomic(() => {
    for (const item of exampleMenu) store.put('menu', item);
    for (let index = 0; index < 12; index++) {
      const table: DiningTable = { id: `table-${index + 1}`, name: `Bord ${String(index + 1).padStart(2, '0')}`, seats: index % 3 === 0 ? 2 : 4, area: index < 8 ? 'Matsalen' : 'Terrassen', x: 15 + (index % 4) * 23, y: 20 + Math.floor(index / 4) * 29, active: true };
      store.put('table', table);
    }
    const users: (Staff & { pin: string })[] = [
      { id: 'admin', name: 'Ansvarig', role: 'admin', active: true, pin: '1234' },
      { id: 'cashier', name: 'Kassa', role: 'cashier', active: true, pin: '2345' },
      { id: 'waiter', name: 'Servering', role: 'waiter', active: true, pin: '3456' },
      { id: 'kitchen', name: 'Kök', role: 'kitchen', active: true, pin: '4567' },
      { id: 'bar', name: 'Bar', role: 'bar', active: true, pin: '5678' },
    ];
    for (const { pin, ...staff } of users) store.put('staff', { ...staff, pinHash: hashPin(pin) });
    const devices: (Device & { code: string })[] = [
      { id: 'main', name: 'Huvudkassa', kind: 'main', station: null, active: true, code: 'LAGUSTOSA-TEST' },
      ...Array.from({ length: 4 }, (_, index) => ({ id: `serving-${index + 1}`, name: `Servering ${index + 1}`, kind: 'serving' as const, station: null, active: true, code: `SERVERING-${index + 1}` })),
      { id: 'display-kitchen', name: 'Köksskärm', kind: 'display', station: 'kitchen', active: true, code: 'KOK-TEST' },
      { id: 'display-bar', name: 'Barskärm', kind: 'display', station: 'bar', active: true, code: 'BAR-TEST' },
      { id: 'display-kitchen-2', name: 'Köksskärm 2', kind: 'display', station: 'kitchen', active: true, code: 'KOK-TEST-2' },
    ];
    for (const { code, ...device } of devices) store.put('device', { ...device, codeHash: digest(code) });
    store.put('settings', { id: 'settings', ...initialSettings });
    store.put('meta', { id: 'seeded', mode: 'training', version: 1 });
  });
}
