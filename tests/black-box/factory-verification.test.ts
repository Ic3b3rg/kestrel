import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FactoryExecutionSchema, FactoryGateSchema } from "@kestrel/contracts";
import {
  createVerificationFixture,
  processVerificationFixture,
  seedCertifiedVerificationHistory,
  verificationModule,
  verificationPlan,
  type VerificationFixture,
} from "./support/factory-verification-fixture.js";

function only<T>(values: T[]): T {
  expect(values).toHaveLength(1);
  const value = values[0];
  if (value === undefined) throw new Error("Expected one fixture reservation");
  return value;
}

describe("Final Feature verification through authenticated HTTP and PostgreSQL", () => {
  let fixture: VerificationFixture;
  const cleanup: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    fixture = await createVerificationFixture();
    cleanup.push(() => fixture.close());
  });
  afterAll(async () => {
    for (const close of cleanup.toReversed()) await close();
  });

  async function implement(featureId: string, breakEarlier = false) {
    const first = only(await fixture.queue(featureId));
    expect((await fixture.run(featureId, first)).purpose).toBe("work_item");
    expect(await processVerificationFixture(fixture.stack, first, "order")).toMatchObject({
      error: null,
    });
    const afterFirst = await fixture.execution(featureId);
    expect(afterFirst.finalVerification?.certificate).toBeNull();
    expect(afterFirst.finalVerification?.runs).toEqual([]);
    const second = only(await fixture.queue(featureId));
    expect(
      await processVerificationFixture(
        fixture.stack,
        second,
        breakEarlier ? "break_consumer" : "consumer",
      ),
    ).toMatchObject({ error: null });
    const afterItems = await fixture.execution(featureId);
    expect(afterItems.workItems.map((item) => item.runs.map((run) => run.state))).toEqual([
      ["verified"],
      ["verified"],
    ]);
    // Both individual passes are real, but they are not a certificate for the final head.
    expect(afterItems.state).not.toBe("verified");
    expect(afterItems.finalVerification?.certificate).toBeNull();
    return { first, second, final: only(await fixture.queue(featureId)) };
  }

  async function providerEffects() {
    return JSON.parse(
      await fixture.stack.executeWebModule(`
      import {readFile} from 'node:fs/promises';
      const state=JSON.parse(await readFile('/tmp/kestrel-factory-github.json','utf8'));
      console.log(JSON.stringify({
        writes:state.calls.filter(call=>['POST','PUT','PATCH','DELETE'].includes(call.method)),
        closed:state.issues.filter(issue=>issue.state!=='open'),
        pullRequests:state.calls.filter(call=>call.endpoint.includes('/pulls')),
      }));
    `),
    ) as { writes: unknown[]; closed: unknown[]; pullRequests: unknown[] };
  }

  it(
    "admits one exact final manifest and commits its certificate and release atomically",
    { timeout: 180_000 },
    async () => {
      const featureId = await fixture.approve(
        "Verify every approved command",
        verificationPlan(true),
      );
      try {
        const originalSource = await fixture.source.snapshotSource();
        const effects = await providerEffects();
        const runs = await implement(featureId);
        expect(await fixture.queue(featureId)).toEqual([runs.final]);
        const final = await fixture.run(featureId, runs.final);
        if (final.purpose !== "feature_verification") throw new Error("Final purpose missing");
        expect(final).toMatchObject({
          workItemId: null,
          approvedVersion: 1,
          attempt: 1,
          state: "queued",
        });
        expect(final.acceptedCommands).toHaveLength(15);
        expect(final.initialRevision).toEqual((await fixture.run(featureId, runs.second)).revision);
        expect(final.verificationManifest[1]?.origins).toEqual([
          { workItemKey: "order", position: 2 },
          { workItemKey: "consumer", position: 2 },
        ]);
        expect(
          final.verificationManifest.slice(10).map((entry) => ({
            position: entry.position,
            program: entry.command.program,
            cwd: entry.command.cwd,
            timeout: entry.command.timeoutSeconds,
            origins: entry.origins,
          })),
        ).toEqual([
          {
            position: 11,
            program: "node",
            cwd: ".",
            timeout: 10,
            origins: [{ workItemKey: "consumer", position: 1 }],
          },
          {
            position: 12,
            program: "node",
            cwd: "checks",
            timeout: 10,
            origins: [{ workItemKey: "consumer", position: 3 }],
          },
          {
            position: 13,
            program: "node",
            cwd: ".",
            timeout: 11,
            origins: [{ workItemKey: "consumer", position: 4 }],
          },
          {
            position: 14,
            program: "echo",
            cwd: ".",
            timeout: 10,
            origins: [{ workItemKey: "consumer", position: 5 }],
          },
          {
            position: 15,
            program: "node",
            cwd: ".",
            timeout: 10,
            origins: [{ workItemKey: "consumer", position: 6 }],
          },
        ]);
        // Reject the update after certificate INSERT: a missing transaction leaves a false certificate.
        await fixture.stack.executeSql(`
        CREATE FUNCTION reject_final_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.id='${runs.final}' AND NEW.state='verified' THEN RAISE EXCEPTION 'fixture certificate commit blocked'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_final_commit BEFORE UPDATE ON factory_execution_runs FOR EACH ROW EXECUTE FUNCTION reject_final_commit();
      `);
        let processed: Awaited<ReturnType<typeof processVerificationFixture>>;
        try {
          processed = await processVerificationFixture(fixture.stack, runs.final, "keep");
        } finally {
          await fixture.stack.executeSql(
            "DROP TRIGGER reject_final_commit ON factory_execution_runs; DROP FUNCTION reject_final_commit();",
          );
        }
        expect(processed.error).toContain("fixture certificate commit blocked");
        expect(processed.events).toHaveLength(15);
        expect(processed.events.every((event) => event.startsWith("check:"))).toBe(true);
        const checked = await fixture.run(featureId, runs.final);
        expect(checked.verification).toHaveLength(15);
        expect(
          checked.verification.every((check) => check.outcome === "passed" && check.exitCode === 0),
        ).toBe(true);
        expect(
          new Set(checked.verification.map((check) => `${check.headCommitId}/${check.treeId}`))
            .size,
        ).toBe(1);
        expect(
          await verificationModule(
            fixture.stack,
            `
        const result=await pool.query("SELECT state,reservation_released_at IS NOT NULL AS released,(SELECT count(*)::int FROM factory_feature_verifications WHERE run_id=$1) AS certificates,(SELECT count(*)::int FROM factory_execution_containers WHERE run_id=$1 AND stopped_at IS NULL) AS pending FROM factory_execution_runs WHERE id=$1",[${JSON.stringify(runs.final)}]);
        console.log(JSON.stringify(result.rows[0]));
      `,
          ),
        ).toEqual({ state: "verifying", released: false, certificates: 0, pending: 0 });
        expect((await fixture.execution(featureId)).finalVerification?.certificate).toBeNull();
        await verificationModule(
          fixture.stack,
          `
        const row=(await pool.query('SELECT id,project_id,feature_id,owner_instance_id FROM factory_execution_runs WHERE id=$1',[${JSON.stringify(runs.final)}])).rows[0];
        const run={id:row.id,projectId:row.project_id,featureId:row.feature_id,ownerInstanceId:row.owner_instance_id};
        await Promise.all([db.finishFactoryExecution(pool,run,{verified:true,writerStopped:true,failure:null,question:null}),db.finishFactoryExecution(pool,run,{verified:true,writerStopped:true,failure:null,question:null})]);
        console.log('null');
      `,
        );
        const certified = await fixture.execution(featureId);
        const certificate = certified.finalVerification?.certificate;
        if (certificate == null) throw new Error("Atomic final certificate missing");
        expect(certified.state).toBe("verified");
        expect(certificate).toMatchObject({
          featureId,
          runId: runs.final,
          approvedVersion: 1,
          revision: final.initialRevision,
        });
        expect(certificate.manifestDigest).toBe(
          createHash("sha256").update(JSON.stringify(certificate.manifest)).digest("hex"),
        );
        expect(certificate.evidenceIds).toEqual(checked.verification.map((check) => check.id));
        expect(await fixture.queue(featureId)).toEqual([]);
        const board = await fixture.board(featureId);
        expect(board.columns.find((column) => column.id === "in_review")?.items).toHaveLength(2);
        expect(board.columns.find((column) => column.id === "completed")?.items).toEqual([]);
        await expect(
          fixture.stack.executeRuntimeSql(
            `UPDATE factory_feature_verifications SET manifest_digest=repeat('0',64) WHERE id='${certificate.id}'`,
          ),
        ).rejects.toThrow();
        await expect(
          fixture.stack.executeRuntimeSql(
            `DELETE FROM factory_feature_verifications WHERE id='${certificate.id}'`,
          ),
        ).rejects.toThrow();
        await expect(
          fixture.stack.executeRuntimeSql(
            `DELETE FROM factory_verification_results WHERE run_id='${runs.final}'`,
          ),
        ).rejects.toThrow();
        await expect(
          fixture.stack.executeRuntimeSql(
            `UPDATE factory_execution_runs SET verification_manifest='[]'::jsonb WHERE id='${runs.final}'`,
          ),
        ).rejects.toThrow();
        expect(await providerEffects()).toEqual(effects);
        expect(await fixture.source.snapshotSource()).toBe(originalSource);
      } finally {
        await fixture.cancel(featureId);
      }
    },
  );

  it(
    "fails when W2 breaks W1 and resumes only final verification from one durable answer",
    { timeout: 180_000 },
    async () => {
      const featureId = await fixture.approve("Catch a cumulative ordering regression");
      try {
        const effects = await providerEffects();
        const runs = await implement(featureId, true);
        const firstItem = await fixture.run(featureId, runs.first);
        const consumer = await fixture.run(featureId, runs.second);
        expect(firstItem.verification[0]?.outcome).toBe("passed");
        expect(consumer.verification[0]?.outcome).toBe("passed");
        expect(firstItem.revision?.headCommitId).not.toBe(consumer.revision?.headCommitId);
        const processed = await processVerificationFixture(fixture.stack, runs.final, "keep");
        expect(processed.error).toBeNull();
        expect(processed.events[0]).toBe("check:1:1");
        expect(processed.events.filter((event) => event === "implementation-turn")).toHaveLength(2);
        const failed = await fixture.run(featureId, runs.final);
        expect(failed).toMatchObject({
          purpose: "feature_verification",
          workItemId: null,
          state: "blocked",
          failure: "verification_failed",
          writerStopped: true,
        });
        expect(
          failed.verification.filter((check) => check.position === 1).map((check) => check.outcome),
        ).toEqual(["failed", "failed", "failed"]);
        expect(failed.verification).toHaveLength(9);
        const execution = await fixture.execution(featureId);
        expect(execution.finalVerification?.certificate).toBeNull();
        const gate = execution.gate;
        if (gate == null) throw new Error("Final failure gate missing");
        expect(gate).toMatchObject({
          purpose: "feature_verification",
          workItemId: null,
          runId: runs.final,
          approvedVersion: 1,
          canResume: true,
        });
        expect(gate.question).toContain("failed checks 1");
        expect(failed.verification[0]?.command.args).toEqual(["--test", "order.test.mjs"]);
        expect(gate.question).toContain("plan version 1");
        const endpoint = `${fixture.path(featureId)}/execution/gates/${gate.id}/resolve`;
        const answer = {
          requestId: randomUUID(),
          expectedPlanVersion: 1,
          decision: "resume_within_plan",
          answer:
            "Restore stable ordering within the approved plan and rerun every original command.",
        };
        expect((await fixture.post(endpoint, { ...answer, expectedPlanVersion: 2 })).status).toBe(
          409,
        );
        const unauthenticated = await fetch(
          `${fixture.stack.apiUrl}${fixture.path(featureId)}/execution`,
        );
        expect(unauthenticated.status).toBe(401);
        await unauthenticated.arrayBuffer();
        const noCsrf = await fetch(`${fixture.stack.apiUrl}${endpoint}`, {
          method: "POST",
          headers: {
            Cookie: fixture.stack.sessionCookie,
            Origin: fixture.stack.apiUrl,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(answer),
        });
        expect(noCsrf.status).toBe(403);
        await noCsrf.arrayBuffer();
        const replies = await Promise.all([
          fixture.post(endpoint, answer),
          fixture.post(endpoint, answer),
        ]);
        for (const response of replies) {
          expect(response.status, await response.clone().text()).toBe(200);
          expect(FactoryGateSchema.parse(await response.json()).resolution).toMatchObject({
            requestId: answer.requestId,
            answer: answer.answer,
          });
        }
        await fixture.stack.restart("web");
        expect((await fixture.post(endpoint, answer)).status).toBe(200);
        const successorId = only(await fixture.queue(featureId));
        const successor = await fixture.run(featureId, successorId);
        if (
          successor.purpose !== "feature_verification" ||
          failed.purpose !== "feature_verification"
        )
          throw new Error("Retry changed purpose");
        expect(successor).toMatchObject({
          attempt: 2,
          workItemId: null,
          approvedVersion: 1,
          verificationManifest: failed.verificationManifest,
          initialRevision: failed.revision,
        });
        expect(
          (await fixture.execution(featureId)).workItems.map((item) =>
            item.runs.map((run) => run.id),
          ),
        ).toEqual([[runs.first], [runs.second]]);
        expect(
          await processVerificationFixture(fixture.stack, successorId, "repair"),
        ).toMatchObject({ error: null });
        const repaired = await fixture.run(featureId, successorId);
        expect(repaired.verification).toHaveLength(6);
        expect(repaired.verification[0]?.outcome).toBe("failed");
        expect(repaired.verification[3]?.headCommitId).not.toBe(
          repaired.verification[0]?.headCommitId,
        );
        const certified = await fixture.execution(featureId);
        expect(certified.state).toBe("verified");
        expect(certified.finalVerification?.certificate?.evidenceIds).toEqual(
          repaired.verification.filter((check) => check.round === 2).map((check) => check.id),
        );
        expect(certified.finalVerification?.runs).toHaveLength(2);
        expect(certified.workItems.map((item) => item.runs.length)).toEqual([1, 1]);
        expect((await fixture.run(featureId, runs.final)).verification).toEqual(
          failed.verification,
        );
        expect((await fixture.post(endpoint, answer)).status).toBe(200);
        expect((await fixture.post(endpoint, { ...answer, requestId: randomUUID() })).status).toBe(
          409,
        );
        expect(await fixture.queue(featureId)).toEqual([]);
        expect(await providerEffects()).toEqual(effects);
      } finally {
        await fixture.cancel(featureId);
      }
    },
  );

  it(
    "retains a cancelled final reservation until bounded recovery crosses stopped history",
    { timeout: 180_000 },
    async () => {
      const featureId = await fixture.approve(
        "Recover final verification without replaying Work Items",
      );
      const runs = await implement(featureId);
      const claim = only(await fixture.claim(runs.final));
      expect(claim).toMatchObject({ purpose: "feature_verification", workItemId: null });
      const history = await fixture.run(featureId, runs.first);
      // Synthetic lifecycle witnesses exercise DB authority, not actual Docker teardown.
      await verificationModule(
        fixture.stack,
        `
      const run=${JSON.stringify(claim)};
      const {readLocalSourceConfig,openFeatureWorkspace}=await import('@kestrel/local-source');
      const {execFileSync}=await import('node:child_process');
      const {join}=await import('node:path');
      const revision=await db.readFactoryFeatureWorkspace(pool,run);
      if(revision===null) throw new Error('Retained final workspace missing');
      const workspace=await openFeatureWorkspace(await readLocalSourceConfig(),revision,{documents:{planMarkdown:run.planMarkdown,specMarkdown:run.specMarkdown}});
      for(const entry of run.verificationManifest) {
        const digest=createHash('sha256').update(run.id+':checked:'+entry.position).digest('hex');
        const identity={name:'kestrel-factory-'+digest.slice(0,32),id:digest};
        await db.reserveFactoryExecutionContainer(pool,run,identity.name,'verification','controlled-fixture-daemon');
        await db.identifyFactoryExecutionContainer(pool,run,identity);
        const started=performance.now();
        let stdout;
        try { stdout=execFileSync(entry.command.program,entry.command.args,{cwd:join(workspace.workspacePath,entry.command.cwd),timeout:entry.command.timeoutSeconds*1000,encoding:'utf8',maxBuffer:64*1024}); }
        finally { await db.stopFactoryExecutionContainer(pool,run,identity); }
        await db.saveFactoryVerification(pool,run,{round:1,position:entry.position,command:entry.command,headCommitId:revision.headCommitId,treeId:revision.treeId,outcome:'passed',exitCode:0,stdout,stderr:'',stdoutTruncated:false,stderrTruncated:false,durationMs:Math.round(performance.now()-started)});
      }
      await pool.query("INSERT INTO factory_execution_containers(name,run_id,phase,container_id,daemon_id,stopped_at) SELECT 'kestrel-factory-'||md5($1||':history:'||n::text),$1::uuid,'verification',repeat(md5(n::text),2),'controlled-fixture-daemon',clock_timestamp() FROM generate_series(1,100) n",[run.id]);
      for(let index=1;index<=41;index++) {
        const identity={name:'kestrel-factory-'+createHash('sha256').update(run.id+':pending:'+index).digest('hex').slice(0,32),id:index.toString(16).padStart(64,'0')};
        await db.reserveFactoryExecutionContainer(pool,run,identity.name,'verification','controlled-fixture-daemon');
        await db.identifyFactoryExecutionContainer(pool,run,identity);
      }
      await db.finishFactoryExecution(pool,run,{verified:true,writerStopped:true,failure:null,question:null});
      console.log('null');
    `,
      );
      // A claimed stop cannot replace durable stop proofs, even with all same-head checks passed.
      const unconfirmed = await fixture.execution(featureId);
      expect(unconfirmed).toMatchObject({
        state: "stopping",
        failure: "stop_unconfirmed",
        finalVerification: { certificate: null },
      });
      const checkedBeforeCancel = await fixture.run(featureId, runs.final);
      expect(checkedBeforeCancel.verification.map((check) => check.outcome)).toEqual([
        "passed",
        "passed",
        "passed",
      ]);
      await fixture.cancel(featureId);
      expect((await fixture.execution(featureId)).state).toBe("stopping");
      const recover = () =>
        verificationModule<{
          released: string[];
          inspected: number;
          pending: number;
          retained: number;
        }>(
          fixture.stack,
          `
      let inspected=0;
      const released=await db.recoverFactoryExecutions(pool,async(container)=>{
        inspected++; if(container.id===null) throw new Error('Expected persisted identity');
        return {name:container.name,id:container.id};
      });
      const counts=(await pool.query('SELECT count(*)::int AS retained,count(*) FILTER(WHERE stopped_at IS NULL)::int AS pending FROM factory_execution_containers WHERE run_id=$1',[${JSON.stringify(runs.final)}])).rows[0];
      console.log(JSON.stringify({released,inspected,...counts}));
    `,
        );
      expect(await recover()).toEqual({ released: [], inspected: 40, pending: 1, retained: 144 });
      expect((await fixture.run(featureId, runs.final)).writerStopped).toBe(false);
      expect(await recover()).toEqual({
        released: [runs.final],
        inspected: 1,
        pending: 0,
        retained: 144,
      });
      expect(await recover()).toEqual({ released: [], inspected: 0, pending: 0, retained: 144 });
      expect(
        await verificationModule(
          fixture.stack,
          `
      try { await db.reserveFactoryExecutionContainer(pool,${JSON.stringify(claim)},'kestrel-factory-'+randomUUID(),'verification'); console.log('"accepted"'); }
      catch(error) { console.log(JSON.stringify(error.code)); }
    `,
        ),
      ).toBe("conflict");
      const cancelled = await fixture.execution(featureId);
      expect(cancelled).toMatchObject({
        state: "cancelled",
        finalVerification: { certificate: null },
      });
      expect(cancelled.finalVerification?.runs).toHaveLength(1);
      expect(cancelled.finalVerification?.runs[0]).toMatchObject({
        state: "cancelled",
        writerStopped: true,
      });
      expect(cancelled.workItems.map((item) => item.runs.map((run) => run.state))).toEqual([
        ["verified"],
        ["verified"],
      ]);
      expect((await fixture.run(featureId, runs.first)).verification).toEqual(history.verification);
      expect((await fixture.run(featureId, runs.final)).verification).toEqual(
        checkedBeforeCancel.verification,
      );
      const board = await fixture.board(featureId);
      expect(board.columns.find((column) => column.id === "in_review")?.items).toHaveLength(2);
      expect(board.columns.find((column) => column.id === "completed")?.items).toEqual([]);
      expect(await fixture.queue(featureId)).toEqual([]);
    },
  );

  it("admits fresh work behind 32 earlier certified Projects", { timeout: 180_000 }, async () => {
    const template = await fixture.approve("Certified scheduling history");
    try {
      const runs = await implement(template);
      expect(await processVerificationFixture(fixture.stack, runs.final, "keep")).toMatchObject({
        error: null,
      });
      expect((await fixture.execution(template)).finalVerification?.certificate).not.toBeNull();
      const seeded = await seedCertifiedVerificationHistory(fixture.stack, template);
      expect(seeded.history).toHaveLength(32);
      const fresh = seeded;
      const pending = await verificationModule<string[]>(
        fixture.stack,
        `
        await db.queueFactoryExecutions(pool,boss);
        const rows=await pool.query("SELECT id FROM factory_execution_runs WHERE feature_id=$1 AND state='queued'",[${JSON.stringify(fresh.featureId)}]);
        console.log(JSON.stringify(rows.rows.map(row=>row.id)));
      `,
      );
      const reserved = only(pending);
      const response = await fixture.stack.fetchApi(
        `/api/v1/projects/${fresh.projectId}/features/${fresh.featureId}/execution`,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const execution = FactoryExecutionSchema.parse(await response.json());
      expect(execution.workItems[0]?.runs).toEqual([
        expect.objectContaining({ id: reserved, purpose: "work_item", state: "queued" }),
      ]);
      expect(execution.finalVerification?.certificate).toBeNull();
    } finally {
      await fixture.cancel(template);
    }
  });
});
