import { afterEach, describe, it, expect } from "vitest";
import { fixture, key } from "./helpers";
import { applyManagement, managementSnapshot } from "../server/backoffice";
import { promotionAvailable } from "../server/promotions-stock";
import type {
  ManagementCommand,
  ManagementKind,
  Promotion,
  Stock,
  StockMovement,
} from "../shared/backoffice";
import type { MenuItem, Receipt } from "../shared/types";
import { replica, provision, ingest } from "../portal/local/replica";
import {
  queueCommand,
  exchange,
  managementData,
} from "../portal/local/management";
import { SourceReader } from "../portal/sync/project";
import { deliveries, SyncWorker } from "../portal/sync/worker";
import { projectArchive } from "../portal/sync/archive";
import { createApp } from "../server/app";
import Fastify from "fastify";
import path from "node:path";
const actorId = key();
function edit(
  f: ReturnType<typeof fixture>,
  kind: ManagementKind,
  target: string,
  value: Record<string, unknown>,
  baseVersion: string | null = null,
) {
  const command: ManagementCommand = {
    id: key(),
    kind,
    target,
    value,
    baseVersion,
  };
  return {
    command,
    run: () => applyManagement(f.service, { command, actorId }),
  };
}
function promotion(id = key()): Promotion {
  return {
    id,
    name: "After work",
    active: true,
    code: "AW2026",
    discountBps: 1500,
    from: "2026-10-01",
    until: "2026-10-31",
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    startTime: "00:00",
    endTime: "23:59",
    maxUses: 2,
  };
}
describe("Adminändringar i den riktiga kassalogiken", () => {
  it("ändrar produkter idempotent, avvisar gammal version och bevarar redan beställda priser", () => {
    const f = fixture();
    f.open();
    const tab = f.tab();
    f.command(tab.id, { action: "add", itemId: "bread" });
    const p = managementSnapshot(f.service).products.find(
        (p) => p.id === "bread",
      )!,
      old = f.service.tab(tab.id).lines[0];
    const edit1 = edit(
      f,
      "product",
      p.id,
      { ...p.value, name: "Nytt bröd", priceOre: old.unitPriceOre + 1200 },
      p.version,
    );
    expect(edit1.run().status).toBe("applied");
    const journal = f.store.journal().length;
    expect(edit1.run().status).toBe("applied");
    expect(f.store.journal()).toHaveLength(journal);
    expect(f.service.tab(tab.id).lines[0]).toEqual(old);
    expect(
      edit(f, "product", p.id, { ...p.value, priceOre: 100 }, p.version).run()
        .status,
    ).toBe("conflict");
    expect(() =>
      applyManagement(f.service, {
        actorId,
        command: {
          ...edit1.command,
          value: { ...p.value, name: "Changed retry" },
        },
      }),
    ).toThrow();
  });
  it("byter kategorinamn i katalogen, hanterar globala grupper och ändrar aldrig orderhistorik", () => {
    const f = fixture();
    f.open();
    const tab = f.tab();
    f.command(tab.id, { action: "add", itemId: "bread" });
    const old = f.service.tab(tab.id).lines[0],
      s = managementSnapshot(f.service),
      category = s.categories.find(
        (c) =>
          c.value.name ===
          f.service.menu().find((m) => m.id === "bread")!.category,
      )!;
    const globalId = key();
    expect(
      edit(f, "global-category", globalId, { name: "Mat", position: 1 }).run()
        .status,
    ).toBe("applied");
    expect(
      edit(
        f,
        "category",
        category.id,
        { ...category.value, name: "Smårätter", globalId },
        category.version,
      ).run().status,
    ).toBe("applied");
    expect(f.service.menu().find((m) => m.id === "bread")!.category).toBe(
      "Smårätter",
    );
    expect(f.service.tab(tab.id).lines[0]).toEqual(old);
    const group = managementSnapshot(f.service).modifiers[0];
    expect(group).toBeDefined();
    expect(
      edit(
        f,
        "modifier",
        group.id,
        { ...group.value, name: "Tillval nytt namn" },
        group.version,
      ).run().status,
    ).toBe("applied");
    expect(
      f.service
        .menu()
        .flatMap((m) => m.modifiers)
        .filter((m) => m.id === group.id)
        .every((m) => m.name === "Tillval nytt namn"),
    ).toBe(true);
  });
  it("skyddar sista administratören, skapar inaktiva konton och behåller enhetens parning", () => {
    const f = fixture(),
      s = managementSnapshot(f.service),
      a = s.staff.find((a) => a.id === "admin")!;
    expect(
      edit(f, "staff", "admin", { ...a.value, active: false }, a.version).run()
        .status,
    ).toBe("rejected");
    expect(
      edit(f, "staff", key(), {
        name: "Ny kollega",
        active: true,
        role: "waiter",
      }).run().status,
    ).toBe("rejected");
    expect(
      edit(f, "staff", key(), {
        name: "Ny kollega",
        active: false,
        role: "waiter",
      }).run().status,
    ).toBe("applied");
    const device = s.devices[0],
      before = f.store.get<{ codeHash: string }>("device", device.id)!.codeHash;
    expect(
      edit(
        f,
        "device",
        device.id,
        {
          name: "Huvudkassan",
          kind: device.value.kind,
          station: device.value.station,
          active: true,
        },
        device.version,
      ).run().status,
    ).toBe("applied");
    expect(
      f.store.get<{ codeHash: string }>("device", device.id)!.codeHash,
    ).toBe(before);
    expect(JSON.stringify(managementSnapshot(f.service))).not.toMatch(
      /pinHash|codeHash|token_hash|"pin"/,
    );
  });
  it("begränsar kuponger, stoppar stapling och låser rabatt efter delbetalning", async () => {
    const f = fixture();
    f.open();
    const offer = promotion();
    expect(edit(f, "coupon", offer.id, { ...offer }).run().status).toBe(
      "applied",
    );
    const t1 = f.tab(null),
      t2 = f.tab(null),
      t3 = f.tab(null);
    for (const t of [t1, t2, t3])
      f.command(t.id, { action: "add", itemId: "bread" });
    f.command(t1.id, { action: "promotion", couponCode: "aw2026" });
    f.command(t2.id, { action: "promotion", couponCode: "AW2026" });
    expect(() =>
      f.command(t3.id, { action: "promotion", couponCode: "AW2026" }),
    ).toThrow("gräns");
    f.command(t2.id, {
      action: "discount",
      discountBps: 500,
      reason: "Personalrabatt",
    });
    expect(() =>
      f.command(t2.id, { action: "promotion", couponCode: "AW2026" }),
    ).toThrow("manuella");
    f.command(t3.id, { action: "promotion", couponCode: "AW2026" });
    f.command(t1.id, { action: "send" });
    await f.pay(t1.id, { amountOre: 1000 });
    expect(() =>
      f.command(t1.id, { action: "promotion", couponCode: "AW2026" }),
    ).toThrow("Betalningen");
    await f.pay(t1.id);
    expect(f.service.tab(t1.id).discountBps).toBe(1500);
    const receipts = f.store.all<Receipt>("receipt");
    expect(receipts).toHaveLength(2);
    expect(receipts.reduce((s, r) => s + r.payment.amountOre, 0)).toBe(
      Math.round(
        f.service.menu().find((m) => m.id === "bread")!.priceOre * 0.85,
      ),
    );
  });
  it("respekterar svensk tid, giltighetsdagar och avstängda kampanjer", () => {
    const p = {
      ...promotion(),
      weekdays: [6],
      startTime: "16:00",
      endTime: "19:00",
    };
    expect(promotionAvailable(p, "2026-10-17T14:00:00Z")).toBe(true);
    expect(promotionAvailable(p, "2026-10-17T13:59:00Z")).toBe(false);
    expect(promotionAvailable(p, "2026-10-18T14:00:00Z")).toBe(false);
    expect(
      promotionAvailable({ ...p, active: false }, "2026-10-17T14:00:00Z"),
    ).toBe(false);
  });
  it("räknar av lager en gång vid skickad beställning och låser en inaktuell inventering", async () => {
    const f = fixture();
    f.open();
    const row = managementSnapshot(f.service).stock.find(
      (s) => s.id === "bread",
    )!;
    expect(
      edit(
        f,
        "stock",
        "bread",
        {
          tracked: true,
          minimum: 3,
          operation: "count",
          quantity: 10,
          reason: "Startinventering",
        },
        row.version,
      ).run().status,
    ).toBe("applied");
    const stale = managementSnapshot(f.service).stock.find(
        (s) => s.id === "bread",
      )!,
      t = f.tab();
    f.command(t.id, { action: "add", itemId: "bread", quantity: 2 });
    expect(f.store.get<Stock>("backoffice-stock", "bread")!.quantity).toBe(10);
    const command = {
      key: key(),
      version: f.service.tab(t.id).version,
      action: "send" as const,
    };
    f.service.updateTab(f.admin, t.id, command);
    f.service.updateTab(f.admin, t.id, command);
    expect(f.store.get<Stock>("backoffice-stock", "bread")!.quantity).toBe(8);
    await f.pay(t.id, { amountOre: 1000 });
    const last = await f.pay(t.id);
    await f.service.refund(f.admin, last.id, {
      key: key(),
      amountOre: 500,
      reason: "Returprov",
      simulation: "approved",
      fiscalSimulation: "confirmed",
    });
    expect(f.store.get<Stock>("backoffice-stock", "bread")!.quantity).toBe(8);
    expect(
      edit(
        f,
        "stock",
        "bread",
        {
          tracked: true,
          minimum: 3,
          operation: "count",
          quantity: 12,
          reason: "Gammal inventering",
        },
        stale.version,
      ).run().status,
    ).toBe("conflict");
    expect(
      f.store
        .all<StockMovement>("stock-movement")
        .filter((m) => m.kind === "order"),
    ).toHaveLength(1);
  });
  it("återger betalda notor, returer och sparade rapporter utan nya rapporthändelser", async () => {
    const f = fixture();
    const day = f.open(),
      t = f.tab();
    f.command(t.id, {
      action: "add",
      itemId: "bread",
      notes: "HEMLIG PRIVAT ANTECKNING",
    });
    f.command(t.id, { action: "send" });
    await f.pay(t.id);
    f.service.takeReport(f.admin, day.id);
    const count = f.store.journal().length;
    const result = projectArchive(day, f.store.journal());
    expect(result.orders[0].status).toBe("paid");
    expect(result.reports.some((r) => r.kind === "X")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("HEMLIG");
    expect(f.store.journal()).toHaveLength(count);
  });
});
describe("Adminbehörigheter och leveranssäkerhet", () => {
  it("kräver rätt restaurang, skrivroll och tvåsteg; återkallad författare får inga kommandon utförda", async () => {
    const db = await replica();
    const restaurant = key(),
      installation = key(),
      user = key(),
      token = "sync-".padEnd(40, "x");
    try {
      await provision(db, restaurant, installation, token, user);
      const body = {
        id: key(),
        kind: "category",
        target: key(),
        baseVersion: null,
        value: { name: "Test", position: 0, globalId: null },
      };
      await db.query(
        "update portal_members set role='viewer' where user_id=$1",
        [user],
      );
      await expect(queueCommand(db, installation, user, body)).rejects.toThrow(
        "UNAUTHORIZED",
      );
      await db.query(
        "update portal_members set role='editor' where user_id=$1",
        [user],
      );
      await queueCommand(db, installation, user, body);
      await expect(
        queueCommand(db, installation, user, {
          ...body,
          id: key(),
          kind: "staff",
        }),
      ).rejects.toThrow("OWNER_REQUIRED");
      await expect(
        queueCommand(db, key(), user, { ...body, id: key() }),
      ).rejects.toThrow("UNAUTHORIZED");
      await db.exec("set role authenticated");
      await db.query("select set_config('request.jwt.claims',$1,false)", [
        JSON.stringify({ sub: user, aal: "aal1" }),
      ]);
      expect(
        (await db.query("select * from portal_commands")).rows,
      ).toHaveLength(0);
      await expect(
        db.query("select portal_queue_command($1,$2::jsonb)", [
          installation,
          JSON.stringify({ ...body, id: key() }),
        ]),
      ).rejects.toThrow("UNAUTHORIZED");
      await db.exec("reset role");
      expect(await exchange(db, installation, token, null, [])).toHaveLength(1);
      await db.query(
        "update portal_members set active=false where user_id=$1",
        [user],
      );
      expect(await exchange(db, installation, token, null, [])).toHaveLength(0);
      expect((await managementData(db, installation)).commands[0].status).toBe(
        "rejected",
      );
      await db.query(
        "update portal_installations set revoked_at=now() where id=$1",
        [installation],
      );
      await expect(exchange(db, installation, token, null, [])).rejects.toThrow(
        "UNAUTHORIZED",
      );
    } finally {
      await db.close();
    }
  }, 30000);
  it("återför samma sparade resultat efter tappad bekräftelse och omstart", async () => {
    const f = fixture({}, true),
      db = await replica(),
      restaurant = key(),
      installation = key(),
      user = key(),
      token = "sync-".padEnd(40, "y"),
      runtimeToken = "runtime".padEnd(40, "z");
    const old = process.env.ADMIN_RUNTIME_TOKEN;
    process.env.ADMIN_RUNTIME_TOKEN = runtimeToken;
    const pos = await createApp({
      database: path.join(f.directory, "bridge.sqlite"),
    });
    if (old === undefined) delete process.env.ADMIN_RUNTIME_TOKEN;
    else process.env.ADMIN_RUNTIME_TOKEN = old;
    const receiver = Fastify();
    let rejectAck = true;
    try {
      await provision(db, restaurant, installation, token, user);
      await pos.app.listen({ host: "127.0.0.1", port: 0 });
      const runtime = `http://127.0.0.1:${(pos.app.server.address() as { port: number }).port}/api/v1/admin-sync/runtime`;
      receiver.post("/ingest", (req) => ingest(db, req.body, token));
      receiver.post("/management-exchange", async (req) => {
        const b = req.body as { snapshot: any; results: any[] };
        if (b.results.length && rejectAck) {
          rejectAck = false;
          throw new Error("Simulerat avbrott");
        }
        return exchange(db, installation, token, b.snapshot, b.results);
      });
      await receiver.listen({ host: "127.0.0.1", port: 0 });
      const config = {
        database: pos.store.filename,
        stateDir: path.join(f.directory, "sync"),
        installationId: installation,
        token,
        endpoint: `http://127.0.0.1:${(receiver.server.address() as { port: number }).port}/ingest`,
        runtimeUrl: runtime,
        runtimeToken,
      };
      let worker = new SyncWorker(config);
      await worker.once();
      const target = key();
      await queueCommand(db, installation, user, {
        id: key(),
        kind: "global-category",
        target,
        baseVersion: null,
        value: { name: "Mat", position: 0 },
      });
      await worker.once();
      worker.close();
      const changes = () =>
        pos.store.journal().filter((e) => e.action === "admin.change").length;
      expect(changes()).toBe(1);
      expect((await managementData(db, installation)).commands[0].status).toBe(
        "queued",
      );
      worker = new SyncWorker(config);
      await worker.once();
      worker.close();
      expect(changes()).toBe(1);
      expect((await managementData(db, installation)).commands[0].status).toBe(
        "applied",
      );
      expect(
        (
          await pos.app.inject({
            url: "/api/v1/admin-sync/management",
            headers: { authorization: "Bearer wrong" },
          })
        ).statusCode,
      ).toBe(403);
      const before = changes();
      const bad = await pos.app.inject({
        url: "/api/v1/admin-sync/commands",
        method: "POST",
        headers: { authorization: `Bearer ${runtimeToken}` },
        payload: {
          source: "wrong",
          actorId: user,
          command: {
            id: key(),
            kind: "category",
            target: key(),
            baseVersion: null,
            value: {},
          },
        },
      });
      expect(bad.statusCode).toBe(400);
      expect(changes()).toBe(before);
    } finally {
      await receiver.close();
      await pos.app.close();
      await db.close();
    }
  }, 30000);
});
