import type { PoolClient } from "pg";
import {
  FeaturePlanDocumentSchema,
  PlanningContextSchema,
  FactoryExecutionRevisionSchema,
  FactoryVerificationResultSchema,
  FactoryExecutionRunSchema,
  type FactoryExecutionFailure,
  type FactoryExecutionRevision,
  type FactoryVerificationResult,
  type FactoryExecutionRun,
  type FeaturePlanDocument,
  type PlanningContext,
} from "@kestrel/contracts";

import type { DatabasePool } from "./pool.js";
import type { DiagnosticJobSender } from "./diagnostics.js";
import { FACTORY_EXECUTION_QUEUE, pgBossDatabase } from "./pg-boss.js";
import { FactoryError, withFactoryFeature, type FeatureRow } from "./factory-planning.js";
import type { ExecutionRunRow } from "./factory-execution-read.js";

interface OwnedRunRow extends ExecutionRunRow {
  owner_instance_id: string | null;
  stop_requested_at: Date | null;
  source: { repositoryId: string; identity: string } | null;
}
export interface ClaimedFactoryExecution {
  id: string;
  ownerInstanceId: string;
  projectId: string;
  featureId: string;
  title: string;
  workItemId: string;
  key: string;
  attempt: number;
  version: number;
  plan: FeaturePlanDocument;
  planMarkdown: string;
  specMarkdown: string;
  context: PlanningContext | null;
  source: OwnedRunRow["source"];
  completed: Array<{ key: string; revision: FactoryExecutionRevision }>;
}

async function transaction<T>(
  pool: DatabasePool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A delivery is only a notification. The durable Project reservation grants writer authority. */
export async function queueFactoryExecutions(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
): Promise<string[]> {
  return transaction(pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('factory-execution-scheduler-v1', 0))",
    );
    const active = await client.query<{ limit: number }>(
      `SELECT (plan.document->'limits'->>'maxConcurrentProjects')::integer AS limit
       FROM factory_execution_runs run JOIN factory_plan_versions plan
         ON plan.feature_id = run.feature_id AND plan.version = run.plan_version
       WHERE run.reservation_released_at IS NULL`,
    );
    let available = Math.min(2, ...active.rows.map((row) => row.limit)) - active.rows.length;
    if (available <= 0) return [];
    const candidates = await client.query<{ id: string; project_id: string }>(
      `SELECT feature.id, COALESCE(owner.canonical_project_id, owner.id) AS project_id
       FROM factory_features feature JOIN projects owner ON owner.id = feature.project_id
       JOIN factory_plan_approvals approval ON approval.feature_id = feature.id AND approval.plan_version = feature.approved_plan_version
       JOIN factory_feature_publications publication ON publication.feature_id = feature.id AND publication.state = 'published'
       WHERE feature.state IN ('queued', 'implementing')
         AND NOT EXISTS (SELECT 1 FROM factory_execution_runs run
           JOIN projects running_project ON running_project.id = run.project_id
           WHERE COALESCE(running_project.canonical_project_id, running_project.id) = COALESCE(owner.canonical_project_id, owner.id)
             AND run.reservation_released_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM factory_features prior
           JOIN projects prior_owner ON prior_owner.id = prior.project_id
           JOIN factory_plan_approvals prior_approval ON prior_approval.feature_id = prior.id AND prior_approval.plan_version = prior.approved_plan_version
           WHERE COALESCE(prior_owner.canonical_project_id, prior_owner.id) = COALESCE(owner.canonical_project_id, owner.id)
             AND prior.state IN ('queued', 'implementing', 'gated', 'in_review')
             AND (prior_approval.approved_at, prior.id) < (approval.approved_at, feature.id))
       ORDER BY approval.approved_at, feature.id LIMIT 32 FOR UPDATE OF feature`,
    );
    const queued: string[] = [];
    for (const candidate of candidates.rows) {
      if (available <= 0) break;
      const version = await client.query<{ version: number; document: unknown }>(
        `SELECT plan.version, plan.document FROM factory_plan_versions plan JOIN factory_features feature
         ON feature.id = plan.feature_id AND feature.approved_plan_version = plan.version WHERE feature.id = $1`,
        [candidate.id],
      );
      const approved = version.rows[0];
      if (approved === undefined) continue;
      const plan = FeaturePlanDocumentSchema.parse(approved.document);
      if (active.rows.length + queued.length >= plan.limits.maxConcurrentProjects) continue;
      const items = await client.query<{ id: string; key: string; board_column: string }>(
        "SELECT id, key, board_column FROM factory_work_items WHERE feature_id = $1 AND plan_version = $2 ORDER BY position",
        [candidate.id, approved.version],
      );
      const ready = items.rows.find(
        (item) =>
          item.board_column === "todo" &&
          plan.workItems
            .find((definition) => definition.key === item.key)
            ?.dependsOn.every((key) =>
              items.rows.some(
                (dependency) =>
                  dependency.key === key &&
                  ["in_review", "completed"].includes(dependency.board_column),
              ),
            ),
      );
      if (ready === undefined) continue;
      const definition = plan.workItems.find((item) => item.key === ready.key);
      if (definition === undefined) throw new Error("Approved Work Item missing");
      const previous = await client.query<{ attempt: number }>(
        "SELECT attempt FROM factory_execution_runs WHERE work_item_id = $1 ORDER BY attempt DESC LIMIT 1",
        [ready.id],
      );
      // Failed attempts require a recorded human disposition before being eligible again.
      if (previous.rows.length > 0) continue;
      const source = await client.query<{ repository_id: string; source_identity: string }>(
        `SELECT source.repository_id, source.source_identity FROM local_repository_sources source JOIN projects owner ON owner.id = source.project_id
         WHERE COALESCE(owner.canonical_project_id, owner.id) = $1 AND source.attachment_state = 'attached' ORDER BY source.project_id LIMIT 1`,
        [candidate.project_id],
      );
      const attached = source.rows[0];
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO factory_execution_runs (feature_id, project_id, work_item_id, plan_version, attempt, source, accepted_commands)
         VALUES ($1,$2,$3,$4,1,$5::jsonb,$6::jsonb) RETURNING id`,
        [
          candidate.id,
          candidate.project_id,
          ready.id,
          approved.version,
          attached === undefined
            ? null
            : JSON.stringify({
                repositoryId: attached.repository_id,
                identity: attached.source_identity,
              }),
          JSON.stringify(definition.verification),
        ],
      );
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error("Execution reservation was not persisted");
      const jobId = await boss.send(
        FACTORY_EXECUTION_QUEUE,
        { runId: id },
        { db: pgBossDatabase(client), id },
      );
      if (jobId !== id) throw new Error("Execution was not durably queued");
      await client.query(
        "UPDATE factory_features SET state = 'implementing', updated_at = clock_timestamp() WHERE id = $1",
        [candidate.id],
      );
      await client.query(
        "INSERT INTO factory_activity (feature_id, work_item_id, kind, summary) VALUES ($1,$2,'execution_queued',$3)",
        [candidate.id, ready.id, `${ready.key} reserved for automatic execution`],
      );
      queued.push(id);
      available = Math.min(
        available - 1,
        plan.limits.maxConcurrentProjects - active.rows.length - queued.length,
      );
    }
    return queued;
  });
}

async function withRun<T>(
  pool: DatabasePool,
  run: Pick<ClaimedFactoryExecution, "id" | "featureId" | "projectId" | "ownerInstanceId">,
  operation: (client: PoolClient, feature: FeatureRow, row: OwnedRunRow) => Promise<T>,
): Promise<T> {
  return withFactoryFeature(pool, run.projectId, run.featureId, async (client, feature) => {
    const selected = await client.query<OwnedRunRow>(
      "SELECT * FROM factory_execution_runs WHERE id = $1 AND feature_id = $2 FOR UPDATE",
      [run.id, run.featureId],
    );
    const row = selected.rows[0];
    if (row === undefined) throw new FactoryError("not_found");
    if (row.owner_instance_id !== run.ownerInstanceId) throw new FactoryError("conflict");
    return operation(client, feature, row);
  });
}

function assertRunning(feature: FeatureRow, row: OwnedRunRow): void {
  if (
    feature.state !== "implementing" ||
    !["running", "verifying"].includes(row.state) ||
    row.stop_requested_at !== null ||
    row.reservation_released_at !== null
  )
    throw new FactoryError("conflict");
}

export async function claimFactoryExecution(
  pool: DatabasePool,
  id: string,
  ownerInstanceId: string,
): Promise<ClaimedFactoryExecution | null> {
  const lookup = await pool.query<{ feature_id: string; project_id: string }>(
    "SELECT feature_id, project_id FROM factory_execution_runs WHERE id = $1",
    [id],
  );
  const identity = lookup.rows[0];
  if (identity === undefined) return null;
  return withFactoryFeature(
    pool,
    identity.project_id,
    identity.feature_id,
    async (client, feature) => {
      const result = await client.query<OwnedRunRow>(
        `UPDATE factory_execution_runs SET state = 'running', owner_instance_id = $2, started_at = clock_timestamp(), heartbeat_at = clock_timestamp()
       WHERE id = $1 AND state = 'queued' AND owner_instance_id IS NULL AND reservation_released_at IS NULL AND stop_requested_at IS NULL
         AND EXISTS (SELECT 1 FROM factory_features WHERE id = feature_id AND state = 'implementing') RETURNING *`,
        [id, ownerInstanceId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const versions = await client.query<{
        document: unknown;
        source_context: unknown;
        plan_markdown: string;
        spec_markdown: string;
      }>("SELECT * FROM factory_plan_versions WHERE feature_id = $1 AND version = $2", [
        row.feature_id,
        row.plan_version,
      ]);
      const version = versions.rows[0];
      if (version === undefined || feature.approved_plan_version !== row.plan_version)
        throw new FactoryError("conflict");
      const workItems = await client.query<{ id: string; key: string; board_column: string }>(
        "SELECT id, key, board_column FROM factory_work_items WHERE feature_id = $1 ORDER BY position",
        [row.feature_id],
      );
      const item = workItems.rows.find((item) => item.id === row.work_item_id);
      if (item === undefined || item.board_column !== "todo") throw new FactoryError("conflict");
      const completed = await client.query<{ key: string; revision: unknown }>(
        `SELECT item.key, run.revision FROM factory_work_items item JOIN factory_execution_runs run ON run.work_item_id = item.id
       WHERE item.feature_id = $1 AND item.board_column IN ('in_review', 'completed') AND run.state = 'verified' ORDER BY item.position`,
        [row.feature_id],
      );
      await client.query(
        "UPDATE factory_work_items SET board_column = 'in_progress' WHERE id = $1",
        [row.work_item_id],
      );
      await client.query(
        "INSERT INTO factory_activity (feature_id, work_item_id, kind, summary) VALUES ($1,$2,'execution_started',$3)",
        [row.feature_id, row.work_item_id, `${item.key} is being implemented`],
      );
      return {
        id,
        ownerInstanceId,
        projectId: feature.project_id,
        featureId: row.feature_id,
        title: feature.title,
        workItemId: row.work_item_id,
        key: item.key,
        attempt: row.attempt,
        version: row.plan_version,
        plan: FeaturePlanDocumentSchema.parse(version.document),
        context: PlanningContextSchema.nullable().parse(version.source_context),
        planMarkdown: version.plan_markdown,
        specMarkdown: version.spec_markdown,
        source: row.source,
        completed: completed.rows.map((item) => ({
          key: item.key,
          revision: FactoryExecutionRevisionSchema.parse(item.revision),
        })),
      };
    },
  );
}

export async function heartbeatFactoryExecution(
  pool: DatabasePool,
  run: ClaimedFactoryExecution,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE factory_execution_runs SET heartbeat_at = clock_timestamp() WHERE id = $1 AND owner_instance_id = $2
     AND state IN ('running', 'verifying') AND stop_requested_at IS NULL AND reservation_released_at IS NULL
     AND EXISTS (SELECT 1 FROM factory_features WHERE id = feature_id AND state = 'implementing')`,
    [run.id, run.ownerInstanceId],
  );
  return result.rowCount === 1;
}

export function recordFactoryExecutionActivity(
  pool: DatabasePool,
  run: ClaimedFactoryExecution,
  kind: FactoryExecutionRun["activity"][number]["kind"],
  summary: string,
): Promise<void> {
  return withRun(pool, run, async (client, _feature, row) => {
    if (row.reservation_released_at !== null) throw new FactoryError("conflict");
    await client.query(
      `INSERT INTO factory_execution_activity (run_id, kind, summary) SELECT $1,$2,$3
       WHERE (SELECT count(*) FROM factory_execution_activity WHERE run_id = $1) < 1000`,
      [run.id, kind, summary.slice(0, 2000)],
    );
  });
}

export function saveFactoryExecutionRuntime(
  pool: DatabasePool,
  run: ClaimedFactoryExecution,
  runtime: NonNullable<FactoryExecutionRun["runtime"]>,
): Promise<void> {
  return withRun(pool, run, async (client, feature, row) => {
    assertRunning(feature, row);
    await client.query("UPDATE factory_execution_runs SET runtime = $2::jsonb WHERE id = $1", [
      run.id,
      JSON.stringify(runtime),
    ]);
  });
}

export function saveFactoryVerification(
  pool: DatabasePool,
  run: ClaimedFactoryExecution,
  value: Omit<FactoryVerificationResult, "id" | "createdAt">,
): Promise<void> {
  const check = FactoryVerificationResultSchema.omit({ id: true, createdAt: true }).parse(value);
  return withRun(pool, run, async (client, _feature, row) => {
    // A command already started may finish after cancellation. Preserve that evidence;
    // cancellation still prevents new checkpoints and new container reservations.
    if (row.reservation_released_at !== null) throw new FactoryError("conflict");
    const command = FactoryExecutionRunSchema.shape.acceptedCommands.parse(row.accepted_commands)[
      check.position - 1
    ];
    const revision = FactoryExecutionRevisionSchema.parse(row.revision);
    if (
      JSON.stringify(command) !== JSON.stringify(check.command) ||
      revision.headCommitId !== check.headCommitId ||
      revision.treeId !== check.treeId
    )
      throw new FactoryError("conflict");
    await client.query(
      "INSERT INTO factory_verification_results (run_id, round, position, result) VALUES ($1,$2,$3,$4::jsonb)",
      [run.id, check.round, check.position, JSON.stringify(check)],
    );
  });
}

export function finishFactoryExecution(
  pool: DatabasePool,
  run: ClaimedFactoryExecution,
  outcome: {
    verified: boolean;
    writerStopped: boolean;
    failure: FactoryExecutionFailure | null;
    question: string | null;
  },
): Promise<void> {
  return withRun(pool, run, async (client, feature, row) => {
    if (row.reservation_released_at !== null) return;
    const pendingContainers = await client.query(
      "SELECT name FROM factory_execution_containers WHERE run_id = $1 AND stopped_at IS NULL",
      [run.id],
    );
    const writerStopped = outcome.writerStopped && pendingContainers.rowCount === 0;
    let verified =
      outcome.verified &&
      writerStopped &&
      feature.state === "implementing" &&
      row.stop_requested_at === null &&
      ["running", "verifying"].includes(row.state);
    if (verified) {
      const checks = await client.query<{ result: unknown }>(
        `SELECT result FROM factory_verification_results WHERE run_id = $1 AND round =
          (SELECT max(round) FROM factory_verification_results WHERE run_id = $1) ORDER BY position`,
        [run.id],
      );
      const revision = FactoryExecutionRevisionSchema.parse(row.revision);
      const commands = FactoryExecutionRunSchema.shape.acceptedCommands.parse(
        row.accepted_commands,
      );
      const workspace = await workspaceFor(client, run.featureId);
      verified =
        workspace !== null &&
        workspace.headCommitId === revision.headCommitId &&
        workspace.treeId === revision.treeId &&
        workspace.baseCommitId === revision.baseCommitId &&
        workspace.branch === revision.branch &&
        checks.rows.length === commands.length &&
        checks.rows.every(({ result }, index) => {
          const check = FactoryVerificationResultSchema.omit({ id: true, createdAt: true }).parse(
            result,
          );
          return (
            check.position === index + 1 &&
            check.outcome === "passed" &&
            check.exitCode === 0 &&
            check.headCommitId === revision.headCommitId &&
            check.treeId === revision.treeId &&
            JSON.stringify(check.command) === JSON.stringify(commands[index])
          );
        });
      if (!verified)
        throw new FactoryError("conflict", "All approved checks must pass on the exact revision");
    }
    const cancelled = feature.state === "cancelled";
    const state = !writerStopped
      ? "interrupted"
      : cancelled
        ? "cancelled"
        : verified
          ? "verified"
          : "blocked";
    const failure = !writerStopped
      ? "stop_unconfirmed"
      : cancelled
        ? "cancelled"
        : verified
          ? null
          : (outcome.failure ?? "interrupted");
    await client.query(
      `UPDATE factory_execution_runs SET state = $2, failure = $3, question = $4, completed_at = clock_timestamp(),
        reservation_released_at = CASE WHEN $5 THEN clock_timestamp() ELSE NULL END WHERE id = $1`,
      [run.id, state, failure, outcome.question?.slice(0, 4000) ?? null, writerStopped],
    );
    await client.query("UPDATE factory_work_items SET board_column = $2 WHERE id = $1", [
      row.work_item_id,
      verified ? "in_review" : "todo",
    ]);
    if (!cancelled)
      await client.query(
        `UPDATE factory_features SET state = CASE WHEN $2 THEN
        CASE WHEN NOT EXISTS (SELECT 1 FROM factory_work_items WHERE feature_id = $1 AND board_column NOT IN ('in_review', 'completed'))
          THEN 'in_review' ELSE 'implementing' END ELSE 'gated' END, updated_at = clock_timestamp() WHERE id = $1`,
        [row.feature_id, verified],
      );
    await client.query(
      "INSERT INTO factory_activity (feature_id, work_item_id, kind, summary) VALUES ($1,$2,$3,$4)",
      [
        row.feature_id,
        row.work_item_id,
        verified ? "item_verified" : "execution_blocked",
        verified
          ? `${run.key} passed its approved checks and is ready for review`
          : `${run.key} stopped: ${failure ?? "interrupted"}`,
      ],
    );
  });
}

export function reserveFactoryExecutionContainer(
  pool: DatabasePool,
  run: ClaimedFactoryExecution,
  name: string,
  phase: "implementation" | "verification",
): Promise<void> {
  return withRun(pool, run, async (client, feature, row) => {
    assertRunning(feature, row);
    const count = await client.query<{ count: string }>(
      "SELECT count(*) FROM factory_execution_containers WHERE run_id = $1",
      [run.id],
    );
    if (Number(count.rows[0]?.count) >= 39)
      throw new FactoryError("conflict", "The attempt environment limit was reached");
    await client.query(
      "INSERT INTO factory_execution_containers (name, run_id, phase) VALUES ($1,$2,$3)",
      [name, run.id, phase],
    );
    if (phase === "implementation")
      await client.query("UPDATE factory_execution_runs SET state = 'running' WHERE id = $1", [
        run.id,
      ]);
    else {
      if (row.revision === null)
        throw new FactoryError("conflict", "Verification requires an exact checkpoint");
      await client.query("UPDATE factory_execution_runs SET state = 'verifying' WHERE id = $1", [
        run.id,
      ]);
    }
  });
}

export async function identifyFactoryExecutionContainer(
  pool: DatabasePool,
  run: ClaimedFactoryExecution,
  container: { name: string; id: string },
): Promise<void> {
  const active = await withRun(pool, run, async (client, feature, row) => {
    if (row.reservation_released_at !== null) throw new FactoryError("conflict");
    const result = await client.query(
      "UPDATE factory_execution_containers SET container_id = $3 WHERE name = $1 AND run_id = $2 AND stopped_at IS NULL AND (container_id IS NULL OR container_id = $3)",
      [container.name, run.id, container.id],
    );
    if (result.rowCount !== 1) throw new FactoryError("conflict");
    return (
      feature.state === "implementing" &&
      ["running", "verifying"].includes(row.state) &&
      row.stop_requested_at === null
    );
  });
  // Preserve the discovered identity even when cancellation arrived during Docker create.
  if (!active) throw new FactoryError("conflict");
}

export function stopFactoryExecutionContainer(
  pool: DatabasePool,
  run: ClaimedFactoryExecution,
  container: { name: string; id: string | null },
): Promise<void> {
  return withRun(pool, run, async (client) => {
    const result = await client.query(
      `UPDATE factory_execution_containers SET container_id = COALESCE(container_id, $3), stopped_at = COALESCE(stopped_at, clock_timestamp())
       WHERE name = $1 AND run_id = $2 AND (container_id IS NULL OR container_id = $3)`,
      [container.name, run.id, container.id],
    );
    if (result.rowCount !== 1) throw new FactoryError("conflict");
  });
}

export interface FactoryFeatureWorkspace {
  projectId: string;
  featureId: string;
  repositoryId: string;
  sourceIdentity: string;
  baseCommitId: string;
  objectFormat: "sha1" | "sha256";
  branch: string;
  headCommitId: string;
  treeId: string;
}

async function workspaceFor(
  client: PoolClient,
  featureId: string,
): Promise<FactoryFeatureWorkspace | null> {
  const result = await client.query<{
    project_id: string;
    feature_id: string;
    repository_id: string;
    source_identity: string;
    base_commit_id: string;
    object_format: "sha1" | "sha256";
    branch: string;
    head_commit_id: string;
    tree_id: string;
  }>("SELECT * FROM factory_feature_workspaces WHERE feature_id = $1", [featureId]);
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        projectId: row.project_id,
        featureId: row.feature_id,
        repositoryId: row.repository_id,
        sourceIdentity: row.source_identity,
        baseCommitId: row.base_commit_id,
        objectFormat: row.object_format,
        branch: row.branch,
        headCommitId: row.head_commit_id,
        treeId: row.tree_id,
      };
}

export function readFactoryFeatureWorkspace(
  pool: DatabasePool,
  run: ClaimedFactoryExecution,
): Promise<FactoryFeatureWorkspace | null> {
  return withRun(pool, run, (client) => workspaceFor(client, run.featureId));
}

/** Freeze the independently inspected source before any runtime receives a writable mount. */
export function initializeFactoryFeatureWorkspace(
  pool: DatabasePool,
  run: ClaimedFactoryExecution,
  workspace: FactoryFeatureWorkspace,
): Promise<FactoryFeatureWorkspace> {
  return withRun(pool, run, async (client, feature, row) => {
    assertRunning(feature, row);
    if (
      workspace.featureId !== row.feature_id ||
      workspace.projectId !== feature.project_id ||
      workspace.repositoryId !== row.source?.repositoryId ||
      workspace.sourceIdentity !== row.source.identity ||
      workspace.headCommitId !== workspace.baseCommitId ||
      (run.context?.commitId != null && workspace.baseCommitId !== run.context.commitId)
    )
      throw new FactoryError("conflict");
    FactoryExecutionRevisionSchema.parse({
      baseCommitId: workspace.baseCommitId,
      headCommitId: workspace.headCommitId,
      treeId: workspace.treeId,
      branch: workspace.branch,
    });
    const existing = await workspaceFor(client, row.feature_id);
    if (existing !== null) {
      if (
        Object.entries(existing).some(
          ([key, value]) => workspace[key as keyof FactoryFeatureWorkspace] !== value,
        )
      )
        throw new FactoryError("conflict");
      return existing;
    }
    await client.query(
      `INSERT INTO factory_feature_workspaces (feature_id, project_id, repository_id, source_identity, base_commit_id, object_format, branch, head_commit_id, tree_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        workspace.featureId,
        workspace.projectId,
        workspace.repositoryId,
        workspace.sourceIdentity,
        workspace.baseCommitId,
        workspace.objectFormat,
        workspace.branch,
        workspace.headCommitId,
        workspace.treeId,
      ],
    );
    return workspace;
  });
}

/** Publish the controller's Git CAS checkpoint and its evidence identity in one DB transaction. */
export function recordFactoryExecutionCheckpoint(
  pool: DatabasePool,
  run: ClaimedFactoryExecution,
  checkpoint: { expectedHead: string; headCommitId: string; treeId: string },
): Promise<FactoryExecutionRevision> {
  return withRun(pool, run, async (client, feature, row) => {
    assertRunning(feature, row);
    const workspace = await workspaceFor(client, run.featureId);
    if (
      workspace === null ||
      (workspace.headCommitId !== checkpoint.expectedHead &&
        (workspace.headCommitId !== checkpoint.headCommitId ||
          workspace.treeId !== checkpoint.treeId))
    )
      throw new FactoryError("conflict");
    const revision = FactoryExecutionRevisionSchema.parse({
      baseCommitId: workspace.baseCommitId,
      branch: workspace.branch,
      headCommitId: checkpoint.headCommitId,
      treeId: checkpoint.treeId,
    });
    await client.query(
      "UPDATE factory_feature_workspaces SET head_commit_id = $2, tree_id = $3 WHERE feature_id = $1",
      [run.featureId, checkpoint.headCommitId, checkpoint.treeId],
    );
    await client.query(
      "UPDATE factory_execution_runs SET state = 'verifying', revision = $2::jsonb WHERE id = $1",
      [run.id, JSON.stringify(revision)],
    );
    return revision;
  });
}

/** Surface interrupted delivery without granting another writer an expired reservation. */
export async function reconcileFactoryExecutions(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
): Promise<void> {
  const candidates = await pool.query<{ id: string; feature_id: string; project_id: string }>(
    `SELECT run.id, run.feature_id, run.project_id FROM factory_execution_runs run
     WHERE reservation_released_at IS NULL AND state IN ('queued', 'running', 'verifying', 'stopping')
       AND ((owner_instance_id IS NOT NULL AND heartbeat_at < clock_timestamp() - interval '30 seconds')
         OR NOT EXISTS (SELECT 1 FROM pgboss.job job WHERE job.name = $1 AND job.id = run.id AND job.state NOT IN ('failed', 'cancelled', 'completed')))
     ORDER BY run.feature_id, run.id`,
    [FACTORY_EXECUTION_QUEUE],
  );
  for (const candidate of candidates.rows) {
    await withFactoryFeature(
      pool,
      candidate.project_id,
      candidate.feature_id,
      async (client, feature) => {
        const selected = await client.query<OwnedRunRow>(
          `SELECT run.* FROM factory_execution_runs run WHERE id = $1 AND reservation_released_at IS NULL
          AND state IN ('queued', 'running', 'verifying', 'stopping')
          AND ((owner_instance_id IS NOT NULL AND heartbeat_at < clock_timestamp() - interval '30 seconds')
            OR NOT EXISTS (SELECT 1 FROM pgboss.job job WHERE job.name = $2 AND job.id = run.id AND job.state NOT IN ('failed', 'cancelled', 'completed')))
         FOR UPDATE`,
          [candidate.id, FACTORY_EXECUTION_QUEUE],
        );
        const row = selected.rows[0];
        if (row === undefined) return;
        const neverOwned = row.owner_instance_id === null;
        const question = neverOwned
          ? "Execution delivery stopped before work could start. Retry this Work Item after checking the local service."
          : "Execution was interrupted. Kestrel retains this Project until its execution environment has been stopped.";
        await client.query(
          `UPDATE factory_execution_runs SET state = $2, failure = 'interrupted', question = $3,
           stop_requested_at = clock_timestamp(), completed_at = clock_timestamp(),
           reservation_released_at = CASE WHEN $4 THEN clock_timestamp() ELSE NULL END WHERE id = $1`,
          [row.id, neverOwned ? "blocked" : "interrupted", question, neverOwned],
        );
        await client.query("UPDATE factory_work_items SET board_column = 'todo' WHERE id = $1", [
          row.work_item_id,
        ]);
        if (feature.state !== "cancelled")
          await client.query(
            "UPDATE factory_features SET state = 'gated', updated_at = clock_timestamp() WHERE id = $1",
            [row.feature_id],
          );
        await client.query(
          "INSERT INTO factory_activity (feature_id, work_item_id, kind, summary) VALUES ($1,$2,'execution_blocked',$3)",
          [row.feature_id, row.work_item_id, question],
        );
      },
    );
  }
  await queueFactoryExecutions(pool, boss);
}
