import pg from "pg";

const { Pool } = pg;

export type DatabasePool = InstanceType<typeof Pool>;

export function createPool(databaseUrl: string, applicationName = "kestrel"): DatabasePool {
  return new Pool({
    application_name: applicationName,
    connectionString: databaseUrl,
    max: 10,
  });
}
