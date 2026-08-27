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
    await expect(page.getByText("Change Intent v1", { exact: true })).toBeVisible();
    await expect(page.getByText("Review the exact committed authorization boundary")).toBeVisible();
    await expect(page.getByText("Not observed", { exact: true })).toBeVisible();
    await expect(page.getByText("Not configured", { exact: true })).toBeVisible();

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
});
