import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  FactoryFeatureVerificationSchema,
  factoryVerificationManifest,
  FeaturePlanDocumentSchema,
  FactoryVerificationResultSchema,
  FactoryGitHubIssueSchema,
  FactoryFeaturePublicationSchema,
  FactoryFeaturePublicationOperationSchema,
  FactoryFeaturePublicationIssueSchema,
  FactoryFeaturePublicationIdentitySchema,
  FactoryFeaturePullRequestSchema,
  FactoryFeaturePublicationReviewSchema,
  FactoryFeaturePublicationFailureSchema,
  type FactoryFeaturePublicationFailure,
  type FactoryFeaturePublicationOperation,
  type FactoryFeaturePublicationIssue,
  type FactoryFeaturePullRequest,
  type FactoryFeaturePublicationReview,
  type FactoryFeatureVerification,
  type FactoryExecutionRevision,
  type FeaturePlanDocument,
} from "@kestrel/contracts";
import type { DatabasePool } from "./pool.js";
import type { DiagnosticJobSender } from "./diagnostics.js";
import { FACTORY_FEATURE_PUBLICATION_QUEUE, pgBossDatabase } from "./pg-boss.js";
import { FactoryError, withFactoryFeature, type FeatureRow } from "./factory-planning.js";
import {
  factoryWorkItemsVerified,
  readCurrentFactoryFeatureVerification,
} from "./factory-verification.js";
import { factoryWorkspaceRevision } from "./factory-execution-read.js";
import type { FactoryFeatureWorkspace } from "./factory-execution.js";
import { factoryImportsFor } from "./factory-issue-imports.js";

export class FactoryFeaturePublicationError extends Error {
  constructor(
    readonly code: FactoryFeaturePublicationFailure,
    options?: ErrorOptions,
  ) {
    super(`Feature publication blocked: ${code}`, options);
  }
}

interface PublicationRow {
  feature_id: string;
  plan_version: number;
  certificate_id: string;
  state: "queued" | "running" | "blocked" | "uncertain" | "published" | "cancelled";
  job_id: string;
  attempt_id: string | null;
  started_at: Date | null;
  push_attempted: boolean;
  push_confirmed_at: Date | null;
  pr_attempted: boolean;
  failure: FactoryFeaturePublicationFailure | null;
  retry_after: Date | null;
  updated_at: Date;
}
export interface FactoryFeaturePublicationClaimIdentity {
  featureId: string;
  projectId: string;
  attemptId: string;
}
export interface ClaimedFactoryFeaturePublication extends FactoryFeaturePublicationClaimIdentity {
  title: string;
  version: number;
  cancelled: boolean;
  plan: FeaturePlanDocument;
  approvalId: string;
  operatorId: string;
  certificate: FactoryFeatureVerification;
  workspace: FactoryFeatureWorkspace;
  planMarkdown: string;
  specMarkdown: string;
  identity: FactoryFeaturePublicationOperation["target"]["identity"];
  issues: FactoryFeaturePublicationIssue[];
  operation: FactoryFeaturePublicationOperation | null;
  pullRequest: FactoryFeaturePullRequest | null;
  pushAttempted: boolean;
  pushConfirmed: boolean;
  prAttempted: boolean;
}
async function publicationRow(client: PoolClient, featureId: string) {
  return (
    await client.query<PublicationRow>(
      "SELECT * FROM factory_feature_pr_publications WHERE feature_id = $1",
      [featureId],
    )
  ).rows[0];
}
async function retainedCertificate(client: PoolClient, id: string) {
  const result = await client.query<{
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
  }>("SELECT * FROM factory_feature_verifications WHERE id = $1", [id]);
  const row = result.rows[0];
  if (row === undefined) throw new FactoryFeaturePublicationError("verification_required");
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
async function operationFor(client: PoolClient, featureId: string) {
  const result = await client.query<{
    id: string;
    feature_id: string;
    target: unknown;
    issues: unknown;
    payload: unknown;
  }>("SELECT * FROM factory_feature_pr_operations WHERE feature_id = $1", [featureId]);
  const row = result.rows[0];
  return row === undefined
    ? null
    : FactoryFeaturePublicationOperationSchema.parse({
        id: row.id,
        featureId: row.feature_id,
        target: row.target,
        issues: row.issues,
        payload: row.payload,
      });
}
async function pullRequestFor(client: PoolClient, featureId: string) {
  const row = (
    await client.query<{ pull_request: unknown }>(
      "SELECT pull_request FROM factory_feature_pr_results WHERE feature_id = $1",
      [featureId],
    )
  ).rows[0];
  return row === undefined ? null : FactoryFeaturePullRequestSchema.parse(row.pull_request);
}
async function issueInputs(
  client: PoolClient,
  featureId: string,
  version: number,
  plan: FeaturePlanDocument,
) {
  const rows = (
    await client.query<{ id: string; key: string; issue: unknown; published_at: Date | null }>(
      `SELECT item.id, item.key, publication.issue, publication.published_at FROM factory_work_items item
     LEFT JOIN factory_issue_publications publication ON publication.work_item_id = item.id AND publication.feature_id = item.feature_id
     WHERE item.feature_id = $1 AND item.plan_version = $2 ORDER BY item.position`,
      [featureId, version],
    )
  ).rows;
  if (rows.length !== plan.workItems.length)
    throw new FactoryFeaturePublicationError("issue_identity_missing");
  const imports = plan.workItems.some((item) => item.importedIssueId !== null)
    ? await factoryImportsFor(client, featureId)
    : [];
  const items = rows.map((row, index) => {
    const definition = plan.workItems[index];
    const parsed = FactoryGitHubIssueSchema.safeParse(row.issue);
    if (definition?.key !== row.key || row.published_at === null || !parsed.success)
      throw new FactoryFeaturePublicationError("issue_identity_missing");
    const issue = parsed.data;
    if (definition.importedIssueId !== null) {
      const original = imports.find((item) => item.id === definition.importedIssueId)?.issue;
      if (original?.id !== issue.id || original.repository.id !== issue.repository.id)
        throw new FactoryFeaturePublicationError("issue_identity_missing");
    }
    return FactoryFeaturePublicationIssueSchema.parse({
      workItemId: row.id,
      key: row.key,
      title: definition.title,
      issue: { repository: issue.repository, id: issue.id, number: issue.number, url: issue.url },
    });
  });
  if (
    new Set(items.map((item) => `${item.issue.repository.id}:${item.issue.id}`)).size !==
    items.length
  )
    throw new FactoryFeaturePublicationError("issue_identity_missing");
  return items;
}

async function publicationInputs(
  client: PoolClient,
  feature: FeatureRow,
  publication: PublicationRow,
) {
  const approved = (
    await client.query<{
      document: unknown;
      plan_markdown: string;
      spec_markdown: string;
      approval_id: string;
      operator_id: string;
      identity: unknown;
    }>(
      `SELECT plan.document, plan.plan_markdown, plan.spec_markdown, approval.id AS approval_id, approval.operator_id, issues.identity
     FROM factory_plan_versions plan JOIN factory_plan_approvals approval ON approval.feature_id = plan.feature_id AND approval.plan_version = plan.version
     JOIN factory_feature_publications issues ON issues.feature_id = plan.feature_id AND issues.state = 'published'
     WHERE plan.feature_id = $1 AND plan.version = $2`,
      [feature.id, publication.plan_version],
    )
  ).rows[0];
  if (approved === undefined || feature.approved_plan_version !== publication.plan_version)
    throw new FactoryFeaturePublicationError("certificate_stale");
  const plan = FeaturePlanDocumentSchema.parse(approved.document);
  const identity = FactoryFeaturePublicationIdentitySchema.safeParse(approved.identity);
  if (!identity.success) throw new FactoryFeaturePublicationError("repository_changed");
  const stored = (
    await client.query<{
      feature_id: string;
      project_id: string;
      repository_id: string;
      source_identity: string;
      base_commit_id: string;
      head_commit_id: string;
      tree_id: string;
      branch: string;
      object_format: "sha1" | "sha256";
    }>("SELECT * FROM factory_feature_workspaces WHERE feature_id = $1", [feature.id])
  ).rows[0];
  if (stored === undefined) throw new FactoryFeaturePublicationError("source_changed");
  const workspace: FactoryFeatureWorkspace = {
    featureId: feature.id,
    projectId: stored.project_id,
    repositoryId: stored.repository_id,
    sourceIdentity: stored.source_identity,
    baseCommitId: stored.base_commit_id,
    headCommitId: stored.head_commit_id,
    treeId: stored.tree_id,
    branch: stored.branch,
    objectFormat: stored.object_format,
  };
  const revision = {
    baseCommitId: workspace.baseCommitId,
    headCommitId: workspace.headCommitId,
    treeId: workspace.treeId,
    branch: workspace.branch,
  };
  const certificate = await retainedCertificate(client, publication.certificate_id);
  assertFactoryFeaturePublicationCertificate({
    featureId: feature.id,
    version: publication.plan_version,
    plan,
    source: { repositoryId: workspace.repositoryId, identity: workspace.sourceIdentity },
    revision,
    certificate,
  });
  const attached = await client.query(
    `SELECT source.id FROM local_repository_sources source JOIN projects project ON project.id = source.project_id
     WHERE COALESCE(project.canonical_project_id, project.id) = $1 AND source.repository_id = $2 AND source.source_identity = $3 AND source.attachment_state = 'attached'`,
    [feature.project_id, workspace.repositoryId, workspace.sourceIdentity],
  );
  const writers = await client.query(
    "SELECT id FROM factory_execution_runs WHERE feature_id = $1 AND reservation_released_at IS NULL",
    [feature.id],
  );
  const finalRun = await client.query(
    `SELECT id FROM factory_execution_runs WHERE id = $1 AND feature_id = $2 AND plan_version = $3 AND purpose = 'feature_verification'
     AND state = 'verified' AND reservation_released_at IS NOT NULL AND source = $4::jsonb AND revision = $5::jsonb AND verification_manifest = $6::jsonb
     AND NOT EXISTS (SELECT 1 FROM factory_execution_containers container WHERE container.run_id = factory_execution_runs.id AND container.stopped_at IS NULL)`,
    [
      certificate.runId,
      feature.id,
      publication.plan_version,
      JSON.stringify(certificate.source),
      JSON.stringify(certificate.revision),
      JSON.stringify(certificate.manifest),
    ],
  );
  if (
    attached.rowCount !== 1 ||
    writers.rowCount !== 0 ||
    finalRun.rowCount !== 1 ||
    !(await factoryWorkItemsVerified(
      client,
      feature.id,
      publication.plan_version,
      plan,
      certificate.source,
      certificate.revision,
    ))
  )
    throw new FactoryFeaturePublicationError("certificate_stale");
  const evidence = (
    await client.query<{ id: string; result: unknown }>(
      `SELECT evidence.id, evidence.result FROM unnest($2::uuid[]) WITH ORDINALITY expected(id, position)
     JOIN factory_verification_results evidence ON evidence.id = expected.id AND evidence.run_id = $1 ORDER BY expected.position`,
      [certificate.runId, certificate.evidenceIds],
    )
  ).rows;
  let round: number | undefined;
  if (
    evidence.length !== certificate.manifest.length ||
    !evidence.every((row, index) => {
      const check = FactoryVerificationResultSchema.omit({ id: true, createdAt: true }).parse(
        row.result,
      );
      round ??= check.round;
      return (
        row.id === certificate.evidenceIds[index] &&
        check.round === round &&
        check.position === index + 1 &&
        check.outcome === "passed" &&
        check.exitCode === 0 &&
        check.headCommitId === revision.headCommitId &&
        check.treeId === revision.treeId &&
        JSON.stringify(check.command) === JSON.stringify(certificate.manifest[index]?.command)
      );
    })
  )
    throw new FactoryFeaturePublicationError("certificate_stale");
  const issues = await issueInputs(client, feature.id, publication.plan_version, plan);
  if (issues.some((item) => item.issue.repository.id !== identity.data.repository.id))
    throw new FactoryFeaturePublicationError("issue_identity_missing");
  return {
    plan,
    identity: identity.data,
    issues,
    workspace,
    certificate,
    approvalId: approved.approval_id,
    operatorId: approved.operator_id,
    planMarkdown: approved.plan_markdown,
    specMarkdown: approved.spec_markdown,
  };
}

async function withAttempt<T>(
  pool: DatabasePool,
  claim: FactoryFeaturePublicationClaimIdentity,
  action: (client: PoolClient, feature: FeatureRow, row: PublicationRow) => Promise<T>,
) {
  return withFactoryFeature(pool, claim.projectId, claim.featureId, async (client, feature) => {
    const row = (
      await client.query<PublicationRow>(
        "SELECT * FROM factory_feature_pr_publications WHERE feature_id = $1 AND state = 'running' AND attempt_id = $2 FOR UPDATE",
        [claim.featureId, claim.attemptId],
      )
    ).rows[0];
    if (row === undefined)
      throw new FactoryError("conflict", "The publication attempt is no longer current");
    return action(client, feature, row);
  });
}
export function markFactoryFeaturePublicationWrite(
  pool: DatabasePool,
  claim: FactoryFeaturePublicationClaimIdentity,
  kind: "push" | "pr",
  attempted: boolean,
) {
  return withAttempt(pool, claim, async (client, feature, row) => {
    if (attempted) {
      if (
        feature.state !== "in_review" ||
        feature.approved_plan_version !== row.plan_version ||
        (kind === "push" ? row.push_attempted : row.pr_attempted) ||
        (kind === "pr" && row.push_confirmed_at === null)
      )
        throw new FactoryError("conflict", "This provider write is no longer authorized");
      const prepared = await client.query(
        "SELECT id FROM factory_feature_pr_operations WHERE feature_id = $1",
        [claim.featureId],
      );
      if (prepared.rows.length !== 1)
        throw new FactoryError("conflict", "Persist the exact operation before writing");
      await publicationInputs(client, feature, row);
    }
    const column = kind === "push" ? "push_attempted" : "pr_attempted";
    await client.query(
      `UPDATE factory_feature_pr_publications SET ${column} = $2, updated_at = clock_timestamp() WHERE feature_id = $1`,
      [claim.featureId, attempted],
    );
  });
}

export function prepareFactoryFeaturePublicationOperation(
  pool: DatabasePool,
  claim: ClaimedFactoryFeaturePublication,
  input: FactoryFeaturePublicationOperation,
) {
  const operation = FactoryFeaturePublicationOperationSchema.parse(input);
  return withAttempt(pool, claim, async (client, feature, row) => {
    if (feature.state !== "in_review") throw new FactoryError("conflict");
    const current = await publicationInputs(client, feature, row);
    if (
      operation.featureId !== feature.id ||
      operation.target.certificateId !== current.certificate.id ||
      operation.target.approvalId !== current.approvalId ||
      operation.target.approvedVersion !== row.plan_version ||
      JSON.stringify(operation.target.identity) !== JSON.stringify(current.identity) ||
      JSON.stringify(operation.target.source) !== JSON.stringify(current.certificate.source) ||
      JSON.stringify(operation.target.revision) !== JSON.stringify(current.certificate.revision) ||
      JSON.stringify(operation.issues) !== JSON.stringify(current.issues)
    )
      throw new FactoryError(
        "conflict",
        "The operation must match the approved certificate and issue identities",
      );
    await client.query(
      `INSERT INTO factory_feature_pr_operations (feature_id,id,target,issues,payload)
      VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) ON CONFLICT (feature_id) DO NOTHING`,
      [
        feature.id,
        operation.id,
        JSON.stringify(operation.target),
        JSON.stringify(operation.issues),
        JSON.stringify(operation.payload),
      ],
    );
    const retained = await operationFor(client, feature.id);
    if (retained === null) throw new FactoryError("conflict");
    return retained;
  });
}
export function confirmFactoryFeaturePublicationPush(
  pool: DatabasePool,
  claim: FactoryFeaturePublicationClaimIdentity,
) {
  return withAttempt(pool, claim, async (client) => {
    if ((await operationFor(client, claim.featureId)) === null) throw new FactoryError("conflict");
    await client.query(
      "UPDATE factory_feature_pr_publications SET push_confirmed_at = COALESCE(push_confirmed_at, clock_timestamp()), updated_at = clock_timestamp() WHERE feature_id = $1",
      [claim.featureId],
    );
  });
}
export function bindFactoryFeaturePullRequest(
  pool: DatabasePool,
  claim: FactoryFeaturePublicationClaimIdentity,
  input: FactoryFeaturePullRequest,
) {
  const pull = FactoryFeaturePullRequestSchema.parse(input);
  return withAttempt(pool, claim, async (client, _feature, row) => {
    const operation = await operationFor(client, claim.featureId);
    if (
      operation === null ||
      row.push_confirmed_at === null ||
      Object.entries(operation.payload).some(
        ([key, value]) => pull[key as keyof typeof operation.payload] !== value,
      ) ||
      JSON.stringify(pull.repository) !== JSON.stringify(operation.target.identity.repository) ||
      pull.author.toLowerCase() !== operation.target.identity.account.toLowerCase()
    )
      throw new FactoryError("conflict", "The pull request must match the persisted operation");
    await client.query(
      "INSERT INTO factory_feature_pr_results (feature_id,pull_request) VALUES ($1,$2::jsonb) ON CONFLICT (feature_id) DO NOTHING",
      [claim.featureId, JSON.stringify(pull)],
    );
    const retained = await pullRequestFor(client, claim.featureId);
    if (JSON.stringify(retained) !== JSON.stringify(pull)) throw new FactoryError("conflict");
  });
}

async function reviewFor(
  client: PoolClient,
  featureId: string,
): Promise<FactoryFeaturePublicationReview | null> {
  const row = (
    await client.query<{
      binding_project_id: string;
      binding_change_proposal_id: string;
      id: string;
      revision_state: string;
      object_format: string;
      base_object_id: string;
      base_ref_snapshot: string;
      head_object_id: string;
      head_ref_snapshot: string;
      object_count: string;
      retained_bytes: string;
      failure_reason: string | null;
      created_at: Date;
      available_at: Date | null;
      manifest_digest: string;
    }>(
      `SELECT binding.project_id AS binding_project_id, binding.change_proposal_id AS binding_change_proposal_id, revision.* FROM factory_feature_pr_revisions binding
     JOIN review_revisions revision ON revision.id = binding.review_revision_id WHERE binding.feature_id = $1`,
      [featureId],
    )
  ).rows[0];
  return row === undefined
    ? null
    : FactoryFeaturePublicationReviewSchema.parse({
        projectId: row.binding_project_id,
        changeProposalId: row.binding_change_proposal_id,
        manifestDigest: row.manifest_digest,
        revision: {
          id: row.id,
          state: row.revision_state,
          objectFormat: row.object_format,
          base: { objectId: row.base_object_id, ref: row.base_ref_snapshot },
          head: { objectId: row.head_object_id, ref: row.head_ref_snapshot },
          objectCount: Number(row.object_count),
          retainedBytes: Number(row.retained_bytes),
          failureReason: row.failure_reason,
          createdAt: row.created_at.toISOString(),
          availableAt: row.available_at?.toISOString() ?? null,
        },
      });
}
export function bindFactoryFeaturePublicationRevision(
  pool: DatabasePool,
  claim: ClaimedFactoryFeaturePublication,
  input: FactoryFeaturePublicationReview,
) {
  const review = FactoryFeaturePublicationReviewSchema.parse(input);
  return withAttempt(pool, claim, async (client, feature) => {
    const pull = await pullRequestFor(client, claim.featureId);
    if (
      pull === null ||
      review.revision.state !== "available" ||
      review.revision.base.objectId !== pull.baseCommitId ||
      review.revision.head.objectId !== pull.headCommitId
    )
      throw new FactoryError("conflict");
    const exact = await client.query(
      `SELECT revision.id FROM review_revisions revision
      JOIN projects owner ON owner.id = revision.project_id JOIN change_proposals proposal ON proposal.id = revision.change_proposal_id
      JOIN change_proposals expected ON expected.id = $3 JOIN local_repository_sources source ON source.id = revision.local_repository_source_id
      WHERE revision.id = $1 AND COALESCE(owner.canonical_project_id, owner.id) = $2
        AND COALESCE(proposal.canonical_change_proposal_id, proposal.id) = COALESCE(expected.canonical_change_proposal_id, expected.id)
        AND revision.revision_state = 'available' AND revision.base_object_id = $4 AND revision.head_object_id = $5 AND revision.manifest_digest = $6
        AND source.repository_id = $7 AND source.source_identity = $8`,
      [
        review.revision.id,
        feature.project_id,
        review.changeProposalId,
        pull.baseCommitId,
        pull.headCommitId,
        review.manifestDigest,
        claim.certificate.source.repositoryId,
        claim.certificate.source.identity,
      ],
    );
    if (exact.rowCount !== 1 || review.projectId !== feature.project_id)
      throw new FactoryError("conflict");
    await client.query(
      "INSERT INTO factory_feature_pr_revisions (feature_id,project_id,change_proposal_id,review_revision_id) VALUES ($1,$2,$3,$4) ON CONFLICT (feature_id) DO NOTHING",
      [feature.id, review.projectId, review.changeProposalId, review.revision.id],
    );
    const retained = await reviewFor(client, feature.id);
    if (retained?.revision.id !== review.revision.id) throw new FactoryError("conflict");
    await client.query(
      "UPDATE factory_feature_pr_publications SET state = $2, failure = NULL, updated_at = clock_timestamp() WHERE feature_id = $1",
      [feature.id, feature.state === "cancelled" ? "cancelled" : "published"],
    );
  });
}
/** Available exact revisions may predate the Feature binding and already have overview facts. */
export async function readFactoryFeaturePublicationRevisionArtifact(
  pool: DatabasePool,
  claim: ClaimedFactoryFeaturePublication,
  revisionId: string,
) {
  const row = (
    await pool.query<{ artifact_locator: string; manifest_digest: string }>(
      `SELECT revision.artifact_locator, revision.manifest_digest FROM review_revisions revision
     JOIN projects project ON project.id = revision.project_id
     JOIN local_repository_sources source ON source.id = revision.local_repository_source_id
     WHERE revision.id = $1 AND revision.revision_state = 'available'
       AND COALESCE(project.canonical_project_id, project.id) = $2
       AND revision.base_object_id = $3 AND revision.head_object_id = $4
       AND source.repository_id = $5 AND source.source_identity = $6`,
      [
        revisionId,
        claim.projectId,
        claim.certificate.revision.baseCommitId,
        claim.certificate.revision.headCommitId,
        claim.certificate.source.repositoryId,
        claim.certificate.source.identity,
      ],
    )
  ).rows[0];
  if (
    row === undefined ||
    !row.artifact_locator.endsWith(`/revisions/${revisionId}`) ||
    !/^[a-f0-9]{64}$/u.test(row.manifest_digest)
  )
    throw new FactoryFeaturePublicationError("retention_unavailable");
  return { artifactLocator: row.artifact_locator, manifestDigest: row.manifest_digest };
}
export function failFactoryFeaturePublication(
  pool: DatabasePool,
  claim: FactoryFeaturePublicationClaimIdentity,
  failure: FactoryFeaturePublicationFailure,
  retryAt?: string,
) {
  FactoryFeaturePublicationFailureSchema.parse(failure);
  return withAttempt(pool, claim, async (client, feature, row) => {
    const pull = await pullRequestFor(client, feature.id);
    const uncertain =
      (row.push_attempted && row.push_confirmed_at === null) || (row.pr_attempted && pull === null);
    await client.query(
      "UPDATE factory_feature_pr_publications SET state = $2, failure = $3, retry_after = $4, updated_at = clock_timestamp() WHERE feature_id = $1",
      [
        feature.id,
        uncertain
          ? "uncertain"
          : feature.state === "cancelled" && pull === null
            ? "cancelled"
            : "blocked",
        failure,
        retryAt ?? null,
      ],
    );
  });
}
export async function isFactoryFeaturePublicationRunning(
  pool: DatabasePool,
  claim: ClaimedFactoryFeaturePublication,
) {
  const result = await pool.query(
    `SELECT 1 FROM factory_feature_pr_publications publication JOIN factory_features feature ON feature.id = publication.feature_id
    WHERE publication.feature_id = $1 AND publication.attempt_id = $2 AND publication.state = 'running'
      AND (feature.state = 'in_review' OR ($3 AND feature.state = 'cancelled'))`,
    [claim.featureId, claim.attemptId, claim.cancelled],
  );
  return result.rowCount === 1;
}

async function publicationView(client: PoolClient, feature: FeatureRow) {
  const row = await publicationRow(client, feature.id);
  const revision = await factoryWorkspaceRevision(client, feature.id);
  const certificate =
    row === undefined
      ? await readCurrentFactoryFeatureVerification(
          client,
          feature.id,
          feature.approved_plan_version,
          revision,
        )
      : await retainedCertificate(client, row.certificate_id);
  const operation = await operationFor(client, feature.id);
  const pullRequest = await pullRequestFor(client, feature.id);
  const review = await reviewFor(client, feature.id);
  const cancelled = feature.state === "cancelled";
  const uncertain =
    row !== undefined &&
    ((row.push_attempted && row.push_confirmed_at === null) ||
      (row.pr_attempted && pullRequest === null));
  const waitingForVerification =
    certificate === null && ["gated", "in_review"].includes(feature.state);
  const state =
    cancelled && !uncertain && (pullRequest === null || review !== null)
      ? "cancelled"
      : row?.state === "running"
        ? "publishing"
        : uncertain && row.state !== "queued"
          ? "uncertain"
          : row?.state === "queued" || (row === undefined && !waitingForVerification)
            ? "pending"
            : (row?.state ?? "blocked");
  return FactoryFeaturePublicationSchema.parse({
    schemaVersion: 1,
    featureId: feature.id,
    approvedVersion: row?.plan_version ?? feature.approved_plan_version,
    state,
    cancelled,
    failure: row?.failure ?? (waitingForVerification ? "verification_required" : null),
    canRetry:
      row !== undefined &&
      ["blocked", "uncertain"].includes(row.state) &&
      (!cancelled || uncertain || (pullRequest !== null && review === null)) &&
      (row.retry_after === null || row.retry_after.getTime() <= Date.now()),
    updatedAt: row?.updated_at.toISOString() ?? null,
    certificate,
    issues: operation?.issues ?? [],
    pullRequest,
    review,
  });
}
export function readFactoryFeaturePublication(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
) {
  return withFactoryFeature(pool, projectId, featureId, publicationView);
}
export function retryFactoryFeaturePublication(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  actorId: string,
  requestId: string,
) {
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    const duplicate = (
      await client.query<{ actor_id: string }>(
        "SELECT actor_id FROM factory_feature_pr_retry_requests WHERE feature_id = $1 AND request_id = $2",
        [featureId, requestId],
      )
    ).rows[0];
    if (duplicate !== undefined) {
      if (duplicate.actor_id !== actorId) throw new FactoryError("conflict");
      return publicationView(client, feature);
    }
    const current = await publicationView(client, feature);
    if (!current.canRetry) throw new FactoryError("conflict", "This publication cannot be retried");
    const retries = await client.query<{ count: string }>(
      "SELECT count(*) FROM factory_feature_pr_retry_requests WHERE feature_id = $1",
      [featureId],
    );
    if (Number(retries.rows[0]?.count) >= 200)
      throw new FactoryError("conflict", "Publication retry limit reached");
    await client.query(
      "INSERT INTO factory_feature_pr_retry_requests (feature_id,request_id,actor_id) VALUES ($1,$2,$3)",
      [featureId, requestId, actorId],
    );
    await client.query(
      "UPDATE factory_feature_pr_publications SET state = 'queued', job_id = $2, attempt_id = NULL, started_at = NULL, failure = NULL, updated_at = clock_timestamp() WHERE feature_id = $1",
      [featureId, randomUUID()],
    );
    return publicationView(client, feature);
  });
}

export async function claimFactoryFeaturePublication(
  pool: DatabasePool,
  featureId: string,
): Promise<ClaimedFactoryFeaturePublication | null> {
  const owner = (
    await pool.query<{ project_id: string }>(
      "SELECT project_id FROM factory_features WHERE id = $1",
      [featureId],
    )
  ).rows[0];
  if (owner === undefined) return null;
  return withFactoryFeature(pool, owner.project_id, featureId, async (client, feature) => {
    if (!["in_review", "cancelled"].includes(feature.state)) return null;
    const attemptId = randomUUID();
    const row = (
      await client.query<PublicationRow>(
        `UPDATE factory_feature_pr_publications SET state = 'running', attempt_id = $2, started_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE feature_id = $1 AND state = 'queued' AND (retry_after IS NULL OR retry_after <= clock_timestamp()) RETURNING *`,
        [featureId, attemptId],
      )
    ).rows[0];
    if (row === undefined) return null;
    try {
      const inputs = await publicationInputs(client, feature, row);
      const operation = await operationFor(client, featureId);
      if (
        operation !== null &&
        (JSON.stringify(operation.target.identity) !== JSON.stringify(inputs.identity) ||
          JSON.stringify(operation.issues) !== JSON.stringify(inputs.issues) ||
          operation.target.certificateId !== inputs.certificate.id)
      )
        throw new FactoryFeaturePublicationError("certificate_stale");
      return {
        ...inputs,
        featureId,
        projectId: feature.project_id,
        title: feature.title,
        version: row.plan_version,
        attemptId,
        cancelled: feature.state === "cancelled",
        operation,
        pullRequest: await pullRequestFor(client, featureId),
        pushAttempted: row.push_attempted,
        pushConfirmed: row.push_confirmed_at !== null,
        prAttempted: row.pr_attempted,
      };
    } catch (error) {
      if (!(error instanceof FactoryFeaturePublicationError)) throw error;
      await client.query(
        "UPDATE factory_feature_pr_publications SET state = 'blocked', failure = $2, updated_at = clock_timestamp() WHERE feature_id = $1",
        [featureId, error.code],
      );
      return null;
    }
  });
}

/** Certificate-backed outbox rows survive restart; attempted flags are never cleared by recovery. */
export async function reconcileFactoryFeaturePublications(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
) {
  const candidates = await pool.query<{
    feature_id: string;
    project_id: string;
  }>(`SELECT feature.id AS feature_id, feature.project_id FROM factory_features feature
    WHERE (feature.state = 'in_review' AND EXISTS (SELECT 1 FROM factory_feature_verifications certificate
      JOIN factory_feature_workspaces workspace ON workspace.feature_id = certificate.feature_id
      WHERE certificate.feature_id = feature.id AND certificate.plan_version = feature.approved_plan_version
        AND certificate.revision = jsonb_build_object('baseCommitId',workspace.base_commit_id,'headCommitId',workspace.head_commit_id,'treeId',workspace.tree_id,'branch',workspace.branch))
      AND NOT EXISTS (SELECT 1 FROM factory_feature_pr_publications publication WHERE publication.feature_id = feature.id))
    OR EXISTS (SELECT 1 FROM factory_feature_pr_publications publication WHERE publication.feature_id = feature.id
      AND ((publication.state = 'queued' AND (publication.retry_after IS NULL OR publication.retry_after <= clock_timestamp()))
        OR (publication.state = 'running' AND publication.started_at < clock_timestamp() - interval '190 seconds')))
    ORDER BY feature.created_at, feature.id LIMIT 200`);
  for (const candidate of candidates.rows)
    await withFactoryFeature(
      pool,
      candidate.project_id,
      candidate.feature_id,
      async (client, feature) => {
        let row = await publicationRow(client, feature.id);
        if (row === undefined) {
          if (feature.state !== "in_review") return;
          const revision = await factoryWorkspaceRevision(client, feature.id);
          const certificate = await readCurrentFactoryFeatureVerification(
            client,
            feature.id,
            feature.approved_plan_version,
            revision,
          );
          if (certificate === null) return;
          await client.query(
            "INSERT INTO factory_feature_pr_publications (feature_id,plan_version,certificate_id) VALUES ($1,$2,$3) ON CONFLICT (feature_id) DO NOTHING",
            [feature.id, certificate.approvedVersion, certificate.id],
          );
        }
        await client.query(
          `UPDATE factory_feature_pr_publications SET state = 'queued', attempt_id = NULL, job_id = $2, started_at = NULL, updated_at = clock_timestamp()
      WHERE feature_id = $1 AND state = 'running' AND started_at < clock_timestamp() - interval '190 seconds'`,
          [feature.id, randomUUID()],
        );
        row = await publicationRow(client, feature.id);
        if (
          row?.state !== "queued" ||
          (row.retry_after !== null && row.retry_after.getTime() > Date.now())
        )
          return;
        const ended = await client.query(
          "SELECT id FROM pgboss.job WHERE name = $1 AND id = $2 AND state IN ('failed','cancelled','completed')",
          [FACTORY_FEATURE_PUBLICATION_QUEUE, row.job_id],
        );
        if (ended.rows.length > 0) {
          const pull = await pullRequestFor(client, feature.id);
          const uncertain =
            (row.push_attempted && row.push_confirmed_at === null) ||
            (row.pr_attempted && pull === null);
          await client.query(
            "UPDATE factory_feature_pr_publications SET state = $2, failure = 'unavailable', updated_at = clock_timestamp() WHERE feature_id = $1",
            [feature.id, uncertain ? "uncertain" : "blocked"],
          );
          return;
        }
        await boss.send(
          FACTORY_FEATURE_PUBLICATION_QUEUE,
          { featureId: feature.id },
          { id: row.job_id, db: pgBossDatabase(client), retryLimit: 0, expireInSeconds: 180 },
        );
      },
    );
}
export function assertFactoryFeaturePublicationCertificate(input: {
  featureId: string;
  version: number;
  plan: FeaturePlanDocument;
  source: { repositoryId: string; identity: string };
  revision: FactoryExecutionRevision;
  certificate: unknown;
}): void {
  if (input.certificate === null) throw new FactoryFeaturePublicationError("verification_required");
  const parsed = FactoryFeatureVerificationSchema.safeParse(input.certificate);
  if (!parsed.success) throw new FactoryFeaturePublicationError("certificate_stale");
  const certificate = parsed.data;
  const manifest = factoryVerificationManifest(input.plan);
  if (
    certificate.featureId !== input.featureId ||
    certificate.approvedVersion !== input.version ||
    certificate.source.repositoryId !== input.source.repositoryId ||
    certificate.source.identity !== input.source.identity ||
    JSON.stringify(certificate.revision) !== JSON.stringify(input.revision) ||
    JSON.stringify(certificate.manifest) !== JSON.stringify(manifest) ||
    certificate.manifestDigest !==
      createHash("sha256").update(JSON.stringify(manifest)).digest("hex") ||
    certificate.evidenceIds.length !== manifest.length ||
    new Set(certificate.evidenceIds).size !== manifest.length
  )
    throw new FactoryFeaturePublicationError("certificate_stale");
}
