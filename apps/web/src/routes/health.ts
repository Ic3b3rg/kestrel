import type { FastifyInstance } from "fastify";

import type { DatabasePool } from "@kestrel/database";

export function registerHealthRoutes(app: FastifyInstance, pool: DatabasePool): void {
  app.get("/health/live", () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
}
