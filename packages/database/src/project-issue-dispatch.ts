import type { DatabasePool } from "./pool.js";
import { FactoryError } from "./factory-planning.js";
import { cancelFactoryFeature, readFactoryPlans } from "./factory-plans.js";
import { boardProjectId } from "./project-issue-board.js";

export interface IssueDispatch {
  id: string;
  project_id: string;
  actor_id: string;
  repository_id: string;
  issue_id: string;
  issue_number: number;
  title: string;
  ready_label: string;
  plan_request_id: string;
  state: "queued" | "preparing" | "running" | "blocked";
  feature_id: string | null;
  snapshot: unknown;
  feature_state: string | null;
}

/** A session lock covers the host reads and idempotent workflow commands across processes. */
export async function withProjectIssueDispatchLock<T>(
  pool: DatabasePool,
  operation: () => Promise<T>,
  wait = false,
): Promise<T | null> {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      wait
        ? "SELECT pg_advisory_lock(hashtextextended('project-issue-dispatch',0)),true AS locked"
        : "SELECT pg_try_advisory_lock(hashtextextended('project-issue-dispatch',0)) AS locked",
    );
    locked = result.rows[0]?.locked === true;
    if (locked) return await operation();
    return null;
  } finally {
    if (locked)
      await client.query("SELECT pg_advisory_unlock(hashtextextended('project-issue-dispatch',0))");
    client.release();
  }
}

export async function hasIssueDispatchPlanRequest(pool: DatabasePool, start: IssueDispatch) {
  const result = await pool.query(
    "SELECT id FROM factory_planning_turns WHERE feature_id=$1 AND request_id=$2",
    [start.feature_id, start.plan_request_id],
  );
  return result.rows.length > 0;
}

export async function hasActiveIssuePlanningTurn(pool: DatabasePool, featureId: string) {
  const result = await pool.query(
    "SELECT 1 FROM factory_planning_turns WHERE feature_id=$1 AND state IN ('queued','running') LIMIT 1",
    [featureId],
  );
  return result.rows.length > 0;
}

export async function changeIssueDispatch(
  pool: DatabasePool,
  projectId: string,
  id: string,
  action: "retry" | "cancel",
) {
  const canonical = await boardProjectId(pool, projectId);
  return withProjectIssueDispatchLock(
    pool,
    async () => {
      const result = await pool.query<{ feature_id: string | null; state: string }>(
        "SELECT feature_id,state FROM project_issue_starts WHERE id=$1 AND project_id=$2",
        [id, canonical],
      );
      const start = result.rows[0];
      if (start === undefined) throw new FactoryError("not_found");
      if (action === "cancel") {
        if (start.state === "done") return { id };
        if (start.feature_id !== null) {
          const plans = await readFactoryPlans(pool, canonical, start.feature_id);
          await cancelFactoryFeature(pool, canonical, start.feature_id, {
            requestId: id,
            expectedVersion: plans.current?.version ?? null,
          });
        }
        await updateIssueDispatch(pool, id, "done");
      } else {
        if (start.state !== "blocked")
          throw new FactoryError("conflict", "Only blocked queued work can be retried.");
        await pool.query(
          "UPDATE project_issue_starts SET state='preparing',message=NULL,plan_request_id=uuidv7() WHERE id=$1",
          [id],
        );
      }
      return { id };
    },
    true,
  );
}

export async function readIssueDispatches(pool: DatabasePool) {
  const result = await pool.query<IssueDispatch>(
    `WITH active AS (
       SELECT start.*,feature.state AS feature_state FROM project_issue_starts start
       LEFT JOIN factory_features feature ON feature.id=start.feature_id WHERE start.state <> 'done'
     ), heads AS (
       SELECT DISTINCT ON (project_id) id FROM active
       WHERE feature_state IS NULL OR feature_state NOT IN ('in_review','completed','cancelled')
       ORDER BY project_id,created_at,id
     )
     SELECT active.* FROM active WHERE id IN (SELECT id FROM heads)
       OR feature_state IN ('in_review','completed','cancelled') ORDER BY created_at,id`,
  );
  return result.rows;
}

export async function issueProjectBusy(pool: DatabasePool, start: IssueDispatch): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM factory_features feature JOIN projects owner ON owner.id=feature.project_id
    WHERE COALESCE(owner.canonical_project_id,owner.id)=$1 AND feature.id IS DISTINCT FROM $2
    AND ((feature.execution_mode='authorized' AND feature.state IN ('queued','implementing','gated')) OR EXISTS (
      SELECT 1 FROM factory_execution_runs run WHERE run.feature_id=feature.id AND run.reservation_released_at IS NULL)) LIMIT 1`,
    [start.project_id, start.feature_id],
  );
  return result.rows.length > 0;
}

export async function updateIssueDispatch(
  pool: DatabasePool,
  id: string,
  state: string,
  message: string | null = null,
) {
  if (state === "running") {
    // A retained explicit board start can authorize only its one bound issue.
    // Ordinary interview publication has no such receipt and keeps individual authority.
    const authorized = await pool.query(
      `UPDATE factory_features feature SET execution_mode='authorized'
       FROM project_issue_starts start, factory_plan_versions plan, factory_issue_imports imported
       WHERE start.id=$1 AND start.state <> 'done' AND feature.id=start.feature_id
         AND feature.project_id=start.project_id AND plan.feature_id=feature.id
         AND plan.version=feature.approved_plan_version
         AND jsonb_array_length(plan.document->'workItems')=1
         AND imported.feature_id=feature.id
         AND imported.id::text=plan.document->'workItems'->0->>'importedIssueId'
         AND imported.repository_provider_id=start.repository_id
         AND imported.issue_provider_id=start.issue_id RETURNING feature.id`,
      [id],
    );
    if (authorized.rows.length !== 1)
      throw new FactoryError(
        "conflict",
        "Execution must contain only the explicitly started issue.",
      );
  }
  await pool.query(
    "UPDATE project_issue_starts SET state=$2,message=$3,updated_at=clock_timestamp() WHERE id=$1 AND state <> 'done'",
    [id, state, message],
  );
}
export async function retainIssueDispatchContext(
  pool: DatabasePool,
  id: string,
  snapshot: unknown,
) {
  await pool.query(
    "UPDATE project_issue_starts SET snapshot=$2::jsonb,state='preparing',updated_at=clock_timestamp() WHERE id=$1 AND snapshot IS NULL",
    [id, JSON.stringify(snapshot)],
  );
}
export async function attachIssueDispatchFeature(
  pool: DatabasePool,
  id: string,
  featureId: string,
) {
  await pool.query(
    "UPDATE project_issue_starts SET feature_id=$2 WHERE id=$1 AND feature_id IS NULL",
    [id, featureId],
  );
}
export async function readIssueExecutionContext(
  pool: Pick<DatabasePool, "query">,
  featureId: string,
): Promise<unknown> {
  const result = await pool.query<{ snapshot: unknown }>(
    "SELECT snapshot FROM project_issue_starts WHERE feature_id=$1",
    [featureId],
  );
  return result.rows[0]?.snapshot ?? null;
}
