import { createHash } from "node:crypto";

import {
  FactoryConceptualReviewBasisSchema,
  FactoryConceptualReviewCheckCatalogSchema,
  FactoryConceptualReviewCheckSchema,
  FactoryConceptualReviewPreparationSchema,
  FactoryFeaturePullRequestPayloadSchema,
  FactoryFeaturePullRequestSchema,
  FactoryFeaturePublicationTargetSchema,
  FactoryFeatureVerificationSchema,
  FactoryVerificationResultSchema,
  FeaturePlanDocumentSchema,
  factoryVerificationManifest,
  type FactoryConceptualReviewBlocker,
  type FactoryConceptualReviewCheck,
  type FactoryConceptualReviewCheckCatalog,
  type FactoryConceptualReviewPreparation,
} from "@kestrel/contracts";
import type { ConceptualReviewSourceBinding } from "@kestrel/local-source";

import type { DatabasePool } from "./pool.js";

export type FactoryConceptualReviewPersistenceErrorCode =
  "not_found" | "not_ready" | "evidence_not_found" | "invalid_request";

export class FactoryConceptualReviewPersistenceError extends Error {
  constructor(public readonly code: FactoryConceptualReviewPersistenceErrorCode) {
    super(`Factory Conceptual Review persistence failed: ${code}`);
    this.name = "FactoryConceptualReviewPersistenceError";
  }
}

export interface FactoryConceptualReviewRuntimeReadiness {
  profile: {
    containerImage: string;
    containerUser: string;
    codexExecutable: string;
    codexExecutableDigest: string;
    codexVersion: string;
  } | null;
}

const RUNTIME_POLICY = {
  kind: "retained_source_review" as const,
  version: 1 as const,
  adapter: "codex_app_server" as const,
  adapterVersion: 1 as const,
  codexProtocol: "app_server_v2" as const,
  sourceAccess: "retained_read_only" as const,
  networkAccess: false as const,
  writeAccess: false as const,
};
const REVIEW_RESOURCES = {
  maximumAttempts: 3,
  timeoutSeconds: 900,
  maximumEvidenceItems: 400,
  maximumWorkspaceFiles: 20_000,
  maximumWorkspaceBytes: 256 * 1024 * 1024,
  maximumGraphNodes: 800,
  maximumOutputBytes: 128 * 1024,
  containerPidsLimit: 128,
  containerMemoryBytes: 1024 * 1024 * 1024,
  containerNanoCpus: 2_000_000_000,
  containerTmpfsBytes: 64 * 1024 * 1024,
} as const;

interface PreparationRow {
  feature_id: string;
  project_id: string;
  approved_plan_version: number | null;
  plan_version_id: string | null;
  plan_version: number | null;
  plan_document: unknown;
  plan_author: string | null;
  approval_id: string | null;
  approval_operator_id: string | null;
  approved_at: Date | null;
  publication_state: string | null;
  publication_plan_version: number | null;
  publication_certificate_id: string | null;
  certificate: unknown;
  operation_target: unknown;
  operation_payload: unknown;
  pull_request: unknown;
  binding_project_id: string | null;
  binding_change_proposal_id: string | null;
  revision_id: string | null;
  revision_project_id: string | null;
  revision_state: string | null;
  object_format: string | null;
  base_ref_snapshot: string | null;
  base_object_id: string | null;
  head_ref_snapshot: string | null;
  head_object_id: string | null;
  object_count: string | null;
  retained_bytes: string | null;
  artifact_locator: string | null;
  retained_manifest_digest: string | null;
  revision_created_at: Date | null;
  available_at: Date | null;
  canonical_revision_project_id: string | null;
  canonical_binding_project_id: string | null;
  canonical_binding_proposal_id: string | null;
  revision_change_proposal_id: string | null;
  canonical_revision_proposal_project_id: string | null;
  canonical_revision_proposal_id: string | null;
  revision_source_repository_id: string | null;
  revision_source_identity: string | null;
  selected_model_id: string | null;
}

interface EvidenceRow {
  id: string;
  run_id: string;
  result: unknown;
  created_at: Date;
}

const preparationQuery = `
  SELECT feature.id AS feature_id, feature.project_id, feature.approved_plan_version,
    plan.id AS plan_version_id, plan.version AS plan_version, plan.document AS plan_document,
    plan.author AS plan_author, approval.id AS approval_id,
    approval.operator_id AS approval_operator_id, approval.approved_at,
    publication.state AS publication_state, publication.plan_version AS publication_plan_version,
    publication.certificate_id AS publication_certificate_id,
    CASE WHEN certificate.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', certificate.id, 'featureId', certificate.feature_id,
      'approvedVersion', certificate.plan_version, 'runId', certificate.run_id,
      'source', certificate.source, 'revision', certificate.revision,
      'manifest', certificate.manifest, 'manifestDigest', certificate.manifest_digest,
      'evidenceIds', certificate.evidence_ids,
      'createdAt', to_char(certificate.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) END AS certificate,
    operation.target AS operation_target, operation.payload AS operation_payload,
    result.pull_request, binding.project_id AS binding_project_id,
    binding.change_proposal_id AS binding_change_proposal_id,
    revision.id AS revision_id, revision.project_id AS revision_project_id,
    revision.revision_state, revision.object_format, revision.base_ref_snapshot,
    revision.base_object_id, revision.head_ref_snapshot, revision.head_object_id,
    revision.object_count, revision.retained_bytes, revision.artifact_locator,
    revision.manifest_digest AS retained_manifest_digest,
    revision.created_at AS revision_created_at, revision.available_at,
    COALESCE(revision_project.canonical_project_id, revision_project.id) AS canonical_revision_project_id,
    COALESCE(binding_proposal_project.canonical_project_id, binding_proposal_project.id)
      AS canonical_binding_project_id,
    COALESCE(binding_proposal.canonical_change_proposal_id, binding_proposal.id)
      AS canonical_binding_proposal_id,
    revision.change_proposal_id AS revision_change_proposal_id,
    COALESCE(revision_proposal_project.canonical_project_id, revision_proposal_project.id)
      AS canonical_revision_proposal_project_id,
    COALESCE(revision_proposal.canonical_change_proposal_id, revision_proposal.id)
      AS canonical_revision_proposal_id,
    revision_source.repository_id AS revision_source_repository_id,
    revision_source.source_identity AS revision_source_identity,
    model.selected_model_id
  FROM factory_features AS feature
  LEFT JOIN factory_plan_versions AS plan
    ON plan.feature_id = feature.id AND plan.version = feature.approved_plan_version
  LEFT JOIN factory_plan_approvals AS approval
    ON approval.feature_id = plan.feature_id AND approval.plan_version = plan.version
  LEFT JOIN factory_feature_pr_publications AS publication ON publication.feature_id = feature.id
  LEFT JOIN factory_feature_verifications AS certificate
    ON certificate.id = publication.certificate_id
  LEFT JOIN factory_feature_pr_operations AS operation ON operation.feature_id = feature.id
  LEFT JOIN factory_feature_pr_results AS result ON result.feature_id = feature.id
  LEFT JOIN factory_feature_pr_revisions AS binding ON binding.feature_id = feature.id
  LEFT JOIN review_revisions AS revision ON revision.id = binding.review_revision_id
  LEFT JOIN projects AS revision_project ON revision_project.id = revision.project_id
  LEFT JOIN local_repository_sources AS revision_source
    ON revision_source.id = revision.local_repository_source_id
  LEFT JOIN change_proposals AS binding_proposal
    ON binding_proposal.id = binding.change_proposal_id
  LEFT JOIN projects AS binding_proposal_project
    ON binding_proposal_project.id = binding_proposal.project_id
  LEFT JOIN change_proposals AS revision_proposal
    ON revision_proposal.id = revision.change_proposal_id
  LEFT JOIN projects AS revision_proposal_project
    ON revision_proposal_project.id = revision_proposal.project_id
  LEFT JOIN LATERAL (
    SELECT preference.selected_model_id
    FROM installations AS installation
    LEFT JOIN codex_review_model_preferences AS preference
      ON preference.installation_id = installation.id
    ORDER BY installation.created_at, installation.id
    LIMIT 1
  ) AS model ON true
  WHERE feature.project_id = $1 AND feature.id = $2
`;

async function readRow(pool: DatabasePool, projectId: string, featureId: string) {
  const row = (await pool.query<PreparationRow>(preparationQuery, [projectId, featureId])).rows[0];
  if (row === undefined) throw new FactoryConceptualReviewPersistenceError("not_found");
  return row;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function planBasis(row: PreparationRow) {
  const plan = FeaturePlanDocumentSchema.safeParse(row.plan_document);
  const provenance = FactoryConceptualReviewBasisSchema.shape.provenance.safeParse({
    planVersionId: row.plan_version_id,
    version: row.plan_version,
    author: row.plan_author,
    approvalId: row.approval_id,
    approvedByOperatorId: row.approval_operator_id,
    approvedAt: row.approved_at?.toISOString(),
    planDigest: plan.success ? sha256(plan.data) : null,
  });
  if (!plan.success || !provenance.success) return null;
  return FactoryConceptualReviewBasisSchema.parse({
    objective: plan.data.objective,
    scope: plan.data.scope,
    outcomes: plan.data.acceptance.map((outcome) => ({
      ...outcome,
      intent: {
        kind: "approved_feature_plan" as const,
        label: `Approved Feature plan · version ${String(provenance.data.version)}`,
      },
    })),
    provenance: provenance.data,
  });
}

async function evidenceFor(
  pool: DatabasePool,
  certificate: ReturnType<typeof FactoryFeatureVerificationSchema.parse>,
): Promise<Array<FactoryConceptualReviewCheck>> {
  const rows = (
    await pool.query<EvidenceRow>(
      `SELECT evidence.id, evidence.run_id, evidence.result, evidence.created_at
       FROM unnest($2::uuid[]) WITH ORDINALITY expected(id, position)
       JOIN factory_verification_results AS evidence
         ON evidence.id = expected.id AND evidence.run_id = $1 AND evidence.purpose = 'feature_verification'
       ORDER BY expected.position`,
      [certificate.runId, certificate.evidenceIds],
    )
  ).rows;
  if (rows.length !== certificate.manifest.length) return [];
  let round: number | null = null;
  const checks: FactoryConceptualReviewCheck[] = [];
  for (const [index, row] of rows.entries()) {
    const stored = FactoryVerificationResultSchema.omit({ id: true, createdAt: true }).safeParse(
      row.result,
    );
    const expected = certificate.manifest[index];
    if (!stored.success || expected === undefined) return [];
    round ??= stored.data.round;
    if (
      row.id !== certificate.evidenceIds[index] ||
      row.run_id !== certificate.runId ||
      stored.data.round !== round ||
      stored.data.position !== index + 1 ||
      stored.data.outcome !== "passed" ||
      stored.data.exitCode !== 0 ||
      stored.data.headCommitId !== certificate.revision.headCommitId ||
      stored.data.treeId !== certificate.revision.treeId ||
      JSON.stringify(stored.data.command) !== JSON.stringify(expected.command)
    )
      return [];
    checks.push(
      FactoryConceptualReviewCheckSchema.parse({
        schemaVersion: 1,
        evidenceId: row.id,
        runId: row.run_id,
        manifestPosition: expected.position,
        origins: expected.origins,
        result: { ...stored.data, id: row.id, createdAt: row.created_at.toISOString() },
      }),
    );
  }
  return checks;
}

interface ExactReviewInputs {
  row: PreparationRow;
  basis: NonNullable<FactoryConceptualReviewPreparation["basis"]>;
  publication: NonNullable<FactoryConceptualReviewPreparation["publication"]>;
  evidence: NonNullable<FactoryConceptualReviewPreparation["evidence"]>;
  checks: FactoryConceptualReviewCheck[];
}

async function resolveExactReviewInputs(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
): Promise<{
  exact: ExactReviewInputs | null;
  row: PreparationRow;
  blocker: FactoryConceptualReviewBlocker;
}> {
  const row = await readRow(pool, projectId, featureId);
  const basis = planBasis(row);
  if (
    basis === null ||
    row.approved_plan_version === null ||
    row.plan_version !== row.approved_plan_version ||
    row.publication_plan_version !== row.approved_plan_version
  )
    return { exact: null, row, blocker: "approved_plan_mismatch" };
  if (
    row.publication_state !== "published" ||
    row.pull_request === null ||
    row.revision_id === null ||
    row.binding_change_proposal_id === null
  )
    return { exact: null, row, blocker: "publication_not_ready" };

  const certificate = FactoryFeatureVerificationSchema.safeParse(row.certificate);
  const plan = FeaturePlanDocumentSchema.safeParse(row.plan_document);
  const target = FactoryFeaturePublicationTargetSchema.safeParse(row.operation_target);
  const payload = FactoryFeaturePullRequestPayloadSchema.safeParse(row.operation_payload);
  const pullRequest = FactoryFeaturePullRequestSchema.safeParse(row.pull_request);
  if (
    !certificate.success ||
    !plan.success ||
    !target.success ||
    !payload.success ||
    !pullRequest.success ||
    certificate.data.id !== row.publication_certificate_id ||
    certificate.data.featureId !== featureId ||
    certificate.data.approvedVersion !== basis.provenance.version ||
    target.data.certificateId !== certificate.data.id ||
    target.data.approvalId !== basis.provenance.approvalId ||
    target.data.approvedVersion !== basis.provenance.version ||
    target.data.source.repositoryId !== certificate.data.source.repositoryId ||
    target.data.source.identity !== certificate.data.source.identity ||
    target.data.revision.branch !== certificate.data.revision.branch ||
    JSON.stringify(pullRequest.data.repository) !==
      JSON.stringify(target.data.identity.repository) ||
    pullRequest.data.author.toLowerCase() !== target.data.identity.account.toLowerCase() ||
    JSON.stringify(factoryVerificationManifest(plan.data)) !==
      JSON.stringify(certificate.data.manifest) ||
    sha256(certificate.data.manifest) !== certificate.data.manifestDigest ||
    JSON.stringify(payload.data) !==
      JSON.stringify({
        title: pullRequest.data.title,
        body: pullRequest.data.body,
        marker: pullRequest.data.marker,
        baseRef: pullRequest.data.baseRef,
        headRef: pullRequest.data.headRef,
        baseCommitId: pullRequest.data.baseCommitId,
        headCommitId: pullRequest.data.headCommitId,
      })
  )
    return { exact: null, row, blocker: "certificate_mismatch" };

  if (
    row.binding_project_id !== projectId ||
    row.canonical_revision_project_id !== projectId ||
    row.canonical_binding_project_id !== projectId ||
    row.canonical_revision_proposal_project_id !== projectId ||
    row.canonical_binding_proposal_id !== row.binding_change_proposal_id ||
    row.canonical_revision_proposal_id !== row.canonical_binding_proposal_id ||
    row.revision_source_repository_id !== certificate.data.source.repositoryId ||
    row.revision_source_identity !== certificate.data.source.identity ||
    row.revision_state !== "available" ||
    (row.object_format !== "sha1" && row.object_format !== "sha256") ||
    row.base_ref_snapshot === null ||
    row.base_object_id !== certificate.data.revision.baseCommitId ||
    row.head_ref_snapshot === null ||
    row.head_object_id !== certificate.data.revision.headCommitId ||
    pullRequest.data.baseCommitId !== certificate.data.revision.baseCommitId ||
    pullRequest.data.headCommitId !== certificate.data.revision.headCommitId ||
    target.data.revision.baseCommitId !== certificate.data.revision.baseCommitId ||
    target.data.revision.headCommitId !== certificate.data.revision.headCommitId ||
    target.data.revision.treeId !== certificate.data.revision.treeId ||
    row.object_count === null ||
    row.retained_bytes === null ||
    row.artifact_locator === null ||
    !row.artifact_locator.endsWith(`/revisions/${row.revision_id}`) ||
    row.retained_manifest_digest === null ||
    row.revision_created_at === null ||
    row.available_at === null
  )
    return { exact: null, row, blocker: "exact_revision_mismatch" };

  const checks = await evidenceFor(pool, certificate.data);
  if (checks.length !== certificate.data.evidenceIds.length)
    return { exact: null, row, blocker: "certificate_mismatch" };
  const objectFormat: "sha1" | "sha256" = row.object_format;
  const revision = {
    id: row.revision_id,
    state: "available" as const,
    objectFormat,
    base: { objectId: row.base_object_id, ref: row.base_ref_snapshot },
    head: { objectId: row.head_object_id, ref: row.head_ref_snapshot },
    objectCount: Number(row.object_count),
    retainedBytes: Number(row.retained_bytes),
    failureReason: null,
    createdAt: row.revision_created_at.toISOString(),
    availableAt: row.available_at.toISOString(),
  };
  const publication = {
    pullRequest: pullRequest.data,
    revision,
    retainedManifestDigest: row.retained_manifest_digest,
    certificate: certificate.data,
  };
  const evidence = {
    source: {
      baseCommitId: certificate.data.revision.baseCommitId,
      headCommitId: certificate.data.revision.headCommitId,
      retainedManifestDigest: row.retained_manifest_digest,
      limits: {
        catalogPageEntries: 200 as const,
        fileBytes: 524_288 as const,
        lineRange: 200 as const,
        responseBytes: 32_768 as const,
      },
    },
    checks: {
      runId: certificate.data.runId,
      manifestDigest: certificate.data.manifestDigest,
      total: certificate.data.evidenceIds.length,
      limits: { catalogPageEntries: 100 as const, outputBytesPerStream: 8192 as const },
    },
  };
  return {
    exact: { row, basis, publication, evidence, checks },
    row,
    blocker: "publication_not_ready",
  };
}

export async function readFactoryConceptualReviewPreparation(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  readiness: FactoryConceptualReviewRuntimeReadiness,
): Promise<FactoryConceptualReviewPreparation> {
  const resolved = await resolveExactReviewInputs(pool, projectId, featureId);
  const blockers: FactoryConceptualReviewBlocker[] = [];
  if (resolved.exact === null) blockers.push(resolved.blocker);
  if (resolved.row.selected_model_id === null) blockers.push("model_not_selected");
  if (readiness.profile === null) blockers.push("review_runtime_unavailable");
  const configuration = {
    model: { route: "codex_subscription" as const, modelId: resolved.row.selected_model_id },
    runtimePolicy: {
      ...RUNTIME_POLICY,
      containerImage: readiness.profile?.containerImage ?? null,
      containerUser: readiness.profile?.containerUser ?? null,
      codexExecutable: readiness.profile?.codexExecutable ?? null,
      codexExecutableDigest: readiness.profile?.codexExecutableDigest ?? null,
      codexVersion: readiness.profile?.codexVersion ?? null,
      status: readiness.profile === null ? ("unavailable" as const) : ("available" as const),
    },
    resources: REVIEW_RESOURCES,
  };
  const exact = resolved.exact;
  const digest =
    exact === null || configuration.model.modelId === null
      ? null
      : sha256({
          schemaVersion: 1,
          projectId,
          featureId,
          changeProposalId: exact.row.binding_change_proposal_id,
          basis: exact.basis,
          publication: exact.publication,
          evidence: exact.evidence,
          configuration,
        });
  return FactoryConceptualReviewPreparationSchema.parse({
    schemaVersion: 1,
    projectId,
    featureId,
    changeProposalId: exact?.row.binding_change_proposal_id ?? null,
    preparationDigest: digest,
    basis: exact?.basis ?? planBasis(resolved.row),
    publication: exact?.publication ?? null,
    evidence: exact?.evidence ?? null,
    configuration,
    readiness: {
      state: blockers.length === 0 ? "ready" : "blocked",
      startAllowed: blockers.length === 0,
      blockers,
    },
  });
}

async function requireExact(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
): Promise<ExactReviewInputs> {
  const resolved = await resolveExactReviewInputs(pool, projectId, featureId);
  if (resolved.exact === null) throw new FactoryConceptualReviewPersistenceError("not_ready");
  return resolved.exact;
}

export async function readFactoryConceptualReviewSourceBinding(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  side: "base" | "head",
): Promise<ConceptualReviewSourceBinding> {
  const exact = await requireExact(pool, projectId, featureId);
  const { row, publication } = exact;
  if (row.artifact_locator === null) throw new FactoryConceptualReviewPersistenceError("not_ready");
  return {
    artifactLocator: row.artifact_locator,
    manifestDigest: publication.retainedManifestDigest,
    expectedBaseCommitId: publication.revision.base.objectId,
    expectedHeadCommitId: publication.revision.head.objectId,
    expectedHeadTreeId: publication.certificate.revision.treeId,
    side,
  };
}

export async function readFactoryConceptualReviewChecks(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  offset = 0,
  limit = 100,
): Promise<FactoryConceptualReviewCheckCatalog> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new FactoryConceptualReviewPersistenceError("invalid_request");
  const exact = await requireExact(pool, projectId, featureId);
  const page = exact.checks.slice(offset, offset + limit);
  return FactoryConceptualReviewCheckCatalogSchema.parse({
    schemaVersion: 1,
    runId: exact.publication.certificate.runId,
    manifestDigest: exact.publication.certificate.manifestDigest,
    checks: page.map((check) => ({
      evidenceId: check.evidenceId,
      runId: check.runId,
      manifestPosition: check.manifestPosition,
      origins: check.origins,
      command: check.result.command,
      headCommitId: check.result.headCommitId,
      treeId: check.result.treeId,
      outcome: check.result.outcome,
      exitCode: check.result.exitCode,
      stdoutTruncated: check.result.stdoutTruncated,
      stderrTruncated: check.result.stderrTruncated,
      durationMs: check.result.durationMs,
      createdAt: check.result.createdAt,
    })),
    offset,
    total: exact.checks.length,
    nextOffset: offset + page.length < exact.checks.length ? offset + page.length : null,
  });
}

export async function readFactoryConceptualReviewCheck(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  evidenceId: string,
): Promise<FactoryConceptualReviewCheck> {
  const exact = await requireExact(pool, projectId, featureId);
  const check = exact.checks.find((candidate) => candidate.evidenceId === evidenceId);
  if (check === undefined) throw new FactoryConceptualReviewPersistenceError("evidence_not_found");
  return FactoryConceptualReviewCheckSchema.parse(check);
}

async function readFrozenWorkflowPreparation(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  workflowId: string,
): Promise<FactoryConceptualReviewPreparation> {
  const selected = await pool.query<{ factory_input: unknown }>(
    `SELECT workflow.factory_input
     FROM review_workflows AS workflow
     WHERE workflow.project_id = $1 AND workflow.feature_id = $2 AND workflow.id = $3`,
    [projectId, featureId, workflowId],
  );
  const row = selected.rows[0];
  if (row === undefined) throw new FactoryConceptualReviewPersistenceError("not_found");
  const preparation = FactoryConceptualReviewPreparationSchema.parse(row.factory_input);
  const publication = preparation.publication;
  const evidence = preparation.evidence;
  if (
    preparation.projectId !== projectId ||
    preparation.featureId !== featureId ||
    preparation.changeProposalId === null ||
    preparation.preparationDigest === null ||
    preparation.basis === null ||
    publication === null ||
    evidence === null ||
    publication.certificate.featureId !== featureId ||
    evidence.checks.runId !== publication.certificate.runId ||
    evidence.checks.manifestDigest !== publication.certificate.manifestDigest ||
    evidence.checks.total !== publication.certificate.evidenceIds.length ||
    sha256(publication.certificate.manifest) !== publication.certificate.manifestDigest
  )
    throw new FactoryConceptualReviewPersistenceError("not_ready");
  return preparation;
}

function frozenCheck(
  certificate: ReturnType<typeof FactoryFeatureVerificationSchema.parse>,
  index: number,
  row: EvidenceRow,
): FactoryConceptualReviewCheck | null {
  const expected = certificate.manifest[index];
  const stored = FactoryVerificationResultSchema.omit({ id: true, createdAt: true }).safeParse(
    row.result,
  );
  if (
    expected === undefined ||
    !stored.success ||
    row.id !== certificate.evidenceIds[index] ||
    row.run_id !== certificate.runId ||
    stored.data.position !== index + 1 ||
    expected.position !== index + 1 ||
    stored.data.outcome !== "passed" ||
    stored.data.exitCode !== 0 ||
    stored.data.headCommitId !== certificate.revision.headCommitId ||
    stored.data.treeId !== certificate.revision.treeId ||
    JSON.stringify(stored.data.command) !== JSON.stringify(expected.command)
  )
    return null;
  return FactoryConceptualReviewCheckSchema.parse({
    schemaVersion: 1,
    evidenceId: row.id,
    runId: row.run_id,
    manifestPosition: expected.position,
    origins: expected.origins,
    result: { ...stored.data, id: row.id, createdAt: row.created_at.toISOString() },
  });
}

async function readFrozenWorkflowCheckRange(
  pool: DatabasePool,
  preparation: FactoryConceptualReviewPreparation,
  offset: number,
  limit: number,
): Promise<FactoryConceptualReviewCheck[]> {
  const certificate = preparation.publication?.certificate;
  if (certificate === undefined)
    throw new FactoryConceptualReviewPersistenceError("evidence_not_found");
  const evidenceIds = certificate.evidenceIds.slice(offset, offset + limit);
  if (evidenceIds.length === 0) return [];
  const rows = (
    await pool.query<EvidenceRow>(
      `SELECT evidence.id, evidence.run_id, evidence.result, evidence.created_at
       FROM unnest($2::uuid[]) WITH ORDINALITY expected(id, position)
       JOIN factory_verification_results AS evidence
         ON evidence.id = expected.id AND evidence.run_id = $1 AND evidence.purpose = 'feature_verification'
       ORDER BY expected.position`,
      [certificate.runId, evidenceIds],
    )
  ).rows;
  if (rows.length !== evidenceIds.length)
    throw new FactoryConceptualReviewPersistenceError("evidence_not_found");
  const checks = rows.map((row, index) => frozenCheck(certificate, offset + index, row));
  if (checks.some((check) => check === null))
    throw new FactoryConceptualReviewPersistenceError("evidence_not_found");
  return checks as FactoryConceptualReviewCheck[];
}

export async function readFactoryConceptualReviewWorkflowChecks(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  workflowId: string,
  offset = 0,
  limit = 100,
): Promise<FactoryConceptualReviewCheckCatalog> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new FactoryConceptualReviewPersistenceError("invalid_request");
  const preparation = await readFrozenWorkflowPreparation(pool, projectId, featureId, workflowId);
  const certificate = preparation.publication?.certificate;
  if (certificate === undefined)
    throw new FactoryConceptualReviewPersistenceError("evidence_not_found");
  const page = await readFrozenWorkflowCheckRange(pool, preparation, offset, limit);
  return FactoryConceptualReviewCheckCatalogSchema.parse({
    schemaVersion: 1,
    runId: certificate.runId,
    manifestDigest: certificate.manifestDigest,
    checks: page.map((check) => ({
      evidenceId: check.evidenceId,
      runId: check.runId,
      manifestPosition: check.manifestPosition,
      origins: check.origins,
      command: check.result.command,
      headCommitId: check.result.headCommitId,
      treeId: check.result.treeId,
      outcome: check.result.outcome,
      exitCode: check.result.exitCode,
      stdoutTruncated: check.result.stdoutTruncated,
      stderrTruncated: check.result.stderrTruncated,
      durationMs: check.result.durationMs,
      createdAt: check.result.createdAt,
    })),
    offset,
    total: certificate.evidenceIds.length,
    nextOffset: offset + page.length < certificate.evidenceIds.length ? offset + page.length : null,
  });
}

export async function readFactoryConceptualReviewWorkflowCheck(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  workflowId: string,
  evidenceId: string,
): Promise<FactoryConceptualReviewCheck> {
  const preparation = await readFrozenWorkflowPreparation(pool, projectId, featureId, workflowId);
  const certificate = preparation.publication?.certificate;
  if (certificate === undefined)
    throw new FactoryConceptualReviewPersistenceError("evidence_not_found");
  const index = certificate.evidenceIds.indexOf(evidenceId);
  if (index < 0) throw new FactoryConceptualReviewPersistenceError("evidence_not_found");
  const check = (await readFrozenWorkflowCheckRange(pool, preparation, index, 1))[0];
  if (check === undefined) throw new FactoryConceptualReviewPersistenceError("evidence_not_found");
  return FactoryConceptualReviewCheckSchema.parse(check);
}
