import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import {
  ChangeOverviewSourceFactsSchema,
  ChangeIntentSchema,
  ChangeIntentSourceSchema,
  ProjectUpsertedSchema,
  type ChangeIntent,
  type ChangeOverviewSourceFacts,
  type ProjectUpserted,
  type ReviewRevision,
} from "@kestrel/contracts";

import { appendAuditRecordInTransaction } from "./audit.js";
import {
  enqueueChangeOverviewRendering,
  type ChangeOverviewRenderingJobCoordinator,
} from "./change-overview-renderings.js";
import type { DatabasePool } from "./pool.js";
import { lockGitHubRepositoryIdentity } from "./provider-identity.js";
import { readProjectInTransaction } from "./projects.js";

type ReviewRevisionFailureReason = NonNullable<ReviewRevision["failureReason"]>;

export interface LocalRepositorySourceObservation {
  displayName: string;
  githubRepository: { name: string; owner: string } | null;
  objectFormat: "sha1" | "sha256";
  relativePath: string;
  repositoryId: string;
  rootId: string;
  sourceIdentity: string;
}

export interface BeginReviewRevisionInput {
  actorId: string;
  base: { objectId: string; ref: string };
  changeIntent: string;
  changeProposalId?: string;
  correlationId: string;
  expectedProjectId?: string;
  head: { objectId: string; ref: string };
  maxBytes: number;
  maxObjects: number;
  source: LocalRepositorySourceObservation;
}

export interface OpenLocalProjectInput {
  actorId: string;
  correlationId: string;
  source: LocalRepositorySourceObservation;
}

export interface BeginReviewRevisionResult {
  artifactProjectId: string;
  changeIntent: ChangeIntent;
  changeProposalId: string;
  localRepositorySourceId: string;
  maxBytes: number;
  maxObjects: number;
  outcome: "acquire" | "acquiring" | "already_available";
  projectId: string;
  revision: ReviewRevision;
}

export interface RetainedArtifactObservation {
  artifactLocator: string;
  baseCommitAuthor: string | null;
  baseCommitSubject: string | null;
  changeOverviewFacts: ChangeOverviewSourceFacts;
  headCommitAuthor: string | null;
  headCommitSubject: string | null;
  manifestDigest: string;
  objectCount: number;
  retainedBytes: number;
}

export interface CompleteReviewRevisionInput {
  actorId: string;
  artifact: RetainedArtifactObservation;
  base: { objectId: string; ref: string };
  correlationId: string;
  enqueueModelRendering: boolean;
  head: { objectId: string; ref: string };
  objectFormat: "sha1" | "sha256";
  projectId: string;
  revisionId: string;
}

export interface ChangeOverviewBackfillReference {
  artifactLocator: string;
  manifestDigest: string;
}

export interface BackfillChangeOverviewFactsInput extends ChangeOverviewBackfillReference {
  actorId: string;
  changeOverviewFacts: ChangeOverviewSourceFacts;
  correlationId: string;
  revisionId: string;
}

export interface FailReviewRevisionInput {
  actorId: string;
  correlationId: string;
  failureReason: ReviewRevisionFailureReason;
  revisionId: string;
}

export interface LocalSourceAttachmentObservation {
  repositoryId: string;
  sourceIdentity: string;
}

export type ReviewRevisionPersistenceErrorCode =
  | "change_proposal_mismatch"
  | "installation_not_available"
  | "revision_limit_exceeded"
  | "revision_state_conflict";

export class ReviewRevisionPersistenceError extends Error {
  constructor(public readonly code: ReviewRevisionPersistenceErrorCode) {
    super(`Review Revision persistence failed: ${code}`);
    this.name = "ReviewRevisionPersistenceError";
  }
}

interface SourceRow {
  attachment_state: "attached" | "detached";
  id: string;
  object_format: "sha1" | "sha256";
  project_id: string;
}

interface RepositoryProjectRow {
  canonical_project_id: string | null;
  id: string;
  provider: string | null;
  provider_observation_kind: string | null;
  provider_repository_id: string | null;
  repository_canonical_url_snapshot: string | null;
  repository_name_snapshot: string | null;
  repository_owner_snapshot: string | null;
}

interface ProviderProposalAliasRow {
  author_login_snapshot: string | null;
  author_provider_id: string | null;
  base_object_id: string;
  base_ref_snapshot: string;
  canonical_change_proposal_id: string | null;
  canonical_url_snapshot: string | null;
  head_object_id: string;
  head_ref_snapshot: string;
  id: string;
  observed_at: Date | null;
  proposal_kind: string;
  proposal_state: "closed" | "merged" | "open" | "unknown" | null;
  provider_number: string | null;
  provider_proposal_id: string | null;
  title_snapshot: string;
}

interface IntentRow {
  acceptance_outcomes: unknown;
  change_proposal_id?: string;
  created_at: Date;
  id: string;
  intent_text: string;
  objective: string | null;
  resolution_issues: unknown;
  resolution_state: "resolved" | "unresolved";
  scope_boundaries: unknown;
  selected_sources: unknown;
  source_digest: string;
  max_version?: string;
  version: string;
}

interface RevisionRow {
  available_at?: Date | null;
  created_at: Date;
  failure_reason?: ReviewRevisionFailureReason | null;
  id: string;
  manifest_digest?: string | null;
  object_count?: string | null;
  retained_bytes?: string | null;
  revision_state: "acquiring" | "available" | "unavailable";
  updated_at?: Date;
}

interface ExactRevisionRow extends RevisionRow {
  acquisition_change_intent_id: string;
  base_object_id: string;
  base_ref_snapshot: string;
  change_proposal_id: string;
  head_object_id: string;
  head_ref_snapshot: string;
  max_bytes: string;
  max_objects: string;
  object_format: "sha1" | "sha256";
  project_id: string;
}

const MAX_PROJECTS_PER_INSTALLATION = 100;
const MAX_PROPOSALS_PER_PROJECT = 100;

function isCapacityConstraint(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("constraint" in error)) return false;
  return (
    error.constraint === "projects_installation_capacity" ||
    error.constraint === "change_proposals_project_capacity"
  );
}

function mapIntent(row: IntentRow): ChangeIntent {
  return ChangeIntentSchema.parse({
    acceptanceOutcomes: row.acceptance_outcomes,
    createdAt: row.created_at.toISOString(),
    id: row.id,
    objective: row.objective,
    resolution: { state: row.resolution_state, issues: row.resolution_issues },
    scopeBoundaries: row.scope_boundaries,
    sourceDigest: row.source_digest,
    sources: row.selected_sources,
    text: row.intent_text,
    version: Number(row.version),
  });
}

function acquisitionIntentFields(intentText: string, version: number) {
  const sources = [
    ChangeIntentSourceSchema.parse({
      id: "operator_input",
      kind: "operator_input",
      label: "Operator input",
      text: intentText,
      version: String(version),
      provenance: { kind: "operator_input" },
    }),
  ];
  const resolution = {
    state: "unresolved" as const,
    issues: [
      { kind: "missing" as const, field: "scope_boundaries" as const },
      { kind: "missing" as const, field: "acceptance_outcomes" as const },
    ],
  };
  return {
    acceptanceOutcomes: [] as string[],
    objective: intentText,
    resolution,
    scopeBoundaries: [] as string[],
    sourceDigest: createHash("sha256").update(JSON.stringify(sources), "utf8").digest("hex"),
    sources,
  };
}

function mapRevision(
  row: RevisionRow,
  input: {
    base: { objectId: string; ref: string };
    head: { objectId: string; ref: string };
    objectFormat: "sha1" | "sha256";
  },
): ReviewRevision {
  return {
    availableAt: row.available_at?.toISOString() ?? null,
    base: input.base,
    createdAt: row.created_at.toISOString(),
    failureReason: row.failure_reason ?? null,
    head: input.head,
    id: row.id,
    objectCount: row.object_count == null ? null : Number(row.object_count),
    objectFormat: input.objectFormat,
    retainedBytes: row.retained_bytes == null ? null : Number(row.retained_bytes),
    state: row.revision_state,
  };
}

function mapExactRevision(row: ExactRevisionRow): ReviewRevision {
  return mapRevision(row, {
    base: { objectId: row.base_object_id, ref: row.base_ref_snapshot },
    head: { objectId: row.head_object_id, ref: row.head_ref_snapshot },
    objectFormat: row.object_format,
  });
}

function exactRevisionLimits(row: ExactRevisionRow): { maxBytes: number; maxObjects: number } {
  const maxBytes = Number(row.max_bytes);
  const maxObjects = Number(row.max_objects);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxObjects) ||
    maxObjects < 1
  ) {
    throw new Error("Stored Review Revision limits are invalid");
  }
  return { maxBytes, maxObjects };
}

function normalizeIntent(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 20_000 ||
    Buffer.byteLength(normalized, "utf8") > 20_000
  ) {
    throw new Error("Change Intent is invalid");
  }
  return normalized;
}

function validateExactRevision(input: BeginReviewRevisionInput): void {
  const objectId = input.source.objectFormat === "sha1" ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u;
  const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  if (
    !objectId.test(input.base.objectId) ||
    !objectId.test(input.head.objectId) ||
    input.base.ref.length === 0 ||
    input.base.ref.length > 255 ||
    input.head.ref.length === 0 ||
    input.head.ref.length > 255 ||
    (input.expectedProjectId !== undefined && !uuidV7.test(input.expectedProjectId)) ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 1 ||
    !Number.isSafeInteger(input.maxObjects) ||
    input.maxObjects < 1
  ) {
    throw new Error("Exact Review Revision input is invalid");
  }
}

async function readInstallationId(client: PoolClient): Promise<string> {
  const result = await client.query<{ id: string }>(`
    SELECT id
    FROM installations
    ORDER BY created_at, id
    LIMIT 1
  `);
  const id = result.rows[0]?.id;
  if (result.rowCount !== 1 || id === undefined) {
    throw new ReviewRevisionPersistenceError("installation_not_available");
  }
  return id;
}

async function findRepositoryProjects(
  client: PoolClient,
  installationId: string,
  github: { name: string; owner: string },
): Promise<RepositoryProjectRow[]> {
  const projects = await client.query<RepositoryProjectRow>(
    `
      SELECT p.id,
             p.canonical_project_id,
             p.provider_observation_kind,
             p.provider,
             p.provider_repository_id,
             p.repository_owner_snapshot,
             p.repository_name_snapshot,
             p.repository_canonical_url_snapshot
      FROM projects AS p
      WHERE p.installation_id = $1
        AND p.canonical_project_id IS NULL
        AND (
          (
            p.provider_observation_kind IN ('public_github', 'host_gh')
            AND p.provider = 'github'
            AND lower(p.repository_owner_snapshot) = lower($2)
            AND lower(p.repository_name_snapshot) = lower($3)
          )
          OR (
            p.provider IS NULL
            AND EXISTS (
              SELECT 1
              FROM local_repository_sources AS source
              WHERE source.project_id = p.id
                AND lower(source.github_owner_snapshot) = lower($2)
                AND lower(source.github_name_snapshot) = lower($3)
            )
          )
        )
      ORDER BY p.id
      LIMIT 3
      FOR UPDATE OF p
    `,
    [installationId, github.owner, github.name],
  );
  return projects.rows;
}

async function findProviderMatch(
  client: PoolClient,
  installationId: string,
  input: BeginReviewRevisionInput,
): Promise<{ projectId: string; proposalId: string | null } | null> {
  const github = input.source.githubRepository;
  if (github === null) {
    if (input.changeProposalId !== undefined) {
      throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
    }
    return null;
  }
  const projects = await findRepositoryProjects(client, installationId, github);
  if (projects.length > 1) {
    throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
  }
  const projectId = projects[0]?.id;
  if (projectId === undefined) {
    if (input.changeProposalId !== undefined) {
      throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
    }
    return null;
  }
  const proposalId = await findExistingProposal(client, projectId, input);
  return { projectId, proposalId };
}

function sameGitHubRepository(
  project: RepositoryProjectRow,
  github: { name: string; owner: string },
): boolean {
  return (
    (project.provider_observation_kind === "public_github" ||
      project.provider_observation_kind === "host_gh") &&
    project.provider === "github" &&
    project.provider_repository_id !== null &&
    project.repository_canonical_url_snapshot !== null &&
    project.repository_owner_snapshot?.toLocaleLowerCase("en-US") ===
      github.owner.toLocaleLowerCase("en-US") &&
    project.repository_name_snapshot?.toLocaleLowerCase("en-US") ===
      github.name.toLocaleLowerCase("en-US")
  );
}

async function readAliasableProviderProposals(
  client: PoolClient,
  providerProjectId: string,
): Promise<ProviderProposalAliasRow[]> {
  const result = await client.query<ProviderProposalAliasRow>(
    `
      SELECT id,
             proposal_kind,
             canonical_change_proposal_id,
             provider_proposal_id,
             provider_number,
             title_snapshot,
             canonical_url_snapshot,
             proposal_state,
             base_ref_snapshot,
             base_object_id,
             head_ref_snapshot,
             head_object_id,
             author_provider_id,
             author_login_snapshot,
             observed_at
      FROM change_proposals
      WHERE project_id = $1
        AND canonical_change_proposal_id IS NULL
      ORDER BY id
      LIMIT 101
      FOR UPDATE
    `,
    [providerProjectId],
  );
  if (
    result.rows.length > MAX_PROPOSALS_PER_PROJECT ||
    result.rows.some((proposal) =>
      proposal.proposal_kind === "provider_observed"
        ? proposal.provider_proposal_id === null ||
          proposal.provider_number === null ||
          proposal.canonical_url_snapshot === null ||
          proposal.proposal_state === null ||
          proposal.observed_at === null
        : proposal.proposal_kind !== "local" ||
          proposal.provider_proposal_id !== null ||
          proposal.provider_number !== null ||
          proposal.canonical_url_snapshot !== null ||
          proposal.proposal_state !== null ||
          proposal.observed_at !== null ||
          proposal.author_provider_id !== null ||
          proposal.author_login_snapshot !== null,
    )
  ) {
    throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
  }
  return result.rows;
}

async function aliasProviderProposal(
  client: PoolClient,
  aliasProposalId: string,
  canonicalProposalId: string,
): Promise<void> {
  await client.query(
    `
      UPDATE change_proposals
      SET canonical_change_proposal_id = $2,
          updated_at = clock_timestamp()
      WHERE canonical_change_proposal_id = $1
    `,
    [aliasProposalId, canonicalProposalId],
  );
  const aliased = await client.query(
    `
      UPDATE change_proposals
      SET proposal_kind = 'alias',
          canonical_change_proposal_id = $2,
          updated_at = clock_timestamp()
      WHERE id = $1
        AND proposal_kind IN ('provider_observed', 'local')
    `,
    [aliasProposalId, canonicalProposalId],
  );
  if (aliased.rowCount !== 1) {
    throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
  }
}

async function enrichLocalProposal(
  client: PoolClient,
  localProposalId: string,
  proposal: ProviderProposalAliasRow,
): Promise<void> {
  const enriched = await client.query(
    `
      UPDATE change_proposals
      SET proposal_kind = 'provider_observed',
          provider_proposal_id = $2,
          provider_number = $3,
          title_snapshot = $4,
          canonical_url_snapshot = $5,
          proposal_state = $6,
          base_ref_snapshot = $7,
          base_object_id = $8,
          head_ref_snapshot = $9,
          head_object_id = $10,
          author_provider_id = $11,
          author_login_snapshot = $12,
          observed_at = $13,
          updated_at = clock_timestamp()
      WHERE id = $1 AND proposal_kind = 'local'
    `,
    [
      localProposalId,
      proposal.provider_proposal_id,
      proposal.provider_number,
      proposal.title_snapshot,
      proposal.canonical_url_snapshot,
      proposal.proposal_state,
      proposal.base_ref_snapshot,
      proposal.base_object_id,
      proposal.head_ref_snapshot,
      proposal.head_object_id,
      proposal.author_provider_id,
      proposal.author_login_snapshot,
      proposal.observed_at,
    ],
  );
  if (enriched.rowCount !== 1) {
    throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
  }
}

async function copyProposalToProject(
  client: PoolClient,
  projectId: string,
  proposal: ProviderProposalAliasRow,
): Promise<string> {
  const copied = await client.query<{ id: string }>(
    `
      INSERT INTO change_proposals (
        project_id,
        proposal_kind,
        provider_proposal_id,
        provider_number,
        title_snapshot,
        canonical_url_snapshot,
        proposal_state,
        base_ref_snapshot,
        base_object_id,
        head_ref_snapshot,
        head_object_id,
        author_provider_id,
        author_login_snapshot,
        observed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id
    `,
    [
      projectId,
      proposal.proposal_kind,
      proposal.provider_proposal_id,
      proposal.provider_number,
      proposal.title_snapshot,
      proposal.canonical_url_snapshot,
      proposal.proposal_state,
      proposal.base_ref_snapshot,
      proposal.base_object_id,
      proposal.head_ref_snapshot,
      proposal.head_object_id,
      proposal.author_provider_id,
      proposal.author_login_snapshot,
      proposal.observed_at,
    ],
  );
  const copiedId = copied.rows[0]?.id;
  if (copied.rowCount !== 1 || copiedId === undefined) {
    throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
  }
  return copiedId;
}

async function mergeProviderProjectAsAlias(
  client: PoolClient,
  localProjectId: string,
  providerProject: RepositoryProjectRow,
  selectedProposalId: string | null,
): Promise<void> {
  if (
    providerProject.canonical_project_id !== null ||
    (providerProject.provider_observation_kind !== "public_github" &&
      providerProject.provider_observation_kind !== "host_gh") ||
    providerProject.provider !== "github" ||
    providerProject.provider_repository_id === null ||
    providerProject.repository_owner_snapshot === null ||
    providerProject.repository_name_snapshot === null ||
    providerProject.repository_canonical_url_snapshot === null
  ) {
    throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
  }
  const localProposals = await client.query<{
    base_object_id: string;
    head_object_id: string;
    id: string;
    proposal_kind: string;
  }>(
    `
      SELECT id, proposal_kind, base_object_id, head_object_id
      FROM change_proposals
      WHERE project_id = $1
        AND canonical_change_proposal_id IS NULL
      ORDER BY id
      LIMIT 101
      FOR UPDATE
    `,
    [localProjectId],
  );
  if (
    localProposals.rows.length > MAX_PROPOSALS_PER_PROJECT ||
    localProposals.rows.some(({ proposal_kind }) => proposal_kind !== "local")
  ) {
    throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
  }

  const providerProposals = await readAliasableProviderProposals(client, providerProject.id);
  const localByExactRevision = new Map(
    localProposals.rows.map((proposal) => [
      `${proposal.base_object_id}:${proposal.head_object_id}`,
      proposal.id,
    ]),
  );
  const providerExactRevisionCounts = new Map<string, number>();
  for (const proposal of providerProposals) {
    const exactRevision = `${proposal.base_object_id}:${proposal.head_object_id}`;
    providerExactRevisionCounts.set(
      exactRevision,
      (providerExactRevisionCounts.get(exactRevision) ?? 0) + 1,
    );
  }
  const proposalMatches = providerProposals.map((proposal) => ({
    localProposalId: (() => {
      const exactRevision = `${proposal.base_object_id}:${proposal.head_object_id}`;
      const localProposalId = localByExactRevision.get(exactRevision) ?? null;
      if (localProposalId === null) return null;
      if (providerExactRevisionCounts.get(exactRevision) === 1) return localProposalId;
      return proposal.id === selectedProposalId ? localProposalId : null;
    })(),
    proposal,
  }));
  const matchedLocalProposalIds = new Set(
    proposalMatches.flatMap(({ localProposalId }) =>
      localProposalId === null ? [] : [localProposalId],
    ),
  );
  const unmatchedProposalCount = proposalMatches.length - matchedLocalProposalIds.size;
  if (localProposals.rows.length + unmatchedProposalCount > MAX_PROPOSALS_PER_PROJECT) {
    throw new ReviewRevisionPersistenceError("revision_limit_exceeded");
  }

  for (const { localProposalId, proposal } of proposalMatches) {
    const canonicalProposalId =
      localProposalId ?? (await copyProposalToProject(client, localProjectId, proposal));
    await aliasProviderProposal(client, proposal.id, canonicalProposalId);
    if (localProposalId !== null && proposal.proposal_kind === "provider_observed") {
      await enrichLocalProposal(client, localProposalId, proposal);
    }
  }

  await client.query(
    `
      UPDATE local_repository_sources
      SET attachment_state = 'detached',
          updated_at = clock_timestamp()
      WHERE project_id = $1 AND attachment_state = 'attached'
    `,
    [providerProject.id],
  );

  const aliasedProject = await client.query(
    `
      UPDATE projects
      SET canonical_project_id = $2,
          provider_observation_kind = NULL,
          provider = NULL,
          provider_repository_id = NULL,
          repository_owner_snapshot = NULL,
          repository_name_snapshot = NULL,
          repository_canonical_url_snapshot = NULL,
          updated_at = clock_timestamp()
      WHERE id = $1 AND canonical_project_id IS NULL
    `,
    [providerProject.id, localProjectId],
  );
  if (aliasedProject.rowCount !== 1) {
    throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
  }
  const enrichedProject = await client.query(
    `
      UPDATE projects
      SET provider_observation_kind = 'public_github',
          provider = 'github',
          provider_repository_id = $2,
          repository_owner_snapshot = $3,
          repository_name_snapshot = $4,
          repository_canonical_url_snapshot = $5,
          updated_at = clock_timestamp()
      WHERE id = $1 AND canonical_project_id IS NULL AND provider IS NULL
    `,
    [
      localProjectId,
      providerProject.provider_repository_id,
      providerProject.repository_owner_snapshot,
      providerProject.repository_name_snapshot,
      providerProject.repository_canonical_url_snapshot,
    ],
  );
  if (enrichedProject.rowCount !== 1) {
    throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
  }
  await client.query(
    `
      UPDATE projects
      SET canonical_project_id = $2,
          updated_at = clock_timestamp()
      WHERE canonical_project_id = $1
    `,
    [providerProject.id, localProjectId],
  );
  await client.query(
    `
      UPDATE projects AS canonical
      SET source_availability = CASE
            WHEN EXISTS (
              SELECT 1
              FROM review_revisions AS revision
              INNER JOIN projects AS revision_project
                ON revision_project.id = revision.project_id
              WHERE COALESCE(revision_project.canonical_project_id, revision_project.id) = $1
                AND revision.revision_state = 'available'
            ) THEN 'available'
            WHEN EXISTS (
              SELECT 1
              FROM review_revisions AS revision
              INNER JOIN projects AS revision_project
                ON revision_project.id = revision.project_id
              WHERE COALESCE(revision_project.canonical_project_id, revision_project.id) = $1
            ) THEN 'unavailable'
            ELSE canonical.source_availability
          END,
          updated_at = clock_timestamp()
      WHERE canonical.id = $1
    `,
    [localProjectId],
  );
}

async function reconcileExistingSourceProject(
  client: PoolClient,
  installationId: string,
  projectId: string,
  source: LocalRepositorySourceObservation,
  changeProposalId?: string,
): Promise<{ changeProposalId: string | undefined; projectId: string }> {
  const github = source.githubRepository;
  const projectResult = await client.query<RepositoryProjectRow>(
    `
      SELECT id,
             canonical_project_id,
             provider_observation_kind,
             provider,
             provider_repository_id,
             repository_owner_snapshot,
             repository_name_snapshot,
             repository_canonical_url_snapshot
      FROM projects
      WHERE id = $1 AND installation_id = $2
      FOR UPDATE
    `,
    [projectId, installationId],
  );
  const project = projectResult.rows[0];
  if (project === undefined) {
    throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
  }
  if (project.canonical_project_id !== null) {
    const canonicalResult = await client.query<RepositoryProjectRow>(
      `
        SELECT id,
               canonical_project_id,
               provider_observation_kind,
               provider,
               provider_repository_id,
               repository_owner_snapshot,
               repository_name_snapshot,
               repository_canonical_url_snapshot
        FROM projects
        WHERE id = $1 AND installation_id = $2 AND canonical_project_id IS NULL
        FOR UPDATE
      `,
      [project.canonical_project_id, installationId],
    );
    const canonicalProject = canonicalResult.rows[0];
    if (
      canonicalProject === undefined ||
      (github !== null && !sameGitHubRepository(canonicalProject, github))
    ) {
      throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
    }
    return { changeProposalId, projectId: canonicalProject.id };
  }
  if (github === null) {
    return { changeProposalId, projectId };
  }
  if (project.provider !== null) {
    if (!sameGitHubRepository(project, github)) {
      throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
    }
    return { changeProposalId, projectId };
  }
  const matches = await findRepositoryProjects(client, installationId, github);
  const otherMatches = matches.filter((match) => match.id !== projectId);
  if (otherMatches.length > 1) {
    throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
  }
  const providerProject = otherMatches[0];
  if (providerProject !== undefined) {
    await mergeProviderProjectAsAlias(client, projectId, providerProject, changeProposalId ?? null);
  }
  return { changeProposalId, projectId };
}

async function createLocalProject(client: PoolClient, installationId: string): Promise<string> {
  const capacity = await client.query<{ project_count: string }>(
    "SELECT count(*) AS project_count FROM projects WHERE installation_id = $1 AND canonical_project_id IS NULL",
    [installationId],
  );
  const projectCount = Number(capacity.rows[0]?.project_count);
  if (!Number.isSafeInteger(projectCount) || projectCount < 0) {
    throw new Error("Installation Project count is invalid");
  }
  if (projectCount >= MAX_PROJECTS_PER_INSTALLATION) {
    throw new ReviewRevisionPersistenceError("revision_limit_exceeded");
  }
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO projects (installation_id)
      VALUES ($1)
      RETURNING id
    `,
    [installationId],
  );
  const id = result.rows[0]?.id;
  if (result.rowCount !== 1 || id === undefined) {
    throw new Error("Local Project creation failed");
  }
  return id;
}

async function attachSource(
  client: PoolClient,
  installationId: string,
  projectId: string,
  source: LocalRepositorySourceObservation,
): Promise<string> {
  await client.query(
    `
      UPDATE local_repository_sources
      SET attachment_state = 'detached',
          updated_at = clock_timestamp()
      WHERE attachment_state = 'attached'
        AND (
          project_id IN (
            SELECT id FROM projects WHERE id = $2 OR canonical_project_id = $2
          )
          OR (
            installation_id = $1
            AND repository_id = $3
            AND source_identity <> $4
          )
        )
    `,
    [installationId, projectId, source.repositoryId, source.sourceIdentity],
  );
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO local_repository_sources (
        installation_id,
        project_id,
        source_identity,
        repository_id,
        root_id,
        repository_relative_locator,
        display_name_snapshot,
        object_format,
        github_owner_snapshot,
        github_name_snapshot,
        attachment_state
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'attached')
      RETURNING id
    `,
    [
      installationId,
      projectId,
      source.sourceIdentity,
      source.repositoryId,
      source.rootId,
      source.relativePath,
      source.displayName,
      source.objectFormat,
      source.githubRepository?.owner ?? null,
      source.githubRepository?.name ?? null,
    ],
  );
  const id = result.rows[0]?.id;
  if (result.rowCount !== 1 || id === undefined) {
    throw new Error("Local Repository Source attachment failed");
  }
  return id;
}

async function refreshSourceAttachment(
  client: PoolClient,
  installationId: string,
  projectId: string,
  sourceId: string,
  source: LocalRepositorySourceObservation,
): Promise<void> {
  await client.query(
    `
      UPDATE local_repository_sources
      SET attachment_state = 'detached',
          updated_at = clock_timestamp()
      WHERE id <> $5
        AND attachment_state = 'attached'
        AND (
          project_id IN (
            SELECT id FROM projects WHERE id = $2 OR canonical_project_id = $2
          )
          OR (
            installation_id = $1
            AND repository_id = $3
            AND source_identity <> $4
          )
        )
    `,
    [installationId, projectId, source.repositoryId, source.sourceIdentity, sourceId],
  );
  await client.query(
    `
      UPDATE local_repository_sources
      SET repository_id = $2,
          root_id = $3,
          repository_relative_locator = $4,
          display_name_snapshot = $5,
          github_owner_snapshot = $6,
          github_name_snapshot = $7,
          attachment_state = 'attached',
          updated_at = clock_timestamp()
      WHERE id = $1
    `,
    [
      sourceId,
      source.repositoryId,
      source.rootId,
      source.relativePath,
      source.displayName,
      source.githubRepository?.owner ?? null,
      source.githubRepository?.name ?? null,
    ],
  );
}

async function auditSourceAttachment(
  client: PoolClient,
  input: OpenLocalProjectInput,
  sourceId: string,
): Promise<void> {
  await appendAuditRecordInTransaction(client, {
    actorId: input.actorId,
    actorType: "operator",
    causationId: null,
    correlationId: input.correlationId,
    denialReason: null,
    eventType: "local_repository_source.attached",
    facts: { objectFormat: input.source.objectFormat },
    outcome: "succeeded",
    targetId: sourceId,
    targetType: "local_repository_source",
  });
}

export async function openLocalProject(
  pool: DatabasePool,
  input: OpenLocalProjectInput,
): Promise<ProjectUpserted> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const installationId = await readInstallationId(client);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('kestrel-local-source:' || $1, 0))",
      [input.source.sourceIdentity],
    );
    if (input.source.githubRepository !== null) {
      await lockGitHubRepositoryIdentity(client, input.source.githubRepository);
    }
    const existingSource = await client.query<SourceRow>(
      `
        SELECT id, project_id, object_format, attachment_state
        FROM local_repository_sources
        WHERE installation_id = $1 AND source_identity = $2
        FOR UPDATE
      `,
      [installationId, input.source.sourceIdentity],
    );
    const sourceRow = existingSource.rows[0];
    let projectId: string;
    let sourceId: string;
    let sourceAttached: boolean;
    if (sourceRow === undefined) {
      const repositoryMatches =
        input.source.githubRepository === null
          ? []
          : await findRepositoryProjects(client, installationId, input.source.githubRepository);
      if (repositoryMatches.length > 1) {
        throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
      }
      projectId = repositoryMatches[0]?.id ?? (await createLocalProject(client, installationId));
      sourceId = await attachSource(client, installationId, projectId, input.source);
      sourceAttached = true;
    } else {
      if (sourceRow.object_format !== input.source.objectFormat) {
        throw new ReviewRevisionPersistenceError("revision_state_conflict");
      }
      const reconciled = await reconcileExistingSourceProject(
        client,
        installationId,
        sourceRow.project_id,
        input.source,
      );
      projectId = reconciled.projectId;
      sourceId = sourceRow.id;
      sourceAttached = sourceRow.attachment_state === "detached";
      await refreshSourceAttachment(client, installationId, projectId, sourceId, input.source);
    }
    if (sourceAttached) {
      await auditSourceAttachment(client, input, sourceId);
    }
    const project = await readProjectInTransaction(client, projectId);
    await client.query("COMMIT");
    return ProjectUpsertedSchema.parse({ project, schemaVersion: 1 });
  } catch (error) {
    await client.query("ROLLBACK");
    throw isCapacityConstraint(error)
      ? new ReviewRevisionPersistenceError("revision_limit_exceeded")
      : error;
  } finally {
    client.release();
  }
}

async function createLocalProposal(
  client: PoolClient,
  projectId: string,
  input: BeginReviewRevisionInput,
): Promise<string> {
  await client.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [projectId]);
  const existing = await client.query<{ id: string }>(
    `
      SELECT id
      FROM change_proposals
      WHERE project_id = $1
        AND proposal_kind = 'local'
        AND canonical_change_proposal_id IS NULL
        AND base_object_id = $2
        AND head_object_id = $3
      FOR UPDATE
    `,
    [projectId, input.base.objectId, input.head.objectId],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId !== undefined) return existingId;
  const capacity = await client.query<{ proposal_count: string }>(
    "SELECT count(*) AS proposal_count FROM change_proposals WHERE project_id = $1 AND canonical_change_proposal_id IS NULL",
    [projectId],
  );
  const proposalCount = Number(capacity.rows[0]?.proposal_count);
  if (!Number.isSafeInteger(proposalCount) || proposalCount < 0) {
    throw new Error("Project Change Proposal count is invalid");
  }
  if (proposalCount >= MAX_PROPOSALS_PER_PROJECT) {
    throw new ReviewRevisionPersistenceError("revision_limit_exceeded");
  }
  const title = `Local change: ${input.head.ref}`.slice(0, 512);
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO change_proposals (
        project_id,
        proposal_kind,
        title_snapshot,
        base_ref_snapshot,
        base_object_id,
        head_ref_snapshot,
        head_object_id,
        observed_at
      )
      VALUES ($1, 'local', $2, $3, $4, $5, $6, NULL)
      ON CONFLICT (project_id, base_object_id, head_object_id)
      WHERE proposal_kind = 'local'
      DO UPDATE SET updated_at = change_proposals.updated_at
      RETURNING id
    `,
    [projectId, title, input.base.ref, input.base.objectId, input.head.ref, input.head.objectId],
  );
  const id = result.rows[0]?.id;
  if (result.rowCount !== 1 || id === undefined) {
    throw new Error("Local Change Proposal creation failed");
  }
  return id;
}

async function findExistingProposal(
  client: PoolClient,
  projectId: string,
  input: BeginReviewRevisionInput,
): Promise<string | null> {
  if (input.changeProposalId !== undefined) {
    const selected = await client.query<{ id: string }>(
      `
        SELECT canonical.id
        FROM change_proposals AS selected
        INNER JOIN change_proposals AS canonical
          ON canonical.id = COALESCE(selected.canonical_change_proposal_id, selected.id)
        WHERE selected.id = $1
          AND canonical.project_id = $2
          AND canonical.canonical_change_proposal_id IS NULL
          AND canonical.base_object_id = $3
          AND canonical.head_object_id = $4
        FOR UPDATE OF selected, canonical
      `,
      [input.changeProposalId, projectId, input.base.objectId, input.head.objectId],
    );
    if (selected.rowCount !== 1) {
      throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
    }
    const canonicalId = selected.rows[0]?.id;
    if (canonicalId === undefined) {
      throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
    }
    return canonicalId;
  }

  const providerMatches = await client.query<{ id: string }>(
    `
      SELECT id
      FROM change_proposals
      WHERE project_id = $1
        AND proposal_kind = 'provider_observed'
        AND canonical_change_proposal_id IS NULL
        AND base_object_id = $2
        AND head_object_id = $3
      ORDER BY id
      LIMIT 2
      FOR UPDATE
    `,
    [projectId, input.base.objectId, input.head.objectId],
  );
  if ((providerMatches.rowCount ?? 0) > 1) {
    throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
  }
  const providerMatch = providerMatches.rows[0]?.id;
  if (providerMatch !== undefined) {
    return providerMatch;
  }

  const localMatch = await client.query<{ id: string }>(
    `
      SELECT id
      FROM change_proposals
      WHERE project_id = $1
        AND proposal_kind = 'local'
        AND canonical_change_proposal_id IS NULL
        AND base_object_id = $2
        AND head_object_id = $3
      FOR UPDATE
    `,
    [projectId, input.base.objectId, input.head.objectId],
  );
  return localMatch.rows[0]?.id ?? null;
}

async function appendOrReuseIntent(
  client: PoolClient,
  targetProposalId: string,
  actorId: string,
  intentText: string,
): Promise<ChangeIntent> {
  const family = await client.query<{ canonical_proposal_id: string }>(
    `
      SELECT canonical.id AS canonical_proposal_id
      FROM change_proposals AS target
      INNER JOIN change_proposals AS canonical
        ON canonical.id = COALESCE(target.canonical_change_proposal_id, target.id)
      WHERE target.id = $1
      FOR UPDATE OF canonical
    `,
    [targetProposalId],
  );
  const canonicalProposalId = family.rows[0]?.canonical_proposal_id;
  if (family.rowCount !== 1 || canonicalProposalId === undefined) {
    throw new Error("Change Proposal family is unavailable");
  }
  const current = await client.query<IntentRow>(
    `
      SELECT intent.id,
             intent.change_proposal_id,
             intent.version,
             intent.intent_text,
             intent.objective,
             intent.scope_boundaries,
             intent.acceptance_outcomes,
             intent.selected_sources,
             intent.source_digest,
             intent.resolution_state,
             intent.resolution_issues,
             intent.created_at,
             max(intent.version) OVER () AS max_version
      FROM change_intents AS intent
      INNER JOIN change_proposals AS intent_proposal
        ON intent_proposal.id = intent.change_proposal_id
      INNER JOIN change_proposals AS target
        ON target.id = $1
      WHERE intent_proposal.id = COALESCE(target.canonical_change_proposal_id, target.id)
         OR intent_proposal.canonical_change_proposal_id = COALESCE(
              target.canonical_change_proposal_id,
              target.id
            )
      ORDER BY intent.version DESC, intent.created_at DESC, intent.id DESC
      LIMIT 1
    `,
    [targetProposalId],
  );
  const currentRow = current.rows[0];
  if (
    currentRow !== undefined &&
    currentRow.change_proposal_id === targetProposalId &&
    currentRow.intent_text === intentText
  ) {
    return mapIntent(currentRow);
  }
  const currentMaxVersion = Number(currentRow?.max_version ?? 0);
  if (!Number.isSafeInteger(currentMaxVersion) || currentMaxVersion < 0) {
    throw new Error("Change Intent version is invalid");
  }
  const nextVersion = currentMaxVersion + 1;
  const structured = acquisitionIntentFields(intentText, nextVersion);
  const inserted = await client.query<IntentRow>(
    `
      INSERT INTO change_intents (
        change_proposal_id,
        version,
        intent_text,
        submitted_by_operator_id,
        objective,
        scope_boundaries,
        acceptance_outcomes,
        selected_sources,
        source_digest,
        resolution_state,
        resolution_issues
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb)
      RETURNING id,
                version,
                intent_text,
                objective,
                scope_boundaries,
                acceptance_outcomes,
                selected_sources,
                source_digest,
                resolution_state,
                resolution_issues,
                created_at
    `,
    [
      targetProposalId,
      nextVersion,
      intentText,
      actorId,
      structured.objective,
      JSON.stringify(structured.scopeBoundaries),
      JSON.stringify(structured.acceptanceOutcomes),
      JSON.stringify(structured.sources),
      structured.sourceDigest,
      structured.resolution.state,
      JSON.stringify(structured.resolution.issues),
    ],
  );
  const row = inserted.rows[0];
  if (inserted.rowCount !== 1 || row === undefined) {
    throw new Error("Change Intent append failed");
  }
  const advanced = await client.query(
    `
      UPDATE change_proposals
      SET optimistic_version = optimistic_version + 1,
          updated_at = clock_timestamp()
      WHERE id = $1
    `,
    [canonicalProposalId],
  );
  if (advanced.rowCount !== 1) {
    throw new Error("Change Proposal version advance failed");
  }
  return mapIntent(row);
}

async function readIntent(client: PoolClient, intentId: string): Promise<ChangeIntent> {
  const result = await client.query<IntentRow>(
    `
      SELECT id,
             version,
             intent_text,
             objective,
             scope_boundaries,
             acceptance_outcomes,
             selected_sources,
             source_digest,
             resolution_state,
             resolution_issues,
             created_at
      FROM change_intents
      WHERE id = $1
    `,
    [intentId],
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) {
    throw new Error("Review Revision acquisition intent is unavailable");
  }
  return mapIntent(row);
}

async function readExactRevision(
  client: PoolClient,
  input: BeginReviewRevisionInput,
  projectId: string,
  proposalId: string,
  sourceId: string,
): Promise<ExactRevisionRow | null> {
  const result = await client.query<ExactRevisionRow>(
    `
      SELECT revision.id,
             revision.project_id,
             revision.change_proposal_id,
             revision.acquisition_change_intent_id,
             revision.revision_state,
             revision.base_ref_snapshot,
             revision.base_object_id,
             revision.head_ref_snapshot,
             revision.head_object_id,
             revision.object_format,
             revision.max_bytes,
             revision.max_objects,
             revision.object_count,
             revision.retained_bytes,
             revision.failure_reason,
             revision.created_at,
             revision.updated_at,
             revision.available_at
      FROM review_revisions AS revision
      INNER JOIN change_proposals AS revision_proposal
        ON revision_proposal.id = revision.change_proposal_id
      INNER JOIN projects AS revision_project
        ON revision_project.id = revision.project_id
      WHERE COALESCE(revision_project.canonical_project_id, revision_project.id) = $1
        AND (
          revision_proposal.id = $2
          OR revision_proposal.canonical_change_proposal_id = $2
        )
        AND revision.local_repository_source_id = $3
        AND revision.base_object_id = $4
        AND revision.head_object_id = $5
      ORDER BY (revision.change_proposal_id = $6) DESC NULLS LAST,
               (revision.change_proposal_id = $2) DESC,
               revision.created_at,
               revision.id
      LIMIT 1
      FOR UPDATE OF revision
    `,
    [
      projectId,
      proposalId,
      sourceId,
      input.base.objectId,
      input.head.objectId,
      input.changeProposalId ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

async function reclaimStaleAcquiringRevision(
  client: PoolClient,
  row: ExactRevisionRow,
): Promise<ExactRevisionRow | null> {
  if (row.revision_state !== "acquiring") return null;
  const reclaimed = await client.query<ExactRevisionRow>(
    `
      WITH lease AS MATERIALIZED (
        SELECT pg_try_advisory_xact_lock(
          hashtextextended('kestrel-review-revision:' || $1::uuid::text, 0)
        ) AS acquired
      )
      UPDATE review_revisions
      SET revision_state = 'unavailable',
          failure_reason = 'acquisition_interrupted',
          updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND revision_state = 'acquiring'
        AND updated_at <= clock_timestamp() - interval '30 minutes'
        AND (SELECT acquired FROM lease)
      RETURNING id,
                project_id,
                change_proposal_id,
                acquisition_change_intent_id,
                revision_state,
                base_ref_snapshot,
                base_object_id,
                head_ref_snapshot,
                head_object_id,
                object_format,
                max_bytes,
                max_objects,
                object_count,
                retained_bytes,
                failure_reason,
                created_at,
                updated_at,
                available_at
    `,
    [row.id],
  );
  return reclaimed.rows[0] ?? null;
}

async function insertRevision(
  client: PoolClient,
  input: BeginReviewRevisionInput,
  projectId: string,
  proposalId: string,
  sourceId: string,
  intentId: string,
): Promise<ReviewRevision> {
  const result = await client.query<RevisionRow>(
    `
      INSERT INTO review_revisions (
        project_id,
        change_proposal_id,
        local_repository_source_id,
        acquisition_change_intent_id,
        revision_state,
        base_ref_snapshot,
        base_object_id,
        head_ref_snapshot,
        head_object_id,
        object_format,
        max_bytes,
        max_objects
      )
      VALUES ($1, $2, $3, $4, 'acquiring', $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, revision_state, created_at
    `,
    [
      projectId,
      proposalId,
      sourceId,
      intentId,
      input.base.ref,
      input.base.objectId,
      input.head.ref,
      input.head.objectId,
      input.source.objectFormat,
      input.maxBytes,
      input.maxObjects,
    ],
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) {
    throw new Error("Exact Review Revision reservation failed");
  }
  return mapRevision(row, { ...input, objectFormat: input.source.objectFormat });
}

async function retryRevision(
  client: PoolClient,
  row: ExactRevisionRow,
  intentId: string,
): Promise<ReviewRevision> {
  const result = await client.query<RevisionRow>(
    `
      UPDATE review_revisions
      SET revision_state = 'acquiring',
          acquisition_change_intent_id = $2,
          failure_reason = NULL,
          updated_at = clock_timestamp()
      WHERE id = $1 AND revision_state = 'unavailable'
      RETURNING id, revision_state, created_at
    `,
    [row.id, intentId],
  );
  const retriedRow = result.rows[0];
  if (result.rowCount !== 1 || retriedRow === undefined) {
    throw new ReviewRevisionPersistenceError("revision_state_conflict");
  }
  return mapRevision(retriedRow, {
    base: { objectId: row.base_object_id, ref: row.base_ref_snapshot },
    head: { objectId: row.head_object_id, ref: row.head_ref_snapshot },
    objectFormat: row.object_format,
  });
}

async function beginReviewRevisionOnClient(
  client: PoolClient,
  input: BeginReviewRevisionInput,
  beforeAcquireCommit?: (revisionId: string) => Promise<void>,
): Promise<BeginReviewRevisionResult> {
  validateExactRevision(input);
  const intentText = normalizeIntent(input.changeIntent);
  try {
    await client.query("BEGIN");
    const installationId = await readInstallationId(client);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('kestrel-local-source:' || $1, 0))",
      [input.source.sourceIdentity],
    );
    if (input.source.githubRepository !== null) {
      await lockGitHubRepositoryIdentity(client, input.source.githubRepository);
    }
    const existingSource = await client.query<SourceRow>(
      `
        SELECT id, project_id, object_format, attachment_state
        FROM local_repository_sources
        WHERE installation_id = $1 AND source_identity = $2
        FOR UPDATE
      `,
      [installationId, input.source.sourceIdentity],
    );
    const sourceRow = existingSource.rows[0];
    let projectId: string;
    let sourceId: string;
    let proposalId: string | undefined;
    let sourceAttached = false;
    if (sourceRow === undefined) {
      const providerMatch = await findProviderMatch(client, installationId, input);
      projectId = providerMatch?.projectId ?? (await createLocalProject(client, installationId));
      if (input.expectedProjectId !== undefined && projectId !== input.expectedProjectId) {
        throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
      }
      proposalId = providerMatch?.proposalId ?? undefined;
      sourceId = await attachSource(client, installationId, projectId, input.source);
      sourceAttached = true;
    } else {
      if (sourceRow.object_format !== input.source.objectFormat) {
        throw new ReviewRevisionPersistenceError("revision_state_conflict");
      }
      projectId = sourceRow.project_id;
      sourceId = sourceRow.id;
      sourceAttached = sourceRow.attachment_state === "detached";
      const reconciledProject = await reconcileExistingSourceProject(
        client,
        installationId,
        projectId,
        input.source,
        input.changeProposalId,
      );
      projectId = reconciledProject.projectId;
      if (input.expectedProjectId !== undefined && projectId !== input.expectedProjectId) {
        throw new ReviewRevisionPersistenceError("change_proposal_mismatch");
      }
      const canonicalInput =
        reconciledProject.changeProposalId === undefined
          ? input
          : { ...input, changeProposalId: reconciledProject.changeProposalId };
      await refreshSourceAttachment(client, installationId, projectId, sourceId, input.source);
      proposalId = (await findExistingProposal(client, projectId, canonicalInput)) ?? undefined;
    }
    proposalId ??= await createLocalProposal(client, projectId, input);
    let existingRevision = await readExactRevision(client, input, projectId, proposalId, sourceId);
    const reclaimedRevision =
      existingRevision === null
        ? null
        : await reclaimStaleAcquiringRevision(client, existingRevision);
    const reclaimed = reclaimedRevision !== null;
    existingRevision = reclaimedRevision ?? existingRevision;
    let changeIntent: ChangeIntent;
    let revision: ReviewRevision;
    let outcome: BeginReviewRevisionResult["outcome"];
    let limits: { maxBytes: number; maxObjects: number };
    let retried = false;
    const currentIntent = await appendOrReuseIntent(client, proposalId, input.actorId, intentText);
    if (existingRevision !== null && existingRevision.revision_state !== "unavailable") {
      changeIntent = await readIntent(client, existingRevision.acquisition_change_intent_id);
      revision = mapExactRevision(existingRevision);
      outcome = existingRevision.revision_state === "available" ? "already_available" : "acquiring";
      limits = exactRevisionLimits(existingRevision);
    } else {
      changeIntent =
        existingRevision !== null && existingRevision.change_proposal_id !== proposalId
          ? await appendOrReuseIntent(
              client,
              existingRevision.change_proposal_id,
              input.actorId,
              intentText,
            )
          : currentIntent;
      if (existingRevision === null) {
        revision = await insertRevision(
          client,
          input,
          projectId,
          proposalId,
          sourceId,
          changeIntent.id,
        );
        limits = { maxBytes: input.maxBytes, maxObjects: input.maxObjects };
      } else {
        revision = await retryRevision(client, existingRevision, changeIntent.id);
        limits = exactRevisionLimits(existingRevision);
        retried = true;
      }
      outcome = "acquire";
    }
    if (sourceAttached) {
      await auditSourceAttachment(client, input, sourceId);
    }
    if (reclaimed && existingRevision !== null) {
      await appendAuditRecordInTransaction(client, {
        actorId: null,
        actorType: "service",
        causationId: null,
        correlationId: randomUUID(),
        denialReason: "acquisition_interrupted",
        eventType: "review_revision.acquisition_interrupted",
        facts: {
          maxBytes: Number(existingRevision.max_bytes),
          maxObjects: Number(existingRevision.max_objects),
        },
        outcome: "denied",
        targetId: existingRevision.id,
        targetType: "review_revision",
      });
    }
    if (outcome === "acquire") {
      await appendAuditRecordInTransaction(client, {
        actorId: input.actorId,
        actorType: "operator",
        causationId: null,
        correlationId: input.correlationId,
        denialReason: null,
        eventType: retried
          ? "review_revision.acquisition_retried"
          : "review_revision.acquisition_started",
        facts: {
          maxBytes: limits.maxBytes,
          maxObjects: limits.maxObjects,
          objectFormat: input.source.objectFormat,
          revisionState: "acquiring",
        },
        outcome: "succeeded",
        targetId: revision.id,
        targetType: "review_revision",
      });
      await beforeAcquireCommit?.(revision.id);
    }
    await client.query("COMMIT");
    return {
      artifactProjectId: existingRevision?.project_id ?? projectId,
      changeIntent,
      changeProposalId: proposalId,
      localRepositorySourceId: sourceId,
      maxBytes: limits.maxBytes,
      maxObjects: limits.maxObjects,
      outcome,
      projectId,
      revision,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw isCapacityConstraint(error)
      ? new ReviewRevisionPersistenceError("revision_limit_exceeded")
      : error;
  }
}

export async function withReviewRevisionAcquisitionLease<T>(
  pool: DatabasePool,
  input: BeginReviewRevisionInput,
  operation: (begun: BeginReviewRevisionResult, leasedPool: DatabasePool) => Promise<T> | T,
): Promise<T> {
  const client = await pool.connect();
  let destroyClient = false;
  const leaseState: { revisionId?: string } = {};
  try {
    const begun = await beginReviewRevisionOnClient(client, input, async (revisionId) => {
      try {
        await client.query(
          "SELECT pg_advisory_lock(hashtextextended('kestrel-review-revision:' || $1, 0))",
          [revisionId],
        );
        leaseState.revisionId = revisionId;
      } catch (error) {
        destroyClient = true;
        throw error;
      }
    });
    return await operation(
      begun,
      borrowPoolClient(client, () => {
        destroyClient = true;
      }),
    );
  } finally {
    const leasedRevisionId = leaseState.revisionId;
    if (leasedRevisionId !== undefined) {
      try {
        const result = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended('kestrel-review-revision:' || $1, 0)) AS unlocked",
          [leasedRevisionId],
        );
        if (result.rows[0]?.unlocked !== true) destroyClient = true;
      } catch {
        destroyClient = true;
      }
    }
    client.release(destroyClient);
  }
}

function validateArtifact(
  artifact: RetainedArtifactObservation,
  projectId: string,
  revisionId: string,
): ChangeOverviewSourceFacts {
  const validSnapshot = (value: string | null, maximumLength: number) =>
    value === null || (value.length >= 1 && value.length <= maximumLength);
  const overviewFacts = ChangeOverviewSourceFactsSchema.safeParse(artifact.changeOverviewFacts);
  if (
    artifact.artifactLocator !== `projects/${projectId}/revisions/${revisionId}` ||
    !validSnapshot(artifact.baseCommitAuthor, 256) ||
    !validSnapshot(artifact.baseCommitSubject, 512) ||
    !validSnapshot(artifact.headCommitAuthor, 256) ||
    !validSnapshot(artifact.headCommitSubject, 512) ||
    !/^[a-f0-9]{64}$/u.test(artifact.manifestDigest) ||
    !Number.isSafeInteger(artifact.objectCount) ||
    artifact.objectCount < 1 ||
    !Number.isSafeInteger(artifact.retainedBytes) ||
    artifact.retainedBytes < 0 ||
    !overviewFacts.success
  ) {
    throw new Error("Retained artifact observation is invalid");
  }
  return overviewFacts.data;
}

export async function readChangeOverviewBackfillReference(
  pool: DatabasePool,
  revisionId: string,
): Promise<ChangeOverviewBackfillReference | null> {
  const result = await pool.query<{
    artifact_locator: string | null;
    manifest_digest: string | null;
  }>(
    `
      SELECT revision.artifact_locator, revision.manifest_digest
      FROM review_revisions AS revision
      LEFT JOIN change_overview_fact_manifests AS overview
        ON overview.review_revision_id = revision.id
      WHERE revision.id = $1
        AND revision.revision_state = 'available'
        AND overview.review_revision_id IS NULL
    `,
    [revisionId],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  if (
    result.rowCount !== 1 ||
    row?.artifact_locator == null ||
    row.manifest_digest == null ||
    !row.artifact_locator.endsWith(`/revisions/${revisionId}`) ||
    !/^[a-f0-9]{64}$/u.test(row.manifest_digest)
  ) {
    throw new Error("Available Review Revision artifact reference is incomplete");
  }
  return { artifactLocator: row.artifact_locator, manifestDigest: row.manifest_digest };
}

export async function backfillChangeOverviewFacts(
  pool: DatabasePool,
  input: BackfillChangeOverviewFactsInput,
): Promise<boolean> {
  const overviewFacts = ChangeOverviewSourceFactsSchema.parse(input.changeOverviewFacts);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const revision = await client.query<{ change_proposal_id: string }>(
      `
        SELECT revision.change_proposal_id
        FROM review_revisions AS revision
        WHERE revision.id = $1
          AND revision.revision_state = 'available'
          AND revision.artifact_locator = $2
          AND revision.manifest_digest = $3
        FOR UPDATE
      `,
      [input.revisionId, input.artifactLocator, input.manifestDigest],
    );
    const revisionRow = revision.rows[0];
    if (revision.rowCount !== 1 || revisionRow === undefined) {
      throw new ReviewRevisionPersistenceError("revision_state_conflict");
    }
    const inserted = await client.query<{ created_at: Date }>(
      `
        INSERT INTO change_overview_fact_manifests (
          review_revision_id,
          rule_version,
          source_facts
        )
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (review_revision_id) DO NOTHING
        RETURNING created_at
      `,
      [input.revisionId, overviewFacts.ruleVersion, JSON.stringify(overviewFacts)],
    );
    if (inserted.rowCount === 0) {
      await client.query("COMMIT");
      return false;
    }
    if (inserted.rowCount !== 1 || inserted.rows[0] === undefined) {
      throw new Error("Change Overview fact backfill failed");
    }
    const proposal = await client.query(
      `
        UPDATE change_proposals AS canonical
        SET optimistic_version = canonical.optimistic_version + 1,
            updated_at = clock_timestamp()
        WHERE canonical.id = (
          SELECT COALESCE(storage.canonical_change_proposal_id, storage.id)
          FROM change_proposals AS storage
          WHERE storage.id = $1
        )
      `,
      [revisionRow.change_proposal_id],
    );
    if (proposal.rowCount !== 1) {
      throw new Error("Change Overview Change Proposal version advance failed");
    }
    await appendAuditRecordInTransaction(client, {
      actorId: input.actorId,
      actorType: "operator",
      causationId: null,
      correlationId: input.correlationId,
      denialReason: null,
      eventType: "change_overview.facts_backfilled",
      facts: {
        changedFileCount: overviewFacts.fileStatistics.total,
        overviewRuleVersion: overviewFacts.ruleVersion,
      },
      outcome: "succeeded",
      targetId: input.revisionId,
      targetType: "review_revision",
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeReviewRevision(
  pool: DatabasePool,
  input: CompleteReviewRevisionInput,
  renderingJobCoordinator: ChangeOverviewRenderingJobCoordinator,
): Promise<ReviewRevision> {
  const overviewFacts = validateArtifact(input.artifact, input.projectId, input.revisionId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<RevisionRow>(
      `
        UPDATE review_revisions
        SET revision_state = 'available',
            object_count = $3,
            retained_bytes = $4,
            artifact_locator = $5,
            manifest_digest = $6,
            base_commit_author_snapshot = $7,
            base_commit_subject_snapshot = $8,
            head_commit_author_snapshot = $9,
            head_commit_subject_snapshot = $10,
            failure_reason = NULL,
            available_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE id = $1
          AND project_id = $2
          AND revision_state = 'acquiring'
        RETURNING id, revision_state, object_count, retained_bytes, failure_reason,
                  created_at, available_at
      `,
      [
        input.revisionId,
        input.projectId,
        input.artifact.objectCount,
        input.artifact.retainedBytes,
        input.artifact.artifactLocator,
        input.artifact.manifestDigest,
        input.artifact.baseCommitAuthor,
        input.artifact.baseCommitSubject,
        input.artifact.headCommitAuthor,
        input.artifact.headCommitSubject,
      ],
    );
    const row = result.rows[0];
    if (result.rowCount !== 1 || row === undefined) {
      throw new ReviewRevisionPersistenceError("revision_state_conflict");
    }
    const overview = await client.query<{ created_at: Date }>(
      `
        INSERT INTO change_overview_fact_manifests (
          review_revision_id,
          rule_version,
          source_facts
        )
        VALUES ($1, $2, $3::jsonb)
        RETURNING created_at
      `,
      [input.revisionId, overviewFacts.ruleVersion, JSON.stringify(overviewFacts)],
    );
    if (overview.rowCount !== 1 || overview.rows[0] === undefined) {
      throw new Error("Change Overview fact manifest persistence failed");
    }
    const project = await client.query(
      `
        UPDATE projects AS canonical
        SET source_availability = 'available', updated_at = clock_timestamp()
        WHERE canonical.id = (
          SELECT COALESCE(storage.canonical_project_id, storage.id)
          FROM projects AS storage
          WHERE storage.id = $1
        )
      `,
      [input.projectId],
    );
    if (project.rowCount !== 1) {
      throw new Error("Review Revision Project availability update failed");
    }
    if (input.enqueueModelRendering) {
      await enqueueChangeOverviewRendering(client, renderingJobCoordinator, {
        correlationId: input.correlationId,
        projectId: input.projectId,
        revisionId: input.revisionId,
      });
    }
    const proposal = await client.query(
      `
        UPDATE change_proposals AS canonical
        SET optimistic_version = canonical.optimistic_version + 1,
            updated_at = clock_timestamp()
        WHERE canonical.id = (
          SELECT COALESCE(storage.canonical_change_proposal_id, storage.id)
          FROM review_revisions AS revision
          INNER JOIN change_proposals AS storage
            ON storage.id = revision.change_proposal_id
          WHERE revision.id = $1
            AND revision.project_id = $2
        )
      `,
      [input.revisionId, input.projectId],
    );
    if (proposal.rowCount !== 1) {
      throw new Error("Review Revision Change Proposal version advance failed");
    }
    await appendAuditRecordInTransaction(client, {
      actorId: input.actorId,
      actorType: "operator",
      causationId: null,
      correlationId: input.correlationId,
      denialReason: null,
      eventType: "review_revision.available",
      facts: {
        changedFileCount: overviewFacts.fileStatistics.total,
        objectCount: input.artifact.objectCount,
        overviewRuleVersion: overviewFacts.ruleVersion,
        retainedBytes: input.artifact.retainedBytes,
      },
      outcome: "succeeded",
      targetId: input.revisionId,
      targetType: "review_revision",
    });
    await client.query("COMMIT");
    return mapRevision(row, input);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failReviewRevision(
  pool: DatabasePool,
  input: FailReviewRevisionInput,
  beforeUnavailable?: () => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{
      project_id: string;
      revision_state: "acquiring" | "available" | "unavailable";
    }>("SELECT project_id, revision_state FROM review_revisions WHERE id = $1 FOR UPDATE", [
      input.revisionId,
    ]);
    const currentRow = current.rows[0];
    if (current.rowCount !== 1 || currentRow === undefined) {
      throw new ReviewRevisionPersistenceError("revision_state_conflict");
    }
    if (currentRow.revision_state === "available") {
      throw new ReviewRevisionPersistenceError("revision_state_conflict");
    }
    if (currentRow.revision_state === "unavailable") {
      await client.query("COMMIT");
      return;
    }
    await beforeUnavailable?.();
    const failed = await client.query<{ project_id: string }>(
      `
        UPDATE review_revisions
        SET revision_state = 'unavailable',
            object_count = NULL,
            retained_bytes = NULL,
            artifact_locator = NULL,
            manifest_digest = NULL,
            failure_reason = $2,
            available_at = NULL,
            updated_at = clock_timestamp()
        WHERE id = $1 AND revision_state = 'acquiring'
        RETURNING project_id
      `,
      [input.revisionId, input.failureReason],
    );
    const row = failed.rows[0];
    if (failed.rowCount !== 1 || row === undefined) {
      throw new ReviewRevisionPersistenceError("revision_state_conflict");
    }
    await client.query(
      `
          UPDATE projects AS canonical
          SET source_availability = CASE
                WHEN EXISTS (
                  SELECT 1
                  FROM review_revisions AS revision
                  INNER JOIN projects AS revision_project
                    ON revision_project.id = revision.project_id
                  WHERE COALESCE(
                          revision_project.canonical_project_id,
                          revision_project.id
                        ) = canonical.id
                    AND revision.revision_state = 'available'
                ) THEN 'available'
                ELSE 'unavailable'
              END,
              updated_at = clock_timestamp()
          WHERE canonical.id = (
            SELECT COALESCE(storage.canonical_project_id, storage.id)
            FROM projects AS storage
            WHERE storage.id = $1
          )
        `,
      [row.project_id],
    );
    await appendAuditRecordInTransaction(client, {
      actorId: input.actorId,
      actorType: "operator",
      causationId: null,
      correlationId: input.correlationId,
      denialReason: input.failureReason,
      eventType: "review_revision.acquisition_failed",
      facts: {},
      outcome: "denied",
      targetId: input.revisionId,
      targetType: "review_revision",
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileAcquiringRevisions(pool: DatabasePool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const candidates = await client.query<{
      id: string;
      max_bytes: string;
      max_objects: string;
      project_id: string;
    }>(`
      SELECT id, project_id, max_bytes, max_objects
      FROM review_revisions
      WHERE revision_state = 'acquiring'
        AND updated_at <= clock_timestamp() - interval '30 minutes'
      ORDER BY id
      FOR UPDATE
    `);
    const interrupted: typeof candidates.rows = [];
    for (const candidate of candidates.rows) {
      const lease = await client.query<{ acquired: boolean }>(
        `
          SELECT pg_try_advisory_xact_lock(
            hashtextextended('kestrel-review-revision:' || $1, 0)
          ) AS acquired
        `,
        [candidate.id],
      );
      if (lease.rows[0]?.acquired !== true) continue;
      const result = await client.query<{
        id: string;
        max_bytes: string;
        max_objects: string;
        project_id: string;
      }>(
        `
          UPDATE review_revisions
          SET revision_state = 'unavailable',
              failure_reason = 'acquisition_interrupted',
              updated_at = clock_timestamp()
          WHERE id = $1
            AND revision_state = 'acquiring'
            AND updated_at <= clock_timestamp() - interval '30 minutes'
          RETURNING id, project_id, max_bytes, max_objects
        `,
        [candidate.id],
      );
      const row = result.rows[0];
      if (row !== undefined) interrupted.push(row);
    }
    await client.query(
      `
        UPDATE projects AS p
        SET source_availability = CASE
              WHEN EXISTS (
                SELECT 1
                FROM review_revisions AS available
                INNER JOIN projects AS revision_project
                  ON revision_project.id = available.project_id
                WHERE COALESCE(
                        revision_project.canonical_project_id,
                        revision_project.id
                      ) = p.id
                  AND available.revision_state = 'available'
              ) THEN 'available'
              ELSE 'unavailable'
            END,
            updated_at = clock_timestamp()
        WHERE p.id IN (
          SELECT COALESCE(storage.canonical_project_id, storage.id)
          FROM projects AS storage
          WHERE storage.id = ANY($1::uuid[])
        )
      `,
      [[...new Set(interrupted.map(({ project_id }) => project_id))]],
    );
    for (const row of interrupted) {
      await appendAuditRecordInTransaction(client, {
        actorId: null,
        actorType: "service",
        causationId: null,
        correlationId: randomUUID(),
        denialReason: "acquisition_interrupted",
        eventType: "review_revision.acquisition_interrupted",
        facts: {
          maxBytes: Number(row.max_bytes),
          maxObjects: Number(row.max_objects),
        },
        outcome: "denied",
        targetId: row.id,
        targetType: "review_revision",
      });
    }
    await client.query("COMMIT");
    return interrupted.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileLocalSourceAttachments(
  pool: DatabasePool,
  observations: readonly LocalSourceAttachmentObservation[],
): Promise<number> {
  const identities = observations.map(({ sourceIdentity }) => sourceIdentity);
  const repositories = observations.map(({ repositoryId }) => repositoryId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{ id: string }>(
      `
        SELECT DISTINCT ON (
          COALESCE(source_project.canonical_project_id, source_project.id)
        ) source.id
        FROM local_repository_sources AS source
        INNER JOIN projects AS source_project ON source_project.id = source.project_id
        INNER JOIN unnest($1::text[], $2::uuid[])
          AS observed(source_identity, repository_id)
          ON observed.source_identity = source.source_identity
         AND observed.repository_id = source.repository_id
        ORDER BY COALESCE(source_project.canonical_project_id, source_project.id),
                 (source.attachment_state = 'attached') DESC,
                 source.updated_at DESC,
                 source.id DESC
      `,
      [identities, repositories],
    );
    const selectedIds = selected.rows.map(({ id }) => id);
    const detached = await client.query(
      `
        UPDATE local_repository_sources
        SET attachment_state = 'detached',
            updated_at = clock_timestamp()
        WHERE attachment_state = 'attached'
          AND NOT (id = ANY($1::uuid[]))
      `,
      [selectedIds],
    );
    const attached = await client.query(
      `
        UPDATE local_repository_sources
        SET attachment_state = 'attached',
            updated_at = clock_timestamp()
        WHERE id = ANY($1::uuid[])
          AND attachment_state = 'detached'
      `,
      [selectedIds],
    );
    await client.query("COMMIT");
    return (detached.rowCount ?? 0) + (attached.rowCount ?? 0);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readReferencedArtifactLocators(
  pool: DatabasePool,
): Promise<readonly string[]> {
  const result = await pool.query<{ artifact_locator: string }>(`
    SELECT artifact_locator
    FROM review_revisions
    WHERE revision_state = 'available'
    ORDER BY artifact_locator
  `);
  return result.rows.map(({ artifact_locator }) => artifact_locator);
}

export async function withArtifactLifecycleLock<T>(
  pool: DatabasePool,
  operation: (lockedPool: DatabasePool) => Promise<T> | T,
): Promise<T> {
  return withArtifactSessionLock(
    pool,
    "SELECT pg_advisory_lock(hashtextextended('kestrel-artifact-lifecycle', 0))",
    "SELECT pg_advisory_unlock(hashtextextended('kestrel-artifact-lifecycle', 0)) AS unlocked",
    operation,
  );
}

export async function withArtifactAcquisitionLock<T>(
  pool: DatabasePool,
  operation: (lockedPool: DatabasePool) => Promise<T> | T,
): Promise<T> {
  return withArtifactSessionLock(
    pool,
    "SELECT pg_advisory_lock(hashtextextended('kestrel-artifact-lifecycle', 0))",
    "SELECT pg_advisory_unlock(hashtextextended('kestrel-artifact-lifecycle', 0)) AS unlocked",
    operation,
  );
}

async function withArtifactSessionLock<T>(
  pool: DatabasePool,
  lockStatement: string,
  unlockStatement: string,
  operation: (lockedPool: DatabasePool) => Promise<T> | T,
): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  let destroyClient = false;
  try {
    try {
      await client.query(lockStatement);
    } catch (error) {
      destroyClient = true;
      throw error;
    }
    locked = true;
    const lockedPool = borrowPoolClient(client, () => {
      destroyClient = true;
    });
    return await operation(lockedPool);
  } finally {
    if (locked) {
      try {
        const result = await client.query<{ unlocked: boolean }>(unlockStatement);
        if (result.rows[0]?.unlocked !== true) destroyClient = true;
      } catch {
        destroyClient = true;
      }
    }
    if (destroyClient) {
      client.release(true);
    } else {
      client.release();
    }
  }
}

function borrowPoolClient(client: PoolClient, destroy: () => void): DatabasePool {
  const query = client.query.bind(client);
  const borrowedClient = {
    query,
    release: (shouldDestroy?: boolean) => {
      if (shouldDestroy === true) destroy();
    },
  } as unknown as PoolClient;
  return {
    connect: () => Promise.resolve(borrowedClient),
    query,
  } as unknown as DatabasePool;
}
