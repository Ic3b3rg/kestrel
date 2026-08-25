import { resolve } from "node:path";

import { buildApp } from "./app.js";
import { readSessionSigningKey } from "./session.js";

import {
  createPgBoss,
  createPool,
  readDatabaseConfig,
  readEventRetentionLimit,
} from "@kestrel/database";

function readPort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

const config = readDatabaseConfig();
const pool = createPool(config.databaseUrl, "kestrel-web");
const eventPool = createPool(config.databaseUrl, "kestrel-web-events", {
  connectionTimeoutMillis: 2_000,
  max: 10,
});
const boss = createPgBoss({
  applicationName: "kestrel-web-pgboss",
  databaseUrl: config.databaseUrl,
});
const app = await buildApp({
  boss,
  eventPool,
  eventRetentionLimit: readEventRetentionLimit(),
  pool,
  pwaRoot: process.env.PWA_ROOT ?? resolve(import.meta.dirname, "../../pwa/dist"),
  sessionSigningKey: readSessionSigningKey(),
});
boss.on("error", (error) => {
  app.log.error({ err: error, event: "pgboss.error" });
});
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ event: "web.stopping", signal });
  await app.close();
  await boss.stop();
  await eventPool.end();
  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      app.log.error({ err: error, event: "web.stop_failed", signal });
      process.exitCode = 1;
    });
  });
}

try {
  await boss.start();
  await app.listen({
    host: process.env.HOST ?? "0.0.0.0",
    port: readPort(process.env.PORT),
  });
  app.log.info({ event: "web.started" });
} catch (error) {
  app.log.error({ err: error, event: "web.start_failed" });
  await app.close();
  await boss.stop({ graceful: false });
  await eventPool.end();
  await pool.end();
  process.exitCode = 1;
}
