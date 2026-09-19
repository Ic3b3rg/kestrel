import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { FactoryFeaturePublication } from "@kestrel/contracts";
import { TEST_OPERATOR_CREDENTIALS } from "./support/compose.js";
import {
  createFeaturePublicationJourney,
  processPublicationFixture,
  type FeaturePublicationJourney,
} from "./support/factory-feature-publication-journey.js";

test.describe("certified Feature PR and Conceptual Review entry", () => {
  let journey: FeaturePublicationJourney;
  let featureId: string;
  let publication: FactoryFeaturePublication;
  let closeJourney: (() => Promise<void>) | undefined;

  test.beforeAll(async () => {
    journey = await createFeaturePublicationJourney();
    closeJourney = () => journey.close();
    featureId = await journey.approvePublication("Publish the certified Feature");
    const { finalRunId } = await journey.implement(featureId);
    await journey.certify(featureId, finalRunId);
    await processPublicationFixture(journey.stack, featureId);
    publication = await journey.publication(featureId);
    if (publication.state !== "published" || publication.review === null)
      throw new Error("Browser fixture did not publish an exact retained Feature revision");
  });

  test.afterAll(async () => {
    await closeJourney?.();
  });

  test("opens the exact approved review basis and its retained evidence", async ({
    page,
  }, testInfo) => {
    await page.goto(journey.stack.pwaUrl);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password", { exact: true }).fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("region", { name: "Sign in to Kestrel" })).toHaveCount(0);

    await page.goto(
      `${journey.stack.pwaUrl}/projects/${journey.projectId}/features/${featureId}?view=board`,
    );
    const panel = page.getByRole("region", { name: "Feature pull request", exact: true });
    await expect(panel.getByText("Pull request published", { exact: true })).toBeVisible();
    const pullRequest = publication.pullRequest;
    const review = publication.review;
    if (pullRequest === null || review === null)
      throw new Error("Published browser fixture lost its PR or Review Revision");
    await expect(
      panel.getByRole("link", {
        name: `Pull request #${String(pullRequest.number)}`,
        exact: true,
      }),
    ).toHaveAttribute("href", pullRequest.url);
    await expect(
      panel.getByText("Work Items stay In review. Linked issues remain open.", { exact: true }),
    ).toBeVisible();
    const issueLinks = panel.getByRole("listitem").getByRole("link");
    await expect(issueLinks).toHaveCount(2);
    await expect(issueLinks.nth(0)).toContainText("order · Retain original order");
    await expect(issueLinks.nth(1)).toContainText("consumer · Add the consumer");

    const certified = panel.locator("summary").filter({ hasText: "Certified revision" });
    await certified.focus();
    await certified.press("Enter");
    await expect(panel.getByText("Version 1", { exact: true })).toBeVisible();
    await expect(panel.getByText(pullRequest.baseCommitId, { exact: true })).toBeVisible();
    await expect(panel.getByText(pullRequest.headCommitId, { exact: true })).toBeVisible();
    await expect(panel.getByText(review.revision.id, { exact: true })).toBeVisible();

    const inReview = page.getByRole("region", { name: "In review", exact: true });
    await expect(inReview.getByRole("button")).toHaveCount(2);
    await expect(page.getByRole("region", { name: "Completed", exact: true })).toContainText(
      "No Work Items",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).include('[aria-label="Feature pull request"]').analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("feature-pr-review-entry-mobile.png"),
      fullPage: true,
    });

    const open = panel.getByRole("button", { name: "Open Feature review", exact: true });
    await open.focus();
    await open.press("Enter");
    await expect(page).toHaveURL(
      `${journey.stack.pwaUrl}/projects/${journey.projectId}/features/${featureId}?view=review`,
    );
    await expect(
      page.getByRole("heading", {
        name: "Did this Feature deliver what you approved?",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Preserve stable ordering while adding its consumer",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Equal values retain their original order", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(pullRequest.headCommitId, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start review", exact: true })).toBeDisabled();
    await expect(page.getByText(/bounded review runner is not available yet/u)).toBeVisible();

    const source = page.getByRole("region", { name: "Retained source inspector", exact: true });
    const browse = source.getByRole("button", { name: "Browse head source", exact: true });
    await browse.focus();
    await browse.press("Enter");
    const valueSource = source.getByRole("button", { name: "value.mjs", exact: true });
    await valueSource.focus();
    await valueSource.press("Enter");
    await expect(source.getByText(/consumer = 2/u)).toBeVisible();

    const checks = page.getByRole("region", {
      name: "Final verification inspector",
      exact: true,
    });
    await checks.getByRole("button", { name: "Inspect final checks", exact: true }).click();
    await expect(checks.getByText("node --test order.test.mjs", { exact: true })).toBeVisible();
    await checks.getByRole("button", { name: "Open result", exact: true }).first().click();
    await expect(checks.getByText(/pass/u).first()).toBeVisible();

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).include(".feature-tabs").analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({
      path: testInfo.outputPath("feature-conceptual-review-mobile.png"),
      fullPage: true,
    });
  });
});
