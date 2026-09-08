import { expect, it, vi } from "vitest";

import { readFactoryExecution, readFactoryExecutionRun } from "./factory-execution-read.js";

const featureId = "01991c36-7f90-7000-8000-000000000001";
const projectId = "01991c36-7f90-7000-8000-000000000002";
const runId = "01991c36-7f90-7000-8000-000000000003";
const itemId = "01991c36-7f90-7000-8000-000000000004";
const gateId = "01991c36-7f90-7000-8000-000000000005";

it("exposes the same durable question and stop eligibility from Feature and attempt reads", async () => {
  const now = new Date("2026-09-08T12:00:00.000Z");
  const run = {
    id: runId,
    feature_id: featureId,
    project_id: projectId,
    work_item_id: itemId,
    attempt: 1,
    plan_version: 3,
    state: "interrupted",
    failure: "stop_unconfirmed",
    question: "Which limit permits this operation?",
    runtime: null,
    revision: null,
    accepted_commands: [{ program: "node", args: ["--test"], cwd: ".", timeoutSeconds: 10 }],
    created_at: now,
    started_at: now,
    completed_at: now,
    reservation_released_at: null,
    resume_gate_id: null,
  };
  const gate = {
    id: gateId,
    feature_id: featureId,
    work_item_id: itemId,
    run_id: runId,
    plan_version: 3,
    reason: "stop_unconfirmed",
    question: run.question,
    required_decision: "inspect_environment",
    created_at: now,
    request_id: null,
    resolved_by: null,
    decision: null,
    answer: null,
    resolved_at: null,
    run_state: run.state,
    run_failure: run.failure,
    attempt: 1,
    reservation_released_at: null,
    has_pending_container: true,
    latest_run_id: runId,
    successor_run_id: null,
    board_column: "todo",
  };
  const query = vi.fn((sql: string) => {
    if (sql.includes("FROM factory_features") && sql.includes("FOR UPDATE"))
      return {
        rows: [{ id: featureId, project_id: projectId, state: "gated", approved_plan_version: 3 }],
      };
    if (sql.includes("SELECT id, key, board_column FROM factory_work_items"))
      return { rows: [{ id: itemId, key: "stable-order", board_column: "todo" }] };
    if (sql.includes("SELECT * FROM factory_execution_runs")) return { rows: [run] };
    if (sql.includes("FROM factory_human_gates gate")) return { rows: [gate] };
    return { rows: [] };
  });
  const pool = { connect: () => ({ query, release: vi.fn() }) } as never;
  const execution = await readFactoryExecution(pool, projectId, featureId);
  const attempt = await readFactoryExecutionRun(pool, projectId, featureId, runId);
  expect(execution.state).toBe("stopping");
  expect(execution.gate).toMatchObject({
    id: gateId,
    runId,
    workItemId: itemId,
    approvedVersion: 3,
    question: run.question,
    canResume: false,
    resumeBlockedReason: "unconfirmed_stop",
  });
  expect(attempt.gate).toEqual(execution.gate);
  expect(attempt.writerStopped).toBe(false);
});
