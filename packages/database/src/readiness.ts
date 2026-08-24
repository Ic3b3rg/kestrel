import { DIAGNOSTIC_QUEUE } from "./pg-boss.js";
import { readInstallationSnapshot } from "./installation.js";
import { verifyAppliedMigrations } from "./migrate.js";
import type { DatabasePool } from "./pool.js";

interface PgBossReadinessRow {
  diagnostic_queue_exists: boolean;
  job_table: string | null;
}

export async function verifyDatabaseReadiness(pool: DatabasePool): Promise<void> {
  await verifyAppliedMigrations(pool);
  await readInstallationSnapshot(pool);
  const result = await pool.query<PgBossReadinessRow>(
    `
      SELECT to_regclass('pgboss.job')::text AS job_table,
             EXISTS (
               SELECT 1
               FROM pgboss.queue
               WHERE name = $1
             ) AS diagnostic_queue_exists
    `,
    [DIAGNOSTIC_QUEUE],
  );
  const readiness = result.rows[0];
  if (result.rowCount !== 1 || !readiness?.job_table || !readiness.diagnostic_queue_exists) {
    throw new Error("Required pg-boss state is unavailable");
  }
}
