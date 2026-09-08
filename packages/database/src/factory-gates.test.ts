import { expect, it, vi } from "vitest";

import { factoryGateForRetry, readFactoryGate, resolveFactoryGate } from "./factory-gates.js";

const featureId = "01991c36-7f90-7000-8000-000000000001";
const projectId = "01991c36-7f90-7000-8000-000000000002";
const runId = "01991c36-7f90-7000-8000-000000000003";
const itemId = "01991c36-7f90-7000-8000-000000000004";
const gateId = "01991c36-7f90-7000-8000-000000000005";
const operatorId = "01991c36-7f90-7000-8000-000000000006";
const requestId = "01991c36-7f90-7000-8000-000000000007";
const otherId = "01991c36-7f90-7000-8000-000000000008";
const now = new Date("2026-09-08T12:00:00.000Z");

function storage() {
  const feature = {
    id: featureId,
    project_id: projectId,
    state: "gated",
    approved_plan_version: 3,
  };
  const gate = {
    id: gateId,
    feature_id: featureId,
    work_item_id: itemId,
    run_id: runId,
    plan_version: 3,
    reason: "input_required",
    question: "Should equal results retain their original order?",
    required_decision: "clarify_within_plan",
    created_at: now,
    request_id: null as string | null,
    resolved_by: null as string | null,
    decision: null as string | null,
    answer: null as string | null,
    resolved_at: null as Date | null,
    run_state: "blocked",
    run_failure: "input_required",
    attempt: 1,
    reservation_released_at: now as Date | null,
    has_pending_container: false,
    latest_run_id: runId,
    successor_run_id: null as string | null,
    board_column: "todo",
  };
  const activity: string[] = [];
  const query = vi.fn((statement: string, parameters?: unknown[]) => {
    if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK")
      return { rowCount: 0, rows: [] };
    if (statement.includes("FROM factory_features") && statement.includes("FOR UPDATE"))
      return { rowCount: 1, rows: [{ ...feature }] };
    if (statement.includes("FROM factory_human_gates gate")) {
      const matches =
        parameters?.[0] === featureId &&
        (statement.includes("gate.request_id = $2")
          ? parameters[1] === gate.request_id
          : statement.includes("gate.run_id = $2")
            ? parameters[1] === gate.run_id
            : parameters[1] === gate.id);
      return { rowCount: matches ? 1 : 0, rows: matches ? [{ ...gate }] : [] };
    }
    if (statement.includes("UPDATE factory_human_gates")) {
      if (gate.resolved_at !== null) return { rowCount: 0, rows: [] };
      Object.assign(gate, {
        request_id: parameters?.[1],
        resolved_by: parameters?.[2],
        decision: parameters?.[3],
        answer: parameters?.[4],
        resolved_at: now,
      });
      return { rowCount: 1, rows: [{ id: gate.id }] };
    }
    if (statement.includes("UPDATE factory_features")) {
      feature.state = "queued";
      return { rowCount: 1, rows: [] };
    }
    if (statement.includes("INSERT INTO factory_activity")) {
      activity.push(String(parameters?.[2]));
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected query: ${statement}`);
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: () => client } as never;
  return { feature, gate, activity, query, client, pool };
}

const answer = {
  requestId,
  expectedPlanVersion: 3,
  decision: "resume_within_plan" as const,
  answer: "Preserve the original order when values are equal.",
};

it("records one bounded answer and permits one scheduler admission on the same plan", async () => {
  const state = storage();
  const result = await resolveFactoryGate(
    state.pool,
    projectId,
    featureId,
    gateId,
    operatorId,
    answer,
  );
  expect(result).toMatchObject({
    runId,
    workItemId: itemId,
    approvedVersion: 3,
    resolution: { requestId, operatorId, decision: "resume_within_plan", answer: answer.answer },
  });
  expect(state.feature.state).toBe("queued");
  expect(
    await factoryGateForRetry(state.client as never, state.feature as never, runId),
  ).toMatchObject({ id: gateId });
  state.gate.successor_run_id = otherId;
  expect(
    await factoryGateForRetry(state.client as never, state.feature as never, runId),
  ).toBeNull();
  expect(
    await resolveFactoryGate(state.pool, projectId, featureId, gateId, operatorId, answer),
  ).toMatchObject({ successorRunId: otherId });
  expect(state.activity).toHaveLength(1);
  expect(
    state.query.mock.calls.filter(([sql]) => sql.includes("UPDATE factory_features")),
  ).toHaveLength(1);
});

it.each([
  { answer: "Use a different technical choice." },
  { expectedPlanVersion: 4 },
  { decision: "requires_plan_change" as const },
])("rejects reuse of an answer identity with different content: %j", async (change) => {
  const state = storage();
  await resolveFactoryGate(state.pool, projectId, featureId, gateId, operatorId, answer);
  await expect(
    resolveFactoryGate(state.pool, projectId, featureId, gateId, operatorId, {
      ...answer,
      ...change,
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(state.activity).toHaveLength(1);
});

it("does not let another operator or another gate reuse the answer identity", async () => {
  const state = storage();
  await resolveFactoryGate(state.pool, projectId, featureId, gateId, operatorId, answer);
  await expect(
    resolveFactoryGate(state.pool, projectId, featureId, gateId, otherId, answer),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    resolveFactoryGate(state.pool, projectId, featureId, otherId, operatorId, answer),
  ).rejects.toMatchObject({ code: "conflict" });
});

it("rejects stale plan versions and a second decision with a fresh request identity", async () => {
  const state = storage();
  await expect(
    resolveFactoryGate(state.pool, projectId, featureId, gateId, operatorId, {
      ...answer,
      expectedPlanVersion: 2,
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(state.gate.resolved_at).toBeNull();
  await resolveFactoryGate(state.pool, projectId, featureId, gateId, operatorId, answer);
  await expect(
    resolveFactoryGate(state.pool, projectId, featureId, gateId, operatorId, {
      ...answer,
      requestId: otherId,
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(state.activity).toHaveLength(1);
});

it.each([
  { reservation_released_at: null },
  { has_pending_container: true },
  { run_state: "running" },
])(
  "never authorizes a successor without proof the previous writer stopped: %j",
  async (uncertain) => {
    const state = storage();
    Object.assign(state.gate, uncertain);
    const gate = await readFactoryGate(state.pool, projectId, featureId, gateId);
    expect(gate).toMatchObject({
      canResume: false,
      resumeBlockedReason: "unconfirmed_stop",
      question: state.gate.question,
    });
    await expect(
      resolveFactoryGate(state.pool, projectId, featureId, gateId, operatorId, answer),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(state.feature.state).toBe("gated");
    expect(state.gate.resolved_at).toBeNull();
  },
);

it.each(["source_changed", "revision_changed"])(
  "does not treat a text answer as reconciliation of %s",
  async (reason) => {
    const state = storage();
    state.gate.run_failure = reason;
    expect(await readFactoryGate(state.pool, projectId, featureId, gateId)).toMatchObject({
      canResume: false,
      resumeBlockedReason: "workspace_uncertain",
    });
    await expect(
      resolveFactoryGate(state.pool, projectId, featureId, gateId, operatorId, answer),
    ).rejects.toMatchObject({ code: "conflict" });
  },
);

it("records a required plan change without changing approval, Work Items, or queue eligibility", async () => {
  const state = storage();
  const command = { ...answer, decision: "requires_plan_change" as const };
  const result = await resolveFactoryGate(
    state.pool,
    projectId,
    featureId,
    gateId,
    operatorId,
    command,
  );
  expect(result).toMatchObject({
    canResume: false,
    resumeBlockedReason: "plan_change_required",
    resolution: { decision: "requires_plan_change" },
  });
  expect(state.feature).toMatchObject({ state: "gated", approved_plan_version: 3 });
  expect(state.gate.board_column).toBe("todo");
  expect(
    await factoryGateForRetry(state.client as never, state.feature as never, runId),
  ).toBeNull();
  expect(
    await resolveFactoryGate(state.pool, projectId, featureId, gateId, operatorId, command),
  ).toEqual(result);
});

it.each([
  { latest_run_id: otherId },
  { board_column: "in_review" },
  { run_state: "verified" },
  { attempt: 20 },
])("preserves verified or superseded boundaries and the attempt cap: %j", async (boundary) => {
  const state = storage();
  Object.assign(state.gate, boundary);
  await expect(
    resolveFactoryGate(state.pool, projectId, featureId, gateId, operatorId, answer),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(state.gate.resolved_at).toBeNull();
});

it("keeps an exact answer replay inspectable after cancellation without resuming", async () => {
  const state = storage();
  await resolveFactoryGate(state.pool, projectId, featureId, gateId, operatorId, answer);
  state.feature.state = "cancelled";
  expect(
    await resolveFactoryGate(state.pool, projectId, featureId, gateId, operatorId, answer),
  ).toMatchObject({ resumeBlockedReason: "cancelled", canResume: false });
  expect(
    await factoryGateForRetry(state.client as never, state.feature as never, runId),
  ).toBeNull();
  expect(state.feature.state).toBe("cancelled");
});
