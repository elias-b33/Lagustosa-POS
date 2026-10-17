import { z } from "zod";
import type {
  MenuItem,
  Settings,
  Staff,
  Device,
  PrinterProfile,
  DiningTable,
  ModifierGroup,
} from "./types.ts";

const id = z.string().min(1).max(100),
  name = z.string().trim().min(1).max(100);
export {
  managementKinds,
  managementCommandSchema,
  type ManagementKind,
  type ManagementCommand,
} from "./backoffice-command";
import type { ManagementKind, ManagementCommand } from "./backoffice-command";
export interface CommandEnvelope {
  command: ManagementCommand;
  actorId: string;
}
export interface CommandResult {
  id: string;
  status: "applied" | "conflict" | "rejected";
  message: string;
  at: string;
}
export interface QueuedCommand extends CommandEnvelope {
  status: "queued" | "applied" | "conflict" | "rejected";
  createdAt: string;
  result: CommandResult | null;
}
export interface Versioned<T> {
  id: string;
  version: string;
  value: T;
}
export const categorySchema = z
  .object({
    id,
    name,
    position: z.number().int().min(0).max(100000),
    globalId: id.nullable(),
  })
  .strict();
export const globalCategorySchema = z
  .object({ id, name, position: z.number().int().min(0).max(100000) })
  .strict();
const realDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const d = new Date(value + "T12:00:00Z");
    return Number.isFinite(d.getTime()) && d.toISOString().startsWith(value);
  });
export const promotionSchema = z
  .object({
    id,
    name,
    active: z.boolean(),
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{3,32}$/)
      .nullable(),
    discountBps: z.number().int().min(1).max(10000),
    from: realDate,
    until: realDate,
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    maxUses: z.number().int().min(1).max(1000000).nullable(),
  })
  .strict()
  .refine(
    (value) => value.from <= value.until && value.startTime < value.endTime,
    "Kontrollera giltighetstid och klockslag.",
  );
export type Category = z.infer<typeof categorySchema>;
export type GlobalCategory = z.infer<typeof globalCategorySchema>;
export type Promotion = z.infer<typeof promotionSchema>;
export interface Stock {
  id: string;
  tracked: boolean;
  quantity: number;
  minimum: number;
}
export const stockCommandSchema = z
  .object({
    id,
    tracked: z.boolean(),
    minimum: z.number().int().min(0).max(1000000),
    operation: z.enum(["configure", "delivery", "waste", "count"]),
    quantity: z.number().int().min(0).max(1000000),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();
export interface StockMovement {
  id: string;
  itemId: string;
  at: string;
  kind: "delivery" | "waste" | "count" | "order";
  delta: number;
  balance: number;
  reference: string;
}
export interface ManagementSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  sequence: number;
  restaurant: Versioned<Settings>;
  products: Versioned<MenuItem>[];
  categories: Versioned<Category>[];
  globalCategories: Versioned<GlobalCategory>[];
  modifiers: Versioned<ModifierGroup>[];
  coupons: (Versioned<Promotion> & { used: number })[];
  campaigns: (Versioned<Promotion> & { used: number })[];
  stock: Versioned<Stock>[];
  movements: StockMovement[];
  staff: Versioned<Staff>[];
  devices: Versioned<Device>[];
  printers: Versioned<PrinterProfile>[];
  tables: Versioned<DiningTable>[];
  events: { id: number; at: string; action: string; entityId: string }[];
}
export interface ManagementData {
  snapshot: ManagementSnapshot | null;
  commands: QueuedCommand[];
  canManage: boolean;
  role: "owner" | "editor" | "viewer";
  connected: boolean;
}
