import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { FactoryConceptualReviewDraft } from "@kestrel/contracts";

import { TEST_OPERATOR_CREDENTIALS } from "./support/compose.js";
import {
  createFeaturePublicationJourney,
  processMergeFixture,
  processPublicationFixture,
  publishConceptualReviewFixture,
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

test.describe("explicit reviewed Feature merge", () => {
  let journey: FeaturePublicationJourney;
  let featureId: string;
  let closeJourney: (() => Promise<void>) | undefined;

  test.beforeAll(async () => {
    journey = await createFeaturePublicationJourney();
    closeJourney = () => journey.close();
    featureId = await journey.approvePublication("Merge a reviewed Feature from Kestrel");
    const { finalRunId } = await journey.implement(featureId);
    await journey.certify(featureId, finalRunId);
    await processPublicationFixture(journey.stack, featureId);
    await publishConceptualReviewFixture(
      journey.stack,
      { projectId: journey.projectId, featureId },
      completeReview(),
    );
  });

  test.afterAll(async () => {
    await closeJourney?.();
  });

  test("approves the exact head and shows provider and issue completion", async ({
    page,
  }, testInfo) => {
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (
        ["error", "warning"].includes(message.type()) &&
        message.text() !==
          "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
      )
        browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await page.goto(journey.stack.pwaUrl);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password", { exact: true }).fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("region", { name: "Sign in to Kestrel" })).toHaveCount(0);
    await page.goto(
      `${journey.stack.pwaUrl}/projects/${journey.projectId}/features/${featureId}?view=review`,
    );

    const panel = page.getByRole("region", {
      name: "Approve reviewed Feature merge",
      exact: true,
    });
    await expect(panel.getByText("Approve exact reviewed head", { exact: true })).toBeVisible();
    await expect(panel.getByText("All final checks are linked", { exact: true })).toBeVisible();
    const approve = panel.getByRole("button", { name: /Approve and merge PR #/u });
    await expect(approve).toBeDisabled();
    const acknowledgement = panel.getByRole("checkbox", {
      name: "Confirm review and exact-head merge",
      exact: true,
    });
    await acknowledgement.focus();
    await acknowledgement.press("Space");
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(
      panel.getByText(
        "Approval is durable. Kestrel is about to reread the pull request and required checks.",
        { exact: true },
      ),
    ).toBeVisible();

    const completed = await processMergeFixture(journey.stack, featureId);
    expect(completed.merge?.state).toBe("completed");
    await expect(panel.getByText("PR merged", { exact: true })).toBeVisible();
    await expect(
      panel.getByText(
        "The PR is merged, linked issues are closed, and the project queue is released.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(panel.getByRole("list", { name: "Linked issue closure results" })).toContainText(
      "closed",
    );
    await expect(
      page.getByText("Completed · The Feature is merged and its project queue is released.", {
        exact: true,
      }),
    ).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .include('[aria-label="Approve reviewed Feature merge"]')
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("feature-merge-completed-mobile.png"),
      fullPage: true,
    });
    expect(browserErrors).toEqual([]);
  });
});
