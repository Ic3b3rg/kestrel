import pg from "pg";

const { Pool } = pg;

export type DatabasePool = InstanceType<typeof Pool>;

export interface CreatePoolOptions {
  connectionTimeoutMillis?: number;
  max?: number;
}

export function createPool(
  databaseUrl: string,
  applicationName = "kestrel",
  options: CreatePoolOptions = {},
): DatabasePool {
  return new Pool({
    application_name: applicationName,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    connectionString: databaseUrl,
    max: options.max ?? 10,
  });
}
