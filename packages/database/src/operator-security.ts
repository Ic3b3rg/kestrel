import {
  CredentialVersionSchema,
  CorrelationIdSchema,
  KestrelIdSchema,
  OperatorUsernameSchema,
  RequestDigestSchema,
  StepUpActionSchema,
  type CredentialVersion,
  type StepUpAction,
} from "@kestrel/contracts";
import type { PoolClient } from "pg";

import { appendAuditRecordInTransaction } from "./audit.js";
import type { DatabasePool } from "./pool.js";

export interface IssueOperatorStepUpProofInput {
  action: StepUpAction;
  correlationId: string;
  credentialVersion: CredentialVersion;
  operatorId: string;
  proofDigest: string;
  requestBindingHmac: string;
  targetId: string;
  targetType: string;
}

interface IssuedStepUpProofRow {
  expires_at: Date;
}

export async function issueOperatorStepUpProof(
  pool: DatabasePool,
  input: IssueOperatorStepUpProofInput,
): Promise<Date | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      DELETE FROM operator_step_up_proofs
      WHERE expires_at <= statement_timestamp()
    `);
    const issued = await client.query<IssuedStepUpProofRow>(
      `
        INSERT INTO operator_step_up_proofs (
          proof_digest,
          operator_id,
          action,
          target_id,
          request_binding_hmac,
          credential_version,
          jwt_signing_generation,
          issued_at,
          expires_at,
          issued_correlation_id
        )
        SELECT $1, id, $2, $3, $4, credential_version, jwt_signing_generation,
               statement_timestamp(), statement_timestamp() + interval '5 minutes', $7
        FROM operators
        WHERE id = $5 AND credential_version = $6::bigint
        RETURNING expires_at
      `,
      [
        RequestDigestSchema.parse(input.proofDigest),
        StepUpActionSchema.parse(input.action),
        KestrelIdSchema.parse(input.targetId),
        RequestDigestSchema.parse(input.requestBindingHmac),
        KestrelIdSchema.parse(input.operatorId),
        CredentialVersionSchema.parse(input.credentialVersion),
        CorrelationIdSchema.parse(input.correlationId),
      ],
    );
    const row = issued.rows[0];
    if (issued.rowCount !== 1 || !row) {
      await client.query("ROLLBACK");
      return null;
    }
    await appendAuditRecordInTransaction(client, {
      actorId: input.operatorId,
      actorType: "operator",
      causationId: null,
      correlationId: input.correlationId,
      denialReason: null,
      eventType: "operator.step_up.issued",
      facts: { action: input.action },
      outcome: "succeeded",
      targetId: input.targetId,
      targetType: input.targetType,
    });
    await client.query("COMMIT");
    return row.expires_at;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface ConsumeOperatorStepUpProofInput {
  action: StepUpAction;
  credentialVersion: CredentialVersion;
  operatorId: string;
  proofDigest: string;
  requestBindingHmac: string;
  targetId: string;
}

interface ConsumedStepUpProofRow {
  action: string;
  credential_version: string;
  is_unexpired: boolean;
  jwt_signing_generation: string;
  operator_id: string;
  request_binding_hmac: string;
  target_id: string;
}

export async function consumeOperatorStepUpProofInTransaction(
  client: PoolClient,
  input: ConsumeOperatorStepUpProofInput,
): Promise<boolean> {
  const consumed = await client.query<ConsumedStepUpProofRow>(
    `
      WITH consumed AS (
        DELETE FROM operator_step_up_proofs
        WHERE proof_digest = $1
        RETURNING operator_id, action, target_id, request_binding_hmac, credential_version,
                  jwt_signing_generation, expires_at
      )
      SELECT operator_id,
             action,
             target_id,
             request_binding_hmac,
             credential_version,
             jwt_signing_generation,
             expires_at > statement_timestamp() AS is_unexpired
      FROM consumed
    `,
    [RequestDigestSchema.parse(input.proofDigest)],
  );
  const row = consumed.rows[0];
  if (consumed.rowCount !== 1 || row === undefined) {
    return false;
  }
  const currentAuthenticationState = await client.query(
    `
      SELECT id
      FROM operators
      WHERE id = $1
        AND credential_version = $2::bigint
        AND jwt_signing_generation = $3::bigint
      FOR UPDATE
    `,
    [row.operator_id, row.credential_version, row.jwt_signing_generation],
  );
  return (
    currentAuthenticationState.rowCount === 1 &&
    row.operator_id === KestrelIdSchema.parse(input.operatorId) &&
    row.action === StepUpActionSchema.parse(input.action) &&
    row.target_id === KestrelIdSchema.parse(input.targetId) &&
    row.request_binding_hmac === RequestDigestSchema.parse(input.requestBindingHmac) &&
    row.credential_version === CredentialVersionSchema.parse(input.credentialVersion) &&
    row.is_unexpired
  );
}

export interface ChangeOperatorCredentialsInput {
  correlationId: string;
  credentialVersion: CredentialVersion;
  expectedVersion: CredentialVersion;
  newPasswordHash: string;
  operatorId: string;
  proofDigest: string;
  requestBindingHmac: string;
  username: string;
}

export type ChangeOperatorCredentialsResult =
  { kind: "changed" } | { kind: "proof-rejected" } | { kind: "version-conflict" };

export async function changeOperatorCredentials(
  pool: DatabasePool,
  input: ChangeOperatorCredentialsInput,
): Promise<ChangeOperatorCredentialsResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const proofAccepted = await consumeOperatorStepUpProofInTransaction(client, {
      action: "operator_credentials_change",
      credentialVersion: input.credentialVersion,
      operatorId: input.operatorId,
      proofDigest: input.proofDigest,
      requestBindingHmac: input.requestBindingHmac,
      targetId: input.operatorId,
    });
    if (!proofAccepted) {
      await appendCredentialChangeAudit(client, input, "invalid_step_up");
      await client.query("COMMIT");
      return { kind: "proof-rejected" };
    }

    if (input.expectedVersion !== input.credentialVersion) {
      await appendCredentialChangeAudit(client, input, "credential_version_conflict");
      await client.query("COMMIT");
      return { kind: "version-conflict" };
    }

    const updated = await client.query(
      `
        UPDATE operators
        SET username = $1,
            password_hash = $2,
            credential_version = credential_version + 1,
            jwt_signing_generation = jwt_signing_generation + 1,
            changed_at = statement_timestamp()
        WHERE id = $3 AND credential_version = $4::bigint
      `,
      [
        OperatorUsernameSchema.parse(input.username),
        input.newPasswordHash,
        input.operatorId,
        CredentialVersionSchema.parse(input.expectedVersion),
      ],
    );
    if (updated.rowCount !== 1) {
      await appendCredentialChangeAudit(client, input, "credential_version_conflict");
      await client.query("COMMIT");
      return { kind: "version-conflict" };
    }

    await client.query("DELETE FROM operator_step_up_proofs WHERE operator_id = $1", [
      input.operatorId,
    ]);

    await appendAuditRecordInTransaction(client, {
      actorId: input.operatorId,
      actorType: "operator",
      causationId: null,
      correlationId: input.correlationId,
      denialReason: null,
      eventType: "operator.credentials_change.succeeded",
      facts: {},
      outcome: "succeeded",
      targetId: input.operatorId,
      targetType: "operator",
    });
    await client.query("COMMIT");
    return { kind: "changed" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface ResetOperatorPasswordInput {
  correlationId: string;
  passwordHash: string;
}

export async function resetOperatorPassword(
  pool: DatabasePool,
  input: ResetOperatorPasswordInput,
): Promise<void> {
  const correlationId = CorrelationIdSchema.parse(input.correlationId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{ id: string }>(`
      SELECT id
      FROM operators
      ORDER BY created_at, id
      LIMIT 2
      FOR UPDATE
    `);
    const operator = selected.rows[0];
    if (selected.rowCount !== 1 || !operator) {
      throw new Error("Operator state is not recoverable");
    }
    const updated = await client.query(
      `
        UPDATE operators
        SET password_hash = $1,
            credential_version = credential_version + 1,
            jwt_signing_generation = jwt_signing_generation + 1,
            changed_at = statement_timestamp()
        WHERE id = $2
      `,
      [input.passwordHash, operator.id],
    );
    if (updated.rowCount !== 1) {
      throw new Error("Operator password reset did not update exactly one row");
    }
    await client.query("DELETE FROM operator_step_up_proofs WHERE operator_id = $1", [operator.id]);
    await client.query("DELETE FROM authentication_rate_limits");
    await appendAuditRecordInTransaction(client, {
      actorId: null,
      actorType: "host",
      causationId: null,
      correlationId,
      denialReason: null,
      eventType: "operator.password_reset.succeeded",
      facts: {},
      outcome: "succeeded",
      targetId: operator.id,
      targetType: "operator",
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function appendCredentialChangeAudit(
  client: PoolClient,
  input: ChangeOperatorCredentialsInput,
  denialReason: string,
): Promise<void> {
  await appendAuditRecordInTransaction(client, {
    actorId: input.operatorId,
    actorType: "operator",
    causationId: null,
    correlationId: input.correlationId,
    denialReason,
    eventType: "operator.credentials_change.denied",
    facts: {},
    outcome: "denied",
    targetId: input.operatorId,
    targetType: "operator",
  });
}
