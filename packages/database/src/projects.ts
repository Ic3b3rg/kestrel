import type { PoolClient } from "pg";

import {
  ProjectInboxSchema,
  ProjectUpsertedSchema,
  type Project,
  type ProjectInbox,
  type ProjectUpserted,
} from "@kestrel/contracts";

import { appendAuditRecordInTransaction } from "./audit.js";
import type { DatabasePool } from "./pool.js";

export interface ProjectDatabaseRow {
  author_login_snapshot: string | null;
  author_provider_id: string | null;
  base_object_id: string;
  base_ref_snapshot: string;
  created_at: Date;
  head_object_id: string;
  head_ref_snapshot: string;
  id: string;
  observed_at: Date;
  proposal_canonical_url: string;
  proposal_id: string;
  proposal_number: string;
  proposal_provider_id: string;
  proposal_state: "closed" | "merged" | "open" | "unknown";
  proposal_title: string;
  provider: string;
  provider_repository_id: string;
  repository_access_kind: string;
  repository_canonical_url_snapshot: string;
  repository_name_snapshot: string;
  repository_owner_snapshot: string;
  updated_at: Date;
}

type ChangeProposal = Project["changeProposals"][number];

export interface PublicGitHubProjectObservation {
  proposal: Omit<ChangeProposal, "id" | "observedAt">;
  repository: Project["repository"];
}

export interface UpsertPublicGitHubProjectInput {
  actorId: string;
  correlationId: string;
  observation: PublicGitHubProjectObservation;
}

function mapAuthor(row: ProjectDatabaseRow): ChangeProposal["author"] {
  if (row.author_login_snapshot === null && row.author_provider_id === null) {
    return null;
  }
  if (row.author_login_snapshot === null || row.author_provider_id === null) {
    throw new Error("Change Proposal author identity is incomplete");
  }
  return { login: row.author_login_snapshot, providerId: row.author_provider_id };
}

export function mapProjectRows(rows: readonly ProjectDatabaseRow[]): ProjectInbox {
  const projects = new Map<string, Project>();
  for (const row of rows) {
    if (row.repository_access_kind !== "public_github" || row.provider !== "github") {
      throw new Error(`Unsupported Repository Access kind: ${row.repository_access_kind}`);
    }
    let project = projects.get(row.id);
    if (project === undefined) {
      project = {
        changeProposals: [],
        createdAt: row.created_at.toISOString(),
        id: row.id,
        modelAccess: "not_configured",
        providerContext: "public_pull_request",
        repository: {
          canonicalUrl: row.repository_canonical_url_snapshot,
          name: row.repository_name_snapshot,
          owner: row.repository_owner_snapshot,
          providerId: row.provider_repository_id,
        },
        repositoryAccess: {
          authentication: "none",
          kind: "public_github",
          synchronization: "manual",
        },
        sourceAvailability: "not_acquired",
        updatedAt: row.updated_at.toISOString(),
      };
      projects.set(row.id, project);
    }
    project.changeProposals.push({
      author: mapAuthor(row),
      base: { objectId: row.base_object_id, ref: row.base_ref_snapshot },
      canonicalUrl: row.proposal_canonical_url,
      head: { objectId: row.head_object_id, ref: row.head_ref_snapshot },
      id: row.proposal_id,
      number: Number(row.proposal_number),
      observedAt: row.observed_at.toISOString(),
      proposalState: row.proposal_state,
      providerId: row.proposal_provider_id,
      title: row.proposal_title,
    });
  }
  return ProjectInboxSchema.parse({ schemaVersion: 1, projects: [...projects.values()] });
}

const PROJECT_ROWS_SELECT = `
  SELECT p.id,
         p.repository_access_kind,
         p.provider,
         p.provider_repository_id,
         p.repository_owner_snapshot,
         p.repository_name_snapshot,
         p.repository_canonical_url_snapshot,
         p.created_at,
         p.updated_at,
         cp.id AS proposal_id,
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
         cp.observed_at
  FROM projects AS p
  INNER JOIN change_proposals AS cp ON cp.project_id = p.id
`;

export async function readProjectInbox(pool: DatabasePool): Promise<ProjectInbox> {
  const result = await pool.query<ProjectDatabaseRow>(`${PROJECT_ROWS_SELECT}
    ORDER BY p.created_at, p.id, cp.provider_number, cp.id
    LIMIT 10001
  `);
  return mapProjectRows(result.rows);
}

async function readProject(client: PoolClient, projectId: string): Promise<Project> {
  const result = await client.query<ProjectDatabaseRow>(
    `${PROJECT_ROWS_SELECT}
      WHERE p.id = $1
      ORDER BY cp.provider_number, cp.id
      LIMIT 101
    `,
    [projectId],
  );
  const inbox = mapProjectRows(result.rows);
  const project = inbox.projects[0];
  if (project === undefined || inbox.projects.length !== 1) {
    throw new Error("Public GitHub Project could not be read after persistence");
  }
  return project;
}

export async function upsertPublicGitHubProject(
  pool: DatabasePool,
  input: UpsertPublicGitHubProjectInput,
): Promise<ProjectUpserted> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const projectResult = await client.query<{ id: string }>(
      `
        INSERT INTO projects (
          installation_id,
          repository_access_kind,
          provider,
          provider_repository_id,
          repository_owner_snapshot,
          repository_name_snapshot,
          repository_canonical_url_snapshot
        )
        SELECT id, 'public_github', 'github', $1, $2, $3, $4
        FROM installations
        ON CONFLICT (installation_id, provider, provider_repository_id)
        DO UPDATE SET repository_owner_snapshot = EXCLUDED.repository_owner_snapshot,
                      repository_name_snapshot = EXCLUDED.repository_name_snapshot,
                      repository_canonical_url_snapshot = EXCLUDED.repository_canonical_url_snapshot,
                      updated_at = clock_timestamp()
        RETURNING id
      `,
      [
        input.observation.repository.providerId,
        input.observation.repository.owner,
        input.observation.repository.name,
        input.observation.repository.canonicalUrl,
      ],
    );
    const projectId = projectResult.rows[0]?.id;
    if (projectResult.rowCount !== 1 || projectId === undefined) {
      throw new Error("Public GitHub Project upsert did not resolve one Installation");
    }

    const proposal = input.observation.proposal;
    const proposalResult = await client.query(
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
        ON CONFLICT (project_id, provider_proposal_id)
        DO UPDATE SET provider_number = EXCLUDED.provider_number,
                      title_snapshot = EXCLUDED.title_snapshot,
                      canonical_url_snapshot = EXCLUDED.canonical_url_snapshot,
                      proposal_state = EXCLUDED.proposal_state,
                      base_ref_snapshot = EXCLUDED.base_ref_snapshot,
                      base_object_id = EXCLUDED.base_object_id,
                      head_ref_snapshot = EXCLUDED.head_ref_snapshot,
                      head_object_id = EXCLUDED.head_object_id,
                      author_provider_id = EXCLUDED.author_provider_id,
                      author_login_snapshot = EXCLUDED.author_login_snapshot,
                      observed_at = clock_timestamp(),
                      updated_at = clock_timestamp()
      `,
      [
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
      ],
    );
    if (proposalResult.rowCount !== 1) {
      throw new Error("Public GitHub Change Proposal upsert did not affect one row");
    }

    const project = await readProject(client, projectId);
    await appendAuditRecordInTransaction(client, {
      actorId: input.actorId,
      actorType: "operator",
      causationId: null,
      correlationId: input.correlationId,
      denialReason: null,
      eventType: "project.public_github_observed",
      facts: {
        proposalNumber: proposal.number,
        repositoryAccessKind: "public_github",
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
