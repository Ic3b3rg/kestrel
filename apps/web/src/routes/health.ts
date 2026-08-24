import type { FastifyInstance } from "fastify";

import {
  apiErrorJsonSchema,
  healthStatusJsonSchema,
  jsonSchemaForEmbedding,
} from "@kestrel/contracts";
import { verifyDatabaseReadiness, type DatabasePool } from "@kestrel/database";

export function registerHealthRoutes(app: FastifyInstance, pool: DatabasePool): void {
  app.get(
    "/health/live",
    { schema: { response: { 200: jsonSchemaForEmbedding(healthStatusJsonSchema) } } },
    () => ({ status: "live" }),
  );

  app.get(
    "/health/ready",
    {
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
