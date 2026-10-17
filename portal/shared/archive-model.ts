import { z } from "zod";
export const orderSummarySchema = z.object({
  id: z.string(),
  number: z.number().int(),
  table: z.string(),
  status: z.enum(["open", "paid", "void"]),
  openedAt: z.string(),
  updatedAt: z.string(),
  guestCount: z.number().int(),
  totalOre: z.number().int(),
  paidOre: z.number().int(),
  lines: z.array(
    z.object({
      name: z.string(),
      quantity: z.number().int(),
      unitPriceOre: z.number().int(),
      vatBps: z.number().int(),
      status: z.string(),
    }),
  ),
});
export const savedReportSchema = z.object({
  id: z.string(),
  kind: z.enum(["X", "Z"]),
  at: z.string(),
  sequence: z.number().int().nullable(),
  registerId: z.string().nullable(),
  salesOre: z.number().int(),
  refundsOre: z.number().int(),
  netOre: z.number().int(),
  vatOre: z.number().int(),
  tipsOre: z.number().int(),
  receipts: z.number().int(),
  expectedCashOre: z.number().int(),
  differenceOre: z.number().int().nullable(),
  methods: z.array(
    z.object({
      method: z.string(),
      salesOre: z.number().int(),
      refundsOre: z.number().int(),
      tipsOre: z.number().int(),
      netOre: z.number().int(),
    }),
  ),
  vat: z.array(
    z.object({
      rateBps: z.number().int(),
      grossOre: z.number().int(),
      vatOre: z.number().int(),
    }),
  ),
});
export const eventSummarySchema = z.object({
  id: z.number().int(),
  at: z.string(),
  action: z.string(),
  entityId: z.string(),
  registerId: z.string().nullable(),
});
export type OrderSummary = z.infer<typeof orderSummarySchema>;
export type SavedReport = z.infer<typeof savedReportSchema>;
export type EventSummary = z.infer<typeof eventSummarySchema>;
