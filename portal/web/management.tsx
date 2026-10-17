import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Plus,
  Search,
  Pencil,
  RefreshCw,
  X,
  Check,
  Clock3,
  AlertCircle,
  ArrowDownToLine,
  Package,
  ChevronRight,
} from "lucide-react";
import { api } from "./client";
import { parseMoney } from "../../shared/money";
import type {
  ManagementData,
  ManagementKind,
  ManagementCommand,
  Versioned,
  ManagementSnapshot,
} from "../../shared/backoffice";
import type {
  OrderSummary,
  SavedReport,
  EventSummary,
} from "../shared/archive-model";
import "./management.css";
const readMoney = (value: string) => {
  const n = parseMoney(value);
  if (n === null)
    throw new Error("Ange ett giltigt pris med högst två decimaler.");
  return n;
};
const money = (ore: number) =>
  new Intl.NumberFormat("sv-SE", { style: "currency", currency: "SEK" }).format(
    ore / 100,
  );
const date = (value: string) =>
  new Date(value).toLocaleString("sv-SE", {
    timeZone: "Europe/Stockholm",
    dateStyle: "short",
    timeStyle: "short",
  });
const today = () =>
  new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
const kindName: Record<string, string> = {
  restaurant: "Restaurang",
  product: "Produkt",
  category: "Kategori",
  "global-category": "Global kategori",
  modifier: "Tillägg",
  coupon: "Kupong",
  campaign: "Kampanj",
  stock: "Lager",
  staff: "Personal",
  device: "Enhet",
  printer: "Skrivare",
  table: "Bord",
};
const stateName: Record<string, string> = {
  applied: "Genomförd",
  queued: "Väntar på kassan",
  conflict: "Nyare ändring finns",
  rejected: "Avvisad",
  open: "Öppen",
  paid: "Betald",
  void: "Makulerad",
  sent: "Skickad",
  held: "Väntar",
  draft: "Ej skickad",
  ready: "Klar",
  served: "Serverad",
  started: "Tillagas",
  admin: "Administratör",
  cashier: "Kassapersonal",
  waiter: "Servering",
  kitchen: "Kök",
  bar: "Bar",
  main: "Huvudkassa",
  serving: "Handkassa",
  display: "Orderskärm",
  guest: "Gästkvitto",
};
export const managementPages = [
  { id: "restaurant", name: "Restaurang", group: "BUTIK" },
  { id: "categories", name: "Kategorier" },
  { id: "catalog", name: "Produkter" },
  { id: "modifiers", name: "Tillägg" },
  { id: "global-categories", name: "Globala kategorier" },
  { id: "coupons", name: "Kuponger" },
  { id: "campaigns", name: "Kampanjer" },
  { id: "inventory", name: "Lager" },
] as const;
const configs: Record<
  string,
  {
    kind: ManagementKind;
    field: keyof ManagementSnapshot;
    label: string;
    help: string;
  }
> = {
  restaurant: {
    kind: "restaurant",
    field: "restaurant",
    label: "Restaurang",
    help: "Företagsuppgifter och kassaidentitet. Identitetsändringar kräver avslutad kassadag.",
  },
  catalog: {
    kind: "product",
    field: "products",
    label: "Produkt",
    help: "Priser och tillägg gäller nya orderrader. Redan registrerade rader behåller sitt underlag.",
  },
  categories: {
    kind: "category",
    field: "categories",
    label: "Kategori",
    help: "Ordna menyn och gruppera kategorier. Ett namnbyte följer med till dagens produktkatalog.",
  },
  "global-categories": {
    kind: "global-category",
    field: "globalCategories",
    label: "Global kategori",
    help: "Samla lokala kategorier under en gemensam huvudgrupp, exempelvis Mat eller Dryck.",
  },
  modifiers: {
    kind: "modifier",
    field: "modifiers",
    label: "Tilläggsgrupp",
    help: "Gemensamma tillval kopplas till produkter. Prisändringar gäller framtida beställningar.",
  },
  coupons: {
    kind: "coupon",
    field: "coupons",
    label: "Kupong",
    help: "Kod för procentuell rabatt på hela notan. En kupong eller kampanj per nota. Användningar reserveras när erbjudandet väljs.",
  },
  campaigns: {
    kind: "campaign",
    field: "campaigns",
    label: "Kampanj",
    help: "Erbjudanden väljs i kassan under Erbjudande. Ange period, veckodagar och klockslag.",
  },
  inventory: {
    kind: "stock",
    field: "stock",
    label: "Lagerjustering",
    help: "Färdiga artiklar räknas av när beställningen skickas. Retur och makulering återför inte lager automatiskt. Inventera eller registrera en inleverans vid behov.",
  },
  staff: {
    kind: "staff",
    field: "staff",
    label: "Medarbetare",
    help: "Nya konton skapas inaktiva. Tilldela en personlig PIN på huvudkassan innan du aktiverar kontot.",
  },
  devices: {
    kind: "device",
    field: "devices",
    label: "Enhet",
    help: "Hantera namn och aktiva enheter. Nya enheter och byte av uppgift paras vid huvudkassan.",
  },
  printers: {
    kind: "printer",
    field: "printers",
    label: "Skrivarprofil",
    help: "En aktiv profil per destination. Själva nätverksanslutningen konfigureras lokalt på kassadatorn.",
  },
  tables: {
    kind: "table",
    field: "tables",
    label: "Bord",
    help: "Bord med öppna notor kan inte avaktiveras. Position anges i procent av bordsplanen.",
  },
};
function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={wide ? "mg-field wide" : "mg-field"}>
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const old = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => old?.focus();
  }, []);
  return (
    <dialog
      className="mg-dialog"
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Stäng dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
function saveFile(name: string, data: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Management({ page }: { page: string }) {
  const [section, setSection] = useState("staff"),
    [data, setData] = useState<ManagementData | null>(null),
    [error, setError] = useState(""),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState(""),
    [editing, setEditing] = useState<
      Versioned<Record<string, unknown>> | null | undefined
    >(undefined),
    [saving, setSaving] = useState(false),
    [notice, setNotice] = useState("");
  const active = page === "settings" ? section : page,
    cfg = configs[active];
  const refresh = useCallback(async () => {
    try {
      setData(await api("/management"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    setSearch("");
    setFilter("");
    setEditing(undefined);
    setNotice("");
  }, [page, section]);
  const snapshot = data?.snapshot;
  const ownerOnly =
    cfg &&
    ["restaurant", "staff", "device", "printer", "table"].includes(cfg.kind);
  const editable = Boolean(
    data?.canManage && (!ownerOnly || data.role === "owner"),
  );
  let rows: Versioned<Record<string, unknown>>[] =
    snapshot && cfg
      ? ((active === "restaurant"
          ? [snapshot.restaurant]
          : snapshot[cfg.field]) as Versioned<Record<string, unknown>>[])
      : [];
  const fullRows = rows;
  rows = rows.filter((row) => {
    const v = row.value;
    const title =
      active === "inventory"
        ? snapshot?.products.find((p) => p.id === row.id)?.value.name
        : active === "restaurant"
          ? (v.company as { name: string })?.name
          : v.name;
    return (
      String(title ?? "")
        .toLocaleLowerCase("sv-SE")
        .includes(search.toLocaleLowerCase("sv-SE")) &&
      (!filter ||
        (active === "catalog"
          ? v.category === filter
          : active === "inventory"
            ? filter === "tracked"
              ? v.tracked
              : Boolean(v.tracked) && Number(v.quantity) <= Number(v.minimum)
            : true))
    );
  });
  const submit = async (value: Record<string, unknown>, id: string) => {
    if (!cfg) return;
    setSaving(true);
    setError("");
    const command: ManagementCommand = {
      id: crypto.randomUUID(),
      kind: cfg.kind,
      target: id,
      baseVersion: editing?.version ?? null,
      value,
    };
    try {
      await api("/commands", { method: "POST", body: JSON.stringify(command) });
      setEditing(undefined);
      setNotice(
        "Ändringen har skickats. Följ status nedan tills kassan har bekräftat den.",
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="management">
      {page === "settings" && (
        <div className="mg-tabs" role="tablist" aria-label="Inställningar">
          {[
            ["staff", "Personal"],
            ["devices", "Enheter"],
            ["printers", "Skrivare"],
            ["tables", "Bord"],
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={section === id}
              onClick={() => setSection(id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="mg-notice" role="status">
          <Check size={17} />
          {notice}
        </p>
      )}
      {!snapshot ? (
        <div className="mg-panel mg-empty">
          <Package />
          <h2>Anslutningen till kassan inväntas</h2>
          <p>Butiksuppgifter visas när kassans adminanslutning har synkat.</p>
          <button className="button secondary" onClick={() => void refresh()}>
            Hämta igen
          </button>
        </div>
      ) : (
        <>
          {!data.connected && (
            <p className="mg-notice warning">
              <Clock3 size={18} />
              Kassan har inte uppdaterat uppgifterna nyligen. Ändringar köas
              tills anslutningen är tillbaka.
            </p>
          )}
          {page === "processing" ? (
            <CommandList data={data} />
          ) : (
            <>
              <div className="mg-panel">
                <div className="mg-panel-head">
                  <div>
                    <h2>
                      {cfg.label === "Produkt"
                        ? "Produktkatalog"
                        : cfg.label === "Lagerjustering"
                          ? "Lagersaldo"
                          : cfg.label}
                    </h2>
                    <p>{cfg.help}</p>
                  </div>
                  {editable &&
                    !["restaurant", "inventory", "devices"].includes(
                      active,
                    ) && (
                      <button
                        className="button primary"
                        onClick={() => setEditing(null)}
                      >
                        <Plus size={16} />
                        Ny {cfg.label.toLocaleLowerCase("sv-SE")}
                      </button>
                    )}
                </div>
                <div className="mg-toolbar">
                  <label className="mg-search">
                    <Search size={17} />
                    <input
                      aria-label="Sök i listan"
                      placeholder="Sök i listan…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  {active === "catalog" && (
                    <select
                      aria-label="Kategori"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    >
                      <option value="">Alla kategorier</option>
                      {snapshot.categories.map((c) => (
                        <option key={c.id} value={c.value.name}>
                          {c.value.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {active === "inventory" && (
                    <select
                      aria-label="Lagerfilter"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    >
                      <option value="">Alla artiklar</option>
                      <option value="tracked">Lagerförda</option>
                      <option value="low">Lågt saldo</option>
                    </select>
                  )}
                  <span className="mg-count">
                    {rows.length} av {fullRows.length}
                  </span>
                </div>
                <div className="mg-table-wrap">
                  <table className="mg-table mg-catalog">
                    <thead>
                      <tr>
                        <th>{active === "inventory" ? "Artikel" : "Namn"}</th>
                        <th>Uppgifter</th>
                        <th>Status</th>
                        <th>
                          <span className="sr-only">Åtgärd</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const v = row.value;
                        const name =
                          active === "inventory"
                            ? snapshot.products.find((p) => p.id === row.id)
                                ?.value.name
                            : active === "restaurant"
                              ? (v.company as { name: string }).name
                              : String(v.name ?? "");
                        return (
                          <tr key={row.id}>
                            <td>
                              <strong>{name}</strong>
                              {active === "catalog" && (
                                <small>{String(v.category)}</small>
                              )}
                            </td>
                            <td>{rowDescription(active, row, snapshot)}</td>
                            <td>{rowStatus(active, v)}</td>
                            <td>
                              <button
                                className="button secondary compact"
                                disabled={!editable}
                                onClick={() => setEditing(row)}
                                aria-label={`Ändra ${name}`}
                              >
                                <Pencil size={14} />
                                <span>
                                  {active === "inventory" ? "Justera" : "Ändra"}
                                </span>
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!rows.length && (
                  <p className="mg-empty">Inga poster matchar urvalet.</p>
                )}
              </div>
              {active === "inventory" && (
                <div className="mg-panel">
                  <div className="mg-panel-head">
                    <h2>Senaste lagerrörelser</h2>
                    <span>De senaste 500 rörelserna</span>
                  </div>
                  <div className="mg-table-wrap">
                    <table className="mg-table">
                      <thead>
                        <tr>
                          <th>Tid</th>
                          <th>Artikel</th>
                          <th>Händelse</th>
                          <th className="num">Förändring</th>
                          <th className="num">Saldo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.movements.slice(0, 50).map((m) => (
                          <tr key={m.id}>
                            <td>{date(m.at)}</td>
                            <td>
                              {snapshot.products.find((p) => p.id === m.itemId)
                                ?.value.name ?? "Arkiverad artikel"}
                            </td>
                            <td>
                              {
                                {
                                  order: "Beställning",
                                  delivery: "Inleverans",
                                  waste: "Svinn",
                                  count: "Inventering",
                                }[m.kind]
                              }
                              <small>{m.reference}</small>
                            </td>
                            <td className="num">
                              {m.delta > 0 ? "+" : ""}
                              {m.delta}
                            </td>
                            <td className="num">{m.balance}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!snapshot.movements.length && (
                    <p className="mg-empty">Inga lagerrörelser registrerade.</p>
                  )}
                </div>
              )}
              <CommandList data={data} compact />
            </>
          )}
        </>
      )}
      {editing !== undefined && cfg && snapshot && (
        <Editor
          kind={cfg.kind}
          row={editing}
          snapshot={snapshot}
          busy={saving}
          onClose={() => setEditing(undefined)}
          onSave={submit}
        />
      )}
    </section>
  );
}
function rowDescription(
  page: string,
  row: Versioned<Record<string, unknown>>,
  s: ManagementSnapshot,
): ReactNode {
  const v = row.value;
  if (page === "catalog")
    return (
      <>
        {money(Number(v.priceOre))}
        <small>
          {String(v.station === "bar" ? "Bar" : "Kök")} ·{" "}
          {String(v.modifiers instanceof Array ? v.modifiers.length : 0)}{" "}
          tilläggsgrupper
        </small>
      </>
    );
  if (page === "categories")
    return (
      <>
        {s.products.filter((p) => p.value.category === v.name).length} produkter
        <small>
          {s.globalCategories.find((g) => g.id === v.globalId)?.value.name ??
            "Ingen global kategori"}
        </small>
      </>
    );
  if (page === "global-categories")
    return (
      <>
        {s.categories.filter((c) => c.value.globalId === row.id).length}{" "}
        kategorier
      </>
    );
  if (page === "modifiers")
    return (
      <>
        {(v.options as unknown[]).length} alternativ · välj {String(v.min)}–
        {String(v.max)}
      </>
    );
  if (["coupons", "campaigns"].includes(page))
    return (
      <>
        {Number(v.discountBps) / 100} % {v.code ? `· ${v.code}` : ""}
        <small>
          {String(v.from)} – {String(v.until)} ·{" "}
          {String((row as unknown as { used: number }).used ?? 0)} /{" "}
          {v.maxUses === null ? "obegränsat" : String(v.maxUses)} användningar
        </small>
      </>
    );
  if (page === "inventory")
    return (
      <>
        <strong>{String(v.quantity)} st</strong>
        <small>Lägsta saldo: {String(v.minimum)}</small>
      </>
    );
  if (page === "restaurant") {
    const c = v.company as Record<string, string>;
    return (
      <>
        {c.organizationNumber}
        <small>
          {c.address}, {c.city}
        </small>
      </>
    );
  }
  if (page === "staff") return stateName[String(v.role)];
  if (page === "devices") return stateName[String(v.kind)];
  if (page === "printers")
    return (
      <>
        {stateName[String(v.destination)]} · {String(v.paperWidthMm)} mm
      </>
    );
  if (page === "tables")
    return (
      <>
        {String(v.area)} · {String(v.seats)} platser
      </>
    );
  return "";
}
function rowStatus(page: string, v: Record<string, unknown>) {
  if (page === "inventory")
    return (
      <span
        className={`badge ${v.tracked && Number(v.quantity) <= Number(v.minimum) ? "warning" : ""}`}
      >
        {!v.tracked
          ? "Ej lagerförd"
          : Number(v.quantity) <= Number(v.minimum)
            ? "Lågt saldo"
            : "Lagerförd"}
      </span>
    );
  if ("active" in v || "available" in v)
    return (
      <span className={`badge ${(v.active ?? v.available) ? "positive" : ""}`}>
        {(v.active ?? v.available) ? "Aktiv" : "Inaktiv"}
      </span>
    );
  return <span className="badge">Konfigurerad</span>;
}
function CommandList({
  data,
  compact = false,
}: {
  data: ManagementData;
  compact?: boolean;
}) {
  return (
    <div className="mg-panel">
      <div className="mg-panel-head">
        <div>
          <h2>Behandlingshistorik</h2>
          <p>Ändringar från Admin och kassans bekräftelse.</p>
        </div>
        {compact && (
          <a className="button secondary" href="#processing">
            Visa alla <ChevronRight size={15} />
          </a>
        )}
      </div>
      {!data.commands.length ? (
        <p className="mg-empty">Inga ändringar från Admin ännu.</p>
      ) : (
        <ul className="mg-commands">
          {data.commands.slice(0, compact ? 5 : 100).map((row) => (
            <li key={row.command.id}>
              <span className={"mg-command-icon " + row.status}>
                {row.status === "applied" ? (
                  <Check size={18} />
                ) : row.status === "queued" ? (
                  <Clock3 size={18} />
                ) : (
                  <AlertCircle size={18} />
                )}
              </span>
              <div>
                <strong>
                  {kindName[row.command.kind]} ·{" "}
                  {String(
                    row.command.value.name ??
                      data.snapshot?.products.find(
                        (p) => p.id === row.command.target,
                      )?.value.name ??
                      row.command.target,
                  )}
                </strong>
                <small>
                  {date(row.createdAt)} ·{" "}
                  {row.result?.message ??
                    "Ändringen inväntar bekräftelse från kassan."}
                </small>
              </div>
              <span className="badge">{stateName[row.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
function defaults(
  kind: ManagementKind,
  s: ManagementSnapshot,
): Record<string, unknown> {
  const id = crypto.randomUUID();
  switch (kind) {
    case "product":
      return {
        id,
        name: "",
        category: s.categories[0]?.value.name ?? "Övrigt",
        description: "",
        priceOre: 0,
        takeawayPriceOre: null,
        taxClass: "food",
        itemKind: "services",
        takeawayItemKind: "goods",
        course: "main",
        station: "kitchen",
        available: true,
        example: false,
        modifiers: [],
      };
    case "category":
      return { id, name: "", position: s.categories.length, globalId: null };
    case "global-category":
      return { id, name: "", position: s.globalCategories.length };
    case "modifier":
      return { id, name: "", min: 0, max: 1, options: [] };
    case "coupon":
    case "campaign":
      return {
        id,
        name: "",
        active: true,
        code: kind === "coupon" ? "" : null,
        discountBps: 1000,
        from: today(),
        until: today(),
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        startTime: "00:00",
        endTime: "23:59",
        maxUses: null,
      };
    case "staff":
      return { id, name: "", role: "waiter", active: false };
    case "printer":
      return {
        id,
        name: "",
        destination: "guest",
        paperWidthMm: 80,
        active: false,
      };
    case "table":
      return {
        id,
        name: "",
        area: "Restaurangen",
        seats: 4,
        x: 50,
        y: 50,
        active: true,
      };
    default:
      return { id };
  }
}
function Editor({
  kind,
  row,
  snapshot,
  busy,
  onClose,
  onSave,
}: {
  kind: ManagementKind;
  row: Versioned<Record<string, unknown>> | null;
  snapshot: ManagementSnapshot;
  busy: boolean;
  onClose: () => void;
  onSave: (v: Record<string, unknown>, id: string) => Promise<void>;
}) {
  const [v, setV] = useState<Record<string, unknown>>(() => {
    const value = structuredClone(row?.value ?? defaults(kind, snapshot));
    if (kind === "stock")
      return {
        id: value.id,
        tracked: value.tracked,
        minimum: value.minimum,
        operation: "count",
        quantity: Math.max(0, Number(value.quantity)),
        reason: "",
      };
    return value;
  });
  const [error, setError] = useState("");
  const put = (key: string, value: unknown) =>
    setV((current) => ({ ...current, [key]: value }));
  const text = (key: string, label: string, type = "text", required = true) => (
    <Field label={label}>
      <input
        type={type}
        required={required}
        value={String(v[key] ?? "")}
        maxLength={key === "description" ? 1000 : 100}
        onChange={(e) => put(key, e.target.value)}
      />
    </Field>
  );
  const number = (key: string, label: string, min = 0, max = 1000000) => (
    <Field label={label}>
      <input
        type="number"
        required
        step="1"
        min={min}
        max={max}
        value={Number(v[key])}
        onChange={(e) =>
          put(key, e.target.value === "" ? "" : Number(e.target.value))
        }
      />
    </Field>
  );
  const select = (key: string, label: string, options: [string, string][]) => (
    <Field label={label}>
      <select
        value={String(v[key] ?? "")}
        onChange={(e) => put(key, e.target.value || null)}
      >
        {options.map(([value, name]) => (
          <option key={value} value={value}>
            {name}
          </option>
        ))}
      </select>
    </Field>
  );
  const check = (key: string, label: string) => (
    <label className="mg-check">
      <input
        type="checkbox"
        checked={Boolean(v[key])}
        onChange={(e) => put(key, e.target.checked)}
      />
      {label}
    </label>
  );
  const price = (key: string, label: string, nullable = false) => (
    <Field label={label}>
      <input
        inputMode="decimal"
        defaultValue={
          v[key] === null ? "" : String(Number(v[key]) / 100).replace(".", ",")
        }
        placeholder={nullable ? "Samma som ordinarie pris" : ""}
        onChange={(e) => {
          try {
            put(
              key,
              e.target.value === "" && nullable
                ? null
                : readMoney(e.target.value),
            );
            setError("");
          } catch {
            put(key, NaN);
          }
        }}
      />
    </Field>
  );
  const valueWithoutId = () => {
    const { id: _, ...rest } = v;
    return rest;
  };
  const title =
    Object.values(configs).find((c) => c.kind === kind)?.label ?? "Ändring";
  return (
    <Dialog
      title={`${row ? "Ändra" : "Ny"} ${title.toLowerCase()}`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="mg-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await onSave(valueWithoutId(), String(v.id ?? row?.id));
          } catch (error) {
            setError((error as Error).message);
          }
        }}
      >
        <div className="mg-fields">
          {kind !== "restaurant" && kind !== "stock" && text("name", "Namn")}
          {kind === "product" && (
            <>
              {select(
                "category",
                "Kategori",
                snapshot.categories.map((c) => [c.value.name, c.value.name]),
              )}
              {price("priceOre", "Pris inkl. moms (kr)")}
              {price("takeawayPriceOre", "Avhämtningspris (kr)", true)}
              {select("taxClass", "Momsklass", [
                ["food", "Mat"],
                ["alcohol", "Alkohol"],
                ["standard", "Standard"],
              ])}
              {select("itemKind", "Klassning – servering", [
                ["goods", "Vara"],
                ["services", "Tjänst"],
              ])}
              {select("takeawayItemKind", "Klassning – avhämtning", [
                ["goods", "Vara"],
                ["services", "Tjänst"],
              ])}
              {select("course", "Servering", [
                ["starter", "Förrätt"],
                ["main", "Huvudrätt"],
                ["dessert", "Dessert"],
                ["drink", "Dryck"],
              ])}
              {select("station", "Destination", [
                ["kitchen", "Kök"],
                ["bar", "Bar"],
              ])}
              {text("description", "Beskrivning", "text", false)}
              {check("available", "Tillgänglig i kassan")}
              <fieldset className="wide">
                <legend>Tilläggsgrupper</legend>
                {snapshot.modifiers.length ? (
                  snapshot.modifiers.map((m) => (
                    <label className="mg-check" key={m.id}>
                      <input
                        type="checkbox"
                        checked={(v.modifiers as { id: string }[]).some(
                          (g) => g.id === m.id,
                        )}
                        onChange={(e) =>
                          put(
                            "modifiers",
                            e.target.checked
                              ? [...(v.modifiers as object[]), m.value]
                              : (v.modifiers as { id: string }[]).filter(
                                  (g) => g.id !== m.id,
                                ),
                          )
                        }
                      />
                      {m.value.name}
                    </label>
                  ))
                ) : (
                  <p>Skapa gemensamma tillägg under Tillägg.</p>
                )}
                {(v.modifiers as { id: string; name: string }[])
                  .filter((m) => !snapshot.modifiers.some((g) => g.id === m.id))
                  .map((m) => (
                    <p key={m.id}>
                      Befintligt produkttillägg: {m.name} (behålls)
                    </p>
                  ))}
              </fieldset>
            </>
          )}
          {["category", "global-category"].includes(kind) &&
            number("position", "Sorteringsordning")}
          {kind === "category" &&
            select("globalId", "Global kategori", [
              ["", "Ingen"],
              ...snapshot.globalCategories.map(
                (c) => [c.id, c.value.name] as [string, string],
              ),
            ])}
          {kind === "modifier" && (
            <>
              {number("min", "Minsta antal val", 0, 20)}
              {number("max", "Högsta antal val", 1, 20)}
              <fieldset className="wide">
                <legend>Alternativ</legend>
                {(
                  v.options as { id: string; name: string; priceOre: number }[]
                ).map((o, index) => (
                  <div className="mg-option" key={o.id}>
                    <Field label={`Alternativ ${index + 1}`}>
                      <input
                        required
                        value={o.name}
                        onChange={(e) =>
                          put(
                            "options",
                            (v.options as (typeof o)[]).map((x) =>
                              x.id === o.id
                                ? { ...x, name: e.target.value }
                                : x,
                            ),
                          )
                        }
                      />
                    </Field>
                    <Field label="Tilläggspris (kr)">
                      <input
                        inputMode="decimal"
                        defaultValue={o.priceOre / 100}
                        onChange={(e) => {
                          let priceOre: number;
                          try {
                            priceOre = readMoney(e.target.value);
                          } catch {
                            priceOre = NaN;
                          }
                          put(
                            "options",
                            (v.options as (typeof o)[]).map((x) =>
                              x.id === o.id ? { ...x, priceOre } : x,
                            ),
                          );
                        }}
                      />
                    </Field>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Ta bort alternativ ${index + 1}`}
                      onClick={() =>
                        put(
                          "options",
                          (v.options as (typeof o)[]).filter(
                            (x) => x.id !== o.id,
                          ),
                        )
                      }
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="button secondary"
                  onClick={() =>
                    put("options", [
                      ...(v.options as object[]),
                      { id: crypto.randomUUID(), name: "", priceOre: 0 },
                    ])
                  }
                >
                  <Plus size={15} />
                  Lägg till alternativ
                </button>
              </fieldset>
            </>
          )}
          {["coupon", "campaign"].includes(kind) && (
            <>
              {kind === "coupon" && text("code", "Kupongkod")}
              <Field label="Rabatt (%)">
                <input
                  type="number"
                  min="0.01"
                  max="100"
                  step="0.01"
                  required
                  value={Number(v.discountBps) / 100}
                  onChange={(e) =>
                    put("discountBps", Math.round(Number(e.target.value) * 100))
                  }
                />
              </Field>
              {text("from", "Giltig från", "date")}
              {text("until", "Giltig till", "date")}
              {text("startTime", "Från klockan", "time")}
              {text("endTime", "Till klockan", "time")}
              <Field label="Max antal notor (tomt = obegränsat)">
                <input
                  type="number"
                  min="1"
                  max="1000000"
                  value={v.maxUses === null ? "" : Number(v.maxUses)}
                  onChange={(e) =>
                    put(
                      "maxUses",
                      e.target.value ? Number(e.target.value) : null,
                    )
                  }
                />
              </Field>
              {check("active", "Aktivt erbjudande")}
              <fieldset className="wide">
                <legend>Veckodagar</legend>
                <div className="mg-weekdays">
                  {["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"].map(
                    (day, index) => (
                      <label key={day}>
                        <input
                          type="checkbox"
                          checked={(v.weekdays as number[]).includes(index + 1)}
                          onChange={(e) =>
                            put(
                              "weekdays",
                              e.target.checked
                                ? [...(v.weekdays as number[]), index + 1]
                                : (v.weekdays as number[]).filter(
                                    (n) => n !== index + 1,
                                  ),
                            )
                          }
                        />
                        {day}
                      </label>
                    ),
                  )}
                </div>
              </fieldset>
            </>
          )}
          {kind === "stock" && (
            <>
              {select("operation", "Åtgärd", [
                ["count", "Inventering – nytt totalt saldo"],
                ["delivery", "Inleverans – lägg till"],
                ["waste", "Svinn – dra av"],
                ["configure", "Ändra lagerinställningar"],
              ])}
              {v.operation !== "configure" && number("quantity", "Antal")}
              {number("minimum", "Lägsta saldo")}
              {check("tracked", "Lagerför artikeln")}
              {text("reason", "Orsak / underlag")}
            </>
          )}
          {kind === "restaurant" && (
            <>
              {Object.entries({
                name: "Företagsnamn",
                organizationNumber: "Organisationsnummer (10 siffror)",
                address: "Adress",
                city: "Postnummer och ort",
                phone: "Telefon",
              }).map(([key, label]) => (
                <Field label={label} key={key}>
                  <input
                    required={key !== "phone"}
                    value={(v.company as Record<string, string>)[key]}
                    onChange={(e) =>
                      put("company", {
                        ...(v.company as object),
                        [key]: e.target.value,
                      })
                    }
                  />
                </Field>
              ))}
              {text("registerId", "Kassans grundidentitet")}
              <p className="wide">
                Momssatser och deras giltighetsdatum hanteras vid huvudkassan.
                Befintliga regler behålls.
              </p>
            </>
          )}
          {kind === "staff" && (
            <>
              {select(
                "role",
                "Behörighet",
                Object.entries(stateName).filter(([id]) =>
                  ["admin", "cashier", "waiter", "kitchen", "bar"].includes(id),
                ),
              )}
              {row ? (
                check("active", "Aktiv medarbetare")
              ) : (
                <p className="wide">
                  Kontot skapas inaktivt. Ställ in PIN och aktivera det i
                  huvudkassan.
                </p>
              )}
            </>
          )}
          {kind === "device" && (
            <>
              {check("active", "Aktiv enhet")}
              <p className="wide">
                Uppgift: {stateName[String(v.kind)]}. Anslutningskoden behålls.
              </p>
            </>
          )}
          {kind === "printer" && (
            <>
              {select("destination", "Destination", [
                ["guest", "Gästkvitto"],
                ["kitchen", "Kök"],
                ["bar", "Bar"],
              ])}
              <Field label="Pappersbredd">
                <select
                  value={Number(v.paperWidthMm)}
                  onChange={(e) => put("paperWidthMm", Number(e.target.value))}
                >
                  <option value="80">80 mm</option>
                  <option value="58">58 mm</option>
                </select>
              </Field>
              {check("active", "Aktiv skrivarprofil")}
            </>
          )}
          {kind === "table" && (
            <>
              {text("area", "Område")}
              {number("seats", "Antal platser", 1, 100)}
              {number("x", "Vågrät position (%)", 0, 100)}
              {number("y", "Lodrät position (%)", 0, 100)}
              {check("active", "Aktivt bord")}
            </>
          )}
        </div>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Avbryt
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? "Skickar…" : "Spara till kassan"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

type ArchiveRow = (OrderSummary | SavedReport | EventSummary) & {
  date: string;
};
type ArchiveResponse = {
  rows: ArchiveRow[];
  page: number;
  pages: number;
  total: number;
  complete: boolean;
};
export function Archive({
  view,
  initialFrom,
  initialTo,
}: {
  view: "history" | "reports" | "logs";
  initialFrom: string;
  initialTo: string;
}) {
  const [from, setFrom] = useState(initialFrom),
    [to, setTo] = useState(initialTo),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(1),
    [data, setData] = useState<ArchiveResponse | null>(null),
    [error, setError] = useState(""),
    [detail, setDetail] = useState<ArchiveRow | null>(null),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    const params = new URLSearchParams({
      from,
      to,
      search,
      status,
      page: String(page),
    });
    void api<ArchiveResponse>(`/${view}?${params}`, { signal: abort.signal })
      .then((r) => {
        setData(r);
        setError("");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [view, from, to, search, status, page, refresh]);
  useEffect(() => {
    setPage(1);
    setStatus("");
    setSearch("");
    setDetail(null);
  }, [view]);
  const exportRows = async () => {
    try {
      const rows: ArchiveRow[] = [];
      for (let p = 1; ; p++) {
        const result = await api<ArchiveResponse>(
          `/${view}?` +
            new URLSearchParams({ from, to, search, status, page: String(p) }),
        );
        rows.push(...result.rows);
        if (p >= result.pages) break;
      }
      saveFile(
        `eleva-${view}-${from}-${to}-test.json`,
        JSON.stringify({ mode: "training", from, to, rows }, null, 2),
        "application/json",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="management">
      <div className="mg-panel">
        <div className="mg-panel-head">
          <div>
            <h2>
              {view === "history"
                ? "Orderhistorik"
                : view === "reports"
                  ? "Sparade X- och Z-rapporter"
                  : "Händelseloggar"}
            </h2>
            <p>
              {view === "reports"
                ? "Sammanfattningar av redan sparade rapporter. Visning skapar inget nytt rapportuttag."
                : view === "logs"
                  ? "Händelsetyp, tid och referens från kassadagarna. Personliga anteckningar och rå journal visas inte."
                  : "Notor med artiklar, betalningssumma och status från kassans sparade underlag."}
            </p>
          </div>
          <button
            className="button secondary"
            onClick={() => void exportRows()}
            disabled={!data}
          >
            <ArrowDownToLine size={16} />
            Exportera JSON
          </button>
        </div>
        <div className="mg-toolbar">
          <Field label="Från">
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </Field>
          <Field label="Till">
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
            />
          </Field>
          <label className="mg-search">
            <Search size={16} />
            <input
              aria-label="Sök historik"
              placeholder="Sök nummer, artikel eller händelse…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </label>
          {view !== "logs" && (
            <select
              aria-label="Historikstatus"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">
                Alla {view === "reports" ? "rapporttyper" : "statusar"}
              </option>
              {(view === "reports" ? ["X", "Z"] : ["open", "paid", "void"]).map(
                (v) => (
                  <option key={v} value={v}>
                    {stateName[v] ?? v}
                  </option>
                ),
              )}
            </select>
          )}
          <button
            className="icon-button"
            aria-label="Uppdatera historik"
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw size={17} />
          </button>
        </div>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {data && !data.complete && (
          <p className="mg-notice warning">
            Viss äldre historik har ännu inte synkats i det nya formatet.
          </p>
        )}
        <div className="mg-table-wrap">
          <table className="mg-table">
            <thead>
              <tr>
                <th>Tid / kassadag</th>
                <th>{view === "logs" ? "Händelse" : "Referens"}</th>
                <th>{view === "logs" ? "Objekt" : "Status / kassa"}</th>
                {view !== "logs" && (
                  <th className="num">
                    {view === "history" ? "Notans belopp" : "Efter returer"}
                  </th>
                )}
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {date("at" in r ? r.at : r.openedAt)}
                    <small>{r.date}</small>
                  </td>
                  <td>
                    {"number" in r
                      ? `Nota ${r.number} · ${r.table}`
                      : "kind" in r
                        ? `${r.kind}-rapport ${r.sequence ?? ""}`
                        : r.action}
                  </td>
                  <td>
                    {"status" in r
                      ? stateName[r.status]
                      : "kind" in r
                        ? (r.registerId ?? "Samtliga kassor")
                        : r.entityId}
                  </td>
                  {view !== "logs" && (
                    <td className="num">
                      {money(
                        "totalOre" in r
                          ? r.totalOre
                          : "netOre" in r
                            ? r.netOre
                            : 0,
                      )}
                    </td>
                  )}
                  <td>
                    {view !== "logs" && (
                      <button
                        className="button secondary compact"
                        onClick={() => setDetail(r)}
                      >
                        Visa detaljer
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && !data.rows.length && (
          <p className="mg-empty">Inga poster under vald period.</p>
        )}
        <div className="mg-pagination">
          <span>
            {data?.total ?? 0} poster · sida {data?.page ?? 1} av{" "}
            {data?.pages ?? 1}
          </span>
          <button
            className="button secondary"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Föregående
          </button>
          <button
            className="button secondary"
            disabled={!data || data.page >= data.pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Nästa
          </button>
        </div>
      </div>
      {detail && (
        <Dialog
          title={
            "number" in detail
              ? `Nota ${detail.number}`
              : "kind" in detail
                ? `${detail.kind}-rapport`
                : "Händelse"
          }
          onClose={() => setDetail(null)}
        >
          <div className="mg-details">
            {"lines" in detail ? (
              <>
                <p>
                  {detail.table} · {detail.guestCount} gäster ·{" "}
                  {stateName[detail.status]}
                </p>
                <dl>
                  <dt>Notans belopp</dt>
                  <dd>{money(detail.totalOre)}</dd>
                  <dt>Godkända försäljningsbetalningar</dt>
                  <dd>{money(detail.paidOre)}</dd>
                  <dt>Kvar att betala</dt>
                  <dd>
                    {money(Math.max(0, detail.totalOre - detail.paidOre))}
                  </dd>
                </dl>
                <p className="mg-muted">
                  Returer visas separat under Försäljning. Raderna beskriver
                  beställningen, även vid delbetalning.
                </p>
                <table className="mg-table">
                  <thead>
                    <tr>
                      <th>Artikel</th>
                      <th>Antal</th>
                      <th>Styckpris</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line, i) => (
                      <tr key={i}>
                        <td>{line.name}</td>
                        <td>{line.quantity}</td>
                        <td>{money(line.unitPriceOre)}</td>
                        <td>{stateName[line.status] ?? line.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : "kind" in detail ? (
              <>
                <p>
                  Träningsrapport · {detail.registerId ?? "Samtliga kassor"} ·{" "}
                  {date(detail.at)}
                </p>
                <dl>
                  {Object.entries({
                    salesOre: "Försäljning",
                    refundsOre: "Returer",
                    netOre: "Efter returer",
                    vatOre: "Varav moms",
                    tipsOre: "Dricks",
                    expectedCashOre: "Förväntat kontant",
                    differenceOre: "Kassadifferens",
                  }).map(([key, label]) => (
                    <div key={key}>
                      <dt>{label}</dt>
                      <dd>
                        {detail[key as keyof SavedReport] === null
                          ? "Ej redovisad"
                          : money(Number(detail[key as keyof SavedReport]))}
                      </dd>
                    </div>
                  ))}
                </dl>
                <h3>Betalningssätt</h3>
                {detail.methods.map((m) => (
                  <p key={m.method}>
                    {(
                      {
                        card: "Kort",
                        cash: "Kontant",
                        swish: "Swish",
                      } as Record<string, string>
                    )[m.method] ?? m.method}
                    : {money(m.netOre)}
                  </p>
                ))}
                <h3>Moms</h3>
                {detail.vat.map((v, i) => (
                  <p key={i}>
                    {v.rateBps / 100} % · Belopp {money(v.grossOre)} · Moms{" "}
                    {money(v.vatOre)}
                  </p>
                ))}
              </>
            ) : null}
            <button
              className="button secondary"
              onClick={() =>
                saveFile(
                  `eleva-${detail.id}-test.json`,
                  JSON.stringify({ mode: "training", ...detail }, null, 2),
                  "application/json",
                )
              }
            >
              <ArrowDownToLine size={16} />
              Spara underlaget
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
