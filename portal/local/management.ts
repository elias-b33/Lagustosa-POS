import type { PGlite } from "@electric-sql/pglite";
import type {
  ManagementData,
  ManagementSnapshot,
  CommandEnvelope,
  CommandResult,
} from "../../shared/backoffice";
import { managementCommandSchema } from "../../shared/backoffice";
import { hashText } from "./replica";
export async function managementData(
  db: PGlite,
  installationId: string,
): Promise<ManagementData> {
  const snapshots = await db.query<{ payload: ManagementSnapshot }>(
    "select payload from portal_management where installation_id=$1",
    [installationId],
  );
  const snapshot = snapshots.rows[0]?.payload ?? null;
  const rows = await db.query<{
    body: CommandEnvelope["command"];
    created_by: string;
    status: ManagementData["commands"][number]["status"];
    created_at: string;
    result: CommandResult | null;
  }>(
    "select body,created_by,status,created_at,result from portal_commands where installation_id=$1 order by created_at desc,id desc limit 100",
    [installationId],
  );
  return {
    snapshot,
    commands: rows.rows.map((row) => ({
      command: row.body,
      actorId: row.created_by,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      result: row.result,
    })),
    canManage: true,
    role: "owner",
    connected: Boolean(
      snapshot && Date.now() - Date.parse(snapshot.generatedAt) < 120000,
    ),
  };
}
export async function queueCommand(
  db: PGlite,
  installationId: string,
  userId: string,
  input: unknown,
) {
  const command = managementCommandSchema.parse(input);
  await db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: userId, aal: "aal2" }),
    ]);
    await tx.query("select portal_queue_command($1,$2::jsonb)", [
      installationId,
      JSON.stringify(command),
    ]);
  });
  return { id: command.id, status: "queued" };
}
export async function exchange(
  db: PGlite,
  installationId: string,
  token: string,
  snapshot: ManagementSnapshot | null,
  results: CommandResult[],
) {
  const data = await db.query<{ commands: CommandEnvelope[] }>(
    "select portal_management_exchange($1,$2,$3::jsonb,$4::jsonb) as commands",
    [
      installationId,
      hashText(token),
      snapshot === null ? null : JSON.stringify(snapshot),
      JSON.stringify(results),
    ],
  );
  return data.rows[0].commands;
}
