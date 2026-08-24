import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import type { DatabasePool, DiagnosticJobSender } from "@kestrel/database";

import { registerDiagnosticRoutes } from "./routes/diagnostics.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerInstallationRoutes } from "./routes/installation.js";
import { registerOpenApiRoute } from "./routes/openapi.js";
import { registerPwaRoutes } from "./routes/pwa.js";

export interface BuildAppOptions {
  boss: DiagnosticJobSender;
  eventRetentionLimit: number;
  logger?: boolean;
  pool: DatabasePool;
  pwaRoot?: string;
}

export async function buildApp({
  boss,
  eventRetentionLimit,
  logger = true,
  pool,
  pwaRoot,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    genReqId: () => randomUUID(),
    logger,
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    if (request.url.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
    }
    done(null, payload);
  });

  app.setErrorHandler((error, request, reply) => {
    const invalidRequest =
      typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      error.validation !== undefined;
    if (!invalidRequest) {
      request.log.error({ err: error, event: "web.request_failed" });
    }

    return reply.code(invalidRequest ? 400 : 500).send({
      schemaVersion: 1,
      code: invalidRequest ? "INVALID_REQUEST" : "INTERNAL_ERROR",
      message: invalidRequest ? "The request does not match the API contract" : "Request failed",
      correlationId: request.id,
    });
  });

  registerDiagnosticRoutes(app, pool, boss, eventRetentionLimit);
  registerEventRoutes(app, pool);
  registerHealthRoutes(app, pool);
  registerInstallationRoutes(app, pool);
  registerOpenApiRoute(app);
  if (pwaRoot !== undefined) {
    await registerPwaRoutes(app, pwaRoot);
  }

  return app;
}
