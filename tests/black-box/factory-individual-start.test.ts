import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PlanningSkillCatalogSchema,
  FactoryIssueImportsSchema,
  FactoryIssuePublicationSchema,
  FeatureSchema,
  LocalRepositoryInventorySchema,
  ProjectUpsertedSchema,
  FactoryExecutionSchema,
  FactoryBoardSchema,
  FactoryWorkItemStartSchema,
  type FeaturePlanDocument,
} from "@kestrel/contracts";
import { startStack, type RunningStack } from "./support/compose.js";
import { createGitFixture } from "./support/git-fixture.js";
import { factoryGitHubFixture } from "./support/factory-github-fixture.js";

describe("Individual issue execution authority", () => {
  let stack: RunningStack;
  let projectId: string;
  let featureId: string;
  const cleanup: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    const source = await createGitFixture();
    cleanup.push(() => source.close());
    stack = await startStack({
      connectedCodexFixture: true,
      repositoryRoot: source.rootPath,
      githubFixture: factoryGitHubFixture,
    });
    cleanup.push(() => stack.close());
    await stack.authenticateOperator();
    // Hold only delivery in this DB-authority test. The actual server can dispatch;
    // this test drives competing worker claims explicitly and inspects them over HTTP.
    await stack.executeSql(`
      CREATE FUNCTION hold_execution_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name = 'factory-execution-v1' THEN NEW.start_after = clock_timestamp() + interval '1 hour'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER hold_execution_delivery BEFORE INSERT ON pgboss.job FOR EACH ROW EXECUTE FUNCTION hold_execution_delivery();
    `);
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories.find(({ displayName }) => displayName === "kestrel");
    if (repository === undefined) throw new Error("Fixture repository missing");
    const opened = await post("/api/v1/projects/local", { repositoryId: repository.repositoryId });
    projectId = ProjectUpsertedSchema.parse(await opened.json()).project.id;
    const created = await post(`/api/v1/projects/${projectId}/features`, {
      requestId: randomUUID(),
      title: "Implement a verified greeting",
    });
    featureId = FeatureSchema.parse(await created.json()).id;
  });
  afterAll(async () => {
    for (const close of cleanup.toReversed()) await close();
  });
  function post(path: string, body: unknown) {
    return stack.fetchApi(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("bootstraps both collections idempotently before the first interview", async () => {
    const catalog = PlanningSkillCatalogSchema.parse(
      await (await stack.fetchApi("/api/v1/planning-skills")).json(),
    );
    expect(catalog.skills.map((skill: { name: string }) => skill.name).sort()).toEqual([
      "brainstorming",
      "grill-with-docs",
    ]);
    await stack.executeWebModule(`
      import { createPool, bootstrapPlanningSkills } from '@kestrel/database';
      import { readBundledPlanningSkills } from './apps/web/dist/factory-bundled-skills.js';
      const pool = createPool(process.env.DATABASE_URL);
      try { await bootstrapPlanningSkills(pool, await readBundledPlanningSkills()); } finally { await pool.end(); }
    `);
    const repeated = PlanningSkillCatalogSchema.parse(
      await (await stack.fetchApi("/api/v1/planning-skills")).json(),
    );
    expect(repeated).toEqual(catalog);
  });

  it("reuses an existing GitHub issue for clarification without replacement or execution", async () => {
    const path = `/api/v1/projects/${projectId}/github-issues/12/start`;
    const responses = await Promise.all([
      post(path, { requestId: randomUUID() }),
      post(path, { requestId: randomUUID() }),
    ]);
    for (const response of responses)
      expect(response.status, await response.clone().text()).toBe(200);
    const features = await Promise.all(
      responses.map(async (response) => FeatureSchema.parse(await response.json())),
    );
    expect(features[0]?.id).toBe(features[1]?.id);
    const feature = features[0];
    if (feature === undefined) throw new Error("Issue interview missing");
    const featurePath = `/api/v1/projects/${projectId}/features/${feature.id}`;
    const imports = FactoryIssueImportsSchema.parse(
      await (await stack.fetchApi(`${featurePath}/imports`)).json(),
    );
    expect(imports.issues).toHaveLength(1);
    expect(imports.issues[0]?.issue.number).toBe(12);
    expect(
      FactoryExecutionSchema.parse(await (await stack.fetchApi(`${featurePath}/execution`)).json())
        .workItems,
    ).toEqual([]);
  });

  it("publishes without runs, starts only the chosen independent issue, and keeps identity on retry", async () => {
    const path = `/api/v1/projects/${projectId}/features/${featureId}`;
    const plan: FeaturePlanDocument = {
      objective: "Implement independent greetings",
      scope: { includes: ["Greetings"], excludes: ["Other changes"] },
      acceptance: [{ key: "greeting", outcome: "The greeting matches its test" }],
      workItems: ["first", "chosen"].map((key) => ({
        key,
        title: key,
        description: `Implement ${key}`,
        requirementKeys: ["greeting"],
        acceptance: ["Its approved test passes"],
        importedIssueId: null,
        dependsOn: [],
        verification: [
          { program: "node", args: ["--test", "greeting.test.mjs"], cwd: ".", timeoutSeconds: 60 },
        ],
      })),
      limits: {
        maxConcurrentProjects: 2,
        maxActiveFeaturesPerProject: 1,
        attemptTimeoutSeconds: 120,
      },
    };
    expect(
      (await post(`${path}/plans`, { requestId: randomUUID(), expectedVersion: null, plan }))
        .status,
    ).toBe(201);
    expect((await post(`${path}/plans/1/approve`, { requestId: randomUUID() })).status).toBe(200);
    await expect
      .poll(
        async () =>
          FactoryIssuePublicationSchema.parse(
            await (await stack.fetchApi(`${path}/publication`)).json(),
          ).state,
        {
          timeout: 25_000,
          interval: 250,
        },
      )
      .toBe("published");
    const before = FactoryExecutionSchema.parse(
      await (await stack.fetchApi(`${path}/execution`)).json(),
    );
    expect(before.workItems.flatMap((item) => item.runs)).toEqual([]);
    const board = FactoryBoardSchema.parse(await (await stack.fetchApi(`${path}/board`)).json());
    const chosen = board.columns
      .flatMap((column) => column.items)
      .find((item) => item.key === "chosen");
    if (chosen === undefined) throw new Error("Chosen issue missing");
    const start = () =>
      post(`${path}/work-items/${chosen.id}/start`, {
        requestId: randomUUID(),
        expectedVersion: 1,
      });
    const responses = await Promise.all([start(), start()]);
    for (const response of responses)
      expect(response.status, await response.clone().text()).toBe(200);
    const receipts = await Promise.all(
      responses.map(async (response) => FactoryWorkItemStartSchema.parse(await response.json())),
    );
    expect(receipts[0]).toEqual(receipts[1]);
    expect(receipts[0]?.workItemId).toBe(chosen.id);
    const receipt = receipts[0];
    if (receipt === undefined) throw new Error("Start receipt missing");
    await stack.restart("web");
    await expect
      .poll(
        async () => {
          const response = await stack.fetchApi(
            `/api/v1/projects/${projectId}/features/${receipt.executionFeatureId}/execution`,
          );
          expect(response.status, await response.clone().text()).toBe(200);
          const execution = FactoryExecutionSchema.parse(await response.json());
          return execution.workItems.flatMap((item) => item.runs).length;
        },
        { timeout: 25_000, interval: 250 },
      )
      .toBe(1);
    const original = FactoryExecutionSchema.parse(
      await (await stack.fetchApi(`${path}/execution`)).json(),
    );
    expect(original.workItems.flatMap((item) => item.runs)).toEqual([]);
  }, 90_000);
});
