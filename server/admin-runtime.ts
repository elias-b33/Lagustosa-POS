import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { KassaService } from "./service";
import { digest } from "./db";
import { managementSnapshot, applyManagement } from "./backoffice";
import { managementCommandSchema } from "../shared/backoffice";
import { z } from "zod";

/** Loopback-only bridge; never exposes POS sessions or pairing credentials. */
export function registerAdminRuntime(
  app: FastifyInstance,
  service: KassaService,
  token?: string,
  changed: () => void = () => {},
) {
  if (!token) return;
  if (token.length < 32)
    throw new Error("ADMIN_RUNTIME_TOKEN måste vara minst 32 tecken.");
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const actual = Buffer.from(
        request.headers.authorization?.replace(/^Bearer /, "") ?? "",
      ),
      expected = Buffer.from(token);
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip) ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      return reply.code(403).send({ message: "Åtkomst nekad." });
  };
  const source = digest(
    path.resolve(service.store.filename).replaceAll("\\", "/").toLowerCase(),
  );
  app.get(
    "/api/v1/admin-sync/runtime",
    { preHandler: authorize },
    async () => ({
      at: service.timestamp(),
      devices: service.deviceConnections(),
    }),
  );
  app.get(
    "/api/v1/admin-sync/management",
    { preHandler: authorize },
    async () => ({ source, snapshot: managementSnapshot(service) }),
  );
  app.post(
    "/api/v1/admin-sync/commands",
    { preHandler: authorize },
    async (request) => {
      const input = z
        .object({
          source: z.literal(source),
          actorId: z.string().uuid(),
          command: managementCommandSchema,
        })
        .strict()
        .parse(request.body);
      const result = applyManagement(service, input);
      if (result.status === "applied") changed();
      return result;
    },
  );
}
