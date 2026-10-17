import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { KassaService } from "./service";

/** Optional, loopback-only telemetry. Does not create a POS login or report event. */
export function registerAdminRuntime(
  app: FastifyInstance,
  service: KassaService,
  token?: string,
) {
  if (!token) return;
  if (token.length < 32)
    throw new Error("ADMIN_RUNTIME_TOKEN måste vara minst 32 tecken.");
  app.get("/api/v1/admin-sync/runtime", async (request, reply) => {
    const actual = Buffer.from(
      request.headers.authorization?.replace(/^Bearer /, "") ?? "",
    );
    const expected = Buffer.from(token);
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip) ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      return reply.code(403).send({ message: "Åtkomst nekad." });
    return { at: service.timestamp(), devices: service.deviceConnections() };
  });
}
