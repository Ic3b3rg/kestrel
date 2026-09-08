import { randomUUID } from "node:crypto";
import {
  FactoryBoardSchema,
  FactoryExecutionRunSchema,
  FactoryExecutionSchema,
  FeatureSchema,
  LocalRepositoryInventorySchema,
  ProjectUpsertedSchema,
  type FeaturePlanDocument,
} from "@kestrel/contracts";
import type { ClaimedFactoryExecution } from "@kestrel/database";
import { startStack, type RunningStack } from "./compose.js";
import { createGitFixture } from "./git-fixture.js";
import { factoryGitHubFixture } from "./factory-github-fixture.js";

const shared = {
  program: "node",
  args: ["-e", "console.log('approved shared check')"],
  cwd: ".",
  timeoutSeconds: 10,
};

export function verificationPlan(large = false): FeaturePlanDocument {
  return {
    objective: "Preserve stable ordering while adding its consumer",
    scope: { includes: ["Stable ordering and its consumer"], excludes: ["Publishing or merging"] },
    acceptance: [
      { key: "stable-order", outcome: "Equal values retain their original order" },
      { key: "consumer-result", outcome: "The consumer returns its approved result" },
    ],
    workItems: [
      {
        key: "order",
        title: "Retain original order",
        description: "Preserve equal-value ordering.",
        requirementKeys: ["stable-order"],
        acceptance: ["Equal values retain their original order"],
        importedIssueId: null,
        dependsOn: [],
        verification: [
          { program: "node", args: ["--test", "order.test.mjs"], cwd: ".", timeoutSeconds: 10 },
          shared,
          ...(large
            ? Array.from({ length: 8 }, (_, index) => ({
                ...shared,
                args: ["-e", `console.log('approved check ${String(index + 1)}')`],
              }))
            : []),
        ],
      },
      {
        key: "consumer",
        title: "Add the consumer",
        description: "Add the consumer without changing ordering.",
        requirementKeys: ["consumer-result", "stable-order"],
        acceptance: ["The consumer returns its approved result"],
        importedIssueId: null,
        dependsOn: ["order"],
        verification: [
          { program: "node", args: ["--test", "consumer.test.mjs"], cwd: ".", timeoutSeconds: 10 },
          shared,
          ...(large
            ? [
                { ...shared, cwd: "checks" },
                { ...shared, timeoutSeconds: 11 },
                { ...shared, program: "echo" },
                { ...shared, args: ["-e", "console.log('a different approved check')"] },
              ]
            : []),
        ],
      },
    ],
    limits: {
      maxConcurrentProjects: 2,
      maxActiveFeaturesPerProject: 1,
      attemptTimeoutSeconds: 120,
    },
  };
}

type ModuleStack = Pick<RunningStack, "executeWebModule">;

/** Runs compiled production database code as the web service's runtime role. */
export async function verificationModule<T>(stack: ModuleStack, source: string): Promise<T> {
  return JSON.parse(
    await stack.executeWebModule(`
      import * as db from '@kestrel/database';
      import { randomUUID, createHash } from 'node:crypto';
      const pool = db.createPool(process.env.DATABASE_URL);
      const boss = db.createPgBoss({applicationName:'verification-journey',databaseUrl:process.env.DATABASE_URL});
      try {
        if ((await pool.query('SELECT current_user AS role')).rows[0].role !== 'kestrel_runtime')
          throw new Error('Acceptance must use the production runtime role');
        await boss.start();
        ${source}
      } finally { await boss.stop(); await pool.end(); }
    `),
  ) as T;
}

export async function createVerificationFixture() {
  const source = await createGitFixture();
  let stack: RunningStack;
  try {
    stack = await startStack({
      repositoryRoot: source.rootPath,
      githubFixture: factoryGitHubFixture,
    });
  } catch (error) {
    await source.close();
    throw error;
  }
  const post = (path: string, body: unknown) =>
    stack.fetchApi(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    await stack.authenticateOperator();
    // Hold delivery, not scheduler admission. Tests invoke the actual worker explicitly.
    await stack.executeSql(`
      CREATE FUNCTION hold_verification_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name='factory-execution-v1' THEN NEW.start_after=clock_timestamp()+interval '1 hour'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER hold_verification_delivery BEFORE INSERT ON pgboss.job FOR EACH ROW EXECUTE FUNCTION hold_verification_delivery();
    `);
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories.find((entry) => entry.displayName === "kestrel");
    if (repository === undefined) throw new Error("Verification repository missing");
    const project = ProjectUpsertedSchema.parse(
      await (
        await post("/api/v1/projects/local", { repositoryId: repository.repositoryId })
      ).json(),
    ).project;
    const path = (featureId: string) => `/api/v1/projects/${project.id}/features/${featureId}`;
    return {
      stack,
      source,
      projectId: project.id,
      path,
      post,
      async close() {
        try {
          await stack.close();
        } finally {
          await source.close();
        }
      },
      async approve(title: string, plan = verificationPlan()) {
        const feature = FeatureSchema.parse(
          await (
            await post(`/api/v1/projects/${project.id}/features`, {
              requestId: randomUUID(),
              title,
            })
          ).json(),
        );
        const saved = await post(`${path(feature.id)}/plans`, {
          requestId: randomUUID(),
          expectedVersion: null,
          plan,
        });
        if (saved.status !== 201) throw new Error(`Plan rejected: ${await saved.text()}`);
        const approval = await post(`${path(feature.id)}/plans/1/approve`, {
          requestId: randomUUID(),
        });
        if (approval.status !== 200) throw new Error(`Approval rejected: ${await approval.text()}`);
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
          const publication = (await (
            await stack.fetchApi(`${path(feature.id)}/publication`)
          ).json()) as { state: string };
          if (publication.state === "published") return feature.id;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throw new Error("Approved issues were not published by the disposable provider fixture");
      },
      async queue(featureId: string) {
        return verificationModule<string[]>(
          stack,
          `
          await Promise.all([db.queueFactoryExecutions(pool,boss),db.queueFactoryExecutions(pool,boss)]);
          const result = await pool.query("SELECT id FROM factory_execution_runs WHERE feature_id=$1 AND state='queued' ORDER BY created_at,id",[${JSON.stringify(featureId)}]);
          console.log(JSON.stringify(result.rows.map(row=>row.id)));
        `,
        );
      },
      async claim(runId: string) {
        return verificationModule<ClaimedFactoryExecution[]>(
          stack,
          `
          const claims=await Promise.all([db.claimFactoryExecution(pool,${JSON.stringify(runId)},randomUUID()),db.claimFactoryExecution(pool,${JSON.stringify(runId)},randomUUID())]);
          console.log(JSON.stringify(claims.filter(Boolean)));
        `,
        );
      },
      async execution(featureId: string) {
        return FactoryExecutionSchema.parse(
          await (await stack.fetchApi(`${path(featureId)}/execution`)).json(),
        );
      },
      async run(featureId: string, runId: string) {
        return FactoryExecutionRunSchema.parse(
          await (await stack.fetchApi(`${path(featureId)}/execution/runs/${runId}`)).json(),
        );
      },
      async board(featureId: string) {
        return FactoryBoardSchema.parse(
          await (await stack.fetchApi(`${path(featureId)}/board`)).json(),
        );
      },
      async cancel(featureId: string) {
        const response = await post(`${path(featureId)}/cancel`, {
          requestId: randomUUID(),
          expectedVersion: 1,
        });
        if (response.status !== 200)
          throw new Error(`Cancellation rejected: ${await response.text()}`);
        await response.arrayBuffer();
      },
    };
  } catch (error) {
    try {
      await stack.close();
    } finally {
      await source.close();
    }
    throw error;
  }
}

export type VerificationFixture = Awaited<ReturnType<typeof createVerificationFixture>>;

/** Seed scheduling history from a real certificate; this does not execute 32 Features. */
export function seedCertifiedVerificationHistory(stack: ModuleStack, templateFeatureId: string) {
  return verificationModule<{ projectId: string; featureId: string; history: string[] }>(
    stack,
    `
    const template=${JSON.stringify(templateFeatureId)}, history=[];
    let next=null;
    const client=await pool.connect();
    await client.query('BEGIN');
    try {
      for(let index=0;index<33;index++) {
        const historical=index<32;
        const projectId=(await client.query('INSERT INTO projects(installation_id) SELECT project.installation_id FROM projects project JOIN factory_features feature ON feature.project_id=project.id WHERE feature.id=$1 RETURNING id',[template])).rows[0].id;
        const featureId=(await client.query("INSERT INTO factory_features(project_id,created_by,request_id,title,state,latest_plan_version,approved_plan_version) SELECT $2,created_by,uuidv7(),title,$3,1,1 FROM factory_features WHERE id=$1 RETURNING id",[template,projectId,historical?'in_review':'queued'])).rows[0].id;
        await client.query("INSERT INTO factory_plan_versions(feature_id,version,request_id,document,source_context,plan_markdown,spec_markdown,author,created_by) SELECT $2,1,uuidv7(),document,source_context,plan_markdown,spec_markdown,'operator',created_by FROM factory_plan_versions WHERE feature_id=$1 AND version=1",[template,featureId]);
        await client.query("INSERT INTO factory_plan_approvals(feature_id,plan_version,request_id,operator_id,approved_at) SELECT $2,1,uuidv7(),operator_id,CASE WHEN $3 THEN approved_at-interval '1 day' ELSE clock_timestamp() END FROM factory_plan_approvals WHERE feature_id=$1 AND plan_version=1",[template,featureId,historical]);
        await client.query("INSERT INTO factory_feature_publications(feature_id,state) VALUES($1,'published')",[featureId]);
        await client.query('INSERT INTO factory_work_items(feature_id,plan_version,key,position,board_column) SELECT $2,1,key,position,$3 FROM factory_work_items WHERE feature_id=$1 AND plan_version=1',[template,featureId,historical?'in_review':'todo']);
        if(!historical) { next={projectId,featureId}; continue; }
        history.push(featureId);
        await client.query('INSERT INTO factory_feature_workspaces(feature_id,project_id,repository_id,source_identity,base_commit_id,object_format,branch,head_commit_id,tree_id) SELECT $2,$3,repository_id,source_identity,base_commit_id,object_format,branch,head_commit_id,tree_id FROM factory_feature_workspaces WHERE feature_id=$1',[template,featureId,projectId]);
        const runId=(await client.query("INSERT INTO factory_execution_runs(feature_id,project_id,work_item_id,plan_version,purpose,attempt,state,source,accepted_commands,verification_manifest,initial_revision,revision,started_at,completed_at,reservation_released_at) SELECT $2,$3,NULL,1,'feature_verification',1,'verified',run.source,run.accepted_commands,run.verification_manifest,run.initial_revision,run.revision,run.started_at,run.completed_at,run.reservation_released_at FROM factory_execution_runs run JOIN factory_feature_verifications certificate ON certificate.run_id=run.id WHERE certificate.feature_id=$1 RETURNING factory_execution_runs.id",[template,featureId,projectId])).rows[0].id;
        await client.query("INSERT INTO factory_verification_results(run_id,round,position,result,purpose) SELECT $2,result.round,result.position,result.result,'feature_verification' FROM factory_verification_results result JOIN factory_feature_verifications certificate ON result.id=ANY(certificate.evidence_ids) WHERE certificate.feature_id=$1 ORDER BY result.position",[template,runId]);
        await client.query('INSERT INTO factory_feature_verifications(feature_id,plan_version,run_id,source,revision,manifest,manifest_digest,evidence_ids) SELECT $2,1,$3,source,revision,manifest,manifest_digest,ARRAY(SELECT id FROM factory_verification_results WHERE run_id=$3 ORDER BY position) FROM factory_feature_verifications WHERE feature_id=$1',[template,featureId,runId]);
      }
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    console.log(JSON.stringify({...next,history}));
  `,
  );
}

/**
 * Real processor, Git checkpoints, PostgreSQL writes and Node commands. Only the
 * model and container boundary is controlled; these are not Docker/model proofs.
 */
export function processVerificationFixture(
  stack: ModuleStack,
  runId: string,
  mode: "order" | "consumer" | "break_consumer" | "repair" | "keep",
  pause?: { token: string; position: number },
) {
  return verificationModule<{ events: string[]; error: string | null }>(
    stack,
    `
    const {createFactoryExecutionProcessor}=await import('./apps/web/dist/factory-execution-processor.js');
    const {readLocalSourceConfig}=await import('@kestrel/local-source');
    const {mkdir,writeFile,access}=await import('node:fs/promises');
    const {join}=await import('node:path');
    const {execFile}=await import('node:child_process');
    const mode=${JSON.stringify(mode)}, pause=${JSON.stringify(pause ?? null)}, events=[];
    async function lifecycle(input,id,operation) {
      const digest=createHash('sha256').update(id).digest('hex');
      const identity={name:'kestrel-factory-'+digest.slice(0,32),id:digest};
      await input.beforeContainerCreate(identity.name,'controlled-fixture-daemon');
      await input.onContainer(identity);
      try { return await operation(); }
      finally { await input.onStopped(identity); }
    }
    const processor=createFactoryExecutionProcessor({pool,readSourceConfig:()=>readLocalSourceConfig(),
      connection:{readConnection:async()=>{
        events.push('model-selection');
        return {schemaVersion:1,state:'ready',reason:null,cli:{version:'0.153.4',supported:true,protocol:'app_server_v2'},
          account:{authentication:'chatgpt',email:null,plan:'pro'},models:[{id:'controlled-model',displayName:'Controlled',isDefault:true}],
          usage:{availability:'available',primary:null,secondary:null},checkedAt:new Date().toISOString()};
      }},
      runtime:{
        runTurn:input=>lifecycle(input,input.requestId,async()=>{
          events.push('implementation-turn');
          await input.onThread('controlled-'+input.requestId); await input.onTurn('controlled-turn');
          if(mode==='order') {
            await mkdir(join(input.cwd,'checks'),{recursive:true});
            await writeFile(join(input.cwd,'checks','README.md'),'Approved command directory.\\n');
            await writeFile(join(input.cwd,'order.test.mjs'),"import {test} from 'node:test'; import assert from 'node:assert/strict'; import {order} from './value.mjs'; test('equal values retain their original order',()=>assert.equal(order,1));\\n");
            await writeFile(join(input.cwd,'consumer.test.mjs'),"import {test} from 'node:test'; import assert from 'node:assert/strict'; import {consumer} from './value.mjs'; test('consumer returns approved result',()=>assert.equal(consumer,2));\\n");
          }
          if(mode!=='keep') await writeFile(join(input.cwd,'value.mjs'),
            'export const order = '+(mode==='break_consumer'?'2':'1')+'; export const consumer = '+(mode==='order'?'1':'2')+';\\n');
          return {threadId:'controlled-'+input.requestId,turnId:'controlled-turn',text:JSON.stringify({status:'completed',summary:'Controlled approved implementation step',question:null})};
        }),
        runVerification:input=>lifecycle(input,input.processId,async()=>{
          events.push('check:'+input.processId.split(':').slice(-2).join(':'));
          if(pause && Number(input.processId.split(':').at(-1))===pause.position && input.processId.split(':').at(-2)==='1') {
            const marker='/tmp/kestrel-verification-pause-'+pause.token;
            await writeFile(marker,'waiting');
            const deadline=Date.now()+60_000;
            while(!(await access(marker+'.continue').then(()=>true,()=>false))) {
              input.signal.throwIfAborted();
              if(Date.now()>deadline) throw new Error('Controlled verification pause expired');
              await new Promise(resolve=>setTimeout(resolve,50));
            }
          }
          const started=performance.now();
          return new Promise((resolve,reject)=>execFile(input.command[0],input.command.slice(1),
            {cwd:join(input.workspaceCwd,input.cwd),timeout:input.timeoutMs,signal:input.signal,maxBuffer:64*1024},
            (error,stdout,stderr)=>{
              if(error && typeof error.code!=='number') { reject(error); return; }
              resolve({processId:input.processId,exitCode:error?.code??0,stdout,stderr,
                stdoutTruncated:false,stderrTruncated:false,durationMs:Math.round(performance.now()-started)});
            }));
        }),
      }});
    let error=null;
    try { await processor.process({runId:${JSON.stringify(runId)}}); }
    catch(failure) { error=String(failure); }
    finally { await processor.stop(); }
    console.log(JSON.stringify({events,error}));
  `,
  );
}

export function releaseVerificationPause(stack: ModuleStack, token: string) {
  return stack.executeWebModule(`
    import {writeFile} from 'node:fs/promises';
    await writeFile(${JSON.stringify(`/tmp/kestrel-verification-pause-${token}.continue`)},'continue');
  `);
}
