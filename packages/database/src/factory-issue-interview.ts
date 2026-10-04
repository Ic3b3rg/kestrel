import type { CodexSubscriptionConnection, FactoryGitHubIssue, Feature } from "@kestrel/contracts";
import { FactoryGitHubIssueSchema } from "@kestrel/contracts";
import type { DatabasePool } from "./pool.js";
import type { DiagnosticJobSender } from "./diagnostics.js";
import {
  acceptPlanningMessageForFeature,
  FactoryError,
  mapFactoryFeature,
  type FeatureRow,
} from "./factory-planning.js";

/** An unplanned tracker issue needs reviewed requirements. Retain its identity, never clone it. */
export async function prepareFactoryIssueInterview(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  projectId: string,
  actorId: string,
  requestId: string,
  input: FactoryGitHubIssue,
  connection: CodexSubscriptionConnection,
): Promise<Feature> {
  const issue = FactoryGitHubIssueSchema.parse(input);
  if (issue.state !== "open") throw new FactoryError("conflict", "This issue is no longer open.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const project = await client.query<{ id: string }>(
      "SELECT id FROM projects WHERE id = (SELECT COALESCE(canonical_project_id, id) FROM projects WHERE id = $1) FOR UPDATE",
      [projectId],
    );
    const canonical = project.rows[0]?.id;
    if (canonical === undefined) throw new FactoryError("not_found");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 213))", [
      `${issue.repository.id}/${issue.id}`,
    ]);
    const existing = await client.query<FeatureRow>(
      `SELECT feature.* FROM factory_features feature JOIN projects owner ON owner.id = feature.project_id
       WHERE COALESCE(owner.canonical_project_id, owner.id) = $1 AND feature.state <> 'cancelled'
         AND (EXISTS (SELECT 1 FROM factory_issue_imports imported WHERE imported.feature_id = feature.id AND imported.repository_provider_id = $2 AND imported.issue_provider_id = $3)
          OR EXISTS (SELECT 1 FROM factory_issue_publications publication WHERE publication.feature_id = feature.id AND publication.issue->'repository'->>'id' = $2 AND publication.issue->>'id' = $3))
       ORDER BY (feature.execution_mode = 'individual') DESC, feature.created_at LIMIT 1`,
      [canonical, issue.repository.id, issue.id],
    );
    if (existing.rows[0] !== undefined) {
      await client.query("COMMIT");
      return mapFactoryFeature({ ...existing.rows[0], project_id: canonical });
    }
    const source = await client.query(
      `SELECT 1 FROM local_repository_sources source JOIN projects owner ON owner.id = source.project_id
       WHERE COALESCE(owner.canonical_project_id, owner.id) = $1 AND source.attachment_state = 'attached'
         AND lower(source.github_owner_snapshot) = lower($2) AND lower(source.github_name_snapshot) = lower($3)`,
      [canonical, issue.repository.owner, issue.repository.name],
    );
    if (source.rowCount === 0)
      throw new FactoryError("conflict", "The linked repository changed. Refresh the board.");
    const count = await client.query<{ count: string }>(
      "SELECT count(*) FROM factory_features WHERE project_id = $1",
      [canonical],
    );
    if (Number(count.rows[0]?.count) >= 200) throw new FactoryError("feature_limit");
    const inserted = await client.query<FeatureRow>(
      "INSERT INTO factory_features (project_id, created_by, request_id, title, initial_title) VALUES ($1,$2,$3,$4,$4) RETURNING *",
      [canonical, actorId, requestId, issue.title.slice(0, 160)],
    );
    const feature = inserted.rows[0];
    if (feature === undefined) throw new Error("Issue interview was not retained");
    await client.query(
      "INSERT INTO factory_issue_imports (feature_id, repository_provider_id, issue_provider_id, snapshot) VALUES ($1,$2,$3,$4::jsonb)",
      [feature.id, issue.repository.id, issue.id, JSON.stringify(issue)],
    );
    await acceptPlanningMessageForFeature(
      client,
      boss,
      feature,
      {
        requestId,
        text: `Prepare the existing GitHub issue #${String(issue.number)} for implementation. Read its retained text and relevant repository files and comments. Clarify any missing scope, acceptance criteria or verification before preparing requirements. Keep this same issue linked; do not create a replacement or start other issues.`,
      },
      undefined,
      undefined,
      connection,
    );
    await client.query("COMMIT");
    return mapFactoryFeature(feature);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
