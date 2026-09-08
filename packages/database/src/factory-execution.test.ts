import { expect, it, vi } from "vitest";

import {
  finishFactoryExecution,
  queueFactoryExecutions,
  reconcileFactoryExecutions,
} from "./factory-execution.js";

const featureId = "01991c36-7f90-7000-8000-000000000001";
const projectId = "01991c36-7f90-7000-8000-000000000002";
const runId = "01991c36-7f90-7000-8000-000000000003";
const itemId = "01991c36-7f90-7000-8000-000000000004";
const ownerId = "01991c36-7f90-7000-8000-000000000005";
const gateId = "01991c36-7f90-7000-8000-000000000006";
const successorId = "01991c36-7f90-7000-8000-000000000007";
type Query = (statement: string, parameters?: unknown[]) => { rows: unknown[]; rowCount?: number };

it("atomically retains the actual consequential question and approved identity when a writer stops", async () => {
  const row = {
    id: runId,
    feature_id: featureId,
    project_id: projectId,
    work_item_id: itemId,
    owner_instance_id: ownerId,
    state: "running",
    plan_version: 3,
    reservation_released_at: null,
    stop_requested_at: null,
    failure: null,
    question: null,
  };
  const query = vi.fn((statement: string, parameters?: unknown[]) => {
    if (statement.includes("FROM factory_features") && statement.includes("FOR UPDATE"))
      return {
        rowCount: 1,
        rows: [{ id: featureId, project_id: projectId, state: "implementing" }],
      };
    if (statement.includes("SELECT * FROM factory_execution_runs"))
      return { rowCount: 1, rows: [row] };
    if (statement.includes("UPDATE factory_execution_runs")) {
      Object.assign(row, {
        state: parameters?.[1],
        failure: parameters?.[2],
        question: parameters?.[3],
      });
    }
    return { rowCount: 0, rows: [] };
  });
  const release = vi.fn();
  await finishFactoryExecution(
    { connect: () => ({ query, release }) } as never,
    { id: runId, featureId, projectId, ownerInstanceId: ownerId, key: "stable-order" } as never,
    {
      verified: false,
      writerStopped: true,
      failure: "input_required",
      question: "Should equal results retain their original order?",
    },
  );

  const gateInsert = query.mock.calls.find(([statement]) =>
    statement.includes("INSERT INTO factory_human_gates"),
  );
  expect(gateInsert).toBeDefined();
  expect(gateInsert?.[1]).toEqual(
    expect.arrayContaining([
      runId,
      "input_required",
      "Should equal results retain their original order?",
      "clarify_within_plan",
    ]),
  );
  expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  expect(release).toHaveBeenCalledOnce();
});

it.each([
  { owner: ownerId, pendingContainer: false, released: false },
  { owner: null, pendingContainer: false, released: true },
  { owner: null, pendingContainer: true, released: false },
])(
  "surfaces abandoned work as a gate and releases only a never-owned empty environment: %j",
  async ({ owner, pendingContainer, released }) => {
    const row = {
      id: runId,
      feature_id: featureId,
      project_id: projectId,
      work_item_id: itemId,
      plan_version: 3,
      owner_instance_id: owner,
    };
    const query = vi.fn<Query>((statement) => {
      if (statement.includes("FROM factory_features") && statement.includes("FOR UPDATE"))
        return {
          rowCount: 1,
          rows: [{ id: featureId, project_id: projectId, state: "implementing" }],
        };
      if (statement.includes("SELECT run.* FROM factory_execution_runs"))
        return { rowCount: 1, rows: [row] };
      if (statement.includes("SELECT name FROM factory_execution_containers"))
        return {
          rowCount: pendingContainer ? 1 : 0,
          rows: pendingContainer ? [{ name: "retained-writer" }] : [],
        };
      if (statement.includes("AS limit")) return { rows: [{ limit: 1 }] };
      return { rowCount: 0, rows: [] };
    });
    const candidateQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValue({ rows: [] });
    await reconcileFactoryExecutions(
      { query: candidateQuery, connect: () => ({ query, release: vi.fn() }) } as never,
      { send: vi.fn() },
    );
    const calls = query.mock.calls;
    expect(calls.find(([sql]) => sql.includes("UPDATE factory_execution_runs"))?.[1]?.[3]).toBe(
      released,
    );
    expect(calls.find(([sql]) => sql.includes("INSERT INTO factory_human_gates"))?.[1]).toEqual(
      expect.arrayContaining([runId, "interrupted", "inspect_environment"]),
    );
  },
);

it("backfills an existing gated attempt without replacing its question or granting execution", async () => {
  const row = {
    id: runId,
    feature_id: featureId,
    project_id: projectId,
    failure: "usage_limit",
    question: "The selected subscription is exhausted; retry after its limit resets.",
  };
  const query = vi.fn<Query>((sql) => {
    if (sql.includes("FROM factory_features") && sql.includes("FOR UPDATE"))
      return { rows: [{ id: featureId, project_id: projectId, state: "gated" }] };
    if (sql.includes("SELECT run.* FROM factory_execution_runs")) return { rows: [row] };
    if (sql.includes("AS limit")) return { rows: [{ limit: 1 }] };
    return { rows: [] };
  });
  const pool = {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] }),
    connect: () => ({ query, release: vi.fn() }),
  } as never;
  const send = vi.fn();
  await reconcileFactoryExecutions(pool, { send });
  expect(
    query.mock.calls.find(([sql]) => sql.includes("INSERT INTO factory_human_gates"))?.[1],
  ).toEqual([runId, "usage_limit", row.question, "retry_within_plan"]);
  expect(query.mock.calls.some(([sql]) => sql.includes("UPDATE factory_execution_runs"))).toBe(
    false,
  );
  expect(send).not.toHaveBeenCalled();
});

it("admits a single answered retry with frozen source and checks after its verified dependency", async () => {
  const verification = [
    { program: "node", args: ["--test", "stable.test.mjs"], cwd: ".", timeoutSeconds: 10 },
  ];
  const source = { repositoryId: "frozen-repository", identity: "frozen-identity" };
  const now = new Date("2026-09-08T12:00:00.000Z");
  const planItem = {
    key: "base",
    title: "Base behavior",
    description: "Return ordered values",
    requirementKeys: ["order"],
    acceptance: ["Stable values"],
    dependsOn: [] as string[],
    verification,
  };
  const document = {
    objective: "Retain stable order",
    scope: { includes: ["Ordering"], excludes: ["New requirements"] },
    acceptance: [{ key: "order", outcome: "The values have stable order" }],
    workItems: [planItem, { ...planItem, key: "stable-order", dependsOn: ["base"] }],
    limits: { maxConcurrentProjects: 2, maxActiveFeaturesPerProject: 1, attemptTimeoutSeconds: 60 },
  };
  const query = vi.fn((statement: string, parameters?: unknown[]) => {
    if (statement.includes("AS limit")) return { rows: [] };
    if (statement.includes("FROM factory_features feature JOIN projects"))
      return {
        rows: [{ id: featureId, project_id: projectId, state: "queued", approved_plan_version: 3 }],
      };
    if (statement.includes("SELECT plan.version, plan.document"))
      return { rows: [{ version: 3, document }] };
    if (statement.includes("SELECT id, key, board_column FROM factory_work_items"))
      return {
        rows: [
          { id: ownerId, key: "base", board_column: "in_review" },
          { id: itemId, key: "stable-order", board_column: "todo" },
        ],
      };
    if (statement.includes("WHERE work_item_id = $1 ORDER BY attempt"))
      return {
        rows: [{ id: runId, attempt: 1, plan_version: 3, source, accepted_commands: verification }],
      };
    if (statement.includes("FROM factory_human_gates gate"))
      return {
        rows: [
          {
            id: gateId,
            feature_id: featureId,
            work_item_id: itemId,
            run_id: runId,
            plan_version: 3,
            reason: "input_required",
            question: "Keep equal values in order?",
            required_decision: "clarify_within_plan",
            created_at: now,
            request_id: successorId,
            resolved_by: ownerId,
            decision: "resume_within_plan",
            answer: "Yes.",
            resolved_at: now,
            run_state: "blocked",
            run_failure: "input_required",
            attempt: 1,
            reservation_released_at: now,
            has_pending_container: false,
            latest_run_id: runId,
            successor_run_id: null,
            board_column: "todo",
          },
        ],
      };
    if (statement.includes("local_repository_sources"))
      throw new Error("A retry must not rebind the frozen source");
    if (statement.includes("INSERT INTO factory_execution_runs")) {
      expect(parameters).toEqual([
        featureId,
        projectId,
        itemId,
        3,
        2,
        JSON.stringify(source),
        JSON.stringify(verification),
        gateId,
      ]);
      return { rows: [{ id: successorId }] };
    }
    return { rows: [] };
  });
  const send = vi.fn().mockResolvedValue(successorId);
  const pool = { connect: () => ({ query, release: vi.fn() }) } as never;
  expect(await queueFactoryExecutions(pool, { send })).toEqual([successorId]);
  expect(send).toHaveBeenCalledExactlyOnceWith(
    "factory-execution-v1",
    { runId: successorId },
    expect.objectContaining({ id: successorId }),
  );
  expect(query.mock.calls.some(([sql]) => sql.includes("UPDATE factory_work_items"))).toBe(false);
});
