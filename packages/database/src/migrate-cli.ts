import { createPool } from "./pool.js";
import { readDatabaseConfig } from "./config.js";
import { migrate } from "./migrate.js";
import {
  CHANGE_OVERVIEW_RENDER_QUEUE,
  CHANGE_OVERVIEW_RENDER_QUEUE_OPTIONS,
  CHANGE_OVERVIEW_RENDER_QUEUE_UPDATE_OPTIONS,
  createPgBoss,
  DIAGNOSTIC_QUEUE,
  DIAGNOSTIC_QUEUE_OPTIONS,
} from "./pg-boss.js";

const config = readDatabaseConfig();
const pool = createPool(config.databaseUrl, "kestrel-migrate");
const boss = createPgBoss({
  applicationName: "kestrel-migrate-pgboss",
  databaseUrl: config.databaseUrl,
  migrate: true,
});
boss.on("error", (error) => {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : "Unknown pg-boss error",
      event: "pgboss.error",
      level: "error",
      service: "migrate",
      timestamp: new Date().toISOString(),
    }),
  );
});

try {
  await boss.start();
  await migrate(pool);
  await boss.createQueue(DIAGNOSTIC_QUEUE, DIAGNOSTIC_QUEUE_OPTIONS);
  await boss.updateQueue(DIAGNOSTIC_QUEUE, DIAGNOSTIC_QUEUE_OPTIONS);
  await boss.createQueue(CHANGE_OVERVIEW_RENDER_QUEUE, CHANGE_OVERVIEW_RENDER_QUEUE_OPTIONS);
  await boss.updateQueue(CHANGE_OVERVIEW_RENDER_QUEUE, CHANGE_OVERVIEW_RENDER_QUEUE_UPDATE_OPTIONS);
  console.log(
    JSON.stringify({
      event: "database.migrated",
      level: "info",
      service: "migrate",
      timestamp: new Date().toISOString(),
    }),
  );
} finally {
  await boss.stop({ graceful: false });
  await pool.end();
}
