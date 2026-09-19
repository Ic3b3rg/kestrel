import { randomUUID } from "node:crypto";
import {
  FactoryConceptualReviewArtifactSchema,
  FactoryFeaturePublicationSchema,
  FactoryReviewCorrectionCurrentSchema,
  type FactoryConceptualReviewDraft,
  type FactoryConceptualReviewArtifact,
  type FactoryReviewCorrectionCurrent,
  type FactoryFeatureVerification,
} from "@kestrel/contracts";
import type { RunningStack } from "./compose.js";
import {
  factoryFeaturePublicationFixture,
  factoryFeaturePublicationFixtureRemotePath,
  factoryFeaturePublicationFixtureRemoteUrl,
  factoryFeaturePublicationFixtureStatePath,
  type FactoryFeaturePublicationFixtureControls,
} from "./factory-feature-publication-fixture.js";
import {
  createVerificationFixture,
  processVerificationFixture,
  verificationModule,
  verificationPlan,
} from "./factory-verification-fixture.js";

export const publicationGitStatePath = "/tmp/kestrel-feature-publication-git.json";
const publicationGitExecutablePath = "/tmp/kestrel-feature-publication-git.cjs";
type ModuleStack = Pick<RunningStack, "executeWebModule">;

export function createPublicationGitWrapper(options: {
  delegate: string;
  statePath: string;
  pauseTimeoutMs?: number;
}): string {
  return `#!/usr/local/bin/node
const fs=require('node:fs'), {spawnSync}=require('node:child_process');
const path=${JSON.stringify(options.statePath)}, args=process.argv.slice(2);
const read=()=>fs.existsSync(path)?JSON.parse(fs.readFileSync(path,'utf8')):{controls:{},calls:[],pushes:0};
const save=state=>{fs.writeFileSync(path+'.'+process.pid,JSON.stringify(state));fs.renameSync(path+'.'+process.pid,path);};
let state=read(); state.calls.push(args);
const push=args.includes('push'); if(push) state.pushes++;
save(state);
const result=spawnSync(${JSON.stringify(options.delegate)},args,{env:process.env,stdio:push?['inherit','pipe','pipe']:'inherit',maxBuffer:4*1024*1024});
if(result.error) throw result.error;
if(!push) process.exit(result.status??1);
if(result.status===0) {
  state=read(); const lose=state.controls.losePushResponse===true;
  state.controls.losePushResponse=false;
  state.paused=state.controls.pauseAfterPush===true; save(state);
  const deadline=Date.now()+${String(options.pauseTimeoutMs ?? 30_000)};
  while(state.paused && state.controls.pauseAfterPush===true) {
    if(Date.now()>deadline) {state.paused=false;save(state);process.stderr.write('Controlled push response pause expired\\n');process.exit(1);}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);state=read();
  }
  state.paused=false;save(state);
  if(lose) {process.stderr.write('Controlled response lost after completed push\\n');process.exit(1);}
}
if(result.stdout)process.stdout.write(result.stdout);
if(result.stderr)process.stderr.write(result.stderr);
process.exit(result.status??1);
`;
}

export interface PublicationGitState {
  controls: { losePushResponse?: boolean; pauseAfterPush?: boolean };
  calls: string[][];
  pushes: number;
  paused?: boolean;
}

export interface PublicationProviderState {
  issues: Array<{ id: string; number: number; state: string }>;
  pullRequests: Array<{
    id: number;
    node_id: string;
    number: number;
    title: string;
    body: string;
    state: string;
    base: { ref: string; sha: string };
    head: { ref: string; sha: string };
  }>;
  writes: Array<{ method: string; endpoint: string; input: unknown }>;
}

export function processPublicationFixture(stack: ModuleStack, featureId: string) {
  return verificationModule<null>(
    stack,
    `
    const {createFactoryFeaturePublicationProcessor}=await import('./apps/web/dist/factory-feature-publication.js');
    const {createFactoryFeatureRevisionRetainer}=await import('./apps/web/dist/factory-feature-revision.js');
    const {readLocalSourceConfig}=await import('@kestrel/local-source');
    const readSourceConfig=async()=>({...await readLocalSourceConfig(),gitExecutable:${JSON.stringify(publicationGitExecutablePath)}});
    await db.reconcileFactoryFeaturePublications(pool,boss);
    const processor=createFactoryFeaturePublicationProcessor({pool,readSourceConfig,
      retain:createFactoryFeatureRevisionRetainer({pool,readSourceConfig,renderingCoordinator:boss})});
    try {await processor.process({featureId:${JSON.stringify(featureId)}});}
    finally {await processor.stop();}
    console.log('null');
  `,
  );
}

const controlledReviewProfile = {
  containerImage: `sha256:${"1".repeat(64)}`,
  containerUser: "1000:1000",
  codexExecutable: "/usr/local/bin/codex",
  codexExecutableDigest: "2".repeat(64),
  codexVersion: "0.155.1",
};

export function publishConceptualReviewFixture(
  stack: ModuleStack,
  context: { projectId: string; featureId: string },
  graph: FactoryConceptualReviewDraft,
): Promise<FactoryConceptualReviewArtifact> {
  return verificationModule<FactoryConceptualReviewArtifact>(
    stack,
    `
    const {createDatabaseFactoryConceptualReviewService}=await import('./apps/web/dist/routes/factory-conceptual-review.js');
    const {readLocalSourceConfig}=await import('@kestrel/local-source');
    await db.selectCodexReviewModel(pool,'controlled-model');
    const context=${JSON.stringify(context)}, graph=${JSON.stringify(graph)};
    const actorId=(await pool.query('SELECT id FROM operators ORDER BY created_at,id LIMIT 1')).rows[0].id;
    const service=createDatabaseFactoryConceptualReviewService(pool,()=>readLocalSourceConfig(),{
      boss,runtimeProfile:${JSON.stringify(controlledReviewProfile)}});
    const preparation=await service.prepare(context);
    if(!preparation.readiness.startAllowed || preparation.preparationDigest===null)
      throw new Error('Controlled Conceptual Review is not ready');
    const started=await service.start(context,{requestId:randomUUID(),preparationDigest:preparation.preparationDigest},
      {actorId,correlationId:randomUUID()});
    const claim=await db.claimFactoryConceptualReviewWorkflow(pool,started.workflow.id);
    if(claim===null) throw new Error('Controlled Conceptual Review was not claimed');
    console.log(JSON.stringify(await db.publishFactoryConceptualReview(pool,claim,graph)));
  `,
  ).then((value) => FactoryConceptualReviewArtifactSchema.parse(value));
}

export function processCorrectionPublicationFixture(
  stack: ModuleStack,
  correctionId: string,
): Promise<FactoryReviewCorrectionCurrent> {
  return verificationModule<FactoryReviewCorrectionCurrent>(
    stack,
    `
    const {createFactoryReviewCorrectionProcessor}=await import('./apps/web/dist/factory-review-correction-processor.js');
    const {createFactoryFeatureRevisionRetainer}=await import('./apps/web/dist/factory-feature-revision.js');
    const {createDatabaseFactoryConceptualReviewService}=await import('./apps/web/dist/routes/factory-conceptual-review.js');
    const {readLocalSourceConfig}=await import('@kestrel/local-source');
    const readSourceConfig=async()=>({...await readLocalSourceConfig(),gitExecutable:${JSON.stringify(publicationGitExecutablePath)}});
    const review=createDatabaseFactoryConceptualReviewService(pool,()=>readLocalSourceConfig(),{
      boss,runtimeProfile:${JSON.stringify(controlledReviewProfile)}});
    await db.reconcileFactoryReviewCorrections(pool,boss);
    const processor=createFactoryReviewCorrectionProcessor({pool,readSourceConfig,review,
      retain:createFactoryFeatureRevisionRetainer({pool,readSourceConfig,renderingCoordinator:boss})});
    try {await processor.process({correctionId:${JSON.stringify(correctionId)}});}
    finally {await processor.stop();}
    const row=(await pool.query('SELECT project_id,feature_id FROM factory_review_corrections WHERE id=$1',[${JSON.stringify(correctionId)}])).rows[0];
    console.log(JSON.stringify(await db.readCurrentFactoryReviewCorrection(pool,row.project_id,row.feature_id)));
  `,
  ).then((value) => FactoryReviewCorrectionCurrentSchema.parse(value));
}

export function publishQueuedConceptualReviewFixture(
  stack: ModuleStack,
  workflowId: string,
  graph: FactoryConceptualReviewDraft,
): Promise<FactoryReviewCorrectionCurrent> {
  return verificationModule<FactoryReviewCorrectionCurrent>(
    stack,
    `
    const claim=await db.claimFactoryConceptualReviewWorkflow(pool,${JSON.stringify(workflowId)});
    if(claim===null) throw new Error('Replacement Conceptual Review was not claimable');
    const graph=${JSON.stringify(graph)};
    if(graph.result==='complete') {
      const catalog=await db.readFactoryConceptualReviewWorkflowChecks(
        pool,claim.preparation.projectId,claim.preparation.featureId,claim.workflowId,0,1);
      const record=catalog.checks[0];
      if(!record || record.outcome!=='passed' || record.exitCode!==0)
        throw new Error('Replacement review has no passing correction evidence');
      const evidenceId='check:replacement-verification';
      graph.evidence.push({id:evidenceId,type:'check',evidenceId:record.evidenceId,
        relation:'supports',proposition:'The corrected exact revision passed an approved command.',
        description:'Correction verification',sufficiency:'The server resolved this record from the immutable correction certificate.',
        limitations:[],record});
      graph.behavioralSteps=graph.behavioralSteps.map(step=>({...step,evidenceIds:[...step.evidenceIds,evidenceId]}));
      graph.edges.push(...graph.behavioralSteps.map(step=>({from:step.id,to:evidenceId,kind:'supported_by'})));
    }
    await db.publishFactoryConceptualReview(pool,claim,graph);
    await db.reconcileFactoryReviewCorrections(pool,boss);
    console.log(JSON.stringify(await db.readCurrentFactoryReviewCorrection(
      pool,claim.preparation.projectId,claim.preparation.featureId)));
  `,
  ).then((value) => FactoryReviewCorrectionCurrentSchema.parse(value));
}

export function interruptPublicationFixtureDuringPush(stack: ModuleStack, featureId: string) {
  return verificationModule<null>(
    stack,
    `
    const {readFile}=await import('node:fs/promises');
    const {setTimeout:delay}=await import('node:timers/promises');
    const {createFactoryFeaturePublicationProcessor}=await import('./apps/web/dist/factory-feature-publication.js');
    const {createFactoryFeatureRevisionRetainer}=await import('./apps/web/dist/factory-feature-revision.js');
    const {readLocalSourceConfig}=await import('@kestrel/local-source');
    const readSourceConfig=async()=>({...await readLocalSourceConfig(),gitExecutable:${JSON.stringify(publicationGitExecutablePath)}});
    await db.reconcileFactoryFeaturePublications(pool,boss);
    const processor=createFactoryFeaturePublicationProcessor({pool,readSourceConfig,
      retain:createFactoryFeatureRevisionRetainer({pool,readSourceConfig,renderingCoordinator:boss})});
    const processing=processor.process({featureId:${JSON.stringify(featureId)}});
    const deadline=Date.now()+15000;
    while(true) {
      const state=JSON.parse(await readFile(${JSON.stringify(publicationGitStatePath)},'utf8'));
      if(state.paused===true) break;
      if(Date.now()>deadline) throw new Error('Timed out waiting for the publication push');
      await delay(25);
    }
    await processor.stop();
    await processing;
    console.log('null');
  `,
  );
}

export async function publicationGitState(stack: ModuleStack): Promise<PublicationGitState> {
  return JSON.parse(
    await stack.executeWebModule(`
    import {readFile} from 'node:fs/promises';
    console.log(await readFile(${JSON.stringify(publicationGitStatePath)},'utf8'));
  `),
  ) as PublicationGitState;
}

export function setPublicationGitControls(
  stack: ModuleStack,
  controls: PublicationGitState["controls"],
) {
  return stack.executeWebModule(`
    import {readFile,writeFile,rename} from 'node:fs/promises';
    const path=${JSON.stringify(publicationGitStatePath)},state=JSON.parse(await readFile(path,'utf8'));
    Object.assign(state.controls,${JSON.stringify(controls)});
    await writeFile(path+'.control',JSON.stringify(state));await rename(path+'.control',path);
  `);
}

export async function publicationProviderState(
  stack: ModuleStack,
): Promise<PublicationProviderState> {
  return JSON.parse(
    await stack.executeWebModule(`
    import {readFile} from 'node:fs/promises';
    console.log(await readFile(${JSON.stringify(factoryFeaturePublicationFixtureStatePath)},'utf8'));
  `),
  ) as PublicationProviderState;
}

export function setPublicationProviderControls(
  stack: ModuleStack,
  controls: FactoryFeaturePublicationFixtureControls,
) {
  return stack.executeWebModule(`
    import {readFile,writeFile,rename} from 'node:fs/promises';
    import {DatabaseSync} from 'node:sqlite';
    const path=${JSON.stringify(factoryFeaturePublicationFixtureStatePath)},lock=new DatabaseSync(path+'.sqlite');
    lock.exec('PRAGMA busy_timeout=5000; BEGIN EXCLUSIVE');
    try {const state=JSON.parse(await readFile(path,'utf8'));Object.assign(state.controls,${JSON.stringify(controls)});
      await writeFile(path+'.control',JSON.stringify(state));await rename(path+'.control',path);
    } finally {lock.close();}
  `);
}

export async function publicationRemoteRefs(stack: ModuleStack): Promise<Record<string, string>> {
  return JSON.parse(
    await stack.executeWebModule(`
    import {execFileSync} from 'node:child_process';
    const text=execFileSync('/usr/bin/git',['--git-dir=${factoryFeaturePublicationFixtureRemotePath}','show-ref'],{encoding:'utf8'});
    console.log(JSON.stringify(Object.fromEntries(text.trim().split('\\n').map(line=>{const [sha,ref]=line.split(' ');return [ref,sha];}))));
  `),
  ) as Record<string, string>;
}

export function movePublicationRef(stack: ModuleStack, ref: string, head: string | null) {
  return stack.executeWebModule(`
    import {execFileSync} from 'node:child_process';
    const ref=${JSON.stringify(ref)},head=${JSON.stringify(head)};
    if(!ref.startsWith('refs/heads/') || !/^[a-zA-Z0-9/_.-]+$/.test(ref) || ref.includes('..') || (head!==null&&!/^[a-f0-9]{40}$/.test(head))) throw new Error('Invalid task-owned ref');
    execFileSync('/usr/bin/git',['--git-dir=${factoryFeaturePublicationFixtureRemotePath}','update-ref',...(head===null?['-d',ref]:[ref,head])]);
  `);
}

function one(values: string[]) {
  if (values.length !== 1 || values[0] === undefined)
    throw new Error(`Expected one execution run; got ${String(values.length)}`);
  return values[0];
}

export async function createFeaturePublicationJourney() {
  const fixture = await createVerificationFixture({
    githubFixture: factoryFeaturePublicationFixture,
    gitHubRemoteMappings: {
      [factoryFeaturePublicationFixtureRemoteUrl]: factoryFeaturePublicationFixtureRemotePath,
    },
  });
  try {
    await fixture.stack.executeWebModule(`
      import {execFileSync} from 'node:child_process';
      import {writeFile} from 'node:fs/promises';
      const environment={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
      execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','clone','--bare','--no-local','/fixtures/repositories/kestrel',${JSON.stringify(factoryFeaturePublicationFixtureRemotePath)}],{env:environment,stdio:'pipe'});
      execFileSync('/usr/bin/git',['--git-dir=${factoryFeaturePublicationFixtureRemotePath}','symbolic-ref','HEAD','refs/heads/main'],{env:environment});
      execFileSync('/usr/bin/git',['--git-dir=${factoryFeaturePublicationFixtureRemotePath}','update-ref','refs/heads/main',${JSON.stringify(fixture.source.headObjectId)}],{env:environment});
      await writeFile(${JSON.stringify(publicationGitStatePath)},JSON.stringify({controls:{},calls:[],pushes:0}));
      const delegate=process.env.LOCAL_GIT_EXECUTABLE;
      if(!delegate || !delegate.startsWith('/fixtures/git-tools/')) throw new Error('The publication wrapper must delegate only to the mapped fixture recorder');
      const createWrapper=${createPublicationGitWrapper.toString()};
      await writeFile(${JSON.stringify(publicationGitExecutablePath)},createWrapper({delegate,statePath:${JSON.stringify(publicationGitStatePath)}}),{mode:0o700});
    `);
    return {
      ...fixture,
      async approvePublication(title: string) {
        const plan = verificationPlan();
        plan.scope.excludes = [
          "Changing the approved ordering requirements",
          "Merging or closing linked issues",
        ];
        return fixture.approve(title, plan);
      },
      async implement(featureId: string) {
        const itemRuns: string[] = [];
        for (const mode of ["order", "consumer"] as const) {
          const runId = one(await fixture.queue(featureId));
          itemRuns.push(runId);
          const result = await processVerificationFixture(fixture.stack, runId, mode);
          if (result.error !== null) throw new Error(result.error);
        }
        return { itemRuns, finalRunId: one(await fixture.queue(featureId)) };
      },
      async certify(featureId: string, finalRunId: string): Promise<FactoryFeatureVerification> {
        const result = await processVerificationFixture(fixture.stack, finalRunId, "keep");
        if (result.error !== null) throw new Error(result.error);
        const certificate = (await fixture.execution(featureId)).finalVerification?.certificate;
        if (certificate == null)
          throw new Error("Real final verification did not retain a certificate");
        return certificate;
      },
      async publication(featureId: string) {
        const response = await fixture.stack.fetchApi(`${fixture.path(featureId)}/pull-request`);
        if (response.status !== 200)
          throw new Error(
            `Publication read failed: ${String(response.status)} ${await response.text()}`,
          );
        return FactoryFeaturePublicationSchema.parse(await response.json());
      },
      async retry(featureId: string, requestId = randomUUID()) {
        return fixture.post(`${fixture.path(featureId)}/pull-request/retry`, { requestId });
      },
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

export type FeaturePublicationJourney = Awaited<ReturnType<typeof createFeaturePublicationJourney>>;
