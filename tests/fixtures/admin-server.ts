import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../server/db";
import { KassaService } from "../../server/service";
import type { Ticket } from "../../shared/types";
const directory = process.env.ADMIN_LOCAL_DIR!;
mkdirSync(directory, { recursive: true });
const database = path.join(directory, "source.sqlite"),
  store = new Store(database);
let now = new Date("2026-10-15T16:00:00Z");
const service = new KassaService(store, {
  now: () => now,
  backupDir: path.join(directory, "backups"),
});
const actor = service.login(
  "admin",
  "1234",
  "LAGUSTOSA-TEST",
  "127.0.0.1",
).actor;
for (let d = 0; d < 3; d++) {
  now = new Date(`2026-10-${15 + d}T16:00:00Z`);
  const day = service.openDay(actor, { key: randomUUID(), floatOre: 0 });
  for (let i = 0; i < 4 + d; i++) {
    const tab = service.createTab(actor, {
      key: randomUUID(),
      tableId: null,
      guestCount: 2,
      serviceMode: "dine_in",
    });
    for (const itemId of ["bread", "margherita", "redwine"])
      service.updateTab(actor, tab.id, {
        key: randomUUID(),
        version: service.tab(tab.id).version,
        action: "add",
        itemId,
        quantity: (i % 2) + 1,
      });
    service.updateTab(actor, tab.id, {
      key: randomUUID(),
      version: service.tab(tab.id).version,
      action: "send",
    });
    service.updateTab(actor, tab.id, {
      key: randomUUID(),
      version: service.tab(tab.id).version,
      action: "fire",
    });
    if (d !== 2 || i < 4)
      await service.startPayment(actor, tab.id, {
        key: randomUUID(),
        version: service.tab(tab.id).version,
        method: i % 2 ? "swish" : "card",
        swishVerified: true,
        tipOre: 500,
        simulation: "approved",
        fiscalSimulation: "confirmed",
      });
    now = new Date(now.getTime() + 900000);
  }
  if (d < 2) {
    for (const ticket of store
      .all<Ticket>("ticket")
      .filter((ticket) => ticket.status !== "served"))
      for (const status of ["started", "ready", "served"] as const)
        service.updateTicket(actor, ticket.id, status);
    service.closeDay(actor, day.id, { key: randomUUID(), countedCashOre: 0 });
  }
}
store.close();
process.env.ADMIN_SOURCE_DB = database;
await import("../../portal/local/server");
