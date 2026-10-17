import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deliverySchema, type Delivery, type PortalDay } from "../shared/model";
import type { PortalMeta } from "../shared/analytics";
export const hashText = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Local PostgreSQL runs the exact cloud migration and ingestion transaction. */
export async function replica(directory?: string) {
  const db = new PGlite(directory);
  await db.waitReady;
  const exists = await db.query(
    "select to_regclass('public.portal_installations') as name",
  );
  if (!(exists.rows[0] as { name: string | null }).name) {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
      grant usage on schema auth to authenticated,anon; grant execute on function auth.uid(),auth.jwt() to authenticated,anon;`);
    await db.exec(
      readFileSync(
        new URL(
          "../supabase/migrations/202610170001_portal.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }
  return db;
}
export async function provision(
  db: PGlite,
  restaurantId: string,
  installationId: string,
  token: string,
  userId: string,
) {
  await db.query("insert into auth.users values($1) on conflict do nothing", [
    userId,
  ]);
  await db.query(
    "insert into portal_restaurants values($1,'La Gustosa') on conflict do nothing",
    [restaurantId],
  );
  await db.query(
    "insert into portal_members values($1,$2,true) on conflict do nothing",
    [restaurantId, userId],
  );
  await db.query(
    "insert into portal_installations(id,restaurant_id,token_hash) values($1,$2,$3) on conflict do nothing",
    [installationId, restaurantId, hashText(token)],
  );
}
export async function ingest(db: PGlite, input: unknown, token: string) {
  const body = deliverySchema.parse(input);
  const result = await db.query<{
    result: { committed: boolean; cursor?: Delivery["cursor"] };
  }>("select portal_ingest($1::jsonb,$2,$3) as result", [
    JSON.stringify(body),
    hashText(token),
    hashText(JSON.stringify(body.days)),
  ]);
  return result.rows[0].result;
}
export async function readReplica(
  db: PGlite,
  installationId: string,
): Promise<{ meta: PortalMeta; days: PortalDay[] } | null> {
  const result = await db.query<{
    metadata: PortalMeta | null;
    received_at: string;
  }>(
    "select metadata,received_at from portal_installations where id=$1 and revoked_at is null",
    [installationId],
  );
  const row = result.rows[0];
  if (!row?.metadata) return null;
  const days = (
    await db.query<{ payload: PortalDay }>(
      "select payload from portal_days where installation_id=$1 order by date",
      [installationId],
    )
  ).rows.map((row) => row.payload);
  return {
    meta: {
      ...row.metadata,
      receivedAt: new Date(row.received_at).toISOString(),
      currentDay: days.find((day) => day.status === "open")?.date ?? null,
    },
    days,
  };
}
