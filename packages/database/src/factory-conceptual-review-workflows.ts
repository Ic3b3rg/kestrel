import {
  FactoryConceptualReviewArtifactSchema,
  FactoryConceptualReviewDraftSchema,
  FactoryConceptualReviewFailureSchema,
  FactoryConceptualReviewHistorySchema,
  FactoryConceptualReviewPreparationSchema,
  FactoryConceptualReviewStartCommandSchema,
  FactoryConceptualReviewWorkflowReadSchema,
  GitObjectIdSchema,
  type FactoryConceptualReviewArtifact,
  type FactoryConceptualReviewDraft,
  type FactoryConceptualReviewFailure,
  type FactoryConceptualReviewHistory,
  type FactoryConceptualReviewPreparation,
  type FactoryConceptualReviewStartCommand,
  type FactoryConceptualReviewWorkflowRead,
  type FactoryFeaturePullRequest,
  type ExternalConceptualReviewPreparation,
} from "@kestrel/contracts";

import type { DiagnosticJobSender } from "./diagnostics.js";
import { FACTORY_CONCEPTUAL_REVIEW_QUEUE, pgBossDatabase } from "./pg-boss.js";
import type { DatabasePool } from "./pool.js";
import type { ConceptualReviewSourceBinding } from "@kestrel/local-source";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

export type FactoryConceptualReviewWorkflowPersistenceErrorCode =
  | "not_found"
  | "not_ready"
  | "preparation_conflict"
  | "active_review"
  | "stale_attempt"
  | "timeout"
  | "invalid_state";

export class FactoryConceptualReviewWorkflowPersistenceError extends Error {
  constructor(public readonly code: FactoryConceptualReviewWorkflowPersistenceErrorCode) {
    super(`Factory Conceptual Review Workflow persistence failed: ${code}`);
    this.name = "FactoryConceptualReviewWorkflowPersistenceError";
  }
}

export interface StartFactoryConceptualReviewWorkflowInput {
  actorId: string;
  correlationId: string;
  projectId: string;
  featureId: string;
  command: FactoryConceptualReviewStartCommand;
}

export interface StartExternalConceptualReviewWorkflowInput {
  actorId: string;
  correlationId: string;
  projectId: string;
  changeProposalId: string;
  command: FactoryConceptualReviewStartCommand;
}

export interface FactoryConceptualReviewClaim {
  workflowId: string;
  attemptId: string;
  attemptNumber: number;
  preparation: FactoryConceptualReviewPreparation;
}

export type FactoryConceptualReviewAttemptIdentity = Pick<
  FactoryConceptualReviewClaim,
  "workflowId" | "attemptId" | "attemptNumber"
>;

export interface FactoryConceptualReviewContainerIdentity {
  name: string;
  id: string | null;
}

export type FactoryConceptualReviewContainerRecovery = (
  container: {
    name: string;
    id: string | null;
    daemonId: string | null;
    image: string | null;
  },
  onIdentified: (id: string) => Promise<void>,
  signal: AbortSignal,
) => Promise<{ name: string; id: string }>;

export type FactoryConceptualReviewWorkspaceDisposal = (attemptId: string) => Promise<void>;

interface WorkflowRow {
  id: string;
  request_id: string;
  project_id: string;
  feature_id: string | null;
  change_proposal_id: string;
  review_revision_id: string;
  input_digest: string;
  factory_input: unknown;
  workflow_state: "queued" | "running" | "published" | "failed";
  attempt_count: number;
  maximum_attempts: number;
  failure_code: string | null;
  artifact_id: string | null;
  requested_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  artifact: unknown;
  current_head_commit_id: string | null;
}

const workflowColumns = `
  workflow.id, workflow.request_id, workflow.project_id, workflow.feature_id,
  workflow.change_proposal_id, workflow.review_revision_id, workflow.input_digest,
  workflow.factory_input, workflow.workflow_state, workflow.attempt_count,
  workflow.maximum_attempts, workflow.failure_code, workflow.artifact_id,
  workflow.requested_at, workflow.started_at, workflow.finished_at,
  artifact.artifact,
  CASE WHEN workflow.feature_id IS NULL THEN (
    SELECT proposal.head_object_id
    FROM change_proposals AS proposal
    WHERE proposal.id = workflow.change_proposal_id
  ) ELSE workflow.observed_head_commit_id END AS current_head_commit_id
`;

function mapWorkflow(row: WorkflowRow): FactoryConceptualReviewWorkflowRead {
  const preparation = FactoryConceptualReviewPreparationSchema.parse(row.factory_input);
  const artifact =
    row.artifact === null ? null : FactoryConceptualReviewArtifactSchema.parse(row.artifact);
  const reviewedHead = preparation.publication?.revision.head.objectId ?? null;
  const currency =
    reviewedHead === null || row.current_head_commit_id === null
      ? "unknown"
      : reviewedHead === row.current_head_commit_id
        ? "up_to_date"
        : "outdated";
  return FactoryConceptualReviewWorkflowReadSchema.parse({
    schemaVersion: 1,
    workflow: {
      id: row.id,
      requestId: row.request_id,
      projectId: row.project_id,
      featureId: row.feature_id,
      changeProposalId: row.change_proposal_id,
      inputDigest: row.input_digest,
      reviewRevisionId: row.review_revision_id,
      state: row.workflow_state,
      attempt: { current: row.attempt_count, maximum: row.maximum_attempts },
      failure: row.failure_code,
      artifactId: row.artifact_id,
      requestedAt: row.requested_at.toISOString(),
      startedAt: row.started_at?.toISOString() ?? null,
      finishedAt: row.finished_at?.toISOString() ?? null,
    },
    artifact,
    currency,
  });
}

function accepted(
  id: string,
  requestedAt: Date,
  preparation: FactoryConceptualReviewPreparation,
  command: FactoryConceptualReviewStartCommand,
): FactoryConceptualReviewWorkflowRead {
  const publication = preparation.publication;
  if (
    preparation.changeProposalId === null ||
    preparation.preparationDigest === null ||
    publication === null
  )
    throw new FactoryConceptualReviewWorkflowPersistenceError("not_ready");
  return FactoryConceptualReviewWorkflowReadSchema.parse({
    schemaVersion: 1,
    workflow: {
      id,
      requestId: command.requestId,
      projectId: preparation.projectId,
      featureId: preparation.featureId,
      changeProposalId: preparation.changeProposalId,
      inputDigest: preparation.preparationDigest,
      reviewRevisionId: publication.revision.id,
      state: "queued",
      attempt: { current: 0, maximum: preparation.configuration.resources.maximumAttempts },
      failure: null,
      artifactId: null,
      requestedAt: requestedAt.toISOString(),
      startedAt: null,
      finishedAt: null,
    },
    artifact: null,
    currency: "unknown",
  });
}

function uniqueness(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

async function readWorkflow(
  pool: DatabasePool,
  input: { projectId: string; featureId: string; workflowId?: string; artifactId?: string },
): Promise<FactoryConceptualReviewWorkflowRead | null> {
  const result = await pool.query<WorkflowRow>(
    `SELECT ${workflowColumns}
     FROM review_workflows AS workflow
     LEFT JOIN factory_conceptual_review_artifacts AS artifact
       ON artifact.id = workflow.artifact_id AND artifact.workflow_id = workflow.id
     WHERE workflow.project_id = $1 AND workflow.feature_id = $2
       AND ($3::uuid IS NULL OR workflow.id = $3)
       AND ($4::uuid IS NULL OR artifact.id = $4)
     ORDER BY workflow.requested_at DESC, workflow.id DESC
     LIMIT 1`,
    [input.projectId, input.featureId, input.workflowId ?? null, input.artifactId ?? null],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapWorkflow(row);
}

export function readCurrentFactoryConceptualReviewWorkflow(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
): Promise<FactoryConceptualReviewWorkflowRead | null> {
  return readWorkflow(pool, { projectId, featureId });
}

export function readFactoryConceptualReviewWorkflow(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  workflowId: string,
): Promise<FactoryConceptualReviewWorkflowRead | null> {
  return readWorkflow(pool, { projectId, featureId, workflowId });
}

export function readFactoryConceptualReviewArtifact(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  artifactId: string,
): Promise<FactoryConceptualReviewWorkflowRead | null> {
  return readWorkflow(pool, { projectId, featureId, artifactId });
}

async function readExternalWorkflow(
  pool: DatabasePool,
  input: {
    projectId: string;
    changeProposalId: string;
    workflowId?: string;
    artifactId?: string;
  },
): Promise<FactoryConceptualReviewWorkflowRead | null> {
  const result = await pool.query<WorkflowRow>(
    `SELECT ${workflowColumns}
     FROM review_workflows AS workflow
     LEFT JOIN factory_conceptual_review_artifacts AS artifact
       ON artifact.id = workflow.artifact_id AND artifact.workflow_id = workflow.id
     WHERE workflow.project_id = $1 AND workflow.change_proposal_id = $2
       AND workflow.feature_id IS NULL AND workflow.factory_input IS NOT NULL
       AND ($3::uuid IS NULL OR workflow.id = $3)
       AND ($4::uuid IS NULL OR artifact.id = $4)
     ORDER BY workflow.requested_at DESC, workflow.id DESC
     LIMIT 1`,
    [input.projectId, input.changeProposalId, input.workflowId ?? null, input.artifactId ?? null],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapWorkflow(row);
}

export function readCurrentExternalConceptualReviewWorkflow(
  pool: DatabasePool,
  projectId: string,
  changeProposalId: string,
): Promise<FactoryConceptualReviewWorkflowRead | null> {
  return readExternalWorkflow(pool, { projectId, changeProposalId });
}

export function readExternalConceptualReviewWorkflow(
  pool: DatabasePool,
  projectId: string,
  changeProposalId: string,
  workflowId: string,
): Promise<FactoryConceptualReviewWorkflowRead | null> {
  return readExternalWorkflow(pool, { projectId, changeProposalId, workflowId });
}

export function readExternalConceptualReviewArtifact(
  pool: DatabasePool,
  projectId: string,
  changeProposalId: string,
  artifactId: string,
): Promise<FactoryConceptualReviewWorkflowRead | null> {
  return readExternalWorkflow(pool, { projectId, changeProposalId, artifactId });
}

export async function readFactoryConceptualReviewHistory(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  offset = 0,
  limit = 20,
): Promise<FactoryConceptualReviewHistory> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
  const [counted, selected] = await Promise.all([
    pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
       FROM review_workflows AS workflow
       JOIN factory_conceptual_review_artifacts AS artifact
         ON artifact.id = workflow.artifact_id AND artifact.workflow_id = workflow.id
       WHERE workflow.project_id = $1 AND workflow.feature_id = $2
         AND workflow.workflow_state = 'published'`,
      [projectId, featureId],
    ),
    pool.query<WorkflowRow>(
      `SELECT ${workflowColumns}
       FROM review_workflows AS workflow
       JOIN factory_conceptual_review_artifacts AS artifact
         ON artifact.id = workflow.artifact_id AND artifact.workflow_id = workflow.id
       WHERE workflow.project_id = $1 AND workflow.feature_id = $2
         AND workflow.workflow_state = 'published'
       ORDER BY workflow.requested_at DESC, workflow.id DESC
       OFFSET $3 LIMIT $4`,
      [projectId, featureId, offset, limit],
    ),
  ]);
  const total = Number(counted.rows[0]?.total ?? 0);
  if (!Number.isSafeInteger(total) || total < 0)
    throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
  const reviews = selected.rows.map((row) => {
    const read = mapWorkflow(row);
    if (read.artifact === null || read.workflow.finishedAt === null)
      throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
    return {
      artifactId: read.artifact.id,
      workflowId: read.workflow.id,
      status: read.artifact.status,
      headCommitId: read.artifact.headCommitId,
      requestedAt: read.workflow.requestedAt,
      finishedAt: read.workflow.finishedAt,
      currency: read.currency,
    };
  });
  return FactoryConceptualReviewHistorySchema.parse({
    schemaVersion: 1,
    reviews,
    offset,
    total,
    nextOffset: offset + reviews.length < total ? offset + reviews.length : null,
  });
}

export async function readExternalConceptualReviewHistory(
  pool: DatabasePool,
  projectId: string,
  changeProposalId: string,
  offset = 0,
  limit = 20,
): Promise<FactoryConceptualReviewHistory> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  ) {
    throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
  }
  const [counted, selected] = await Promise.all([
    pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
       FROM review_workflows AS workflow
       JOIN factory_conceptual_review_artifacts AS artifact
         ON artifact.id = workflow.artifact_id AND artifact.workflow_id = workflow.id
       WHERE workflow.project_id = $1 AND workflow.change_proposal_id = $2
         AND workflow.feature_id IS NULL AND workflow.factory_input IS NOT NULL
         AND workflow.workflow_state = 'published'`,
      [projectId, changeProposalId],
    ),
    pool.query<WorkflowRow>(
      `SELECT ${workflowColumns}
       FROM review_workflows AS workflow
       JOIN factory_conceptual_review_artifacts AS artifact
         ON artifact.id = workflow.artifact_id AND artifact.workflow_id = workflow.id
       WHERE workflow.project_id = $1 AND workflow.change_proposal_id = $2
         AND workflow.feature_id IS NULL AND workflow.factory_input IS NOT NULL
         AND workflow.workflow_state = 'published'
       ORDER BY workflow.requested_at DESC, workflow.id DESC
       OFFSET $3 LIMIT $4`,
      [projectId, changeProposalId, offset, limit],
    ),
  ]);
  const total = Number(counted.rows[0]?.total ?? 0);
  if (!Number.isSafeInteger(total) || total < 0)
    throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
  const reviews = selected.rows.map((row) => {
    const read = mapWorkflow(row);
    if (read.artifact === null || read.workflow.finishedAt === null)
      throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
    return {
      artifactId: read.artifact.id,
      workflowId: read.workflow.id,
      status: read.artifact.status,
      headCommitId: read.artifact.headCommitId,
      requestedAt: read.workflow.requestedAt,
      finishedAt: read.workflow.finishedAt,
      currency: read.currency,
    };
  });
  return FactoryConceptualReviewHistorySchema.parse({
    schemaVersion: 1,
    reviews,
    offset,
    total,
    nextOffset: offset + reviews.length < total ? offset + reviews.length : null,
  });
}

export async function readFactoryConceptualReviewWorkflowSourceBinding(
  pool: DatabasePool,
  workflowId: string,
): Promise<Omit<ConceptualReviewSourceBinding, "side">> {
  const result = await pool.query<{ factory_input: unknown; artifact_locator: string | null }>(
    `SELECT workflow.factory_input, revision.artifact_locator
     FROM review_workflows AS workflow
     JOIN review_revisions AS revision ON revision.id = workflow.review_revision_id
     WHERE workflow.id = $1 AND workflow.factory_input IS NOT NULL`,
    [workflowId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new FactoryConceptualReviewWorkflowPersistenceError("not_found");
  const preparation = FactoryConceptualReviewPreparationSchema.parse(row.factory_input);
  if (row.artifact_locator === null || preparation.publication === null)
    throw new FactoryConceptualReviewWorkflowPersistenceError("not_ready");
  const expectedHeadTreeId =
    preparation.featureId === null
      ? preparation.evidence?.source.headTreeId
      : preparation.publication.certificate.revision.treeId;
  if (expectedHeadTreeId === undefined)
    throw new FactoryConceptualReviewWorkflowPersistenceError("not_ready");
  return {
    artifactLocator: row.artifact_locator,
    manifestDigest: preparation.publication.retainedManifestDigest,
    expectedBaseCommitId: preparation.publication.revision.base.objectId,
    expectedHeadCommitId: preparation.publication.revision.head.objectId,
    expectedHeadTreeId,
  };
}

export async function readFactoryConceptualReviewWorkflowPullRequest(
  pool: DatabasePool,
  workflowId: string,
): Promise<FactoryFeaturePullRequest> {
  const result = await pool.query<{ factory_input: unknown }>(
    `SELECT factory_input FROM review_workflows
     WHERE id = $1 AND feature_id IS NOT NULL`,
    [workflowId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new FactoryConceptualReviewWorkflowPersistenceError("not_found");
  const preparation = FactoryConceptualReviewPreparationSchema.parse(row.factory_input);
  if (preparation.featureId === null || preparation.publication === null)
    throw new FactoryConceptualReviewWorkflowPersistenceError("not_ready");
  return preparation.publication.pullRequest;
}

export async function startFactoryConceptualReviewWorkflow(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  input: StartFactoryConceptualReviewWorkflowInput,
  prepare: (pool: DatabasePool) => Promise<FactoryConceptualReviewPreparation>,
  transactionTimeoutMs = 10_000,
): Promise<FactoryConceptualReviewWorkflowRead> {
  const command = FactoryConceptualReviewStartCommandSchema.parse(input.command);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await configureDatabaseDeadline(client, transactionTimeoutMs);
    const locked = await client.query<{
      project_id: string;
      change_proposal_id: string;
      change_intent_id: string;
      review_revision_id: string;
    }>(
      `SELECT feature.project_id, binding.change_proposal_id,
        revision.acquisition_change_intent_id AS change_intent_id,
        revision.id AS review_revision_id
       FROM factory_features AS feature
       JOIN factory_feature_pr_revisions AS binding ON binding.feature_id = feature.id
       JOIN review_revisions AS revision ON revision.id = binding.review_revision_id
       JOIN change_proposals AS proposal
         ON proposal.id = binding.change_proposal_id
        AND proposal.canonical_change_proposal_id IS NULL
        AND proposal.project_id = feature.project_id
       WHERE feature.project_id = $1 AND feature.id = $2
       FOR UPDATE OF feature, proposal`,
      [input.projectId, input.featureId],
    );
    const identity = locked.rows[0];
    if (locked.rowCount !== 1 || identity === undefined)
      throw new FactoryConceptualReviewWorkflowPersistenceError("not_found");

    const duplicate = await client.query<WorkflowRow>(
      `SELECT ${workflowColumns}
       FROM review_workflows AS workflow
       LEFT JOIN factory_conceptual_review_artifacts AS artifact
         ON artifact.id = workflow.artifact_id AND artifact.workflow_id = workflow.id
       WHERE workflow.feature_id = $1 AND workflow.request_id = $2`,
      [input.featureId, command.requestId],
    );
    const retained = duplicate.rows[0];
    if (retained !== undefined) {
      await client.query("COMMIT");
      return mapWorkflow(retained);
    }

    const unresolvedEnvironment = await client.query<{ present: number }>(
      `SELECT CASE
         WHEN attempt.container_name IS NOT NULL AND attempt.container_stopped_at IS NULL THEN 1
         WHEN attempt.workspace_disposed_at IS NULL THEN 1
         ELSE 0
       END AS present
       FROM review_workflows AS workflow
       JOIN review_workflow_attempts AS attempt
         ON attempt.workflow_id = workflow.id
        AND attempt.attempt_id = workflow.attempt_id
        AND attempt.attempt_number = workflow.attempt_count
       WHERE workflow.change_proposal_id = $1
         AND workflow.factory_input IS NOT NULL
         AND workflow.workflow_state = 'failed'
         AND workflow.failure_code = 'stop_unconfirmed'
       ORDER BY workflow.requested_at, workflow.id
       LIMIT 1
       FOR UPDATE OF workflow, attempt`,
      [identity.change_proposal_id],
    );
    if (unresolvedEnvironment.rowCount !== 0)
      throw new FactoryConceptualReviewWorkflowPersistenceError("active_review");

    const preparation = await prepare(client as unknown as DatabasePool);
    if (
      preparation.featureId === null ||
      preparation.featureId !== input.featureId ||
      preparation.readiness.state !== "ready" ||
      !preparation.readiness.startAllowed ||
      preparation.preparationDigest === null ||
      preparation.publication === null ||
      preparation.changeProposalId !== identity.change_proposal_id
    )
      throw new FactoryConceptualReviewWorkflowPersistenceError("not_ready");
    if (preparation.preparationDigest !== command.preparationDigest)
      throw new FactoryConceptualReviewWorkflowPersistenceError("preparation_conflict");
    if (preparation.publication.revision.id !== identity.review_revision_id)
      throw new FactoryConceptualReviewWorkflowPersistenceError("preparation_conflict");

    const inserted = await client.query<{ id: string; requested_at: Date }>(
      `WITH identity AS (SELECT uuidv7() AS id)
       INSERT INTO review_workflows (
         id, project_id, change_proposal_id, review_revision_id, change_intent_id,
         requested_by_operator_id, input_digest, analysis_configuration, authority,
         resource_envelope, workflow_state, feature_id, request_id, factory_input,
         job_id, maximum_attempts
       )
       SELECT identity.id, $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb,
         $9::jsonb, 'queued', $10, $11, $12::jsonb, identity.id, $13
       FROM identity
       RETURNING id, requested_at`,
      [
        preparation.projectId,
        preparation.changeProposalId,
        preparation.publication.revision.id,
        identity.change_intent_id,
        input.actorId,
        preparation.preparationDigest,
        JSON.stringify(preparation.configuration),
        JSON.stringify({
          kind: "approved_feature_plan",
          actorId: input.actorId,
          approvalId: preparation.basis?.provenance.approvalId,
          approvedVersion: preparation.basis?.provenance.version,
        }),
        JSON.stringify(preparation.configuration.resources),
        preparation.featureId,
        command.requestId,
        JSON.stringify(preparation),
        preparation.configuration.resources.maximumAttempts,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error("Conceptual Review Workflow was not inserted");
    const jobId = await boss.send(
      FACTORY_CONCEPTUAL_REVIEW_QUEUE,
      { workflowId: row.id },
      { db: pgBossDatabase(client), id: row.id },
    );
    if (jobId !== row.id) throw new Error("Conceptual Review Workflow was not durably queued");
    const result = accepted(row.id, row.requested_at, preparation, command);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollback(client);
    if (databaseDeadline(error))
      throw new FactoryConceptualReviewWorkflowPersistenceError("timeout");
    if (uniqueness(error))
      throw new FactoryConceptualReviewWorkflowPersistenceError("active_review");
    throw error;
  } finally {
    client.release();
  }
}

export async function startExternalConceptualReviewWorkflow(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  input: StartExternalConceptualReviewWorkflowInput,
  prepare: (pool: DatabasePool) => Promise<ExternalConceptualReviewPreparation>,
  transactionTimeoutMs = 10_000,
): Promise<FactoryConceptualReviewWorkflowRead> {
  const command = FactoryConceptualReviewStartCommandSchema.parse(input.command);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await configureDatabaseDeadline(client, transactionTimeoutMs);
    const locked = await client.query<{
      project_id: string;
      change_proposal_id: string;
      change_intent_id: string | null;
      review_revision_id: string | null;
    }>(
      `SELECT project.id AS project_id, proposal.id AS change_proposal_id,
         intent.id AS change_intent_id, revision.id AS review_revision_id
       FROM projects AS requested_project
       JOIN projects AS project
         ON project.id = COALESCE(requested_project.canonical_project_id, requested_project.id)
       JOIN change_proposals AS requested_proposal ON requested_proposal.id = $2
       JOIN change_proposals AS proposal
         ON proposal.id = COALESCE(
           requested_proposal.canonical_change_proposal_id,
           requested_proposal.id
         )
        AND proposal.project_id = project.id
        AND proposal.proposal_kind = 'provider_observed'
       LEFT JOIN LATERAL (
         SELECT current_intent.id
         FROM change_intents AS current_intent
         JOIN change_proposals AS intent_proposal
           ON intent_proposal.id = current_intent.change_proposal_id
         WHERE COALESCE(intent_proposal.canonical_change_proposal_id, intent_proposal.id) = proposal.id
         ORDER BY current_intent.version DESC, current_intent.created_at DESC, current_intent.id DESC
         LIMIT 1
       ) AS intent ON true
       LEFT JOIN LATERAL (
         SELECT retained.id
         FROM review_revisions AS retained
         JOIN change_proposals AS retained_proposal
           ON retained_proposal.id = retained.change_proposal_id
         WHERE retained.revision_state = 'available'
           AND retained.base_object_id = proposal.base_object_id
           AND retained.head_object_id = proposal.head_object_id
           AND COALESCE(retained_proposal.canonical_change_proposal_id, retained_proposal.id)
             = proposal.id
         ORDER BY retained.available_at DESC, retained.id DESC
         LIMIT 1
       ) AS revision ON true
       WHERE requested_project.id = $1
       FOR UPDATE OF project, proposal`,
      [input.projectId, input.changeProposalId],
    );
    const identity = locked.rows[0];
    if (locked.rowCount !== 1 || identity === undefined)
      throw new FactoryConceptualReviewWorkflowPersistenceError("not_found");

    const duplicate = await client.query<WorkflowRow>(
      `SELECT ${workflowColumns}
       FROM review_workflows AS workflow
       LEFT JOIN factory_conceptual_review_artifacts AS artifact
         ON artifact.id = workflow.artifact_id AND artifact.workflow_id = workflow.id
       WHERE workflow.change_proposal_id = $1 AND workflow.request_id = $2
         AND workflow.feature_id IS NULL AND workflow.factory_input IS NOT NULL`,
      [identity.change_proposal_id, command.requestId],
    );
    const retained = duplicate.rows[0];
    if (retained !== undefined) {
      await client.query("COMMIT");
      return mapWorkflow(retained);
    }

    const unresolvedEnvironment = await client.query<{ present: number }>(
      `SELECT CASE
         WHEN attempt.container_name IS NOT NULL AND attempt.container_stopped_at IS NULL THEN 1
         WHEN attempt.workspace_disposed_at IS NULL THEN 1
         ELSE 0
       END AS present
       FROM review_workflows AS workflow
       JOIN review_workflow_attempts AS attempt
         ON attempt.workflow_id = workflow.id
        AND attempt.attempt_id = workflow.attempt_id
        AND attempt.attempt_number = workflow.attempt_count
       WHERE workflow.change_proposal_id = $1
         AND workflow.factory_input IS NOT NULL
         AND workflow.workflow_state = 'failed'
         AND workflow.failure_code = 'stop_unconfirmed'
       ORDER BY workflow.requested_at, workflow.id
       LIMIT 1
       FOR UPDATE OF workflow, attempt`,
      [identity.change_proposal_id],
    );
    if (unresolvedEnvironment.rowCount !== 0)
      throw new FactoryConceptualReviewWorkflowPersistenceError("active_review");

    const preparation = await prepare(client as unknown as DatabasePool);
    if (
      preparation.readiness.state !== "ready" ||
      !preparation.readiness.startAllowed ||
      preparation.preparationDigest === null ||
      preparation.basis === null ||
      preparation.publication === null ||
      preparation.changeProposalId !== identity.change_proposal_id ||
      preparation.projectId !== identity.project_id ||
      preparation.basis.provenance.changeIntentId !== identity.change_intent_id ||
      preparation.publication.revision.id !== identity.review_revision_id
    ) {
      throw new FactoryConceptualReviewWorkflowPersistenceError("not_ready");
    }
    if (preparation.preparationDigest !== command.preparationDigest)
      throw new FactoryConceptualReviewWorkflowPersistenceError("preparation_conflict");

    const inserted = await client.query<{ id: string; requested_at: Date }>(
      `WITH identity AS (SELECT uuidv7() AS id)
       INSERT INTO review_workflows (
         id, project_id, change_proposal_id, review_revision_id, change_intent_id,
         requested_by_operator_id, input_digest, analysis_configuration, authority,
         resource_envelope, workflow_state, feature_id, request_id, factory_input,
         job_id, maximum_attempts
       )
       SELECT identity.id, $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb,
         $9::jsonb, 'queued', NULL, $10, $11::jsonb, identity.id, $12
       FROM identity
       RETURNING id, requested_at`,
      [
        preparation.projectId,
        preparation.changeProposalId,
        preparation.publication.revision.id,
        preparation.basis.provenance.changeIntentId,
        input.actorId,
        preparation.preparationDigest,
        JSON.stringify(preparation.configuration),
        JSON.stringify({
          kind: "external_pull_request",
          actorId: input.actorId,
          changeIntentId: preparation.basis.provenance.changeIntentId,
          changeIntentVersion: preparation.basis.provenance.version,
          resolution: preparation.basis.provenance.resolution,
        }),
        JSON.stringify(preparation.configuration.resources),
        command.requestId,
        JSON.stringify(preparation),
        preparation.configuration.resources.maximumAttempts,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error("Conceptual Review Workflow was not inserted");
    const jobId = await boss.send(
      FACTORY_CONCEPTUAL_REVIEW_QUEUE,
      { workflowId: row.id },
      { db: pgBossDatabase(client), id: row.id },
    );
    if (jobId !== row.id) throw new Error("Conceptual Review Workflow was not durably queued");
    const result = accepted(row.id, row.requested_at, preparation, command);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollback(client);
    if (databaseDeadline(error))
      throw new FactoryConceptualReviewWorkflowPersistenceError("timeout");
    if (uniqueness(error))
      throw new FactoryConceptualReviewWorkflowPersistenceError("active_review");
    throw error;
  } finally {
    client.release();
  }
}

export async function claimFactoryConceptualReviewWorkflow(
  pool: DatabasePool,
  workflowId: string,
  transactionTimeoutMs = 10_000,
): Promise<FactoryConceptualReviewClaim | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await configureDatabaseDeadline(client, transactionTimeoutMs);
    const claimed = await client.query<{
      id: string;
      attempt_id: string;
      attempt_count: number;
      factory_input: unknown;
    }>(
      `UPDATE review_workflows
       SET workflow_state = 'running', attempt_count = attempt_count + 1,
         attempt_id = uuidv7(), started_at = COALESCE(started_at, clock_timestamp()),
         heartbeat_at = clock_timestamp(), failure_code = NULL,
         observed_head_commit_id = NULL, head_observed_at = NULL
       WHERE id = $1 AND factory_input IS NOT NULL AND workflow_state = 'queued'
         AND attempt_count < maximum_attempts
       RETURNING id, attempt_id, attempt_count, factory_input`,
      [workflowId],
    );
    const row = claimed.rows[0];
    if (row === undefined) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `INSERT INTO review_workflow_attempts
        (workflow_id, attempt_number, attempt_id, attempt_state)
       VALUES ($1, $2, $3, 'running')`,
      [row.id, row.attempt_count, row.attempt_id],
    );
    const claim = {
      workflowId: row.id,
      attemptId: row.attempt_id,
      attemptNumber: row.attempt_count,
      preparation: FactoryConceptualReviewPreparationSchema.parse(row.factory_input),
    };
    await client.query("COMMIT");
    return claim;
  } catch (error) {
    await rollback(client);
    if (databaseDeadline(error))
      throw new FactoryConceptualReviewWorkflowPersistenceError("timeout");
    throw error;
  } finally {
    client.release();
  }
}

function assertContainerName(name: string): void {
  if (!/^kestrel-factory-[a-f0-9]{32}$/u.test(name))
    throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
}

function requireCurrentAttempt(result: { rowCount: number | null }): void {
  if (result.rowCount !== 1)
    throw new FactoryConceptualReviewWorkflowPersistenceError("stale_attempt");
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Operation interrupted");
}

function databaseDeadline(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "55P03" || error.code === "57014")
  );
}

async function rollback(client: Pick<PoolClient, "query">): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction failure.
  }
}

function assertDatabaseTimeout(transactionTimeoutMs: number): void {
  if (!Number.isSafeInteger(transactionTimeoutMs) || transactionTimeoutMs < 1)
    throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
}

async function configureDatabaseDeadline(
  client: Pick<PoolClient, "query">,
  transactionTimeoutMs: number,
): Promise<void> {
  assertDatabaseTimeout(transactionTimeoutMs);
  await client.query(
    `SELECT set_config('lock_timeout', $1, true),
      set_config('statement_timeout', $1, true)`,
    [`${String(transactionTimeoutMs)}ms`],
  );
}

async function boundedQuery<T extends QueryResultRow>(
  pool: DatabasePool,
  sql: string,
  values: readonly unknown[] = [],
  transactionTimeoutMs = 10_000,
): Promise<QueryResult<T>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await configureDatabaseDeadline(client, transactionTimeoutMs);
    const result = await client.query<T>(sql, [...values]);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollback(client);
    if (databaseDeadline(error))
      throw new FactoryConceptualReviewWorkflowPersistenceError("timeout");
    throw error;
  } finally {
    client.release();
  }
}

async function boundedCallback<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  assertDatabaseTimeout(timeoutMs);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new FactoryConceptualReviewWorkflowPersistenceError("timeout")),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function boundedMutation(
  pool: DatabasePool,
  sql: string,
  values: readonly unknown[],
  transactionTimeoutMs = 10_000,
): Promise<{ rowCount: number | null }> {
  assertDatabaseTimeout(transactionTimeoutMs);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await configureDatabaseDeadline(client, transactionTimeoutMs);
    const result = await client.query(sql, [...values]);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollback(client);
    if (databaseDeadline(error))
      throw new FactoryConceptualReviewWorkflowPersistenceError("timeout");
    throw error;
  } finally {
    client.release();
  }
}

export async function reserveFactoryConceptualReviewContainer(
  pool: DatabasePool,
  claim: FactoryConceptualReviewAttemptIdentity,
  name: string,
  daemonId?: string,
  transactionTimeoutMs = 10_000,
): Promise<void> {
  assertContainerName(name);
  if (daemonId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u.test(daemonId))
    throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
  requireCurrentAttempt(
    await boundedMutation(
      pool,
      `UPDATE review_workflow_attempts AS attempt
       SET container_name = $4, docker_daemon_id = $5,
         heartbeat_at = clock_timestamp()
       FROM review_workflows AS workflow
       WHERE attempt.workflow_id = $1 AND attempt.attempt_id = $2
         AND attempt.attempt_number = $3 AND attempt.attempt_state = 'running'
         AND attempt.container_name IS NULL
         AND workflow.id = attempt.workflow_id AND workflow.attempt_id = attempt.attempt_id
         AND workflow.attempt_count = attempt.attempt_number
         AND workflow.workflow_state = 'running'`,
      [claim.workflowId, claim.attemptId, claim.attemptNumber, name, daemonId ?? null],
      transactionTimeoutMs,
    ),
  );
}

export async function identifyFactoryConceptualReviewContainer(
  pool: DatabasePool,
  claim: FactoryConceptualReviewAttemptIdentity,
  container: { name: string; id: string },
  transactionTimeoutMs = 10_000,
): Promise<void> {
  assertContainerName(container.name);
  if (!/^[a-f0-9]{64}$/u.test(container.id))
    throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
  requireCurrentAttempt(
    await boundedMutation(
      pool,
      `UPDATE review_workflow_attempts AS attempt
       SET container_id = $5, heartbeat_at = clock_timestamp()
       FROM review_workflows AS workflow
       WHERE attempt.workflow_id = $1 AND attempt.attempt_id = $2
         AND attempt.attempt_number = $3 AND attempt.attempt_state = 'running'
         AND attempt.container_name = $4
         AND (attempt.container_id IS NULL OR attempt.container_id = $5)
         AND attempt.container_stopped_at IS NULL
         AND workflow.id = attempt.workflow_id AND workflow.attempt_id = attempt.attempt_id
         AND workflow.attempt_count = attempt.attempt_number
         AND workflow.workflow_state = 'running'`,
      [claim.workflowId, claim.attemptId, claim.attemptNumber, container.name, container.id],
      transactionTimeoutMs,
    ),
  );
}

export async function stopFactoryConceptualReviewContainer(
  pool: DatabasePool,
  claim: FactoryConceptualReviewAttemptIdentity,
  container: FactoryConceptualReviewContainerIdentity,
  transactionTimeoutMs = 10_000,
): Promise<void> {
  assertContainerName(container.name);
  if (container.id !== null && !/^[a-f0-9]{64}$/u.test(container.id))
    throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
  requireCurrentAttempt(
    await boundedMutation(
      pool,
      `UPDATE review_workflow_attempts
       SET container_id = COALESCE(container_id, $5),
         container_stopped_at = COALESCE(container_stopped_at, clock_timestamp()),
         heartbeat_at = clock_timestamp()
       WHERE workflow_id = $1 AND attempt_id = $2 AND attempt_number = $3
         AND attempt_state = 'running' AND container_name = $4
         AND (container_id IS NULL OR container_id = $5)`,
      [claim.workflowId, claim.attemptId, claim.attemptNumber, container.name, container.id],
      transactionTimeoutMs,
    ),
  );
}

export async function recordFactoryConceptualReviewResourceDisposal(
  pool: DatabasePool,
  claim: FactoryConceptualReviewAttemptIdentity,
  transactionTimeoutMs = 10_000,
): Promise<void> {
  requireCurrentAttempt(
    await boundedMutation(
      pool,
      `UPDATE review_workflow_attempts AS attempt
       SET workspace_disposed_at = COALESCE(workspace_disposed_at, clock_timestamp()),
         heartbeat_at = clock_timestamp()
       FROM review_workflows AS workflow
       WHERE attempt.workflow_id = $1 AND attempt.attempt_id = $2
         AND attempt.attempt_number = $3
         AND (attempt.container_name IS NULL OR attempt.container_stopped_at IS NOT NULL)
         AND workflow.id = attempt.workflow_id
         AND workflow.attempt_id = attempt.attempt_id
         AND workflow.attempt_count = attempt.attempt_number
         AND workflow.workflow_state = 'running'`,
      [claim.workflowId, claim.attemptId, claim.attemptNumber],
      transactionTimeoutMs,
    ),
  );
}

export async function recordFactoryConceptualReviewSession(
  pool: DatabasePool,
  claim: FactoryConceptualReviewAttemptIdentity,
  identity: { threadId: string } | { turnId: string },
  transactionTimeoutMs = 10_000,
): Promise<void> {
  const threadId = "threadId" in identity ? identity.threadId : null;
  const turnId = "turnId" in identity ? identity.turnId : null;
  const value = threadId ?? turnId;
  if (value === null || value.length < 1 || value.length > 512 || value.includes("\0"))
    throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
  requireCurrentAttempt(
    await boundedMutation(
      pool,
      `UPDATE review_workflow_attempts AS attempt
       SET runtime_thread_id = COALESCE(runtime_thread_id, $4),
         runtime_turn_id = COALESCE(runtime_turn_id, $5),
         heartbeat_at = clock_timestamp()
       FROM review_workflows AS workflow
       WHERE attempt.workflow_id = $1 AND attempt.attempt_id = $2
         AND attempt.attempt_number = $3 AND attempt.attempt_state = 'running'
         AND ($4::text IS NULL OR attempt.runtime_thread_id IS NULL OR attempt.runtime_thread_id = $4)
         AND ($5::text IS NULL OR attempt.runtime_turn_id IS NULL OR attempt.runtime_turn_id = $5)
         AND workflow.id = attempt.workflow_id AND workflow.attempt_id = attempt.attempt_id
         AND workflow.attempt_count = attempt.attempt_number
         AND workflow.workflow_state = 'running'`,
      [claim.workflowId, claim.attemptId, claim.attemptNumber, threadId, turnId],
      transactionTimeoutMs,
    ),
  );
}

export async function heartbeatFactoryConceptualReviewWorkflow(
  pool: DatabasePool,
  claim: FactoryConceptualReviewAttemptIdentity,
  transactionTimeoutMs = 10_000,
): Promise<boolean> {
  const result = await boundedMutation(
    pool,
    `WITH touched AS (
       UPDATE review_workflow_attempts AS attempt
       SET heartbeat_at = clock_timestamp()
       FROM review_workflows AS workflow
       WHERE attempt.workflow_id = $1 AND attempt.attempt_id = $2
         AND attempt.attempt_number = $3 AND attempt.attempt_state = 'running'
         AND workflow.id = attempt.workflow_id AND workflow.attempt_id = attempt.attempt_id
         AND workflow.attempt_count = attempt.attempt_number
         AND workflow.workflow_state = 'running'
       RETURNING attempt.workflow_id, attempt.attempt_id, attempt.attempt_number
     )
     UPDATE review_workflows AS workflow
     SET heartbeat_at = clock_timestamp()
     FROM touched
     WHERE workflow.id = touched.workflow_id
       AND workflow.attempt_id = touched.attempt_id
       AND workflow.attempt_count = touched.attempt_number
       AND workflow.workflow_state = 'running'`,
    [claim.workflowId, claim.attemptId, claim.attemptNumber],
    transactionTimeoutMs,
  );
  return result.rowCount === 1;
}

export async function observeFactoryConceptualReviewHead(
  pool: DatabasePool,
  claim: FactoryConceptualReviewAttemptIdentity,
  observedHeadCommitId: string,
  transactionTimeoutMs = 10_000,
): Promise<void> {
  const head = GitObjectIdSchema.parse(observedHeadCommitId);
  requireCurrentAttempt(
    await boundedMutation(
      pool,
      `UPDATE review_workflows
       SET observed_head_commit_id = $4, head_observed_at = clock_timestamp(),
         heartbeat_at = clock_timestamp()
       WHERE id = $1 AND attempt_id = $2 AND attempt_count = $3
         AND workflow_state = 'running'`,
      [claim.workflowId, claim.attemptId, claim.attemptNumber, head],
      transactionTimeoutMs,
    ),
  );
}

export async function observePublishedFactoryConceptualReviewHead(
  pool: DatabasePool,
  workflowId: string,
  observedHeadCommitId: string,
  transactionTimeoutMs = 10_000,
): Promise<void> {
  const head = GitObjectIdSchema.parse(observedHeadCommitId);
  requireCurrentAttempt(
    await boundedMutation(
      pool,
      `UPDATE review_workflows
       SET observed_head_commit_id = $2, head_observed_at = clock_timestamp()
       WHERE id = $1 AND factory_input IS NOT NULL AND workflow_state = 'published'`,
      [workflowId, head],
      transactionTimeoutMs,
    ),
  );
}

export async function failFactoryConceptualReviewWorkflow(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  claim: FactoryConceptualReviewAttemptIdentity,
  value: FactoryConceptualReviewFailure,
  retryable: boolean,
  transactionTimeoutMs = 10_000,
): Promise<"queued" | "failed"> {
  const failure = FactoryConceptualReviewFailureSchema.parse(value);
  if (!Number.isSafeInteger(transactionTimeoutMs) || transactionTimeoutMs < 1)
    throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('lock_timeout', $1, true),
        set_config('statement_timeout', $1, true)`,
      [`${String(transactionTimeoutMs)}ms`],
    );
    const attempt = await client.query(
      `UPDATE review_workflow_attempts
       SET attempt_state = 'failed', failure_code = $4,
         heartbeat_at = clock_timestamp(), finished_at = clock_timestamp()
       WHERE workflow_id = $1 AND attempt_id = $2 AND attempt_number = $3
         AND attempt_state = 'running'`,
      [claim.workflowId, claim.attemptId, claim.attemptNumber, failure],
    );
    if (attempt.rowCount !== 1)
      throw new FactoryConceptualReviewWorkflowPersistenceError("stale_attempt");
    const updated = await client.query<{ job_id: string | null; retrying: boolean }>(
      `UPDATE review_workflows
       SET workflow_state = CASE
           WHEN $5 AND attempt_count < maximum_attempts THEN 'queued'
           ELSE 'failed' END,
         job_id = CASE
           WHEN $5 AND attempt_count < maximum_attempts THEN uuidv7()
           ELSE job_id END,
         attempt_id = CASE
           WHEN $5 AND attempt_count < maximum_attempts THEN NULL
           ELSE attempt_id END,
         failure_code = $4,
         heartbeat_at = clock_timestamp(),
         finished_at = CASE
           WHEN $5 AND attempt_count < maximum_attempts THEN NULL
           ELSE clock_timestamp() END
       WHERE id = $1 AND attempt_id = $2 AND attempt_count = $3
         AND workflow_state = 'running'
       RETURNING job_id,
         workflow_state = 'queued' AS retrying`,
      [claim.workflowId, claim.attemptId, claim.attemptNumber, failure, retryable],
    );
    const row = updated.rows[0];
    if (row === undefined)
      throw new FactoryConceptualReviewWorkflowPersistenceError("stale_attempt");
    if (row.retrying) {
      if (row.job_id === null)
        throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
      const jobId = await boss.send(
        FACTORY_CONCEPTUAL_REVIEW_QUEUE,
        { workflowId: claim.workflowId },
        { db: pgBossDatabase(client), id: row.job_id },
      );
      if (jobId !== row.job_id) throw new Error("Conceptual Review retry was not durably queued");
    }
    await client.query("COMMIT");
    return row.retrying ? "queued" : "failed";
  } catch (error) {
    await rollback(client);
    if (databaseDeadline(error))
      throw new FactoryConceptualReviewWorkflowPersistenceError("timeout");
    throw error;
  } finally {
    client.release();
  }
}

export async function publishFactoryConceptualReview(
  pool: DatabasePool,
  claim: FactoryConceptualReviewAttemptIdentity,
  value: FactoryConceptualReviewDraft,
  signal?: AbortSignal,
  transactionTimeoutMs = 30_000,
): Promise<FactoryConceptualReviewArtifact> {
  assertNotAborted(signal);
  if (!Number.isSafeInteger(transactionTimeoutMs) || transactionTimeoutMs < 1)
    throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
  const databaseTimeout = `${String(transactionTimeoutMs)}ms`;
  const draft = FactoryConceptualReviewDraftSchema.parse(value);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    assertNotAborted(signal);
    await client.query(
      `SELECT set_config('lock_timeout', $1, true),
        set_config('statement_timeout', $1, true)`,
      [databaseTimeout],
    );
    assertNotAborted(signal);
    const selected = await client.query<{ factory_input: unknown }>(
      `SELECT factory_input FROM review_workflows
       WHERE id = $1 AND attempt_id = $2 AND attempt_count = $3
         AND workflow_state = 'running'
       FOR UPDATE`,
      [claim.workflowId, claim.attemptId, claim.attemptNumber],
    );
    assertNotAborted(signal);
    const row = selected.rows[0];
    if (row === undefined)
      throw new FactoryConceptualReviewWorkflowPersistenceError("stale_attempt");
    const preparation = FactoryConceptualReviewPreparationSchema.parse(row.factory_input);
    if (
      preparation.preparationDigest === null ||
      preparation.changeProposalId === null ||
      preparation.publication === null
    )
      throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
    const hasCheckEvidence = draft.evidence.some(({ type }) => type === "check");
    const checksAvailable = preparation.featureId !== null && preparation.evidence !== null;
    if (hasCheckEvidence && !checksAvailable)
      throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
    const generated = await client.query<{ id: string; created_at: Date }>(
      "SELECT uuidv7() AS id, clock_timestamp() AS created_at",
    );
    assertNotAborted(signal);
    const identity = generated.rows[0];
    if (identity === undefined) throw new Error("Artifact identity unavailable");
    const checksLinked = hasCheckEvidence && checksAvailable;
    const artifact = FactoryConceptualReviewArtifactSchema.parse({
      schemaVersion: 1,
      id: identity.id,
      workflowId: claim.workflowId,
      inputDigest: preparation.preparationDigest,
      reviewRevisionId: preparation.publication.revision.id,
      baseCommitId: preparation.publication.revision.base.objectId,
      headCommitId: preparation.publication.revision.head.objectId,
      status: draft.result,
      evidenceScope: {
        source: "exact_retained_revision",
        executedChecks: checksLinked ? "linked_final_certificate" : "not_linked",
        narrativeAuthority: checksLinked
          ? "host_resolved_evidence_model_judgment"
          : "source_only_model_interpretation",
      },
      graph: draft,
      createdAt: identity.created_at.toISOString(),
    });
    await client.query(
      `INSERT INTO factory_conceptual_review_artifacts
        (id, workflow_id, project_id, feature_id, change_proposal_id,
         review_revision_id, input_digest, artifact_status, artifact, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [
        artifact.id,
        artifact.workflowId,
        preparation.projectId,
        preparation.featureId,
        preparation.changeProposalId,
        artifact.reviewRevisionId,
        artifact.inputDigest,
        artifact.status,
        JSON.stringify(artifact),
        identity.created_at,
      ],
    );
    assertNotAborted(signal);
    const attempt = await client.query(
      `UPDATE review_workflow_attempts
       SET attempt_state = 'published', finished_at = clock_timestamp(),
         heartbeat_at = clock_timestamp()
       WHERE workflow_id = $1 AND attempt_id = $2 AND attempt_number = $3
         AND attempt_state = 'running'`,
      [claim.workflowId, claim.attemptId, claim.attemptNumber],
    );
    assertNotAborted(signal);
    const workflow = await client.query(
      `UPDATE review_workflows
       SET workflow_state = 'published', artifact_id = $4, finished_at = clock_timestamp(),
         heartbeat_at = clock_timestamp(), failure_code = NULL
       WHERE id = $1 AND attempt_id = $2 AND attempt_count = $3
         AND workflow_state = 'running'`,
      [claim.workflowId, claim.attemptId, claim.attemptNumber, artifact.id],
    );
    assertNotAborted(signal);
    if (attempt.rowCount !== 1 || workflow.rowCount !== 1)
      throw new FactoryConceptualReviewWorkflowPersistenceError("stale_attempt");
    assertNotAborted(signal);
    await client.query("COMMIT");
    return artifact;
  } catch (error) {
    await client.query("ROLLBACK");
    if (databaseDeadline(error))
      throw new FactoryConceptualReviewWorkflowPersistenceError("timeout");
    throw error;
  } finally {
    client.release();
  }
}

/** Recreates lost queue delivery and fences abandoned attempt owners after restart. */
export async function reconcileFactoryConceptualReviewWorkflows(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  recoverContainer?: FactoryConceptualReviewContainerRecovery,
  disposeWorkspace?: FactoryConceptualReviewWorkspaceDisposal,
  databaseTimeoutMs = 10_000,
): Promise<void> {
  const queued = await boundedQuery<{ id: string }>(
    pool,
    `SELECT workflow.id
     FROM review_workflows AS workflow
     WHERE workflow.factory_input IS NOT NULL AND workflow.workflow_state = 'queued'
       AND NOT EXISTS (
         SELECT 1 FROM pgboss.job AS job
         WHERE job.name = $1 AND job.id = workflow.job_id
           AND job.state NOT IN ('failed', 'cancelled', 'completed')
       )
     ORDER BY workflow.requested_at, workflow.id
     LIMIT 200`,
    [FACTORY_CONCEPTUAL_REVIEW_QUEUE],
    databaseTimeoutMs,
  );
  for (const candidate of queued.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await configureDatabaseDeadline(client, databaseTimeoutMs);
      const selected = await client.query<{ job_id: string }>(
        `UPDATE review_workflows AS workflow
         SET job_id = uuidv7(), heartbeat_at = NULL
         WHERE workflow.id = $1 AND workflow.factory_input IS NOT NULL
           AND workflow.workflow_state = 'queued'
           AND NOT EXISTS (
             SELECT 1 FROM pgboss.job AS job
             WHERE job.name = $2 AND job.id = workflow.job_id
               AND job.state NOT IN ('failed', 'cancelled', 'completed')
           )
         RETURNING workflow.job_id`,
        [candidate.id, FACTORY_CONCEPTUAL_REVIEW_QUEUE],
      );
      const row = selected.rows[0];
      if (row !== undefined) {
        const jobId = await boss.send(
          FACTORY_CONCEPTUAL_REVIEW_QUEUE,
          { workflowId: candidate.id },
          { db: pgBossDatabase(client), id: row.job_id },
        );
        if (jobId !== row.job_id)
          throw new Error("Conceptual Review Workflow was not durably reconciled");
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      if (databaseDeadline(error)) continue;
      throw error;
    } finally {
      client.release();
    }
  }

  type InterruptedReview = {
    id: string;
    attempt_id: string;
    attempt_count: number;
    maximum_attempts: number;
    attempt_failure_code: string | null;
    container_name: string | null;
    container_id: string | null;
    docker_daemon_id: string | null;
    container_image: string | null;
    container_stopped_at: Date | null;
    workspace_disposed_at: Date | null;
  };
  const staleCandidates = await boundedQuery<{ id: string }>(
    pool,
    `SELECT workflow.id
     FROM review_workflows AS workflow
     WHERE workflow.factory_input IS NOT NULL
       AND workflow.workflow_state = 'running'
       AND workflow.heartbeat_at < clock_timestamp() - interval '30 seconds'
     ORDER BY workflow.requested_at, workflow.id
    LIMIT 20`,
    [],
    databaseTimeoutMs,
  );
  const fenced: InterruptedReview[] = [];
  for (const candidate of staleCandidates.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await configureDatabaseDeadline(client, databaseTimeoutMs);
      const selected = await client.query<InterruptedReview>(
        `SELECT workflow.id, workflow.attempt_id, workflow.attempt_count,
           workflow.maximum_attempts, attempt.failure_code AS attempt_failure_code,
           attempt.container_name, attempt.container_id, attempt.docker_daemon_id,
           workflow.factory_input #>> '{configuration,runtimePolicy,containerImage}'
             AS container_image,
           attempt.container_stopped_at, attempt.workspace_disposed_at
         FROM review_workflows AS workflow
         JOIN review_workflow_attempts AS attempt
           ON attempt.workflow_id = workflow.id
          AND attempt.attempt_id = workflow.attempt_id
          AND attempt.attempt_number = workflow.attempt_count
         WHERE workflow.id = $1 AND workflow.factory_input IS NOT NULL
           AND workflow.workflow_state = 'running'
           AND workflow.heartbeat_at < clock_timestamp() - interval '30 seconds'
           AND attempt.attempt_state = 'running'
         FOR UPDATE OF workflow, attempt`,
        [candidate.id],
      );
      const row = selected.rows[0];
      if (row !== undefined) {
        requireCurrentAttempt(
          await client.query(
            `UPDATE review_workflow_attempts
             SET attempt_state = 'failed', failure_code = 'interrupted',
               heartbeat_at = clock_timestamp(), finished_at = clock_timestamp()
             WHERE workflow_id = $1 AND attempt_id = $2 AND attempt_number = $3
               AND attempt_state = 'running'`,
            [row.id, row.attempt_id, row.attempt_count],
          ),
        );
        requireCurrentAttempt(
          await client.query(
            `UPDATE review_workflows
             SET workflow_state = 'failed', failure_code = 'stop_unconfirmed',
               heartbeat_at = clock_timestamp(), finished_at = clock_timestamp()
             WHERE id = $1 AND attempt_id = $2 AND attempt_count = $3
               AND workflow_state = 'running'`,
            [row.id, row.attempt_id, row.attempt_count],
          ),
        );
        fenced.push({ ...row, attempt_failure_code: "interrupted" });
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      if (databaseDeadline(error)) continue;
      throw error;
    } finally {
      client.release();
    }
  }

  const pendingStopCleanup = await boundedQuery<InterruptedReview>(
    pool,
    `SELECT workflow.id, workflow.attempt_id, workflow.attempt_count,
       workflow.maximum_attempts, attempt.failure_code AS attempt_failure_code,
       attempt.container_name, attempt.container_id, attempt.docker_daemon_id,
       workflow.factory_input #>> '{configuration,runtimePolicy,containerImage}'
         AS container_image,
       attempt.container_stopped_at, attempt.workspace_disposed_at
     FROM review_workflows AS workflow
     JOIN review_workflow_attempts AS attempt
       ON attempt.workflow_id = workflow.id
      AND attempt.attempt_id = workflow.attempt_id
      AND attempt.attempt_number = workflow.attempt_count
     WHERE workflow.factory_input IS NOT NULL
       AND workflow.workflow_state = 'failed'
       AND workflow.failure_code = 'stop_unconfirmed'
       AND attempt.heartbeat_at < clock_timestamp() - interval '30 seconds'
     ORDER BY attempt.heartbeat_at, workflow.requested_at, workflow.id
     LIMIT 20`,
    [],
    databaseTimeoutMs,
  );
  const pending = new Map(
    [...fenced, ...pendingStopCleanup.rows].map((row) => [
      `${row.id}:${row.attempt_id}:${String(row.attempt_count)}`,
      row,
    ]),
  );
  for (const row of pending.values()) {
    const claim = {
      workflowId: row.id,
      attemptId: row.attempt_id,
      attemptNumber: row.attempt_count,
    };
    const touchForBackoff = async () => {
      await boundedMutation(
        pool,
        `UPDATE review_workflow_attempts AS attempt
         SET heartbeat_at = clock_timestamp()
         FROM review_workflows AS workflow
         WHERE attempt.workflow_id = $1 AND attempt.attempt_id = $2
           AND attempt.attempt_number = $3
           AND workflow.id = attempt.workflow_id
           AND workflow.attempt_id = attempt.attempt_id
           AND workflow.attempt_count = attempt.attempt_number
           AND workflow.workflow_state = 'failed'
           AND workflow.failure_code = 'stop_unconfirmed'`,
        [claim.workflowId, claim.attemptId, claim.attemptNumber],
        databaseTimeoutMs,
      );
    };
    if (row.container_name !== null && row.container_stopped_at === null) {
      if (recoverContainer === undefined) {
        await touchForBackoff().catch(() => undefined);
        continue;
      }
      try {
        const stopped = await boundedCallback(
          recoverContainer(
            {
              name: row.container_name,
              id: row.container_id,
              daemonId: row.docker_daemon_id,
              image: row.container_image,
            },
            async (id) => {
              requireCurrentAttempt(
                await boundedMutation(
                  pool,
                  `UPDATE review_workflow_attempts AS attempt
                 SET container_id = $5
                 FROM review_workflows AS workflow
                 WHERE attempt.workflow_id = $1 AND attempt.attempt_id = $2
                   AND attempt.attempt_number = $3 AND attempt.container_name = $4
                   AND (attempt.container_id IS NULL OR attempt.container_id = $5)
                   AND attempt.container_stopped_at IS NULL
                   AND workflow.id = attempt.workflow_id
                   AND workflow.attempt_id = attempt.attempt_id
                   AND workflow.attempt_count = attempt.attempt_number
                   AND workflow.workflow_state = 'failed'
                   AND workflow.failure_code = 'stop_unconfirmed'`,
                  [claim.workflowId, claim.attemptId, claim.attemptNumber, row.container_name, id],
                  databaseTimeoutMs,
                ),
              );
            },
            AbortSignal.timeout(databaseTimeoutMs),
          ),
          databaseTimeoutMs,
        );
        requireCurrentAttempt(
          await boundedMutation(
            pool,
            `UPDATE review_workflow_attempts AS attempt
             SET container_id = COALESCE(container_id, $5),
               container_stopped_at = COALESCE(container_stopped_at, clock_timestamp()),
               heartbeat_at = clock_timestamp()
             FROM review_workflows AS workflow
             WHERE attempt.workflow_id = $1 AND attempt.attempt_id = $2
               AND attempt.attempt_number = $3 AND attempt.container_name = $4
               AND (attempt.container_id IS NULL OR attempt.container_id = $5)
               AND workflow.id = attempt.workflow_id
               AND workflow.attempt_id = attempt.attempt_id
               AND workflow.attempt_count = attempt.attempt_number
               AND workflow.workflow_state = 'failed'
               AND workflow.failure_code = 'stop_unconfirmed'`,
            [claim.workflowId, claim.attemptId, claim.attemptNumber, stopped.name, stopped.id],
            databaseTimeoutMs,
          ),
        );
      } catch {
        await touchForBackoff().catch(() => undefined);
        continue;
      }
    }
    if (!(row.workspace_disposed_at instanceof Date)) {
      if (disposeWorkspace === undefined) {
        await touchForBackoff().catch(() => undefined);
        continue;
      }
      try {
        await boundedCallback(disposeWorkspace(claim.attemptId), databaseTimeoutMs);
        requireCurrentAttempt(
          await boundedMutation(
            pool,
            `UPDATE review_workflow_attempts AS attempt
             SET workspace_disposed_at = COALESCE(workspace_disposed_at, clock_timestamp()),
               heartbeat_at = clock_timestamp()
             FROM review_workflows AS workflow
             WHERE attempt.workflow_id = $1 AND attempt.attempt_id = $2
               AND attempt.attempt_number = $3
               AND (attempt.container_name IS NULL OR attempt.container_stopped_at IS NOT NULL)
               AND workflow.id = attempt.workflow_id
               AND workflow.attempt_id = attempt.attempt_id
               AND workflow.attempt_count = attempt.attempt_number
               AND workflow.workflow_state = 'failed'
               AND workflow.failure_code = 'stop_unconfirmed'`,
            [claim.workflowId, claim.attemptId, claim.attemptNumber],
            databaseTimeoutMs,
          ),
        );
      } catch {
        await touchForBackoff().catch(() => undefined);
        continue;
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await configureDatabaseDeadline(client, databaseTimeoutMs);
      const finalized = await client.query<{ job_id: string | null; retrying: boolean }>(
        `UPDATE review_workflows AS workflow
         SET workflow_state = CASE
             WHEN attempt.failure_code = 'interrupted'
               AND workflow.attempt_count < workflow.maximum_attempts THEN 'queued'
             ELSE 'failed' END,
           job_id = CASE
             WHEN attempt.failure_code = 'interrupted'
               AND workflow.attempt_count < workflow.maximum_attempts THEN uuidv7()
             ELSE workflow.job_id END,
           attempt_id = CASE
             WHEN attempt.failure_code = 'interrupted'
               AND workflow.attempt_count < workflow.maximum_attempts THEN NULL
             ELSE workflow.attempt_id END,
           failure_code = 'interrupted',
           heartbeat_at = clock_timestamp(),
           finished_at = CASE
             WHEN attempt.failure_code = 'interrupted'
               AND workflow.attempt_count < workflow.maximum_attempts THEN NULL
             ELSE workflow.finished_at END
         FROM review_workflow_attempts AS attempt
         WHERE workflow.id = $1 AND workflow.attempt_id = $2
           AND workflow.attempt_count = $3
           AND workflow.workflow_state = 'failed'
           AND workflow.failure_code = 'stop_unconfirmed'
           AND attempt.workflow_id = workflow.id
           AND attempt.attempt_id = $2
           AND attempt.attempt_number = $3
           AND attempt.workspace_disposed_at IS NOT NULL
           AND (attempt.container_name IS NULL OR attempt.container_stopped_at IS NOT NULL)
         RETURNING workflow.job_id,
           workflow.workflow_state = 'queued' AS retrying`,
        [claim.workflowId, claim.attemptId, claim.attemptNumber],
      );
      const result = finalized.rows[0];
      if (result !== undefined && result.retrying) {
        if (result.job_id === null)
          throw new FactoryConceptualReviewWorkflowPersistenceError("invalid_state");
        const jobId = await boss.send(
          FACTORY_CONCEPTUAL_REVIEW_QUEUE,
          { workflowId: claim.workflowId },
          { db: pgBossDatabase(client), id: result.job_id },
        );
        if (jobId !== result.job_id)
          throw new Error("Conceptual Review retry was not durably queued");
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      if (databaseDeadline(error)) continue;
      throw error;
    } finally {
      client.release();
    }
  }
}
