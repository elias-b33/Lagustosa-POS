import { randomUUID, randomInt } from "node:crypto";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { digest } from "./db";
import type { KassaService } from "./service";
import { demand } from "./errors";
import * as schemas from "./validation";
import type {
  Actor,
  MenuItem,
  ModifierGroup,
  Staff,
  Device,
  PrinterProfile,
  DiningTable,
} from "../shared/types";
import {
  categorySchema,
  globalCategorySchema,
  promotionSchema,
  stockCommandSchema,
  managementCommandSchema,
  type CommandEnvelope,
  type CommandResult,
  type ManagementSnapshot,
  type Versioned,
  type Category,
  type GlobalCategory,
  type Promotion,
  type Stock,
  type StockMovement,
  type ManagementKind,
} from "../shared/backoffice";
import { promotionUsage } from "./promotions-stock";

const version = <T>(id: string, value: T): Versioned<T> => ({
  id,
  value,
  version: digest(JSON.stringify(value)),
});
export function managementSnapshot(service: KassaService): ManagementSnapshot {
  const store = service.store;
  return store.atomic(() => {
    const menu = service.menu();
    const modifiers = store.all<ModifierGroup>("backoffice-modifier");
    for (const product of menu)
      for (const group of product.modifiers)
        if (!modifiers.some((row) => row.id === group.id))
          modifiers.push(group);
    const categories = store.all<Category>("backoffice-category");
    for (const name of new Set(menu.map((item) => item.category)))
      if (!categories.some((row) => row.name === name))
        categories.push({
          id: "category-" + digest(name).slice(0, 20),
          name,
          position: categories.length,
          globalId: null,
        });
    const list = <T extends { id: string }>(kind: string) =>
      store.all<T>(kind).map((value) => version(value.id, value));
    const promo = (kind: string) =>
      list<Promotion>("backoffice-" + kind).map((row) => ({
        ...row,
        used: promotionUsage(store, row.id),
      }));
    const stock = menu.map((item) =>
      version(
        item.id,
        store.get<Stock>("backoffice-stock", item.id) ?? {
          id: item.id,
          tracked: false,
          quantity: 0,
          minimum: 0,
        },
      ),
    );
    const events = store.journal();
    return {
      schemaVersion: 1,
      generatedAt: service.timestamp(),
      sequence: events.at(-1)?.id ?? 0,
      restaurant: version("settings", service.settings()),
      products: menu.map((row) => version(row.id, row)),
      categories: categories
        .sort(
          (a, b) =>
            a.position - b.position || a.name.localeCompare(b.name, "sv"),
        )
        .map((row) => version(row.id, row)),
      globalCategories: list<GlobalCategory>("backoffice-global-category"),
      modifiers: modifiers.map((row) => ({
        ...version(row.id, row),
        version: digest(
          JSON.stringify([
            row,
            menu.flatMap((p) =>
              p.modifiers
                .filter((m) => m.id === row.id)
                .map((m) => ({ productId: p.id, group: m })),
            ),
          ]),
        ),
      })),
      coupons: promo("coupon"),
      campaigns: promo("campaign"),
      stock,
      movements: store
        .all<StockMovement>("stock-movement")
        .slice(-500)
        .reverse(),
      staff: service.publicStaff().map((row) => version(row.id, row)),
      devices: service.publicDevices().map((row) => version(row.id, row)),
      printers: list<PrinterProfile>("printer"),
      tables: list<DiningTable>("table"),
      events: events
        .slice(-500)
        .reverse()
        .map((row) => ({
          id: row.id,
          at: row.at,
          action: row.action,
          entityId: row.entityId,
        })),
    };
  });
}
function currentVersion(
  snapshot: ManagementSnapshot,
  kind: ManagementKind,
  id: string,
) {
  if (kind === "restaurant") return snapshot.restaurant;
  const fields = {
    product: "products",
    category: "categories",
    "global-category": "globalCategories",
    modifier: "modifiers",
    coupon: "coupons",
    campaign: "campaigns",
    stock: "stock",
    staff: "staff",
    device: "devices",
    printer: "printers",
    table: "tables",
  } as const;
  return snapshot[fields[kind]].find((row) => row.id === id);
}
export function applyManagement(
  service: KassaService,
  envelope: CommandEnvelope,
): CommandResult {
  const command = managementCommandSchema.parse(envelope.command),
    actorId = z.string().uuid().parse(envelope.actorId),
    store = service.store;
  const fingerprint = digest(JSON.stringify([actorId, command]));
  return store.atomic(() => {
    const previous = store.get<{
      id: string;
      fingerprint: string;
      result: CommandResult;
    }>("backoffice-command", command.id);
    if (previous) {
      demand(
        previous.fingerprint === fingerprint,
        "Ändringsidentifieraren har redan använts.",
        409,
        "KEY_REUSED",
      );
      return previous.result;
    }
    let result: CommandResult;
    try {
      store.atomic(() => {
        const snapshot = managementSnapshot(service),
          current = currentVersion(snapshot, command.kind, command.target);
        demand(
          (current?.version ?? null) === command.baseVersion,
          "Uppgifterna har ändrats i kassan. Hämta senaste versionen innan du sparar igen.",
          409,
          "VERSION_CONFLICT",
        );
        const device = service
          .publicDevices()
          .find((row) => row.active && row.kind === "main");
        demand(device, "En aktiv huvudkassa krävs.", 409);
        const actor: Actor = {
          staff: {
            id: "portal:" + actorId,
            name: "Eleva Admin",
            role: "admin",
            active: true,
          },
          device,
        };
        const value = { ...command.value, id: command.target };
        if (command.kind === "product") {
          const item = schemas.menuSchema.parse(value);
          for (const group of item.modifiers) {
            const current = snapshot.modifiers.find((m) => m.id === group.id);
            demand(
              !current || isDeepStrictEqual(group, current.value),
              "Tillvalen har ändrats. Hämta katalogen igen.",
              409,
              "VERSION_CONFLICT",
            );
          }
          service.saveMenu(actor, item);
        } else if (command.kind === "restaurant") {
          const { id: _, ...settings } = value;
          service.saveSettings(actor, schemas.settingsSchema.parse(settings));
        } else if (command.kind === "category") {
          const category = categorySchema.parse(value);
          demand(
            !snapshot.categories.some(
              (row) =>
                row.id !== category.id &&
                row.value.name.toLocaleLowerCase("sv") ===
                  category.name.toLocaleLowerCase("sv"),
            ),
            "Kategorinamnet används redan.",
          );
          demand(
            !category.globalId ||
              snapshot.globalCategories.some(
                (row) => row.id === category.globalId,
              ),
            "Välj en befintlig global kategori.",
          );
          const old = snapshot.categories.find(
            (row) => row.id === category.id,
          )?.value;
          if (old && old.name !== category.name)
            for (const product of snapshot.products.filter(
              (row) => row.value.category === old.name,
            ))
              service.saveMenu(actor, {
                ...product.value,
                category: category.name,
              });
          store.put("backoffice-category", category);
        } else if (command.kind === "global-category") {
          const category = globalCategorySchema.parse(value);
          demand(
            !snapshot.globalCategories.some(
              (row) =>
                row.id !== category.id &&
                row.value.name.toLowerCase() === category.name.toLowerCase(),
            ),
            "Namnet används redan.",
          );
          store.put("backoffice-global-category", category);
        } else if (command.kind === "modifier") {
          const group = schemas.menuSchema.shape.modifiers.element.parse(value);
          demand(
            group.min <= group.max &&
              group.max <= group.options.length &&
              new Set(group.options.map((row) => row.id)).size ===
                group.options.length,
            "Kontrollera tillvalsgruppens gränser och alternativ.",
          );
          store.put("backoffice-modifier", group);
          for (const product of snapshot.products.filter((row) =>
            row.value.modifiers.some((item) => item.id === group.id),
          ))
            service.saveMenu(actor, {
              ...product.value,
              modifiers: product.value.modifiers.map((item) =>
                item.id === group.id ? group : item,
              ),
            });
        } else if (command.kind === "coupon" || command.kind === "campaign") {
          const promo = promotionSchema.parse(value);
          demand(
            command.kind === "coupon"
              ? Boolean(promo.code)
              : promo.code === null,
            "Kuponger kräver kod; kampanjer väljs utan kod.",
          );
          if (promo.code) {
            promo.code = promo.code.toUpperCase();
            demand(
              !snapshot.coupons.some(
                (row) => row.id !== promo.id && row.value.code === promo.code,
              ),
              "Kupongkoden används redan.",
            );
          }
          demand(
            promo.maxUses === null ||
              promo.maxUses >= promotionUsage(store, promo.id),
            "Gränsen får inte understiga redan reserverade användningar.",
          );
          store.put("backoffice-" + command.kind, promo);
        } else if (command.kind === "stock") {
          const input = stockCommandSchema.parse(value);
          demand(
            snapshot.products.some((row) => row.id === input.id),
            "Artikeln finns inte.",
          );
          const stock = store.get<Stock>("backoffice-stock", input.id) ?? {
            id: input.id,
            tracked: false,
            quantity: 0,
            minimum: 0,
          };
          const delta =
            input.operation === "delivery"
              ? input.quantity
              : input.operation === "waste"
                ? -input.quantity
                : input.operation === "count"
                  ? input.quantity - stock.quantity
                  : 0;
          stock.quantity += delta;
          stock.tracked = input.tracked;
          stock.minimum = input.minimum;
          demand(
            Number.isSafeInteger(stock.quantity) &&
              Math.abs(stock.quantity) <= 100000000,
            "Lagervärdet är för stort.",
          );
          store.put("backoffice-stock", stock);
          if (input.operation !== "configure") {
            const movement: StockMovement = {
              id: command.id,
              itemId: stock.id,
              at: service.timestamp(),
              kind: input.operation,
              delta,
              balance: stock.quantity,
              reference: input.reason,
            };
            store.put("stock-movement", movement);
          }
        } else if (command.kind === "staff") {
          const staff = schemas.staffSchema.omit({ pin: true }).parse(value);
          if (!snapshot.staff.some((row) => row.id === staff.id)) {
            demand(
              !staff.active,
              "Nya medarbetare skapas inaktiva. Ange PIN i huvudkassan innan kontot aktiveras.",
            );
            service.saveStaff(actor, {
              ...staff,
              pin: String(randomInt(10000000, 99999999)),
            });
          } else service.saveStaff(actor, staff);
        } else if (command.kind === "device") {
          const { id, ...input } = value;
          const parsed = schemas.deviceSchema.parse(input);
          // Existing device edits must not silently rotate its pairing code or terminate its login.
          const old = service.publicDevices().find((row) => row.id === id);
          demand(
            old,
            "Nya enheter paras vid huvudkassan för att anslutningskoden ska stanna lokalt.",
          );
          demand(
            parsed.kind === old.kind && parsed.station === old.station,
            "Byt enhetens uppgift vid huvudkassan.",
          );
          demand(
            old.kind !== "main" ||
              parsed.active ||
              snapshot.devices.some(
                (row) =>
                  row.id !== id &&
                  row.value.kind === "main" &&
                  row.value.active,
              ),
            "Minst en huvudkassa måste vara aktiv.",
          );
          const stored = store.get<Record<string, unknown> & { id: string }>(
            "device",
            String(id),
          )!;
          store.put("device", { ...stored, ...parsed });
          if (!parsed.active)
            store.db
              .prepare("DELETE FROM sessions WHERE device_id=?")
              .run(String(id));
        } else if (command.kind === "printer")
          service.savePrinter(actor, schemas.printerSchema.parse(value));
        else if (command.kind === "table")
          service.saveTable(actor, schemas.tableSchema.parse(value));
        service.log(actor, "admin.change", command.target, {
          commandId: command.id,
          kind: command.kind,
          baseVersion: command.baseVersion,
          before: current?.value ?? null,
          requested: value,
        });
      });
      result = {
        id: command.id,
        status: "applied",
        message: "Ändringen är genomförd i kassan.",
        at: service.timestamp(),
      };
    } catch (error) {
      const e = error as Error & { code?: string };
      result = {
        id: command.id,
        status: e.code === "VERSION_CONFLICT" ? "conflict" : "rejected",
        message:
          e instanceof z.ZodError
            ? "Kontrollera formulärets uppgifter."
            : e.message,
        at: service.timestamp(),
      };
    }
    store.put("backoffice-command", { id: command.id, fingerprint, result });
    return result;
  });
}
