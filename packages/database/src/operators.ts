import {
  CredentialVersionSchema,
  OperatorSchema,
  type CredentialVersion,
  type Operator,
} from "@kestrel/contracts";

import type { DatabasePool } from "./pool.js";

interface OperatorDatabaseRow {
  credential_version: string;
  created_at: Date;
  id: string;
  jwt_signing_generation: string;
  password_hash: string;
  username: string;
}

export interface OperatorCredentials extends Operator {
  credentialVersion: CredentialVersion;
  passwordHash: string;
  sessionGeneration: CredentialVersion;
}

export type OperatorSessionState = Omit<OperatorCredentials, "passwordHash">;

export interface BootstrapOperatorInput {
  passwordHash: string;
  username: string;
}

export type BootstrapOperatorResult = { created: false } | { created: true; operator: Operator };

function mapOperator(row: OperatorDatabaseRow): Operator {
  return OperatorSchema.parse({ id: row.id, username: row.username });
}

function mapOperatorSessionState(row: OperatorDatabaseRow): OperatorSessionState {
  return {
    ...mapOperator(row),
    credentialVersion: CredentialVersionSchema.parse(row.credential_version),
    sessionGeneration: CredentialVersionSchema.parse(row.jwt_signing_generation),
  };
}

export async function bootstrapOperator(
  pool: DatabasePool,
  input: BootstrapOperatorInput,
): Promise<BootstrapOperatorResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE operators IN ACCESS EXCLUSIVE MODE");
    const existing = await client.query<{ id: string }>("SELECT id FROM operators LIMIT 2");
    if (existing.rowCount === 1) {
      await client.query("COMMIT");
      return { created: false };
    }
    if (existing.rowCount !== 0) {
      throw new Error("Operator state is ambiguous");
    }

    const inserted = await client.query<OperatorDatabaseRow>(
      `
        INSERT INTO operators (username, password_hash)
        VALUES ($1, $2)
        RETURNING id, username, password_hash, credential_version,
                  jwt_signing_generation, created_at
      `,
      [input.username, input.passwordHash],
    );
    const row = inserted.rows[0];
    if (inserted.rowCount !== 1 || !row) {
      throw new Error("Operator insert did not create exactly one row");
    }
    await client.query("COMMIT");
    return { created: true, operator: mapOperator(row) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readOperatorCredentials(
  pool: DatabasePool,
  username: string,
): Promise<OperatorCredentials | null> {
  const selected = await pool.query<OperatorDatabaseRow>(`
    SELECT id, username, password_hash, credential_version,
           jwt_signing_generation, created_at
    FROM operators
    ORDER BY created_at, id
    LIMIT 2
  `);
  if ((selected.rowCount ?? 0) > 1) {
    throw new Error("Operator state is ambiguous");
  }
  const row = selected.rows[0];
  if (!row || row.username !== username) {
    return null;
  }
  return { ...mapOperatorSessionState(row), passwordHash: row.password_hash };
}

export async function readOperatorSessionState(
  pool: Pick<DatabasePool, "query">,
  operatorId: string,
): Promise<OperatorSessionState | null> {
  const selected = await pool.query<OperatorDatabaseRow>(`
    SELECT id, username, password_hash, credential_version,
           jwt_signing_generation, created_at
    FROM operators
    ORDER BY created_at, id
    LIMIT 2
  `);
  if ((selected.rowCount ?? 0) > 1) {
    throw new Error("Operator state is ambiguous");
  }
  const row = selected.rows[0];
  return row?.id === operatorId ? mapOperatorSessionState(row) : null;
}
