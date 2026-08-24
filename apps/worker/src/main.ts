import {
  createPgBoss,
  createPool,
  DIAGNOSTIC_QUEUE,
  readDatabaseConfig,
  readDiagnosticLogContext,
  readEventRetentionLimit,
} from "@kestrel/database";

import { parseDiagnosticJobData, processDiagnostic } from "./process-diagnostic.js";

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
      const diagnostic = parseDiagnosticJobData(job.data);
      if (job.id !== diagnostic.diagnosticId) {
        throw new Error("Diagnostic job identifier does not match its payload");
      }
      const logContext = await readDiagnosticLogContext(pool, diagnostic.diagnosticId);
      log("info", "diagnostic.started", { ...logContext });
      await processDiagnostic(pool, diagnostic, retentionLimit, job.signal);
      log("info", "diagnostic.succeeded", { ...logContext });
    },
  );
  log("info", "worker.started");
  const signal = await shutdown;
  log("info", "worker.stopping", { signal });
} finally {
  await boss.stop();
  await pool.end();
}
