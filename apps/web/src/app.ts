import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import type { DatabasePool } from "@kestrel/database";

import { registerHealthRoutes } from "./routes/health.js";
import { registerInstallationRoutes } from "./routes/installation.js";
import { registerOpenApiRoute } from "./routes/openapi.js";

export interface BuildAppOptions {
  logger?: boolean;
  pool: DatabasePool;
}

export async function buildApp({ logger = true, pool }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
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

  registerHealthRoutes(app, pool);
  registerInstallationRoutes(app, pool);
  registerOpenApiRoute(app);

  return app;
}
