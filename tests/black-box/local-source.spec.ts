import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

import { startStack, TEST_OPERATOR_CREDENTIALS, type RunningStack } from "./support/compose.js";
import { createGitFixture, type GitFixture } from "./support/git-fixture.js";

async function holdNextInventoryResponse(page: Page): Promise<{
  completed: Promise<void>;
  handler: (route: Route) => Promise<void>;
  observed: Promise<void>;
  release(): void;
}> {
  let markObserved: () => void = () => undefined;
  const observed = new Promise<void>((resolve) => {
    markObserved = resolve;
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markCompleted: () => void = () => undefined;
  const completed = new Promise<void>((resolve) => {
    markCompleted = resolve;
  });
  const handler = async (route: Route) => {
    const response = await route.fetch();
    markObserved();
    await gate;
    await route.fulfill({ response });
    markCompleted();
  };
  await page.route("**/api/v1/local-repository-sources", handler);
  return { completed, handler, observed, release };
}

test.describe("local-first Project flow", () => {
  let fixture: GitFixture | undefined;
  let stack: RunningStack | undefined;

  test.beforeAll(async () => {
    fixture = await createGitFixture();
    stack = await startStack({ repositoryRoot: fixture.rootPath });
    await stack.bootstrapOperator(TEST_OPERATOR_CREDENTIALS);
  });

  test.afterAll(async () => {
    if (stack !== undefined) await stack.close();
    if (fixture !== undefined) await fixture.close();
  });

  test("the Operator retains an exact local revision without a page reload", async ({ page }) => {
    if (stack === undefined || fixture === undefined) {
      throw new Error("Local-source browser fixture is unavailable");
    }
    await page.goto(stack.pwaUrl);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password").fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Kestrel Installation" })).toBeVisible();
    const repositorySettings = page.getByRole("region", { name: "Settings" });
    await expect(
      repositorySettings.getByRole("heading", { name: "Repository access" }),
    ).toBeVisible();
    await expect(repositorySettings.getByText("kestrel", { exact: true })).toBeVisible();
    await expect(repositorySettings.locator("code").first()).toHaveText(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    await repositorySettings.getByRole("button", { name: "Refresh repositories" }).click();
    await expect(repositorySettings.getByText("kestrel", { exact: true })).toBeVisible();

    const localTrigger = page.getByRole("button", { name: "Open local repository" });
    const publicInput = page.getByLabel("Optional public GitHub pull request URL");
    await expect(localTrigger).toBeVisible();
    await expect(publicInput).toBeVisible();
    expect(
      await localTrigger.evaluate((trigger) => {
        const input = document.querySelector('input[type="url"]');
        return (
          input !== null &&
          Boolean(trigger.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING)
        );
      }),
    ).toBe(true);

    const staleInventory = await holdNextInventoryResponse(page);
    await localTrigger.click();
    await staleInventory.observed;
    const dialog = page.getByRole("dialog", { name: "Retain an exact change" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    staleInventory.release();
    await staleInventory.completed;
    await page.unroute("**/api/v1/local-repository-sources", staleInventory.handler);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );

    const freshInventory = await holdNextInventoryResponse(page);
    await localTrigger.focus();
    await page.keyboard.press("Enter");
    await freshInventory.observed;
    await expect(
      page.getByLabel("Repository").getByRole("option", { name: "kestrel" }),
    ).toHaveCount(0);
    freshInventory.release();
    await freshInventory.completed;
    await page.unroute("**/api/v1/local-repository-sources", freshInventory.handler);
    await expect(page.getByRole("heading", { name: "Retain an exact change" })).toBeFocused();
    await expect(dialog.getByText("No authorized local repositories are available.")).toHaveCount(
      0,
    );
    await page.getByLabel("Repository").selectOption({ label: "kestrel" });
    await expect(page.getByLabel("Base reference")).toBeEnabled();
    await page.getByLabel("Base reference").selectOption({ label: "main" });
    await page.getByLabel("Head reference").selectOption({ label: "review-source" });
    await expect(page.getByLabel("Change Intent")).toHaveValue("");
    await expect(dialog.getByRole("heading", { name: "Suggestions from commits" })).toBeVisible();
    await page
      .getByLabel("Change Intent")
      .fill("Review the exact committed authorization boundary");
    await expect(dialog.getByText(fixture.baseObjectId, { exact: true })).toBeVisible();
    await expect(dialog.getByText(fixture.headObjectId, { exact: true })).toBeVisible();
    let markRequestObserved: () => void = () => undefined;
    const requestObserved = new Promise<void>((resolve) => {
      markRequestObserved = resolve;
    });
    let releaseFailure: () => void = () => undefined;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const failRetention = async (route: Route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      markRequestObserved();
      await failureGate;
      await route.fulfill({
        contentType: "application/json",
        json: {
          schemaVersion: 1,
          code: "SERVICE_UNAVAILABLE",
          message: "Retention is temporarily unavailable.",
          correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
        },
        status: 503,
      });
    };
    await page.route("**/api/v1/review-revisions", failRetention);
    const retainButton = page.getByRole("button", { name: "Retain Review Revision" });
    await retainButton.click();
    await requestObserved;
    await expect(page.getByRole("button", { name: "Retaining…" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
    await expect(page.getByLabel("Repository")).toBeDisabled();
    await expect(page.getByLabel("Base reference")).toBeDisabled();
    await expect(page.getByLabel("Head reference")).toBeDisabled();
    await expect(page.getByLabel("Change Intent")).toBeDisabled();
    await expect(page.getByLabel("Change Intent")).toHaveValue(
      "Review the exact committed authorization boundary",
    );
    releaseFailure();
    await expect(dialog.getByRole("alert")).toContainText(
      "Retention is temporarily unavailable. Reference: 0c14b018-0260-4aa0-a5e9-61d212b948ce",
    );
    await expect(retainButton).toBeEnabled();
    await expect(page.getByLabel("Change Intent")).toHaveValue(
      "Review the exact committed authorization boundary",
    );
    await page.unroute("**/api/v1/review-revisions", failRetention);
    await retainButton.click();

    await expect(dialog).toHaveCount(0);
    await expect(localTrigger).toBeFocused();
    await expect(page.getByRole("status")).toContainText("The exact Review Revision is available.");
    await expect(page.getByText("Available", { exact: true })).toHaveCount(2);
    await expect(
      page.locator("dl.commit-pointer-list").getByText("Change Intent v1", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator("dl.commit-pointer-list")
        .getByRole("definition")
        .filter({ hasText: "Review the exact committed authorization boundary" }),
    ).toBeVisible();
    await expect(page.getByText("Not observed", { exact: true })).toBeVisible();
    await expect(page.getByText("Not configured", { exact: true })).toBeVisible();

    const overview = page.getByRole("region", { name: "Change Overview" });
    await expect(overview.getByText("Ready", { exact: true })).toBeVisible();
    await expect(
      overview.getByText("Deterministic facts with optional source-linked model wording", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      overview.getByLabel(`Change Overview exact head object ID ${fixture.headObjectId}`),
    ).toBeVisible();
    await expect(
      overview.getByText("1 changed file · 0 added · 1 modified · 0 deleted"),
    ).toBeVisible();
    await expect(overview.getByText("Base snapshot · 3 files", { exact: true })).toBeVisible();
    await expect(overview.getByText("Head snapshot · 3 files", { exact: true })).toBeVisible();
    await expect(overview.getByText("review.txt", { exact: true })).toBeVisible();
    await expect(overview.getByRole("heading", { name: "Source areas" })).toBeVisible();
    await expect(overview.getByText("Repository root", { exact: true })).toBeVisible();
    await expect(
      overview.getByRole("heading", { name: "Natural-language orientation" }),
    ).toBeVisible();
    await expect(
      overview.getByText("No available model profile was configured for this source."),
    ).toBeVisible();
    await expect(overview.getByText("review.txt", { exact: true })).toBeVisible();
    await expect(overview).not.toContainText("Operator Attention");
    await expect(overview).not.toContainText(/Graph|Evidence|Coverage|Finding|Risk|Verdict/u);

    const preparation = page.getByRole("region", { name: "Review preparation" });
    await preparation.getByRole("button", { name: "Prepare Review" }).click();
    await expect(preparation.getByText(fixture.baseObjectId, { exact: true })).toBeVisible();
    await expect(preparation.getByText(fixture.headObjectId, { exact: true })).toBeVisible();
    await expect(preparation.getByText("Change Intent v1", { exact: true })).toBeVisible();
    await expect(preparation.getByText("Change Intent is not resolved.")).toBeVisible();
    await expect(preparation.getByText("Model route is not available.")).toBeVisible();
    await expect(preparation.getByText("Resource Envelope is not available.")).toBeVisible();
    await expect(preparation.getByRole("button", { name: "Start Review" })).toBeDisabled();
    await stack.executeSql(`
      DO $$
      BEGIN
        IF (SELECT count(*) FROM review_workflows) <> 0 THEN
          RAISE EXCEPTION 'Review preparation created a workflow';
        END IF;
      END;
      $$;
    `);

    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations).toEqual([]);
    for (const viewport of [
      { width: 375, height: 812 },
      { width: 1_280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    }
  });

  test("repository setup explains every inventory state without exposing a path control", async ({
    page,
  }) => {
    if (stack === undefined) {
      throw new Error("Local-source browser fixture is unavailable");
    }
    await page.goto(stack.pwaUrl);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password").fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Kestrel Installation" })).toBeVisible();

    const inventoryUrl = "**/api/v1/local-repository-sources";
    const trigger = page.getByRole("button", { name: "Open local repository" });
    await expect(trigger).toBeEnabled();
    const trustedHostCommand =
      "npm run authorize-repository-root -- /absolute/path/to/authorized-parent";
    const assertGuidedState = async (title: string) => {
      const dialog = page.getByRole("dialog", { name: "Retain an exact change" });
      await expect(dialog.getByRole("heading", { name: title })).toBeVisible();
      await expect(dialog.getByText(trustedHostCommand, { exact: true })).toBeVisible();
      await expect(dialog.locator("form")).toBeHidden();
      await expect(dialog.locator('input[type="text"], input[type="file"]')).toHaveCount(0);
      const accessibility = await new AxeBuilder({ page })
        .include(".local-repository-dialog")
        .analyze();
      expect(accessibility.violations).toEqual([]);
    };

    const loading = await holdNextInventoryResponse(page);
    await trigger.focus();
    await page.keyboard.press("Enter");
    await loading.observed;
    await assertGuidedState("Checking repository setup");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    loading.release();
    await loading.completed;
    await page.unroute(inventoryUrl, loading.handler);

    const verifyInventoryState = async (
      inventoryState: "no_configured_roots" | "no_repositories_found",
      title: string,
    ) => {
      const handler = async (route: Route) => {
        await route.fulfill({
          contentType: "application/json",
          json: { schemaVersion: 1, inventoryState, repositories: [] },
          status: 200,
        });
      };
      await page.route(inventoryUrl, handler);
      await trigger.click();
      await assertGuidedState(title);
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
      await page.unroute(inventoryUrl, handler);
    };

    await verifyInventoryState("no_configured_roots", "No repository roots are configured");
    await verifyInventoryState("no_repositories_found", "No Git repositories were found");

    const failDiscovery = async (route: Route) => {
      await route.fulfill({
        contentType: "application/json",
        json: {
          schemaVersion: 1,
          code: "SERVICE_UNAVAILABLE",
          message: "Local repository discovery is unavailable",
          correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
        },
        status: 503,
      });
    };
    await page.route(inventoryUrl, failDiscovery);
    await trigger.click();
    await assertGuidedState("Repository discovery failed");
    await expect(page.getByRole("dialog")).toContainText(
      "Reference: 0c14b018-0260-4aa0-a5e9-61d212b948ce",
    );
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await page.unroute(inventoryUrl, failDiscovery);

    await trigger.click();
    await expect(page.getByLabel("Repository")).toBeVisible();
    await expect(
      page.getByLabel("Repository").getByRole("option", { name: "kestrel" }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("dialog").getByText(trustedHostCommand, { exact: true }),
    ).toHaveCount(0);
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

    await page.setViewportSize({ width: 320, height: 800 });
    await verifyInventoryState("no_configured_roots", "No repository roots are configured");
    const width = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.client);
  });
});
