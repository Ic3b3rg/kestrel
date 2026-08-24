import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import type { DatabasePool } from "./pool.js";

const MIGRATION_FILE = /^[0-9]{3}_[a-z0-9_]+\.sql$/;

function checksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function migrate(
  pool: DatabasePool,
  migrationsDirectory = new URL("../migrations/", import.meta.url),
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

    const fileNames = (await readdir(migrationsDirectory))
      .filter((fileName) => MIGRATION_FILE.test(fileName))
      .sort();

    for (const fileName of fileNames) {
      const contents = await readFile(new URL(fileName, migrationsDirectory), "utf8");
      const expectedChecksum = checksum(contents);
      const applied = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [fileName],
      );

      if (applied.rowCount === 1) {
        if (applied.rows[0]?.checksum !== expectedChecksum) {
          throw new Error(`Applied migration checksum changed: ${fileName}`);
        }
        continue;
      }

      await client.query(contents);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
        fileName,
        expectedChecksum,
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
