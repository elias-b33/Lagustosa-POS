import { z } from "zod";

const id = z.string().min(1).max(160);
const ore = z.number().int().safe();
const count = z.number().int().min(0).max(100000000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(value + "T12:00:00Z");
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  });
const time = z.string().datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const totalsSchema = z
  .object({
    salesOre: ore,
    refundsOre: ore,
    salesVatOre: ore,
    refundsVatOre: ore,
    tipsOre: ore,
    discountsOre: ore,
    salesCount: count,
    refundsCount: count,
  })
  .strict();
export type Totals = z.infer<typeof totalsSchema>;
export const zeroTotals = (): Totals => ({
  salesOre: 0,
  refundsOre: 0,
  salesVatOre: 0,
  refundsVatOre: 0,
  tipsOre: 0,
  discountsOre: 0,
  salesCount: 0,
  refundsCount: 0,
});
export function addTotals(target: Totals, source: Totals): Totals {
  for (const key of Object.keys(target) as (keyof Totals)[]) {
    const value = target[key] + source[key];
    if (!Number.isSafeInteger(value))
      throw new Error("Statistikens belopp överstiger säker heltalsberäkning.");
    target[key] = value;
  }
  return target;
}
export const net = (value: Totals, exclusive = false) =>
  value.salesOre -
  value.refundsOre -
  (exclusive ? value.salesVatOre - value.refundsVatOre : 0);
const quantity = z
  .object({
    numerator: z.string().regex(/^\d{1,80}$/),
    denominator: z.string().regex(/^[1-9]\d{0,79}$/),
  })
  .strict();
const bucketSchema = z
  .object({ key: id, registerId: id, totals: totalsSchema })
  .strict();
const productSchema = z
  .object({
    itemId: id,
    name: z.string().max(200),
    category: z.string().max(200),
    registerId: id,
    totals: totalsSchema,
    sold: quantity,
    refunded: quantity,
    unknownQuantity: count,
  })
  .strict();
const receiptSchema = z
  .object({
    id,
    number: count.nullable(),
    tabNumber: count.nullable(),
    registerId: id,
    at: time,
    kind: z.enum(["sale", "refund"]),
    method: z.enum(["card", "cash", "swish"]),
    amountOre: ore,
    vatOre: ore,
    tipOre: ore,
    fiscalStatus: z.enum(["confirmed", "pending", "unknown", "missing"]),
  })
  .strict();
export const daySchema = z
  .object({
    id,
    date,
    status: z.enum(["open", "closed"]),
    totals: totalsSchema,
    registers: z.array(bucketSchema),
    methods: z.array(bucketSchema),
    vat: z.array(bucketSchema),
    products: z.array(productSchema),
    receipts: z.array(receiptSchema),
    hours: z.array(bucketSchema),
    coverage: z.array(z.string().max(180)).max(100),
  })
  .strict();
export type PortalDay = z.infer<typeof daySchema>;
export type Product = PortalDay["products"][number];
export type ReceiptSummary = PortalDay["receipts"][number];
export const operationsSchema = z
  .object({
    openTabs: z.array(
      z
        .object({
          id,
          number: count,
          table: z.string().max(160),
          openedAt: time,
          totalOre: ore,
          paidOre: ore,
          remainingOre: ore,
          rows: count,
          pending: count,
        })
        .strict(),
    ),
    kitchen: count,
    bar: count,
    unresolvedPayments: count,
    unresolvedFiscal: count,
    prints: z
      .object({ queued: count, failed: count, uncertain: count })
      .strict(),
    backup: z.object({ lastAt: time.nullable(), failed: z.boolean() }).strict(),
    devices: z.array(
      z
        .object({
          id,
          name: z.string().max(160),
          active: z.boolean(),
          connections: count.nullable(),
          lastSeenAt: time.nullable(),
        })
        .strict(),
    ),
    runtimeAt: time.nullable(),
  })
  .strict();
export type Operations = z.infer<typeof operationsSchema>;
export const cursorSchema = z.object({ sequence: count, hash }).strict();
export type Cursor = z.infer<typeof cursorSchema>;
export const initialCursor = (): Cursor => ({
  sequence: 0,
  hash: "0".repeat(64),
});
export const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    installationId: z.string().uuid(),
    mode: z.literal("training"),
    restaurantName: z.string().min(1).max(160),
    generatedAt: time,
    cursor: cursorSchema,
    previous: cursorSchema,
    days: z.array(daySchema),
    operations: operationsSchema,
    registers: z.array(z.object({ id, name: z.string().max(160) }).strict()),
  })
  .strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export const deliverySchema = snapshotSchema
  .omit({ days: true })
  .extend({
    days: z.array(daySchema).max(10),
    batchId: z.string().uuid(),
    part: count,
    parts: z.number().int().min(1).max(10000),
  })
  .strict()
  .refine((value) => value.part < value.parts, "Ogiltig leveransdel.");
export type Delivery = z.infer<typeof deliverySchema>;
export const querySchema = z
  .object({ from: date, to: date, registerId: id.optional() })
  .strict()
  .refine((value) => {
    const span = Date.parse(value.to) - Date.parse(value.from);
    return span >= 0 && span <= 365 * 86400000;
  }, "Välj ett datumintervall på högst ett år.");
export type AnalyticsQuery = z.infer<typeof querySchema>;
