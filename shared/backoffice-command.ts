import { z } from "zod";
const id = z.string().min(1).max(100);
export const managementKinds = [
  "restaurant",
  "product",
  "category",
  "global-category",
  "modifier",
  "coupon",
  "campaign",
  "stock",
  "staff",
  "device",
  "printer",
  "table",
] as const;
export type ManagementKind = (typeof managementKinds)[number];
export const managementCommandSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(managementKinds),
    target: id,
    baseVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    value: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ManagementCommand = z.infer<typeof managementCommandSchema>;
