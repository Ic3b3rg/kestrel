import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LifecycleProfileViewSchema,
  PlanningSkillCatalogSchema,
  FactoryIssueImportsSchema,
  FactoryIssuePublicationSchema,
  FeatureSchema,
  FeatureChatSchema,
  LocalRepositoryInventorySchema,
  ProjectUpsertedSchema,
  FactoryExecutionSchema,
  FactoryBoardSchema,
  FactoryWorkItemStartSchema,
  ProjectBoardSnapshotSchema,
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
    const profilePath = "/api/v1/lifecycle-profiles/planning";
    const profile = LifecycleProfileViewSchema.parse(
      await (await stack.fetchApi(profilePath)).json(),
    );
    expect(profile.resolved?.skills.map(({ name }) => name)).toEqual(["grill-with-docs"]);
    const chosen = catalog.skills.find(({ name }) => name === "brainstorming");
    if (chosen === undefined) throw new Error("Bundled brainstorming missing");
    const saved = await stack.fetchApi(profilePath, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: profile.versions.installation,
        settings: { skillDigests: [chosen.contentDigest] },
      }),
    });
    expect(saved.status).toBe(200);
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
    const preserved = LifecycleProfileViewSchema.parse(
      await (await stack.fetchApi(profilePath)).json(),
    );
    expect(preserved.resolved?.skills.map(({ name }) => name)).toEqual(["brainstorming"]);
  });

  it("keeps a configured bundled version usable after an explicit library update", async () => {
    const result = await stack.executeWebModule(`
      import { createHash, randomUUID } from 'node:crypto';
      import { createPool, retainGitHubPlanningSkill, installGitHubPlanningSkill, bootstrapPlanningSkills } from '@kestrel/database';
      import { requireInstalledPlanningSkills } from './packages/database/dist/factory-skills.js';
      import { readBundledPlanningSkills } from './apps/web/dist/factory-bundled-skills.js';
      const pool=createPool(process.env.DATABASE_URL);
      try {
        const bundles=await readBundledPlanningSkills(); const original=bundles.find(bundle=>bundle.name==='brainstorming');
        const files=original.files.map(file=>file.path==='SKILL.md'?{...file,content:file.content+'\\nUpdated procedure.\\n'}:file);
        const updated={...original,files,contentDigest:createHash('sha256').update(JSON.stringify(files)).digest('hex')};
        await retainGitHubPlanningSkill(pool,updated);
        const actor=(await pool.query('SELECT id FROM operators LIMIT 1')).rows[0].id;
        await installGitHubPlanningSkill(pool,actor,{requestId:randomUUID(),digest:updated.contentDigest});
        await requireInstalledPlanningSkills(pool,[original.contentDigest]);
        await bootstrapPlanningSkills(pool,bundles);
        const current=(await pool.query('SELECT digest FROM factory_planning_skill_catalog WHERE name=$1',['brainstorming'])).rows[0];
        console.log(JSON.stringify({preserved:current.digest===updated.contentDigest}));
      } finally {await pool.end();}
    `);
    expect(JSON.parse(result)).toEqual({ preserved: true });
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
    const commands = [0, 1].map(() => ({ requestId: randomUUID(), expectedVersion: 1 }));
    const responses = await Promise.all(
      commands.map((command) => post(`${path}/work-items/${chosen.id}/start`, command)),
    );
    for (const response of responses)
      expect(response.status, await response.clone().text()).toBe(200);
    const receipts = await Promise.all(
      responses.map(async (response) => FactoryWorkItemStartSchema.parse(await response.json())),
    );
    expect(receipts[0]).toEqual(receipts[1]);
    expect(receipts[0]?.workItemId).toBe(chosen.id);
    const receipt = receipts[0];
    if (receipt === undefined) throw new Error("Start receipt missing");
    const projectBoard = ProjectBoardSnapshotSchema.parse(
      await (await stack.fetchApi(`/api/v1/projects/${projectId}/board`)).json(),
    );
    expect(projectBoard.workItems.find(({ item }) => item.id === chosen.id)).toMatchObject({
      queued: true,
      item: { column: "in_progress", executionFeatureId: receipt.executionFeatureId },
    });
    expect(
      projectBoard.workItems
        .filter(({ item }) => item.featureId === featureId && item.id !== chosen.id)
        .map(({ item }) => ({
          key: item.key,
          column: item.column,
          executionFeatureId: item.executionFeatureId,
        })),
    ).toEqual([{ key: "first", column: "todo", executionFeatureId: null }]);
    const childChat = FeatureChatSchema.parse(
      await (
        await stack.fetchApi(`/api/v1/projects/${projectId}/features/${receipt.executionFeatureId}`)
      ).json(),
    );
    expect(childChat.messages).toHaveLength(1);
    expect(childChat.messages[0]?.content).toContain("Implement [issue #");
    expect(childChat.messages[0]?.content).toContain(chosen.providerUrl);
    expect(childChat.turns).toHaveLength(0);
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
    const cancellation = await post(
      `/api/v1/projects/${projectId}/features/${receipt.executionFeatureId}/cancel`,
      { requestId: randomUUID(), expectedVersion: 1 },
    );
    expect(cancellation.status, await cancellation.clone().text()).toBe(200);
    const cancelledBoard = FactoryBoardSchema.parse(
      await (await stack.fetchApi(`${path}/board`)).json(),
    );
    const cancelledItem = cancelledBoard.columns
      .flatMap((column) => column.items)
      .find((item) => item.id === chosen.id);
    expect(cancelledItem?.column).toBe("todo");
    expect(cancelledItem?.blocking).toBeNull();
    expect(cancelledItem?.executionFeatureId).toBeNull();
    const cancelledProjectBoard = ProjectBoardSnapshotSchema.parse(
      await (await stack.fetchApi(`/api/v1/projects/${projectId}/board`)).json(),
    );
    expect(cancelledProjectBoard.workItems.find(({ item }) => item.id === chosen.id)).toMatchObject(
      {
        queued: false,
        item: { column: "todo", executionFeatureId: null },
      },
    );
    const restartCommand = { requestId: randomUUID(), expectedVersion: 1 };
    const restartedResponse = await post(`${path}/work-items/${chosen.id}/start`, restartCommand);
    expect(restartedResponse.status, await restartedResponse.clone().text()).toBe(200);
    const restarted = FactoryWorkItemStartSchema.parse(await restartedResponse.json());
    expect(restarted.executionFeatureId).not.toBe(receipt.executionFeatureId);
    expect(
      FactoryWorkItemStartSchema.parse(
        await (await post(`${path}/work-items/${chosen.id}/start`, restartCommand)).json(),
      ),
    ).toEqual(restarted);
    for (const command of commands)
      expect(
        FactoryWorkItemStartSchema.parse(
          await (await post(`${path}/work-items/${chosen.id}/start`, command)).json(),
        ),
      ).toEqual(receipt);
    const retained = FactoryExecutionSchema.parse(
      await (
        await stack.fetchApi(
          `/api/v1/projects/${projectId}/features/${receipt.executionFeatureId}/execution`,
        )
      ).json(),
    );
    expect(retained.state).toBe("cancelled");
    expect(retained.workItems.flatMap((item) => item.runs).length).toBeGreaterThanOrEqual(1);
    const restartedBoard = FactoryBoardSchema.parse(
      await (await stack.fetchApi(`${path}/board`)).json(),
    );
    expect(
      restartedBoard.columns
        .flatMap((column) => column.items)
        .filter((item) => item.id === chosen.id),
    ).toHaveLength(1);
  }, 90_000);
});
