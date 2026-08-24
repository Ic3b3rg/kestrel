import { createPool } from "./pool.js";
import { readDatabaseConfig } from "./config.js";
import { migrate } from "./migrate.js";

const config = readDatabaseConfig();
const pool = createPool(config.databaseUrl, "kestrel-migrate");

try {
  await migrate(pool);
  console.log(
    JSON.stringify({
      event: "database.migrated",
      level: "info",
      service: "migrate",
      timestamp: new Date().toISOString(),
    }),
  );
} finally {
  await pool.end();
}
