import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  FactoryReviewCorrectionCurrentSchema,
  type FactoryConceptualReviewDraft,
} from "@kestrel/contracts";

import { TEST_OPERATOR_CREDENTIALS } from "./support/compose.js";
import {
  createFeaturePublicationJourney,
  processPublicationFixture,
  publishConceptualReviewFixture,
  type FeaturePublicationJourney,
} from "./support/factory-feature-publication-journey.js";

const findingId = "finding:clarify-result";
const findingTitle = "The result has no correction marker";

function correctionReviewGraph(): FactoryConceptualReviewDraft {
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
    result: "partial",
    summary: "The approved outcomes are present, with one bounded implementation defect.",
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
    problems: [
      {
        id: findingId,
        type: "finding",
        title: findingTitle,
        condition: "An operator inspects the selected implementation path.",
        consequence: "The reviewed technical correction is not explicit in source.",
        reasoning: "The exact reviewed line contains only the two exported values.",
        evidenceIds: [evidenceId],
        riskLevel: "low",
        sufficiency: "The retained source line shows the missing marker.",
        limitations: ["This finding does not change an approved behavior."],
      },
    ],
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
      { from: evidenceId, to: findingId, kind: "reveals" },
    ],
    limitations: [],
  };
}

test.describe("bounded correction from the current Conceptual Review", () => {
  let journey: FeaturePublicationJourney;
  let featureId: string;
  let closeJourney: (() => Promise<void>) | undefined;

  test.beforeAll(async () => {
    journey = await createFeaturePublicationJourney();
    closeJourney = () => journey.close();
    featureId = await journey.approvePublication("Correct one reviewed defect from the browser");
    const { finalRunId } = await journey.implement(featureId);
    await journey.certify(featureId, finalRunId);
    await processPublicationFixture(journey.stack, featureId);
    await publishConceptualReviewFixture(
      journey.stack,
      { projectId: journey.projectId, featureId },
      correctionReviewGraph(),
    );
  });

  test.afterAll(async () => {
    await closeJourney?.();
  });

  test("selects explicit authority, starts durably, and restores it after refresh", async ({
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

    const panel = page.getByRole("region", { name: "Request review correction", exact: true });
    await expect(panel.getByText("Request a bounded correction", { exact: true })).toBeVisible();
    const finding = panel.getByRole("checkbox", {
      name: `Include finding: ${findingTitle}`,
      exact: true,
    });
    await finding.focus();
    await finding.press("Space");
    await expect(finding).toHaveAttribute("data-state", "checked");
    await panel
      .getByLabel("Correction request", { exact: true })
      .fill("Add the reviewed correction marker without changing approved behavior.");
    const apply = panel.getByRole("button", {
      name: "Apply correction and review again",
      exact: true,
    });
    await apply.focus();
    await apply.press("Enter");

    await expect(panel.locator('[data-correction-state="executing"]')).toBeVisible();
    await expect(
      panel.getByText(
        "Applying only the correction you authorized, then running every approved check.",
        { exact: true },
      ),
    ).toBeVisible();
    const persisted = FactoryReviewCorrectionCurrentSchema.parse(
      await (
        await journey.stack.fetchApi(`${journey.path(featureId)}/review/corrections/current`)
      ).json(),
    );
    expect(persisted.correction).toMatchObject({
      state: "executing",
      instruction: "Add the reviewed correction marker without changing approved behavior.",
      findings: [{ id: findingId, title: findingTitle, riskLevel: "low" }],
    });

    await page.reload();
    await expect(panel.locator('[data-correction-state="executing"]')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).include('[aria-label="Request review correction"]').analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("review-correction-mobile.png"),
      fullPage: true,
    });
    expect(browserErrors).toEqual([]);
  });
});
