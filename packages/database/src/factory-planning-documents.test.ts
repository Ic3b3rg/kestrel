import { expect, it, vi } from "vitest";
import { readFactoryChat } from "./factory-planning.js";

it("links generated replies to their own immutable plan version and leaves ordinary messages unlinked", async () => {
  const featureId = "01991c36-7f90-7000-8000-000000000001";
  const projectId = "01991c36-7f90-7000-8000-000000000002";
  const now = new Date("2026-09-08T12:00:00.000Z");
  const messages = [
    {
      id: "01991c36-7f90-7000-8000-000000000003",
      role: "assistant",
      content: "Plan version 1 is ready",
      created_at: now,
      generated_plan_version: 1,
    },
    {
      id: "01991c36-7f90-7000-8000-000000000004",
      role: "assistant",
      content: "Plan version 3 is ready",
      created_at: now,
      generated_plan_version: 3,
    },
    {
      id: "01991c36-7f90-7000-8000-000000000005",
      role: "user",
      content: "My text says plan version 99",
      created_at: now,
      generated_plan_version: null,
    },
    {
      id: "01991c36-7f90-7000-8000-000000000006",
      role: "assistant",
      content: "One more question",
      created_at: now,
      generated_plan_version: null,
    },
  ];
  const query = vi.fn((sql: string, parameters?: unknown[]) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
    if (sql.includes("SELECT id FROM factory_features WHERE EXISTS"))
      return { rowCount: 0, rows: [] };
    if (sql.includes("FROM factory_features"))
      return {
        rowCount: 1,
        rows: [
          {
            id: featureId,
            project_id: projectId,
            title: "Search",
            state: "planning",
            latest_plan_version: 4,
            planning_context: null,
            skill_selection_version: 0,
            created_at: now,
            updated_at: now,
          },
        ],
      };
    if (sql.includes("FROM factory_planning_messages")) {
      expect(parameters).toEqual([featureId]);
      return { rowCount: messages.length, rows: messages };
    }
    if (sql.includes("FROM factory_planning_turns")) return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected read: ${sql}`);
  });
  const pool = { query, connect: () => ({ query, release: () => undefined }) } as never;
  const chat = await readFactoryChat(pool, projectId, featureId);
  expect(chat.messages[0]).toMatchObject({ generatedPlanVersion: 1 });
  expect(chat.messages[1]).toMatchObject({ generatedPlanVersion: 3 });
  expect(chat.messages[2]).not.toHaveProperty("generatedPlanVersion");
  expect(chat.messages[3]).not.toHaveProperty("generatedPlanVersion");
  const sql = query.mock.calls.find(([sql]) => sql.includes("FROM factory_planning_messages"))?.[0];
  expect(sql).toContain("plan.source_turn_id = message.reply_to_turn_id");
  expect(sql).toContain("plan.feature_id = message.feature_id");
});
