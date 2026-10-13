import { z } from 'zod';

const id = z.string().min(1).max(100);
const ore = z.number().int().min(0).max(100000000);
const itemSelection = z.array(z.object({ lineId: id, quantity: z.number().int().min(1).max(100) }).strict()).min(1).max(1000)
  .refine(items => new Set(items.map(item => item.lineId)).size === items.length, 'En artikelrad får endast väljas en gång.');

export const paymentSchema = z.object({
  key: id, version: z.number().int().min(1), method: z.enum(['card', 'swish', 'cash']),
  amountOre: ore.optional(), tipOre: ore, lineIds: z.array(id).min(1).max(1000).optional(), items: itemSelection.optional(),
  guest: z.number().int().min(0).max(100).optional(), tenderedOre: ore.optional(),
  swishVerified: z.boolean().optional(), simulation: z.enum(['approved', 'declined', 'cancelled', 'unknown']),
  fiscalSimulation: z.enum(['confirmed', 'unknown']).default('confirmed'),
}).strict().refine(input => !input.items || !input.lineIds && input.guest === undefined, 'Artikelantal kan inte kombineras med ett annat artikelurval.');

export const refundSchema = z.object({
  key: id, amountOre: ore.optional(), lineIds: z.array(id).min(1).max(1000).optional(), items: itemSelection.optional(),
  reason: z.string().trim().min(3).max(500),
  simulation: z.enum(['approved', 'declined', 'cancelled', 'unknown']),
  fiscalSimulation: z.enum(['confirmed', 'unknown']).default('confirmed'),
}).strict().refine(input => !input.items || !input.lineIds, 'Välj artikelantal eller artikelrader.')
  .refine(input => input.amountOre !== undefined || input.items !== undefined || input.lineIds !== undefined, 'Välj artiklar eller ett belopp att returnera.');

export type PaymentInput = z.infer<typeof paymentSchema>;
export type RefundInput = z.infer<typeof refundSchema>;
