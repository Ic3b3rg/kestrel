import { beforeEach, expect, it, vi } from "vitest";
import { completePlanningTurn, type FeatureRow } from "./factory-planning.js";
import { startPlanningFeature } from "./factory-start.js";
import type * as skillModule from "./factory-skills.js";

const skills = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("./factory-skills.js", async (original) => ({
  ...(await original<typeof skillModule>()),
  resolvePlanningSkillInvocation: skills.resolve,
}));
beforeEach(() => {
  skills.resolve
    .mockReset()
    .mockImplementation((_client, _text, selected) => Promise.resolve(selected));
});

const featureId = "01991c36-7f90-7000-8000-000000000001";
const projectId = "01991c36-7f90-7000-8000-000000000002";
const turnId = "01991c36-7f90-7000-8000-000000000003";
const messageId = "01991c36-7f90-7000-8000-000000000004";
const actorId = "01991c36-7f90-7000-8000-000000000005";
const command = {
  requestId: "59b1c9d6-414c-4b98-9d62-1e2e6d092004",
  text: "Plan saved report search",
  skillDigests: [] as string[],
};
const feature: FeatureRow = {
  id: featureId,
  project_id: projectId,
  title: "New plan",
  title_source: "pending",
  initial_title: "New plan",
  state: "planning",
  planning_context: null,
  skill_selection_version: 0,
  runtime_thread_id: null,
  latest_plan_version: null,
  approved_plan_version: null,
  cancel_request_id: null,
  created_at: new Date("2026-09-08T10:00:00.000Z"),
  updated_at: new Date("2026-09-08T10:00:00.000Z"),
};

function startFixture(existing?: Record<string, unknown>) {
  const query = vi.fn((sql: string, parameters?: unknown[]) => {
    void parameters;
    if (sql.startsWith("SELECT id FROM projects"))
      return Promise.resolve({ rowCount: 1, rows: [{ id: projectId }] });
    if (sql.includes("FROM factory_planning_starts"))
      return Promise.resolve({
        rowCount: existing === undefined ? 0 : 1,
        rows: existing === undefined ? [] : [existing],
      });
    if (sql.startsWith("SELECT count(*)"))
      return Promise.resolve({ rowCount: 1, rows: [{ count: "0" }] });
    if (sql.startsWith("INSERT INTO factory_features"))
      return Promise.resolve({ rowCount: 1, rows: [feature] });
    if (sql.startsWith("INSERT INTO factory_planning_messages"))
      return Promise.resolve({ rowCount: 1, rows: [{ id: messageId }] });
    if (sql.startsWith("INSERT INTO factory_planning_turns"))
      return Promise.resolve({ rowCount: 1, rows: [{ id: turnId }] });
    return Promise.resolve({ rowCount: 0, rows: [] });
  });
  const release = vi.fn();
  const client = { query, release };
  const connect = vi.fn(() => Promise.resolve(client));
  const send = vi.fn(
    async (
      _name: string,
      _data: unknown,
      options: { db: { executeSql: (sql: string, values: unknown[]) => Promise<unknown> } },
    ): Promise<string | null> => {
      await options.db.executeSql("INSERT durable queue job", [turnId]);
      return turnId;
    },
  );
  return { pool: { connect } as never, boss: { send } as never, query, connect, release, send };
}

it("accepts the first message, merged Skill selection and queue job in one transaction", async () => {
  const selected = "a".repeat(64);
  const invoked = "b".repeat(64);
  skills.resolve.mockResolvedValue([selected, invoked]);
  const fixture = startFixture();
  const first = { ...command, text: "$grilling Define search", skillDigests: [selected] };
  const result = await startPlanningFeature(fixture.pool, fixture.boss, projectId, actorId, first);
  expect(result).toMatchObject({
    feature: { id: featureId, title: "New plan" },
    messageId,
    turnId,
  });
  expect(fixture.connect).toHaveBeenCalledTimes(1);
  expect(skills.resolve).toHaveBeenCalledWith(expect.anything(), first.text, [selected]);
  const selectionWrites = fixture.query.mock.calls.filter(([sql]) =>
    sql.startsWith("INSERT INTO factory_feature_skill_selections"),
  );
  expect(selectionWrites).toHaveLength(1);
  expect(selectionWrites[0]?.[1]).toEqual([
    featureId,
    1,
    first.requestId,
    JSON.stringify([selected, invoked]),
  ]);
  const immutableStart = fixture.query.mock.calls.find(([sql]) =>
    sql.startsWith("INSERT INTO factory_planning_starts"),
  );
  expect(immutableStart?.[1]).toEqual([
    featureId,
    actorId,
    first.requestId,
    first.text,
    JSON.stringify([selected]),
    messageId,
    turnId,
  ]);
  const statements = fixture.query.mock.calls.map(([sql]) => sql);
  expect(statements[0]).toBe("BEGIN");
  expect(statements.indexOf("INSERT durable queue job")).toBeLessThan(statements.indexOf("COMMIT"));
  expect(statements.at(-1)).toBe("COMMIT");
  expect(fixture.release).toHaveBeenCalledOnce();
});

it.each(["Skill rejection", "queue failure"])(
  "rolls back the new Feature and message after %s",
  async (failure) => {
    const fixture = startFixture();
    if (failure === "Skill rejection")
      skills.resolve.mockRejectedValue(new Error("Skill unavailable"));
    else fixture.send.mockResolvedValue(null);
    await expect(
      startPlanningFeature(fixture.pool, fixture.boss, projectId, actorId, command),
    ).rejects.toThrow();
    const statements = fixture.query.mock.calls.map(([sql]) => sql);
    expect(statements.some((sql) => sql.startsWith("INSERT INTO factory_features"))).toBe(true);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(statements.some((sql) => sql.startsWith("INSERT INTO factory_planning_starts"))).toBe(
      false,
    );
    expect(fixture.release).toHaveBeenCalledOnce();
  },
);

it("replays the original request after rename without repeating message or queue effects", async () => {
  const fixture = startFixture({
    ...feature,
    title: "Operator name",
    title_source: "operator",
    first_prompt: command.text,
    skill_digests: [],
    message_id: messageId,
    turn_id: turnId,
  });
  expect(
    await startPlanningFeature(fixture.pool, fixture.boss, projectId, actorId, command),
  ).toMatchObject({ feature: { title: "Operator name" }, messageId, turnId });
  expect(fixture.send).not.toHaveBeenCalled();
  expect(fixture.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
});

it.each([{ text: "Changed prompt" }, { skillDigests: ["a".repeat(64)] }])(
  "rejects reuse of an accepted request with changed content %j",
  async (change) => {
    const fixture = startFixture({
      ...feature,
      first_prompt: command.text,
      skill_digests: [],
      message_id: messageId,
      turn_id: turnId,
    });
    await expect(
      startPlanningFeature(fixture.pool, fixture.boss, projectId, actorId, {
        ...command,
        ...change,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(fixture.send).not.toHaveBeenCalled();
  },
);

it.each(["pending", "operator"])(
  "saves a generated title only while its source is %s",
  async (source) => {
    let title = source === "pending" ? "New plan" : "Operator's saved title";
    const query = vi.fn((sql: string, parameters?: unknown[]) => {
      if (sql.includes("FROM factory_features") && sql.includes("FOR UPDATE"))
        return {
          rowCount: 1,
          rows: [{ id: featureId, project_id: projectId, title, title_source: source }],
        };
      if (sql.includes("UPDATE factory_planning_turns"))
        return { rowCount: 1, rows: [{ id: turnId }] };
      if (sql.includes("SET title =")) {
        expect(sql).toContain("title_source = 'pending'");
        if (source === "pending") title = String(parameters?.[1]);
      }
      return { rowCount: 1, rows: [] };
    });
    await completePlanningTurn(
      { connect: () => ({ query, release: vi.fn() }) } as never,
      { id: turnId, featureId, projectId, purpose: "conversation", needsTitle: true } as never,
      { text: "Which reports need searching?", title: "Saved report search" },
    );
    expect(title).toBe(source === "pending" ? "Saved report search" : "Operator's saved title");
  },
);
