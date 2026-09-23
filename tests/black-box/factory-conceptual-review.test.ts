import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FactoryConceptualReviewCheckCatalogSchema,
  FactoryConceptualReviewCheckSchema,
  FactoryConceptualReviewHistorySchema,
  FactoryConceptualReviewPreparationSchema,
  FactoryConceptualReviewSourceCatalogSchema,
  FactoryConceptualReviewSourceLinesSchema,
  FactoryConceptualReviewWorkflowReadSchema,
  type FactoryConceptualReviewDraft,
} from "@kestrel/contracts";
import {
  createFeaturePublicationJourney,
  processPublicationFixture,
  publicationProviderState,
  type FeaturePublicationJourney,
} from "./support/factory-feature-publication-journey.js";
import { verificationModule } from "./support/factory-verification-fixture.js";

describe("exact Conceptual Review inputs through authenticated HTTP and retained storage", () => {
  let journey: FeaturePublicationJourney;
  let closeJourney: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    closeJourney = undefined;
    journey = await createFeaturePublicationJourney();
    closeJourney = () => journey.close();
  });

  afterEach(async () => {
    const close = closeJourney;
    closeJourney = undefined;
    await close?.();
  });

  it(
    "inspects the exact approved plan, retained source and final checks without starting work",
    { timeout: 180_000 },
    async () => {
      const featureId = await journey.approvePublication("Review a certified Feature");
      const { finalRunId } = await journey.implement(featureId);
      const certificate = await journey.certify(featureId, finalRunId);
      await processPublicationFixture(journey.stack, featureId);
      const publication = await journey.publication(featureId);
      const before = await publicationProviderState(journey.stack);
      const root = `${journey.path(featureId)}/review`;

      const modelDisabled = await journey.stack.fetchApi(`${root}/preparation`);
      expect(modelDisabled.status).toBe(200);
      expect(
        FactoryConceptualReviewPreparationSchema.parse(await modelDisabled.json()),
      ).toMatchObject({
        featureId,
        preparationDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        basis: {
          objective: "Preserve stable ordering while adding its consumer",
          outcomes: [
            { key: "stable-order", intent: { kind: "approved_feature_plan" } },
            { key: "consumer-result", intent: { kind: "approved_feature_plan" } },
          ],
        },
        publication: {
          pullRequest: { headCommitId: certificate.revision.headCommitId },
          revision: { id: publication.review?.revision.id },
          certificate,
        },
        readiness: {
          state: "blocked",
          startAllowed: false,
          blockers: ["review_runtime_unavailable"],
        },
      });

      await verificationModule<null>(
        journey.stack,
        `await db.selectCodexReviewModel(pool,'controlled-model'); console.log('null');`,
      );
      const prepared = FactoryConceptualReviewPreparationSchema.parse(
        await (await journey.stack.fetchApi(`${root}/preparation`)).json(),
      );
      expect(prepared.preparationDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(prepared.readiness.blockers).toEqual(["review_runtime_unavailable"]);

      const catalog = FactoryConceptualReviewSourceCatalogSchema.parse(
        await (await journey.stack.fetchApi(`${root}/source?side=head&offset=0&limit=200`)).json(),
      );
      expect(catalog.commitId).toBe(certificate.revision.headCommitId);
      expect(catalog.entries.some(({ path }) => path === "value.mjs")).toBe(true);
      const lines = FactoryConceptualReviewSourceLinesSchema.parse(
        await (
          await journey.stack.fetchApi(
            `${root}/source/lines?side=head&path=value.mjs&startLine=1&endLine=1`,
          )
        ).json(),
      );
      expect(lines).toMatchObject({
        status: "available",
        commitId: certificate.revision.headCommitId,
      });
      if (lines.status !== "available") throw new Error("Retained source text is unavailable");
      expect(lines.text).toContain("consumer = 2");

      const checks = FactoryConceptualReviewCheckCatalogSchema.parse(
        await (await journey.stack.fetchApi(`${root}/checks?offset=0&limit=100`)).json(),
      );
      expect(checks.total).toBe(certificate.evidenceIds.length);
      expect(checks.checks.every(({ outcome }) => outcome === "passed")).toBe(true);
      const checkSummary = checks.checks[0];
      if (checkSummary === undefined) throw new Error("Final check catalog is empty");
      if (checkSummary.outcome !== "passed" || checkSummary.exitCode !== 0)
        throw new Error("Final check fixture did not pass");
      const passedCheckSummary = {
        ...checkSummary,
        outcome: "passed" as const,
        exitCode: 0 as const,
      };
      const evidenceId = checkSummary.evidenceId;
      const check = FactoryConceptualReviewCheckSchema.parse(
        await (await journey.stack.fetchApi(`${root}/checks/${evidenceId}`)).json(),
      );
      expect(check).toMatchObject({
        evidenceId,
        runId: certificate.runId,
        result: {
          headCommitId: certificate.revision.headCommitId,
          treeId: certificate.revision.treeId,
          outcome: "passed",
        },
      });
      expect(
        await verificationModule<number>(
          journey.stack,
          "console.log(JSON.stringify(Number((await pool.query('SELECT count(*) FROM review_workflows')).rows[0].count)));",
        ),
      ).toBe(0);

      const mappedOutcome = prepared.basis?.outcomes[0];
      const gapOutcome = prepared.basis?.outcomes[1];
      if (mappedOutcome === undefined || gapOutcome === undefined)
        throw new Error("Review fixture needs one mapped and one gap outcome");
      const graph: FactoryConceptualReviewDraft = {
        result: "partial",
        summary: "One approved requirement is supported by source and a final check; one is a Gap.",
        outcomes: [
          {
            id: `outcome:${mappedOutcome.key}`,
            outcomeKey: mappedOutcome.key,
            title: mappedOutcome.outcome,
            coverage: "mapped",
            behavioralStepIds: [`step:${mappedOutcome.key}`],
            reason: "Exact source and the frozen final check support this requirement.",
          },
          {
            id: `outcome:${gapOutcome.key}`,
            outcomeKey: gapOutcome.key,
            title: gapOutcome.outcome,
            coverage: "gap",
            behavioralStepIds: [],
            reason: "No independently supported behavior was established for this requirement.",
          },
        ],
        behavioralSteps: [
          {
            id: `step:${mappedOutcome.key}`,
            title: "Preserve stable order",
            description: "The implementation retains source order when values compare equally.",
            change: "modified",
            outcomeKeys: [mappedOutcome.key],
            evidenceIds: ["source:stable-order", "check:stable-order"],
          },
        ],
        evidence: [
          {
            id: "source:stable-order",
            type: "source",
            side: "head",
            path: "value.mjs",
            startLine: 1,
            endLine: 1,
            description: "Stable ordering implementation",
            sufficiency: "The exact frozen head identifies the implementation path.",
            limitations: ["Source alone cannot establish execution."],
          },
          {
            id: "check:stable-order",
            type: "check",
            evidenceId,
            relation: "supports",
            proposition: "The certified ordering check passed on the reviewed head.",
            description: "Final Feature verification",
            sufficiency: "The server-owned record establishes this command execution.",
            limitations: ["The behavioral link remains Model Judgment."],
            record: passedCheckSummary,
          },
        ],
        problems: [
          {
            id: "concern:consumer-gap",
            type: "unverified_concern",
            title: "Consumer behavior remains unverified",
            condition: "The approved consumer outcome has no supported behavioral mapping.",
            possibleConsequence: "The Feature may omit the approved consumer result.",
            reasonUnverified: "No relevant final check was linked to that requirement.",
            evidenceIds: [],
            limitations: ["A targeted final check is required."],
          },
        ],
        edges: [
          {
            from: `outcome:${mappedOutcome.key}`,
            to: `step:${mappedOutcome.key}`,
            kind: "implemented_by",
          },
          {
            from: `step:${mappedOutcome.key}`,
            to: "source:stable-order",
            kind: "supported_by",
          },
          {
            from: `step:${mappedOutcome.key}`,
            to: "check:stable-order",
            kind: "supported_by",
          },
        ],
        limitations: ["The consumer outcome remains a Gap."],
      };
      const artifactId = await verificationModule<string>(
        journey.stack,
        `const featureId=${JSON.stringify(featureId)};
         const factoryInput=${JSON.stringify(prepared)};
         const graph=${JSON.stringify(graph)};
         const identity=(await pool.query(
           \`SELECT binding.project_id, binding.change_proposal_id,
              binding.review_revision_id, revision.acquisition_change_intent_id AS change_intent_id,
              (SELECT id FROM operators LIMIT 1) AS operator_id
            FROM factory_feature_pr_revisions AS binding
            JOIN review_revisions AS revision ON revision.id=binding.review_revision_id
            WHERE binding.feature_id=$1\`, [featureId])).rows[0];
         const generated=(await pool.query(
           'SELECT uuidv7()::text AS workflow_id, uuidv7()::text AS attempt_id')).rows[0];
         const workflowId=generated.workflow_id, attemptId=generated.attempt_id;
         await pool.query(
           \`INSERT INTO review_workflows
             (id,project_id,change_proposal_id,review_revision_id,change_intent_id,
              requested_by_operator_id,input_digest,analysis_configuration,authority,
              resource_envelope,workflow_state,feature_id,request_id,factory_input,job_id,
              attempt_count,maximum_attempts,attempt_id,started_at,heartbeat_at,
              observed_head_commit_id,head_observed_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'{}','{}','{}','running',$8,$9,$10::jsonb,$11,
              1,1,$12,clock_timestamp(),clock_timestamp(),$13,clock_timestamp())\`,
           [workflowId,identity.project_id,identity.change_proposal_id,
            identity.review_revision_id,identity.change_intent_id,identity.operator_id,
            factoryInput.preparationDigest,featureId,randomUUID(),JSON.stringify(factoryInput),
            randomUUID(),attemptId,factoryInput.publication.revision.head.objectId]);
         await pool.query(
           \`INSERT INTO review_workflow_attempts
             (workflow_id,attempt_number,attempt_id,attempt_state,heartbeat_at)
            VALUES ($1,1,$2,'running',clock_timestamp())\`, [workflowId,attemptId]);
         const artifact=await db.publishFactoryConceptualReview(
           pool,{workflowId,attemptId,attemptNumber:1},graph);
         console.log(JSON.stringify(artifact.id));`,
      );
      const history = FactoryConceptualReviewHistorySchema.parse(
        await (await journey.stack.fetchApi(`${root}/artifacts?offset=0&limit=20`)).json(),
      );
      expect(history.reviews[0]).toMatchObject({
        artifactId,
        status: "partial",
        headCommitId: certificate.revision.headCommitId,
        currency: "up_to_date",
      });
      const selected = FactoryConceptualReviewWorkflowReadSchema.parse(
        await (await journey.stack.fetchApi(`${root}/artifacts/${artifactId}`)).json(),
      );
      expect(selected.artifact?.graph).toEqual(graph);
      const artifactLines = FactoryConceptualReviewSourceLinesSchema.parse(
        await (
          await journey.stack.fetchApi(
            `${root}/artifacts/${artifactId}/source/lines?side=head&path=value.mjs&startLine=1&endLine=1`,
          )
        ).json(),
      );
      expect(artifactLines).toEqual(lines);
      const artifactCheck = FactoryConceptualReviewCheckSchema.parse(
        await (
          await journey.stack.fetchApi(`${root}/artifacts/${artifactId}/checks/${evidenceId}`)
        ).json(),
      );
      expect(artifactCheck).toEqual(check);
      expect(selected.artifact?.graph.outcomes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outcomeKey: mappedOutcome.key, coverage: "mapped" }),
          expect.objectContaining({ outcomeKey: gapOutcome.key, coverage: "gap" }),
        ]),
      );
      expect(selected.artifact?.graph.problems).toContainEqual(
        expect.objectContaining({ id: "concern:consumer-gap", type: "unverified_concern" }),
      );

      await journey.source.detach();
      await journey.stack.restart("web");
      const retainedAfterDetach = FactoryConceptualReviewSourceLinesSchema.parse(
        await (
          await journey.stack.fetchApi(
            `${root}/source/lines?side=head&path=value.mjs&startLine=1&endLine=1`,
          )
        ).json(),
      );
      expect(retainedAfterDetach).toEqual(lines);
      const artifactAfterDetach = FactoryConceptualReviewWorkflowReadSchema.parse(
        await (await journey.stack.fetchApi(`${root}/artifacts/${artifactId}`)).json(),
      );
      expect(artifactAfterDetach.artifact?.graph).toEqual(graph);
      expect(
        FactoryConceptualReviewCheckSchema.parse(
          await (
            await journey.stack.fetchApi(`${root}/artifacts/${artifactId}/checks/${evidenceId}`)
          ).json(),
        ),
      ).toEqual(check);

      expect(
        (
          await journey.stack.fetchApi(
            `/api/v1/projects/01991c36-7f90-7000-8000-000000000099/features/${featureId}/review/preparation`,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await journey.stack.fetchApi(
            `${root}/source/lines?side=head&path=../secret&startLine=1&endLine=1`,
          )
        ).status,
      ).toBe(400);
      expect(
        (await journey.stack.fetchApi(`${root}/checks/01991c36-7f90-7000-8000-000000000098`))
          .status,
      ).toBe(404);

      const effects = await verificationModule<{ workflows: number; reviewWrites: number }>(
        journey.stack,
        `const workflows=Number((await pool.query('SELECT count(*) FROM review_workflows')).rows[0].count);
         const reviewWrites=Number((await pool.query("SELECT count(*) FROM installation_audit_records WHERE event_type LIKE 'review_workflow.%'")).rows[0].count);
         console.log(JSON.stringify({workflows,reviewWrites}));`,
      );
      expect(effects).toEqual({ workflows: 1, reviewWrites: 0 });
      const lockedLifecycle = await verificationModule<{
        stop: { code: string; elapsedMs: number };
        claim: { code: string; elapsedMs: number };
        reconcile: { completed: boolean; elapsedMs: number };
      }>(
        journey.stack,
        `const featureId=${JSON.stringify(featureId)};
         const factoryInput=${JSON.stringify(prepared)};
         const identity=(await pool.query(
           \`SELECT binding.project_id, binding.change_proposal_id,
              binding.review_revision_id, revision.acquisition_change_intent_id AS change_intent_id,
              (SELECT id FROM operators LIMIT 1) AS operator_id
            FROM factory_feature_pr_revisions AS binding
            JOIN review_revisions AS revision ON revision.id=binding.review_revision_id
            WHERE binding.feature_id=$1\`, [featureId])).rows[0];
         const workflowId=randomUUID(), attemptId=randomUUID();
         await pool.query(
           \`INSERT INTO review_workflows
             (id,project_id,change_proposal_id,review_revision_id,change_intent_id,
              requested_by_operator_id,input_digest,analysis_configuration,authority,
              resource_envelope,workflow_state,feature_id,request_id,factory_input,job_id,
              attempt_count,maximum_attempts,attempt_id,started_at,heartbeat_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'{}','{}','{}','running',$8,$9,'{}',$10,
              1,1,$11,clock_timestamp(),clock_timestamp())\`,
           [workflowId,identity.project_id,identity.change_proposal_id,
            identity.review_revision_id,identity.change_intent_id,identity.operator_id,
            'd'.repeat(64),featureId,randomUUID(),randomUUID(),attemptId]);
         const containerName='kestrel-factory-'+'a'.repeat(32);
         await pool.query(
           \`INSERT INTO review_workflow_attempts
             (workflow_id,attempt_number,attempt_id,attempt_state,container_name)
            VALUES ($1,1,$2,'running',$3)\`, [workflowId,attemptId,containerName]);
         const locker=await pool.connect();
         await locker.query('BEGIN');
         await locker.query(
           'SELECT 1 FROM review_workflow_attempts WHERE workflow_id=$1 FOR UPDATE',
           [workflowId]);
         const started=Date.now(); let code='none';
         try {
           await db.stopFactoryConceptualReviewContainer(
             pool,{workflowId,attemptId,attemptNumber:1},{name:containerName,id:null},100);
         } catch (error) { code=error?.code ?? 'unknown'; }
         const elapsedMs=Date.now()-started;
         await locker.query('ROLLBACK'); locker.release();
         await pool.query(
           "UPDATE review_workflow_attempts SET attempt_state='failed',failure_code='internal_error',finished_at=clock_timestamp() WHERE workflow_id=$1",
           [workflowId]);
         await pool.query(
           "UPDATE review_workflows SET workflow_state='failed',failure_code='internal_error',finished_at=clock_timestamp() WHERE id=$1",
           [workflowId]);

         const queuedWorkflowId=randomUUID();
         await pool.query(
           \`INSERT INTO review_workflows
             (id,project_id,change_proposal_id,review_revision_id,change_intent_id,
              requested_by_operator_id,input_digest,analysis_configuration,authority,
              resource_envelope,workflow_state,feature_id,request_id,factory_input,job_id,
              attempt_count,maximum_attempts)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'{}','{}','{}','queued',$8,$9,$10::jsonb,$11,0,1)\`,
           [queuedWorkflowId,identity.project_id,identity.change_proposal_id,
            identity.review_revision_id,identity.change_intent_id,identity.operator_id,
            factoryInput.preparationDigest,featureId,randomUUID(),JSON.stringify(factoryInput),randomUUID()]);
         const claimLocker=await pool.connect();
         await claimLocker.query('BEGIN');
         await claimLocker.query('SELECT 1 FROM review_workflows WHERE id=$1 FOR UPDATE',[queuedWorkflowId]);
         const claimStarted=Date.now(); let claimCode='none';
         try { await db.claimFactoryConceptualReviewWorkflow(pool,queuedWorkflowId,100); }
         catch (error) { claimCode=error?.code ?? 'unknown'; }
         const claimElapsedMs=Date.now()-claimStarted;
         await claimLocker.query('ROLLBACK'); claimLocker.release();
         await pool.query(
           "UPDATE review_workflows SET workflow_state='failed',failure_code='internal_error',finished_at=clock_timestamp() WHERE id=$1",
           [queuedWorkflowId]);

         const staleWorkflowId=randomUUID(), staleAttemptId=randomUUID();
         await pool.query(
           \`INSERT INTO review_workflows
             (id,project_id,change_proposal_id,review_revision_id,change_intent_id,
              requested_by_operator_id,input_digest,analysis_configuration,authority,
              resource_envelope,workflow_state,feature_id,request_id,factory_input,job_id,
              attempt_count,maximum_attempts,attempt_id,started_at,heartbeat_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'{}','{}','{}','running',$8,$9,$10::jsonb,$11,
              1,1,$12,clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute')\`,
           [staleWorkflowId,identity.project_id,identity.change_proposal_id,
            identity.review_revision_id,identity.change_intent_id,identity.operator_id,
            factoryInput.preparationDigest,featureId,randomUUID(),JSON.stringify(factoryInput),randomUUID(),staleAttemptId]);
         await pool.query(
           \`INSERT INTO review_workflow_attempts
             (workflow_id,attempt_number,attempt_id,attempt_state,heartbeat_at)
            VALUES ($1,1,$2,'running',clock_timestamp()-interval '1 minute')\`,
           [staleWorkflowId,staleAttemptId]);
         const reconcileLocker=await pool.connect();
         await reconcileLocker.query('BEGIN');
         await reconcileLocker.query(
           \`SELECT 1 FROM review_workflows AS workflow
             JOIN review_workflow_attempts AS attempt ON attempt.workflow_id=workflow.id
             WHERE workflow.id=$1 FOR UPDATE OF workflow,attempt\`,[staleWorkflowId]);
         const reconcileStarted=Date.now(); let reconcileCompleted=false;
         await db.reconcileFactoryConceptualReviewWorkflows(
           pool,{send:async()=>{throw new Error('Unexpected reconciliation send')}},
           undefined,async()=>{},100);
         reconcileCompleted=true;
         const reconcileElapsedMs=Date.now()-reconcileStarted;
         await reconcileLocker.query('ROLLBACK'); reconcileLocker.release();
         await pool.query(
           "UPDATE review_workflow_attempts SET attempt_state='failed',failure_code='internal_error',finished_at=clock_timestamp() WHERE workflow_id=$1",
           [staleWorkflowId]);
         await pool.query(
           "UPDATE review_workflows SET workflow_state='failed',failure_code='internal_error',finished_at=clock_timestamp() WHERE id=$1",
           [staleWorkflowId]);
         console.log(JSON.stringify({
           stop:{code,elapsedMs},
           claim:{code:claimCode,elapsedMs:claimElapsedMs},
           reconcile:{completed:reconcileCompleted,elapsedMs:reconcileElapsedMs}
         }));`,
      );
      expect(lockedLifecycle.stop.code).toBe("timeout");
      expect(lockedLifecycle.stop.elapsedMs).toBeLessThan(3_000);
      expect(lockedLifecycle.claim.code).toBe("timeout");
      expect(lockedLifecycle.claim.elapsedMs).toBeLessThan(3_000);
      expect(lockedLifecycle.reconcile.completed).toBe(true);
      expect(lockedLifecycle.reconcile.elapsedMs).toBeLessThan(3_000);
      expect((await publicationProviderState(journey.stack)).writes).toEqual(before.writes);
    },
  );
});
