import type { FastifyInstance, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { z } from "zod";
import { newSecret, passwordMatches, totpStep } from "./auth";

type Attempts = { failures: number; blockedUntil: number };
export type LocalAuthConfig = {
  email: string;
  passwordHash: string;
  secret: string;
  enrolled: boolean;
  requireMfa?: boolean;
  lastTotpStep?: number;
  passwordAttempts?: Attempts;
  mfaAttempts?: Attempts;
};
type Session = {
  stage: "password" | "verified";
  expires: number;
  pending?: { secret: string; expires: number };
};
const cookieName = "eleva_admin_local";
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();

/** Single-account, loopback-only test auth. Production uses Supabase Auth + AAL2 RLS. */
export function registerLocalAuth(
  app: FastifyInstance,
  config: LocalAuthConfig,
  save: (next: LocalAuthConfig) => void,
  now: () => number = Date.now,
) {
  const sessions = new Map<string, Session>();
  const required = () => config.requireMfa !== false;
  const update = (patch: Partial<LocalAuthConfig>) => {
    const next = { ...config, ...patch };
    save(next); // Persist replay/rate limits before issuing access; disk failure fails closed.
    Object.assign(config, next);
  };
  const current = (token?: string) => {
    for (const [key, value] of sessions)
      if (value.expires <= now()) sessions.delete(key);
    return sessions.get(token ?? "");
  };
  const issue = (reply: FastifyReply, stage: Session["stage"]) => {
    const token = randomBytes(32).toString("base64url");
    const seconds = stage === "password" ? 600 : 8 * 3600;
    current();
    while (sessions.size >= 32) sessions.delete(sessions.keys().next().value!);
    sessions.set(token, { stage, expires: now() + seconds * 1000 });
    reply.setCookie(cookieName, token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      maxAge: seconds,
    });
  };
  const blocked = (
    key: "passwordAttempts" | "mfaAttempts",
    reply: FastifyReply,
  ) => {
    const wait = Math.ceil(((config[key]?.blockedUntil ?? 0) - now()) / 1000);
    if (wait <= 0) return false;
    reply
      .header("Retry-After", wait)
      .code(429)
      .send({
        message: "För många försök. Vänta 15 minuter innan du försöker igen.",
      });
    return true;
  };
  const fail = (key: "passwordAttempts" | "mfaAttempts") => {
    const old = config[key];
    const failures =
      (old && (!old.blockedUntil || old.blockedUntil > now())
        ? old.failures
        : 0) + 1;
    update({
      [key]: { failures, blockedUntil: failures >= 5 ? now() + 900000 : 0 },
    });
  };
  const passwordOk = (
    password: string,
    reply: FastifyReply,
    email = config.email,
  ) => {
    if (blocked("passwordAttempts", reply)) return false;
    // Always compute the password check, including unknown email addresses.
    const matches = passwordMatches(password, config.passwordHash);
    if (!matches || email !== config.email) {
      fail("passwordAttempts");
      reply.code(401).send({ message: "Fel e-post eller lösenord." });
      return false;
    }
    update({ passwordAttempts: { failures: 0, blockedUntil: 0 } });
    return true;
  };
  const info = (entry: Session) => ({
    email: config.email,
    verified: entry.stage === "verified",
    enrolled: config.enrolled,
    local: true,
    mfaRequired: required(),
  });

  app.post("/api/auth/login", { bodyLimit: 4096 }, async (request, reply) => {
    const input = z
      .object({ email: z.string().max(160), password: z.string().max(256) })
      .strict()
      .parse(request.body);
    if (!passwordOk(input.password, reply, input.email)) return;
    sessions.delete(request.cookies[cookieName] ?? "");
    issue(reply, required() ? "password" : "verified");
    return { email: config.email, enrolled: config.enrolled };
  });
  app.get("/api/auth/session", async (request, reply) => {
    const entry = current(request.cookies[cookieName]);
    return entry ? info(entry) : reply.code(401).send({ message: "Logga in." });
  });
  app.post("/api/auth/enroll", { bodyLimit: 4096 }, async (request, reply) => {
    const entry = current(request.cookies[cookieName]);
    if (
      !entry ||
      (required() && (entry.stage !== "password" || config.enrolled))
    )
      return reply
        .code(403)
        .send({
          message: "Logga in för att konfigurera Google Authenticator.",
        });
    const input = z
      .object({ password: z.string().max(256).optional() })
      .strict()
      .parse(request.body);
    let secret = config.secret;
    if (!required()) {
      // Opting in from a test session requires a fresh password and a new, session-bound key.
      if (!passwordOk(input.password ?? "", reply)) return;
      secret =
        entry.pending && entry.pending.expires > now()
          ? entry.pending.secret
          : newSecret();
      entry.pending = { secret, expires: now() + 600000 };
    }
    const uri = `otpauth://totp/Eleva%20Admin:${encodeURIComponent(config.email)}?secret=${secret}&issuer=Eleva%20Admin&algorithm=SHA1&digits=6&period=30`;
    return { secret, qr: await QRCode.toDataURL(uri) };
  });
  app.post("/api/auth/enroll/cancel", { bodyLimit: 4096 }, async (request) => {
    const entry = current(request.cookies[cookieName]);
    if (entry) delete entry.pending;
    return { ok: true };
  });
  app.post("/api/auth/verify", { bodyLimit: 4096 }, async (request, reply) => {
    const token = request.cookies[cookieName] ?? "",
      entry = current(token);
    if (!entry)
      return reply
        .code(401)
        .send({ message: "Inloggningen har gått ut. Logga in igen." });
    const optIn = !required();
    if (
      optIn
        ? !entry.pending || entry.pending.expires <= now()
        : entry.stage !== "password"
    )
      return reply
        .code(403)
        .send({ message: "Påbörja en ny verifiering innan du anger koden." });
    if (blocked("mfaAttempts", reply)) return;
    const parsed = codeSchema.safeParse(request.body);
    const secret = optIn ? entry.pending!.secret : config.secret;
    const step = parsed.success
      ? totpStep(secret, parsed.data.code, now())
      : null;
    if (step === null || (!optIn && step <= (config.lastTotpStep ?? -1))) {
      fail("mfaAttempts");
      return reply
        .code(401)
        .send({
          message:
            "Koden är felaktig, har gått ut eller har redan använts. Vänta på en ny kod i Google Authenticator.",
        });
    }
    const newEnrollment = optIn || !config.enrolled;
    update({
      secret,
      enrolled: true,
      requireMfa: true,
      lastTotpStep: step,
      mfaAttempts: { failures: 0, blockedUntil: 0 },
    });
    // Enabling MFA invalidates every previous password-only session, including other browsers.
    if (newEnrollment) sessions.clear();
    else sessions.delete(token);
    issue(reply, "verified");
    return { ok: true };
  });
  app.post("/api/auth/logout", async (request, reply) => {
    sessions.delete(request.cookies[cookieName] ?? "");
    reply.clearCookie(cookieName, { path: "/" });
    return { ok: true };
  });
  return {
    required,
    verified: (token?: string) => current(token)?.stage === "verified",
  };
}
