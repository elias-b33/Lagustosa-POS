import Database from "better-sqlite3";
import { projectArchive } from "./archive";
import type {
  AuditEntry,
  BusinessDay,
  Device,
  DiningTable,
  Payment,
  Receipt,
  Settings,
  Tab,
  Ticket,
  PrintJob,
  DeviceConnection,
} from "../../shared/types";
import { calculateTab } from "../../shared/money";
import { allocationQuantity, addQuantities } from "../../shared/allocations";
import { registerLedgerSnapshot } from "../../server/register-reporting";
import {
  addTotals,
  initialCursor,
  snapshotSchema,
  zeroTotals,
  type Cursor,
  type Operations,
  type PortalDay,
  type Product,
  type Snapshot,
  type Totals,
} from "../shared/model";

export interface RuntimeStatus {
  at: string;
  devices: DeviceConnection[];
}
const quantity = () => ({ numerator: "0", denominator: "1" });
const legacy = "legacy-unassigned";
const issue = (day: PortalDay, value: string) => {
  if (!day.coverage.includes(value)) day.coverage.push(value);
};
function totalsFor(payment: Payment): Totals {
  const sale = payment.kind === "sale";
  return {
    ...zeroTotals(),
    [sale ? "salesOre" : "refundsOre"]: payment.amountOre,
    [sale ? "salesVatOre" : "refundsVatOre"]: payment.allocations.reduce(
      (sum, row) => sum + row.vatOre,
      0,
    ),
    tipsOre: sale ? payment.tipOre : 0,
    discountsOre: sale
      ? payment.allocations.reduce(
          (sum, row) => sum + (row.discountOre ?? 0),
          0,
        )
      : 0,
    salesCount: sale ? 1 : 0,
    refundsCount: sale ? 0 : 1,
  };
}
function bucket(
  day: PortalDay,
  field: "registers" | "methods" | "vat" | "hours",
  key: string,
  registerId: string,
  value: Totals,
) {
  let row = day[field].find(
    (candidate) => candidate.key === key && candidate.registerId === registerId,
  );
  if (!row) {
    row = { key, registerId, totals: zeroTotals() };
    day[field].push(row);
  }
  addTotals(row.totals, value);
}
export function projectDay(day: BusinessDay, journal: AuditEntry[]): PortalDay {
  const ledger = registerLedgerSnapshot({ day, journal });
  const result: PortalDay = {
    ...projectArchive(day, journal),
    id: day.id,
    date: day.date,
    status: day.status,
    totals: zeroTotals(),
    registers: [],
    methods: [],
    vat: [],
    hours: [],
    products: [],
    receipts: [],
    coverage: [],
  };
  const receipts = new Map(
    [...ledger.receipts.values()].map((value) => [
      value.receipt.paymentId,
      value.receipt,
    ]),
  );
  const products = new Map<string, Product>();
  for (const { payment, at } of ledger.payments.values()) {
    if (
      payment.status !== "approved" ||
      payment.dayId !== day.id ||
      at <= ledger.from
    )
      continue;
    const receipt = receipts.get(payment.id);
    const registerId = payment.registerId ?? receipt?.registerId ?? legacy;
    const totals = totalsFor(payment);
    addTotals(result.totals, totals);
    bucket(result, "registers", registerId, registerId, totals);
    bucket(result, "methods", payment.method, registerId, totals);
    const timestamp = receipt?.createdAt ?? payment.updatedAt;
    bucket(
      result,
      "hours",
      new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Stockholm",
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date(timestamp)),
      registerId,
      totals,
    );
    if (!receipt) issue(result, "Ett godkänt belopp saknar kvittounderlag.");
    if (registerId === legacy)
      issue(result, "Historisk kassaidentitet saknas för vissa belopp.");
    result.receipts.push({
      id: receipt?.id ?? payment.id,
      number: receipt?.number ?? null,
      tabNumber: receipt?.tab.number ?? null,
      registerId,
      at: timestamp,
      kind: payment.kind,
      method: payment.method,
      amountOre: payment.amountOre,
      vatOre: payment.allocations.reduce((sum, row) => sum + row.vatOre, 0),
      tipOre: payment.tipOre,
      fiscalStatus: receipt
        ? (ledger.fiscal.get(receipt.id) ?? receipt.fiscalStatus)
        : "missing",
    });
    const sale = payment.kind === "sale";
    for (const allocation of payment.allocations) {
      const line = receipt?.tab.lines.find(
        (candidate) => candidate.id === allocation.lineId,
      );
      const value: Totals = {
        ...zeroTotals(),
        [sale ? "salesOre" : "refundsOre"]: allocation.grossOre,
        [sale ? "salesVatOre" : "refundsVatOre"]: allocation.vatOre,
        discountsOre: sale ? (allocation.discountOre ?? 0) : 0,
      };
      bucket(result, "vat", String(allocation.vatBps), registerId, value);
      const itemId = line?.itemId ?? "unknown",
        name = line?.name ?? "Historisk artikel saknas",
        category = line?.category ?? "Historisk kategori saknas";
      const key = JSON.stringify([registerId, itemId, name, category]);
      let product = products.get(key);
      if (!product) {
        product = {
          itemId,
          name,
          category,
          registerId,
          totals: zeroTotals(),
          sold: quantity(),
          refunded: quantity(),
          unknownQuantity: 0,
        };
        products.set(key, product);
      }
      addTotals(product.totals, value);
      const q = allocationQuantity(allocation);
      if (q && allocation.quantityBasis === "items")
        product[sale ? "sold" : "refunded"] = addQuantities(
          product[sale ? "sold" : "refunded"],
          q,
        );
      else {
        product.unknownQuantity++;
        issue(result, "Vissa artikelantal saknas eller är beloppsandelar.");
      }
      if (!line?.category)
        issue(result, "Vissa historiska artikelgrupper saknas.");
      if (sale && allocation.discountOre === undefined)
        issue(
          result,
          "Rabattunderlaget är ofullständigt för äldre försäljningar.",
        );
    }
  }
  result.products = [...products.values()];
  if (day.status === "closed" && day.report) {
    const saved = day.report;
    if (
      result.totals.salesOre !== saved.salesOre ||
      result.totals.refundsOre !== saved.refundsOre ||
      result.totals.salesVatOre - result.totals.refundsVatOre !==
        saved.vatOre ||
      result.totals.tipsOre !== saved.tipsOre ||
      result.totals.salesCount !== saved.receipts
    ) {
      issue(
        result,
        "Detaljunderlaget avviker från sparat dagsavslut; totalsumman följer dagsavslutet.",
      );
      // Keep the stored total authoritative; retain detailed rows with an explicit coverage warning.
      result.totals = {
        ...result.totals,
        salesOre: saved.salesOre,
        refundsOre: saved.refundsOre,
        tipsOre: saved.tipsOre,
        salesCount: saved.receipts,
        salesVatOre: saved.vatOre + result.totals.refundsVatOre,
      };
    }
    if (saved.training)
      result.totals.discountsOre = saved.training.discountsOre;
    for (const report of saved.registers ?? []) {
      const id = report.registerId ?? report.legacyRegisterId ?? legacy;
      let row = result.registers.find((row) => row.registerId === id);
      if (!row) {
        row = { key: id, registerId: id, totals: zeroTotals() };
        result.registers.push(row);
      }
      row.totals = {
        salesOre: report.training.salesOre,
        refundsOre: report.training.refundsOre,
        tipsOre: report.training.tipsOre,
        discountsOre: report.training.discountsOre,
        salesCount: report.training.receiptCounts.sales,
        refundsCount: report.training.receiptCounts.refunds,
        salesVatOre: report.training.vat.reduce(
          (sum, row) => sum + row.salesVatOre,
          0,
        ),
        refundsVatOre: report.training.vat.reduce(
          (sum, row) => sum + row.refundsVatOre,
          0,
        ),
      };
    }
    if (
      !result.registers.length &&
      Object.values(result.totals).some((value) => value !== 0)
    ) {
      result.registers.push({
        key: legacy,
        registerId: legacy,
        totals: { ...result.totals },
      });
      issue(result, "Historisk kassaidentitet saknas för vissa belopp.");
    }
  }
  for (const order of result.orders ?? []) {
    order.paidOre = [...ledger.payments.values()]
      .filter(
        (row) =>
          row.payment.tabId === order.id &&
          row.payment.status === "approved" &&
          row.payment.kind === "sale",
      )
      .reduce((sum, row) => sum + row.payment.amountOre, 0);
  }
  return result;
}

/** No Store constructor: it runs schema DDL. This connection cannot mutate POS data. */
export class SourceReader {
  readonly db: Database.Database;
  private cachedDays = new Map<string, PortalDay>();
  private lastSequence = -1;
  constructor(filename: string) {
    this.db = new Database(filename, { readonly: true, fileMustExist: true });
    this.db.pragma("query_only = ON");
    this.db.pragma("busy_timeout = 1500");
  }
  close() {
    this.db.close();
  }
  capture(
    installationId: string,
    previous: Cursor = initialCursor(),
    runtime?: RuntimeStatus,
    now = new Date(),
  ): Snapshot {
    return this.db.transaction(() => {
      const rows = <T>(kind: string) =>
        (
          this.db
            .prepare("SELECT body FROM entities WHERE kind=? ORDER BY rowid")
            .all(kind) as { body: string }[]
        ).map((row) => JSON.parse(row.body) as T);
      const last = this.db
        .prepare("SELECT id,hash FROM audit ORDER BY id DESC LIMIT 1")
        .get() as { id: number; hash: string } | undefined;
      const cursor = last
        ? { sequence: last.id, hash: last.hash }
        : initialCursor();
      if (previous.sequence) {
        const anchor = this.db
          .prepare("SELECT hash FROM audit WHERE id=?")
          .get(previous.sequence) as { hash: string } | undefined;
        if (anchor?.hash !== previous.hash)
          throw new Error(
            "SOURCE_DIVERGED: Journalen avviker från senaste synkning. Gör en kontrollerad omsynkning.",
          );
      }
      const days = rows<BusinessDay>("day");
      if (cursor.sequence !== this.lastSequence) {
        const journal = (
          this.db
            .prepare(
              "SELECT id,at,actor,action,entity_id AS entityId,details,hash,previous_hash AS previousHash FROM audit ORDER BY id",
            )
            .all() as (Omit<AuditEntry, "details"> & { details: string })[]
        ).map((row) => ({ ...row, details: JSON.parse(row.details) }));
        for (const day of days)
          if (
            !this.cachedDays.has(day.id) ||
            this.cachedDays.get(day.id)!.status !== "closed"
          )
            this.cachedDays.set(day.id, projectDay(day, journal));
        this.lastSequence = cursor.sequence;
      }
      const payments = rows<Payment>("payment"),
        receipts = rows<Receipt>("receipt"),
        tables = rows<DiningTable>("table");
      const tickets = rows<Ticket>("ticket"),
        prints = rows<PrintJob>("print"),
        devices = rows<Device>("device");
      const backup = rows<{ id: string; lastAt?: string; error?: string }>(
        "meta",
      ).find((row) => row.id === "backup");
      const operations: Operations = {
        openTabs: rows<Tab>("tab")
          .filter((tab) => tab.status === "open")
          .map((tab) => {
            const paidOre = payments
              .filter(
                (payment) =>
                  payment.tabId === tab.id &&
                  payment.kind === "sale" &&
                  payment.status === "approved",
              )
              .reduce((sum, payment) => sum + payment.amountOre, 0);
            const totalOre = calculateTab(tab).grossOre;
            return {
              id: tab.id,
              number: tab.number,
              table: tab.tableId
                ? (tables.find((table) => table.id === tab.tableId)?.name ??
                  "Bord")
                : "Disknota",
              openedAt: tab.openedAt,
              totalOre,
              paidOre,
              remainingOre: totalOre - paidOre,
              rows: tab.lines.filter((line) => line.status !== "void").length,
              pending: payments.filter(
                (payment) =>
                  payment.tabId === tab.id &&
                  ["pending", "unknown"].includes(payment.status),
              ).length,
            };
          }),
        kitchen: tickets.filter(
          (ticket) =>
            ticket.station === "kitchen" && ticket.status !== "served",
        ).length,
        bar: tickets.filter(
          (ticket) => ticket.station === "bar" && ticket.status !== "served",
        ).length,
        unresolvedPayments: payments.filter((payment) =>
          ["pending", "unknown"].includes(payment.status),
        ).length,
        unresolvedFiscal: receipts.filter(
          (receipt) => receipt.fiscalStatus !== "confirmed",
        ).length,
        prints: {
          queued: prints.filter((job) =>
            ["queued", "printing"].includes(job.status),
          ).length,
          failed: prints.filter((job) => job.status === "failed").length,
          uncertain: prints.filter((job) => job.status === "uncertain").length,
        },
        backup: {
          lastAt: backup?.lastAt ?? null,
          failed: Boolean(backup?.error),
        },
        runtimeAt: runtime?.at ?? null,
        devices: devices.map((device) => {
          const connection = runtime?.devices.find(
            (row) => row.deviceId === device.id,
          );
          return {
            id: device.id,
            name: device.name,
            active: device.active,
            connections: connection?.connections ?? null,
            lastSeenAt: connection?.lastSeenAt ?? null,
          };
        }),
      };
      const registers = rows<{ id: string; deviceId: string }>("register").map(
        (register) => ({
          id: register.id,
          name:
            devices.find((device) => device.id === register.deviceId)?.name ??
            register.id,
        }),
      );
      return snapshotSchema.parse({
        schemaVersion: 1,
        installationId,
        mode: "training",
        restaurantName:
          rows<Settings>("settings")[0]?.company.name || "Restaurangen",
        generatedAt: now.toISOString(),
        cursor,
        previous,
        days: days.map((day) => this.cachedDays.get(day.id)!),
        operations,
        registers,
      });
    })();
  }
}
