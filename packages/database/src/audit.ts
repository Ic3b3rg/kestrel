import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import type { DatabasePool } from "./pool.js";

type AuditIdentityType = "anonymous" | "host" | "operator" | "service";
type AuditOutcome = "denied" | "succeeded";
type AuditFact = boolean | null | number | string;

export interface AppendAuditRecordInput {
  actorId: string | null;
  actorType: AuditIdentityType;
  causationId: string | null;
  correlationId: string;
  denialReason: string | null;
  eventType: string;
  facts?: Record<string, AuditFact>;
  outcome: AuditOutcome;
  targetId: string | null;
  targetType: string;
}

interface ReservedAuditIdentityRow {
  id: string;
  occurred_at: Date;
}

function canonicalFacts(facts: Record<string, AuditFact>): Record<string, AuditFact> {
  return Object.fromEntries(
    Object.entries(facts).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function canonicalAuditRecord(
  id: string,
  occurredAt: Date,
  priorRecordHash: string | null,
  input: AppendAuditRecordInput,
): string {
  return JSON.stringify({
    actorId: input.actorId,
    actorType: input.actorType,
    causationId: input.causationId,
    correlationId: input.correlationId,
    denialReason: input.denialReason,
    eventType: input.eventType,
    eventVersion: 1,
    facts: canonicalFacts(input.facts ?? {}),
    id,
    occurredAt: occurredAt.toISOString(),
    outcome: input.outcome,
    priorRecordHash,
    targetId: input.targetId,
    targetType: input.targetType,
  });
}

export async function appendAuditRecordInTransaction(
  client: PoolClient,
  input: AppendAuditRecordInput,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('kestrel-audit-chain', 0))");
  const previous = await client.query<{ record_hash: string }>(`
    SELECT record_hash
    FROM installation_audit_records
    ORDER BY id DESC
    LIMIT 1
  `);
  const reserved = await client.query<ReservedAuditIdentityRow>(`
    SELECT nextval(pg_get_serial_sequence('installation_audit_records', 'id')) AS id,
           clock_timestamp() AS occurred_at
  `);
  const identity = reserved.rows[0];
  if (!identity) {
    throw new Error("Installation Audit identity reservation failed");
  }
  const priorRecordHash = previous.rows[0]?.record_hash ?? null;
  const recordHash = createHash("sha256")
    .update(canonicalAuditRecord(identity.id, identity.occurred_at, priorRecordHash, input))
    .digest("hex");
  const inserted = await client.query(
    `
      INSERT INTO installation_audit_records (
        id,
        event_type,
        event_version,
        actor_type,
        actor_id,
        target_type,
        target_id,
        correlation_id,
        causation_id,
        outcome,
        denial_reason,
        facts,
        occurred_at,
        prior_record_hash,
        record_hash
      )
      VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
    `,
    [
      identity.id,
      input.eventType,
      input.actorType,
      input.actorId,
      input.targetType,
      input.targetId,
      input.correlationId,
      input.causationId,
      input.outcome,
      input.denialReason,
      JSON.stringify(canonicalFacts(input.facts ?? {})),
      identity.occurred_at,
      priorRecordHash,
      recordHash,
    ],
  );
  if (inserted.rowCount !== 1) {
    throw new Error("Installation Audit append did not create exactly one record");
  }
}

export async function appendAuditRecord(
  pool: DatabasePool,
  input: AppendAuditRecordInput,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await appendAuditRecordInTransaction(client, input);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
