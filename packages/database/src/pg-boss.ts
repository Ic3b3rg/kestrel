import { PgBoss, type ConstructorOptions, type Db, type Queue } from "pg-boss";
import type { PoolClient } from "pg";

export const DIAGNOSTIC_QUEUE = "installation-diagnostic-v1";

export const DIAGNOSTIC_QUEUE_OPTIONS = {
  deleteAfterSeconds: 86_400,
  expireInSeconds: 30,
  notify: true,
  retryBackoff: true,
  retryDelay: 1,
  retryDelayMax: 30,
  retryLimit: 5,
} satisfies Omit<Queue, "name">;

export interface CreatePgBossOptions {
  applicationName: string;
  databaseUrl: string;
  migrate?: boolean;
  schedule?: boolean;
  supervise?: boolean;
  useListenNotify?: boolean;
}

export function createPgBoss(options: CreatePgBossOptions): PgBoss {
  const config: ConstructorOptions = {
    application_name: options.applicationName,
    connectionString: options.databaseUrl,
    migrate: options.migrate ?? false,
    schedule: options.schedule ?? false,
    schema: "pgboss",
    supervise: options.supervise ?? false,
    useListenNotify: options.useListenNotify ?? false,
  };
  return new PgBoss(config);
}

export function pgBossDatabase(client: PoolClient): Db {
  return {
    async executeSql(text, values) {
      const result = await client.query(text, values);
      return { rows: result.rows };
    },
  };
}
