import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import type { DatabasePool, DiagnosticJobSender } from "@kestrel/database";

import { registerDiagnosticRoutes } from "./routes/diagnostics.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerInstallationRoutes } from "./routes/installation.js";
import { registerOpenApiRoute } from "./routes/openapi.js";

export interface BuildAppOptions {
  boss: DiagnosticJobSender;
  eventRetentionLimit: number;
  logger?: boolean;
  pool: DatabasePool;
}

export async function buildApp({
  boss,
  eventRetentionLimit,
  logger = true,
  pool,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    genReqId: () => randomUUID(),
    logger,
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
  registerHealthRoutes(app, pool);
  registerInstallationRoutes(app, pool);
  registerOpenApiRoute(app);

  return app;
}
