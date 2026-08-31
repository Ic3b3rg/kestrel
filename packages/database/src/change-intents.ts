import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import {
  ChangeIntentSchema,
  ChangeIntentSourceSchema,
  ChangeIntentVersionCreatedSchema,
  CreateChangeIntentVersionCommandSchema,
  evaluateChangeIntentResolution,
  type ChangeIntentSource,
  type ChangeIntentVersionCreated,
  type CreateChangeIntentVersionCommand,
} from "@kestrel/contracts";

import { appendAuditRecordInTransaction } from "./audit.js";
import type { DatabasePool } from "./pool.js";

export type ChangeIntentPersistenceErrorCode = "not_found" | "source_conflict" | "version_conflict";

export class ChangeIntentPersistenceError extends Error {
  constructor(public readonly code: ChangeIntentPersistenceErrorCode) {
    super(`Change Intent persistence failed: ${code}`);
    this.name = "ChangeIntentPersistenceError";
  }
}

export interface CreateChangeIntentVersionInput {
  actorId: string;
  changeProposalId: string;
  command: CreateChangeIntentVersionCommand;
  correlationId: string;
  projectId: string;
}

interface ProposalIntentCandidateRow {
  canonical_proposal_id: string;
  canonical_url_snapshot: string | null;
  observed_at: Date | null;
  optimistic_version: string;
  proposal_body: string | null;
  proposal_kind: "local" | "provider_observed";
  proposal_title: string;
}

interface ProposalIntentSourceRow extends ProposalIntentCandidateRow {
  canonical_project_id: string;
}

interface RevisionIntentSourceRow {
  base_commit_author_snapshot: string | null;
  base_commit_subject_snapshot: string | null;
  base_object_id: string;
  base_ref_snapshot: string;
  head_commit_author_snapshot: string | null;
  head_commit_subject_snapshot: string | null;
  head_object_id: string;
  head_ref_snapshot: string;
}

interface InsertedIntentRow {
  created_at: Date;
  id: string;
  version: string;
}

function nonEmpty(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized === "" ? null : normalized;
}

function providerSources(row: ProposalIntentCandidateRow): ChangeIntentSource[] {
  if (
    row.proposal_kind !== "provider_observed" ||
    row.canonical_url_snapshot === null ||
    row.observed_at === null
  ) {
    return [];
  }
  const observedAt = row.observed_at.toISOString();
  const provenanceBase = {
    kind: "provider_field" as const,
    provider: "github" as const,
    observedAt,
    canonicalUrl: row.canonical_url_snapshot,
  };
  const sources: ChangeIntentSource[] = [
    ChangeIntentSourceSchema.parse({
      id: "provider_title",
      kind: "provider_field",
      label: "GitHub title",
      text: row.proposal_title,
      version: observedAt,
      provenance: { ...provenanceBase, field: "title" },
    }),
  ];
  const body = nonEmpty(row.proposal_body);
  if (body !== null) {
    sources.push(
      ChangeIntentSourceSchema.parse({
        id: "provider_description",
        kind: "provider_field",
        label: "GitHub description",
        text: body,
        version: observedAt,
        provenance: { ...provenanceBase, field: "description" },
      }),
    );
  }
  return sources;
}

function commitSources(row: RevisionIntentSourceRow | undefined): ChangeIntentSource[] {
  if (row === undefined) return [];
  const sources: ChangeIntentSource[] = [];
  for (const side of ["base", "head"] as const) {
    const objectId = side === "base" ? row.base_object_id : row.head_object_id;
    const ref = side === "base" ? row.base_ref_snapshot : row.head_ref_snapshot;
    const author = nonEmpty(
      side === "base" ? row.base_commit_author_snapshot : row.head_commit_author_snapshot,
    );
    const subject = nonEmpty(
      side === "base" ? row.base_commit_subject_snapshot : row.head_commit_subject_snapshot,
    );
    if (author !== null) {
      sources.push(
        ChangeIntentSourceSchema.parse({
          id: `${side}_commit_author`,
          kind: "commit_author",
          label: `${side === "base" ? "Base" : "Head"} commit author`,
          text: author,
          version: objectId,
          provenance: { kind: "commit_author", side, objectId, ref },
        }),
      );
    }
    if (subject !== null) {
      sources.push(
        ChangeIntentSourceSchema.parse({
          id: `${side}_commit_message`,
          kind: "commit_message",
          label: `${side === "base" ? "Base" : "Head"} commit message`,
          text: subject,
          version: objectId,
          provenance: { kind: "commit_message", side, objectId, ref },
        }),
      );
    }
  }
  return sources;
}

export function buildChangeIntentCandidates(
  proposal: ProposalIntentCandidateRow,
  revision?: RevisionIntentSourceRow,
): ChangeIntentSource[] {
  return [...providerSources(proposal), ...commitSources(revision)];
}

function digestSources(sources: readonly ChangeIntentSource[]): string {
  return createHash("sha256").update(JSON.stringify(sources), "utf8").digest("hex");
}

async function readProposal(
  client: PoolClient,
  projectId: string,
  changeProposalId: string,
): Promise<ProposalIntentSourceRow> {
  const result = await client.query<ProposalIntentSourceRow>(
    `
      WITH project_family AS (
        SELECT COALESCE(canonical_project_id, id) AS id
        FROM projects
        WHERE id = $1
      )
      SELECT project_family.id AS canonical_project_id,
             canonical.id AS canonical_proposal_id,
             canonical.proposal_kind,
             canonical.title_snapshot AS proposal_title,
             canonical.body_snapshot AS proposal_body,
             canonical.canonical_url_snapshot,
             canonical.observed_at,
             canonical.optimistic_version
      FROM change_proposals AS selected
      INNER JOIN change_proposals AS canonical
        ON canonical.id = COALESCE(selected.canonical_change_proposal_id, selected.id)
      INNER JOIN project_family ON project_family.id = canonical.project_id
      WHERE selected.id = $2
        AND canonical.canonical_change_proposal_id IS NULL
      FOR UPDATE OF canonical
    `,
    [projectId, changeProposalId],
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) {
    throw new ChangeIntentPersistenceError("not_found");
  }
  return row;
}

async function readLatestAvailableRevision(
  client: PoolClient,
  canonicalProposalId: string,
): Promise<RevisionIntentSourceRow | undefined> {
  const result = await client.query<RevisionIntentSourceRow>(
    `
      SELECT revision.base_ref_snapshot,
             revision.base_object_id,
             revision.base_commit_author_snapshot,
             revision.base_commit_subject_snapshot,
             revision.head_ref_snapshot,
             revision.head_object_id,
             revision.head_commit_author_snapshot,
             revision.head_commit_subject_snapshot
      FROM review_revisions AS revision
      INNER JOIN change_proposals AS revision_proposal
        ON revision_proposal.id = revision.change_proposal_id
      WHERE revision.revision_state = 'available'
        AND (
          revision_proposal.id = $1
          OR revision_proposal.canonical_change_proposal_id = $1
        )
      ORDER BY revision.available_at DESC, revision.id DESC
      LIMIT 1
    `,
    [canonicalProposalId],
  );
  return result.rows[0];
}

async function nextIntentVersion(client: PoolClient, canonicalProposalId: string): Promise<number> {
  const result = await client.query<{ max_version: string | null }>(
    `
      SELECT max(intent.version) AS max_version
      FROM change_intents AS intent
      INNER JOIN change_proposals AS intent_proposal
        ON intent_proposal.id = intent.change_proposal_id
      WHERE intent_proposal.id = $1
         OR intent_proposal.canonical_change_proposal_id = $1
    `,
    [canonicalProposalId],
  );
  const current = Number(result.rows[0]?.max_version ?? 0);
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error("Change Intent version is invalid");
  }
  return current + 1;
}

async function createChangeIntentVersionInTransaction(
  client: PoolClient,
  input: CreateChangeIntentVersionInput,
): Promise<ChangeIntentVersionCreated> {
  const command = CreateChangeIntentVersionCommandSchema.parse(input.command);
  const proposal = await readProposal(client, input.projectId, input.changeProposalId);
  const proposalVersion = Number(proposal.optimistic_version);
  if (!Number.isSafeInteger(proposalVersion) || proposalVersion < 1) {
    throw new Error("Change Proposal version is invalid");
  }
  if (proposalVersion !== command.expectedProposalVersion) {
    throw new ChangeIntentPersistenceError("version_conflict");
  }

  const candidates = buildChangeIntentCandidates(
    proposal,
    await readLatestAvailableRevision(client, proposal.canonical_proposal_id),
  );
  const candidatesById = new Map(candidates.map((source) => [source.id, source]));
  const sources = command.selectedSourceIds.map((sourceId) => {
    const source = candidatesById.get(sourceId);
    if (source === undefined) throw new ChangeIntentPersistenceError("source_conflict");
    return source;
  });
  const version = await nextIntentVersion(client, proposal.canonical_proposal_id);
  if (command.operatorInput !== null) {
    sources.push(
      ChangeIntentSourceSchema.parse({
        id: "operator_input",
        kind: "operator_input",
        label: "Operator input",
        text: command.operatorInput,
        version: String(version),
        provenance: { kind: "operator_input" },
      }),
    );
  }
  const resolution = evaluateChangeIntentResolution({
    acceptanceOutcomes: command.acceptanceOutcomes,
    objective: command.objective,
    scopeBoundaries: command.scopeBoundaries,
    sourceCount: sources.length,
    unresolvedIssues: command.unresolvedIssues,
  });
  const sourceDigest = digestSources(sources);
  const text = command.objective ?? command.operatorInput ?? sources[0]?.text;
  if (text === undefined) {
    throw new ChangeIntentPersistenceError("source_conflict");
  }

  const inserted = await client.query<InsertedIntentRow>(
    `
      INSERT INTO change_intents (
        change_proposal_id,
        version,
        intent_text,
        submitted_by_operator_id,
        objective,
        scope_boundaries,
        selected_sources,
        acceptance_outcomes,
        source_digest,
        resolution_state,
        resolution_issues
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb)
      RETURNING id, version, created_at
    `,
    [
      proposal.canonical_proposal_id,
      version,
      text,
      input.actorId,
      command.objective,
      JSON.stringify(command.scopeBoundaries),
      JSON.stringify(sources),
      JSON.stringify(command.acceptanceOutcomes),
      sourceDigest,
      resolution.state,
      JSON.stringify(resolution.issues),
    ],
  );
  const insertedRow = inserted.rows[0];
  if (inserted.rowCount !== 1 || insertedRow === undefined) {
    throw new Error("Change Intent append failed");
  }
  const advanced = await client.query<{ optimistic_version: string }>(
    `
      UPDATE change_proposals
      SET optimistic_version = optimistic_version + 1,
          updated_at = clock_timestamp()
      WHERE id = $1 AND optimistic_version = $2
      RETURNING optimistic_version
    `,
    [proposal.canonical_proposal_id, proposalVersion],
  );
  const nextProposalVersion = Number(advanced.rows[0]?.optimistic_version);
  if (advanced.rowCount !== 1 || !Number.isSafeInteger(nextProposalVersion)) {
    throw new ChangeIntentPersistenceError("version_conflict");
  }

  const changeIntent = ChangeIntentSchema.parse({
    acceptanceOutcomes: command.acceptanceOutcomes,
    createdAt: insertedRow.created_at.toISOString(),
    id: insertedRow.id,
    objective: command.objective,
    resolution,
    scopeBoundaries: command.scopeBoundaries,
    sourceDigest,
    sources,
    text,
    version: Number(insertedRow.version),
  });
  await appendAuditRecordInTransaction(client, {
    actorId: input.actorId,
    actorType: "operator",
    causationId: null,
    correlationId: input.correlationId,
    denialReason: null,
    eventType: "change_intent.version_created",
    facts: {
      intentVersion: changeIntent.version,
      resolutionState: changeIntent.resolution.state,
      sourceCount: changeIntent.sources.length,
    },
    outcome: "succeeded",
    targetId: changeIntent.id,
    targetType: "change_intent",
  });
  return ChangeIntentVersionCreatedSchema.parse({
    schemaVersion: 1,
    projectId: proposal.canonical_project_id,
    changeProposalId: proposal.canonical_proposal_id,
    proposalVersion: nextProposalVersion,
    changeIntent,
  });
}

export async function createChangeIntentVersion(
  pool: DatabasePool,
  input: CreateChangeIntentVersionInput,
): Promise<ChangeIntentVersionCreated> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await createChangeIntentVersionInTransaction(client, input);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
