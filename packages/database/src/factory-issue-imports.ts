import type { PoolClient } from "pg";
import {
  FactoryGitHubIssueSchema,
  FactoryIssueImportsSchema,
  ImportedFactoryIssueSchema,
  type FactoryGitHubIssue,
  type FeaturePlanDocument,
  type ImportFactoryIssuesCommand,
  type ImportedFactoryIssue,
} from "@kestrel/contracts";
import {
  FactoryError,
  mapFactoryFeature,
  withFactoryFeature,
  type FeatureRow,
} from "./factory-planning.js";
import type { DatabasePool } from "./pool.js";

export async function factoryImportsFor(
  client: Pick<PoolClient, "query">,
  featureId: string,
): Promise<ImportedFactoryIssue[]> {
  const result = await client.query<{
    id: string;
    feature_id: string;
    snapshot: unknown;
    created_at: Date;
  }>("SELECT * FROM factory_issue_imports WHERE feature_id = $1 ORDER BY created_at, id", [
    featureId,
  ]);
  return result.rows.map((row) =>
    ImportedFactoryIssueSchema.parse({
      id: row.id,
      featureId: row.feature_id,
      issue: row.snapshot,
      importedAt: row.created_at.toISOString(),
    }),
  );
}

async function importsView(client: PoolClient, feature: FeatureRow) {
  const pending = await client.query(
    "SELECT id FROM factory_planning_turns WHERE feature_id = $1 AND state IN ('queued', 'running') LIMIT 1",
    [feature.id],
  );
  return FactoryIssueImportsSchema.parse({
    schemaVersion: 1,
    feature: mapFactoryFeature(feature),
    canImport:
      feature.state === "planning" &&
      feature.latest_plan_version === null &&
      pending.rowCount === 0,
    issues: await factoryImportsFor(client, feature.id),
  });
}

export function readFactoryIssueImports(pool: DatabasePool, projectId: string, featureId: string) {
  return withFactoryFeature(pool, projectId, featureId, importsView);
}

function numbers(command: ImportFactoryIssuesCommand): number[] {
  const sorted = [...command.issueNumbers].sort((left, right) => left - right);
  if (new Set(sorted).size !== sorted.length)
    throw new FactoryError("invalid_plan", "Select each issue only once");
  return sorted;
}

async function duplicateImport(
  client: PoolClient,
  featureId: string,
  command: ImportFactoryIssuesCommand,
) {
  const result = await client.query<{ issue_numbers: number[] }>(
    "SELECT issue_numbers FROM factory_issue_import_requests WHERE feature_id = $1 AND request_id = $2",
    [featureId, command.requestId],
  );
  if (result.rows[0] === undefined) return false;
  if (JSON.stringify(result.rows[0].issue_numbers) !== JSON.stringify(numbers(command)))
    throw new FactoryError("conflict", "This import request was already used for different issues");
  return true;
}

/** A repeated HTTP import can return its saved result without contacting GitHub again. */
export function readFactoryImportRequest(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  command: ImportFactoryIssuesCommand,
) {
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) =>
    (await duplicateImport(client, featureId, command)) ? importsView(client, feature) : null,
  );
}

export async function assertFactoryIssueAvailable(
  client: PoolClient,
  featureId: string,
  repositoryId: string,
  issueId: string,
) {
  // Serialize reservations made by independent Features. Cancellation releases the logical
  // reservation without deleting any frozen issue snapshot or successful provider binding.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 213))", [
    `${repositoryId}/${issueId}`,
  ]);
  const result = await client.query(
    `
    SELECT 1 FROM factory_features feature WHERE feature.id <> $1
      AND feature.state NOT IN ('cancelled', 'completed') AND (
        EXISTS (SELECT 1 FROM factory_issue_imports imported WHERE imported.feature_id = feature.id
          AND imported.repository_provider_id = $2 AND imported.issue_provider_id = $3)
        OR EXISTS (SELECT 1 FROM factory_issue_publications published WHERE published.feature_id = feature.id
          AND published.issue->'repository'->>'id' = $2 AND published.issue->>'id' = $3)
      ) LIMIT 1`,
    [featureId, repositoryId, issueId],
  );
  if (result.rowCount !== 0)
    throw new FactoryError(
      "conflict",
      "This GitHub issue is already linked to another active feature",
    );
}

export function importFactoryIssues(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  command: ImportFactoryIssuesCommand,
  snapshots: FactoryGitHubIssue[],
) {
  const selected = numbers(command);
  const issues = snapshots.map((issue) => FactoryGitHubIssueSchema.parse(issue));
  if (
    JSON.stringify(issues.map(({ number }) => number).sort((a, b) => a - b)) !==
      JSON.stringify(selected) ||
    issues.some(({ state }) => state !== "open") ||
    new Set(issues.map(({ repository }) => repository.id)).size !== 1
  )
    throw new FactoryError("invalid_plan", "Select open issues from this Project repository");
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    if (await duplicateImport(client, featureId, command)) return importsView(client, feature);
    const current = await importsView(client, feature);
    if (!current.canImport)
      throw new FactoryError(
        "conflict",
        "Import issues before saving the first plan, with no planning turn in progress",
      );
    const retained = new Set(
      current.issues.map(({ issue }) => `${issue.repository.id}/${issue.id}`),
    );
    const additions = issues.filter((issue) => !retained.has(`${issue.repository.id}/${issue.id}`));
    if (current.issues.length + additions.length > 20)
      throw new FactoryError("invalid_plan", "A feature can import at most 20 issues");
    const repo = issues[0]?.repository;
    if (repo === undefined) throw new FactoryError("invalid_plan");
    const source = await client.query<{
      github_owner_snapshot: string;
      github_name_snapshot: string;
    }>(
      `
      SELECT source.github_owner_snapshot, source.github_name_snapshot FROM local_repository_sources source
      JOIN projects project ON project.id = source.project_id
      WHERE COALESCE(project.canonical_project_id, project.id) = $1 AND source.attachment_state = 'attached'
        AND source.github_owner_snapshot IS NOT NULL AND source.github_name_snapshot IS NOT NULL LIMIT 1`,
      [feature.project_id],
    );
    const coordinates = source.rows[0];
    if (
      coordinates?.github_owner_snapshot.toLowerCase() !== repo.owner.toLowerCase() ||
      coordinates.github_name_snapshot.toLowerCase() !== repo.name.toLowerCase() ||
      current.issues.some(({ issue }) => issue.repository.id !== repo.id)
    )
      throw new FactoryError(
        "conflict",
        "The Project repository changed; refresh before importing issues",
      );
    // Stable ordering avoids two multi-issue imports acquiring the same locks in reverse order.
    for (const issue of [...additions].sort((a, b) => a.id.localeCompare(b.id))) {
      await assertFactoryIssueAvailable(client, featureId, repo.id, issue.id);
      await client.query(
        `INSERT INTO factory_issue_imports (feature_id, repository_provider_id, issue_provider_id, snapshot)
        VALUES ($1,$2,$3,$4::jsonb)`,
        [featureId, repo.id, issue.id, JSON.stringify(issue)],
      );
    }
    await client.query(
      "INSERT INTO factory_issue_import_requests (feature_id, request_id, issue_numbers) VALUES ($1,$2,$3::jsonb)",
      [featureId, command.requestId, JSON.stringify(selected)],
    );
    if (additions.length > 0) {
      await client.query(
        "UPDATE factory_features SET runtime_thread_id = NULL, updated_at = clock_timestamp() WHERE id = $1",
        [featureId],
      );
      await client.query(
        "INSERT INTO factory_activity (feature_id, kind, summary) VALUES ($1,'issues_imported',$2)",
        [
          featureId,
          `${String(additions.length)} GitHub issue snapshots imported for planning; execution still requires plan approval`,
        ],
      );
    }
    return importsView(client, feature);
  });
}

export async function assertFactoryPlanImports(
  client: PoolClient,
  featureId: string,
  plan: FeaturePlanDocument,
  requireAll: boolean,
) {
  const imports = await factoryImportsFor(client, featureId);
  const references = new Set(
    plan.workItems.flatMap(({ importedIssueId }) =>
      importedIssueId === null ? [] : [importedIssueId],
    ),
  );
  for (const id of references)
    if (!imports.some((imported) => imported.id === id))
      throw new FactoryError(
        "invalid_plan",
        "The plan refers to an issue that was not imported into this feature",
      );
  if (requireAll) {
    const missing = imports.filter(({ id }) => !references.has(id));
    if (missing.length > 0)
      throw new FactoryError(
        "invalid_plan",
        `Link each imported issue to one Work Item before approval: ${missing.map(({ issue }) => `#${String(issue.number)}`).join(", ")}`,
      );
    for (const imported of [...imports].sort((a, b) => a.issue.id.localeCompare(b.issue.id)))
      await assertFactoryIssueAvailable(
        client,
        featureId,
        imported.issue.repository.id,
        imported.issue.id,
      );
  }
  return imports;
}
