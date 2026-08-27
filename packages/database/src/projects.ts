import type { PoolClient } from "pg";

import {
  ProjectInboxSchema,
  ProjectUpsertedSchema,
  type ChangeIntent,
  type LocalRepositorySource,
  type ProviderObservedChangeProposal,
  type Project,
  type ProjectInbox,
  type ProjectUpserted,
  type RepositorySnapshot,
  type ReviewRevision,
} from "@kestrel/contracts";

import { appendAuditRecordInTransaction } from "./audit.js";
import type { DatabasePool } from "./pool.js";
import { lockGitHubRepositoryIdentity } from "./provider-identity.js";

export interface ProjectDatabaseRow {
  author_login_snapshot: string | null;
  author_provider_id: string | null;
  base_object_id: string;
  base_ref_snapshot: string;
  created_at: Date;
  head_object_id: string;
  head_ref_snapshot: string;
  id: string;
  observed_at: Date | null;
  proposal_canonical_url: string | null;
  proposal_id: string;
  proposal_number: string | null;
  proposal_provider_id: string | null;
  proposal_state: "closed" | "merged" | "open" | "unknown" | null;
  proposal_title: string;
  provider: string | null;
  provider_repository_id: string | null;
  provider_observation_kind: string | null;
  repository_canonical_url_snapshot: string | null;
  repository_name_snapshot: string | null;
  repository_owner_snapshot: string | null;
  updated_at: Date;
  source_availability?: "available" | "not_acquired" | "unavailable";
  local_source_id?: string | null;
  local_repository_id?: string | null;
  local_display_name?: string | null;
  local_source_state?: "attached" | "detached" | null;
  local_object_format?: "sha1" | "sha256" | null;
  local_source_created_at?: Date | null;
  local_source_updated_at?: Date | null;
  proposal_kind?: "local" | "provider_observed";
  proposal_created_at?: Date;
  proposal_updated_at?: Date;
  intent_id?: string | null;
  intent_version?: string | null;
  intent_text?: string | null;
  intent_created_at?: Date | null;
  revision_id?: string | null;
  revision_state?: "acquiring" | "available" | "unavailable" | null;
  revision_object_format?: "sha1" | "sha256" | null;
  revision_base_ref?: string | null;
  revision_base_object_id?: string | null;
  revision_head_ref?: string | null;
  revision_head_object_id?: string | null;
  revision_object_count?: string | null;
  revision_retained_bytes?: string | null;
  revision_failure_reason?: ReviewRevision["failureReason"];
  revision_created_at?: Date | null;
  revision_available_at?: Date | null;
}

export interface PublicGitHubProjectObservation {
  proposal: Omit<
    ProviderObservedChangeProposal,
    "id" | "observedAt" | "kind" | "changeIntent" | "reviewRevisions"
  >;
  repository: RepositorySnapshot;
}

export interface UpsertPublicGitHubProjectInput {
  actorId: string;
  correlationId: string;
  observation: PublicGitHubProjectObservation;
}

function mapAuthor(row: ProjectDatabaseRow): ProviderObservedChangeProposal["author"] {
  if (row.author_login_snapshot === null && row.author_provider_id === null) {
    return null;
  }
  if (row.author_login_snapshot === null || row.author_provider_id === null) {
    throw new Error("Change Proposal author identity is incomplete");
  }
  return { login: row.author_login_snapshot, providerId: row.author_provider_id };
}

function mapProviderRepository(row: ProjectDatabaseRow): RepositorySnapshot | null {
  if (row.provider_observation_kind !== null && row.provider_observation_kind !== "public_github") {
    throw new Error(`Unsupported Provider Observation kind: ${row.provider_observation_kind}`);
  }
  const values = [
    row.provider_repository_id,
    row.repository_owner_snapshot,
    row.repository_name_snapshot,
    row.repository_canonical_url_snapshot,
  ];
  if (values.every((value) => value === null)) {
    if (row.provider !== null || row.provider_observation_kind !== null) {
      throw new Error("Project Provider Observation identity is incomplete");
    }
    return null;
  }
  if (
    row.provider !== "github" ||
    row.provider_observation_kind !== "public_github" ||
    row.provider_repository_id === null ||
    row.repository_owner_snapshot === null ||
    row.repository_name_snapshot === null ||
    row.repository_canonical_url_snapshot === null
  ) {
    throw new Error("Project Provider Observation identity is incomplete");
  }
  return {
    canonicalUrl: row.repository_canonical_url_snapshot,
    name: row.repository_name_snapshot,
    owner: row.repository_owner_snapshot,
    providerId: row.provider_repository_id,
  };
}

function mapLocalSource(row: ProjectDatabaseRow): LocalRepositorySource | null {
  const values = [
    row.local_source_id,
    row.local_repository_id,
    row.local_display_name,
    row.local_source_state,
    row.local_object_format,
    row.local_source_created_at,
    row.local_source_updated_at,
  ];
  if (values.every((value) => value === undefined || value === null)) {
    return null;
  }
  if (
    row.local_source_id == null ||
    row.local_repository_id == null ||
    row.local_display_name == null ||
    row.local_source_state == null ||
    row.local_object_format == null ||
    row.local_source_created_at == null ||
    row.local_source_updated_at == null
  ) {
    throw new Error("Local Repository Source identity is incomplete");
  }
  return {
    createdAt: row.local_source_created_at.toISOString(),
    displayName: row.local_display_name,
    id: row.local_source_id,
    objectFormat: row.local_object_format,
    repositoryId: row.local_repository_id,
    state: row.local_source_state,
    updatedAt: row.local_source_updated_at.toISOString(),
  };
}

function mapChangeIntent(row: ProjectDatabaseRow): ChangeIntent | null {
  const values = [row.intent_id, row.intent_version, row.intent_text, row.intent_created_at];
  if (values.every((value) => value === undefined || value === null)) {
    return null;
  }
  if (
    row.intent_id == null ||
    row.intent_version == null ||
    row.intent_text == null ||
    row.intent_created_at == null
  ) {
    throw new Error("Change Intent is incomplete");
  }
  return {
    createdAt: row.intent_created_at.toISOString(),
    id: row.intent_id,
    text: row.intent_text,
    version: Number(row.intent_version),
  };
}

function mapReviewRevision(row: ProjectDatabaseRow): ReviewRevision | null {
  if (row.revision_id == null) {
    return null;
  }
  if (
    row.revision_state == null ||
    row.revision_object_format == null ||
    row.revision_created_at == null ||
    row.revision_base_ref == null ||
    row.revision_base_object_id == null ||
    row.revision_head_ref == null ||
    row.revision_head_object_id == null
  ) {
    throw new Error("Review Revision is incomplete");
  }
  return {
    availableAt: row.revision_available_at?.toISOString() ?? null,
    base: {
      objectId: row.revision_base_object_id,
      ref: row.revision_base_ref,
    },
    createdAt: row.revision_created_at.toISOString(),
    failureReason: row.revision_failure_reason ?? null,
    head: {
      objectId: row.revision_head_object_id,
      ref: row.revision_head_ref,
    },
    id: row.revision_id,
    objectCount: row.revision_object_count == null ? null : Number(row.revision_object_count),
    objectFormat: row.revision_object_format,
    retainedBytes: row.revision_retained_bytes == null ? null : Number(row.revision_retained_bytes),
    state: row.revision_state,
  };
}

function appendRevision(
  proposal: Project["changeProposals"][number],
  revision: ReviewRevision | null,
): void {
  if (revision === null) {
    return;
  }
  const revisions = proposal.reviewRevisions;
  if (!revisions.some(({ id }) => id === revision.id)) {
    revisions.push(revision);
  }
  proposal.reviewRevisions = revisions;
}

export function mapProjectRows(rows: readonly ProjectDatabaseRow[]): ProjectInbox {
  const projects = new Map<string, Project>();
  for (const row of rows) {
    const repository = mapProviderRepository(row);
    const localSource = mapLocalSource(row);
    let project = projects.get(row.id);
    if (project === undefined) {
      project = {
        changeProposals: [],
        createdAt: row.created_at.toISOString(),
        id: row.id,
        modelAccess: "not_configured",
        providerObservation:
          repository === null
            ? null
            : { authentication: "none", kind: "public_github", refresh: "manual" },
        repository,
        localRepositorySource: localSource,
        sourceAvailability: row.source_availability ?? "not_acquired",
        updatedAt: row.updated_at.toISOString(),
      };
      projects.set(row.id, project);
    }
    let proposal = project.changeProposals.find(({ id }) => id === row.proposal_id);
    const changeIntent = mapChangeIntent(row);
    if (proposal === undefined) {
      if ((row.proposal_kind ?? "provider_observed") === "local") {
        if (changeIntent === null) {
          throw new Error("Local Change Proposal requires Change Intent");
        }
        proposal = {
          base: { objectId: row.base_object_id, ref: row.base_ref_snapshot },
          changeIntent,
          createdAt: (row.proposal_created_at ?? row.created_at).toISOString(),
          head: { objectId: row.head_object_id, ref: row.head_ref_snapshot },
          id: row.proposal_id,
          kind: "local",
          reviewRevisions: [],
          title: row.proposal_title,
          updatedAt: (row.proposal_updated_at ?? row.updated_at).toISOString(),
        };
      } else {
        if (
          row.proposal_provider_id === null ||
          row.proposal_number === null ||
          row.proposal_canonical_url === null ||
          row.proposal_state === null ||
          row.observed_at === null
        ) {
          throw new Error("Provider Change Proposal identity is incomplete");
        }
        proposal = {
          author: mapAuthor(row),
          base: { objectId: row.base_object_id, ref: row.base_ref_snapshot },
          canonicalUrl: row.proposal_canonical_url,
          changeIntent,
          head: { objectId: row.head_object_id, ref: row.head_ref_snapshot },
          id: row.proposal_id,
          kind: "provider_observed",
          number: Number(row.proposal_number),
          observedAt: row.observed_at.toISOString(),
          proposalState: row.proposal_state,
          providerId: row.proposal_provider_id,
          reviewRevisions: [],
          title: row.proposal_title,
        };
      }
      project.changeProposals.push(proposal);
    }
    appendRevision(proposal, mapReviewRevision(row));
  }
  return ProjectInboxSchema.parse({ schemaVersion: 1, projects: [...projects.values()] });
}

function projectRowsSelect(requiredRevisionId: "NULL::uuid" | "$2::uuid"): string {
  return `
  SELECT p.id,
         p.provider_observation_kind,
         p.provider,
         p.provider_repository_id,
         p.repository_owner_snapshot,
         p.repository_name_snapshot,
         p.repository_canonical_url_snapshot,
         p.source_availability,
         p.created_at,
         p.updated_at,
         lrs.id AS local_source_id,
         lrs.repository_id AS local_repository_id,
         lrs.display_name_snapshot AS local_display_name,
         lrs.attachment_state AS local_source_state,
         lrs.object_format AS local_object_format,
         lrs.created_at AS local_source_created_at,
         lrs.updated_at AS local_source_updated_at,
         cp.id AS proposal_id,
         cp.proposal_kind,
         cp.provider_proposal_id AS proposal_provider_id,
         cp.provider_number AS proposal_number,
         cp.title_snapshot AS proposal_title,
         cp.canonical_url_snapshot AS proposal_canonical_url,
         cp.proposal_state,
         cp.base_ref_snapshot,
         cp.base_object_id,
         cp.head_ref_snapshot,
         cp.head_object_id,
         cp.author_provider_id,
         cp.author_login_snapshot,
         cp.observed_at,
         cp.created_at AS proposal_created_at,
         cp.updated_at AS proposal_updated_at,
         ci.id AS intent_id,
         ci.version AS intent_version,
         ci.intent_text,
         ci.created_at AS intent_created_at,
         rr.id AS revision_id,
         rr.revision_state,
         rr.object_format AS revision_object_format,
         rr.base_ref_snapshot AS revision_base_ref,
         rr.base_object_id AS revision_base_object_id,
         rr.head_ref_snapshot AS revision_head_ref,
         rr.head_object_id AS revision_head_object_id,
         rr.object_count AS revision_object_count,
         rr.retained_bytes AS revision_retained_bytes,
         rr.failure_reason AS revision_failure_reason,
         rr.created_at AS revision_created_at,
         rr.available_at AS revision_available_at
  FROM projects AS p
  INNER JOIN change_proposals AS cp
    ON cp.project_id = p.id
   AND p.canonical_project_id IS NULL
   AND cp.canonical_change_proposal_id IS NULL
  LEFT JOIN LATERAL (
    SELECT source.id,
           source.repository_id,
           source.display_name_snapshot,
           source.attachment_state,
           source.object_format,
           source.created_at,
           source.updated_at
    FROM local_repository_sources AS source
    WHERE source.project_id = p.id
       OR source.project_id IN (
            SELECT alias_project.id
            FROM projects AS alias_project
            WHERE alias_project.canonical_project_id = p.id
          )
    ORDER BY (source.attachment_state = 'attached') DESC,
             source.updated_at DESC,
             source.id DESC
    LIMIT 1
  ) AS lrs ON true
  LEFT JOIN LATERAL (
    SELECT intent.id, intent.version, intent.intent_text, intent.created_at
    FROM change_intents AS intent
    INNER JOIN change_proposals AS intent_proposal
      ON intent_proposal.id = intent.change_proposal_id
    WHERE intent_proposal.id = cp.id
       OR intent_proposal.canonical_change_proposal_id = cp.id
    ORDER BY intent.version DESC, intent.created_at DESC, intent.id DESC
    LIMIT 1
  ) AS ci ON true
  LEFT JOIN LATERAL (
    SELECT revision.id,
           revision.revision_state,
           revision.object_format,
           revision.base_ref_snapshot,
           revision.base_object_id,
           revision.head_ref_snapshot,
           revision.head_object_id,
           revision.object_count,
           revision.retained_bytes,
           revision.failure_reason,
           revision.created_at,
           revision.available_at
    FROM review_revisions AS revision
    INNER JOIN change_proposals AS revision_proposal
      ON revision_proposal.id = revision.change_proposal_id
    WHERE revision_proposal.id = cp.id
       OR revision_proposal.canonical_change_proposal_id = cp.id
    ORDER BY (revision.id = ${requiredRevisionId}) DESC NULLS LAST,
             revision.created_at DESC,
             revision.id
    LIMIT 20
  ) AS rr ON true
`;
}

export async function readProjectInbox(pool: DatabasePool): Promise<ProjectInbox> {
  const result = await pool.query<ProjectDatabaseRow>(`${projectRowsSelect("NULL::uuid")}
    ORDER BY p.created_at, p.id, cp.provider_number NULLS LAST, cp.created_at, cp.id,
             rr.created_at DESC NULLS LAST, rr.id
    LIMIT 200001
  `);
  return mapProjectRows(result.rows);
}

export async function readProjectInTransaction(
  client: PoolClient,
  projectId: string,
): Promise<Project> {
  const result = await client.query<ProjectDatabaseRow>(
    `${projectRowsSelect("$2::uuid")}
      WHERE p.id = (
        SELECT COALESCE(requested.canonical_project_id, requested.id)
        FROM projects AS requested
        WHERE requested.id = $1
      )
      ORDER BY cp.provider_number NULLS LAST, cp.created_at, cp.id,
               rr.created_at DESC NULLS LAST, rr.id
      LIMIT 2001
    `,
    [projectId, null],
  );
  const inbox = mapProjectRows(result.rows);
  const project = inbox.projects[0];
  if (project === undefined || inbox.projects.length !== 1) {
    throw new Error("Public GitHub Project could not be read after persistence");
  }
  return project;
}

export async function readProject(
  pool: DatabasePool,
  projectId: string,
  requiredRevisionId?: string,
): Promise<Project> {
  const result = await pool.query<ProjectDatabaseRow>(
    `${projectRowsSelect("$2::uuid")}
      WHERE p.id = (
        SELECT COALESCE(requested.canonical_project_id, requested.id)
        FROM projects AS requested
        WHERE requested.id = $1
      )
      ORDER BY cp.provider_number NULLS LAST, cp.created_at, cp.id,
               rr.created_at DESC NULLS LAST, rr.id
      LIMIT 2001
    `,
    [projectId, requiredRevisionId ?? null],
  );
  const inbox = mapProjectRows(result.rows);
  const project = inbox.projects[0];
  if (project === undefined || inbox.projects.length !== 1) {
    throw new Error("Project could not be read after Review Revision persistence");
  }
  return project;
}

async function readInstallationId(client: PoolClient): Promise<string> {
  const result = await client.query<{ id: string }>(`
    SELECT id FROM installations ORDER BY created_at, id LIMIT 1
  `);
  const id = result.rows[0]?.id;
  if (result.rowCount !== 1 || id === undefined) {
    throw new Error("Public GitHub Project upsert did not resolve one Installation");
  }
  return id;
}

async function resolveProviderProject(
  client: PoolClient,
  installationId: string,
  observation: PublicGitHubProjectObservation,
): Promise<string> {
  const { repository } = observation;
  await lockGitHubRepositoryIdentity(client, repository);
  const existing = await client.query<{ id: string }>(
    `
      SELECT id
      FROM projects
      WHERE installation_id = $1
        AND canonical_project_id IS NULL
        AND provider = 'github'
        AND provider_repository_id = $2
      FOR UPDATE
    `,
    [installationId, repository.providerId],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId !== undefined) {
    await client.query(
      `
        UPDATE projects
        SET repository_owner_snapshot = $2,
            repository_name_snapshot = $3,
            repository_canonical_url_snapshot = $4,
            updated_at = clock_timestamp()
        WHERE id = $1
      `,
      [existingId, repository.owner, repository.name, repository.canonicalUrl],
    );
    return existingId;
  }

  const localMatches = await client.query<{ project_id: string }>(
    `
      SELECT p.id AS project_id
      FROM projects AS p
      WHERE p.installation_id = $1
        AND p.canonical_project_id IS NULL
        AND p.provider IS NULL
        AND EXISTS (
          SELECT 1
          FROM local_repository_sources AS source
          WHERE source.project_id = p.id
            AND lower(source.github_owner_snapshot) = lower($2)
            AND lower(source.github_name_snapshot) = lower($3)
        )
      ORDER BY p.id
      LIMIT 2
      FOR UPDATE OF p
    `,
    [installationId, repository.owner, repository.name],
  );
  if ((localMatches.rowCount ?? 0) > 1) {
    throw new Error("Public GitHub observation matches more than one local Project");
  }
  const localMatch = localMatches.rows[0];
  if (localMatch !== undefined) {
    const adopted = await client.query(
      `
        UPDATE projects
        SET provider_observation_kind = 'public_github',
            provider = 'github',
            provider_repository_id = $2,
            repository_owner_snapshot = $3,
            repository_name_snapshot = $4,
            repository_canonical_url_snapshot = $5,
            updated_at = clock_timestamp()
        WHERE id = $1 AND provider IS NULL
      `,
      [
        localMatch.project_id,
        repository.providerId,
        repository.owner,
        repository.name,
        repository.canonicalUrl,
      ],
    );
    if (adopted.rowCount !== 1) {
      throw new Error("Local Project provider enrichment did not affect one row");
    }
    return localMatch.project_id;
  }

  const inserted = await client.query<{ id: string }>(
    `
      INSERT INTO projects (
        installation_id,
        provider_observation_kind,
        provider,
        provider_repository_id,
        repository_owner_snapshot,
        repository_name_snapshot,
        repository_canonical_url_snapshot
      )
      VALUES ($1, 'public_github', 'github', $2, $3, $4, $5)
      ON CONFLICT (installation_id, provider, provider_repository_id)
      DO UPDATE SET repository_owner_snapshot = EXCLUDED.repository_owner_snapshot,
                    repository_name_snapshot = EXCLUDED.repository_name_snapshot,
                    repository_canonical_url_snapshot = EXCLUDED.repository_canonical_url_snapshot,
                    updated_at = clock_timestamp()
      RETURNING id
    `,
    [
      installationId,
      repository.providerId,
      repository.owner,
      repository.name,
      repository.canonicalUrl,
    ],
  );
  const projectId = inserted.rows[0]?.id;
  if (inserted.rowCount !== 1 || projectId === undefined) {
    throw new Error("Public GitHub Project upsert did not resolve one Installation");
  }
  return projectId;
}

async function upsertProviderProposal(
  client: PoolClient,
  projectId: string,
  proposal: PublicGitHubProjectObservation["proposal"],
): Promise<void> {
  const existing = await client.query<{ id: string }>(
    `
      SELECT id
      FROM change_proposals
      WHERE project_id = $1
        AND proposal_kind = 'provider_observed'
        AND canonical_change_proposal_id IS NULL
        AND provider_proposal_id = $2
      FOR UPDATE
    `,
    [projectId, proposal.providerId],
  );
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
    [projectId, proposal.base.objectId, proposal.head.objectId],
  );
  const existingProviderProposalId = existing.rows[0]?.id ?? null;
  const localProposalId = localMatch.rows[0]?.id ?? null;
  let proposalId = existingProviderProposalId ?? localProposalId;
  if (
    existingProviderProposalId !== null &&
    localProposalId !== null &&
    existingProviderProposalId !== localProposalId
  ) {
    await client.query(
      `
        UPDATE change_proposals
        SET canonical_change_proposal_id = $2,
            updated_at = clock_timestamp()
        WHERE canonical_change_proposal_id = $1
      `,
      [existingProviderProposalId, localProposalId],
    );
    const aliased = await client.query(
      `
        UPDATE change_proposals
        SET proposal_kind = 'alias',
            canonical_change_proposal_id = $2,
            updated_at = clock_timestamp()
        WHERE id = $1
          AND proposal_kind = 'provider_observed'
      `,
      [existingProviderProposalId, localProposalId],
    );
    if (aliased.rowCount !== 1) {
      throw new Error("Provider Change Proposal cannot be reconciled with local history");
    }
    proposalId = localProposalId;
  }
  const parameters = [
    projectId,
    proposal.providerId,
    proposal.number,
    proposal.title,
    proposal.canonicalUrl,
    proposal.proposalState,
    proposal.base.ref,
    proposal.base.objectId,
    proposal.head.ref,
    proposal.head.objectId,
    proposal.author?.providerId ?? null,
    proposal.author?.login ?? null,
  ];
  if (proposalId !== null) {
    const updated = await client.query(
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
            observed_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE id = $13 AND project_id = $1
      `,
      [...parameters, proposalId],
    );
    if (updated.rowCount !== 1) {
      throw new Error("Public GitHub Change Proposal enrichment did not affect one row");
    }
    return;
  }
  const inserted = await client.query(
    `
      INSERT INTO change_proposals (
        project_id,
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
        author_login_snapshot
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `,
    parameters,
  );
  if (inserted.rowCount !== 1) {
    throw new Error("Public GitHub Change Proposal upsert did not affect one row");
  }
}

export async function upsertPublicGitHubProject(
  pool: DatabasePool,
  input: UpsertPublicGitHubProjectInput,
): Promise<ProjectUpserted> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const installationId = await readInstallationId(client);
    const projectId = await resolveProviderProject(client, installationId, input.observation);
    const proposal = input.observation.proposal;
    await upsertProviderProposal(client, projectId, proposal);

    const project = await readProjectInTransaction(client, projectId);
    await appendAuditRecordInTransaction(client, {
      actorId: input.actorId,
      actorType: "operator",
      causationId: null,
      correlationId: input.correlationId,
      denialReason: null,
      eventType: "project.public_github_observed",
      facts: {
        proposalNumber: proposal.number,
        providerObservationKind: "public_github",
      },
      outcome: "succeeded",
      targetId: projectId,
      targetType: "project",
    });
    await client.query("COMMIT");
    return ProjectUpsertedSchema.parse({ schemaVersion: 1, project });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
