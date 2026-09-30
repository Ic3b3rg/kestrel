import { assertFactoryIssueAvailable } from "./factory-issue-imports.js";
import {
  ProjectBoardSettingsSchema,
  ProjectIssueStartSchema,
  type FactoryGitHubIssue,
} from "@kestrel/contracts";
import type { DatabasePool } from "./pool.js";
import { FactoryError } from "./factory-planning.js";

export async function boardProjectId(pool: DatabasePool, projectId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "SELECT COALESCE(canonical_project_id,id) AS id FROM projects WHERE id=$1",
    [projectId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new FactoryError("not_found");
  return id;
}

export async function readProjectBoardSettings(pool: DatabasePool, projectId: string) {
  const result = await pool.query<{ ready_label: string }>(
    "SELECT ready_label FROM project_board_settings WHERE project_id=$1",
    [await boardProjectId(pool, projectId)],
  );
  return { readyLabel: result.rows[0]?.ready_label ?? "ready-for-agent" };
}

export async function saveProjectBoardSettings(
  pool: DatabasePool,
  projectId: string,
  input: unknown,
) {
  const settings = ProjectBoardSettingsSchema.parse(input);
  await pool.query(
    "INSERT INTO project_board_settings (project_id,ready_label) VALUES ($1,$2) ON CONFLICT (project_id) DO UPDATE SET ready_label=EXCLUDED.ready_label",
    [await boardProjectId(pool, projectId), settings.readyLabel],
  );
  return settings;
}

export async function readProjectIssueObservation(
  pool: DatabasePool,
  projectId: string,
  key: string,
): Promise<unknown> {
  const result = await pool.query<{ value: unknown }>(
    "SELECT value FROM project_issue_observations WHERE project_id=$1 AND observation_key=$2",
    [projectId, key],
  );
  return result.rows[0]?.value ?? null;
}

export async function saveProjectIssueObservation(
  pool: DatabasePool,
  projectId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await pool.query(
    "INSERT INTO project_issue_observations (project_id,observation_key,value) VALUES ($1,$2,$3::jsonb) ON CONFLICT (project_id,observation_key) DO UPDATE SET value=EXCLUDED.value",
    [projectId, key, JSON.stringify(value)],
  );
}

export async function readProjectIssueStarts(pool: DatabasePool, projectId: string) {
  const result = await pool.query<{
    id: string;
    issue_number: number;
    issue_url: string;
    title: string;
    state: string;
    feature_id: string | null;
    message: string | null;
  }>(
    "SELECT * FROM project_issue_starts WHERE project_id=$1 ORDER BY (state='done'),created_at DESC,id DESC LIMIT 200",
    [projectId],
  );
  return result.rows.map((row) =>
    ProjectIssueStartSchema.parse({
      id: row.id,
      issueNumber: row.issue_number,
      issueUrl: row.issue_url,
      title: row.title,
      state: row.state,
      featureId: row.feature_id,
      message: row.message,
    }),
  );
}

export async function readProjectIssueStart(
  pool: DatabasePool,
  projectId: string,
  startId: string,
) {
  const result = await pool.query<{
    id: string;
    issue_number: number;
    issue_url: string;
    title: string;
    state: string;
    feature_id: string | null;
    message: string | null;
  }>(
    "SELECT id,issue_number,issue_url,title,state,feature_id,message FROM project_issue_starts WHERE project_id=$1 AND id=$2",
    [await boardProjectId(pool, projectId), startId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new FactoryError("not_found");
  return ProjectIssueStartSchema.parse({
    id: row.id,
    issueNumber: row.issue_number,
    issueUrl: row.issue_url,
    title: row.title,
    state: row.state,
    featureId: row.feature_id,
    message: row.message,
  });
}

export async function findProjectIssueStart(
  pool: DatabasePool,
  projectId: string,
  actorId: string,
  command: { requestId: string; issueNumber: number },
) {
  const id = await boardProjectId(pool, projectId);
  const result = await pool.query<{ project_id: string; issue_number: number; id: string }>(
    "SELECT id,project_id,issue_number FROM project_issue_starts WHERE actor_id=$1 AND request_id=$2",
    [actorId, command.requestId],
  );
  const existing = result.rows[0];
  if (existing === undefined) return null;
  if (existing.project_id !== id || existing.issue_number !== command.issueNumber)
    throw new FactoryError("conflict", "This start request already belongs to another issue.");
  return existing.id;
}

export async function enqueueProjectIssue(
  pool: DatabasePool,
  projectId: string,
  actorId: string,
  command: { requestId: string; issueNumber: number },
  issue: FactoryGitHubIssue,
) {
  const id = await boardProjectId(pool, projectId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [id]);
    const duplicate = await client.query<{ id: string; project_id: string; issue_number: number }>(
      "SELECT id,project_id,issue_number FROM project_issue_starts WHERE actor_id=$1 AND request_id=$2",
      [actorId, command.requestId],
    );
    const old = duplicate.rows[0];
    if (old !== undefined) {
      if (old.project_id !== id || old.issue_number !== command.issueNumber)
        throw new FactoryError("conflict");
      await client.query("COMMIT");
      return old.id;
    }
    const settings = await client.query<{ ready_label: string }>(
      "SELECT ready_label FROM project_board_settings WHERE project_id=$1",
      [id],
    );
    const label = settings.rows[0]?.ready_label ?? "ready-for-agent";
    if (
      issue.number !== command.issueNumber ||
      issue.state !== "open" ||
      !issue.labels?.some((item) => item.name === label)
    )
      throw new FactoryError("conflict", `Only open issues labelled ${label} can start.`);
    await assertFactoryIssueAvailable(client, null, issue.repository.id, issue.id);
    const existing = await client.query(
      "SELECT id FROM project_issue_starts WHERE repository_id=$1 AND issue_id=$2 AND state <> 'done'",
      [issue.repository.id, issue.id],
    );
    if (existing.rowCount !== 0)
      throw new FactoryError("conflict", "This issue is already queued or running.");
    const result = await client.query<{ id: string }>(
      `INSERT INTO project_issue_starts (project_id,actor_id,request_id,repository_id,issue_id,issue_number,issue_url,title,ready_label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        id,
        actorId,
        command.requestId,
        issue.repository.id,
        issue.id,
        issue.number,
        issue.url,
        issue.title,
        label,
      ],
    );
    await client.query("COMMIT");
    const inserted = result.rows[0];
    if (inserted === undefined) throw new Error("Issue start was not persisted");
    return inserted.id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
