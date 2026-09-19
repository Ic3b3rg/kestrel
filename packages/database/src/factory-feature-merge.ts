import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import {
  ApproveFactoryFeatureMergeCommandSchema,
  FactoryConceptualReviewArtifactSchema,
  FactoryFeatureMergeCurrentSchema,
  FactoryFeatureMergeFailureSchema,
  FactoryFeatureMergeSchema,
  FactoryFeaturePublicationIdentitySchema,
  FactoryFeaturePublicationOperationSchema,
  FactoryFeaturePullRequestSchema,
  RetryFactoryFeatureMergeCommandSchema,
  type ApproveFactoryFeatureMergeCommand,
  type FactoryFeatureMerge,
  type FactoryFeatureMergeFailure,
  type FactoryFeaturePublicationOperation,
  type FactoryFeaturePublicationIssue,
  type FactoryFeaturePullRequest,
} from "@kestrel/contracts";

import type { DiagnosticJobSender } from "./diagnostics.js";
import { FactoryError, withFactoryFeature } from "./factory-planning.js";
import { FACTORY_MERGE_QUEUE, pgBossDatabase } from "./pg-boss.js";
import type { DatabasePool } from "./pool.js";

interface MergeRow {
  feature_id: string;
  id: string;
  project_id: string;
  plan_version: number;
  requested_by_operator_id: string;
  request_id: string;
  source_workflow_id: string;
  source_artifact_id: string;
  source_review_revision_id: string;
  source_input_digest: string;
  base_commit_id: string;
  head_commit_id: string;
  certificate_id: string;
  publication_operation_id: string;
  identity: unknown;
  pull_request: unknown;
  state: FactoryFeatureMerge["state"];
  failure: FactoryFeatureMergeFailure | null;
  job_id: string;
  attempt_id: string | null;
  attempts: number;
  merge_attempted: boolean;
  merge_commit_id: string | null;
  provider_merged_at: Date | null;
  retry_after: Date | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface MergeIssueRow {
  merge_id: string;
  work_item_id: string;
  feature_id: string;
  key: string;
  issue: unknown;
  state: FactoryFeatureMerge["issues"][number]["state"];
  failure: FactoryFeatureMerge["issues"][number]["failure"];
  attempts: number;
  closed_at: Date | null;
  updated_at: Date;
}

export class FactoryFeatureMergeError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "not_ready"
      | "review_outdated"
      | "review_partial"
      | "active_correction"
      | "invalid_state"
      | "retry_limit",
  ) {
    super(`Factory Feature merge failed: ${code}`);
    this.name = "FactoryFeatureMergeError";
  }
}

export interface FactoryFeatureMergeClaimIdentity {
  featureId: string;
  projectId: string;
  attemptId: string;
}

export interface ClaimedFactoryFeatureMerge extends FactoryFeatureMergeClaimIdentity {
  id: string;
  approvedVersion: number;
  identity: FactoryFeaturePublicationOperation["target"]["identity"];
  pullRequest: FactoryFeaturePullRequest;
  sourceReview: FactoryFeatureMerge["sourceReview"];
  certificateId: string;
  mergeAttempted: boolean;
  provider: FactoryFeatureMerge["provider"];
  issues: FactoryFeaturePublicationIssue[];
}

export interface ClaimedFactoryFeatureMergeIssue {
  mergeId: string;
  workItemId: string;
  key: string;
  issue: FactoryFeaturePublicationIssue["issue"];
}

async function mergeRow(client: PoolClient, featureId: string, lock = false) {
  return (
    await client.query<MergeRow>(
      `SELECT * FROM factory_feature_merges WHERE feature_id = $1${lock ? " FOR UPDATE" : ""}`,
      [featureId],
    )
  ).rows[0];
}

async function issueRows(client: PoolClient, mergeId: string) {
  return (
    await client.query<MergeIssueRow>(
      "SELECT * FROM factory_feature_merge_issues WHERE merge_id = $1 ORDER BY key, work_item_id",
      [mergeId],
    )
  ).rows;
}

function mapIssue(row: MergeIssueRow): FactoryFeatureMerge["issues"][number] {
  const issue = FactoryFeaturePublicationOperationSchema.shape.issues.element.shape.issue.parse(
    row.issue,
  );
  return {
    workItemId: row.work_item_id,
    key: row.key,
    number: issue.number,
    url: issue.url,
    state: row.state,
    failure: row.failure,
    attempts: row.attempts,
    closedAt: row.closed_at?.toISOString() ?? null,
  };
}

async function mapMerge(client: PoolClient, row: MergeRow): Promise<FactoryFeatureMerge> {
  const merged = row.merge_commit_id !== null && row.provider_merged_at !== null;
  const pullRequest = FactoryFeaturePullRequestSchema.parse(row.pull_request);
  return FactoryFeatureMergeSchema.parse({
    schemaVersion: 1,
    id: row.id,
    featureId: row.feature_id,
    approvedVersion: row.plan_version,
    requestedByOperatorId: row.requested_by_operator_id,
    sourceReview: {
      workflowId: row.source_workflow_id,
      artifactId: row.source_artifact_id,
      reviewRevisionId: row.source_review_revision_id,
      baseCommitId: row.base_commit_id,
      headCommitId: row.head_commit_id,
    },
    pullRequest: { ...pullRequest, state: merged ? "closed" : pullRequest.state },
    certificateId: row.certificate_id,
    state: row.state,
    failure: row.failure,
    canRetry:
      row.failure !== "retry_limit" &&
      (["blocked", "uncertain"].includes(row.state) ||
        (row.state === "closing_issues" && row.failure === "issue_closure_failed")) &&
      (row.retry_after === null || row.retry_after.getTime() <= Date.now()),
    provider: {
      merged,
      mergeCommitId: row.merge_commit_id,
      mergedAt: row.provider_merged_at?.toISOString() ?? null,
    },
    issues: (await issueRows(client, row.id)).map(mapIssue),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  });
}

export function readCurrentFactoryFeatureMerge(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
) {
  return withFactoryFeature(pool, projectId, featureId, async (client) => {
    const row = await mergeRow(client, featureId);
    return FactoryFeatureMergeCurrentSchema.parse({
      schemaVersion: 1,
      merge: row === undefined ? null : await mapMerge(client, row),
    });
  });
}

interface ReviewRow {
  workflow_id: string;
  workflow_state: string;
  artifact_id: string | null;
  review_revision_id: string;
  input_digest: string;
  observed_head_commit_id: string | null;
  artifact_status: string | null;
  artifact: unknown;
  container_stopped_at: Date | null;
  workspace_disposed_at: Date | null;
}

async function currentReview(client: PoolClient, featureId: string) {
  return (
    await client.query<ReviewRow>(
      `SELECT workflow.id AS workflow_id, workflow.workflow_state, workflow.artifact_id,
        workflow.review_revision_id, workflow.input_digest, workflow.observed_head_commit_id,
        artifact.artifact_status, artifact.artifact,
        attempt.container_stopped_at, attempt.workspace_disposed_at
       FROM review_workflows workflow
       LEFT JOIN factory_conceptual_review_artifacts artifact
         ON artifact.id = workflow.artifact_id AND artifact.workflow_id = workflow.id
       LEFT JOIN LATERAL (
         SELECT container_stopped_at, workspace_disposed_at FROM review_workflow_attempts
         WHERE workflow_id = workflow.id ORDER BY attempt_number DESC LIMIT 1
       ) attempt ON true
       WHERE workflow.feature_id = $1
       ORDER BY workflow.requested_at DESC, workflow.id DESC LIMIT 1`,
      [featureId],
    )
  ).rows[0];
}

interface PublicationRow {
  plan_version: number;
  certificate_id: string;
  operation_id: string;
  target: unknown;
  issues: unknown;
  payload: unknown;
  pull_request: unknown;
}

async function publication(client: PoolClient, featureId: string) {
  return (
    await client.query<PublicationRow>(
      `SELECT publication.plan_version, publication.certificate_id, operation.id AS operation_id,
        operation.target, operation.issues, operation.payload, result.pull_request
       FROM factory_feature_pr_publications publication
       JOIN factory_feature_pr_operations operation ON operation.feature_id = publication.feature_id
       JOIN factory_feature_pr_results result ON result.feature_id = publication.feature_id
       WHERE publication.feature_id = $1 AND publication.state = 'published'`,
      [featureId],
    )
  ).rows[0];
}

async function replayOrConflict(
  client: PoolClient,
  featureId: string,
  actorId: string,
  command: ApproveFactoryFeatureMergeCommand,
) {
  const row = await mergeRow(client, featureId);
  if (row === undefined) return null;
  if (
    row.request_id !== command.requestId ||
    row.requested_by_operator_id !== actorId ||
    row.plan_version !== command.expectedPlanVersion ||
    row.source_workflow_id !== command.review.workflowId ||
    row.source_artifact_id !== command.review.artifactId ||
    row.head_commit_id !== command.review.headCommitId
  )
    throw new FactoryError("conflict", "This Feature already has a different merge approval");
  return mapMerge(client, row);
}

export function replayFactoryFeatureMergeRequest(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  actorId: string,
  input: ApproveFactoryFeatureMergeCommand,
) {
  const command = ApproveFactoryFeatureMergeCommandSchema.parse(input);
  return withFactoryFeature(pool, projectId, featureId, (client) =>
    replayOrConflict(client, featureId, actorId, command),
  );
}

export function approveFactoryFeatureMerge(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  projectId: string,
  featureId: string,
  actorId: string,
  input: ApproveFactoryFeatureMergeCommand,
) {
  const command = ApproveFactoryFeatureMergeCommandSchema.parse(input);
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    const replay = await replayOrConflict(client, featureId, actorId, command);
    if (replay !== null) return replay;
    if (
      feature.state !== "in_review" ||
      feature.approved_plan_version !== command.expectedPlanVersion
    )
      throw new FactoryFeatureMergeError("not_ready");

    const activeCorrection = await client.query(
      `SELECT id FROM factory_review_corrections WHERE feature_id = $1
       AND state IN ('executing','gated','publishing','blocked','uncertain','reviewing')`,
      [featureId],
    );
    if (activeCorrection.rowCount !== 0) throw new FactoryFeatureMergeError("active_correction");

    const review = await currentReview(client, featureId);
    const published = await publication(client, featureId);
    if (
      review === undefined ||
      review.workflow_state !== "published" ||
      review.artifact_id === null ||
      review.workflow_id !== command.review.workflowId ||
      review.artifact_id !== command.review.artifactId ||
      published === undefined ||
      published.plan_version !== command.expectedPlanVersion
    )
      throw new FactoryFeatureMergeError("review_outdated");
    const artifact = FactoryConceptualReviewArtifactSchema.parse(review.artifact);
    if (artifact.status !== "complete" || review.artifact_status !== "complete")
      throw new FactoryFeatureMergeError("review_partial");
    if (
      artifact.id !== command.review.artifactId ||
      artifact.workflowId !== command.review.workflowId ||
      artifact.reviewRevisionId !== review.review_revision_id ||
      artifact.inputDigest !== review.input_digest ||
      artifact.headCommitId !== command.review.headCommitId ||
      review.observed_head_commit_id !== artifact.headCommitId ||
      review.container_stopped_at === null ||
      review.workspace_disposed_at === null
    )
      throw new FactoryFeatureMergeError("review_outdated");

    const operation = FactoryFeaturePublicationOperationSchema.parse({
      id: published.operation_id,
      featureId,
      target: published.target,
      issues: published.issues,
      payload: published.payload,
    });
    const pullRequest = FactoryFeaturePullRequestSchema.parse(published.pull_request);
    if (
      published.certificate_id !== operation.target.certificateId ||
      operation.target.approvedVersion !== command.expectedPlanVersion ||
      operation.target.revision.baseCommitId !== artifact.baseCommitId ||
      operation.target.revision.headCommitId !== artifact.headCommitId ||
      pullRequest.baseCommitId !== artifact.baseCommitId ||
      pullRequest.headCommitId !== artifact.headCommitId ||
      pullRequest.state !== "open"
    )
      throw new FactoryFeatureMergeError("review_outdated");

    const running = await client.query(
      `SELECT id FROM factory_execution_runs WHERE feature_id = $1 AND reservation_released_at IS NULL
       UNION ALL SELECT id FROM review_workflows WHERE feature_id = $1 AND workflow_state IN ('queued','running')
       UNION ALL SELECT container.run_id AS id FROM factory_execution_containers container
         JOIN factory_execution_runs run ON run.id = container.run_id
         WHERE run.feature_id = $1 AND container.stopped_at IS NULL`,
      [featureId],
    );
    if (running.rowCount !== 0) throw new FactoryFeatureMergeError("not_ready");

    const inserted = (
      await client.query<{ id: string; job_id: string }>(
        `INSERT INTO factory_feature_merges (
          feature_id,project_id,plan_version,requested_by_operator_id,request_id,
          source_workflow_id,source_artifact_id,source_review_revision_id,source_input_digest,
          base_commit_id,head_commit_id,certificate_id,publication_operation_id,identity,pull_request)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)
         RETURNING id,job_id`,
        [
          featureId,
          feature.project_id,
          command.expectedPlanVersion,
          actorId,
          command.requestId,
          review.workflow_id,
          review.artifact_id,
          review.review_revision_id,
          review.input_digest,
          artifact.baseCommitId,
          artifact.headCommitId,
          published.certificate_id,
          operation.id,
          JSON.stringify(operation.target.identity),
          JSON.stringify(pullRequest),
        ],
      )
    ).rows[0];
    if (inserted === undefined) throw new Error("Merge approval was not persisted");
    for (const linked of operation.issues)
      await client.query(
        `INSERT INTO factory_feature_merge_issues (merge_id,work_item_id,feature_id,key,issue)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [inserted.id, linked.workItemId, featureId, linked.key, JSON.stringify(linked.issue)],
      );
    await client.query(
      "UPDATE factory_features SET state = 'merging', updated_at = clock_timestamp() WHERE id = $1",
      [featureId],
    );
    await client.query(
      "INSERT INTO factory_activity (feature_id,kind,summary) VALUES ($1,'merge_approved',$2)",
      [featureId, `The Operator approved exact reviewed head ${artifact.headCommitId}`],
    );
    const jobId = await boss.send(
      FACTORY_MERGE_QUEUE,
      { featureId },
      { db: pgBossDatabase(client), id: inserted.job_id },
    );
    if (jobId !== inserted.job_id) throw new Error("Merge was not durably queued");
    const row = await mergeRow(client, featureId);
    if (row === undefined) throw new Error("Merge approval disappeared");
    return mapMerge(client, row);
  });
}

export async function claimFactoryFeatureMerge(
  pool: DatabasePool,
  featureId: string,
): Promise<ClaimedFactoryFeatureMerge | null> {
  const owner = (
    await pool.query<{ project_id: string }>(
      "SELECT project_id FROM factory_features WHERE id = $1",
      [featureId],
    )
  ).rows[0];
  if (owner === undefined) return null;
  return withFactoryFeature(pool, owner.project_id, featureId, async (client, feature) => {
    if (!["merging", "completed"].includes(feature.state)) return null;
    const attemptId = randomUUID();
    const row = (
      await client.query<MergeRow>(
        `UPDATE factory_feature_merges SET state = 'checking', failure = NULL,
          attempt_id = $2, attempts = attempts + 1, updated_at = clock_timestamp()
         WHERE feature_id = $1 AND state = 'queued' AND attempts < 20
           AND (retry_after IS NULL OR retry_after <= clock_timestamp()) RETURNING *`,
        [featureId, attemptId],
      )
    ).rows[0];
    if (row === undefined) return null;
    const identity = FactoryFeaturePublicationIdentitySchema.parse(row.identity);
    const pullRequest = FactoryFeaturePullRequestSchema.parse(row.pull_request);
    const issues = (await issueRows(client, row.id)).map((item) => ({
      workItemId: item.work_item_id,
      key: item.key,
      title: item.key,
      issue: FactoryFeaturePublicationOperationSchema.shape.issues.element.shape.issue.parse(
        item.issue,
      ),
    }));
    return {
      id: row.id,
      featureId,
      projectId: feature.project_id,
      attemptId,
      approvedVersion: row.plan_version,
      identity,
      pullRequest,
      sourceReview: {
        workflowId: row.source_workflow_id,
        artifactId: row.source_artifact_id,
        reviewRevisionId: row.source_review_revision_id,
        baseCommitId: row.base_commit_id,
        headCommitId: row.head_commit_id,
      },
      certificateId: row.certificate_id,
      mergeAttempted: row.merge_attempted,
      provider: {
        merged: row.merge_commit_id !== null,
        mergeCommitId: row.merge_commit_id,
        mergedAt: row.provider_merged_at?.toISOString() ?? null,
      },
      issues,
    };
  });
}

async function claimedRow(
  client: PoolClient,
  claim: FactoryFeatureMergeClaimIdentity,
): Promise<MergeRow> {
  const row = await mergeRow(client, claim.featureId, true);
  if (row === undefined || row.attempt_id !== claim.attemptId)
    throw new FactoryError("conflict", "The merge attempt is no longer current");
  return row;
}

export function markFactoryFeatureMergeWrite(
  pool: DatabasePool,
  claim: FactoryFeatureMergeClaimIdentity,
) {
  return withFactoryFeature(pool, claim.projectId, claim.featureId, async (client, feature) => {
    const row = await claimedRow(client, claim);
    if (
      feature.state !== "merging" ||
      row.state !== "checking" ||
      row.merge_attempted ||
      row.merge_commit_id !== null
    )
      throw new FactoryError("conflict", "This exact merge write is not authorized");
    await client.query(
      `UPDATE factory_feature_merges SET state = 'merging', merge_attempted = true,
       updated_at = clock_timestamp() WHERE feature_id = $1 AND attempt_id = $2`,
      [claim.featureId, claim.attemptId],
    );
  });
}

export function completeFactoryFeatureMerge(
  pool: DatabasePool,
  claim: FactoryFeatureMergeClaimIdentity,
  proof: { mergeCommitId: string; mergedAt: string },
) {
  return withFactoryFeature(pool, claim.projectId, claim.featureId, async (client, feature) => {
    const row = await claimedRow(client, claim);
    if (
      feature.state !== "merging" ||
      !["merging", "checking"].includes(row.state) ||
      !row.merge_attempted ||
      row.merge_commit_id !== null
    )
      throw new FactoryError("conflict", "Provider merge proof is not authorized");
    await client.query(
      `UPDATE factory_feature_merges SET state = 'closing_issues', failure = NULL,
       merge_commit_id = $3, provider_merged_at = $4::timestamptz, updated_at = clock_timestamp()
       WHERE feature_id = $1 AND attempt_id = $2`,
      [claim.featureId, claim.attemptId, proof.mergeCommitId, proof.mergedAt],
    );
    await client.query(
      "UPDATE factory_work_items SET board_column = 'completed' WHERE feature_id = $1 AND plan_version = $2",
      [claim.featureId, row.plan_version],
    );
    await client.query(
      "UPDATE factory_features SET state = 'completed', updated_at = clock_timestamp() WHERE id = $1",
      [claim.featureId],
    );
    await client.query(
      "INSERT INTO factory_activity (feature_id,kind,summary) VALUES ($1,'merge_confirmed',$2)",
      [claim.featureId, `GitHub confirmed merge commit ${proof.mergeCommitId}`],
    );
  });
}

export function failFactoryFeatureMerge(
  pool: DatabasePool,
  claim: FactoryFeatureMergeClaimIdentity,
  failure: FactoryFeatureMergeFailure,
  uncertain = false,
) {
  const parsed = FactoryFeatureMergeFailureSchema.parse(failure);
  return withFactoryFeature(pool, claim.projectId, claim.featureId, async (client) => {
    const row = await claimedRow(client, claim);
    if (row.merge_commit_id !== null) throw new FactoryError("conflict");
    await client.query(
      `UPDATE factory_feature_merges SET state = $3, failure = $4,
       retry_after = CASE WHEN $4 = 'rate_limited' THEN clock_timestamp() + interval '1 minute' ELSE NULL END,
       updated_at = clock_timestamp() WHERE feature_id = $1 AND attempt_id = $2`,
      [claim.featureId, claim.attemptId, uncertain ? "uncertain" : "blocked", parsed],
    );
    await client.query(
      "INSERT INTO factory_activity (feature_id,kind,summary) VALUES ($1,'merge_blocked',$2)",
      [claim.featureId, `Merge stopped: ${parsed}`],
    );
  });
}

export function claimNextFactoryFeatureMergeIssue(
  pool: DatabasePool,
  claim: FactoryFeatureMergeClaimIdentity,
) {
  return withFactoryFeature(pool, claim.projectId, claim.featureId, async (client) => {
    const merge = await claimedRow(client, claim);
    if (merge.merge_commit_id === null || merge.provider_merged_at === null)
      throw new FactoryError("conflict");
    const row = (
      await client.query<MergeIssueRow>(
        `UPDATE factory_feature_merge_issues issue SET state = 'closing', failure = NULL,
          attempts = attempts + 1, updated_at = clock_timestamp()
         WHERE (issue.merge_id, issue.work_item_id) = (
           SELECT merge_id, work_item_id FROM factory_feature_merge_issues
           WHERE merge_id = $1 AND state = 'pending' AND attempts < 20
           ORDER BY key, work_item_id LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING *`,
        [merge.id],
      )
    ).rows[0];
    if (row === undefined) return null;
    return {
      mergeId: row.merge_id,
      workItemId: row.work_item_id,
      key: row.key,
      issue: FactoryFeaturePublicationOperationSchema.shape.issues.element.shape.issue.parse(
        row.issue,
      ),
    } satisfies ClaimedFactoryFeatureMergeIssue;
  });
}

export function completeFactoryFeatureMergeIssue(
  pool: DatabasePool,
  claim: FactoryFeatureMergeClaimIdentity,
  issue: ClaimedFactoryFeatureMergeIssue,
  closedAt: string,
) {
  return withFactoryFeature(pool, claim.projectId, claim.featureId, async (client) => {
    const merge = await claimedRow(client, claim);
    if (merge.id !== issue.mergeId || merge.merge_commit_id === null)
      throw new FactoryError("conflict");
    const result = await client.query(
      `UPDATE factory_feature_merge_issues SET state = 'closed', failure = NULL,
       closed_at = $4::timestamptz, updated_at = clock_timestamp()
       WHERE merge_id = $1 AND work_item_id = $2 AND feature_id = $3 AND state = 'closing'`,
      [issue.mergeId, issue.workItemId, claim.featureId, closedAt],
    );
    if (result.rowCount !== 1) throw new FactoryError("conflict");
    await client.query(
      "INSERT INTO factory_activity (feature_id,work_item_id,kind,summary) VALUES ($1,$2,'issue_closed',$3)",
      [claim.featureId, issue.workItemId, `Closed linked GitHub issue for ${issue.key}`],
    );
  });
}

export function failFactoryFeatureMergeIssue(
  pool: DatabasePool,
  claim: FactoryFeatureMergeClaimIdentity,
  issue: ClaimedFactoryFeatureMergeIssue,
  failure: FactoryFeatureMerge["issues"][number]["failure"],
) {
  if (failure === null) throw new FactoryError("conflict");
  return withFactoryFeature(pool, claim.projectId, claim.featureId, async (client) => {
    const merge = await claimedRow(client, claim);
    if (merge.id !== issue.mergeId || merge.merge_commit_id === null)
      throw new FactoryError("conflict");
    await client.query(
      `UPDATE factory_feature_merge_issues SET state = 'failed', failure = $3,
       updated_at = clock_timestamp() WHERE merge_id = $1 AND work_item_id = $2 AND state = 'closing'`,
      [issue.mergeId, issue.workItemId, failure],
    );
  });
}

export function finishFactoryFeatureMerge(
  pool: DatabasePool,
  claim: FactoryFeatureMergeClaimIdentity,
) {
  return withFactoryFeature(pool, claim.projectId, claim.featureId, async (client) => {
    const merge = await claimedRow(client, claim);
    if (merge.merge_commit_id === null) throw new FactoryError("conflict");
    const remaining = await client.query<{ state: string }>(
      "SELECT state FROM factory_feature_merge_issues WHERE merge_id = $1 AND state <> 'closed'",
      [merge.id],
    );
    if (remaining.rowCount === 0) {
      await client.query(
        `UPDATE factory_feature_merges SET state = 'completed', failure = NULL,
         completed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE feature_id = $1 AND attempt_id = $2`,
        [claim.featureId, claim.attemptId],
      );
      await client.query(
        "INSERT INTO factory_activity (feature_id,kind,summary) VALUES ($1,'merge_completed',$2)",
        [claim.featureId, "The Feature was merged and every linked GitHub issue was closed"],
      );
      return;
    }
    await client.query(
      `UPDATE factory_feature_merges SET state = 'closing_issues', failure = 'issue_closure_failed',
       updated_at = clock_timestamp() WHERE feature_id = $1 AND attempt_id = $2`,
      [claim.featureId, claim.attemptId],
    );
  });
}

export function retryFactoryFeatureMerge(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  projectId: string,
  featureId: string,
  actorId: string,
  input: unknown,
) {
  const command = RetryFactoryFeatureMergeCommandSchema.parse(input);
  return withFactoryFeature(pool, projectId, featureId, async (client) => {
    const row = await mergeRow(client, featureId, true);
    if (row === undefined) throw new FactoryFeatureMergeError("not_found");
    const duplicate = (
      await client.query<{ actor_id: string }>(
        "SELECT actor_id FROM factory_feature_merge_retry_requests WHERE merge_id = $1 AND request_id = $2",
        [row.id, command.requestId],
      )
    ).rows[0];
    if (duplicate !== undefined) {
      if (duplicate.actor_id !== actorId) throw new FactoryError("conflict");
      return mapMerge(client, row);
    }
    const current = await mapMerge(client, row);
    if (!current.canRetry) throw new FactoryFeatureMergeError("invalid_state");
    if (row.attempts >= 20) {
      await client.query(
        `UPDATE factory_feature_merges SET state = 'blocked', failure = 'retry_limit',
         updated_at = clock_timestamp() WHERE id = $1`,
        [row.id],
      );
      const limited = await mergeRow(client, featureId);
      if (limited === undefined) throw new Error("Merge disappeared");
      return mapMerge(client, limited);
    }
    await client.query(
      "INSERT INTO factory_feature_merge_retry_requests (merge_id,request_id,actor_id) VALUES ($1,$2,$3)",
      [row.id, command.requestId, actorId],
    );
    const jobId = randomUUID();
    await client.query(
      `UPDATE factory_feature_merges SET state = 'queued', failure = NULL, job_id = $2,
       attempt_id = NULL, retry_after = NULL, updated_at = clock_timestamp() WHERE id = $1`,
      [row.id, jobId],
    );
    await client.query(
      "UPDATE factory_feature_merge_issues SET state = 'pending', failure = NULL WHERE merge_id = $1 AND state = 'failed'",
      [row.id],
    );
    const sent = await boss.send(
      FACTORY_MERGE_QUEUE,
      { featureId },
      { db: pgBossDatabase(client), id: jobId },
    );
    if (sent !== jobId) throw new Error("Merge retry was not durably queued");
    const updated = await mergeRow(client, featureId);
    if (updated === undefined) throw new Error("Merge disappeared");
    return mapMerge(client, updated);
  });
}

/** Durable approvals and attempted writes are always observed again after restart. */
export async function reconcileFactoryFeatureMerges(pool: DatabasePool, boss: DiagnosticJobSender) {
  const candidates = await pool.query<{ feature_id: string; project_id: string }>(
    `SELECT feature_id, project_id FROM factory_feature_merges
     WHERE state = 'queued'
       OR (state IN ('checking','merging')
         AND updated_at < clock_timestamp() - interval '190 seconds')
       OR (state = 'closing_issues' AND failure IS NULL
         AND updated_at < clock_timestamp() - interval '190 seconds')
     ORDER BY updated_at, id LIMIT 200`,
  );
  for (const candidate of candidates.rows)
    await withFactoryFeature(pool, candidate.project_id, candidate.feature_id, async (client) => {
      let row = await mergeRow(client, candidate.feature_id, true);
      if (row === undefined) return;
      if (["checking", "merging"].includes(row.state)) {
        const recovered = await client.query(
          `UPDATE factory_feature_merges SET state = 'queued', failure = NULL,
             attempt_id = NULL, job_id = $2, updated_at = clock_timestamp()
             WHERE feature_id = $1 AND state IN ('checking','merging')
               AND updated_at < clock_timestamp() - interval '190 seconds'`,
          [row.feature_id, randomUUID()],
        );
        if (recovered.rowCount !== 1) return;
        await client.query(
          "UPDATE factory_feature_merge_issues SET state = 'pending', failure = NULL WHERE merge_id = $1 AND state = 'closing'",
          [row.id],
        );
        row = await mergeRow(client, row.feature_id, true);
      } else if (row.state === "closing_issues") {
        const jobId = randomUUID();
        const recovered = await client.query(
          `UPDATE factory_feature_merges SET state = 'queued', job_id = $2,
             attempt_id = NULL, updated_at = clock_timestamp()
             WHERE feature_id = $1 AND state = 'closing_issues' AND failure IS NULL
               AND updated_at < clock_timestamp() - interval '190 seconds'`,
          [row.feature_id, jobId],
        );
        if (recovered.rowCount !== 1) return;
        await client.query(
          "UPDATE factory_feature_merge_issues SET state = 'pending', failure = NULL WHERE merge_id = $1 AND state = 'closing'",
          [row.id],
        );
        row = await mergeRow(client, row.feature_id, true);
      }
      if (row?.state !== "queued") return;
      if (row.attempts >= 20) {
        await client.query(
          `UPDATE factory_feature_merges SET state = 'blocked', failure = 'retry_limit',
           attempt_id = NULL, updated_at = clock_timestamp() WHERE id = $1 AND state = 'queued'`,
          [row.id],
        );
        await client.query(
          `UPDATE factory_feature_merge_issues SET state = 'failed', failure = 'timeout',
           updated_at = clock_timestamp() WHERE merge_id = $1 AND state = 'closing'`,
          [row.id],
        );
        return;
      }
      const active = await client.query(
        "SELECT id FROM pgboss.job WHERE name = $1 AND id = $2 AND state NOT IN ('failed','cancelled','completed')",
        [FACTORY_MERGE_QUEUE, row.job_id],
      );
      if (active.rowCount !== 0) return;
      const sent = await boss.send(
        FACTORY_MERGE_QUEUE,
        { featureId: row.feature_id },
        { db: pgBossDatabase(client), id: row.job_id },
      );
      if (sent !== row.job_id) throw new Error("Merge recovery was not durably queued");
    });
}
