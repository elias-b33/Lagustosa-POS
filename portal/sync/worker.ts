import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SourceReader, type RuntimeStatus } from "./project";
import { syncManagement } from "./management";
import {
  deliverySchema,
  initialCursor,
  type Cursor,
  type Delivery,
  type Snapshot,
} from "../shared/model";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface SyncConfig {
  database: string;
  stateDir: string;
  installationId: string;
  endpoint: string;
  token: string;
  runtimeUrl?: string;
  runtimeToken?: string;
}
interface SyncState {
  cursor: Cursor;
  days: Record<string, string>;
  pending: Delivery[] | null;
  pendingDays: Record<string, string> | null;
}
export function deliveries(
  snapshot: Snapshot,
  previousDays: Record<string, string>,
): { parts: Delivery[]; days: Record<string, string> } {
  const hashes = Object.fromEntries(
    snapshot.days.map((day) => [day.id, digest(day)]),
  );
  const changed = snapshot.days.filter(
    (day) => hashes[day.id] !== previousDays[day.id],
  );
  const chunks: Snapshot["days"][] = [];
  let chunk: Snapshot["days"] = [],
    bytes = 0;
  for (const day of changed) {
    const size = Buffer.byteLength(JSON.stringify(day));
    if (size > 6_000_000)
      throw new Error(
        "En kassadag är för stor för överföringen. Kontakta support.",
      );
    if (chunk.length && (chunk.length >= 10 || bytes + size > 6_000_000)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(day);
    bytes += size;
  }
  if (chunk.length || !chunks.length) chunks.push(chunk);
  const batchId = randomUUID();
  return {
    days: hashes,
    parts: chunks.map((days, part) =>
      deliverySchema.parse({
        ...snapshot,
        days,
        batchId,
        part,
        parts: chunks.length,
      }),
    ),
  };
}
function secureEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error(
      "Synkningen kräver HTTPS, utom vid lokala tester på denna dator.",
    );
  return url;
}
export class SyncWorker {
  readonly source: SourceReader;
  private state: SyncState;
  private filename: string;
  constructor(readonly config: SyncConfig) {
    secureEndpoint(config.endpoint);
    if (config.token.length < 32)
      throw new Error("Synknyckeln måste innehålla minst 32 tecken.");
    mkdirSync(config.stateDir, { recursive: true });
    this.filename = path.join(config.stateDir, "sync-state.json");
    this.state = existsSync(this.filename)
      ? JSON.parse(readFileSync(this.filename, "utf8"))
      : { cursor: initialCursor(), days: {}, pending: null, pendingDays: null };
    this.source = new SourceReader(config.database);
  }
  private save() {
    const temp = this.filename + ".tmp";
    writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temp, this.filename);
  }
  async once() {
    // Validate the pending/acknowledged anchor before sending anything after a restore.
    let runtime: RuntimeStatus | undefined;
    if (this.config.runtimeUrl && this.config.runtimeToken) {
      const address = secureEndpoint(this.config.runtimeUrl);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(address.hostname))
        throw new Error("Driftstatus ska hämtas lokalt på kassaservern.");
      try {
        const response = await fetch(address, {
          headers: { Authorization: `Bearer ${this.config.runtimeToken}` },
          signal: AbortSignal.timeout(2000),
          redirect: "error",
        });
        if (response.ok) runtime = (await response.json()) as RuntimeStatus;
      } catch {
        /* Missing runtime status is explicit, never "connected". */
      }
    }
    const snapshot = this.source.capture(
      this.config.installationId,
      this.state.pending?.[0]?.cursor ?? this.state.cursor,
      runtime,
    );
    if (!this.state.pending) {
      snapshot.previous = this.state.cursor;
      const batch = deliveries(snapshot, this.state.days);
      this.state.pending = batch.parts;
      this.state.pendingDays = batch.days;
      this.save();
    }
    let committed = false;
    for (const part of this.state.pending) {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.token}`,
        },
        body: JSON.stringify(part),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      const result = (await response.json()) as {
        committed?: boolean;
        cursor?: Cursor;
        message?: string;
      };
      if (!response.ok)
        throw new Error(
          `Synkning avvisad (${response.status}): ${result.message ?? "Kontrollera anslutningen."}`,
        );
      if (
        result.committed &&
        result.cursor?.sequence === part.cursor.sequence &&
        result.cursor.hash === part.cursor.hash
      )
        committed = true;
    }
    if (!committed)
      throw new Error(
        "Mottagaren har inte bekräftat hela leveransen. Försöker igen.",
      );
    this.state.cursor = this.state.pending[0].cursor;
    this.state.days = this.state.pendingDays!;
    this.state.pending = null;
    this.state.pendingDays = null;
    this.save();
    try {
      await syncManagement(this.config, this.state.cursor.sequence);
    } catch (error) {
      process.stderr.write(`Adminanslutning: ${(error as Error).message}\n`);
    }
    return this.state.cursor;
  }
  close() {
    this.source.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const worker = new SyncWorker({
    database: process.env.ADMIN_SOURCE_DB!,
    stateDir: process.env.ADMIN_SYNC_STATE!,
    installationId: process.env.ADMIN_INSTALLATION_ID!,
    endpoint: process.env.ADMIN_INGEST_URL!,
    token: process.env.ADMIN_SYNC_TOKEN!,
    runtimeUrl: process.env.ADMIN_RUNTIME_URL,
    runtimeToken: process.env.ADMIN_RUNTIME_TOKEN,
  });
  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
  });
  process.on("SIGTERM", () => {
    stopped = true;
  });
  try {
    do {
      try {
        await worker.once();
        process.stdout.write(`Statistik synkad ${new Date().toISOString()}\n`);
      } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`);
      }
      if (process.argv.includes("--once")) break;
      await new Promise((resolve) => setTimeout(resolve, 30000));
    } while (!stopped);
  } finally {
    worker.close();
  }
}
