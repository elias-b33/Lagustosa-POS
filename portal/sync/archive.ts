import type {
  AuditEntry,
  BusinessDay,
  Tab,
  DayReport,
  Receipt,
} from "../../shared/types";
import type { RegisterReport } from "../../shared/register-reports";
import { calculateTab } from "../../shared/money";
import type {
  OrderSummary,
  SavedReport,
  EventSummary,
} from "../shared/archive-model";
export function projectArchive(day: BusinessDay, journal: AuditEntry[]) {
  const tabs = new Map<string, Tab>(),
    reports: SavedReport[] = [],
    events: EventSummary[] = [];
  for (const event of journal) {
    const d = event.details as {
      tab?: Tab;
      receipt?: Receipt;
      day?: BusinessDay;
      dayId?: string;
      report?: DayReport | RegisterReport;
      registerId?: string;
      payment?: { dayId: string };
    };
    if (d.tab?.dayId === day.id) tabs.set(d.tab.id, d.tab);
    if (d.receipt?.dayId === day.id) tabs.set(d.receipt.tab.id, d.receipt.tab);
    if (
      d.tab?.dayId !== day.id &&
      d.day?.id !== day.id &&
      d.dayId !== day.id &&
      d.payment?.dayId !== day.id &&
      d.receipt?.dayId !== day.id &&
      event.entityId !== day.id
    )
      continue;
    events.push({
      id: event.id,
      at: event.at,
      action: event.action,
      entityId: event.entityId,
      registerId: d.registerId ?? null,
    });
    if (
      ["report.x", "report.register_x", "report.register_z"].includes(
        event.action,
      ) &&
      d.report
    ) {
      const r = d.report;
      if ("scope" in r) {
        const t = r.training;
        reports.push({
          id: "event-" + event.id,
          kind: r.kind,
          at: r.generatedAt,
          sequence: r.sequence,
          registerId: r.registerId,
          salesOre: t.salesOre,
          refundsOre: t.refundsOre,
          netOre: t.netOre,
          vatOre: t.vat.reduce((s, v) => s + v.netVatOre, 0),
          tipsOre: t.tipsOre,
          receipts: t.receiptCounts.total,
          expectedCashOre: t.expectedCashOre,
          differenceOre: null,
          methods: t.methods,
          vat: t.vat.map((v) => ({
            rateBps: v.vatBps,
            grossOre: v.netGrossOre,
            vatOre: v.netVatOre,
          })),
        });
      } else reports.push(summary("event-" + event.id, "X", event.at, r));
    }
  }
  if (day.report && day.closedAt)
    reports.push(summary("day-" + day.id, "Z", day.closedAt, day.report));
  const orders: OrderSummary[] = [...tabs.values()].map((tab) => ({
    id: tab.id,
    number: tab.number,
    table: tab.tableId ? tab.label : "Disknota",
    status: tab.status,
    openedAt: tab.openedAt,
    updatedAt: tab.updatedAt,
    guestCount: tab.guestCount,
    totalOre: calculateTab(tab).grossOre,
    paidOre: 0,
    lines: tab.lines.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      unitPriceOre: line.unitPriceOre,
      vatBps: line.vatBps,
      status: line.status,
    })),
  }));
  return { orders, reports, events };
}
function summary(
  id: string,
  kind: "X" | "Z",
  at: string,
  r: DayReport,
): SavedReport {
  return {
    id,
    kind,
    at,
    sequence: r.training?.sequence ?? null,
    registerId: null,
    salesOre: r.salesOre,
    refundsOre: r.refundsOre,
    netOre: r.netOre,
    vatOre: r.vatOre,
    tipsOre: r.tipsOre,
    receipts: r.receipts,
    expectedCashOre: r.expectedCashOre,
    differenceOre: r.differenceOre,
    methods: r.methods,
    vat: r.vat.map((v) => ({
      rateBps: v.vatBps,
      grossOre: v.grossOre,
      vatOre: v.vatOre,
    })),
  };
}
