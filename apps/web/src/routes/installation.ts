import type { FastifyInstance } from "fastify";

import { readInstallationSnapshot, type DatabasePool } from "@kestrel/database";

export function registerInstallationRoutes(app: FastifyInstance, pool: DatabasePool): void {
  app.get("/api/v1/installation", async () => readInstallationSnapshot(pool));
}
