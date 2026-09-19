import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FactoryConceptualReviewCheckCatalogSchema,
  FactoryConceptualReviewCheckSchema,
  FactoryConceptualReviewPreparationSchema,
  FactoryConceptualReviewSourceCatalogSchema,
  FactoryConceptualReviewSourceLinesSchema,
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
        preparationDigest: null,
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
          blockers: ["model_not_selected", "review_runtime_unavailable"],
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
      const evidenceId = checks.checks[0]?.evidenceId;
      if (evidenceId === undefined) throw new Error("Final check catalog is empty");
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
      expect(effects).toEqual({ workflows: 0, reviewWrites: 0 });
      expect((await publicationProviderState(journey.stack)).writes).toEqual(before.writes);
    },
  );
});
