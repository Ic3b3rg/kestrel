import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FactoryBoardSchema,
  FactoryExecutionSchema,
  FactoryExecutionRunSchema,
  FactoryGateSchema,
  FeatureSchema,
  LocalRepositoryInventorySchema,
  ProjectUpsertedSchema,
  type FactoryGate,
  type FeaturePlanDocument,
} from "@kestrel/contracts";
import type { ClaimedFactoryExecution } from "@kestrel/database";
import { startStack, type RunningStack } from "./support/compose.js";
import { createGitFixture } from "./support/git-fixture.js";
import { factoryGitHubFixture } from "./support/factory-github-fixture.js";

const verification = [
  { program: "node", args: ["--test", "order.test.mjs"], cwd: ".", timeoutSeconds: 60 },
];
const plan: FeaturePlanDocument = {
  objective: "Keep results in stable order",
  scope: { includes: ["Stable ordering"], excludes: ["New filters"] },
  acceptance: [{ key: "order", outcome: "Equal values retain their original order" }],
  workItems: ["order", "consumer"].map((key, index) => ({
    key,
    title: key,
    description: `Implement ${key}`,
    requirementKeys: ["order"],
    acceptance: ["The approved ordering check passes"],
    importedIssueId: null,
    dependsOn: index === 0 ? [] : ["order"],
    verification,
  })),
  limits: { maxConcurrentProjects: 2, maxActiveFeaturesPerProject: 1, attemptTimeoutSeconds: 120 },
};

describe("Factory Human Gates over HTTP and PostgreSQL", () => {
  let stack: RunningStack;
  const cleanup: Array<() => Promise<void>> = [];
  const projects: Record<string, string> = {};
  let first: string;
  let queued: string;
  let other: string;
  let third: string;
  let gate: FactoryGate;
  let original: ClaimedFactoryExecution;
  const path = (project: string, feature: string) =>
    `/api/v1/projects/${project}/features/${feature}`;
  function post(endpoint: string, body: unknown) {
    return stack.fetchApi(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function module<T>(source: string): Promise<T> {
    return JSON.parse(
      await stack.executeWebModule(`
      import * as db from '@kestrel/database';
      import { randomUUID } from 'node:crypto';
      const pool = db.createPool(process.env.DATABASE_URL);
      const boss = db.createPgBoss({applicationName:'gate-authority-test',databaseUrl:process.env.DATABASE_URL});
      try { await boss.start(); ${source} }
      finally { await boss.stop(); await pool.end(); }
    `),
    ) as T;
  }
  async function approve(project: string, title: string, document = plan) {
    const feature = FeatureSchema.parse(
      await (
        await post(`/api/v1/projects/${project}/features`, { requestId: randomUUID(), title })
      ).json(),
    );
    const endpoint = path(project, feature.id);
    expect(
      (
        await post(`${endpoint}/plans`, {
          requestId: randomUUID(),
          expectedVersion: null,
          plan: document,
        })
      ).status,
    ).toBe(201);
    expect((await post(`${endpoint}/plans/1/approve`, { requestId: randomUUID() })).status).toBe(
      200,
    );
    await expect
      .poll(
        async () =>
          ((await (await stack.fetchApi(`${endpoint}/publication`)).json()) as { state: string })
            .state,
        { timeout: 25_000, interval: 200 },
      )
      .toBe("published");
    return feature.id;
  }
  async function claim(features: string[]) {
    return module<ClaimedFactoryExecution[]>(`
      await Promise.all([db.queueFactoryExecutions(pool,boss),db.queueFactoryExecutions(pool,boss)]);
      const pending = await pool.query("SELECT id FROM factory_execution_runs WHERE feature_id = ANY($1::uuid[]) AND state='queued' ORDER BY created_at,id",[${JSON.stringify(features)}]);
      const claims = (await Promise.all(pending.rows.flatMap(row => [db.claimFactoryExecution(pool,row.id,randomUUID()),db.claimFactoryExecution(pool,row.id,randomUUID())]))).filter(Boolean);
      console.log(JSON.stringify(claims));
    `);
  }
  async function block(
    run: ClaimedFactoryExecution,
    question = "Should equal values keep their original order?",
  ) {
    await module(
      `await db.finishFactoryExecution(pool,${JSON.stringify(run)},{verified:false,writerStopped:true,failure:'input_required',question:${JSON.stringify(question)}}); console.log('null');`,
    );
    const execution = FactoryExecutionSchema.parse(
      await (await stack.fetchApi(`${path(run.projectId, run.featureId)}/execution`)).json(),
    );
    if (execution.gate == null) throw new Error("Durable gate missing");
    return execution.gate;
  }
  // These are controlled worker records for database authority checks. Runtime/Docker
  // execution is exercised separately; no model output is manufactured by this fixture.
  async function verify(run: ClaimedFactoryExecution) {
    await module(`
      const run = ${JSON.stringify(run)};
      let workspace = await db.readFactoryFeatureWorkspace(pool,run);
      if (!workspace) workspace = await db.initializeFactoryFeatureWorkspace(pool,run,{
        projectId:run.projectId,featureId:run.featureId,repositoryId:run.source.repositoryId,sourceIdentity:run.source.identity,
        baseCommitId:run.context?.commitId ?? 'a'.repeat(40),headCommitId:run.context?.commitId ?? 'a'.repeat(40),treeId:'c'.repeat(40),objectFormat:'sha1',branch:'feature/gate-'+run.featureId,
      });
      const revision = await db.recordFactoryExecutionCheckpoint(pool,run,{expectedHead:workspace.headCommitId,headCommitId:'b'.repeat(40),treeId:'c'.repeat(40)});
      await db.saveFactoryVerification(pool,run,{round:1,position:1,command:run.plan.workItems.find(item=>item.key===run.key).verification[0],headCommitId:revision.headCommitId,treeId:revision.treeId,outcome:'passed',exitCode:0,stdout:'Controlled ordering check passed',stderr:'',stdoutTruncated:false,stderrTruncated:false,durationMs:1});
      await db.finishFactoryExecution(pool,run,{verified:true,writerStopped:true,failure:null,question:null});
      console.log('null');
    `);
  }
  beforeAll(async () => {
    const fixture = await createGitFixture();
    cleanup.push(() => fixture.close());
    await fixture.createSibling("falcon");
    await fixture.createSibling("owl");
    stack = await startStack({
      repositoryRoot: fixture.rootPath,
      githubFixture: factoryGitHubFixture.replaceAll(
        "424242",
        "({kestrel:424242,falcon:424243,owl:424244}[name] ?? 424245)",
      ),
    });
    cleanup.push(() => stack.close());
    await stack.authenticateOperator();
    await stack.executeSql(`CREATE FUNCTION hold_gate_execution_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='factory-execution-v1' THEN NEW.start_after=clock_timestamp()+interval '1 hour'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER hold_gate_execution_delivery BEFORE INSERT ON pgboss.job FOR EACH ROW EXECUTE FUNCTION hold_gate_execution_delivery();`);
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    for (const name of ["kestrel", "falcon", "owl"]) {
      const repository = inventory.repositories.find((entry) => entry.displayName === name);
      if (repository === undefined) throw new Error(`Fixture ${name} missing`);
      projects[name] = ProjectUpsertedSchema.parse(
        await (
          await post("/api/v1/projects/local", { repositoryId: repository.repositoryId })
        ).json(),
      ).project.id;
    }
  });
  afterAll(async () => {
    for (const close of cleanup.toReversed()) await close();
  });

  it(
    "keeps the gated Feature first, progresses another Project, and releases its global execution slot",
    { timeout: 120_000 },
    async () => {
      first = await approve(projects.kestrel!, "First feature");
      queued = await approve(projects.kestrel!, "Queued feature");
      other = await approve(projects.falcon!, "Other project", {
        ...plan,
        workItems: plan.workItems.slice(0, 1),
      });
      third = await approve(projects.owl!, "Third project", {
        ...plan,
        workItems: plan.workItems.slice(0, 1),
      });
      const claims = await claim([first, queued, other, third]);
      expect(claims.map((run) => run.featureId).sort()).toEqual([first, other].sort());
      original = claims.find((run) => run.featureId === first)!;
      expect(original.key).toBe("order");
      gate = await block(original);
      await verify(claims.find((run) => run.featureId === other)!);
      const board = FactoryBoardSchema.parse(
        await (await stack.fetchApi(`${path(projects.kestrel!, first)}/board`)).json(),
      );
      expect(
        board.columns.find((column) => column.id === "todo")?.items[0]?.blocking,
      ).toMatchObject({
        kind: "human_gate",
        explanation: expect.stringContaining(gate.question),
      });
      expect(
        FactoryExecutionSchema.parse(
          await (await stack.fetchApi(`${path(projects.falcon!, other)}/execution`)).json(),
        ).state,
      ).toBe("verified");
      const next = await claim([queued, third]);
      expect(next.map((run) => run.featureId)).toEqual([third]);
      await block(next[0]!);
      expect(
        FactoryExecutionSchema.parse(
          await (await stack.fetchApi(`${path(projects.kestrel!, queued)}/execution`)).json(),
        ).workItems.every((item) => item.runs.length === 0),
      ).toBe(true);
    },
  );

  it(
    "persists one exact answer through restart and creates one successor before its dependent Work Item",
    { timeout: 90_000 },
    async () => {
      const endpoint = `${path(projects.kestrel!, first)}/execution/gates/${gate.id}`;
      const answer = {
        requestId: randomUUID(),
        expectedPlanVersion: 1,
        decision: "resume_within_plan",
        answer: "Keep the original order, as required by the approved acceptance criterion.",
      };
      expect(FactoryGateSchema.parse(await (await stack.fetchApi(endpoint)).json())).toEqual(gate);
      expect(
        (await post(`${endpoint}/resolve`, { ...answer, expectedPlanVersion: 2 })).status,
      ).toBe(409);
      expect((await post(`${endpoint}/resolve`, { ...answer, answer: " \n " })).status).toBe(400);
      const noCsrf = await fetch(`${stack.apiUrl}${endpoint}/resolve`, {
        method: "POST",
        headers: {
          Cookie: stack.sessionCookie,
          Origin: stack.apiUrl,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(answer),
      });
      expect(noCsrf.status).toBe(403);
      await noCsrf.arrayBuffer();
      await expect(
        stack.executeRuntimeSql(
          `UPDATE factory_human_gates SET question='Different question' WHERE id='${gate.id}'`,
        ),
      ).rejects.toThrow();
      const answers = await Promise.all([
        post(`${endpoint}/resolve`, answer),
        post(`${endpoint}/resolve`, answer),
      ]);
      for (const response of answers) {
        expect(response.status, await response.clone().text()).toBe(200);
        expect(FactoryGateSchema.parse(await response.json()).resolution).toMatchObject({
          requestId: answer.requestId,
          decision: answer.decision,
          answer: answer.answer,
        });
      }
      expect(
        (await post(`${endpoint}/resolve`, { ...answer, answer: "Changed after sending" })).status,
      ).toBe(409);
      await stack.restart("web");
      expect(FactoryGateSchema.parse(await (await stack.fetchApi(endpoint)).json())).toMatchObject({
        resolution: { requestId: answer.requestId, answer: answer.answer },
      });
      const successors = await claim([first, queued]);
      expect(successors).toHaveLength(1);
      const successor = successors[0]!;
      expect(successor).toMatchObject({
        featureId: first,
        key: "order",
        attempt: 2,
        version: 1,
        source: original.source,
        gateResolution: {
          id: gate.id,
          runId: original.id,
          approvedVersion: 1,
          answer: answer.answer,
        },
      });
      expect(successor.plan).toEqual(original.plan);
      const details = FactoryExecutionRunSchema.parse(
        await (
          await stack.fetchApi(`${path(projects.kestrel!, first)}/execution/runs/${successor.id}`)
        ).json(),
      );
      expect(details.acceptedCommands).toEqual(verification);
      await verify(successor);
      const dependent = await claim([first, queued]);
      expect(dependent).toHaveLength(1);
      expect(dependent[0]).toMatchObject({
        featureId: first,
        key: "consumer",
        attempt: 1,
        completed: [{ key: "order" }],
      });
      await verify(dependent[0]!);
      expect((await post(`${endpoint}/resolve`, answer)).status).toBe(200);
      expect(
        (await post(`${endpoint}/resolve`, { ...answer, requestId: randomUUID() })).status,
      ).toBe(409);
      expect(
        (
          await post(`${path(projects.kestrel!, first)}/cancel`, {
            requestId: randomUUID(),
            expectedVersion: 1,
          })
        ).status,
      ).toBe(200);
    },
  );

  it("records plan changes without authorizing them and converges when cancellation races an answer", async () => {
    const [run] = await claim([queued]);
    if (run === undefined) throw new Error("Next Project feature did not become ready");
    const pendingGate = await block(
      run,
      "Should the feature add a new filter outside its approved scope?",
    );
    const endpoint = `${path(projects.kestrel!, queued)}/execution/gates/${pendingGate.id}/resolve`;
    const change = {
      requestId: randomUUID(),
      expectedPlanVersion: 1,
      decision: "requires_plan_change",
      answer: "A new filter needs its own approved acceptance criteria.",
    };
    const response = await post(endpoint, change);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(FactoryGateSchema.parse(await response.json())).toMatchObject({
      canResume: false,
      resumeBlockedReason: "plan_change_required",
    });
    expect(await claim([queued])).toEqual([]);
    expect(
      (await post(endpoint, { ...change, requestId: randomUUID(), decision: "resume_within_plan" }))
        .status,
    ).toBe(409);
    const thirdExecution = FactoryExecutionSchema.parse(
      await (await stack.fetchApi(`${path(projects.owl!, third)}/execution`)).json(),
    );
    if (thirdExecution.gate == null) throw new Error("Third Project gate missing");
    const race = await Promise.all([
      post(`${path(projects.owl!, third)}/execution/gates/${thirdExecution.gate.id}/resolve`, {
        requestId: randomUUID(),
        expectedPlanVersion: 1,
        decision: "resume_within_plan",
        answer: "Continue within the approved ordering requirement.",
      }),
      post(`${path(projects.owl!, third)}/cancel`, { requestId: randomUUID(), expectedVersion: 1 }),
    ]);
    expect([200, 409]).toContain(race[0]!.status);
    expect(race[1]!.status).toBe(200);
    for (const response of race) await response.arrayBuffer();
    expect(await claim([third])).toEqual([]);
    expect(
      FactoryExecutionSchema.parse(
        await (await stack.fetchApi(`${path(projects.owl!, third)}/execution`)).json(),
      ).state,
    ).toBe("cancelled");
  });
});
