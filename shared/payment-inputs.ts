import { z } from 'zod';

const id = z.string().min(1).max(100);
const ore = z.number().int().min(0).max(100000000);

export const paymentSchema = z.object({
  key: id, version: z.number().int().min(1), method: z.enum(['card', 'swish', 'cash']),
  amountOre: ore.optional(), tipOre: ore, lineIds: z.array(id).max(1000).optional(),
  guest: z.number().int().min(0).max(100).optional(), tenderedOre: ore.optional(),
  swishVerified: z.boolean().optional(), simulation: z.enum(['approved', 'declined', 'cancelled', 'unknown']),
  fiscalSimulation: z.enum(['confirmed', 'unknown']).default('confirmed'),
}).strict();

export const refundSchema = z.object({
  key: id, amountOre: ore, reason: z.string().trim().min(3).max(500),
  simulation: z.enum(['approved', 'declined', 'cancelled', 'unknown']),
  fiscalSimulation: z.enum(['confirmed', 'unknown']).default('confirmed'),
}).strict();

export type PaymentInput = z.infer<typeof paymentSchema>;
export type RefundInput = z.infer<typeof refundSchema>;
