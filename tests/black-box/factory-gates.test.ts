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

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected fixture value missing");
  return value;
}

describe("Factory Human Gates over HTTP and PostgreSQL", () => {
  let stack: RunningStack;
  const cleanup: Array<() => Promise<void>> = [];
  const projects = { kestrel: "", falcon: "", owl: "" };
  let first: string;
  let queued: string;
  let other: string;
  let third: string;
  let owlHead: string;
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
    await stack.executeSql(
      `UPDATE factory_features SET execution_mode='authorized' WHERE id='${feature.id}'`,
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
      const commands = run.purpose === 'feature_verification' ? run.verificationManifest.map(entry=>entry.command) : run.plan.workItems.find(item=>item.key===run.key).verification;
      for (const [index,command] of commands.entries()) await db.saveFactoryVerification(pool,run,{round:1,position:index+1,command,headCommitId:revision.headCommitId,treeId:revision.treeId,outcome:'passed',exitCode:0,stdout:'Controlled ordering check passed',stderr:'',stdoutTruncated:false,stderrTruncated:false,durationMs:1});
      await db.finishFactoryExecution(pool,run,{verified:true,writerStopped:true,failure:null,question:null});
      console.log('null');
    `);
  }
  beforeAll(async () => {
    const fixture = await createGitFixture();
    cleanup.push(() => fixture.close());
    await fixture.createSibling("falcon");
    owlHead = (await fixture.createSibling("owl")).headObjectId;
    stack = await startStack({
      connectedCodexFixture: true,
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
    for (const name of ["kestrel", "falcon", "owl"] as const) {
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
    "settles a failed execution atomically and once under competing completions",
    { timeout: 120_000 },
    async () => {
      const featureId = await approve(projects.kestrel, "Atomic execution outcome");
      const endpoint = path(projects.kestrel, featureId);
      const run = required((await claim([featureId]))[0]);
      const snapshot = async () => ({
        execution: FactoryExecutionSchema.parse(
          await (await stack.fetchApi(`${endpoint}/execution`)).json(),
        ),
        board: FactoryBoardSchema.parse(await (await stack.fetchApi(`${endpoint}/board`)).json()),
      });
      try {
        const before = await snapshot();
        await stack.executeSql(`
        CREATE FUNCTION reject_execution_activity() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.feature_id='${featureId}' AND NEW.kind='execution_blocked' THEN RAISE EXCEPTION 'fixture terminal activity blocked'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_execution_activity BEFORE INSERT ON factory_activity FOR EACH ROW EXECUTE FUNCTION reject_execution_activity();
      `);
        try {
          const failure = await module<string>(`
          let failure = null;
          try { await db.finishFactoryExecution(pool,${JSON.stringify(run)}, {verified:false,writerStopped:true,failure:'input_required',question:'Keep the approved ordering?'}); }
          catch(error) { failure=String(error); }
          console.log(JSON.stringify(failure));
        `);
          expect(failure).toContain("fixture terminal activity blocked");
          expect(await snapshot()).toEqual(before);
        } finally {
          await stack.executeSql(
            "DROP TRIGGER reject_execution_activity ON factory_activity; DROP FUNCTION reject_execution_activity();",
          );
        }
        const facts = await module<{ gates: number; activities: number; released: boolean }>(`
        const run=${JSON.stringify(run)};
        const outcome={verified:false,writerStopped:true,failure:'input_required',question:'Keep the approved ordering?'};
        await Promise.all([db.finishFactoryExecution(pool,run,outcome),db.finishFactoryExecution(pool,run,outcome)]);
        const result=await pool.query("SELECT reservation_released_at IS NOT NULL AS released,(SELECT count(*)::int FROM factory_human_gates WHERE run_id=$1) AS gates,(SELECT count(*)::int FROM factory_activity WHERE feature_id=$2 AND kind='execution_blocked') AS activities FROM factory_execution_runs WHERE id=$1",[run.id,run.featureId]);
        console.log(JSON.stringify(result.rows[0]));
      `);
        expect(facts).toEqual({ gates: 1, activities: 1, released: true });
        const after = await snapshot();
        expect(after.execution.gate?.question).toBe("Keep the approved ordering?");
        expect(after.execution.workItems[0]?.runs[0]).toMatchObject({
          state: "blocked",
          writerStopped: true,
        });
        expect(
          after.board.columns.find((column) => column.id === "todo")?.items[0]?.blocking?.kind,
        ).toBe("human_gate");
        expect(await claim([featureId])).toEqual([]);
      } finally {
        const response = await post(`${endpoint}/cancel`, {
          requestId: randomUUID(),
          expectedVersion: 1,
        });
        await response.arrayBuffer();
        await module(
          `await db.finishFactoryExecution(pool,${JSON.stringify(run)},{verified:false,writerStopped:true,failure:'cancelled',question:null}); console.log('null');`,
        );
      }
    },
  );

  it(
    "keeps the gated Feature first, progresses another Project, and releases its global execution slot",
    { timeout: 120_000 },
    async () => {
      first = await approve(projects.kestrel, "First feature");
      queued = await approve(projects.kestrel, "Queued feature");
      other = await approve(projects.falcon, "Other project", {
        ...plan,
        workItems: plan.workItems.slice(0, 1),
      });
      third = await approve(projects.owl, "Third project", {
        ...plan,
        workItems: plan.workItems.slice(0, 1),
      });
      const claims = await claim([first, queued, other, third]);
      expect(claims.map((run) => run.featureId).sort()).toEqual([first, other].sort());
      original = required(claims.find((run) => run.featureId === first));
      expect(original.key).toBe("order");
      const competing = required(claims.find((run) => run.featureId === other));
      // Each module opens a fresh database connection, as a restarted host would.
      expect(
        await module<boolean>(
          `console.log(JSON.stringify(await db.claimFactoryExecutionHeavySlot(pool,${JSON.stringify(original.id)})));`,
        ),
      ).toBe(true);
      expect(
        await module<boolean>(
          `console.log(JSON.stringify(await db.claimFactoryExecutionHeavySlot(pool,${JSON.stringify(competing.id)})));`,
        ),
      ).toBe(false);
      await module(
        `await db.recordFactoryExecutionActivity(pool,${JSON.stringify(original)},'lifecycle','Prerequisite probe failed',{detail:${JSON.stringify("npm run build\nexit 1")},exitCode:1,retainDetail:true}); console.log('null');`,
      );
      gate = await block(original);
      const retained = FactoryExecutionRunSchema.parse(
        await (
          await stack.fetchApi(`${path(projects.kestrel, first)}/execution/runs/${original.id}`)
        ).json(),
      );
      expect(
        retained.activity.find((event) => event.summary === "Prerequisite probe failed")?.detail,
      ).toBe("npm run build\nexit 1");
      expect(
        await module<boolean>(
          `console.log(JSON.stringify(await db.claimFactoryExecutionHeavySlot(pool,${JSON.stringify(competing.id)})));`,
        ),
      ).toBe(true);
      await verify(competing);
      const final = required((await claim([other]))[0]);
      expect(final.purpose).toBe("feature_verification");
      await verify(final);
      const board = FactoryBoardSchema.parse(
        await (await stack.fetchApi(`${path(projects.kestrel, first)}/board`)).json(),
      );
      const blocking = board.columns.find((column) => column.id === "todo")?.items[0]?.blocking;
      expect(blocking?.kind).toBe("human_gate");
      expect(blocking?.explanation).toContain(gate.question);
      expect(
        FactoryExecutionSchema.parse(
          await (await stack.fetchApi(`${path(projects.falcon, other)}/execution`)).json(),
        ).state,
      ).toBe("verified");
      const next = await claim([queued, third]);
      expect(next.map((run) => run.featureId)).toEqual([third]);
      await block(required(next[0]));
      expect(
        FactoryExecutionSchema.parse(
          await (await stack.fetchApi(`${path(projects.kestrel, queued)}/execution`)).json(),
        ).workItems.every((item) => item.runs.length === 0),
      ).toBe(true);
    },
  );

  it(
    "persists one exact answer through restart and creates one successor before its dependent Work Item",
    { timeout: 90_000 },
    async () => {
      const endpoint = `${path(projects.kestrel, first)}/execution/gates/${gate.id}`;
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
      const successor = required(successors[0]);
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
          await stack.fetchApi(`${path(projects.kestrel, first)}/execution/runs/${successor.id}`)
        ).json(),
      );
      expect(details.acceptedCommands).toEqual(verification);
      await verify(successor);
      const board = FactoryBoardSchema.parse(
        await (await stack.fetchApi(`${path(projects.kestrel, first)}/board`)).json(),
      );
      expect(
        board.columns.find(({ id }) => id === "in_review")?.items.map(({ key }) => key),
      ).toEqual(["order"]);
      expect(board.columns.find(({ id }) => id === "completed")?.items).toEqual([]);
      expect(
        board.columns
          .find(({ id }) => id === "todo")
          ?.items.filter(({ blocking }) => blocking === null)
          .map(({ key }) => key),
      ).toEqual(["consumer"]);
      const dependent = await claim([first, queued]);
      expect(dependent).toHaveLength(1);
      expect(dependent[0]).toMatchObject({
        featureId: first,
        key: "consumer",
        attempt: 1,
        completed: [{ key: "order" }],
      });
      await verify(required(dependent[0]));
      expect((await post(`${endpoint}/resolve`, answer)).status).toBe(200);
      expect(
        (await post(`${endpoint}/resolve`, { ...answer, requestId: randomUUID() })).status,
      ).toBe(409);
      expect(
        (
          await post(`${path(projects.kestrel, first)}/cancel`, {
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
    const endpoint = `${path(projects.kestrel, queued)}/execution/gates/${pendingGate.id}/resolve`;
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
      await (await stack.fetchApi(`${path(projects.owl, third)}/execution`)).json(),
    );
    if (thirdExecution.gate == null) throw new Error("Third Project gate missing");
    const race = await Promise.all([
      post(`${path(projects.owl, third)}/execution/gates/${thirdExecution.gate.id}/resolve`, {
        requestId: randomUUID(),
        expectedPlanVersion: 1,
        decision: "resume_within_plan",
        answer: "Continue within the approved ordering requirement.",
      }),
      post(`${path(projects.owl, third)}/cancel`, { requestId: randomUUID(), expectedVersion: 1 }),
    ]);
    expect([200, 409]).toContain(race[0].status);
    expect(race[1].status).toBe(200);
    for (const response of race) await response.arrayBuffer();
    expect(await claim([third])).toEqual([]);
    expect(
      FactoryExecutionSchema.parse(
        await (await stack.fetchApi(`${path(projects.owl, third)}/execution`)).json(),
      ).state,
    ).toBe("cancelled");
  });
  it(
    "checks restored source on the server before retrying the same saved revision",
    { timeout: 90_000 },
    async () => {
      const featureId = await approve(projects.owl, "Recover a restored workspace");
      const endpoint = path(projects.owl, featureId);
      const run = required((await claim([featureId]))[0]);
      const open = `
      const {readLocalSourceConfig,resolveRepository,inspectRepository,openFeatureWorkspace,snapshotFeatureWorkspace}=await import('@kestrel/local-source');
      const {readFile,writeFile}=await import('node:fs/promises');
      const run=${JSON.stringify(run)};
      const config=await readLocalSourceConfig();
      const inspection=await inspectRepository(config,await resolveRepository(config,run.source.repositoryId));
      const identity={projectId:run.projectId,featureId:run.featureId,repositoryId:run.source.repositoryId,sourceIdentity:run.source.identity,baseCommitId:${JSON.stringify(owlHead)},objectFormat:inspection.objectFormat,branch:'refs/heads/kestrel/feature/'+run.featureId};
      const workspace=await openFeatureWorkspace(config,identity);
    `;
      const saved = await module<string>(`${open}
      const snapshot=await snapshotFeatureWorkspace(workspace,{expectedHead:identity.baseCommitId});
      await db.initializeFactoryFeatureWorkspace(pool,run,{...identity,...snapshot});
      const saved=await readFile(workspace.workspacePath+'/review.txt','utf8');
      await writeFile(workspace.workspacePath+'/review.txt','unfinished implementation\\n');
      await db.finishFactoryExecution(pool,run,{verified:false,writerStopped:true,failure:'source_changed',question:null});
      console.log(JSON.stringify(saved));
    `);
      const paused = FactoryExecutionSchema.parse(
        await (await stack.fetchApi(`${endpoint}/execution`)).json(),
      );
      const stopped = paused.gate;
      if (stopped == null) throw new Error("Missing source recovery gate");
      expect(stopped).toMatchObject({
        reason: "source_changed",
        canResume: false,
        resumeBlockedReason: "workspace_uncertain",
      });
      const retry = {
        requestId: randomUUID(),
        expectedPlanVersion: 1,
        decision: "resume_within_plan",
        answer: "Retry the retained execution within the approved plan.",
      };
      expect((await post(`${endpoint}/execution/gates/${stopped.id}/resolve`, retry)).status).toBe(
        409,
      );
      expect(
        FactoryExecutionSchema.parse(await (await stack.fetchApi(`${endpoint}/execution`)).json())
          .state,
      ).toBe("blocked");
      await module(`${open}
      await writeFile(workspace.workspacePath+'/review.txt',${JSON.stringify(saved)});
      console.log('null');
    `);
      const responses = await Promise.all([
        post(`${endpoint}/execution/gates/${stopped.id}/resolve`, retry),
        post(`${endpoint}/execution/gates/${stopped.id}/resolve`, retry),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const receipts = await Promise.all(
        responses.map(async (response) => FactoryGateSchema.parse(await response.json())),
      );
      expect(receipts[0]).toEqual(receipts[1]);
      const next = required((await claim([featureId]))[0]);
      expect(next.source).toEqual(run.source);
      const proof = await module<{ head: string; tree: string }>(`
      const result=await pool.query('SELECT workspace_restoration FROM factory_human_gates WHERE id=$1',[${JSON.stringify(stopped.id)}]);
      console.log(JSON.stringify({head:result.rows[0].workspace_restoration.headCommitId,tree:result.rows[0].workspace_restoration.treeId}));
    `);
      expect(proof.head).toBe(owlHead);
      expect(proof.tree).toMatch(/^[a-f0-9]{40}$/u);
      await module(
        `await db.finishFactoryExecution(pool,${JSON.stringify(next)},{verified:false,writerStopped:true,failure:'interrupted',question:null});console.log('null');`,
      );
      expect(
        (await post(`${endpoint}/cancel`, { requestId: randomUUID(), expectedVersion: 1 })).status,
      ).toBe(200);
    },
  );
});
