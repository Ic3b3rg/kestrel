import type { FastifyInstance } from "fastify";

import {
  apiErrorJsonSchema,
  healthStatusJsonSchema,
  jsonSchemaForEmbedding,
} from "@kestrel/contracts";
import { verifyDatabaseReadiness, type DatabasePool } from "@kestrel/database";

import { PUBLIC_ROUTE_CONFIG } from "../authentication.js";

export function registerHealthRoutes(app: FastifyInstance, pool: DatabasePool): void {
  app.get(
    "/health/live",
    {
      config: PUBLIC_ROUTE_CONFIG,
      schema: { response: { 200: jsonSchemaForEmbedding(healthStatusJsonSchema) } },
    },
    () => ({ status: "live" }),
  );

  app.get(
    "/health/ready",
    {
      config: PUBLIC_ROUTE_CONFIG,
      schema: {
        response: {
          200: jsonSchemaForEmbedding(healthStatusJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      try {
        await verifyDatabaseReadiness(pool);
        return { status: "ready" };
      } catch {
        return reply.code(503).send({
          schemaVersion: 1,
          code: "SERVICE_UNAVAILABLE",
          message: "Database readiness check failed",
          correlationId: request.id,
        });
      }
    },
  );
}
