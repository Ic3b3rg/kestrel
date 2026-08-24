import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import type { DatabasePool } from "./pool.js";

const MIGRATION_FILE = /^[0-9]{3}_[a-z0-9_]+\.sql$/;
const DEFAULT_MIGRATIONS_DIRECTORY = new URL("../migrations/", import.meta.url);

export interface MigrationRecord {
  checksum: string;
  name: string;
}

interface MigrationDefinition extends MigrationRecord {
  contents: string;
}

function checksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function readMigrationDefinitions(migrationsDirectory: URL): Promise<MigrationDefinition[]> {
  const fileNames = (await readdir(migrationsDirectory))
    .filter((fileName) => MIGRATION_FILE.test(fileName))
    .sort();
  return Promise.all(
    fileNames.map(async (name) => {
      const contents = await readFile(new URL(name, migrationsDirectory), "utf8");
      return { checksum: checksum(contents), contents, name };
    }),
  );
}

export function assertAppliedMigrations(
  expected: readonly MigrationRecord[],
  applied: readonly MigrationRecord[],
): void {
  const appliedByName = new Map(applied.map((migration) => [migration.name, migration.checksum]));
  for (const migration of expected) {
    const appliedChecksum = appliedByName.get(migration.name);
    if (appliedChecksum === undefined) {
      throw new Error(`Required migration is not applied: ${migration.name}`);
    }
    if (appliedChecksum !== migration.checksum) {
      throw new Error(`Applied migration checksum changed: ${migration.name}`);
    }
  }
}

export async function verifyAppliedMigrations(
  pool: DatabasePool,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
): Promise<void> {
  const expected = await readMigrationDefinitions(migrationsDirectory);
  const result = await pool.query<MigrationRecord>(
    `
      SELECT name, checksum
      FROM schema_migrations
      WHERE name = ANY($1::text[])
    `,
    [expected.map((migration) => migration.name)],
  );
  assertAppliedMigrations(expected, result.rows);
}

export async function migrate(
  pool: DatabasePool,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('kestrel-schema-migrations', 0))",
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);

    const migrations = await readMigrationDefinitions(migrationsDirectory);

    for (const migration of migrations) {
      const applied = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [migration.name],
      );

      if (applied.rowCount === 1) {
        if (applied.rows[0]?.checksum !== migration.checksum) {
          throw new Error(`Applied migration checksum changed: ${migration.name}`);
        }
        continue;
      }

      await client.query(migration.contents);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
        migration.name,
        migration.checksum,
      ]);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
