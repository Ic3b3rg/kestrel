import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  FactoryGitHubIssueSchema,
  FactoryGitHubRepositorySchema,
  FactoryIssuePublicationSchema,
  FeaturePlanDocumentSchema,
  type FactoryGitHubIssue,
  type FactoryGitHubRepository,
  type FactoryProviderFailure,
  type FeaturePlanDocument,
} from "@kestrel/contracts";
import type { DatabasePool } from "./pool.js";
import type { DiagnosticJobSender } from "./diagnostics.js";
import { FACTORY_PUBLICATION_QUEUE, pgBossDatabase } from "./pg-boss.js";
import { FactoryError, withFactoryFeature, type FeatureRow } from "./factory-planning.js";
import { assertFactoryIssueAvailable, factoryImportsFor } from "./factory-issue-imports.js";

export interface FactoryPublicationIdentity {
  repository: FactoryGitHubRepository;
  account: string;
}
interface PublicationRow {
  feature_id: string;
  state: "queued" | "running" | "blocked" | "published";
  identity: FactoryPublicationIdentity | null;
  coordinates: { owner: string; name: string } | null;
  feature_url: string | null;
  failure: FactoryProviderFailure | null;
  job_id: string;
  attempt_id: string | null;
  started_at: Date | null;
  retry_after: Date | null;
  updated_at: Date;
}
export interface FactoryPublicationItemRow {
  work_item_id: string;
  feature_id: string;
  key: string;
  position: number;
  issue_operation_id: string;
  issue_attempted: boolean;
  issue: FactoryGitHubIssue | null;
  comment_operation_id: string;
  comment_attempted: boolean;
  comment_id: string | null;
  dependency_mode: "native" | "textual" | null;
  failure: FactoryProviderFailure | null;
  published_at: Date | null;
}
export interface ClaimedFactoryPublication {
  featureId: string;
  projectId: string;
  title: string;
  version: number;
  attemptId: string;
  plan: FeaturePlanDocument;
  identity: FactoryPublicationIdentity | null;
  coordinates: { owner: string; name: string } | null;
  featureUrl: string | null;
  item: FactoryPublicationItemRow;
  items: FactoryPublicationItemRow[];
}

async function publicationItems(client: Pick<PoolClient, "query">, featureId: string) {
  const result = await client.query<FactoryPublicationItemRow>(
    `SELECT publication.*, item.key, item.position
    FROM factory_issue_publications publication JOIN factory_work_items item ON item.id = publication.work_item_id
    WHERE publication.feature_id = $1 ORDER BY item.position`,
    [featureId],
  );
  return result.rows;
}
async function publicationView(client: PoolClient, feature: FeatureRow) {
  const result = await client.query<PublicationRow>(
    "SELECT * FROM factory_feature_publications WHERE feature_id = $1",
    [feature.id],
  );
  const publication = result.rows[0];
  const items = await publicationItems(client, feature.id);
  return FactoryIssuePublicationSchema.parse({
    schemaVersion: 1,
    featureId: feature.id,
    state:
      feature.state === "cancelled"
        ? "cancelled"
        : publication === undefined
          ? "not_approved"
          : publication.state === "queued"
            ? "pending"
            : publication.state === "running"
              ? "publishing"
              : publication.state,
    failure: publication?.failure ?? null,
    updatedAt: publication?.updated_at.toISOString() ?? null,
    items: items.map((item) => ({
      workItemId: item.work_item_id,
      key: item.key,
      state:
        item.published_at !== null
          ? "published"
          : (item.issue_attempted && item.issue === null) ||
              (item.comment_attempted && item.comment_id === null)
            ? "reconciling"
            : item.failure !== null
              ? "blocked"
              : publication?.state === "running"
                ? "publishing"
                : "pending",
      issue: item.issue === null ? null : { number: item.issue.number, url: item.issue.url },
      failure: item.failure,
      dependencyMode: item.dependency_mode,
    })),
  });
}

export function readFactoryIssuePublication(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
) {
  return withFactoryFeature(pool, projectId, featureId, publicationView);
}

/** Written in the approval transaction, then drained by the durable job dispatcher. */
export async function initializeFactoryPublication(
  client: PoolClient,
  featureId: string,
  plan: FeaturePlanDocument,
  featureUrl?: string,
) {
  await client.query(
    `INSERT INTO factory_feature_publications (feature_id, feature_url, coordinates)
    SELECT feature.id, $2, (SELECT jsonb_build_object('owner', source.github_owner_snapshot, 'name', source.github_name_snapshot)
      FROM local_repository_sources source JOIN projects project ON project.id = source.project_id
      WHERE COALESCE(project.canonical_project_id, project.id) = COALESCE(owner.canonical_project_id, owner.id)
        AND source.attachment_state = 'attached' AND source.github_owner_snapshot IS NOT NULL
        AND source.github_name_snapshot IS NOT NULL LIMIT 1)
    FROM factory_features feature JOIN projects owner ON owner.id = feature.project_id WHERE feature.id = $1`,
    [featureId, featureUrl ?? null],
  );
  const imports = await factoryImportsFor(client, featureId);
  const items = await client.query<{ id: string; key: string }>(
    "SELECT id, key FROM factory_work_items WHERE feature_id = $1 ORDER BY position",
    [featureId],
  );
  for (const item of items.rows) {
    const definition = plan.workItems.find(({ key }) => key === item.key);
    if (definition === undefined) throw new Error("Approved item is missing");
    const imported = imports.find(({ id }) => id === definition.importedIssueId);
    await client.query(
      "INSERT INTO factory_issue_publications (work_item_id, feature_id, issue) VALUES ($1,$2,$3::jsonb)",
      [item.id, featureId, imported === undefined ? null : JSON.stringify(imported.issue)],
    );
  }
  for (const item of items.rows) {
    for (const key of plan.workItems.find((definition) => definition.key === item.key)?.dependsOn ??
      []) {
      const blocker = items.rows.find((candidate) => candidate.key === key);
      if (blocker === undefined) throw new Error("Approved dependency is missing");
      await client.query(
        "INSERT INTO factory_provider_dependencies (work_item_id, blocking_work_item_id) VALUES ($1,$2)",
        [item.id, blocker.id],
      );
    }
  }
}

export function retryFactoryPublication(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  requestId: string,
) {
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    const duplicate = await client.query(
      "SELECT 1 FROM factory_publication_retry_requests WHERE feature_id = $1 AND request_id = $2",
      [featureId, requestId],
    );
    if (duplicate.rowCount !== 0) return publicationView(client, feature);
    const current = await client.query<PublicationRow>(
      "SELECT * FROM factory_feature_publications WHERE feature_id = $1 FOR UPDATE",
      [featureId],
    );
    const publication = current.rows[0];
    if (feature.state !== "queued" || publication?.state !== "blocked")
      throw new FactoryError("conflict", "Only blocked publication can be retried");
    const retries = await client.query<{ count: string }>(
      "SELECT count(*) FROM factory_publication_retry_requests WHERE feature_id = $1",
      [featureId],
    );
    if (Number(retries.rows[0]?.count) >= 200)
      throw new FactoryError("conflict", "Publication retry limit reached");
    await client.query(
      "INSERT INTO factory_publication_retry_requests (feature_id, request_id) VALUES ($1,$2)",
      [featureId, requestId],
    );
    await client.query(
      `UPDATE factory_feature_publications SET state = 'queued', failure = NULL, job_id = $2,
      attempt_id = NULL, started_at = NULL, updated_at = clock_timestamp() WHERE feature_id = $1`,
      [featureId, randomUUID()],
    );
    await client.query(
      "UPDATE factory_issue_publications SET failure = NULL WHERE feature_id = $1 AND published_at IS NULL",
      [featureId],
    );
    await client.query(
      "INSERT INTO factory_activity (feature_id, kind, summary) VALUES ($1,'publication_retried','GitHub publication retry requested; uncertain writes will only be reconciled')",
      [featureId],
    );
    return publicationView(client, feature);
  });
}

/** Outbox rows and job identity survive a web process restart. Never replay an uncertain POST. */
export async function reconcileFactoryPublications(pool: DatabasePool, boss: DiagnosticJobSender) {
  const candidates = await pool.query<{ feature_id: string; project_id: string }>(`
    SELECT publication.feature_id, feature.project_id FROM factory_feature_publications publication
    JOIN factory_features feature ON feature.id = publication.feature_id
    WHERE feature.state = 'queued' AND (publication.state = 'queued'
      OR (publication.state = 'running' AND publication.started_at < clock_timestamp() - interval '190 seconds'))
    ORDER BY feature.created_at, feature.id LIMIT 200`);
  for (const candidate of candidates.rows) {
    await withFactoryFeature(
      pool,
      candidate.project_id,
      candidate.feature_id,
      async (client, feature) => {
        if (feature.state !== "queued") return;
        await client.query(
          `UPDATE factory_feature_publications SET state = 'queued', attempt_id = NULL,
        job_id = $2, started_at = NULL, updated_at = clock_timestamp()
        WHERE feature_id = $1 AND state = 'running' AND started_at < clock_timestamp() - interval '190 seconds'`,
          [feature.id, randomUUID()],
        );
        const result = await client.query<PublicationRow>(
          "SELECT * FROM factory_feature_publications WHERE feature_id = $1",
          [feature.id],
        );
        const publication = result.rows[0];
        if (
          publication?.state !== "queued" ||
          (publication.retry_after !== null && publication.retry_after.getTime() > Date.now())
        )
          return;
        const ended = await client.query(
          `SELECT id FROM pgboss.job WHERE name = $1 AND id = $2
          AND state IN ('failed', 'cancelled', 'completed')`,
          [FACTORY_PUBLICATION_QUEUE, publication.job_id],
        );
        if (ended.rows.length !== 0) {
          await client.query(
            `UPDATE factory_feature_publications SET state = 'blocked', failure = 'unavailable',
            updated_at = clock_timestamp() WHERE feature_id = $1`,
            [feature.id],
          );
          const item = (await publicationItems(client, feature.id)).find(
            (candidate) => candidate.published_at === null,
          );
          if (item !== undefined)
            await client.query(
              "UPDATE factory_issue_publications SET failure = 'unavailable' WHERE work_item_id = $1",
              [item.work_item_id],
            );
          await client.query(
            `INSERT INTO factory_activity (feature_id, kind, summary)
            VALUES ($1,'publication_failed','GitHub publication delivery interrupted; retry resumes the retained operation')`,
            [feature.id],
          );
          return;
        }
        await boss.send(
          FACTORY_PUBLICATION_QUEUE,
          { featureId: feature.id },
          {
            id: publication.job_id,
            db: pgBossDatabase(client),
            retryLimit: 0,
            expireInSeconds: 180,
          },
        );
      },
    );
  }
}

export async function claimFactoryPublication(
  pool: DatabasePool,
  featureId: string,
): Promise<ClaimedFactoryPublication | null> {
  const owner = await pool.query<{ project_id: string }>(
    "SELECT project_id FROM factory_features WHERE id = $1",
    [featureId],
  );
  const projectId = owner.rows[0]?.project_id;
  if (projectId === undefined) return null;
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    if (feature.state !== "queued" || feature.approved_plan_version === null) return null;
    const attemptId = randomUUID();
    const result = await client.query<PublicationRow>(
      `UPDATE factory_feature_publications SET state = 'running',
      attempt_id = $2, started_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE feature_id = $1 AND state = 'queued' AND (retry_after IS NULL OR retry_after <= clock_timestamp()) RETURNING *`,
      [featureId, attemptId],
    );
    const publication = result.rows[0];
    if (publication === undefined) return null;
    const items = await publicationItems(client, featureId);
    const item = items.find((candidate) => candidate.published_at === null);
    if (item === undefined) {
      await client.query(
        "UPDATE factory_feature_publications SET state = 'published', failure = NULL, updated_at = clock_timestamp() WHERE feature_id = $1",
        [featureId],
      );
      return null;
    }
    const version = await client.query<{ document: unknown }>(
      "SELECT document FROM factory_plan_versions WHERE feature_id = $1 AND version = $2",
      [featureId, feature.approved_plan_version],
    );
    return {
      featureId,
      projectId: feature.project_id,
      title: feature.title,
      version: feature.approved_plan_version,
      attemptId,
      plan: FeaturePlanDocumentSchema.parse(version.rows[0]?.document),
      identity: publication.identity,
      coordinates: publication.coordinates,
      featureUrl: publication.feature_url,
      item,
      items,
    };
  });
}

async function withPublicationAttempt<T>(
  pool: DatabasePool,
  claim: ClaimedFactoryPublication,
  operation: (client: PoolClient, feature: FeatureRow) => Promise<T>,
) {
  return withFactoryFeature(pool, claim.projectId, claim.featureId, async (client, feature) => {
    const result = await client.query(
      "SELECT 1 FROM factory_feature_publications WHERE feature_id = $1 AND state = 'running' AND attempt_id = $2 FOR UPDATE",
      [claim.featureId, claim.attemptId],
    );
    if (result.rowCount !== 1)
      throw new FactoryError("conflict", "The publication attempt is no longer current");
    return operation(client, feature);
  });
}

export function setFactoryPublicationIdentity(
  pool: DatabasePool,
  claim: ClaimedFactoryPublication,
  identity: FactoryPublicationIdentity,
) {
  FactoryGitHubRepositorySchema.parse(identity.repository);
  return withPublicationAttempt(pool, claim, async (client, feature) => {
    if (feature.state !== "queued") throw new FactoryError("conflict");
    if (
      claim.identity !== null &&
      (claim.identity.repository.id !== identity.repository.id ||
        claim.identity.repository.owner.toLowerCase() !== identity.repository.owner.toLowerCase() ||
        claim.identity.repository.name.toLowerCase() !== identity.repository.name.toLowerCase() ||
        claim.identity.account.toLowerCase() !== identity.account.toLowerCase())
    )
      throw new FactoryError("conflict", "The GitHub repository or host account changed");
    const imports = await factoryImportsFor(client, claim.featureId);
    if (imports.some(({ issue }) => issue.repository.id !== identity.repository.id))
      throw new FactoryError("conflict", "The imported repository identity changed");
    await client.query(
      "UPDATE factory_feature_publications SET identity = COALESCE(identity, $3::jsonb) WHERE feature_id = $1 AND attempt_id = $2",
      [claim.featureId, claim.attemptId, JSON.stringify(identity)],
    );
  });
}

export async function isFactoryPublicationRunning(
  pool: DatabasePool,
  claim: ClaimedFactoryPublication,
) {
  const result = await pool.query(
    `SELECT 1 FROM factory_feature_publications publication
    JOIN factory_features feature ON feature.id = publication.feature_id
    WHERE publication.feature_id = $1 AND publication.attempt_id = $2
      AND publication.state = 'running' AND feature.state = 'queued'`,
    [claim.featureId, claim.attemptId],
  );
  return result.rowCount === 1;
}

/** The exact payload is append-only, even when a definite rejection permits another attempt. */
export function prepareFactoryProviderOperation(
  pool: DatabasePool,
  claim: ClaimedFactoryPublication,
  kind: "issue" | "comment",
  payload: unknown,
) {
  return withPublicationAttempt(pool, claim, async (client, feature) => {
    if (feature.state !== "queued") throw new FactoryError("conflict");
    const id = kind === "issue" ? claim.item.issue_operation_id : claim.item.comment_operation_id;
    await client.query(
      "INSERT INTO factory_provider_operations (id, work_item_id, kind, payload) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO NOTHING",
      [id, claim.item.work_item_id, kind, JSON.stringify(payload)],
    );
    const result = await client.query<{ payload: unknown }>(
      "SELECT payload FROM factory_provider_operations WHERE id = $1",
      [id],
    );
    return result.rows[0]?.payload;
  });
}

export function markFactoryProviderAttempt(
  pool: DatabasePool,
  claim: ClaimedFactoryPublication,
  kind: "issue" | "comment",
  attempted: boolean,
) {
  return withPublicationAttempt(pool, claim, async (client, feature) => {
    if (attempted && feature.state !== "queued") throw new FactoryError("conflict");
    const column = kind === "issue" ? "issue_attempted" : "comment_attempted";
    await client.query(
      `UPDATE factory_issue_publications SET ${column} = $2 WHERE work_item_id = $1`,
      [claim.item.work_item_id, attempted],
    );
  });
}

export function bindFactoryPublishedIssue(
  pool: DatabasePool,
  claim: ClaimedFactoryPublication,
  value: FactoryGitHubIssue,
) {
  const issue = FactoryGitHubIssueSchema.parse(value);
  return withPublicationAttempt(pool, claim, async (client) => {
    const identity = await client.query<{ identity: FactoryPublicationIdentity }>(
      "SELECT identity FROM factory_feature_publications WHERE feature_id = $1",
      [claim.featureId],
    );
    if (identity.rows[0]?.identity.repository.id !== issue.repository.id)
      throw new FactoryError("conflict", "The provider returned a different repository");
    await assertFactoryIssueAvailable(client, claim.featureId, issue.repository.id, issue.id);
    const duplicate = await client.query(
      "SELECT 1 FROM factory_issue_publications WHERE feature_id = $1 AND work_item_id <> $2 AND issue->>'id' = $3",
      [claim.featureId, claim.item.work_item_id, issue.id],
    );
    if (duplicate.rowCount !== 0)
      throw new FactoryError("conflict", "This issue is already linked to a different Work Item");
    await client.query(
      "UPDATE factory_issue_publications SET issue = $2::jsonb, failure = NULL WHERE work_item_id = $1 AND issue IS NULL",
      [claim.item.work_item_id, JSON.stringify(issue)],
    );
  });
}

export function bindFactoryPublishedComment(
  pool: DatabasePool,
  claim: ClaimedFactoryPublication,
  commentId: string,
) {
  return withPublicationAttempt(pool, claim, async (client) => {
    await client.query(
      "UPDATE factory_issue_publications SET comment_id = $2, failure = NULL WHERE work_item_id = $1 AND comment_id IS NULL",
      [claim.item.work_item_id, commentId],
    );
  });
}

export function readFactoryProviderDependencies(
  pool: DatabasePool,
  claim: ClaimedFactoryPublication,
) {
  return withPublicationAttempt(pool, claim, async (client) => {
    const result = await client.query<{
      blocking_work_item_id: string;
      state: "pending" | "attempted" | "confirmed" | "textual";
    }>(
      "SELECT blocking_work_item_id, state FROM factory_provider_dependencies WHERE work_item_id = $1 ORDER BY blocking_work_item_id",
      [claim.item.work_item_id],
    );
    return result.rows;
  });
}
export function setFactoryProviderDependency(
  pool: DatabasePool,
  claim: ClaimedFactoryPublication,
  blockingItemId: string,
  state: "pending" | "attempted" | "confirmed" | "textual",
) {
  return withPublicationAttempt(pool, claim, async (client, feature) => {
    if (state === "attempted" && feature.state !== "queued") throw new FactoryError("conflict");
    const result = await client.query(
      "UPDATE factory_provider_dependencies SET state = $3 WHERE work_item_id = $1 AND blocking_work_item_id = $2",
      [claim.item.work_item_id, blockingItemId, state],
    );
    if (result.rowCount !== 1) throw new FactoryError("conflict");
  });
}

export function failFactoryPublication(
  pool: DatabasePool,
  claim: ClaimedFactoryPublication,
  failure: FactoryProviderFailure,
  retryAt?: string,
) {
  return withPublicationAttempt(pool, claim, async (client) => {
    await client.query(
      `UPDATE factory_feature_publications SET state = 'blocked', failure = $2,
      retry_after = $3, updated_at = clock_timestamp() WHERE feature_id = $1`,
      [claim.featureId, failure, retryAt ?? null],
    );
    await client.query(
      "UPDATE factory_issue_publications SET failure = $2 WHERE work_item_id = $1 AND published_at IS NULL",
      [claim.item.work_item_id, failure],
    );
    await client.query(
      "INSERT INTO factory_activity (feature_id, work_item_id, kind, summary) VALUES ($1,$2,'publication_failed',$3)",
      [
        claim.featureId,
        claim.item.work_item_id,
        `GitHub publication needs attention: ${failure}. Confirmed issue links are preserved.`,
      ],
    );
  });
}

export function completeFactoryPublicationItem(
  pool: DatabasePool,
  claim: ClaimedFactoryPublication,
) {
  return withPublicationAttempt(pool, claim, async (client, feature) => {
    const remaining = await client.query(
      "SELECT 1 FROM factory_provider_dependencies WHERE work_item_id = $1 AND state NOT IN ('confirmed','textual') LIMIT 1",
      [claim.item.work_item_id],
    );
    if (remaining.rowCount !== 0)
      throw new FactoryError("conflict", "Provider dependencies are not confirmed");
    const updated = await client.query(
      `UPDATE factory_issue_publications SET published_at = clock_timestamp(), failure = NULL,
      dependency_mode = CASE WHEN EXISTS (SELECT 1 FROM factory_provider_dependencies WHERE work_item_id = $1 AND state = 'textual') THEN 'textual' ELSE 'native' END
      WHERE work_item_id = $1 AND issue IS NOT NULL AND comment_id IS NOT NULL AND published_at IS NULL RETURNING work_item_id`,
      [claim.item.work_item_id],
    );
    if (updated.rowCount !== 1) throw new FactoryError("conflict");
    const pending = await client.query(
      "SELECT 1 FROM factory_issue_publications WHERE feature_id = $1 AND published_at IS NULL LIMIT 1",
      [claim.featureId],
    );
    await client.query(
      `UPDATE factory_feature_publications SET state = $2, failure = NULL, retry_after = NULL,
      job_id = $3, attempt_id = NULL, started_at = NULL, updated_at = clock_timestamp() WHERE feature_id = $1`,
      [claim.featureId, pending.rowCount === 0 ? "published" : "queued", randomUUID()],
    );
    await client.query(
      "INSERT INTO factory_activity (feature_id, work_item_id, kind, summary) VALUES ($1,$2,'issue_published',$3)",
      [
        claim.featureId,
        claim.item.work_item_id,
        `${claim.item.key} linked to GitHub with approved detail and dependencies${feature.state === "cancelled" ? "; feature remains cancelled" : ""}`,
      ],
    );
  });
}
