import { expect, it, vi } from "vitest";
import { FeaturePlanDocumentSchema } from "@kestrel/contracts";
import { saveFactoryPlan } from "./factory-plans.js";

const featureId = "01991c36-7f90-7000-8000-000000000001";
const projectId = "01991c36-7f90-7000-8000-000000000002";
const actorId = "01991c36-7f90-7000-8000-000000000003";
const requestId = "7c14d4d4-cdbe-4a40-8afc-abca43304be8";
const now = new Date("2026-09-08T12:00:00.000Z");
const legacyPlan = FeaturePlanDocumentSchema.parse({
  objective: "Document agreed search terminology",
  scope: { includes: ["Search glossary"], excludes: [] },
  acceptance: [{ key: "R1", outcome: "The glossary defines saved search" }],
  workItems: [
    {
      key: "W1",
      title: "Write glossary",
      description: "Apply agreed terminology",
      requirementKeys: ["R1"],
      acceptance: ["Saved search is defined"],
      dependsOn: [],
      verification: [
        { program: "node", args: ["--test", "glossary.test.mjs"], cwd: ".", timeoutSeconds: 60 },
      ],
    },
  ],
  limits: { maxConcurrentProjects: 2, maxActiveFeaturesPerProject: 1, attemptTimeoutSeconds: 1800 },
});

it.each([
  { empty: false, atLimit: false },
  { empty: true, atLimit: false },
  { empty: false, atLimit: true },
])(
  "replays omitted and empty proposals without rewriting stored history: %j",
  async ({ empty, atLimit }) => {
    const original = structuredClone(legacyPlan);
    if (atLimit) {
      original.objective = "x".repeat(4_000);
      original.scope.includes = Array.from({ length: 20 }, () => "x".repeat(2_000));
      original.scope.excludes = Array.from({ length: 20 }, () => "x".repeat(2_000));
      const item = original.workItems[0];
      const requirement = original.acceptance[0];
      if (item === undefined || requirement === undefined) throw new Error("Missing plan fixture");
      item.description = "x".repeat(8_000);
      requirement.outcome = "x".repeat(2_000);
      item.acceptance[0] = "x".repeat(
        96_000 - Buffer.byteLength(JSON.stringify(original)) + (item.acceptance[0]?.length ?? 0),
      );
      expect(Buffer.byteLength(JSON.stringify(original))).toBe(96_000);
    }
    const document = empty ? { ...original, proposedDocuments: [] } : original;
    const snapshot = JSON.stringify(document);
    const row = {
      id: "01991c36-7f90-7000-8000-000000000004",
      feature_id: featureId,
      version: 1,
      based_on_version: null,
      request_id: requestId,
      document,
      source_context: { commitId: "a".repeat(40), documents: [], notice: "Historical source." },
      plan_markdown: "# Original plan\n",
      spec_markdown: "# Original spec\n",
      author: "operator",
      created_by: actorId,
      created_at: now,
    };
    const query = vi.fn((sql: string, parameters?: unknown[]) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM factory_features") && sql.includes("FOR UPDATE"))
        return { rowCount: 1, rows: [{ id: featureId, project_id: projectId, state: "queued" }] };
      if (sql.includes("FROM factory_plan_versions")) {
        expect(parameters).toEqual([featureId, requestId]);
        return { rowCount: 1, rows: [row] };
      }
      throw new Error(`Unexpected mutation or read: ${sql}`);
    });
    const pool = { connect: () => ({ query, release: () => undefined }) } as never;
    const render = () => {
      throw new Error("A replay must not regenerate historical artifacts");
    };
    const command = {
      requestId,
      expectedVersion: null,
      plan: empty ? original : { ...original, proposedDocuments: [] },
    };
    const replay = await saveFactoryPlan(pool, projectId, featureId, actorId, command, render);
    expect(replay.document).toEqual(document);
    expect(JSON.stringify(row.document)).toBe(snapshot);
    expect(replay.planMarkdown).toBe("# Original plan");
    expect(replay.sourceContext).toEqual(row.source_context);
    await expect(
      saveFactoryPlan(
        pool,
        projectId,
        featureId,
        actorId,
        {
          ...command,
          plan: {
            ...legacyPlan,
            proposedDocuments: [
              {
                key: "glossary",
                kind: "glossary",
                path: "CONTEXT.md",
                pathIsProvisional: false,
                markdown: "# Language\nSaved search: a named set of filters.\n",
                workItemKey: "W1",
              },
            ],
          },
        },
        render,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  },
);
