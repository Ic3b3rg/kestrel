import type { FastifyInstance } from "fastify";

import { apiErrorJsonSchema, healthStatusJsonSchema } from "@kestrel/contracts";
import type { DatabasePool } from "@kestrel/database";

export function registerHealthRoutes(app: FastifyInstance, pool: DatabasePool): void {
  app.get("/health/live", { schema: { response: { 200: healthStatusJsonSchema } } }, () => ({
    status: "live",
  }));

  app.get(
    "/health/ready",
    { schema: { response: { 200: healthStatusJsonSchema, 503: apiErrorJsonSchema } } },
    async (request, reply) => {
      try {
        await pool.query("SELECT 1");
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
