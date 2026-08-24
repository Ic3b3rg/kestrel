import {
  createPgBoss,
  createPool,
  DIAGNOSTIC_QUEUE,
  readDatabaseConfig,
  readEventRetentionLimit,
} from "@kestrel/database";

import { processDiagnostic } from "./process-diagnostic.js";

function log(level: "error" | "info", event: string, fields: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({
    event,
    level,
    service: "worker",
    timestamp: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") {
    console.error(entry);
  } else {
    console.log(entry);
  }
}

const shutdown = new Promise<string>((resolve) => {
  process.once("SIGINT", () => resolve("SIGINT"));
  process.once("SIGTERM", () => resolve("SIGTERM"));
});
const config = readDatabaseConfig();
const retentionLimit = readEventRetentionLimit();
const pool = createPool(config.databaseUrl, "kestrel-worker");
const boss = createPgBoss({
  applicationName: "kestrel-worker-pgboss",
  databaseUrl: config.databaseUrl,
  supervise: true,
  useListenNotify: true,
});
boss.on("error", (error) => {
  log("error", "pgboss.error", {
    error: error instanceof Error ? error.message : "Unknown pg-boss error",
  });
});

try {
  await boss.start();
  await boss.work<unknown>(
    DIAGNOSTIC_QUEUE,
    { batchSize: 1, notifyPollingIntervalSeconds: 5, pollingIntervalSeconds: 1 },
    async (jobs) => {
      const job = jobs[0];
      if (!job) {
        return;
      }
      log("info", "diagnostic.started", { diagnosticId: job.id });
      await processDiagnostic(pool, job.data, retentionLimit, job.signal);
      log("info", "diagnostic.succeeded", { diagnosticId: job.id });
    },
  );
  log("info", "worker.started");
  const signal = await shutdown;
  log("info", "worker.stopping", { signal });
} finally {
  await boss.stop();
  await pool.end();
}
