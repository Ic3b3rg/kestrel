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
  requestDigest: string;
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
    const issued = await client.query<IssuedStepUpProofRow>(
      `
        INSERT INTO operator_step_up_proofs (
          proof_digest,
          operator_id,
          action,
          target_id,
          request_digest,
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
        RequestDigestSchema.parse(input.requestDigest),
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
  requestDigest: string;
  targetId: string;
}

interface ConsumedStepUpProofRow {
  action: string;
  credential_version: string;
  is_unexpired: boolean;
  jwt_signing_generation: string;
  operator_id: string;
  request_digest: string;
  target_id: string;
}

export async function consumeOperatorStepUpProofInTransaction(
  client: PoolClient,
  input: ConsumeOperatorStepUpProofInput,
): Promise<boolean> {
  const consumed = await client.query<ConsumedStepUpProofRow>(
    `
      WITH consumed AS (
        UPDATE operator_step_up_proofs
        SET consumed_at = statement_timestamp()
        WHERE proof_digest = $1 AND consumed_at IS NULL
        RETURNING operator_id, action, target_id, request_digest, credential_version,
                  jwt_signing_generation, expires_at
      )
      SELECT operator_id,
             action,
             target_id,
             request_digest,
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
    row.request_digest === RequestDigestSchema.parse(input.requestDigest) &&
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
  requestDigest: string;
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
      requestDigest: input.requestDigest,
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
