import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactoryFeaturePublicationSchema, ProjectInboxSchema } from "@kestrel/contracts";
import {
  createFeaturePublicationJourney,
  interruptPublicationFixtureDuringPush,
  movePublicationRef,
  processPublicationFixture,
  publicationGitState,
  publicationProviderState,
  publicationRemoteRefs,
  setPublicationGitControls,
  setPublicationProviderControls,
  type FeaturePublicationJourney,
} from "./support/factory-feature-publication-journey.js";

async function waitFor(predicate: () => Promise<boolean>, description: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe("certified Feature PR publication through HTTP, PostgreSQL, Git and GitHub", () => {
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
    "publishes one cumulative PR and retains its exact Review Revision without closing work",
    { timeout: 180_000 },
    async () => {
      const originalSource = await journey.source.snapshotSource();
      const pushesBefore = (await publicationGitState(journey.stack)).pushes;
      const featureId = await journey.approvePublication("Publish the certified Feature");
      const { finalRunId } = await journey.implement(featureId);
      const certificate = await journey.certify(featureId, finalRunId);
      const providerBefore = await publicationProviderState(journey.stack);

      await processPublicationFixture(journey.stack, featureId);

      const publication = await journey.publication(featureId);
      expect(publication).toMatchObject({
        featureId,
        approvedVersion: 1,
        state: "published",
        cancelled: false,
        failure: null,
        canRetry: false,
      });
      expect(publication.certificate).toEqual(certificate);
      expect(publication.issues.map(({ key }) => key)).toEqual(["order", "consumer"]);
      expect(publication.issues.every(({ issue }) => issue.repository.name === "kestrel")).toBe(
        true,
      );
      expect(publication.pullRequest).toMatchObject({
        state: "open",
        baseRef: "main",
        headRef: `kestrel/feature/${featureId}`,
        baseCommitId: certificate.revision.baseCommitId,
        headCommitId: certificate.revision.headCommitId,
      });
      expect(publication.pullRequest?.body).toContain(
        "These results cover the declared verification commands. Conceptual Review has not run yet.",
      );
      expect(publication.review).toMatchObject({
        revision: {
          state: "available",
          base: { objectId: certificate.revision.baseCommitId },
          head: { objectId: certificate.revision.headCommitId },
        },
      });
      expect(publication.review?.manifestDigest).toMatch(/^[a-f0-9]{64}$/u);

      const board = await journey.board(featureId);
      expect(board.columns.find(({ id }) => id === "in_review")?.items).toHaveLength(2);
      expect(board.columns.find(({ id }) => id === "completed")?.items).toEqual([]);

      const provider = await publicationProviderState(journey.stack);
      expect(provider.pullRequests).toHaveLength(providerBefore.pullRequests.length + 1);
      expect(provider.writes.filter(({ endpoint }) => endpoint.endsWith("/pulls"))).toHaveLength(
        providerBefore.writes.filter(({ endpoint }) => endpoint.endsWith("/pulls")).length + 1,
      );
      expect(provider.issues.every(({ state }) => state === "open")).toBe(true);
      expect((await publicationGitState(journey.stack)).pushes).toBe(pushesBefore + 1);

      const refs = await publicationRemoteRefs(journey.stack);
      expect(refs["refs/heads/main"]).toBe(certificate.revision.baseCommitId);
      expect(refs[`refs/heads/kestrel/feature/${featureId}`]).toBe(
        certificate.revision.headCommitId,
      );
      expect(await journey.source.snapshotSource()).toBe(originalSource);

      const review = publication.review;
      if (review === null) throw new Error("Published Feature has no retained Review Revision");
      const inbox = ProjectInboxSchema.parse(
        await (await journey.stack.fetchApi("/api/v1/projects")).json(),
      );
      const project = inbox.projects.find(({ id }) => id === review.projectId);
      const proposal = project?.changeProposals.find(({ id }) => id === review.changeProposalId);
      const planSource = proposal?.changeIntent?.sources.find(
        ({ kind }) => kind === "approved_feature_plan",
      );
      expect(planSource).toMatchObject({
        kind: "approved_feature_plan",
        provenance: {
          kind: "approved_feature_plan",
          featureId,
          approvedVersion: 1,
          certificateId: certificate.id,
        },
      });
    },
  );

  it(
    "reconciles an interrupted push and a lost PR response after restart without duplicate writes",
    { timeout: 180_000 },
    async () => {
      const pushesBefore = (await publicationGitState(journey.stack)).pushes;
      const featureId = await journey.approvePublication("Recover an uncertain Feature PR");
      const { finalRunId } = await journey.implement(featureId);
      const certificate = await journey.certify(featureId, finalRunId);
      const providerBefore = await publicationProviderState(journey.stack);

      await setPublicationGitControls(journey.stack, { pauseAfterPush: true });
      await interruptPublicationFixtureDuringPush(journey.stack, featureId);
      await setPublicationGitControls(journey.stack, { pauseAfterPush: false });
      expect(await journey.publication(featureId)).toMatchObject({
        state: "uncertain",
        failure: "uncertain_write",
        canRetry: true,
        pullRequest: null,
      });
      expect(
        (await publicationRemoteRefs(journey.stack))[`refs/heads/kestrel/feature/${featureId}`],
      ).toBe(certificate.revision.headCommitId);

      await journey.stack.restart("web");
      const pushRetryId = randomUUID();
      expect((await journey.retry(featureId, pushRetryId)).status).toBe(202);
      expect((await journey.retry(featureId, pushRetryId)).status).toBe(202);
      await setPublicationProviderControls(journey.stack, { uncertainPullRequestCreate: true });
      await processPublicationFixture(journey.stack, featureId);
      expect(await journey.publication(featureId)).toMatchObject({
        state: "uncertain",
        failure: "uncertain_write",
        canRetry: true,
        pullRequest: null,
      });

      await journey.stack.restart("web");
      const prRetryId = randomUUID();
      expect((await journey.retry(featureId, prRetryId)).status).toBe(202);
      expect((await journey.retry(featureId, prRetryId)).status).toBe(202);
      await processPublicationFixture(journey.stack, featureId);

      const recovered = FactoryFeaturePublicationSchema.parse(
        await (await journey.stack.fetchApi(`${journey.path(featureId)}/pull-request`)).json(),
      );
      expect(recovered).toMatchObject({
        state: "published",
        failure: null,
        pullRequest: { headCommitId: certificate.revision.headCommitId },
        review: { revision: { state: "available" } },
      });
      const provider = await publicationProviderState(journey.stack);
      expect(provider.pullRequests).toHaveLength(providerBefore.pullRequests.length + 1);
      expect(provider.writes.filter(({ endpoint }) => endpoint.endsWith("/pulls"))).toHaveLength(
        providerBefore.writes.filter(({ endpoint }) => endpoint.endsWith("/pulls")).length + 1,
      );
      expect((await publicationGitState(journey.stack)).pushes).toBe(pushesBefore + 1);
    },
  );

  it(
    "blocks target drift before either the Feature push or PR creation",
    { timeout: 180_000 },
    async () => {
      const originalSource = await journey.source.snapshotSource();
      const pushesBefore = (await publicationGitState(journey.stack)).pushes;
      const featureId = await journey.approvePublication("Reject target branch drift");
      const { finalRunId } = await journey.implement(featureId);
      const certificate = await journey.certify(featureId, finalRunId);
      const providerBefore = await publicationProviderState(journey.stack);
      expect(journey.source.baseObjectId).not.toBe(certificate.revision.baseCommitId);

      await movePublicationRef(journey.stack, "refs/heads/main", journey.source.baseObjectId);
      try {
        await processPublicationFixture(journey.stack, featureId);
        expect(await journey.publication(featureId)).toMatchObject({
          state: "blocked",
          failure: "target_changed",
          canRetry: true,
          pullRequest: null,
          review: null,
        });
        expect((await publicationGitState(journey.stack)).pushes).toBe(pushesBefore);
        const provider = await publicationProviderState(journey.stack);
        expect(provider.pullRequests).toHaveLength(providerBefore.pullRequests.length);
        expect(provider.writes.filter(({ endpoint }) => endpoint.endsWith("/pulls"))).toHaveLength(
          providerBefore.writes.filter(({ endpoint }) => endpoint.endsWith("/pulls")).length,
        );
        expect(await journey.source.snapshotSource()).toBe(originalSource);
      } finally {
        await movePublicationRef(
          journey.stack,
          "refs/heads/main",
          certificate.revision.baseCommitId,
        );
      }
    },
  );

  it(
    "reconciles a push completed during cancellation and never opens a PR",
    { timeout: 180_000 },
    async () => {
      const pushesBefore = (await publicationGitState(journey.stack)).pushes;
      const featureId = await journey.approvePublication("Cancel after the Feature push");
      const { finalRunId } = await journey.implement(featureId);
      const certificate = await journey.certify(featureId, finalRunId);
      const providerBefore = await publicationProviderState(journey.stack);

      await setPublicationGitControls(journey.stack, { pauseAfterPush: true });
      const processing = processPublicationFixture(journey.stack, featureId);
      await waitFor(
        async () => (await publicationGitState(journey.stack)).paused === true,
        "the completed Feature push to pause before returning",
      );
      await journey.cancel(featureId);
      await new Promise((resolve) => setTimeout(resolve, 1_250));
      await setPublicationGitControls(journey.stack, { pauseAfterPush: false });
      await processing;

      expect(
        (await publicationRemoteRefs(journey.stack))[`refs/heads/kestrel/feature/${featureId}`],
      ).toBe(certificate.revision.headCommitId);
      expect(await journey.publication(featureId)).toMatchObject({
        state: "uncertain",
        cancelled: true,
        canRetry: true,
        pullRequest: null,
      });

      expect((await journey.retry(featureId)).status).toBe(202);
      await processPublicationFixture(journey.stack, featureId);
      expect(await journey.publication(featureId)).toMatchObject({
        state: "cancelled",
        cancelled: true,
        failure: "cancelled",
        canRetry: false,
        pullRequest: null,
        review: null,
      });
      const provider = await publicationProviderState(journey.stack);
      expect(provider.pullRequests).toHaveLength(providerBefore.pullRequests.length);
      expect(provider.writes.filter(({ endpoint }) => endpoint.endsWith("/pulls"))).toHaveLength(
        providerBefore.writes.filter(({ endpoint }) => endpoint.endsWith("/pulls")).length,
      );
      expect((await publicationGitState(journey.stack)).pushes).toBe(pushesBefore + 1);
    },
  );
});
