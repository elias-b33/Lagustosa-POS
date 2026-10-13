import { z } from 'zod';

export const cashMovementSchema = z.object({
  key: z.string().min(1).max(100), dayId: z.string().min(1).max(100), direction: z.enum(['in', 'out']),
  amountOre: z.number().int().min(1).max(100000000), reason: z.string().trim().min(3).max(500),
}).strict();
export type CashMovementInput = z.infer<typeof cashMovementSchema>;
