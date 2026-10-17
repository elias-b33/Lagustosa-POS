import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { managementCommandSchema } from "../../shared/backoffice-command";
import type { SyncConfig } from "./worker";
import type {
  CommandEnvelope,
  CommandResult,
  ManagementSnapshot,
} from "../../shared/backoffice";
const request = async <T>(
  url: URL,
  token: string,
  body?: unknown,
): Promise<T> => {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(`Adminanslutningen svarade ${response.status}.`);
  return response.json() as Promise<T>;
};
/** Commands stay in the receiver's queue until the POS has durably saved their result. */
export async function syncManagement(config: SyncConfig, sequence: number) {
  if (!config.runtimeUrl || !config.runtimeToken) return;
  const runtime = new URL(config.runtimeUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(runtime.hostname))
    throw new Error("Adminanslutningen måste vara lokal.");
  const state = await request<{ source: string; snapshot: ManagementSnapshot }>(
    new URL("management", runtime),
    config.runtimeToken,
  );
  const source = createHash("sha256")
    .update(path.resolve(config.database).replaceAll("\\", "/").toLowerCase())
    .digest("hex");
  if (state.source !== source)
    throw new Error("Adminanslutningen hör till en annan kassadatabas.");
  const target = new URL("management-exchange", config.endpoint);
  const exchange = (
    snapshot: ManagementSnapshot | null,
    results: CommandResult[],
  ) =>
    request<CommandEnvelope[]>(target, config.token, {
      installationId: config.installationId,
      snapshot,
      results,
    });
  const commands = await exchange(
    state.snapshot.sequence <= sequence ? state.snapshot : null,
    [],
  );
  for (const envelope of commands) {
    const valid = managementCommandSchema.safeParse(envelope.command);
    // A member can call the database RPC directly. Invalid bodies must not block the queue.
    if (!valid.success) {
      await exchange(null, [
        {
          id: z.string().uuid().parse(envelope.command.id),
          status: "rejected",
          message: "Ändringen innehåller ogiltiga uppgifter och har avvisats.",
          at: new Date().toISOString(),
        },
      ]);
      continue;
    }
    const result = await request<CommandResult>(
      new URL("commands", runtime),
      config.runtimeToken,
      { ...envelope, source },
    );
    await exchange(null, [result]);
  }
  return commands.length;
}
