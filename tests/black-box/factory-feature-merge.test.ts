import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FactoryFeatureMergeSchema, type FactoryConceptualReviewDraft } from "@kestrel/contracts";
import {
  createFeaturePublicationJourney,
  processMergeFixture,
  processPublicationFixture,
  publicationProviderState,
  publicationRemoteRefs,
  publishConceptualReviewFixture,
  setPublicationProviderControls,
  type FeaturePublicationJourney,
} from "./support/factory-feature-publication-journey.js";

function completeReview(): FactoryConceptualReviewDraft {
  const evidenceId = "source:feature-result";
  const outcomes = [
    {
      id: "outcome:stable-order",
      outcomeKey: "stable-order",
      title: "Equal values retain their original order",
      coverage: "mapped" as const,
      behavioralStepIds: ["step:stable-order"],
      reason: "The exact revision preserves equal-value ordering.",
    },
    {
      id: "outcome:consumer-result",
      outcomeKey: "consumer-result",
      title: "The consumer returns its approved result",
      coverage: "mapped" as const,
      behavioralStepIds: ["step:consumer-result"],
      reason: "The exact revision exposes the approved consumer result.",
    },
  ];
  const behavioralSteps = outcomes.map((outcome) => ({
    id: outcome.id.replace("outcome:", "step:"),
    title: outcome.title,
    description: outcome.reason,
    change: "modified" as const,
    outcomeKeys: [outcome.outcomeKey],
    evidenceIds: [evidenceId],
  }));
  return {
    result: "complete",
    summary: "The exact reviewed revision satisfies both approved outcomes.",
    outcomes,
    behavioralSteps,
    evidence: [
      {
        id: evidenceId,
        type: "source",
        side: "head",
        path: "value.mjs",
        startLine: 1,
        endLine: 1,
        description: "Approved behavior implementation",
        sufficiency: "The exact retained head contains both approved exports.",
        limitations: ["Runtime proof is linked from the final verification certificate."],
      },
    ],
    problems: [],
    edges: [
      ...outcomes.map((outcome) => ({
        from: outcome.id,
        to: outcome.id.replace("outcome:", "step:"),
        kind: "implemented_by" as const,
      })),
      ...behavioralSteps.map((step) => ({
        from: step.id,
        to: evidenceId,
        kind: "supported_by" as const,
      })),
    ],
    limitations: [],
  };
}

describe("approved exact-head merge through GitHub and the project queue", () => {
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
    "recovers an uncertain merge, closes linked issues, and releases the next Feature",
    { timeout: 300_000 },
    async () => {
      const featureId = await journey.approvePublication("Merge one reviewed Feature");
      const { finalRunId } = await journey.implement(featureId);
      const certificate = await journey.certify(featureId, finalRunId);
      await processPublicationFixture(journey.stack, featureId);
      const publication = await journey.publication(featureId);
      if (publication.pullRequest === null) throw new Error("The Feature PR was not published");
      const review = await publishConceptualReviewFixture(
        journey.stack,
        { projectId: journey.projectId, featureId },
        completeReview(),
      );

      const waitingFeatureId = await journey.approvePublication("Wait for the project lane");
      expect(await journey.queue(waitingFeatureId)).toEqual([]);

      const approval = await journey.merge(featureId, review);
      expect(approval.response.status, JSON.stringify(approval.error)).toBe(202);
      expect(approval.value).toMatchObject({
        featureId,
        state: "queued",
        sourceReview: {
          workflowId: review.workflowId,
          artifactId: review.id,
          headCommitId: certificate.revision.headCommitId,
        },
        pullRequest: { number: publication.pullRequest.number },
      });

      await setPublicationProviderControls(journey.stack, {
        uncertainMerge: true,
        failIssueCloseOnce: true,
      });
      const uncertain = await processMergeFixture(journey.stack, featureId);
      expect(uncertain.merge).toMatchObject({
        state: "uncertain",
        failure: "uncertain_write",
        provider: { merged: false },
      });
      let provider = await publicationProviderState(journey.stack);
      expect(
        provider.pullRequests.find(({ number }) => number === publication.pullRequest?.number),
      ).toMatchObject({
        state: "closed",
        merged: true,
        merge_commit_sha: certificate.revision.headCommitId,
      });
      expect(provider.writes.filter(({ endpoint }) => endpoint.endsWith("/merge"))).toHaveLength(1);
      expect(
        provider.issues
          .filter(({ number }) => publication.issues.some(({ issue }) => issue.number === number))
          .every(({ state }) => state === "open"),
      ).toBe(true);
      expect(await journey.queue(waitingFeatureId)).toEqual([]);

      await journey.stack.restart("web");
      const retryAfterRestart = await journey.retryMerge(featureId, randomUUID());
      expect(retryAfterRestart.status).toBe(202);
      const closing = await processMergeFixture(journey.stack, featureId);
      expect(closing.merge).toMatchObject({
        state: "closing_issues",
        failure: "issue_closure_failed",
        provider: {
          merged: true,
          mergeCommitId: certificate.revision.headCommitId,
        },
      });
      expect(closing.merge?.issues.some(({ state }) => state === "failed")).toBe(true);
      expect(closing.merge?.issues.some(({ state }) => state === "closed")).toBe(true);
      const releasedRuns = await journey.queue(waitingFeatureId);
      expect(releasedRuns).toHaveLength(1);
      const completedBoard = await journey.board(featureId);
      expect(completedBoard.feature.state).toBe("completed");
      expect(completedBoard.columns.find(({ id }) => id === "completed")?.items).toHaveLength(2);

      const closureRetry = await journey.retryMerge(featureId, randomUUID());
      expect(closureRetry.status).toBe(202);
      const completed = await processMergeFixture(journey.stack, featureId);
      expect(completed.merge).toMatchObject({
        state: "completed",
        failure: null,
        provider: {
          merged: true,
          mergeCommitId: certificate.revision.headCommitId,
        },
      });
      expect(completed.merge?.issues.every(({ state }) => state === "closed")).toBe(true);
      expect(FactoryFeatureMergeSchema.parse(completed.merge).completedAt).not.toBeNull();

      provider = await publicationProviderState(journey.stack);
      expect(provider.writes.filter(({ endpoint }) => endpoint.endsWith("/merge"))).toHaveLength(1);
      expect(
        provider.issues
          .filter(({ number }) => publication.issues.some(({ issue }) => issue.number === number))
          .every(({ state }) => state === "closed"),
      ).toBe(true);
      expect((await publicationRemoteRefs(journey.stack))["refs/heads/main"]).toBe(
        certificate.revision.headCommitId,
      );
    },
  );
});
