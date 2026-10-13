import { z } from 'zod';
export { paymentSchema, refundSchema } from '../shared/payment-inputs';
export type { PaymentInput, RefundInput } from '../shared/payment-inputs';
export { cashMovementSchema } from '../shared/cash-inputs';

const ore = z.number().int().min(0).max(100000000);
const id = z.string().min(1).max(100);
const text = z.string().trim().max(1000);
const role = z.enum(['admin', 'cashier', 'waiter', 'kitchen', 'bar']);
const option = z.object({ id, name: z.string().trim().min(1).max(100), priceOre: ore }).strict();
const modifier = z.object({ id, name: z.string().trim().min(1).max(100), min: z.number().int().min(0).max(20), max: z.number().int().min(1).max(20), options: z.array(option).max(20) }).strict();
export const menuSchema = z.object({
  id, name: z.string().trim().min(1).max(100), category: z.string().trim().min(1).max(100), description: text,
  position: z.number().int().min(0).max(100000).optional(),
  itemKind: z.enum(['goods', 'services']).optional(),
  takeawayItemKind: z.enum(['goods', 'services']).optional(),
  priceOre: ore, takeawayPriceOre: ore.nullable(), taxClass: z.enum(['food', 'alcohol', 'standard']),
  course: z.enum(['starter', 'main', 'dessert', 'drink']), station: z.enum(['kitchen', 'bar']),
  available: z.boolean(), example: z.boolean(), modifiers: z.array(modifier).max(10),
}).strict();
export const tableSchema = z.object({ id, name: z.string().trim().min(1).max(40), seats: z.number().int().min(1).max(100), area: z.string().trim().min(1).max(60), x: z.number().min(0).max(100), y: z.number().min(0).max(100), active: z.boolean() }).strict();
export const deviceSchema = z.object({ name: z.string().trim().min(1).max(60), kind: z.enum(['main', 'serving', 'display']), station: z.enum(['kitchen', 'bar']).nullable(), active: z.boolean() }).strict();
export const printerSchema = z.object({ id, name: z.string().trim().min(1).max(60), destination: z.enum(['guest', 'kitchen', 'bar']), paperWidthMm: z.union([z.literal(58), z.literal(80)]), active: z.boolean() }).strict();
export const staffSchema = z.object({ id, name: z.string().trim().min(1).max(60), role, active: z.boolean(), pin: z.string().regex(/^\d{4,8}$/).optional() }).strict();
export const loginSchema = z.object({ staffId: id, pin: z.string().regex(/^\d{4,8}$/), deviceCode: z.string().min(1).max(100) }).strict();
export const createTabSchema = z.object({ key: id, tableId: id.nullable(), guestCount: z.number().int().min(1).max(100), serviceMode: z.enum(['dine_in', 'takeaway']) }).strict();
export const commandSchema = z.object({
  key: id, version: z.number().int().min(1),
  action: z.enum(['add', 'remove', 'send', 'fire', 'move', 'guests', 'discount', 'price', 'void']),
  itemId: id.optional(), lineId: id.optional(), quantity: z.number().int().min(1).max(100).optional(),
  guest: z.number().int().min(0).max(100).optional(), modifiers: z.array(id).max(100).optional(), notes: text.optional(),
  course: z.enum(['starter', 'main', 'dessert', 'drink']).optional(), hold: z.boolean().optional(),
  tableId: id.nullable().optional(), guestCount: z.number().int().min(1).max(100).optional(),
  discountBps: z.number().int().min(0).max(10000).optional(), priceOre: ore.optional(), reason: text.optional(),
}).strict();
export const openDaySchema = z.object({ key: id, floatOre: ore }).strict();
export const closeDaySchema = z.object({ key: id, countedCashOre: ore }).strict();
export const ticketSchema = z.object({ status: z.enum(['started', 'ready', 'served']) }).strict();
export const printSchema = z.object({ action: z.enum(['print', 'resolve', 'reprint', 'route']), outcome: z.enum(['printed', 'failed', 'uncertain']).optional(), reason: text.optional(), printerId: id.optional() }).strict();
export const settingsSchema = z.object({
  company: z.object({ name: z.string().trim().min(1).max(100), organizationNumber: z.string().regex(/^\d{10}$/), address: z.string().trim().min(1).max(100), city: z.string().trim().min(1).max(100), phone: z.string().trim().max(40) }).strict(),
  registerId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  taxRules: z.array(z.object({ id, taxClass: z.enum(['food', 'alcohol', 'standard']), mode: z.enum(['dine_in', 'takeaway']), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), rateBps: z.number().int().min(0).max(10000) }).strict()).min(6).max(100),
}).strict();
export type TabCommand = z.infer<typeof commandSchema>;
