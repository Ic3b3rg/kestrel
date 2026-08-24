import { buildApp } from "./app.js";

import { createPool, readDatabaseConfig } from "@kestrel/database";

function readPort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

const config = readDatabaseConfig();
const pool = createPool(config.databaseUrl, "kestrel-web");
const app = await buildApp({ pool });
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ event: "web.stopping", signal });
  await app.close();
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
  await app.listen({
    host: process.env.HOST ?? "0.0.0.0",
    port: readPort(process.env.PORT),
  });
  app.log.info({ event: "web.started" });
} catch (error) {
  app.log.error({ err: error, event: "web.start_failed" });
  await pool.end();
  process.exitCode = 1;
}
