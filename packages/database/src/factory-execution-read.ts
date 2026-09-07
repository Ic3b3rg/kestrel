import {
  FactoryExecutionSchema,
  FactoryExecutionRunSchema,
  FactoryExecutionRunSummarySchema,
  FactoryExecutionRevisionSchema,
  type FactoryExecution,
  type FactoryExecutionRun,
} from "@kestrel/contracts";
import type { PoolClient } from "pg";

import { FactoryError, withFactoryFeature } from "./factory-planning.js";
import type { DatabasePool } from "./pool.js";

export interface ExecutionRunRow {
  id: string;
  feature_id: string;
  project_id: string;
  work_item_id: string;
  plan_version: number;
  attempt: number;
  state: string;
  failure: string | null;
  question: string | null;
  runtime: unknown;
  revision: unknown;
  accepted_commands: unknown;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  reservation_released_at: Date | null;
}

function summary(row: ExecutionRunRow) {
  return FactoryExecutionRunSummarySchema.parse({
    id: row.id,
    workItemId: row.work_item_id,
    attempt: row.attempt,
    state: row.state,
    failure: row.failure,
    writerStopped: row.reservation_released_at !== null,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  });
}

export async function factoryWorkspaceRevision(client: PoolClient, featureId: string) {
  const result = await client.query<{
    base_commit_id: string;
    head_commit_id: string;
    tree_id: string;
    branch: string;
  }>("SELECT * FROM factory_feature_workspaces WHERE feature_id = $1", [featureId]);
  const row = result.rows[0];
  return row === undefined
    ? null
    : FactoryExecutionRevisionSchema.parse({
        baseCommitId: row.base_commit_id,
        headCommitId: row.head_commit_id,
        treeId: row.tree_id,
        branch: row.branch,
      });
}

export function readFactoryExecution(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
): Promise<FactoryExecution> {
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    const items = await client.query<{ id: string; key: string; board_column: string }>(
      "SELECT id, key, board_column FROM factory_work_items WHERE feature_id = $1 AND plan_version = $2 ORDER BY position",
      [featureId, feature.approved_plan_version],
    );
    const runs = await client.query<ExecutionRunRow>(
      "SELECT * FROM factory_execution_runs WHERE feature_id = $1 ORDER BY created_at, id",
      [featureId],
    );
    const latest = runs.rows.at(-1);
    const stopping = runs.rows.some(
      (row) =>
        row.reservation_released_at === null &&
        (feature.state === "cancelled" ||
          ["stopping", "blocked", "interrupted"].includes(row.state)),
    );
    const state = stopping
      ? "stopping"
      : feature.state === "cancelled"
        ? "cancelled"
        : feature.approved_plan_version === null
          ? "not_approved"
          : feature.state === "gated"
            ? "blocked"
            : items.rows.length > 0 &&
                items.rows.every((item) => ["in_review", "completed"].includes(item.board_column))
              ? "verified"
              : runs.rows.some(
                    (row) => row.reservation_released_at === null && row.state !== "queued",
                  )
                ? "running"
                : "pending";
    return FactoryExecutionSchema.parse({
      schemaVersion: 1,
      featureId,
      state,
      failure: latest?.failure ?? null,
      question: latest?.question ?? null,
      revision: await factoryWorkspaceRevision(client, featureId),
      workItems: items.rows.map((item) => ({
        id: item.id,
        key: item.key,
        runs: runs.rows.filter((run) => run.work_item_id === item.id).map(summary),
      })),
    });
  });
}

export function readFactoryExecutionRun(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  runId: string,
): Promise<FactoryExecutionRun> {
  return withFactoryFeature(pool, projectId, featureId, async (client) => {
    const result = await client.query<ExecutionRunRow>(
      "SELECT * FROM factory_execution_runs WHERE id = $1 AND feature_id = $2",
      [runId, featureId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new FactoryError("not_found");
    const activity = await client.query<{
      id: string;
      kind: string;
      summary: string;
      created_at: Date;
    }>(
      "SELECT * FROM factory_execution_activity WHERE run_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100",
      [runId],
    );
    const verification = await client.query<{ id: string; result: object; created_at: Date }>(
      "SELECT * FROM factory_verification_results WHERE run_id = $1 ORDER BY round, position",
      [runId],
    );
    return FactoryExecutionRunSchema.parse({
      ...summary(row),
      schemaVersion: 1,
      featureId,
      approvedVersion: row.plan_version,
      question: row.question,
      runtime: row.runtime,
      revision: row.revision,
      acceptedCommands: row.accepted_commands,
      activity: activity.rows.toReversed().map((event) => ({
        id: event.id,
        kind: event.kind,
        summary: event.summary,
        createdAt: event.created_at.toISOString(),
      })),
      verification: verification.rows.map((check) => ({
        ...check.result,
        id: check.id,
        createdAt: check.created_at.toISOString(),
      })),
    });
  });
}
