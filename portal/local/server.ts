import Fastify from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { z } from "zod";
import { replica, provision, ingest, readReplica } from "./replica";
import {
  newSecret,
  passwordHash,
  passwordMatches,
  totp,
  verifyTotp,
} from "./auth";
import { analytics, exportCsv, receiptPage } from "../shared/analytics";
import { querySchema } from "../shared/model";
import { SyncWorker } from "../sync/worker";
import { managementData, queueCommand, exchange } from "./management";
import { archivePage } from "../shared/archive";

const directory = path.resolve(
  process.env.ADMIN_LOCAL_DIR ??
    path.join(process.env.LOCALAPPDATA ?? ".", "LagustosaPOS", "eleva-admin"),
);
mkdirSync(directory, { recursive: true });
const configFile = path.join(directory, "local-account.json");
type Config = {
  restaurantId: string;
  installationId: string;
  userId: string;
  token: string;
  email: string;
  passwordHash: string;
  secret: string;
  enrolled: boolean;
  requireMfa?: boolean;
};
let config: Config;
if (existsSync(configFile))
  config = JSON.parse(readFileSync(configFile, "utf8"));
else {
  const password = "Eleva-" + randomBytes(9).toString("base64url") + "!";
  config = {
    restaurantId: randomUUID(),
    installationId: randomUUID(),
    userId: randomUUID(),
    token: randomBytes(32).toString("base64url"),
    email: "ansvarig@eleva.test",
    passwordHash: passwordHash(password),
    secret: newSecret(),
    enrolled: false,
  };
  writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  writeFileSync(
    path.join(directory, "inloggning.txt"),
    `Lokal testportal\nE-post: ${config.email}\nLösenord: ${password}\nTvåstegskod: kör npm run admin:code\n`,
    { mode: 0o600 },
  );
}
// This setting belongs only to this loopback test server, never to Supabase Auth.
if (process.env.ADMIN_LOCAL_REQUIRE_MFA !== undefined) {
  config.requireMfa =
    z.enum(["true", "false"]).parse(process.env.ADMIN_LOCAL_REQUIRE_MFA) ===
    "true";
  writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
}
const requireMfa = config.requireMfa !== false;
const credentialsFile = path.join(directory, "inloggning.txt");
if (existsSync(credentialsFile)) {
  const text = readFileSync(credentialsFile, "utf8").replace(
    /Tvåsteg(?:skod|sverifiering):[^\r\n]*/g,
    requireMfa
      ? "Tvåstegskod: kör npm run admin:code"
      : "Tvåstegsverifiering: avstängd endast i denna lokala testportal",
  );
  writeFileSync(credentialsFile, text, { mode: 0o600 });
}
if (process.argv.includes("--code")) {
  process.stdout.write(
    requireMfa
      ? `Aktuell lokal testkod: ${totp(config.secret)}\n`
      : "Tvåstegsverifieringen är avstängd i denna lokala testportal. Logga in med e-post och lösenord.\n",
  );
  process.exit(0);
}
const port = Number(process.env.ADMIN_LOCAL_PORT ?? 5194);
const db = await replica(path.join(directory, "replica"));
await provision(
  db,
  config.restaurantId,
  config.installationId,
  config.token,
  config.userId,
);
const app = Fastify({ bodyLimit: 8_000_000, logger: false });
await app.register(cookie);
const sessions = new Map<
  string,
  { stage: "password" | "verified"; expires: number; lastCode?: string }
>();
let failures = 0,
  blockedUntil = 0;
app.addHook("onRequest", async (request, reply) => {
  reply
    .header("Cache-Control", "no-store")
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY")
    .header("Referrer-Policy", "no-referrer");
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
  );
  const hostname = (request.headers.host ?? "").split(":")[0];
  if (!["127.0.0.1", "localhost"].includes(hostname))
    return reply
      .code(403)
      .send({ message: "Testportalen är endast tillgänglig lokalt." });
  if (!["GET", "HEAD"].includes(request.method)) {
    const origin = request.headers.origin;
    if (
      origin &&
      ![
        "http://127.0.0.1:5193",
        "http://localhost:5193",
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
      ].includes(origin)
    )
      return reply.code(403).send({ message: "Åtkomst nekad." });
    if (request.headers["sec-fetch-site"] === "cross-site")
      return reply.code(403).send({ message: "Åtkomst nekad." });
  }
});
app.setErrorHandler((error, _request, reply) => {
  reply.code(error instanceof z.ZodError ? 400 : 409).send({
    message:
      error instanceof z.ZodError
        ? "Kontrollera uppgifterna."
        : (error as Error).message,
  });
});
app.post("/api/auth/login", async (request, reply) => {
  if (Date.now() < blockedUntil)
    return reply
      .code(429)
      .send({ message: "För många försök. Vänta 15 minuter." });
  const input = z
    .object({ email: z.string().max(160), password: z.string().max(256) })
    .strict()
    .parse(request.body);
  if (
    input.email !== config.email ||
    !passwordMatches(input.password, config.passwordHash)
  ) {
    if (++failures >= 5) {
      blockedUntil = Date.now() + 900000;
      failures = 0;
    }
    return reply.code(401).send({ message: "Fel e-post eller lösenord." });
  }
  failures = 0;
  sessions.delete(request.cookies.eleva_admin_local ?? "");
  const token = randomBytes(32).toString("base64url");
  const lifetime = requireMfa ? 600 : 8 * 3600;
  sessions.set(token, {
    stage: requireMfa ? "password" : "verified",
    expires: Date.now() + lifetime * 1000,
  });
  reply.setCookie("eleva_admin_local", token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    maxAge: lifetime,
  });
  return { email: config.email, enrolled: config.enrolled };
});
app.get("/api/auth/session", async (request, reply) => {
  const session = sessions.get(request.cookies.eleva_admin_local ?? "");
  if (!session || session.expires < Date.now())
    return reply.code(401).send({ message: "Logga in." });
  return {
    email: config.email,
    verified: session.stage === "verified",
    enrolled: config.enrolled,
    local: true,
    mfaRequired: requireMfa,
  };
});
app.get("/api/auth/enroll", async (request, reply) => {
  if (!requireMfa)
    return reply.code(403).send({
      message: "Tvåstegsverifieringen är avstängd i detta lokala test.",
    });
  const session = sessions.get(request.cookies.eleva_admin_local ?? "");
  if (!session || session.expires < Date.now() || config.enrolled)
    return reply
      .code(403)
      .send({ message: "Logga in för att konfigurera tvåstegsverifiering." });
  const uri = `otpauth://totp/Eleva%20Admin:${encodeURIComponent(config.email)}?secret=${config.secret}&issuer=Eleva%20Admin`;
  return { secret: config.secret, qr: await QRCode.toDataURL(uri) };
});
app.post("/api/auth/verify", async (request, reply) => {
  if (!requireMfa)
    return reply.code(403).send({
      message: "Logga in med e-post och lösenord i detta lokala test.",
    });
  const token = request.cookies.eleva_admin_local ?? "",
    session = sessions.get(token);
  if (!session || session.expires < Date.now())
    return reply.code(401).send({ message: "Logga in igen." });
  if (Date.now() < blockedUntil)
    return reply
      .code(429)
      .send({ message: "För många kodförsök. Vänta 15 minuter." });
  const { code } = z
    .object({ code: z.string().max(6) })
    .strict()
    .parse(request.body);
  if (!verifyTotp(config.secret, code) || session.lastCode === code) {
    if (++failures >= 5) {
      blockedUntil = Date.now() + 900000;
      failures = 0;
    }
    return reply.code(401).send({ message: "Koden stämmer inte." });
  }
  failures = 0;
  sessions.delete(token);
  const next = randomBytes(32).toString("base64url");
  sessions.set(next, {
    stage: "verified",
    expires: Date.now() + 8 * 3600000,
    lastCode: code,
  });
  config.enrolled = true;
  writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  reply.setCookie("eleva_admin_local", next, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    maxAge: 8 * 3600,
  });
  return { ok: true };
});
app.post("/api/auth/logout", async (request, reply) => {
  sessions.delete(request.cookies.eleva_admin_local ?? "");
  reply.clearCookie("eleva_admin_local", { path: "/" });
  return { ok: true };
});
app.post("/api/ingest", async (request, reply) => {
  try {
    return await ingest(
      db,
      request.body,
      request.headers.authorization?.replace(/^Bearer /, "") ?? "",
    );
  } catch (error) {
    return reply
      .code((error as Error).message.includes("UNAUTHORIZED") ? 401 : 409)
      .send({ message: (error as Error).message });
  }
});
app.post("/api/management-exchange", async (request, reply) => {
  const body = z
    .object({
      installationId: z.literal(config.installationId),
      snapshot: z.record(z.string(), z.unknown()).nullable(),
      results: z
        .array(
          z
            .object({
              id: z.string().uuid(),
              status: z.enum(["applied", "conflict", "rejected"]),
              message: z.string().max(1000),
              at: z.string().datetime(),
            })
            .strict(),
        )
        .max(20),
    })
    .strict()
    .parse(request.body);
  return exchange(
    db,
    body.installationId,
    request.headers.authorization?.replace(/^Bearer /, "") ?? "",
    body.snapshot as never,
    body.results,
  );
});
app.post("/api/commands", async (request, reply) => {
  const currentSession = sessions.get(request.cookies.eleva_admin_local ?? "");
  if (
    !currentSession ||
    currentSession.stage !== "verified" ||
    currentSession.expires < Date.now()
  )
    return reply.code(401).send({ message: "Logga in för att fortsätta." });
  const result = await queueCommand(
    db,
    config.installationId,
    config.userId,
    request.body,
  );
  void sync().then(() => sync());
  return result;
});
app.get("/api/:route", async (request, reply) => {
  const session = sessions.get(request.cookies.eleva_admin_local ?? "");
  if (!session || session.stage !== "verified" || session.expires < Date.now())
    return reply.code(401).send({
      message: requireMfa
        ? "Logga in med tvåstegsverifiering."
        : "Logga in med e-post och lösenord.",
    });
  if ((request.params as { route: string }).route === "management")
    return managementData(db, config.installationId);
  const current = await readReplica(db, config.installationId);
  if (!current)
    return reply
      .code(503)
      .send({ message: "Väntar på första överföringen från kassan." });
  const { route } = request.params as { route: string };
  if (route === "meta") return { ...current.meta, local: true };
  const q = request.query as Record<string, string>;
  const query = querySchema.parse({
    from: q.from,
    to: q.to,
    ...(q.registerId ? { registerId: q.registerId } : {}),
  });
  if (["history", "reports", "logs"].includes(route))
    return archivePage(current.days, {
      ...query,
      view: route,
      search: q.search?.slice(0, 160),
      status: q.status,
      page: Number(q.page) || 1,
    });
  if (route === "receipts")
    return receiptPage(current.days, {
      ...query,
      search: q.search?.slice(0, 160),
      kind: q.kind,
      page: Math.max(1, Number(q.page) || 1),
    });
  const result = analytics(current.days, query);
  if (route === "export")
    return reply
      .type("text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        'attachment; filename="eleva-statistik-test.csv"',
      )
      .send(exportCsv(current.days, query, q));
  if (route !== "analytics")
    return reply.code(404).send({ message: "Sidan finns inte." });
  return result;
});
const web = path.resolve("dist/portal");
if (existsSync(web)) {
  await app.register(staticFiles, { root: web });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith("/api/") || request.method !== "GET"
      ? reply.code(404).send({ message: "Sidan finns inte." })
      : reply.sendFile("index.html"),
  );
}
await app.listen({ host: "127.0.0.1", port });
let worker: SyncWorker | undefined;
const sourceFile = path.join(directory, "source.json");
const savedSource = existsSync(sourceFile)
  ? (JSON.parse(readFileSync(sourceFile, "utf8")).database as string)
  : undefined;
const sourceDatabase = process.env.ADMIN_SOURCE_DB ?? savedSource;
const bridgeFile = path.join(directory, "bridge.json");
const bridge = existsSync(bridgeFile)
  ? JSON.parse(readFileSync(bridgeFile, "utf8"))
  : {};
if (
  savedSource &&
  sourceDatabase &&
  path.resolve(savedSource) !== path.resolve(sourceDatabase)
)
  throw new Error(
    "Denna portal hör till en annan kassadatabas. Använd en separat ADMIN_LOCAL_DIR för en annan installation.",
  );
if (sourceDatabase) {
  if (!savedSource)
    writeFileSync(
      sourceFile,
      JSON.stringify({ database: sourceDatabase }, null, 2),
      { mode: 0o600 },
    );
  worker = new SyncWorker({
    database: sourceDatabase,
    stateDir: path.join(directory, "sync"),
    installationId: config.installationId,
    endpoint: `http://127.0.0.1:${port}/api/ingest`,
    token: config.token,
    runtimeUrl: process.env.ADMIN_RUNTIME_URL ?? bridge.runtimeUrl,
    runtimeToken: process.env.ADMIN_RUNTIME_TOKEN ?? bridge.runtimeToken,
  });
}
let syncing = false;
const sync = async () => {
  if (syncing || !worker) return;
  syncing = true;
  try {
    await worker.once();
  } catch (error) {
    process.stderr.write(`Synkning: ${(error as Error).message}\n`);
  } finally {
    syncing = false;
  }
};
await sync();
const timer = setInterval(() => void sync(), 30000);
timer.unref();
process.stdout.write(
  `Eleva Admin: http://127.0.0.1:${port}/\nInloggning: ${path.join(directory, "inloggning.txt")}\n`,
);
const shutdown = async () => {
  clearInterval(timer);
  await app.close();
  worker?.close();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
