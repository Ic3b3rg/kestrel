import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import type { DatabasePool } from "@kestrel/database";

import { registerHealthRoutes } from "./routes/health.js";
import { registerInstallationRoutes } from "./routes/installation.js";

export interface BuildAppOptions {
  logger?: boolean;
  pool: DatabasePool;
}

export async function buildApp({ logger = true, pool }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    disableRequestLogging: false,
    genReqId: () => randomUUID(),
    logger,
  });

  registerHealthRoutes(app, pool);
  registerInstallationRoutes(app, pool);

  return app;
}
