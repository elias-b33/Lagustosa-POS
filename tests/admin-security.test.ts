import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { randomUUID } from "node:crypto";
import {
  registerLocalAuth,
  type LocalAuthConfig,
} from "../portal/local/auth-routes";
import {
  newSecret,
  passwordHash,
  passwordMatches,
  totp,
} from "../portal/local/auth";
import { boundedJson, selectInstallation } from "../portal/shared/security";
import { validatePublicConfig } from "../portal/shared/public-config";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const password = "Testlösenord-authenticator-2026";
async function fixture(
  mfa = true,
  saved?: LocalAuthConfig,
  time = Date.parse("2026-10-17T20:00:00Z"),
) {
  let now = time;
  let disk: LocalAuthConfig = saved
    ? structuredClone(saved)
    : {
        email: "audit@eleva.test",
        passwordHash: passwordHash(password),
        secret: newSecret(),
        enrolled: false,
        requireMfa: mfa,
      };
  const config = structuredClone(disk);
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  const auth = registerLocalAuth(
    app,
    config,
    (next) => {
      disk = structuredClone(next);
    },
    () => now,
  );
  app.get("/protected", (request, reply) =>
    auth.verified(request.cookies.eleva_admin_local)
      ? { ok: true }
      : reply.code(401).send({ ok: false }),
  );
  const post = (route: string, body: Record<string, unknown>, session?: string) =>
    app.inject({
      method: "POST",
      url: "/api/auth/" + route,
      headers: session ? { cookie: session } : {},
      payload: body,
    });
  const login = async () => {
    const result = await post("login", { email: config.email, password });
    expect(result.statusCode).toBe(200);
    return String(result.headers["set-cookie"]).split(";")[0];
  };
  const access = (session: string) =>
    app.inject({ url: "/protected", headers: { cookie: session } });
  const code = () => totp(config.secret, now);
  return {
    app,
    config,
    post,
    login,
    access,
    code,
    disk: () => disk,
    time: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Säker inloggning med Google Authenticator", () => {
  it("kräver båda faktorerna, roterar sessionskakan och skyddar den kopplade nyckeln", async () => {
    const f = await fixture(),
      first = await f.login();
    expect((await f.access(first)).statusCode).toBe(401);
    expect((await f.post("enroll", {})).statusCode).toBe(403);
    const setup = await f.post("enroll", {}, first);
    expect(setup.json().qr).toMatch(/^data:image\/png;base64,/);
    expect(setup.json().secret).toBe(f.config.secret);
    const confirmed = await f.post("verify", { code: f.code() }, first);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.headers["set-cookie"]).toContain("HttpOnly");
    expect(confirmed.headers["set-cookie"]).toContain("SameSite=Strict");
    const verified = String(confirmed.headers["set-cookie"]).split(";")[0];
    expect(verified).not.toBe(first);
    expect((await f.access(first)).statusCode).toBe(401);
    expect((await f.access(verified)).statusCode).toBe(200);
    expect((await f.post("enroll", {}, verified)).statusCode).toBe(403);
    expect((await f.post("enroll", {}, await f.login())).statusCode).toBe(403);
  });
  it("avvisar återanvända koder även efter ny inloggning, samtidig begäran och serveromstart", async () => {
    const f = await fixture();
    f.config.enrolled = true;
    const a = await f.login(),
      b = await f.login(),
      code = f.code();
    const results = await Promise.all([
      f.post("verify", { code }, a),
      f.post("verify", { code }, b),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const restarted = await fixture(true, f.disk(), f.time());
    expect(
      (await restarted.post("verify", { code }, await restarted.login()))
        .statusCode,
    ).toBe(401);
    restarted.advance(30000);
    expect(
      (
        await restarted.post(
          "verify",
          { code: restarted.code() },
          await restarted.login(),
        )
      ).statusCode,
    ).toBe(200);
  });
  it("lösenordsinloggning kan inte nollställa spärren för felaktiga mobilkoder", async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++)
      expect(
        (await f.post("verify", { code: "bad" }, await f.login())).statusCode,
      ).toBe(401);
    expect(
      (await f.post("verify", { code: f.code() }, await f.login())).statusCode,
    ).toBe(429);
    const restarted = await fixture(true, f.disk(), f.time());
    expect(
      (
        await restarted.post(
          "verify",
          { code: restarted.code() },
          await restarted.login(),
        )
      ).statusCode,
    ).toBe(429);
    restarted.advance(900001);
    expect(
      (
        await restarted.post(
          "verify",
          { code: restarted.code() },
          await restarted.login(),
        )
      ).statusCode,
    ).toBe(200);
  });
  it("begränsar lösenordsgissning över omstart och gör utloggade/utgångna sessioner obrukbara", async () => {
    const f = await fixture(false),
      logged = await f.login();
    await f.post("logout", {}, logged);
    expect((await f.access(logged)).statusCode).toBe(401);
    const expires = await f.login();
    f.advance(8 * 3600000);
    expect((await f.access(expires)).statusCode).toBe(401);
    for (let i = 0; i < 5; i++)
      await f.post("login", { email: f.config.email, password: "wrong" });
    const restarted = await fixture(false, f.disk(), f.time());
    const result = await restarted.post("login", {
      email: f.config.email,
      password,
    });
    expect(result.statusCode).toBe(429);
    expect(result.headers["retry-after"]).toBe("900");
  });
  it("slår på MFA först efter lösenord och ny mobilkod, och avslutar övriga testsessioner", async () => {
    const f = await fixture(false),
      a = await f.login(),
      b = await f.login();
    expect((await f.access(a)).statusCode).toBe(200);
    expect((await f.post("enroll", {}, a)).statusCode).toBe(401);
    const original = f.config.secret;
    const setup = await f.post("enroll", { password }, a);
    const secret = setup.json().secret;
    expect(secret).not.toBe(original);
    expect(f.config.requireMfa).toBe(false);
    expect(
      (await f.post("verify", { code: totp(secret, f.time()) }, b)).statusCode,
    ).toBe(403);
    const result = await f.post("verify", { code: totp(secret, f.time()) }, a);
    expect(result.statusCode).toBe(200);
    expect(f.disk().requireMfa).toBe(true);
    expect(f.disk().secret).toBe(secret);
    expect((await f.access(a)).statusCode).toBe(401);
    expect((await f.access(b)).statusCode).toBe(401);
    expect((await f.access(await f.login())).statusCode).toBe(401);
  });
  it("avbruten eller för gammal koppling behåller testläget och kan inte användas", async () => {
    const f = await fixture(false),
      a = await f.login();
    let setup = (await f.post("enroll", { password }, a)).json();
    await f.post("enroll/cancel", {}, a);
    expect(
      (await f.post("verify", { code: totp(setup.secret, f.time()) }, a))
        .statusCode,
    ).toBe(403);
    setup = (await f.post("enroll", { password }, a)).json();
    f.advance(600001);
    expect(
      (await f.post("verify", { code: totp(setup.secret, f.time()) }, a))
        .statusCode,
    ).toBe(403);
    expect(f.config.requireMfa).toBe(false);
    expect((await f.access(a)).statusCode).toBe(200);
  });
  it("tillåter bara begränsad klockskillnad och kortlivad första inloggning", async () => {
    const f = await fixture(),
      a = await f.login();
    expect(
      (
        await f.post(
          "verify",
          { code: totp(f.config.secret, f.time() - 90000) },
          a,
        )
      ).statusCode,
    ).toBe(401);
    f.advance(600000);
    expect((await f.post("verify", { code: f.code() }, a)).statusCode).toBe(
      401,
    );
    expect(
      (
        await f.post(
          "verify",
          { code: totp(f.config.secret, f.time() + 30000) },
          await f.login(),
        )
      ).statusCode,
    ).toBe(200);
  });
  it("avvisar felaktigt lagrad lösenordshash utan jämförelsefel", () => {
    expect(passwordMatches(password, "broken")).toBe(false);
    expect(passwordMatches(password, passwordHash(password))).toBe(true);
    expect(passwordMatches("wrong", passwordHash(password))).toBe(false);
  });
});

describe("Molnportalens gränser", () => {
  it("väljer aldrig automatiskt en annan installation när en viss adress begärts", () => {
    const own = { id: randomUUID() },
      other = randomUUID();
    expect(selectInstallation([own], other)).toBeNull();
    expect(selectInstallation([own], "")).toBeNull();
    expect(selectInstallation([own], own.id)).toBe(own);
    expect(selectInstallation([own], null)).toBe(own);
    expect(selectInstallation([own, { id: other }], null)).toBeNull();
  });
  it("begränsar strömmande JSON i byte innan hela begäran har lästs", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://example.test", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    await expect(boundedJson(request, 10)).rejects.toMatchObject({
      status: 413,
    });
    expect(cancelled).toBe(true);
    const normal = () =>
      new Request("https://example.test", {
        method: "POST",
        body: JSON.stringify({ name: "ÅÄÖ" }),
      });
    await expect(boundedJson(normal(), 100)).resolves.toEqual({ name: "ÅÄÖ" });
    await expect(boundedJson(normal(), 14)).rejects.toMatchObject({
      status: 413,
    });
    await expect(
      boundedJson(
        new Request("https://example.test", { method: "POST", body: "{" }),
        10,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("stoppar serverhemligheter i alla webbbyggen och accepterar bara publika nycklar", () => {
    const jwt = (role: string) =>
      `e30.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`;
    expect(() => validatePublicConfig()).not.toThrow();
    expect(() => validatePublicConfig(undefined, undefined, true)).toThrow();
    for (const key of [
      "sb_secret_do-not-expose",
      jwt("service_role"),
      "malformed",
    ])
      expect(() =>
        validatePublicConfig("https://example.supabase.co", key),
      ).toThrow();
    expect(() =>
      validatePublicConfig("https://example.supabase.co", jwt("anon")),
    ).not.toThrow();
    expect(() =>
      validatePublicConfig(
        "https://example.supabase.co",
        "sb_publishable_test",
      ),
    ).not.toThrow();
    expect(() =>
      validatePublicConfig("http://example.supabase.co", jwt("anon")),
    ).toThrow();
    expect(() =>
      validatePublicConfig("http://127.0.0.1:54321", jwt("anon"), false, true),
    ).not.toThrow();
    expect(() =>
      validatePublicConfig("https://secret@example.supabase.co", jwt("anon")),
    ).toThrow();
  });
});
