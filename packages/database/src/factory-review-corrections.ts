import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";

import {
  FactoryConceptualReviewArtifactSchema,
  FactoryFeaturePublicationOperationSchema,
  FactoryFeaturePublicationReviewSchema,
  FactoryFeaturePullRequestSchema,
  FactoryFeatureVerificationSchema,
  FactoryReviewCorrectionCommandSchema,
  FactoryReviewCorrectionCurrentSchema,
  FactoryReviewCorrectionFailureSchema,
  FactoryReviewCorrectionSchema,
  FactoryVerificationManifestSchema,
  FeaturePlanDocumentSchema,
  factoryVerificationManifest,
  type FactoryFeaturePublicationOperation,
  type FactoryFeaturePublicationIssue,
  type FactoryFeaturePublicationReview,
  type FactoryFeaturePullRequest,
  type FactoryFeatureVerification,
  type FactoryConceptualReviewWorkflowRead,
  type FactoryReviewCorrection,
  type FactoryReviewCorrectionCommand,
  type FactoryReviewCorrectionFailure,
  type FeaturePlanDocument,
} from "@kestrel/contracts";

import type { DiagnosticJobSender } from "./diagnostics.js";
import { FACTORY_CORRECTION_QUEUE, FACTORY_EXECUTION_QUEUE, pgBossDatabase } from "./pg-boss.js";
import { FactoryError, withFactoryFeature, type FeatureRow } from "./factory-planning.js";
import type { DatabasePool } from "./pool.js";
import type { FactoryFeatureWorkspace } from "./factory-execution.js";

interface CorrectionRow {
  id: string;
  feature_id: string;
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
  tree_id: string;
  instruction: string;
  finding_ids: string[];
  findings: unknown;
  publication_input: unknown;
  review_request_id: string;
  state: FactoryReviewCorrection["state"];
  failure: FactoryReviewCorrectionFailure | null;
  current_run_id: string;
  certificate_id: string | null;
  job_id: string | null;
  attempt_id: string | null;
  push_attempted: boolean;
  push_confirmed_at: Date | null;
  replacement_pull_request: unknown;
  replacement_project_id: string | null;
  replacement_change_proposal_id: string | null;
  replacement_review_revision_id: string | null;
  replacement_manifest_digest: string | null;
  replacement_review_workflow_id: string | null;
  replacement_artifact_id: string | null;
  retry_after: Date | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const FindingSelectionSchema = FactoryReviewCorrectionSchema.shape.findings;
const PublicationInputSchema = z.strictObject({
  operation: FactoryFeaturePublicationOperationSchema,
  pullRequest: FactoryFeaturePullRequestSchema,
});

export class FactoryReviewCorrectionError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "not_ready"
      | "review_outdated"
      | "finding_not_found"
      | "active_correction"
      | "retry_limit"
      | "invalid_state",
  ) {
    super(`Factory review correction failed: ${code}`);
    this.name = "FactoryReviewCorrectionError";
  }
}

function mapCorrection(row: CorrectionRow): FactoryReviewCorrection {
  return FactoryReviewCorrectionSchema.parse({
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
    instruction: row.instruction,
    findings: row.findings,
    state: row.state,
    failure: row.failure,
    canRetry:
      ["blocked", "uncertain"].includes(row.state) &&
      row.failure !== "retry_limit" &&
      (row.retry_after === null || row.retry_after.getTime() <= Date.now()),
    runId: row.current_run_id,
    certificateId: row.certificate_id,
    replacementReview:
      row.replacement_review_workflow_id === null
        ? null
        : {
            workflowId: row.replacement_review_workflow_id,
            artifactId: row.replacement_artifact_id,
            headCommitId: FactoryFeaturePullRequestSchema.parse(row.replacement_pull_request)
              .headCommitId,
          },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  });
}

async function currentRow(client: PoolClient, featureId: string): Promise<CorrectionRow | null> {
  const result = await client.query<CorrectionRow>(
    "SELECT * FROM factory_review_corrections WHERE feature_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
    [featureId],
  );
  return result.rows[0] ?? null;
}

export function readCurrentFactoryReviewCorrection(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
) {
  return withFactoryFeature(pool, projectId, featureId, async (client) => {
    const correction = await currentRow(client, featureId);
    return FactoryReviewCorrectionCurrentSchema.parse({
      schemaVersion: 1,
      correction: correction === null ? null : mapCorrection(correction),
    });
  });
}

interface CurrentReviewInputs {
  workflow_id: string;
  workflow_state: string;
  artifact_id: string | null;
  review_revision_id: string;
  input_digest: string;
  observed_head_commit_id: string | null;
  artifact: unknown;
}

interface WorkspaceRow {
  repository_id: string;
  source_identity: string;
  base_commit_id: string;
  head_commit_id: string;
  tree_id: string;
  branch: string;
  object_format: "sha1" | "sha256";
}

async function selectCurrentReview(client: PoolClient, featureId: string) {
  return (
    await client.query<CurrentReviewInputs>(
      `SELECT workflow.id AS workflow_id, workflow.workflow_state, workflow.artifact_id,
        workflow.review_revision_id, workflow.input_digest, workflow.observed_head_commit_id,
        artifact.artifact
       FROM review_workflows AS workflow
       LEFT JOIN factory_conceptual_review_artifacts AS artifact
         ON artifact.id = workflow.artifact_id AND artifact.workflow_id = workflow.id
       WHERE workflow.feature_id = $1
       ORDER BY workflow.requested_at DESC, workflow.id DESC LIMIT 1`,
      [featureId],
    )
  ).rows[0];
}

async function selectWorkspace(client: PoolClient, featureId: string) {
  return (
    await client.query<WorkspaceRow>(
      "SELECT * FROM factory_feature_workspaces WHERE feature_id = $1",
      [featureId],
    )
  ).rows[0];
}

async function selectCertificate(
  client: PoolClient,
  featureId: string,
  version: number,
  workspace: WorkspaceRow,
): Promise<FactoryFeatureVerification | null> {
  const row = (
    await client.query<{
      id: string;
      feature_id: string;
      plan_version: number;
      run_id: string;
      source: unknown;
      revision: unknown;
      manifest: unknown;
      manifest_digest: string;
      evidence_ids: string[];
      created_at: Date;
    }>(
      `SELECT * FROM factory_feature_verifications
       WHERE feature_id = $1 AND plan_version = $2
         AND revision = jsonb_build_object(
           'baseCommitId', $3::text, 'headCommitId', $4::text,
           'treeId', $5::text, 'branch', $6::text)
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [
        featureId,
        version,
        workspace.base_commit_id,
        workspace.head_commit_id,
        workspace.tree_id,
        workspace.branch,
      ],
    )
  ).rows[0];
  return row === undefined
    ? null
    : FactoryFeatureVerificationSchema.parse({
        id: row.id,
        featureId: row.feature_id,
        approvedVersion: row.plan_version,
        runId: row.run_id,
        source: row.source,
        revision: row.revision,
        manifest: row.manifest,
        manifestDigest: row.manifest_digest,
        evidenceIds: row.evidence_ids,
        createdAt: row.created_at.toISOString(),
      });
}

async function selectPublicationInput(client: PoolClient, featureId: string) {
  const result = await client.query<{
    id: string;
    target: unknown;
    issues: unknown;
    payload: unknown;
    pull_request: unknown;
  }>(
    `SELECT operation.id, operation.target, operation.issues, operation.payload, result.pull_request
     FROM factory_feature_pr_publications AS publication
     JOIN factory_feature_pr_operations AS operation ON operation.feature_id = publication.feature_id
     JOIN factory_feature_pr_results AS result ON result.feature_id = publication.feature_id
     JOIN factory_feature_pr_revisions AS revision ON revision.feature_id = publication.feature_id
     WHERE publication.feature_id = $1 AND publication.state = 'published'`,
    [featureId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return PublicationInputSchema.parse({
    operation: {
      id: row.id,
      featureId,
      target: row.target,
      issues: row.issues,
      payload: row.payload,
    },
    pullRequest: row.pull_request,
  });
}

async function replayOrConflict(
  client: PoolClient,
  feature: FeatureRow,
  actorId: string,
  command: FactoryReviewCorrectionCommand,
): Promise<FactoryReviewCorrection | null> {
  const duplicate = (
    await client.query<CorrectionRow>(
      "SELECT * FROM factory_review_corrections WHERE feature_id = $1 AND request_id = $2",
      [feature.id, command.requestId],
    )
  ).rows[0];
  if (duplicate === undefined) return null;
  if (
    duplicate.requested_by_operator_id !== actorId ||
    duplicate.plan_version !== command.expectedPlanVersion ||
    duplicate.source_workflow_id !== command.review.workflowId ||
    duplicate.source_artifact_id !== command.review.artifactId ||
    duplicate.head_commit_id !== command.review.headCommitId ||
    duplicate.instruction !== command.instruction ||
    JSON.stringify(duplicate.finding_ids) !== JSON.stringify(command.findingIds)
  )
    throw new FactoryError("conflict", "The correction request ID was already used");
  return mapCorrection(duplicate);
}

/** Return an exact durable replay before any provider read is attempted. */
export function replayFactoryReviewCorrectionRequest(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  actorId: string,
  input: FactoryReviewCorrectionCommand,
): Promise<FactoryReviewCorrection | null> {
  const command = FactoryReviewCorrectionCommandSchema.parse(input);
  return withFactoryFeature(pool, projectId, featureId, (client, feature) =>
    replayOrConflict(client, feature, actorId, command),
  );
}

export function requestFactoryReviewCorrection(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  projectId: string,
  featureId: string,
  actorId: string,
  input: FactoryReviewCorrectionCommand,
): Promise<FactoryReviewCorrection> {
  const command = FactoryReviewCorrectionCommandSchema.parse(input);
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    const replay = await replayOrConflict(client, feature, actorId, command);
    if (replay !== null) return replay;
    if (
      feature.state !== "in_review" ||
      feature.approved_plan_version !== command.expectedPlanVersion
    )
      throw new FactoryReviewCorrectionError("not_ready");
    const active = await client.query(
      `SELECT id FROM factory_review_corrections WHERE feature_id = $1
       AND state IN ('executing','gated','publishing','blocked','uncertain','reviewing')`,
      [featureId],
    );
    if (active.rowCount !== 0) throw new FactoryReviewCorrectionError("active_correction");
    const [review, workspace, publication] = await Promise.all([
      selectCurrentReview(client, featureId),
      selectWorkspace(client, featureId),
      selectPublicationInput(client, featureId),
    ]);
    if (
      review === undefined ||
      review.workflow_state !== "published" ||
      review.artifact_id === null ||
      review.workflow_id !== command.review.workflowId ||
      review.artifact_id !== command.review.artifactId ||
      workspace === undefined ||
      publication === null
    )
      throw new FactoryReviewCorrectionError("not_ready");
    const artifact = FactoryConceptualReviewArtifactSchema.parse(review.artifact);
    if (
      artifact.id !== command.review.artifactId ||
      artifact.workflowId !== command.review.workflowId ||
      artifact.reviewRevisionId !== review.review_revision_id ||
      artifact.inputDigest !== review.input_digest ||
      artifact.baseCommitId !== workspace.base_commit_id ||
      artifact.headCommitId !== workspace.head_commit_id ||
      artifact.headCommitId !== command.review.headCommitId ||
      review.observed_head_commit_id !== artifact.headCommitId ||
      publication.pullRequest.headCommitId !== artifact.headCommitId ||
      publication.operation.payload.headCommitId !== artifact.headCommitId
    )
      throw new FactoryReviewCorrectionError("review_outdated");
    const findings = command.findingIds.map((findingId) => {
      const problem = artifact.graph.problems.find(
        (candidate) => candidate.id === findingId && candidate.type === "finding",
      );
      if (problem?.type !== "finding") throw new FactoryReviewCorrectionError("finding_not_found");
      return { id: problem.id, title: problem.title, riskLevel: problem.riskLevel };
    });
    const planRow = (
      await client.query<{ document: unknown }>(
        "SELECT document FROM factory_plan_versions WHERE feature_id = $1 AND version = $2",
        [featureId, command.expectedPlanVersion],
      )
    ).rows[0];
    if (planRow === undefined) throw new FactoryReviewCorrectionError("not_ready");
    const plan = FeaturePlanDocumentSchema.parse(planRow.document);
    const manifest = factoryVerificationManifest(plan);
    const certificate = await selectCertificate(
      client,
      featureId,
      command.expectedPlanVersion,
      workspace,
    );
    if (
      certificate === null ||
      certificate.source.repositoryId !== workspace.repository_id ||
      certificate.source.identity !== workspace.source_identity ||
      JSON.stringify(certificate.manifest) !== JSON.stringify(manifest) ||
      publication.operation.target.certificateId !== certificate.id
    )
      throw new FactoryReviewCorrectionError("not_ready");
    const running = await client.query(
      `SELECT id FROM factory_execution_runs WHERE feature_id = $1 AND reservation_released_at IS NULL
       UNION ALL SELECT id FROM review_workflows WHERE feature_id = $1 AND workflow_state IN ('queued','running')`,
      [featureId],
    );
    if (running.rowCount !== 0) throw new FactoryReviewCorrectionError("not_ready");
    const inserted = (
      await client.query<{ id: string }>(
        `INSERT INTO factory_review_corrections (
          feature_id, project_id, plan_version, requested_by_operator_id, request_id,
          source_workflow_id, source_artifact_id, source_review_revision_id, source_input_digest,
          base_commit_id, head_commit_id, tree_id, instruction, finding_ids, findings,
          publication_input)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text[],$15::jsonb,$16::jsonb)
         RETURNING id`,
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
          workspace.base_commit_id,
          workspace.head_commit_id,
          workspace.tree_id,
          command.instruction,
          command.findingIds,
          JSON.stringify(FindingSelectionSchema.parse(findings)),
          JSON.stringify(publication),
        ],
      )
    ).rows[0];
    if (inserted === undefined) throw new Error("Correction request was not persisted");
    const run = (
      await client.query<{ id: string }>(
        `INSERT INTO factory_execution_runs (
          feature_id, project_id, work_item_id, plan_version, purpose, attempt, source,
          accepted_commands, verification_manifest, initial_revision, revision, correction_id)
         VALUES ($1,$2,NULL,$3,'correction',1,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$7::jsonb,$8)
         RETURNING id`,
        [
          featureId,
          feature.project_id,
          command.expectedPlanVersion,
          JSON.stringify(certificate.source),
          JSON.stringify(manifest.map((entry) => entry.command)),
          JSON.stringify(manifest),
          JSON.stringify(certificate.revision),
          inserted.id,
        ],
      )
    ).rows[0];
    if (run === undefined) throw new Error("Correction execution was not persisted");
    await client.query(
      "UPDATE factory_review_corrections SET current_run_id = $2, updated_at = clock_timestamp() WHERE id = $1",
      [inserted.id, run.id],
    );
    const jobId = await boss.send(
      FACTORY_EXECUTION_QUEUE,
      { runId: run.id },
      { db: pgBossDatabase(client), id: run.id },
    );
    if (jobId !== run.id) throw new Error("Correction execution was not durably queued");
    await client.query(
      "UPDATE factory_features SET state = 'implementing', updated_at = clock_timestamp() WHERE id = $1",
      [featureId],
    );
    await client.query(
      "INSERT INTO factory_activity (feature_id, kind, summary) VALUES ($1,'correction_requested',$2)",
      [featureId, `The Operator requested a correction from review ${artifact.id}`],
    );
    const row = await currentRow(client, featureId);
    if (row === null) throw new Error("Correction request disappeared");
    return mapCorrection(row);
  });
}

export function retryFactoryReviewCorrection(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  correctionId: string,
  actorId: string,
  requestId: string,
): Promise<FactoryReviewCorrection> {
  return withFactoryFeature(pool, projectId, featureId, async (client) => {
    const correction = (
      await client.query<CorrectionRow>(
        "SELECT * FROM factory_review_corrections WHERE id = $1 AND feature_id = $2 FOR UPDATE",
        [correctionId, featureId],
      )
    ).rows[0];
    if (correction === undefined) throw new FactoryReviewCorrectionError("not_found");
    const duplicate = (
      await client.query<{ actor_id: string }>(
        "SELECT actor_id FROM factory_review_correction_retry_requests WHERE correction_id = $1 AND request_id = $2",
        [correctionId, requestId],
      )
    ).rows[0];
    if (duplicate !== undefined) {
      if (duplicate.actor_id !== actorId) throw new FactoryError("conflict");
      return mapCorrection(correction);
    }
    if (!["blocked", "uncertain"].includes(correction.state))
      throw new FactoryReviewCorrectionError("invalid_state");
    const retries = await client.query<{ count: string }>(
      "SELECT count(*) FROM factory_review_correction_retry_requests WHERE correction_id = $1",
      [correctionId],
    );
    if (Number(retries.rows[0]?.count ?? 0) >= 20) {
      await client.query(
        "UPDATE factory_review_corrections SET failure = 'retry_limit', updated_at = clock_timestamp() WHERE id = $1",
        [correctionId],
      );
      const limited = await currentRow(client, featureId);
      if (limited === null) throw new Error("Correction request disappeared");
      return mapCorrection(limited);
    }
    await client.query(
      "INSERT INTO factory_review_correction_retry_requests (correction_id,request_id,actor_id) VALUES ($1,$2,$3)",
      [correctionId, requestId, actorId],
    );
    await client.query(
      `UPDATE factory_review_corrections SET state = 'publishing', failure = NULL,
       job_id = NULL, attempt_id = NULL, retry_after = NULL, updated_at = clock_timestamp()
       WHERE id = $1`,
      [correctionId],
    );
    const updated = await currentRow(client, featureId);
    if (updated === null) throw new Error("Correction request disappeared");
    return mapCorrection(updated);
  });
}

export interface ClaimedFactoryReviewCorrection {
  id: string;
  featureId: string;
  projectId: string;
  attemptId: string;
  planVersion: number;
  title: string;
  plan: FeaturePlanDocument;
  approvalId: string;
  operatorId: string;
  workspace: FactoryFeatureWorkspace;
  planMarkdown: string;
  specMarkdown: string;
  identity: FactoryFeaturePublicationOperation["target"]["identity"];
  issues: FactoryFeaturePublicationIssue[];
  reviewRequestId: string;
  sourceReview: FactoryReviewCorrection["sourceReview"];
  instruction: string;
  findings: FactoryReviewCorrection["findings"];
  runId: string;
  certificate: FactoryFeatureVerification;
  operation: FactoryFeaturePublicationOperation;
  pullRequest: FactoryFeaturePullRequest;
  pushAttempted: boolean;
  pushConfirmed: boolean;
}

async function certificateById(client: PoolClient, certificateId: string) {
  const row = (
    await client.query<{
      id: string;
      feature_id: string;
      plan_version: number;
      run_id: string;
      source: unknown;
      revision: unknown;
      manifest: unknown;
      manifest_digest: string;
      evidence_ids: string[];
      created_at: Date;
    }>("SELECT * FROM factory_feature_verifications WHERE id = $1", [certificateId])
  ).rows[0];
  if (row === undefined) throw new FactoryReviewCorrectionError("not_ready");
  return FactoryFeatureVerificationSchema.parse({
    id: row.id,
    featureId: row.feature_id,
    approvedVersion: row.plan_version,
    runId: row.run_id,
    source: row.source,
    revision: row.revision,
    manifest: row.manifest,
    manifestDigest: row.manifest_digest,
    evidenceIds: row.evidence_ids,
    createdAt: row.created_at.toISOString(),
  });
}

export async function claimFactoryReviewCorrection(
  pool: DatabasePool,
  correctionId: string,
): Promise<ClaimedFactoryReviewCorrection | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const attemptId = randomUUID();
    const result = await client.query<CorrectionRow>(
      `UPDATE factory_review_corrections SET attempt_id = $2, updated_at = clock_timestamp()
       WHERE id = $1 AND state = 'publishing' AND certificate_id IS NOT NULL
         AND attempt_id IS NULL RETURNING *`,
      [correctionId, attemptId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      await client.query("COMMIT");
      return null;
    }
    const certificate = await certificateById(client, row.certificate_id ?? "");
    const publication = PublicationInputSchema.parse(row.publication_input);
    const context = (
      await client.query<{
        title: string;
        state: string;
        approved_plan_version: number | null;
        document: unknown;
        plan_markdown: string;
        spec_markdown: string;
        approval_id: string;
        project_id: string;
        repository_id: string;
        source_identity: string;
        base_commit_id: string;
        head_commit_id: string;
        tree_id: string;
        branch: string;
        object_format: "sha1" | "sha256";
      }>(
        `SELECT feature.title, feature.state, feature.approved_plan_version,
          plan.document, plan.plan_markdown, plan.spec_markdown, approval.id AS approval_id,
          workspace.project_id, workspace.repository_id, workspace.source_identity,
          workspace.base_commit_id, workspace.head_commit_id, workspace.tree_id,
          workspace.branch, workspace.object_format
         FROM factory_features AS feature
         JOIN factory_plan_versions AS plan
           ON plan.feature_id = feature.id AND plan.version = $2
         JOIN factory_plan_approvals AS approval
           ON approval.feature_id = plan.feature_id AND approval.plan_version = plan.version
         JOIN factory_feature_workspaces AS workspace ON workspace.feature_id = feature.id
         WHERE feature.id = $1
         FOR UPDATE OF feature`,
        [row.feature_id, row.plan_version],
      )
    ).rows[0];
    if (
      context === undefined ||
      context.state !== "in_review" ||
      context.approved_plan_version !== row.plan_version ||
      certificate.featureId !== row.feature_id ||
      certificate.approvedVersion !== row.plan_version ||
      certificate.runId !== row.current_run_id ||
      certificate.revision.baseCommitId !== row.base_commit_id ||
      certificate.revision.headCommitId === row.head_commit_id ||
      certificate.revision.baseCommitId !== context.base_commit_id ||
      certificate.revision.headCommitId !== context.head_commit_id ||
      certificate.revision.treeId !== context.tree_id ||
      certificate.revision.branch !== context.branch ||
      certificate.source.repositoryId !== context.repository_id ||
      certificate.source.identity !== context.source_identity
    )
      throw new FactoryReviewCorrectionError("invalid_state");
    const plan = FeaturePlanDocumentSchema.parse(context.document);
    if (JSON.stringify(factoryVerificationManifest(plan)) !== JSON.stringify(certificate.manifest))
      throw new FactoryReviewCorrectionError("invalid_state");
    const workspace: FactoryFeatureWorkspace = {
      featureId: row.feature_id,
      projectId: context.project_id,
      repositoryId: context.repository_id,
      sourceIdentity: context.source_identity,
      baseCommitId: context.base_commit_id,
      headCommitId: context.head_commit_id,
      treeId: context.tree_id,
      branch: context.branch,
      objectFormat: context.object_format,
    };
    await client.query("COMMIT");
    return {
      id: row.id,
      featureId: row.feature_id,
      projectId: row.project_id,
      attemptId,
      planVersion: row.plan_version,
      title: context.title,
      plan,
      approvalId: context.approval_id,
      operatorId: row.requested_by_operator_id,
      workspace,
      planMarkdown: context.plan_markdown,
      specMarkdown: context.spec_markdown,
      identity: publication.operation.target.identity,
      issues: publication.operation.issues,
      reviewRequestId: row.review_request_id,
      sourceReview: {
        workflowId: row.source_workflow_id,
        artifactId: row.source_artifact_id,
        reviewRevisionId: row.source_review_revision_id,
        baseCommitId: row.base_commit_id,
        headCommitId: row.head_commit_id,
      },
      instruction: row.instruction,
      findings: FindingSelectionSchema.parse(row.findings),
      runId: row.current_run_id,
      certificate,
      operation: publication.operation,
      pullRequest: publication.pullRequest,
      pushAttempted: row.push_attempted,
      pushConfirmed: row.push_confirmed_at !== null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function withCorrectionAttempt<T>(
  pool: DatabasePool,
  claim: ClaimedFactoryReviewCorrection,
  operation: (client: PoolClient, row: CorrectionRow) => Promise<T>,
): Promise<T> {
  return withFactoryFeature(pool, claim.projectId, claim.featureId, async (client) => {
    const row = (
      await client.query<CorrectionRow>(
        `SELECT * FROM factory_review_corrections
         WHERE id = $1 AND feature_id = $2 AND state = 'publishing' AND attempt_id = $3 FOR UPDATE`,
        [claim.id, claim.featureId, claim.attemptId],
      )
    ).rows[0];
    if (row === undefined) throw new FactoryReviewCorrectionError("invalid_state");
    return operation(client, row);
  });
}

export function markFactoryReviewCorrectionPush(
  pool: DatabasePool,
  claim: ClaimedFactoryReviewCorrection,
  attempted: boolean,
) {
  return withCorrectionAttempt(pool, claim, async (client, row) => {
    if (attempted && row.push_attempted && row.push_confirmed_at === null)
      throw new FactoryReviewCorrectionError("invalid_state");
    await client.query(
      `UPDATE factory_review_corrections SET push_attempted = $2,
       updated_at = clock_timestamp() WHERE id = $1`,
      [claim.id, attempted],
    );
  });
}

export function confirmFactoryReviewCorrectionPush(
  pool: DatabasePool,
  claim: ClaimedFactoryReviewCorrection,
) {
  return withCorrectionAttempt(pool, claim, async (client) => {
    await client.query(
      `UPDATE factory_review_corrections SET push_confirmed_at = COALESCE(push_confirmed_at, clock_timestamp()),
       updated_at = clock_timestamp() WHERE id = $1`,
      [claim.id],
    );
  });
}

export function bindFactoryReviewCorrectionRevision(
  pool: DatabasePool,
  claim: ClaimedFactoryReviewCorrection,
  operationInput: FactoryFeaturePublicationOperation,
  pullRequestInput: FactoryFeaturePullRequest,
  reviewInput: FactoryFeaturePublicationReview,
) {
  const operation = FactoryFeaturePublicationOperationSchema.parse(operationInput);
  const pullRequest = FactoryFeaturePullRequestSchema.parse(pullRequestInput);
  const review = FactoryFeaturePublicationReviewSchema.parse(reviewInput);
  const expectedTarget = {
    ...claim.operation.target,
    certificateId: claim.certificate.id,
    source: claim.certificate.source,
    revision: claim.certificate.revision,
  };
  const expectedPayload = {
    ...claim.operation.payload,
    headCommitId: claim.certificate.revision.headCommitId,
  };
  const expectedPullRequest = { ...claim.pullRequest, ...expectedPayload };
  if (
    operation.id !== claim.operation.id ||
    operation.featureId !== claim.featureId ||
    JSON.stringify(operation.target) !== JSON.stringify(expectedTarget) ||
    JSON.stringify(operation.issues) !== JSON.stringify(claim.operation.issues) ||
    JSON.stringify(operation.payload) !== JSON.stringify(expectedPayload) ||
    JSON.stringify(pullRequest) !== JSON.stringify(expectedPullRequest) ||
    pullRequest.state !== "open" ||
    review.projectId !== claim.projectId ||
    review.revision.state !== "available" ||
    review.revision.base.objectId !== claim.certificate.revision.baseCommitId ||
    review.revision.head.objectId !== claim.certificate.revision.headCommitId
  )
    throw new FactoryReviewCorrectionError("invalid_state");
  return withCorrectionAttempt(pool, claim, async (client, row) => {
    if (
      row.certificate_id !== claim.certificate.id ||
      row.push_confirmed_at === null ||
      row.replacement_review_workflow_id !== null
    )
      throw new FactoryReviewCorrectionError("invalid_state");
    await client.query(
      `UPDATE factory_feature_pr_publications SET certificate_id = $2,
       updated_at = clock_timestamp() WHERE feature_id = $1 AND state = 'published'`,
      [claim.featureId, claim.certificate.id],
    );
    await client.query(
      "UPDATE factory_feature_pr_operations SET target = $2::jsonb, payload = $3::jsonb WHERE feature_id = $1",
      [claim.featureId, JSON.stringify(operation.target), JSON.stringify(operation.payload)],
    );
    await client.query(
      "UPDATE factory_feature_pr_results SET pull_request = $2::jsonb WHERE feature_id = $1",
      [claim.featureId, JSON.stringify(pullRequest)],
    );
    await client.query(
      `UPDATE factory_feature_pr_revisions SET project_id = $2, change_proposal_id = $3,
       review_revision_id = $4 WHERE feature_id = $1`,
      [claim.featureId, review.projectId, review.changeProposalId, review.revision.id],
    );
    await client.query(
      `UPDATE factory_review_corrections SET replacement_pull_request = $2::jsonb,
       replacement_project_id = $3, replacement_change_proposal_id = $4,
       replacement_review_revision_id = $5, replacement_manifest_digest = $6,
       updated_at = clock_timestamp() WHERE id = $1`,
      [
        claim.id,
        JSON.stringify(pullRequest),
        review.projectId,
        review.changeProposalId,
        review.revision.id,
        review.manifestDigest,
      ],
    );
    await client.query(
      "INSERT INTO factory_activity (feature_id, kind, summary) VALUES ($1,'correction_published',$2)",
      [claim.featureId, "The corrected exact revision was retained on the existing pull request"],
    );
  });
}

export function bindFactoryReviewCorrectionWorkflow(
  pool: DatabasePool,
  claim: ClaimedFactoryReviewCorrection,
  input: FactoryConceptualReviewWorkflowRead,
) {
  const workflow = input.workflow;
  if (
    workflow.requestId !== claim.reviewRequestId ||
    workflow.projectId !== claim.projectId ||
    workflow.featureId !== claim.featureId
  )
    throw new FactoryReviewCorrectionError("invalid_state");
  return withCorrectionAttempt(pool, claim, async (client, row) => {
    if (
      row.replacement_project_id !== workflow.projectId ||
      row.replacement_change_proposal_id !== workflow.changeProposalId ||
      row.replacement_review_revision_id !== workflow.reviewRevisionId ||
      row.replacement_pull_request === null
    )
      throw new FactoryReviewCorrectionError("invalid_state");
    const completed = workflow.state === "published" && workflow.artifactId !== null;
    const failed = workflow.state === "failed";
    await client.query(
      `UPDATE factory_review_corrections SET state = $2, failure = $3,
       replacement_review_workflow_id = $4, replacement_artifact_id = $5,
       completed_at = CASE WHEN $6 THEN clock_timestamp() ELSE NULL END,
       attempt_id = NULL, job_id = NULL, updated_at = clock_timestamp() WHERE id = $1`,
      [
        claim.id,
        completed ? "completed" : failed ? "failed" : "reviewing",
        failed ? "review_failed" : null,
        workflow.id,
        completed ? workflow.artifactId : null,
        completed,
      ],
    );
  });
}

export function failFactoryReviewCorrection(
  pool: DatabasePool,
  claim: ClaimedFactoryReviewCorrection,
  failure: FactoryReviewCorrectionFailure,
  retryAt?: Date,
) {
  const parsed = FactoryReviewCorrectionFailureSchema.parse(failure);
  return withCorrectionAttempt(pool, claim, async (client, row) => {
    const uncertain = row.push_attempted && row.push_confirmed_at === null;
    await client.query(
      `UPDATE factory_review_corrections SET state = $2, failure = $3, retry_after = $4,
       attempt_id = NULL, job_id = NULL, updated_at = clock_timestamp() WHERE id = $1`,
      [
        claim.id,
        uncertain ? "uncertain" : "blocked",
        uncertain ? "uncertain_write" : parsed,
        retryAt ?? null,
      ],
    );
  });
}

/** Requeues interrupted publication and creates a correction successor after an accepted gate. */
export async function reconcileFactoryReviewCorrections(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('factory-review-correction-reconcile-v1', 0))",
    );
    await client.query(
      `UPDATE factory_review_corrections SET
       state = CASE WHEN push_attempted AND push_confirmed_at IS NULL THEN 'uncertain' ELSE 'publishing' END,
       failure = CASE WHEN push_attempted AND push_confirmed_at IS NULL THEN 'uncertain_write' ELSE NULL END,
       attempt_id = NULL, job_id = NULL, updated_at = clock_timestamp()
       WHERE state = 'publishing' AND attempt_id IS NOT NULL
         AND updated_at < clock_timestamp() - interval '940 seconds'`,
    );
    const reviews = await client.query<{
      correction_id: string;
      feature_id: string;
      workflow_state: string;
      artifact_id: string | null;
    }>(
      `SELECT correction.id AS correction_id, correction.feature_id,
        workflow.workflow_state, workflow.artifact_id
       FROM factory_review_corrections AS correction
       JOIN review_workflows AS workflow ON workflow.id = correction.replacement_review_workflow_id
       WHERE correction.state = 'reviewing' AND workflow.workflow_state IN ('published','failed')
       ORDER BY correction.updated_at, correction.id LIMIT 20
       FOR UPDATE OF correction, workflow`,
    );
    for (const review of reviews.rows) {
      const completed = review.workflow_state === "published" && review.artifact_id !== null;
      await client.query(
        `UPDATE factory_review_corrections SET state = $2, failure = $3,
         replacement_artifact_id = $4,
         completed_at = CASE WHEN $5 THEN clock_timestamp() ELSE NULL END,
         updated_at = clock_timestamp() WHERE id = $1`,
        [
          review.correction_id,
          completed ? "completed" : "failed",
          completed ? null : "review_failed",
          completed ? review.artifact_id : null,
          completed,
        ],
      );
      await client.query(
        "INSERT INTO factory_activity (feature_id, kind, summary) VALUES ($1,'correction_reviewed',$2)",
        [
          review.feature_id,
          completed
            ? "The replacement Conceptual Review is ready"
            : "The replacement Conceptual Review failed and remains inspectable",
        ],
      );
    }
    const resumable = await client.query<{
      correction_id: string;
      feature_id: string;
      project_id: string;
      plan_version: number;
      current_run_id: string;
      attempt: number;
      source: unknown;
      accepted_commands: unknown;
      verification_manifest: unknown;
      initial_revision: unknown;
      base_commit_id: string;
      head_commit_id: string;
      tree_id: string;
      branch: string;
      gate_id: string;
    }>(
      `SELECT correction.id AS correction_id, correction.feature_id, correction.project_id,
        correction.plan_version, correction.current_run_id, run.attempt, run.source,
        run.accepted_commands, run.verification_manifest, run.initial_revision,
        workspace.base_commit_id, workspace.head_commit_id, workspace.tree_id, workspace.branch,
        gate.id AS gate_id
       FROM factory_review_corrections AS correction
       JOIN factory_execution_runs AS run ON run.id = correction.current_run_id
       JOIN factory_human_gates AS gate ON gate.run_id = run.id
       JOIN factory_features AS feature ON feature.id = correction.feature_id
       JOIN factory_feature_workspaces AS workspace ON workspace.feature_id = correction.feature_id
       WHERE correction.state = 'gated' AND feature.state = 'queued'
         AND gate.decision = 'resume_within_plan' AND gate.resolved_at IS NOT NULL
         AND run.reservation_released_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM factory_execution_containers container
           WHERE container.run_id = run.id AND container.stopped_at IS NULL)
       ORDER BY correction.updated_at, correction.id LIMIT 20 FOR UPDATE OF correction, feature`,
    );
    for (const row of resumable.rows) {
      if (row.attempt >= 20) continue;
      const revision = {
        baseCommitId: row.base_commit_id,
        headCommitId: row.head_commit_id,
        treeId: row.tree_id,
        branch: row.branch,
      };
      const run = (
        await client.query<{ id: string }>(
          `INSERT INTO factory_execution_runs (
            feature_id,project_id,work_item_id,plan_version,purpose,attempt,source,
            accepted_commands,verification_manifest,initial_revision,revision,correction_id,resume_gate_id)
           VALUES ($1,$2,NULL,$3,'correction',$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$8::jsonb,$9,$10)
           RETURNING id`,
          [
            row.feature_id,
            row.project_id,
            row.plan_version,
            row.attempt + 1,
            row.source == null ? null : JSON.stringify(row.source),
            JSON.stringify(row.accepted_commands),
            JSON.stringify(row.verification_manifest),
            JSON.stringify(revision),
            row.correction_id,
            row.gate_id,
          ],
        )
      ).rows[0];
      if (run === undefined) throw new Error("Correction retry was not persisted");
      await client.query(
        `UPDATE factory_review_corrections SET state = 'executing', failure = NULL,
         current_run_id = $2, updated_at = clock_timestamp() WHERE id = $1`,
        [row.correction_id, run.id],
      );
      await client.query(
        "UPDATE factory_features SET state = 'implementing', updated_at = clock_timestamp() WHERE id = $1",
        [row.feature_id],
      );
      const job = await boss.send(
        FACTORY_EXECUTION_QUEUE,
        { runId: run.id },
        { db: pgBossDatabase(client), id: run.id },
      );
      if (job !== run.id) throw new Error("Correction retry was not durably queued");
    }
    const queued = await client.query<{ id: string }>(
      `SELECT correction.id FROM factory_review_corrections AS correction
       WHERE correction.state = 'publishing' AND correction.certificate_id IS NOT NULL
         AND correction.attempt_id IS NULL
         AND (correction.retry_after IS NULL OR correction.retry_after <= clock_timestamp())
         AND NOT EXISTS (SELECT 1 FROM pgboss.job job WHERE job.name = $1
           AND job.id = correction.job_id AND job.state NOT IN ('failed','cancelled','completed'))
       ORDER BY correction.updated_at, correction.id LIMIT 20 FOR UPDATE OF correction`,
      [FACTORY_CORRECTION_QUEUE],
    );
    for (const row of queued.rows) {
      const jobId = randomUUID();
      await client.query(
        "UPDATE factory_review_corrections SET job_id = $2, updated_at = clock_timestamp() WHERE id = $1",
        [row.id, jobId],
      );
      const sent = await boss.send(
        FACTORY_CORRECTION_QUEUE,
        { correctionId: row.id },
        { db: pgBossDatabase(client), id: jobId },
      );
      if (sent !== jobId) throw new Error("Correction publication was not durably queued");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function correctionPublicationInput(claim: ClaimedFactoryReviewCorrection) {
  return PublicationInputSchema.parse({
    operation: claim.operation,
    pullRequest: claim.pullRequest,
  });
}

export function correctionVerificationManifest(value: unknown) {
  return FactoryVerificationManifestSchema.parse(value);
}
