import { expect, it, vi } from "vitest";

import { readFactoryExecution, readFactoryExecutionRun } from "./factory-execution-read.js";

const featureId = "01991c36-7f90-7000-8000-000000000001";
const projectId = "01991c36-7f90-7000-8000-000000000002";
const runId = "01991c36-7f90-7000-8000-000000000003";
const itemId = "01991c36-7f90-7000-8000-000000000004";
const gateId = "01991c36-7f90-7000-8000-000000000005";

it("does not claim whole-Feature verification from completed Work Item columns without a certificate", async () => {
  const query = vi.fn((sql: string) => {
    if (sql.includes("FROM factory_features") && sql.includes("FOR UPDATE"))
      return {
        rows: [
          { id: featureId, project_id: projectId, state: "in_review", approved_plan_version: 1 },
        ],
      };
    if (sql.includes("SELECT id, key, board_column FROM factory_work_items"))
      return {
        rows: [
          { id: itemId, key: "W1", board_column: "in_review" },
          { id: gateId, key: "W2", board_column: "in_review" },
        ],
      };
    if (sql.includes("FROM factory_feature_workspaces"))
      return {
        rows: [
          {
            base_commit_id: "a".repeat(40),
            head_commit_id: "b".repeat(40),
            tree_id: "c".repeat(40),
            branch: "refs/heads/kestrel/feature/test",
          },
        ],
      };
    return { rows: [] };
  });
  const execution = await readFactoryExecution(
    { connect: () => ({ query, release: vi.fn() }) } as never,
    projectId,
    featureId,
  );
  expect(execution.state).toBe("pending");
});

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

it("surfaces missing cumulative workspace proof as a blocker instead of silently waiting", async () => {
  const query = vi.fn((sql: string) => {
    if (sql.includes("FROM factory_features") && sql.includes("FOR UPDATE"))
      return {
        rows: [
          { id: featureId, project_id: projectId, state: "in_review", approved_plan_version: 1 },
        ],
      };
    if (sql.includes("SELECT id, key, board_column FROM factory_work_items"))
      return { rows: [{ id: itemId, key: "W1", board_column: "in_review" }] };
    return { rows: [] };
  });
  const execution = await readFactoryExecution(
    { connect: () => ({ query, release: vi.fn() }) } as never,
    projectId,
    featureId,
  );
  expect(execution).toMatchObject({
    state: "blocked",
    failure: "source_unavailable",
    finalVerification: { certificate: null },
  });
  expect(execution.question).toContain("checkpoint is unavailable");
});

it("resets visible progress after a repair checkpoint invalidates the prior pass", async () => {
  const now = new Date("2026-09-08T12:00:00.000Z");
  const revision = {
    baseCommitId: "a".repeat(40),
    headCommitId: "b".repeat(40),
    treeId: "c".repeat(40),
    branch: "refs/heads/kestrel/feature/test",
  };
  const query = vi.fn((sql: string) => {
    if (sql.includes("FROM factory_features") && sql.includes("FOR UPDATE"))
      return {
        rows: [
          { id: featureId, project_id: projectId, state: "implementing", approved_plan_version: 1 },
        ],
      };
    if (sql.includes("SELECT id, key, board_column FROM factory_work_items"))
      return { rows: [{ id: itemId, key: "W1", board_column: "in_review" }] };
    if (sql.includes("SELECT * FROM factory_execution_runs"))
      return {
        rows: [
          {
            id: runId,
            feature_id: featureId,
            project_id: projectId,
            work_item_id: null,
            purpose: "feature_verification",
            plan_version: 1,
            attempt: 1,
            state: "verifying",
            failure: null,
            question: null,
            revision,
            accepted_commands: [
              { program: "node", args: ["--test"], cwd: ".", timeoutSeconds: 10 },
            ],
            created_at: now,
            started_at: now,
            completed_at: null,
            reservation_released_at: null,
          },
        ],
      };
    if (sql.includes("FROM factory_feature_workspaces"))
      return {
        rows: [
          {
            base_commit_id: revision.baseCommitId,
            head_commit_id: revision.headCommitId,
            tree_id: revision.treeId,
            branch: revision.branch,
          },
        ],
      };
    if (sql.includes("SELECT max(round)"))
      return {
        rows: [
          {
            round: 1,
            checked: "1",
            passed: "1",
            head_commit_id: "d".repeat(40),
            tree_id: "e".repeat(40),
          },
        ],
      };
    return { rows: [] };
  });
  const execution = await readFactoryExecution(
    { connect: () => ({ query, release: vi.fn() }) } as never,
    projectId,
    featureId,
  );
  expect(execution.finalVerification?.progress).toEqual({
    round: 2,
    checked: 0,
    passed: 0,
    total: 1,
  });
  expect(execution.finalVerification?.certificate).toBeNull();
});
