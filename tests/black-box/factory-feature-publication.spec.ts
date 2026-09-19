import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  FactoryConceptualReviewPreparationSchema,
  type FactoryConceptualReviewDraft,
  type FactoryConceptualReviewWorkflowRead,
  type FactoryFeaturePublication,
} from "@kestrel/contracts";
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

  test("starts durably and explores a Partial outcome-to-finding graph with the keyboard", async ({
    page,
  }, testInfo) => {
    const reviewRoot = `${journey.path(featureId)}/review`;
    const preparedResponse = await journey.stack.fetchApi(`${reviewRoot}/preparation`);
    expect(preparedResponse.status).toBe(200);
    const blocked = FactoryConceptualReviewPreparationSchema.parse(await preparedResponse.json());
    const inputDigest = "f".repeat(64);
    const preparation = FactoryConceptualReviewPreparationSchema.parse({
      ...blocked,
      preparationDigest: inputDigest,
      configuration: {
        ...blocked.configuration,
        model: { ...blocked.configuration.model, modelId: "gpt-6-astra" },
        runtimePolicy: {
          ...blocked.configuration.runtimePolicy,
          containerImage: `sha256:${"1".repeat(64)}`,
          containerUser: "501:20",
          codexExecutable: "/usr/local/bin/codex",
          codexExecutableDigest: "e".repeat(64),
          codexVersion: "0.155.1",
          status: "available",
        },
      },
      readiness: { state: "ready", startAllowed: true, blockers: [] },
    });
    const pullRequest = publication.pullRequest;
    const retained = publication.review;
    if (
      pullRequest === null ||
      retained === null ||
      preparation.changeProposalId === null ||
      preparation.publication === null
    )
      throw new Error("Browser review fixture lost its exact publication inputs");
    const exactPullRequest = pullRequest;
    const exactRetained = retained;
    const exactChangeProposalId = preparation.changeProposalId;

    const workflowId = "01991c36-7f90-7000-8000-000000000071";
    const artifactId = "01991c36-7f90-7000-8000-000000000072";
    const requestedAt = "2026-09-19T12:00:00.000Z";
    const graph: FactoryConceptualReviewDraft = {
      result: "partial",
      summary: "The approved behavior is mapped, with one exact-head concurrency risk.",
      outcomes:
        preparation.basis?.outcomes.map((outcome) => ({
          id: `outcome:${outcome.key}`,
          outcomeKey: outcome.key,
          title: outcome.outcome,
          coverage: "mapped" as const,
          behavioralStepIds: [`step:${outcome.key}`],
          reason: "The frozen head contains a source path for this approved outcome.",
        })) ?? [],
      behavioralSteps:
        preparation.basis?.outcomes.map((outcome, index) => ({
          id: `step:${outcome.key}`,
          title: index === 0 ? "Keep equal values in source order" : "Expose the ordered consumer",
          description:
            index === 0
              ? "The ordering path preserves the original sequence for equal values."
              : "The consumer reads the ordered result produced by the Feature.",
          change: index === 0 ? ("modified" as const) : ("added" as const),
          outcomeKeys: [outcome.key],
          evidenceIds: [index === 0 ? "source:order" : "source:consumer"],
        })) ?? [],
      evidence: [
        {
          id: "source:order",
          type: "source",
          side: "head",
          path: "value.mjs",
          startLine: 1,
          endLine: 1,
          description: "Stable ordering implementation",
          sufficiency: "The exact head line establishes the ordering path.",
          limitations: ["Executed checks are linked in the next review slice."],
        },
        {
          id: "source:consumer",
          type: "source",
          side: "head",
          path: "value.mjs",
          startLine: 1,
          endLine: 1,
          description: "Consumer result assignment",
          sufficiency: "The exact head line shows the returned consumer value.",
          limitations: ["No browser timing trace is linked."],
        },
      ],
      problems: [
        {
          id: "finding:stale-result",
          type: "finding",
          title: "Older results can replace the latest result",
          condition: "Two consumer requests finish out of order.",
          consequence: "The visible value can move back to an older result.",
          reasoning: "The exact-head assignment has no request identity guard.",
          evidenceIds: ["source:consumer"],
          riskLevel: "medium",
          sufficiency: "The unconditional assignment establishes the stale-write path.",
          limitations: ["The race was not executed in this source-only slice."],
        },
      ],
      edges: [
        ...(preparation.basis?.outcomes ?? []).map((outcome) => ({
          from: `outcome:${outcome.key}`,
          to: `step:${outcome.key}`,
          kind: "implemented_by" as const,
        })),
        ...(preparation.basis?.outcomes ?? []).map((outcome, index) => ({
          from: `step:${outcome.key}`,
          to: index === 0 ? "source:order" : "source:consumer",
          kind: "supported_by" as const,
        })),
        { from: "source:consumer", to: "finding:stale-result", kind: "reveals" },
      ],
      limitations: ["Browser interaction was not observed."],
    };
    let queued: FactoryConceptualReviewWorkflowRead | null = null;
    let published = false;
    let workflowReads = 0;
    let reviewWrites = 0;

    await page.route(`**${reviewRoot}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const relative = url.pathname.slice(reviewRoot.length);
      if (relative === "/preparation" && request.method() === "GET") {
        await route.fulfill({ json: preparation, status: 200 });
        return;
      }
      if (relative === "/workflows/current" && request.method() === "GET") {
        await route.fulfill({
          json: { schemaVersion: 1, review: published ? publishedRead() : queued },
          status: 200,
        });
        return;
      }
      if (relative === "/workflows" && request.method() === "POST") {
        reviewWrites += 1;
        const command = request.postDataJSON() as {
          requestId: string;
          preparationDigest: string;
        };
        expect(command.preparationDigest).toBe(inputDigest);
        queued = {
          schemaVersion: 1,
          workflow: {
            id: workflowId,
            requestId: command.requestId,
            projectId: journey.projectId,
            featureId,
            changeProposalId: exactChangeProposalId,
            inputDigest,
            reviewRevisionId: exactRetained.revision.id,
            state: "queued",
            attempt: { current: 0, maximum: 3 },
            failure: null,
            artifactId: null,
            requestedAt,
            startedAt: null,
            finishedAt: null,
          },
          artifact: null,
          currency: "up_to_date",
        };
        await route.fulfill({ json: queued, status: 202 });
        return;
      }
      if (relative === `/workflows/${workflowId}` && request.method() === "GET") {
        workflowReads += 1;
        if (queued === null) throw new Error("The browser polled a review it did not start");
        if (workflowReads === 1) {
          await route.fulfill({
            json: {
              ...queued,
              workflow: {
                ...queued.workflow,
                state: "running",
                attempt: { current: 1, maximum: 3 },
                startedAt: "2026-09-19T12:00:01.000Z",
              },
            },
            status: 200,
          });
          return;
        }
        published = true;
        await route.fulfill({ json: publishedRead(), status: 200 });
        return;
      }
      if (relative === `/workflows/${workflowId}/source/lines` && request.method() === "GET") {
        expect(url.searchParams.get("side")).toBe("head");
        expect(url.searchParams.get("path")).toBe("value.mjs");
        await route.fulfill({
          json: {
            status: "available",
            side: "head",
            commitId: exactPullRequest.headCommitId,
            mode: "100644",
            objectId: "e".repeat(40),
            path: "value.mjs",
            type: "blob",
            startLine: 1,
            endLine: 1,
            totalLines: 1,
            hasFinalNewline: true,
            lineEndings: ["lf"],
            text: "export const consumer = response; // unconditional assignment\n",
          },
          status: 200,
        });
        return;
      }
      await route.continue();
    });

    function publishedRead(): FactoryConceptualReviewWorkflowRead {
      if (queued === null) throw new Error("Cannot publish an unaccepted review");
      return {
        schemaVersion: 1,
        workflow: {
          ...queued.workflow,
          state: "published",
          attempt: { current: 1, maximum: 3 },
          artifactId,
          startedAt: "2026-09-19T12:00:01.000Z",
          finishedAt: "2026-09-19T12:00:03.000Z",
        },
        artifact: {
          schemaVersion: 1,
          id: artifactId,
          workflowId,
          inputDigest,
          reviewRevisionId: exactRetained.revision.id,
          baseCommitId: exactPullRequest.baseCommitId,
          headCommitId: exactPullRequest.headCommitId,
          status: "partial",
          evidenceScope: {
            source: "exact_retained_revision",
            executedChecks: "not_linked",
            narrativeAuthority: "source_only_model_interpretation",
          },
          graph,
          createdAt: "2026-09-19T12:00:03.000Z",
        },
        currency: "outdated",
      };
    }

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

    const start = page.getByRole("button", { name: "Start review", exact: true });
    await expect(start).toBeEnabled();
    await start.focus();
    await start.press("Enter");
    await expect(page.getByText("Review queued", { exact: true })).toBeVisible();
    expect(reviewWrites).toBe(1);
    await page.reload();
    await expect(page.getByText("Review queued", { exact: true })).toBeVisible();
    await expect(page.getByText("Reviewing the frozen revision", { exact: true })).toBeVisible();
    await expect(page.getByText(graph.summary, { exact: true })).toBeVisible();
    await expect(page.getByText("Outdated · PR head moved", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Older results can replace the latest result/u }).first(),
    ).toBeVisible();

    const outcome = page
      .getByRole("region", { name: "Requirements review graph", exact: true })
      .getByRole("button", { name: new RegExp(graph.outcomes[0]?.title ?? "missing", "u") });
    await outcome.focus();
    await outcome.press("Enter");
    await expect(
      page.getByText("The frozen head contains a source path", { exact: false }),
    ).toBeVisible();
    const step = page.getByRole("button", { name: /Expose the ordered consumer/u }).first();
    await step.focus();
    await step.press("Enter");
    await expect(
      page.getByText("The consumer reads the ordered result", { exact: false }),
    ).toBeVisible();
    const source = page.getByRole("button", { name: /Consumer result assignment/u }).first();
    await source.focus();
    await source.press("Enter");
    await expect(page.getByText(/unconditional assignment/u)).toBeVisible();
    const finding = page
      .getByRole("button", { name: /Older results can replace the latest result/u })
      .first();
    await finding.focus();
    await finding.press("Enter");
    await expect(page.getByText("medium risk", { exact: true })).toBeVisible();
    await expect(
      page.getByText("The visible value can move back to an older result.", { exact: true }),
    ).toBeVisible();

    const outline = page
      .locator("summary")
      .filter({ hasText: "Linked outline for keyboard review" });
    await outline.focus();
    await outline.press("Enter");
    await expect(page.getByText("implemented by", { exact: true }).first()).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).include('[aria-label="Requirements review graph"]').analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("conceptual-review-graph-mobile.png"),
      fullPage: true,
    });
    expect(reviewWrites).toBe(1);
    expect(browserErrors).toEqual([]);
  });
});
