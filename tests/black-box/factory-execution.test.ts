import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FeatureSchema,
  LocalRepositoryInventorySchema,
  ProjectUpsertedSchema,
  FactoryExecutionSchema,
  FactoryExecutionRunSchema,
  FactoryBoardSchema,
  type FeaturePlanDocument,
} from "@kestrel/contracts";
import { startStack, type RunningStack } from "./support/compose.js";
import { createGitFixture } from "./support/git-fixture.js";
import { factoryGitHubFixture } from "./support/factory-github-fixture.js";

describe("Factory execution authority", () => {
  let stack: RunningStack;
  let projectId: string;
  let featureId: string;
  const cleanup: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    const source = await createGitFixture();
    cleanup.push(() => source.close());
    stack = await startStack({
      repositoryRoot: source.rootPath,
      githubFixture: factoryGitHubFixture,
    });
    cleanup.push(() => stack.close());
    await stack.authenticateOperator();
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

  it("exposes no execution authority or runs before exact plan approval", async () => {
    const response = await stack.fetchApi(
      `/api/v1/projects/${projectId}/features/${featureId}/execution`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      featureId,
      state: "not_approved",
      failure: null,
      question: null,
      revision: null,
      workItems: [],
    });
  });

  it("claims published approved work once and retains its reservation through cancellation", async () => {
    const verification = [
      { program: "node", args: ["--test", "greeting.test.mjs"], cwd: ".", timeoutSeconds: 60 },
    ];
    const plan: FeaturePlanDocument = {
      objective: "Implement a greeting",
      scope: { includes: ["A greeting"], excludes: ["Other changes"] },
      acceptance: [{ key: "greeting", outcome: "The greeting matches its test" }],
      workItems: ["greeting", "consumer"].map((key, index) => ({
        key,
        title: key,
        description: `Implement ${key}`,
        requirementKeys: ["greeting"],
        acceptance: ["Its approved test passes"],
        importedIssueId: null,
        dependsOn: index === 0 ? [] : ["greeting"],
        verification,
      })),
      limits: {
        maxConcurrentProjects: 2,
        maxActiveFeaturesPerProject: 1,
        attemptTimeoutSeconds: 120,
      },
    };
    const path = `/api/v1/projects/${projectId}/features/${featureId}`;
    expect(
      (await post(`${path}/plans`, { requestId: randomUUID(), expectedVersion: null, plan }))
        .status,
    ).toBe(201);
    expect((await post(`${path}/plans/1/approve`, { requestId: randomUUID() })).status).toBe(200);
    await expect
      .poll(
        async () => {
          const response = await stack.fetchApi(`${path}/publication`);
          return ((await response.json()) as { state: string }).state;
        },
        { timeout: 25_000, interval: 250 },
      )
      .toBe("published");
    const claimed = JSON.parse(
      (
        await stack.executeWebModule(`
      import { randomUUID } from 'node:crypto';
      import { createPool, createPgBoss, queueFactoryExecutions, claimFactoryExecution } from '@kestrel/database';
      const pool = createPool(process.env.DATABASE_URL); const boss = createPgBoss({applicationName:'execution-test',databaseUrl:process.env.DATABASE_URL});
      try {
        await boss.start();
        const queued = (await Promise.all([queueFactoryExecutions(pool,boss),queueFactoryExecutions(pool,boss),queueFactoryExecutions(pool,boss)])).flat();
        if (queued.length !== 1) throw new Error('Duplicate writer reservations');
        const claims = await Promise.all([claimFactoryExecution(pool,queued[0],randomUUID()),claimFactoryExecution(pool,queued[0],randomUUID())]);
        const accepted = claims.filter(Boolean); if (accepted.length !== 1) throw new Error('Duplicate writer claims');
        console.log(JSON.stringify(accepted[0]));
      } finally { await boss.stop(); await pool.end(); }
    `)
      ).trim(),
    ) as { id: string; ownerInstanceId: string; key: string };
    expect(claimed.key).toBe("greeting");
    const executionResponse = await stack.fetchApi(`${path}/execution`);
    expect(executionResponse.status, await executionResponse.clone().text()).toBe(200);
    const execution = FactoryExecutionSchema.parse(await executionResponse.json());
    expect(execution.state).toBe("running");
    expect(execution.workItems[0]?.runs).toHaveLength(1);
    expect(execution.workItems[1]?.runs).toEqual([]);
    const boardResponse = await stack.fetchApi(`${path}/board`);
    expect(boardResponse.status, await boardResponse.clone().text()).toBe(200);
    expect(
      FactoryBoardSchema.parse(await boardResponse.json()).columns.find(
        (column) => column.id === "in_progress",
      )?.items[0]?.key,
    ).toBe("greeting");
    const detail = FactoryExecutionRunSchema.parse(
      await (await stack.fetchApi(`${path}/execution/runs/${claimed.id}`)).json(),
    );
    expect(detail.acceptedCommands).toEqual(verification);
    expect(detail.verification).toEqual([]);
    expect(detail.writerStopped).toBe(false);
    const containerName = `kestrel-factory-${randomUUID()}`;
    const containerId = "a".repeat(64);
    await stack.executeWebModule(`
      import { createPool, reserveFactoryExecutionContainer, identifyFactoryExecutionContainer } from '@kestrel/database';
      const pool=createPool(process.env.DATABASE_URL);
      const run=${JSON.stringify(claimed)};
      try {
        await reserveFactoryExecutionContainer(pool,run,${JSON.stringify(containerName)},'implementation');
        await identifyFactoryExecutionContainer(pool,run,{name:${JSON.stringify(containerName)},id:${JSON.stringify(containerId)}});
      } finally { await pool.end(); }
    `);
    const cancel = await post(`${path}/cancel`, { requestId: randomUUID(), expectedVersion: 1 });
    expect(cancel.status, await cancel.clone().text()).toBe(200);
    expect(
      FactoryExecutionSchema.parse(await (await stack.fetchApi(`${path}/execution`)).json()).state,
    ).toBe("stopping");
    expect(
      JSON.parse(
        await stack.executeWebModule(`
      import { createPool, claimFactoryExecution } from '@kestrel/database';
      import { randomUUID } from 'node:crypto';
      const pool=createPool(process.env.DATABASE_URL);
      try { console.log(JSON.stringify(await claimFactoryExecution(pool,${JSON.stringify(claimed.id)},randomUUID()))); }
      finally { await pool.end(); }
    `),
      ),
    ).toBeNull();
    await stack.executeWebModule(`
      import { createPool, finishFactoryExecution } from '@kestrel/database';
      const pool=createPool(process.env.DATABASE_URL);
      try { await finishFactoryExecution(pool,${JSON.stringify(claimed)},{verified:false,writerStopped:true,failure:'cancelled',question:null}); }
      finally { await pool.end(); }
    `);
    const uncertain = FactoryExecutionSchema.parse(
      await (await stack.fetchApi(`${path}/execution`)).json(),
    );
    expect(uncertain).toMatchObject({ state: "stopping", failure: "stop_unconfirmed" });
    expect(uncertain.workItems[0]?.runs[0]?.writerStopped).toBe(false);
    await stack.executeWebModule(`
      import { createPool, stopFactoryExecutionContainer, finishFactoryExecution } from '@kestrel/database';
      const pool=createPool(process.env.DATABASE_URL); const run=${JSON.stringify(claimed)};
      try {
        try { await stopFactoryExecutionContainer(pool,run,{name:${JSON.stringify(containerName)},id:${JSON.stringify("b".repeat(64))}}); throw new Error('Wrong container accepted'); }
        catch (error) { if(error.code!=='conflict') throw error; }
        await stopFactoryExecutionContainer(pool,run,{name:${JSON.stringify(containerName)},id:${JSON.stringify(containerId)}});
        await finishFactoryExecution(pool,run,{verified:false,writerStopped:true,failure:'cancelled',question:null});
      } finally { await pool.end(); }
    `);
    expect(
      FactoryExecutionSchema.parse(await (await stack.fetchApi(`${path}/execution`)).json()),
    ).toMatchObject({ state: "cancelled", failure: "cancelled" });
  });
});
