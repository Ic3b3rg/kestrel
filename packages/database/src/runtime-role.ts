import type { DatabasePool } from "./pool.js";

export const RUNTIME_DATABASE_ROLE = "kestrel_runtime";

function runtimePassword(runtimeDatabaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(runtimeDatabaseUrl);
  } catch {
    throw new Error("RUNTIME_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    decodeURIComponent(parsed.username) !== RUNTIME_DATABASE_ROLE
  ) {
    throw new Error(`RUNTIME_DATABASE_URL must authenticate as ${RUNTIME_DATABASE_ROLE}`);
  }
  const password = decodeURIComponent(parsed.password);
  if (password.length < 16) {
    throw new Error(
      "RUNTIME_DATABASE_URL must contain a runtime password of at least 16 characters",
    );
  }
  return password;
}

export async function prepareRuntimeDatabaseRole(
  ownerPool: DatabasePool,
  runtimeDatabaseUrl: string,
): Promise<void> {
  const password = runtimePassword(runtimeDatabaseUrl);
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('kestrel-runtime-database-role', 0))",
    );
    const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'kestrel_runtime'");
    if (role.rowCount !== 1) {
      throw new Error("The runtime database role migration is not applied");
    }
    const formatted = await client.query<{ statement: string }>(
      `
        SELECT format(
          'ALTER ROLE kestrel_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
          $1::text
        ) AS statement
      `,
      [password],
    );
    const statement = formatted.rows[0]?.statement;
    if (statement === undefined) {
      throw new Error("The runtime database role could not be configured");
    }
    await client.query(statement);
    await client.query("ALTER ROLE kestrel_runtime SET search_path = pg_catalog, public, pgboss");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
