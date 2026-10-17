import { createClient } from "@supabase/supabase-js";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const url = process.env.SUPABASE_URL,
  secret = process.env.SUPABASE_SERVICE_ROLE_KEY,
  email = process.env.ADMIN_OWNER_EMAIL,
  origin = process.env.PORTAL_ORIGIN;
if (
  !url?.startsWith("https://") ||
  !secret ||
  !email ||
  !origin?.startsWith("https://")
)
  throw new Error(
    "Ange SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_OWNER_EMAIL och PORTAL_ORIGIN via skyddade miljövariabler.",
  );
const output = path.resolve(
  process.env.ADMIN_PROVISION_OUTPUT ??
    path.join(
      process.env.LOCALAPPDATA ?? ".",
      "LagustosaPOS",
      "admin-provision",
      randomUUID(),
    ),
);
mkdirSync(output, { recursive: true });
const client = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const restaurantId = randomUUID(),
  installationId = randomUUID(),
  token = randomBytes(32).toString("base64url");
// Generate the invitation link without sending email; delivery is a separate explicit action.
const { data: invite, error: inviteError } =
  await client.auth.admin.generateLink({
    type: "invite",
    email,
    options: { redirectTo: origin + "/account" },
  });
if (inviteError) throw inviteError;
const { error: r } = await client.from("portal_restaurants").insert({
  id: restaurantId,
  name: process.env.ADMIN_RESTAURANT_NAME ?? "La Gustosa",
});
if (r) throw r;
const { error: m } = await client
  .from("portal_members")
  .insert({
    restaurant_id: restaurantId,
    user_id: invite.user.id,
    role: "owner",
  });
if (m) throw m;
const { error: i } = await client.from("portal_installations").insert({
  id: installationId,
  restaurant_id: restaurantId,
  token_hash: createHash("sha256").update(token).digest("hex"),
});
if (i) throw i;
writeFileSync(
  path.join(output, "installation.json"),
  JSON.stringify(
    {
      restaurantId,
      installationId,
      ingestUrl: url + "/functions/v1/admin-api/ingest",
      token,
      ownerEmail: email,
      invitationLink: invite.properties.action_link,
    },
    null,
    2,
  ),
  { mode: 0o600, flag: "wx" },
);
process.stdout.write(
  `Installationsuppgifter sparade lokalt: ${output}\nIngen e-post har skickats.\n`,
);
