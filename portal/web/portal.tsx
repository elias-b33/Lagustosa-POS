import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  ArrowLeft,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Clock3,
  CreditCard,
  LayoutDashboard,
  ListOrdered,
  LogOut,
  Menu,
  Package,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
  Wifi,
  WifiOff,
  X,
  Check,
  AlertCircle,
  Sun,
  Moon,
  ReceiptText,
  Utensils,
  ArrowUpDown,
} from "lucide-react";
import {
  api,
  download,
  enroll,
  local,
  newPassword,
  resetPassword,
  session,
  signIn,
  signOut,
  verify,
  type Session,
} from "./client";
import {
  dateShift,
  stockholmDate,
  filterProducts,
  type ProductFilters,
  type Analytics,
  type PortalMeta,
  receiptPage,
} from "../shared/analytics";
import {
  net,
  type Operations,
  type Product,
  type Totals,
} from "../shared/model";

type Page =
  "overview" | "orders" | "sales" | "products" | "operations" | "account";
const pages = [
  {
    id: "overview",
    name: "Översikt",
    icon: LayoutDashboard,
    group: "VERKSAMHET",
  },
  { id: "orders", name: "Beställningar", icon: ListOrdered },
  { id: "sales", name: "Försäljning", icon: BarChart3, group: "ANALYS" },
  { id: "products", name: "Artiklar", icon: Package },
  {
    id: "operations",
    name: "Driftstatus",
    icon: SlidersHorizontal,
    group: "ADMINISTRATION",
  },
  { id: "account", name: "Mitt konto", icon: ShieldCheck },
] as const;
const money = (ore: number) =>
  new Intl.NumberFormat("sv-SE", {
    style: "currency",
    currency: "SEK",
    maximumFractionDigits: 2,
  }).format(ore / 100);
const shortMoney = (ore: number) =>
  new Intl.NumberFormat("sv-SE", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(ore / 100) + " kr";
const number = (n: number) => new Intl.NumberFormat("sv-SE").format(n);
const dateLabel = (value: string) =>
  new Intl.DateTimeFormat("sv-SE", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Stockholm",
  }).format(new Date(value));
const timeLabel = (value: string) =>
  new Intl.DateTimeFormat("sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Stockholm",
  }).format(new Date(value));
const methodName = (value: string) =>
  ({ card: "Kort", cash: "Kontant", swish: "Swish" })[value] ?? value;
const elapsed = (value: string) => {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 60000),
  );
  return minutes < 60
    ? `${minutes} min`
    : minutes < 1440
      ? `${Math.floor(minutes / 60)} tim ${minutes % 60} min`
      : `${Math.floor(minutes / 1440)} dygn`;
};
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        e<span />
      </span>
      <div>
        eleva<span>ADMIN</span>
      </div>
    </div>
  );
}
function Panel({
  title,
  sub,
  action,
  children,
  className = "",
}: {
  title: string;
  sub?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-heading">
        <div>
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <BarChart3 size={28} />
      <p>{children}</p>
    </div>
  );
}
function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice" role="status">
      <AlertCircle size={17} />
      <span>{children}</span>
    </div>
  );
}

function Login({
  identity,
  onReady,
}: {
  identity: Session | null;
  onReady: () => void;
}) {
  const [email, setEmail] = useState(identity?.email ?? ""),
    [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null),
    [sent, setSent] = useState(false);
  const act = async (work: () => Promise<unknown>) => {
    setWorking(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="login-layout">
      <div className="login-story">
        <Brand />
        <div>
          <span className="eyebrow">
            ETT ANNAT PERSPEKTIV PÅ DIN RESTAURANG
          </span>
          <h1>
            Nära verksamheten.
            <br />
            Var du än är.
          </h1>
          <p>
            Försäljningen, favoriterna och det som behöver din uppmärksamhet.
            Samlat på ett ställe.
          </p>
          <div className="login-lines" aria-hidden="true">
            {[32, 50, 45, 67, 55, 84, 73, 100, 88].map((height, i) => (
              <i key={i} style={{ height: height + "%" }} />
            ))}
          </div>
        </div>
        <small>
          ELEVA STUDIOS <span>Restaurangens kontrollrum</span>
        </small>
      </div>
      <div className="login-side">
        <div className="login-card">
          <span className="eyebrow">ELEVA ADMIN</span>
          <h2>{identity ? "Ett steg till" : "Välkommen tillbaka"}</h2>
          <p>
            {identity
              ? "Bekräfta inloggningen med din autentiseringsapp."
              : "Logga in för att se hur det går för restaurangen."}
          </p>
          {local && <span className="badge training">Lokal testportal</span>}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                if (identity) await verify(code);
                else await signIn(email, password);
                onReady();
              });
            }}
          >
            {!identity ? (
              <>
                <label>
                  E-post
                  <input
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label>
                  Lösenord
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                <div className="signed-email">{identity.email}</div>
                {!identity.enrolled && !setup && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={working}
                    onClick={() =>
                      void act(async () => setSetup(await enroll()))
                    }
                  >
                    Konfigurera tvåstegsverifiering
                  </button>
                )}
                {setup && (
                  <div className="mfa-setup">
                    <img
                      src={setup.qr}
                      width="180"
                      height="180"
                      alt="QR-kod för autentiseringsappen"
                    />
                    <p>Skanna i din autentiseringsapp.</p>
                    <details>
                      <summary>Ange nyckeln manuellt</summary>
                      <code>{setup.secret}</code>
                    </details>
                  </div>
                )}
                <label>
                  Sexsiffrig kod
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  />
                </label>
              </>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="button primary" disabled={working}>
              {working
                ? "Kontrollerar…"
                : identity
                  ? "Öppna Admin"
                  : "Logga in"}
              <ArrowUpRight size={17} />
            </button>
          </form>
          {!identity ? (
            <button
              className="text-button"
              onClick={() =>
                void act(async () => {
                  await resetPassword(email);
                  setSent(true);
                })
              }
            >
              Glömt lösenord?
            </button>
          ) : (
            <button
              className="text-button"
              onClick={() =>
                void act(async () => {
                  await signOut();
                  onReady();
                })
              }
            >
              <ArrowLeft size={14} />
              Byt konto
            </button>
          )}
          {sent && (
            <p role="status">Om kontot finns har instruktioner skickats.</p>
          )}
          <div className="login-footer">
            <ShieldCheck size={15} />
            {local
              ? "Personlig inloggning · Lokal testportal"
              : "Personlig inloggning · Tvåstegsverifiering"}
          </div>
        </div>
      </div>
    </div>
  );
}

function Chart({ data, exclusive }: { data: Analytics; exclusive: boolean }) {
  const [table, setTable] = useState(false);
  const grouped = useMemo(() => {
    const step = data.series.length > 93 ? 30 : data.series.length > 31 ? 7 : 1;
    const list: { label: string; value: number }[] = [];
    for (let i = 0; i < data.series.length; i += step)
      list.push({
        label: dateLabel(data.series[i].date),
        value: data.series
          .slice(i, i + step)
          .reduce((sum, row) => sum + net(row.totals, exclusive), 0),
      });
    return list;
  }, [data, exclusive]);
  const high = Math.max(100, ...grouped.map((row) => row.value)),
    low = Math.min(0, ...grouped.map((row) => row.value)),
    span = high - low;
  const y = (value: number) => 220 - ((value - low) / span) * 180;
  const width = 700 / Math.max(1, grouped.length);
  return (
    <Panel
      title="Försäljning över tid"
      sub={`${dateLabel(data.query.from)} – ${dateLabel(data.query.to)} · efter returer ${exclusive ? "exkl." : "inkl."} moms`}
      action={
        <button className="quiet-button" onClick={() => setTable(!table)}>
          {table ? "Visa diagram" : "Visa tabell"}
        </button>
      }
    >
      {table ? (
        <div className="table-scroll chart-table">
          <table>
            <thead>
              <tr>
                <th>Datum</th>
                <th className="numeric">Försäljning efter returer</th>
              </tr>
            </thead>
            <tbody>
              {data.series.map((row) => (
                <tr key={row.date}>
                  <td>{dateLabel(row.date)}</td>
                  <td className="numeric">
                    {money(net(row.totals, exclusive))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-wrap">
          <svg
            viewBox="0 0 790 270"
            role="img"
            aria-label="Stapeldiagram över försäljning efter returer"
          >
            <defs>
              <linearGradient id="bar-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#f9854d" />
                <stop offset="1" stopColor="#df5627" />
              </linearGradient>
            </defs>
            {[0, 0.25, 0.5, 0.75, 1].map((f) => {
              const value = low + span * f;
              return (
                <g key={f}>
                  <line
                    x1="75"
                    y1={y(value)}
                    x2="780"
                    y2={y(value)}
                    className="grid-line"
                  />
                  <text x="62" y={y(value) + 4} textAnchor="end">
                    {shortMoney(value)}
                  </text>
                </g>
              );
            })}
            {grouped.map((row, i) => (
              <g key={i}>
                <rect
                  x={80 + i * width + width * 0.13}
                  y={Math.min(y(0), y(row.value))}
                  width={Math.max(2, width * 0.74)}
                  height={Math.max(
                    row.value === 0 ? 0 : 2,
                    Math.abs(y(row.value) - y(0)),
                  )}
                  rx="3"
                  fill={row.value < 0 ? "#d88787" : "url(#bar-fill)"}
                  tabIndex={0}
                  aria-label={`${row.label}: ${money(row.value)}`}
                >
                  <title>
                    {row.label}: {money(row.value)}
                  </title>
                </rect>
                {(i % Math.max(1, Math.ceil(grouped.length / 8)) === 0 ||
                  grouped.length === 1) && (
                  <text
                    x={80 + i * width + width / 2}
                    y="247"
                    textAnchor="middle"
                  >
                    {row.label}
                  </text>
                )}
              </g>
            ))}
          </svg>
          {grouped.every((row) => row.value === 0) && (
            <span className="chart-zero">
              Ingen försäljning under vald period
            </span>
          )}
          <div className="chart-legend">
            <i />
            Försäljning efter returer
          </div>
        </div>
      )}
    </Panel>
  );
}
function Metrics({ data, exclusive }: { data: Analytics; exclusive: boolean }) {
  const current = net(data.total, exclusive),
    prior = net(data.previous, exclusive);
  const change =
    prior > 0
      ? `${((current - prior) / prior) * 100 > 0 ? "+" : ""}${new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 1 }).format(((current - prior) / prior) * 100)} %`
      : null;
  const average = data.total.salesCount
    ? Math.round(
        (data.total.salesOre - (exclusive ? data.total.salesVatOre : 0)) /
          data.total.salesCount,
      )
    : null;
  return (
    <div className="metrics">
      {[
        {
          label: "Försäljning efter returer",
          value: money(current),
          icon: Wallet,
          note: change
            ? `${change} mot föregående period`
            : "Ingen jämförbar föregående försäljning",
          accent: true,
        },
        {
          label: "Försäljningskvitton",
          value: number(data.total.salesCount),
          icon: ReceiptText,
          note: `${number(data.total.refundsCount)} returkvitton under perioden`,
        },
        {
          label: "Genomsnitt per kvitto",
          value: average === null ? "—" : money(average),
          icon: BarChart3,
          note: "Försäljningar före returer, utan dricks",
        },
        {
          label: "Dricks",
          value: money(data.total.tipsOre),
          icon: CreditCard,
          note: "Redovisas separat från försäljningen",
        },
      ].map((row) => (
        <section
          className={`metric ${row.accent ? "metric-primary" : ""}`}
          key={row.label}
        >
          <div className="metric-label">
            {row.label}
            <row.icon size={17} />
          </div>
          <strong>{row.value}</strong>
          <small>{row.note}</small>
        </section>
      ))}
    </div>
  );
}
function Products({
  products,
  exclusive,
  compact = false,
  filters = { search: "", category: "", sort: "sales" },
  onFilters,
}: {
  products: Product[];
  exclusive: boolean;
  compact?: boolean;
  filters?: ProductFilters;
  onFilters?: (filters: ProductFilters) => void;
}) {
  const { search, category, sort } = filters;
  const setSearch = (search: string) => onFilters?.({ ...filters, search }),
    setCategory = (category: string) => onFilters?.({ ...filters, category }),
    setSort = (sort: string) => onFilters?.({ ...filters, sort });
  const categories = [...new Set(products.map((row) => row.category))].sort();
  const rows = filterProducts(products, filters, exclusive);
  if (compact)
    return (
      <div className="rank-list">
        {!rows.length ? (
          <Empty>Försäljningen visas här när den har synkats.</Empty>
        ) : (
          rows.slice(0, 5).map((row, i) => (
            <div className="rank-row" key={i}>
              <span className="rank-number">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <strong>{row.name}</strong>
                <small>{row.category}</small>
              </div>
              <b>{money(net(row.totals, exclusive))}</b>
            </div>
          ))
        )}
      </div>
    );
  const quantity = (q: Product["sold"]) =>
    q.denominator === "1" ? q.numerator : `${q.numerator}/${q.denominator}`;
  return (
    <>
      <div className="table-tools">
        <label className="search-field">
          <Search size={17} />
          <input
            aria-label="Sök artikel"
            placeholder="Sök bland sålda artiklar…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          aria-label="Kategori"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">Alla kategorier</option>
          {categories.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <select
          aria-label="Sortering"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="sales">Högst försäljning</option>
          <option value="refunds">Högst returer</option>
          <option value="quantity">Dokumenterat antal</option>
          <option value="name">Artikelnamn</option>
        </select>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Artikel</th>
              <th>Dokumenterat antal</th>
              <th className="numeric">Returer</th>
              <th className="numeric">Efter returer</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td>
                  <strong>{row.name}</strong>
                  <small>{row.category}</small>
                </td>
                <td>
                  {quantity(row.sold)} sålda · {quantity(row.refunded)}{" "}
                  returnerade
                  {row.unknownQuantity > 0 && (
                    <small className="amber">
                      {row.unknownQuantity} fördelningar saknar säkert antal
                    </small>
                  )}
                </td>
                <td className="numeric">
                  {money(
                    row.totals.refundsOre -
                      (exclusive ? row.totals.refundsVatOre : 0),
                  )}
                </td>
                <td className="numeric">
                  <strong>{money(net(row.totals, exclusive))}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <Empty>Inga artiklar matchar dina filter.</Empty>}
      </div>
    </>
  );
}
type Receipts = ReturnType<typeof receiptPage>;
function ReceiptsTable({
  value,
  onPage,
  compact = false,
}: {
  value: Receipts | null;
  onPage: (page: number) => void;
  compact?: boolean;
}) {
  if (!value?.rows.length)
    return <Empty>Inga kvitton under den valda perioden.</Empty>;
  if (compact)
    return (
      <div className="recent-list">
        {value.rows.slice(0, 5).map((row) => (
          <div className="recent-row" key={row.id}>
            <span
              className={`receipt-icon ${row.kind === "refund" ? "refund" : ""}`}
            >
              <ReceiptText size={18} />
            </span>
            <div>
              <strong>
                {row.kind === "refund" ? "Retur" : "Kvitto"}{" "}
                {row.number === null ? "saknas" : `#${row.number}`}
              </strong>
              <small>
                {dateLabel(row.at)} · {timeLabel(row.at)} ·{" "}
                {methodName(row.method)}
              </small>
            </div>
            <b>
              {row.kind === "refund" ? "−" : ""}
              {money(row.amountOre)}
            </b>
          </div>
        ))}
      </div>
    );
  return (
    <>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Kvitto / nota</th>
              <th>Datum</th>
              <th>Betalning</th>
              <th>Kassa</th>
              <th>Status</th>
              <th className="numeric">Belopp inkl. moms</th>
            </tr>
          </thead>
          <tbody>
            {value.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>
                    {row.number === null ? "Underlag saknas" : `#${row.number}`}
                  </strong>
                  <small>
                    {row.tabNumber === null ? "" : "Nota " + row.tabNumber}
                  </small>
                </td>
                <td>
                  {dateLabel(row.at)}
                  <small>{timeLabel(row.at)}</small>
                </td>
                <td>{methodName(row.method)}</td>
                <td className="register-cell" title={row.registerId}>
                  {row.registerId}
                </td>
                <td>
                  <span
                    className={`badge ${row.kind === "refund" ? "amber" : "success"}`}
                  >
                    {row.kind === "refund" ? "Retur" : "Godkänd"}
                  </span>
                  {row.fiscalStatus !== "confirmed" && (
                    <small className="amber">
                      Kontrollstatus{" "}
                      {row.fiscalStatus === "missing" ? "saknas" : "oklar"}
                    </small>
                  )}
                </td>
                <td className="numeric">
                  <strong>
                    {row.kind === "refund" ? "−" : ""}
                    {money(row.amountOre)}
                  </strong>
                  {row.tipOre > 0 && (
                    <small>+ {money(row.tipOre)} dricks</small>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        <span>{number(value.total)} kvitton</span>
        <div>
          <button
            className="quiet-button"
            disabled={value.page <= 1}
            onClick={() => onPage(value.page - 1)}
          >
            Föregående
          </button>
          <span>
            {value.page} / {value.pages}
          </span>
          <button
            className="quiet-button"
            disabled={value.page >= value.pages}
            onClick={() => onPage(value.page + 1)}
          >
            Nästa
          </button>
        </div>
      </div>
    </>
  );
}
function Orders({ operations }: { operations: Operations }) {
  const [selected, setSelected] = useState<string | null>(null),
    [search, setSearch] = useState("");
  const dialog = useRef<HTMLElement | null>(null),
    opener = useRef<HTMLElement | null>(null);
  const rows = operations.openTabs
    .filter((row) =>
      `${row.table} ${row.number}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  const detail = operations.openTabs.find((row) => row.id === selected);
  useEffect(() => {
    if (!selected) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
      if (event.key === "Tab") {
        const items =
          dialog.current?.querySelectorAll<HTMLButtonElement>("button");
        if (!items?.length) return;
        const first = items[0],
          last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      opener.current?.focus();
    };
  }, [selected]);
  return (
    <>
      <div className="orders-summary">
        <span className="badge amber">
          {operations.openTabs.length} öppna notor
        </span>
        <strong>
          {money(
            operations.openTabs.reduce((sum, row) => sum + row.remainingOre, 0),
          )}{" "}
          kvar att betala
        </strong>
        <label className="search-field">
          <Search size={17} />
          <input
            aria-label="Sök nota"
            placeholder="Sök bord eller nota…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      <div className="order-grid">
        {rows.map((row) => (
          <article className="order-card" key={row.id}>
            <div>
              <h2>{row.table}</h2>
              <span className="badge amber">
                {row.paidOre ? "Delbetald" : "Öppen"}
              </span>
            </div>
            <p>
              Nota #{row.number} · <Clock3 size={13} />
              {elapsed(row.openedAt)}
            </p>
            <div className="order-value">
              <span>{row.rows} artikelrader</span>
              <strong>{money(row.remainingOre)}</strong>
            </div>
            <div className="order-paid">
              {row.paidOre > 0
                ? `${money(row.paidOre)} redan betalt`
                : "Inväntar betalning"}
              {row.pending > 0 && (
                <span className="amber"> · Betalning behöver kontrolleras</span>
              )}
            </div>
            <button
              className="button secondary"
              onClick={(event) => {
                opener.current = event.currentTarget;
                setSelected(row.id);
              }}
            >
              Visa sammanfattning
              <ChevronRight size={15} />
            </button>
          </article>
        ))}
      </div>
      {!rows.length && (
        <Panel title="Öppna notor">
          <Empty>Inga öppna notor matchar ditt val.</Empty>
        </Panel>
      )}
      {detail && (
        <div className="detail-backdrop" onClick={() => setSelected(null)}>
          <section
            ref={dialog}
            className="detail-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="icon-button close-detail"
              autoFocus
              aria-label="Stäng sammanfattning"
              onClick={() => setSelected(null)}
            >
              <X />
            </button>
            <span className="eyebrow">NOTA #{detail.number}</span>
            <h2 id="detail-title">{detail.table}</h2>
            <p>
              Öppnad {dateLabel(detail.openedAt)} {timeLabel(detail.openedAt)}
            </p>
            <dl>
              <div>
                <dt>Notans belopp</dt>
                <dd>{money(detail.totalOre)}</dd>
              </div>
              <div>
                <dt>Godkända betalningar</dt>
                <dd>{money(detail.paidOre)}</dd>
              </div>
              <div>
                <dt>Kvar att betala</dt>
                <dd>{money(detail.remainingOre)}</dd>
              </div>
            </dl>
            <Notice>
              Sammanfattning från senaste synkningen. Notan hanteras i kassan.
            </Notice>
            <button
              className="button secondary"
              onClick={() => setSelected(null)}
            >
              Stäng
            </button>
          </section>
        </div>
      )}
    </>
  );
}
function Breakdown({
  title,
  rows,
  exclusive,
  label,
}: {
  title: string;
  rows: Analytics["methods"];
  exclusive: boolean;
  label: (key: string) => string;
}) {
  return (
    <Panel title={title}>
      <div className="breakdown">
        {rows.map((row) => (
          <div key={row.key}>
            <span>{label(row.key)}</span>
            <strong>{money(net(row.totals, exclusive))}</strong>
          </div>
        ))}
        {!rows.length && <Empty>Inga belopp att visa.</Empty>}
      </div>
    </Panel>
  );
}
function OperationsView({ meta }: { meta: PortalMeta }) {
  const ops = meta.operations;
  return (
    <>
      <div className="metrics">
        {[
          { label: "Köksbongar i kö", value: ops.kitchen },
          { label: "Barbongar i kö", value: ops.bar },
          { label: "Osäkra betalningar", value: ops.unresolvedPayments },
          {
            label: "Utskrifter att kontrollera",
            value: ops.prints.failed + ops.prints.uncertain,
          },
        ].map((row) => (
          <section className="metric" key={row.label}>
            <div className="metric-label">{row.label}</div>
            <strong>{row.value}</strong>
            <small>Senast mottagna uppgifter</small>
          </section>
        ))}
      </div>
      <div className="two-columns">
        <Panel
          title="Enheter"
          sub={
            ops.runtimeAt
              ? `Status från ${timeLabel(ops.runtimeAt)}`
              : "Anslutningsstatus har inte överförts"
          }
        >
          <div className="device-list">
            {ops.devices.map((row) => (
              <div key={row.id}>
                <span
                  className={`status-dot ${row.connections ? "online" : ""}`}
                />
                <div>
                  <strong>{row.name}</strong>
                  <small>
                    {!row.active
                      ? "Avstängd"
                      : row.connections === null
                        ? "Anslutningsstatus saknas"
                        : row.connections
                          ? "Ansluten vid senaste uppdateringen"
                          : "Ingen aktiv anslutning"}
                  </small>
                </div>
                {row.connections ? <Wifi size={17} /> : <WifiOff size={17} />}
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Kontroller">
          <dl className="checks">
            <div>
              <dt>Kvitton med oklar kontrollstatus</dt>
              <dd>{ops.unresolvedFiscal}</dd>
            </div>
            <div>
              <dt>Utskrifter som väntar</dt>
              <dd>{ops.prints.queued}</dd>
            </div>
            <div>
              <dt>Misslyckade utskrifter</dt>
              <dd>{ops.prints.failed}</dd>
            </div>
            <div>
              <dt>Osäkra utskrifter</dt>
              <dd>{ops.prints.uncertain}</dd>
            </div>
            <div>
              <dt>Senaste backup</dt>
              <dd>
                {ops.backup.lastAt
                  ? `${dateLabel(ops.backup.lastAt)} ${timeLabel(ops.backup.lastAt)}`
                  : "Uppgift saknas"}
              </dd>
            </div>
            <div>
              <dt>Backupfel rapporterat</dt>
              <dd>{ops.backup.failed ? "Ja" : "Nej"}</dd>
            </div>
          </dl>
        </Panel>
      </div>
    </>
  );
}
function Account({
  identity,
  onLogout,
}: {
  identity: Session;
  onLogout: () => Promise<void>;
}) {
  const [password, setPassword] = useState(""),
    [message, setMessage] = useState("");
  return (
    <div className="account-column">
      <Panel
        title="Din inloggning"
        sub="Personlig åtkomst till restaurangens statistik"
      >
        <dl className="checks">
          <div>
            <dt>E-post</dt>
            <dd>{identity.email}</dd>
          </div>
          <div>
            <dt>Tvåstegsverifiering</dt>
            <dd>
              {identity.local && identity.mfaRequired === false ? (
                <span className="badge training">Avstängd i lokalt test</span>
              ) : (
                <span className="badge success">
                  <Check size={13} />
                  Aktiv
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Åtkomst</dt>
            <dd>Statistik och läsåtkomst</dd>
          </div>
        </dl>
        {local ? (
          <Notice>
            Det här kontot gäller den lokala testportalen. Ett separat inbjudet
            konto används vid publicering.
          </Notice>
        ) : (
          <form
            className="password-form"
            onSubmit={(e) => {
              e.preventDefault();
              void newPassword(password)
                .then(() => {
                  setPassword("");
                  setMessage("Lösenordet har uppdaterats.");
                })
                .catch((error) => setMessage(error.message));
            }}
          >
            <label>
              Nytt lösenord
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button className="button secondary">Spara lösenord</button>
          </form>
        )}
        {message && <p role="status">{message}</p>}
        <div className="panel-bottom">
          <button className="button secondary" onClick={() => void onLogout()}>
            <LogOut size={16} />
            Logga ut
          </button>
        </div>
      </Panel>
    </div>
  );
}

export function Portal() {
  const [identity, setIdentity] = useState<Session | null>(null),
    [authLoading, setAuthLoading] = useState(true),
    [page, setPage] = useState<Page>(() =>
      pages.some((p) => p.id === location.hash.slice(1))
        ? (location.hash.slice(1) as Page)
        : location.pathname === "/account"
          ? "account"
          : "overview",
    );
  const [meta, setMeta] = useState<PortalMeta | null>(null),
    [data, setData] = useState<Analytics | null>(null),
    [receipts, setReceipts] = useState<Receipts | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [mobile, setMobile] = useState(false);
  const [preset, setPreset] = useState("day"),
    [from, setFrom] = useState(stockholmDate()),
    [to, setTo] = useState(stockholmDate()),
    [register, setRegister] = useState(""),
    [exclusive, setExclusive] = useState(false),
    [receiptSearch, setReceiptSearch] = useState(""),
    [kind, setKind] = useState(""),
    [receiptNumber, setReceiptNumber] = useState(1),
    [theme, setTheme] = useState(
      () => localStorage.getItem("eleva-admin-theme") ?? "dark",
    );
  const [productFilters, setProductFilters] = useState<ProductFilters>({
    search: "",
    category: "",
    sort: "sales",
  });
  const generation = useRef(0),
    initialized = useRef(false),
    controller = useRef<AbortController | null>(null);
  const refreshSession = useCallback(async () => {
    const current = await session();
    setIdentity(current);
    setAuthLoading(false);
  }, []);
  useEffect(() => {
    void refreshSession();
    const onHash = () => {
      const value = location.hash.slice(1);
      if (pages.some((p) => p.id === value)) setPage(value as Page);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [refreshSession]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("eleva-admin-theme", theme);
  }, [theme]);
  const query = useMemo(
    () =>
      new URLSearchParams({
        from,
        to,
        ...(register ? { registerId: register } : {}),
      }),
    [from, to, register],
  );
  useEffect(() => {
    setData(null);
    setReceipts(null);
  }, [query]);
  const refresh = useCallback(async () => {
    if (!identity?.verified) return;
    const ticket = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    try {
      const current = await api<PortalMeta>("/meta", { signal: abort.signal });
      if (ticket !== generation.current) return;
      setMeta(current);
      if (!initialized.current) {
        initialized.current = true;
        const date = current.currentDay ?? stockholmDate();
        if (date !== from || date !== to) {
          setFrom(date);
          setTo(date);
          return;
        }
      }
      const [stats, records] = await Promise.all([
        api<Analytics>("/analytics?" + query, { signal: abort.signal }),
        api<Receipts>(
          "/receipts?" +
            query +
            "&" +
            new URLSearchParams({
              search: receiptSearch,
              kind,
              page: String(receiptNumber),
            }),
          { signal: abort.signal },
        ),
      ]);
      if (ticket !== generation.current) return;
      setData(stats);
      setReceipts(records);
      setError("");
    } catch (e) {
      if (ticket !== generation.current || (e as Error).name === "AbortError")
        return;
      setError((e as Error).message);
      if ([401, 403].includes((e as { status?: number }).status ?? 0)) {
        setIdentity(null);
        setData(null);
        setMeta(null);
        setReceipts(null);
        initialized.current = false;
        void signOut().catch(() => {});
      }
    } finally {
      if (ticket === generation.current) setLoading(false);
    }
  }, [identity, query, receiptSearch, kind, receiptNumber, from, to]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30000);
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", visible);
      controller.current?.abort();
    };
  }, [refresh]);
  const logout = async () => {
    await signOut();
    generation.current++;
    controller.current?.abort();
    setIdentity(null);
    setMeta(null);
    setData(null);
    setReceipts(null);
    initialized.current = false;
  };
  const navigate = (id: Page) => {
    setPage(id);
    location.hash = id;
    setMobile(false);
    if (id === "overview") {
      setReceiptSearch("");
      setKind("");
      setReceiptNumber(1);
    }
  };
  const range = (value: string) => {
    setPreset(value);
    setReceiptNumber(1);
    const today = stockholmDate();
    if (value === "day") {
      setFrom(meta?.currentDay ?? today);
      setTo(meta?.currentDay ?? today);
    }
    if (value === "yesterday") {
      setFrom(dateShift(today, -1));
      setTo(dateShift(today, -1));
    }
    if (value === "week") {
      const dow = new Date(today + "T12:00:00Z").getUTCDay();
      setFrom(dateShift(today, -((dow + 6) % 7)));
      setTo(today);
    }
    if (value === "month") {
      setFrom(today.slice(0, 7) + "01");
      setTo(today);
    }
  };
  if (authLoading)
    return (
      <div className="initial-loading">
        <Brand />
        <p>Öppnar Eleva Admin…</p>
      </div>
    );
  if (!identity?.verified)
    return (
      <Login
        key={identity?.email ?? "login"}
        identity={identity}
        onReady={() => void refreshSession()}
      />
    );
  const current = pages.find((p) => p.id === page)!;
  const stale = meta
    ? Date.now() - Date.parse(meta.generatedAt) > 120000
    : true;
  const economic = ["overview", "sales", "products"].includes(page);
  const exportFile = async () => {
    try {
      const params = new URLSearchParams(query);
      params.set("exclusive", String(exclusive));
      params.set("view", page);
      if (page === "sales") {
        params.set("search", receiptSearch);
        params.set("kind", kind);
      }
      if (page === "products") {
        params.set("productSearch", productFilters.search);
        params.set("category", productFilters.category);
        params.set("sort", productFilters.sort);
      }
      await download(params);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="portal-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Till innehållet
      </a>
      {mobile && (
        <div className="nav-backdrop" onClick={() => setMobile(false)} />
      )}
      <aside className={`sidebar ${mobile ? "nav-open" : ""}`}>
        <Brand />
        <button
          className="icon-button mobile-close"
          aria-label="Stäng meny"
          onClick={() => setMobile(false)}
        >
          <X />
        </button>
        <div className="restaurant-chip">
          <span>LG</span>
          <div>
            <strong>{meta?.restaurantName ?? "Restaurangen"}</strong>
            <small>Restaurangöversikt</small>
          </div>
        </div>
        <nav aria-label="Huvudmeny">
          {pages.map((item) => (
            <div key={item.id}>
              {"group" in item && <h2>{item.group}</h2>}
              <button
                className={item.id === page ? "active" : ""}
                aria-current={item.id === page ? "page" : undefined}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={18} />
                {item.name}
                {item.id === "orders" &&
                  Boolean(meta?.operations.openTabs.length) && (
                    <span className="nav-count">
                      {meta!.operations.openTabs.length}
                    </span>
                  )}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="account-avatar">
            {identity.email[0].toUpperCase()}
          </div>
          <div>
            <strong>Ansvarig</strong>
            <span>{identity.email}</span>
          </div>
          <button
            className="icon-button"
            aria-label="Logga ut"
            onClick={() => void logout().catch((e) => setError(e.message))}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button
            className="icon-button menu-toggle"
            aria-label="Öppna meny"
            onClick={() => setMobile(!mobile)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumbs">
            <span>{meta?.restaurantName ?? "Restaurangen"}</span>
            <ChevronRight size={14} />
            <strong>{current.name}</strong>
          </div>
          <div className="topbar-actions">
            <span className="badge training">Träningsdata</span>
            <button
              className="icon-button"
              aria-label={
                theme === "dark"
                  ? "Växla till ljust tema"
                  : "Växla till mörkt tema"
              }
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {page === "overview"
                  ? "DIN RESTAURANG, I SIFFROR"
                  : page === "orders"
                    ? "PÅGÅENDE SERVICE"
                    : "ELEVA ADMIN"}
              </span>
              <h1>{current.name}</h1>
              <p>
                {page === "overview"
                  ? "En samlad bild av försäljningen och verksamheten."
                  : page === "orders"
                    ? "Öppna notor och kvarstående betalningar från senaste synkningen."
                    : page === "sales"
                      ? "Följ försäljning, betalningar och returer över tid."
                      : page === "products"
                        ? "Se vad som säljer och hur sortimentet presterar."
                        : page === "operations"
                          ? "Det senaste kända läget från restaurangen."
                          : "Din personliga åtkomst till Eleva Admin."}
              </p>
            </div>
            <div className="heading-actions">
              {economic && (
                <button
                  className="button secondary"
                  disabled={!data || loading}
                  onClick={() => void exportFile()}
                >
                  <ArrowDownToLine size={16} />
                  Exportera
                </button>
              )}
              <button
                className="icon-button refresh-button"
                disabled={loading}
                aria-label="Uppdatera statistik"
                onClick={() => void refresh()}
              >
                <RefreshCw size={17} className={loading ? "spinning" : ""} />
              </button>
            </div>
          </div>
          <div className="sync-line">
            <span className={`status-dot ${!stale ? "online" : ""}`} />
            <span>
              {meta
                ? `${stale ? "Fördröjda uppgifter" : "Senast synkad"} · ${dateLabel(meta.generatedAt)} ${timeLabel(meta.generatedAt)}`
                : "Väntar på statistik"}
            </span>
            {local && <span className="local-label">Lokal testportal</span>}
            {data?.partial && economic && (
              <span>Pågående kassadag · preliminär period</span>
            )}
          </div>
          {error && (
            <Notice>
              {error}
              <button className="text-button" onClick={() => void refresh()}>
                Försök igen
              </button>
            </Notice>
          )}
          {stale && meta && (
            <Notice>
              Uppgifterna är äldre än två minuter. Visar senast mottagna
              underlag; restaurangens aktuella läge kan ha ändrats.
            </Notice>
          )}
          {economic && (
            <div className="filters">
              <div className="period-options">
                {[
                  { id: "day", name: "Kassadag" },
                  { id: "yesterday", name: "Igår" },
                  { id: "week", name: "Denna vecka" },
                  { id: "month", name: "Denna månad" },
                  { id: "custom", name: "Egen period" },
                ].map((item) => (
                  <button
                    key={item.id}
                    className={preset === item.id ? "active" : ""}
                    onClick={() => range(item.id)}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
              <div className="filter-selects">
                <select
                  aria-label="Försäljningskassa"
                  value={register}
                  onChange={(e) => {
                    setRegister(e.target.value);
                    setReceiptNumber(1);
                  }}
                >
                  <option value="">Alla kassor</option>
                  {meta?.registers.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                  {data?.registers.some(
                    (row) => row.key === "legacy-unassigned",
                  ) && (
                    <option value="legacy-unassigned">
                      Historisk kassa saknas
                    </option>
                  )}
                </select>
                <select
                  aria-label="Momsvisning"
                  value={exclusive ? "ex" : "inc"}
                  onChange={(e) => setExclusive(e.target.value === "ex")}
                >
                  <option value="inc">Inkl. moms</option>
                  <option value="ex">Exkl. moms</option>
                </select>
              </div>
              {preset === "custom" && (
                <div className="date-fields">
                  <label>
                    Från
                    <input
                      type="date"
                      value={from}
                      max={to}
                      onChange={(e) => {
                        setFrom(e.target.value);
                        setReceiptNumber(1);
                      }}
                    />
                  </label>
                  <label>
                    Till
                    <input
                      type="date"
                      value={to}
                      min={from}
                      onChange={(e) => {
                        setTo(e.target.value);
                        setReceiptNumber(1);
                      }}
                    />
                  </label>
                </div>
              )}
            </div>
          )}
          {data?.coverage.length && economic ? (
            <details className="coverage">
              <summary>
                <AlertCircle size={16} />
                Vissa historiska uppgifter är ofullständiga
              </summary>
              <ul>
                {data.coverage.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {page === "account" ? (
            <Account identity={identity} onLogout={logout} />
          ) : !meta || (!data && economic) ? (
            <Panel title={loading ? "Hämtar statistik…" : "Statistik inväntas"}>
              <Empty>
                {loading
                  ? "Sammanställer restaurangens uppgifter."
                  : "Anslut kassan för att visa statistik här."}
              </Empty>
            </Panel>
          ) : (
            <>
              {page === "overview" && data && (
                <>
                  <Metrics data={data} exclusive={exclusive} />
                  <Chart data={data} exclusive={exclusive} />
                  <div className="two-columns">
                    <Panel
                      title="Mest sålda artiklar"
                      sub="Efter försäljningsbelopp, med returer avräknade"
                      action={
                        <button
                          className="text-button"
                          onClick={() => navigate("products")}
                        >
                          Alla artiklar
                          <ArrowUpRight size={15} />
                        </button>
                      }
                    >
                      <Products
                        products={data.products}
                        exclusive={exclusive}
                        compact
                      />
                    </Panel>
                    <Panel
                      title="Senaste kvitton"
                      sub="Vald period · belopp inklusive moms"
                      action={
                        <button
                          className="text-button"
                          onClick={() => navigate("sales")}
                        >
                          Visa alla
                          <ArrowUpRight size={15} />
                        </button>
                      }
                    >
                      <ReceiptsTable
                        value={receipts}
                        onPage={setReceiptNumber}
                        compact
                      />
                    </Panel>
                  </div>
                  <div className="service-strip">
                    <Utensils size={22} />
                    <div>
                      <strong>
                        {meta.operations.openTabs.length} öppna notor just nu
                      </strong>
                      <span>
                        {money(
                          meta.operations.openTabs.reduce(
                            (sum, row) => sum + row.remainingOre,
                            0,
                          ),
                        )}{" "}
                        kvar att betala · {meta.operations.kitchen} köksbongar i
                        kö
                      </span>
                    </div>
                    <button
                      className="button secondary"
                      onClick={() => navigate("orders")}
                    >
                      Se beställningar
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </>
              )}
              {page === "orders" && <Orders operations={meta.operations} />}
              {page === "sales" && data && (
                <>
                  <Metrics data={data} exclusive={exclusive} />
                  <div className="three-columns">
                    <Breakdown
                      title="Betalningssätt"
                      rows={data.methods}
                      exclusive={exclusive}
                      label={methodName}
                    />
                    <Panel title="Moms och rabatter">
                      <dl className="checks">
                        {data.vat.map((row) => (
                          <div key={row.key}>
                            <dt>Moms {Number(row.key) / 100} %</dt>
                            <dd>
                              {money(
                                row.totals.salesVatOre -
                                  row.totals.refundsVatOre,
                              )}
                            </dd>
                          </div>
                        ))}
                        <div>
                          <dt>Registrerade rabatter inkl. moms</dt>
                          <dd>{money(data.total.discountsOre)}</dd>
                        </div>
                      </dl>
                    </Panel>
                    <Breakdown
                      title="Försäljning per kassa"
                      rows={data.registers}
                      exclusive={exclusive}
                      label={(id) =>
                        meta.registers.find((row) => row.id === id)?.name ??
                        "Historisk kassa"
                      }
                    />
                  </div>
                  <Panel
                    title="Försäljningar och returer"
                    sub="Beloppen i kvittolistan visas alltid inklusive moms"
                  >
                    <div className="table-tools">
                      <label className="search-field">
                        <Search size={17} />
                        <input
                          aria-label="Sök kvitto"
                          placeholder="Sök kvittonummer, nota eller kassa…"
                          value={receiptSearch}
                          onChange={(e) => {
                            setReceiptSearch(e.target.value);
                            setReceiptNumber(1);
                          }}
                        />
                      </label>
                      <select
                        aria-label="Kvittotyp"
                        value={kind}
                        onChange={(e) => {
                          setKind(e.target.value);
                          setReceiptNumber(1);
                        }}
                      >
                        <option value="">Alla typer</option>
                        <option value="sale">Försäljningar</option>
                        <option value="refund">Returer</option>
                      </select>
                    </div>
                    <ReceiptsTable value={receipts} onPage={setReceiptNumber} />
                  </Panel>
                </>
              )}
              {page === "products" && data && (
                <Panel
                  title="Artikelförsäljning"
                  sub="Historiska namn, priser och kategorier från försäljningen"
                >
                  <Products
                    products={data.products}
                    exclusive={exclusive}
                    filters={productFilters}
                    onFilters={setProductFilters}
                  />
                </Panel>
              )}
              {page === "operations" && <OperationsView meta={meta} />}
            </>
          )}
          <footer className="page-footer">
            <span>
              ELEVA ADMIN <i /> Överblick för restaurangens ansvariga
            </span>
            <span>Träningsdata · Belopp i SEK</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
