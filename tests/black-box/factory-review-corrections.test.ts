import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FactoryConceptualReviewCurrentSchema,
  FactoryConceptualReviewHistorySchema,
  FactoryFeaturePublicationSchema,
  FactoryReviewCorrectionCurrentSchema,
  FactoryReviewCorrectionSchema,
  type FactoryConceptualReviewDraft,
} from "@kestrel/contracts";
import {
  createFeaturePublicationJourney,
  processCorrectionPublicationFixture,
  processPublicationFixture,
  publicationProviderState,
  publicationRemoteRefs,
  publishConceptualReviewFixture,
  publishQueuedConceptualReviewFixture,
  setPublicationProviderControls,
  type FeaturePublicationJourney,
} from "./support/factory-feature-publication-journey.js";
import { processVerificationFixture } from "./support/factory-verification-fixture.js";

function reviewGraph(withFinding: boolean): FactoryConceptualReviewDraft {
  const evidenceId = "source:feature-result";
  const outcomes = [
    {
      id: "outcome:stable-order",
      outcomeKey: "stable-order",
      title: "Equal values retain their original order",
      coverage: "mapped" as const,
      behavioralStepIds: ["step:stable-order"],
      reason: "The retained source implements the approved ordering result.",
    },
    {
      id: "outcome:consumer-result",
      outcomeKey: "consumer-result",
      title: "The consumer returns its approved result",
      coverage: "mapped" as const,
      behavioralStepIds: ["step:consumer-result"],
      reason: "The retained source exposes the approved consumer result.",
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
    result: withFinding ? "partial" : "complete",
    summary: withFinding
      ? "The approved outcomes are present, with one bounded implementation defect."
      : "The corrected exact revision satisfies the approved outcomes.",
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
        description: "Feature result implementation",
        sufficiency: "The exact retained head contains both approved exports.",
        limitations: ["Runtime proof remains in the immutable verification certificate."],
      },
    ],
    problems: withFinding
      ? [
          {
            id: "finding:clarify-result",
            type: "finding",
            title: "The result has no correction marker",
            condition: "An operator inspects the selected implementation path.",
            consequence: "The reviewed technical correction is not explicit in source.",
            reasoning: "The exact reviewed line contains only the two exported values.",
            evidenceIds: [evidenceId],
            riskLevel: "low",
            sufficiency: "The retained source line shows the missing marker.",
            limitations: ["This finding does not change an approved behavior."],
          },
        ]
      : [],
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
      ...(withFinding
        ? [
            {
              from: evidenceId,
              to: "finding:clarify-result",
              kind: "reveals" as const,
            },
          ]
        : []),
    ],
    limitations: [],
  };
}

describe("selected review correction through replacement Conceptual Review", () => {
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
    "keeps one PR, applies exact bounded authority, survives restart, and preserves both reviews",
    { timeout: 240_000 },
    async () => {
      const featureId = await journey.approvePublication("Correct one reviewed defect");
      const { finalRunId } = await journey.implement(featureId);
      await journey.certify(featureId, finalRunId);
      await processPublicationFixture(journey.stack, featureId);
      const originalPublication = await journey.publication(featureId);
      const originalPullRequest = originalPublication.pullRequest;
      if (originalPullRequest === null) throw new Error("The original PR was not published");
      const originalReview = await publishConceptualReviewFixture(
        journey.stack,
        { projectId: journey.projectId, featureId },
        reviewGraph(true),
      );
      const root = `${journey.path(featureId)}/review/corrections`;

      const unknown = await journey.post(root, {
        requestId: randomUUID(),
        expectedPlanVersion: 1,
        review: {
          workflowId: originalReview.workflowId,
          artifactId: originalReview.id,
          headCommitId: originalReview.headCommitId,
        },
        instruction: "Apply only the selected technical correction.",
        findingIds: ["finding:missing"],
      });
      expect(unknown.status).toBe(409);

      const requestId = randomUUID();
      const command = {
        requestId,
        expectedPlanVersion: 1,
        review: {
          workflowId: originalReview.workflowId,
          artifactId: originalReview.id,
          headCommitId: originalReview.headCommitId,
        },
        instruction: "Add the reviewed correction marker without changing approved behavior.",
        findingIds: ["finding:clarify-result"],
      };
      const acceptedResponse = await journey.post(root, command);
      expect(acceptedResponse.status).toBe(202);
      const accepted = FactoryReviewCorrectionSchema.parse(await acceptedResponse.json());
      expect(accepted).toMatchObject({
        featureId,
        approvedVersion: 1,
        state: "executing",
        instruction: command.instruction,
        findings: [{ id: "finding:clarify-result", riskLevel: "low" }],
        sourceReview: {
          workflowId: originalReview.workflowId,
          artifactId: originalReview.id,
          headCommitId: originalReview.headCommitId,
        },
      });

      await setPublicationProviderControls(journey.stack, { auth: true });
      const replay = await journey.post(root, command);
      expect(replay.status).toBe(202);
      expect(FactoryReviewCorrectionSchema.parse(await replay.json()).id).toBe(accepted.id);
      const conflictingReplay = await journey.post(root, {
        ...command,
        instruction: "Use the same request ID for different authority.",
      });
      expect(conflictingReplay.status).toBe(409);
      await setPublicationProviderControls(journey.stack, { auth: false });

      const execution = await processVerificationFixture(
        journey.stack,
        accepted.runId,
        "correction",
      );
      expect(execution.error).toBeNull();
      expect(execution.events).toContain("implementation-turn");
      const verified = FactoryReviewCorrectionCurrentSchema.parse(
        await (await journey.stack.fetchApi(`${root}/current`)).json(),
      ).correction;
      expect(verified).toMatchObject({ id: accepted.id, state: "publishing" });
      expect(verified?.certificateId).not.toBeNull();

      const publishing = await processCorrectionPublicationFixture(journey.stack, accepted.id);
      expect(publishing.correction).toMatchObject({ id: accepted.id, state: "reviewing" });
      const replacement = publishing.correction?.replacementReview;
      if (replacement === null || replacement === undefined)
        throw new Error("The replacement review was not started");
      expect(replacement.artifactId).toBeNull();
      expect(replacement.headCommitId).not.toBe(originalReview.headCommitId);

      const currentPublicationResponse = await journey.stack.fetchApi(
        `${journey.path(featureId)}/pull-request`,
      );
      expect(currentPublicationResponse.status).toBe(200);
      const currentPublication = FactoryFeaturePublicationSchema.parse(
        await currentPublicationResponse.json(),
      );
      expect(currentPublication.pullRequest).toMatchObject({
        number: originalPullRequest.number,
        headCommitId: replacement.headCommitId,
      });
      const provider = await publicationProviderState(journey.stack);
      expect(provider.pullRequests).toHaveLength(1);
      expect(provider.pullRequests[0]?.number).toBe(originalPullRequest.number);
      const refs = await publicationRemoteRefs(journey.stack);
      expect(refs[`refs/heads/${originalPullRequest.headRef}`]).toBe(replacement.headCommitId);

      const completed = await publishQueuedConceptualReviewFixture(
        journey.stack,
        replacement.workflowId,
        reviewGraph(false),
      );
      expect(completed.correction).toMatchObject({
        id: accepted.id,
        state: "completed",
        failure: null,
        replacementReview: { workflowId: replacement.workflowId },
      });
      expect(completed.correction?.replacementReview?.artifactId).not.toBeNull();

      const currentReview = FactoryConceptualReviewCurrentSchema.parse(
        await (
          await journey.stack.fetchApi(`${journey.path(featureId)}/review/workflows/current`)
        ).json(),
      );
      expect(currentReview.review).toMatchObject({
        workflow: { id: replacement.workflowId, state: "published" },
        artifact: { headCommitId: replacement.headCommitId, status: "complete" },
        currency: "up_to_date",
      });
      const history = FactoryConceptualReviewHistorySchema.parse(
        await (
          await journey.stack.fetchApi(
            `${journey.path(featureId)}/review/artifacts?offset=0&limit=20`,
          )
        ).json(),
      );
      expect(history.reviews.map(({ artifactId }) => artifactId)).toEqual(
        expect.arrayContaining([
          originalReview.id,
          completed.correction?.replacementReview?.artifactId,
        ]),
      );

      await journey.stack.restart("web");
      const afterRestart = FactoryReviewCorrectionCurrentSchema.parse(
        await (await journey.stack.fetchApi(`${root}/current`)).json(),
      );
      expect(afterRestart.correction).toMatchObject({
        id: accepted.id,
        state: "completed",
        replacementReview: { workflowId: replacement.workflowId },
      });

      const replacementReview = currentReview.review;
      if (replacementReview === null || replacementReview.artifact === null)
        throw new Error("The replacement review cannot authorize the cancellation check");
      const secondResponse = await journey.post(root, {
        requestId: randomUUID(),
        expectedPlanVersion: 1,
        review: {
          workflowId: replacementReview.workflow.id,
          artifactId: replacementReview.artifact.id,
          headCommitId: replacementReview.artifact.headCommitId,
        },
        instruction: "Apply one more bounded correction before cancellation.",
        findingIds: [],
      });
      expect(secondResponse.status).toBe(202);
      const second = FactoryReviewCorrectionSchema.parse(await secondResponse.json());
      expect(second.state).toBe("executing");
      await journey.cancel(featureId);
      const cancelled = FactoryReviewCorrectionCurrentSchema.parse(
        await (await journey.stack.fetchApi(`${root}/current`)).json(),
      );
      expect(cancelled.correction).toMatchObject({
        id: second.id,
        state: "cancelled",
        failure: "cancelled",
      });
    },
  );
});
