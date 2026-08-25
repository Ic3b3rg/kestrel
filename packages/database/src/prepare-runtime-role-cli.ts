import { readDatabaseConfig } from "./config.js";
import { createPool } from "./pool.js";
import { prepareRuntimeDatabaseRole } from "./runtime-role.js";

const runtimeDatabaseUrl = process.env.RUNTIME_DATABASE_URL;
if (runtimeDatabaseUrl === undefined) {
  throw new Error("RUNTIME_DATABASE_URL is required");
}

const ownerPool = createPool(readDatabaseConfig().databaseUrl, "kestrel-runtime-role");
try {
  await prepareRuntimeDatabaseRole(ownerPool, runtimeDatabaseUrl);
  console.log(
    JSON.stringify({
      event: "database.runtime_role_prepared",
      level: "info",
      service: "database-role",
      timestamp: new Date().toISOString(),
    }),
  );
} finally {
  await ownerPool.end();
}
