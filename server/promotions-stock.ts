import { randomUUID } from "node:crypto";
import { demand } from "./errors";
import type { Store } from "./db";
import type { Tab } from "../shared/types";
import type { Promotion, Stock, StockMovement } from "../shared/backoffice";

export function promotionAvailable(p: Promotion, at: string) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));
  const date = parts.slice(0, 10),
    time = parts.slice(11, 16),
    weekday = new Date(date + "T12:00:00Z").getUTCDay() || 7;
  return (
    p.active &&
    date >= p.from &&
    date <= p.until &&
    p.weekdays.includes(weekday) &&
    time >= p.startTime &&
    time <= p.endTime
  );
}
export function promotionUsage(store: Store, id: string, exclude?: string) {
  return store
    .all<Tab>("tab")
    .filter(
      (tab) =>
        tab.id !== exclude && tab.promotion?.id === id && tab.status !== "void",
    ).length;
}
export function applyPromotion(
  store: Store,
  tab: Tab,
  input: { promotionId?: string; couponCode?: string },
  at: string,
) {
  const kind = input.couponCode ? "coupon" : "campaign";
  const p = store
    .all<Promotion>("backoffice-" + kind)
    .find((row) =>
      kind === "coupon"
        ? row.code?.toUpperCase() === input.couponCode?.trim().toUpperCase()
        : row.id === input.promotionId,
    );
  demand(
    p && promotionAvailable(p, at),
    "Erbjudandet finns inte eller gäller inte just nu.",
    409,
    "PROMOTION_UNAVAILABLE",
  );
  demand(
    p.maxUses === null || promotionUsage(store, p.id, tab.id) < p.maxUses,
    "Erbjudandets användningsgräns är nådd.",
    409,
    "PROMOTION_LIMIT",
  );
  demand(
    tab.discountBps === 0 || tab.promotion,
    "Ta bort den manuella rabatten innan erbjudandet används.",
    409,
    "PROMOTION_STACK",
  );
  tab.discountBps = p.discountBps;
  tab.discountReason = `${kind === "coupon" ? "Kupong" : "Kampanj"}: ${p.name}`;
  tab.promotion = { id: p.id, name: p.name, kind, discountBps: p.discountBps };
}
/** Physical stock leaves storage when an order is sent. Payment retries/returns never deduct it again. */
export function consumeSentStock(
  store: Store,
  before: Tab,
  after: Tab,
  at: string,
  actor: string,
) {
  for (const line of after.lines) {
    const previous = before.lines.find((row) => row.id === line.id);
    if (
      line.status !== "sent" ||
      !previous ||
      !["draft", "held"].includes(previous.status)
    )
      continue;
    const stock = store.get<Stock>("backoffice-stock", line.itemId);
    if (!stock?.tracked) continue;
    const id = `order:${after.id}:${line.id}`;
    if (store.get("stock-movement", id)) continue;
    stock.quantity -= line.quantity;
    demand(Number.isSafeInteger(stock.quantity), "Lagervärdet är för stort.");
    const movement: StockMovement = {
      id,
      itemId: line.itemId,
      at,
      kind: "order",
      delta: -line.quantity,
      balance: stock.quantity,
      reference: `Nota ${after.number}`,
    };
    store.put("backoffice-stock", stock);
    store.put("stock-movement", movement);
    store.audit(actor, "stock.order", line.itemId, { movement }, at);
  }
}
