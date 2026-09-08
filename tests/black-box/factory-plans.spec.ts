import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  FeaturePlanVersionSchema,
  FeaturePlansSchema,
  KestrelIdSchema,
  type FeaturePlanDocument,
} from "@kestrel/contracts";
import { startStack, TEST_OPERATOR_CREDENTIALS, type RunningStack } from "./support/compose.js";
import { createGitFixture, type GitFixture } from "./support/git-fixture.js";

const plan: FeaturePlanDocument = {
  objective: "Find saved reports by their title.",
  scope: { includes: ["Search local report titles"], excludes: ["Search report contents"] },
  acceptance: [{ key: "R1", outcome: "An Operator can find a saved report by title." }],
  workItems: [
    {
      key: "W1",
      title: "Index report titles",
      description: "Create a local title index.",
      importedIssueId: null,
      requirementKeys: ["R1"],
      acceptance: ["The index includes every saved title."],
      dependsOn: [],
      verification: [
        { program: "npm", args: ["test", "--", "report-index"], cwd: ".", timeoutSeconds: 120 },
      ],
    },
    {
      key: "W2",
      title: "Search saved reports",
      description: "Connect title search to the report list.",
      importedIssueId: null,
      requirementKeys: ["R1"],
      acceptance: ["Matching reports remain readable after reload."],
      dependsOn: ["W1"],
      verification: [
        { program: "npm", args: ["test", "--", "report-search"], cwd: ".", timeoutSeconds: 120 },
      ],
    },
  ],
  limits: { maxConcurrentProjects: 2, maxActiveFeaturesPerProject: 1, attemptTimeoutSeconds: 1800 },
};

async function login(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
  await page.getByLabel("Password", { exact: true }).fill(TEST_OPERATOR_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function openFeature(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "Open Project", exact: true }).click();
  const repositoryDialog = page.getByRole("dialog", { name: "Open an authorized repository" });
  const repositoryId = await repositoryDialog
    .getByRole("option")
    .filter({ hasText: "kestrel" })
    .first()
    .getAttribute("value");
  if (repositoryId === null) throw new Error("The fixture has no repository identity");
  await repositoryDialog.getByLabel("Repository", { exact: true }).selectOption(repositoryId);
  await repositoryDialog.getByRole("button", { name: "Open selected Project" }).click();
  await expect(repositoryDialog).toHaveCount(0);
  await page.getByRole("button", { name: "New feature", exact: true }).click();
  const featureDialog = page.getByRole("dialog", { name: "New feature", exact: true });
  await featureDialog.getByLabel("Feature name", { exact: true }).fill(title);
  await featureDialog.getByRole("button", { name: "Create feature", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

async function seedPlan(page: Page): Promise<string> {
  const endpoint = `/api/v1${new URL(page.url()).pathname}/plans`;
  const saved = await page.evaluate(
    async ({ endpoint, plan }) => {
      const csrf = document.cookie
        .split("; ")
        .find((cookie) => cookie.startsWith("__Host-kestrel-csrf="))
        ?.split("=")[1];
      if (csrf === undefined) throw new Error("The authenticated browser has no CSRF token");
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Kestrel-CSRF": csrf },
        body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: null, plan }),
      });
      if (response.status !== 201) throw new Error(`Plan seed failed: ${await response.text()}`);
      return response.json() as Promise<unknown>;
    },
    { endpoint, plan },
  );
  expect(FeaturePlanVersionSchema.parse(saved).version).toBe(1);
  await page.getByRole("button", { name: "Load latest version", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Plan · version 1", exact: true })).toBeVisible();
  return endpoint;
}

test.describe("Feature plan approval", () => {
  let stack: RunningStack | undefined;
  let fixture: GitFixture | undefined;
  test.beforeAll(async () => {
    fixture = await createGitFixture();
    stack = await startStack({ repositoryRoot: fixture.rootPath });
    await stack.bootstrapOperator(TEST_OPERATOR_CREDENTIALS);
  });
  test.afterAll(async () => {
    await stack?.close();
    await fixture?.close();
  });

  test("edits normal plan fields, rejects stale approval, and retains the approved board", async ({
    page,
  }) => {
    if (stack === undefined) throw new Error("The planning stack is unavailable");
    await login(page, stack.pwaUrl);
    await openFeature(page, "Find a saved report");
    await expect(page.getByRole("tab", { name: "Plan", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Plan", exact: true }).click();
    const planUrl = page.url();
    expect(new URL(planUrl).searchParams.get("view")).toBe("plan");
    await seedPlan(page);
    await page.getByRole("button", { name: "Edit draft", exact: true }).click();
    await page
      .getByLabel("Objective", { exact: true })
      .fill("Find saved reports by a case-insensitive title search.");
    await page.getByLabel("Attempt limit (minutes)", { exact: true }).fill("20");
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    await page.getByRole("tab", { name: "Plan", exact: true }).click();
    await expect(page.getByLabel("Objective", { exact: true })).toHaveValue(
      "Find saved reports by a case-insensitive title search.",
    );
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(planUrl);
    await page.getByRole("button", { name: "Save new version", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Plan · version 2", exact: true }),
    ).toBeVisible();
    const stalePage = await page.context().newPage();
    await stalePage.goto(planUrl);
    await expect(
      stalePage.getByRole("button", { name: "Approve version 2", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Edit draft", exact: true }).click();
    await page
      .getByLabel("Objective", { exact: true })
      .fill("Find saved reports by a case-insensitive title search, including archived reports.");
    await page.getByRole("button", { name: "Save new version", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Plan · version 3", exact: true }),
    ).toBeVisible();
    await stalePage.getByRole("button", { name: "Approve version 2", exact: true }).click();
    await expect(stalePage.getByRole("alert")).toBeVisible();
    await expect(stalePage.getByRole("tab", { name: "Plan", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await stalePage.getByRole("button", { name: "Load latest version", exact: true }).click();
    await expect(
      stalePage.getByRole("heading", { name: "Plan · version 3", exact: true }),
    ).toBeVisible();
    const routeParts = new URL(planUrl).pathname.split("/");
    const projectId = KestrelIdSchema.parse(routeParts[2]);
    const featureId = KestrelIdSchema.parse(routeParts[4]);
    const aliasProjectId = "018f0f89-949a-75a8-8f61-6df78a843b20";
    await stack.executeSql(`INSERT INTO projects (id, installation_id, canonical_project_id)
      SELECT '${aliasProjectId}', installation_id, id FROM projects WHERE id = '${projectId}';`);
    await stalePage.goto(
      `${stack.pwaUrl}/projects/${aliasProjectId}/features/${featureId}?view=plan`,
    );
    await expect(stalePage).toHaveURL(planUrl);
    await expect(stalePage.getByRole("tab", { name: "Plan", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      stalePage.getByRole("heading", { name: "Plan · version 3", exact: true }),
    ).toBeVisible();
    await stalePage.screenshot({
      path: test.info().outputPath("factory-plan-desktop.png"),
      fullPage: true,
      animations: "disabled",
    });
    expect((await new AxeBuilder({ page: stalePage }).analyze()).violations).toEqual([]);
    await stalePage.setViewportSize({ width: 375, height: 812 });
    await stalePage.screenshot({
      path: test.info().outputPath("factory-plan-narrow.png"),
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await stalePage.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page: stalePage }).analyze()).violations).toEqual([]);
    await stalePage.setViewportSize({ width: 1024, height: 800 });
    await stalePage.getByRole("button", { name: "Approve version 3", exact: true }).click();
    await expect(stalePage.getByRole("tab", { name: "Board", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await stalePage.reload();
    for (const label of ["To do", "In progress", "In review", "Completed"]) {
      await expect(stalePage.getByRole("region", { name: label, exact: true })).toBeVisible();
    }
    await expect(
      stalePage.getByRole("region", { name: "Feature execution", exact: true }),
    ).toBeVisible();
    await stalePage.getByRole("button", { name: "2. Search saved reports", exact: true }).click();
    const item = stalePage.getByRole("dialog", { name: "Search saved reports", exact: true });
    await expect(
      item.getByText("Matching reports remain readable after reload.", { exact: true }),
    ).toBeVisible();
    await expect(item.getByText("W1", { exact: true })).toBeVisible();
    await expect(item.getByText("R1", { exact: true })).toBeVisible();
    await stalePage.keyboard.press("Escape");
    await expect(item).toHaveCount(0);
    await expect(
      stalePage.getByRole("button", { name: "2. Search saved reports", exact: true }),
    ).toBeFocused();
    await stalePage.screenshot({
      path: test.info().outputPath("factory-board-desktop.png"),
      animations: "disabled",
    });
    expect((await new AxeBuilder({ page: stalePage }).analyze()).violations).toEqual([]);
    await stalePage.setViewportSize({ width: 375, height: 812 });
    await stalePage.screenshot({
      path: test.info().outputPath("factory-board-narrow.png"),
      animations: "disabled",
    });
    expect(
      await stalePage.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page: stalePage }).analyze()).violations).toEqual([]);
    await stalePage.getByRole("tab", { name: "Plan", exact: true }).click();
    await stalePage.getByRole("button", { name: "Plan Markdown", exact: true }).click();
    await expect(
      stalePage.getByRole("dialog", { name: "Plan Markdown · version 3", exact: true }),
    ).toContainText("including archived reports");
    await stalePage.keyboard.press("Escape");
    await stalePage.getByRole("button", { name: "Cancel feature", exact: true }).click();
    await stalePage
      .getByRole("dialog", { name: "Cancel this feature?", exact: true })
      .getByRole("button", { name: "Cancel feature", exact: true })
      .click();
    await expect(stalePage.getByText("This feature is cancelled.", { exact: true })).toBeVisible();
    await stalePage.getByRole("tab", { name: "Chat", exact: true }).click();
    await expect(stalePage.getByLabel("Message", { exact: true })).toBeDisabled();
    await stalePage.close();
  });

  test("retains a failed plan generation through reload and an explicit retry", async ({
    page,
  }) => {
    if (stack === undefined) throw new Error("The planning stack is unavailable");
    await login(page, stack.pwaUrl);
    await openFeature(page, "Define a report export plan");
    await page.getByRole("tab", { name: "Plan", exact: true }).click();
    const endpoint = `/api/v1${new URL(page.url()).pathname}/plans`;
    await page.getByRole("button", { name: "Generate plan", exact: true }).click();
    await expect(page.getByText("Codex is unavailable", { exact: true })).toBeVisible();
    const readPlans = async () =>
      FeaturePlansSchema.parse(
        await page.evaluate(async (path) => {
          const response = await fetch(path, { headers: { Accept: "application/json" } });
          return response.json() as Promise<unknown>;
        }, endpoint),
      );
    const failed = await readPlans();
    expect(failed.generation?.state).toBe("failed");
    expect(failed.current).toBeNull();
    await page.reload();
    await expect(page.getByText("Codex is unavailable", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Retry generation", exact: true }).click();
    await expect
      .poll(async () => (await readPlans()).generation?.id)
      .not.toBe(failed.generation?.id);
    await expect(page.getByText("Codex is unavailable", { exact: true })).toBeVisible();
    expect((await readPlans()).current).toBeNull();
    await expect(page.getByRole("button", { name: /^Approve version/u })).toHaveCount(0);
  });

  test("preserves unsaved edits and an uncertain save through reconnection, then clears them on sign-out", async ({
    page,
  }) => {
    if (stack === undefined) throw new Error("The planning stack is unavailable");
    await login(page, stack.pwaUrl);
    await openFeature(page, "Keep a report search draft");
    await page.getByRole("tab", { name: "Plan", exact: true }).click();
    const endpoint = await seedPlan(page);
    await page.getByRole("button", { name: "Edit draft", exact: true }).click();
    const objective = page.getByLabel("Objective", { exact: true });
    const draftObjective = "Keep title search edits while the workstation reconnects.";
    await objective.fill(draftObjective);
    await page.context().setOffline(true);
    await expect(
      page.getByRole("button", { name: "Save new version", exact: true }),
    ).toBeDisabled();
    await page.context().setOffline(false);
    await expect(objective).toHaveValue(draftObjective);
    await expect(page.getByRole("button", { name: "Save new version", exact: true })).toBeEnabled();

    const saveRequests: string[] = [];
    await page.route(`**${endpoint}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postData();
      if (body === null) throw new Error("The plan command has no body");
      saveRequests.push(body);
      if (saveRequests.length !== 1) return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort("connectionfailed");
    });
    await page.getByRole("button", { name: "Save new version", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry request", exact: true })).toBeVisible();
    await page.context().setOffline(true);
    await expect(page.getByRole("button", { name: "Retry request", exact: true })).toBeDisabled();
    await page.route("**/api/v1/session", (route) => route.abort("connectionfailed"), { times: 1 });
    await page.context().setOffline(false);
    await expect(
      page.getByRole("button", { name: "Retry session check", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry request", exact: true }),
    ).not.toBeVisible();
    await page.getByRole("button", { name: "Retry session check", exact: true }).click();
    await expect(objective).toHaveValue(draftObjective);
    await page.getByRole("button", { name: "Retry request", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Plan · version 2", exact: true }),
    ).toBeVisible();
    expect(saveRequests).toHaveLength(2);
    expect(saveRequests[1]).toBe(saveRequests[0]);
    const saved = FeaturePlansSchema.parse(
      await page.evaluate(async (path) => {
        const response = await fetch(path);
        return response.json() as Promise<unknown>;
      }, endpoint),
    );
    expect(saved.versions).toHaveLength(2);

    await page.getByRole("button", { name: "Edit draft", exact: true }).click();
    await objective.fill("This private draft must disappear when the session ends.");
    await page.getByRole("button", { name: "Project documents", exact: true }).click();
    const privateDialog = page.getByRole("dialog", { name: "Project documents", exact: true });
    await expect(privateDialog).toBeVisible();
    const signedOut = await page.evaluate(async () => {
      const csrf = document.cookie
        .split("; ")
        .find((cookie) => cookie.startsWith("__Host-kestrel-csrf="))
        ?.split("=")[1];
      if (csrf === undefined) throw new Error("The authenticated browser has no CSRF token");
      return (
        await fetch("/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Kestrel-CSRF": csrf },
          body: "{}",
        })
      ).status;
    });
    expect(signedOut).toBe(204);
    await page.context().setOffline(true);
    await page.context().setOffline(false);
    await expect(
      page.getByRole("heading", { name: "Sign in to Kestrel", exact: true }),
    ).toBeVisible();
    await expect(objective).toHaveCount(0);
    await expect(privateDialog).toHaveCount(0);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password", { exact: true }).fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Plan · version 2", exact: true }),
    ).toBeVisible();
    await expect(objective).toHaveCount(0);
    await expect(page.getByText(draftObjective, { exact: true })).toBeVisible();
  });

  test("preserves Forward history when leaving a dirty plan with Back is cancelled", async ({
    page,
  }) => {
    if (stack === undefined) throw new Error("The planning stack is unavailable");
    await login(page, stack.pwaUrl);
    const title = "Keep report planning history";
    await openFeature(page, title);
    await page.getByRole("tab", { name: "Plan", exact: true }).click();
    await seedPlan(page);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    const settingsUrl = page.url();
    await page.getByRole("link", { name: title, exact: true }).click();
    const chatUrl = page.url();
    await page.getByRole("tab", { name: "Plan", exact: true }).click();
    const planUrl = page.url();
    await page.getByRole("button", { name: "Edit draft", exact: true }).click();
    await page
      .getByLabel("Objective", { exact: true })
      .fill("Retain this draft across browser history.");
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    const boardUrl = page.url();
    await page.goBack();
    await expect(page).toHaveURL(chatUrl);
    await page.goBack();
    await expect(page).toHaveURL(planUrl);
    const discardPrompt = page.waitForEvent("dialog");
    await page.evaluate(() => window.history.go(-2));
    const prompt = await discardPrompt;
    expect(prompt.message()).toBe("Discard unsaved plan edits and leave this feature?");
    await prompt.dismiss();
    await expect(page).toHaveURL(planUrl);
    await expect(page.getByLabel("Objective", { exact: true })).toHaveValue(
      "Retain this draft across browser history.",
    );
    await page.goForward();
    await expect(page).toHaveURL(chatUrl);
    await page.goForward();
    await expect(page).toHaveURL(boardUrl);
    const acceptedDiscardPrompt = page.waitForEvent("dialog");
    await page.evaluate(() => window.history.go(-4));
    await (await acceptedDiscardPrompt).accept();
    await expect(page).toHaveURL(settingsUrl);
    await page.getByRole("link", { name: title, exact: true }).click();
    await page.getByRole("tab", { name: "Plan", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Plan · version 1", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Objective", { exact: true })).toHaveCount(0);
  });

  test("suspends document dialogs and the mobile drawer while retaining a private draft", async ({
    page,
  }) => {
    if (stack === undefined) throw new Error("The planning stack is unavailable");
    await login(page, stack.pwaUrl);
    await openFeature(page, "Keep a draft behind its document inspector");
    await page.getByRole("tab", { name: "Plan", exact: true }).click();
    await seedPlan(page);

    const reconnectWithDialog = async (name: string) => {
      const dialog = page.getByRole("dialog", { name, exact: true });
      await expect(dialog).toBeVisible();
      await page.context().setOffline(true);
      await page.route("**/api/v1/session", (route) => route.abort("connectionfailed"), {
        times: 1,
      });
      await page.context().setOffline(false);
      await expect(page.getByText("Session check unavailable", { exact: true })).toBeVisible();
      await expect(dialog).toHaveCount(0);
      const retry = page.getByRole("button", { name: "Retry session check", exact: true });
      await retry.focus();
      await expect(retry).toBeFocused();
      if (name === "Workspace navigation")
        await page.screenshot({
          path: test.info().outputPath("session-retry-mobile.png"),
          animations: "disabled",
        });
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    };

    await page.getByRole("button", { name: "Plan Markdown", exact: true }).click();
    await reconnectWithDialog("Plan Markdown · version 1");
    await page.getByRole("button", { name: "Edit draft", exact: true }).click();
    const draftObjective = "Retain edits while checking access to the document inspector.";
    await page.getByLabel("Objective", { exact: true }).fill(draftObjective);
    await page.getByRole("button", { name: "Project documents", exact: true }).click();
    await reconnectWithDialog("Project documents");
    await expect(page.getByLabel("Objective", { exact: true })).toHaveValue(draftObjective);

    await page.setViewportSize({ width: 375, height: 812 });
    const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
    await navigation.click();
    await reconnectWithDialog("Workspace navigation");
    await expect(navigation).toBeFocused();
    await expect(page.getByLabel("Objective", { exact: true })).toHaveValue(draftObjective);
  });
});
