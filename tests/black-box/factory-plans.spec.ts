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
  proposedDocuments: [
    {
      key: "report-glossary",
      kind: "glossary",
      path: "CONTEXT.md",
      pathIsProvisional: false,
      markdown: "# Report\nA saved report has a title and retained contents.\n",
      workItemKey: "W1",
    },
    {
      key: "title-search",
      kind: "adr",
      path: "docs/adr/0001-title-search.md",
      pathIsProvisional: true,
      markdown: "# Title search\nSearch titles while preserving report contents.\n",
      workItemKey: "W2",
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
  await page.getByRole("button", { name: "New plan", exact: true }).click();
  await page.getByLabel("Describe the change", { exact: true }).fill(title);
  await page.getByRole("main").getByRole("button", { name: "Start plan", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "New plan", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Rename feature", exact: true }).click();
  const featureDialog = page.getByRole("dialog", { name: "Rename feature", exact: true });
  await featureDialog.getByLabel("Feature name", { exact: true }).fill(title);
  await featureDialog.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(featureDialog).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByText("Codex is unavailable", { exact: true })).toBeVisible();
}

async function seedPlan(
  page: Page,
  {
    expectedVersion = null,
    document: planDocument = plan,
  }: { expectedVersion?: number | null; document?: FeaturePlanDocument } = {},
): Promise<string> {
  const endpoint = `/api/v1${new URL(page.url()).pathname}/plans`;
  const saved = await page.evaluate(
    async ({ endpoint, plan, expectedVersion }) => {
      const csrf = document.cookie
        .split("; ")
        .find((cookie) => cookie.startsWith("__Host-kestrel-csrf="))
        ?.split("=")[1];
      if (csrf === undefined) throw new Error("The authenticated browser has no CSRF token");
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Kestrel-CSRF": csrf },
        body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion, plan }),
      });
      if (response.status !== 201) throw new Error(`Plan seed failed: ${await response.text()}`);
      return response.json() as Promise<unknown>;
    },
    { endpoint, plan: planDocument, expectedVersion },
  );
  const version = (expectedVersion ?? 0) + 1;
  expect(FeaturePlanVersionSchema.parse(saved).version).toBe(version);
  await page.getByRole("button", { name: "Load latest version", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `Plan · version ${String(version)}`, exact: true }),
  ).toBeVisible();
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

  test("opens a generated reply's original documents after a later draft changes them", async ({
    page,
  }) => {
    if (stack === undefined || fixture === undefined)
      throw new Error("The planning stack is unavailable");
    const glossary = plan.proposedDocuments?.[0];
    if (glossary === undefined) throw new Error("No glossary fixture");
    await login(page, stack.pwaUrl);
    await openFeature(page, "Retain agreed report terminology");
    await page.getByRole("tab", { name: "Plan", exact: true }).click();
    await seedPlan(page);
    const featureId = KestrelIdSchema.parse(new URL(page.url()).pathname.split("/")[4]);
    const context = {
      commitId: fixture.headObjectId,
      documents: [],
      notice: "Retained generation context for this fixture.",
    };
    // Controlled model completion exercises the production transaction; live model conformance is separate.
    await stack.executeWebModule(`
      import { createPool, claimPlanningTurn, completeGeneratedFactoryPlan } from "@kestrel/database";
      import { renderFeaturePlanArtifacts } from "./apps/web/dist/factory-plan-artifacts.js";
      const pool = createPool(process.env.DATABASE_URL);
      try {
        const message = await pool.query("INSERT INTO factory_planning_messages (feature_id,role,content) VALUES ($1,'user','Generate the agreed glossary and ADR') RETURNING id", ["${featureId}"]);
        const turn = await pool.query("INSERT INTO factory_planning_turns (feature_id,message_id,request_id,purpose,expected_plan_version) VALUES ($1,$2,uuidv7(),'plan',1) RETURNING id", ["${featureId}",message.rows[0].id]);
        const claimed = await claimPlanningTurn(pool,turn.rows[0].id);
        await completeGeneratedFactoryPlan(pool,claimed,${JSON.stringify(plan)},${JSON.stringify(context)},renderFeaturePlanArtifacts);
      } finally { await pool.end(); }
    `);
    await seedPlan(page, {
      expectedVersion: 2,
      document: {
        ...plan,
        proposedDocuments: [
          {
            ...glossary,
            markdown: "# Report\nThis is the later draft, not the generated proposal.\n",
          },
        ],
      },
    });
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    await page.reload();
    const opener = page.getByRole("button", { name: "Inspect plan 2 documents", exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Proposed documents · version 2",
      exact: true,
    });
    await expect(dialog.getByLabel("Proposed contents of CONTEXT.md", { exact: true })).toHaveText(
      glossary.markdown,
    );
    await expect(dialog).not.toContainText("This is the later draft");
    await expect(
      dialog.getByRole("region", { name: "Proposed docs/adr/0001-title-search.md", exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Sources supplied for this plan", exact: true })
      .click();
    const sources = page.getByRole("dialog", {
      name: "Sources supplied for this plan",
      exact: true,
    });
    await expect(sources).toContainText(context.commitId);
    await expect(sources).toContainText(context.notice);
    await expect(
      sources.getByRole("button", { name: "Back to proposed documents", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Sources supplied for this plan", exact: true }),
    ).toBeFocused();
    await page.screenshot({
      path: test.info().outputPath("factory-generated-documents-desktop.png"),
      animations: "disabled",
    });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
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
    const endpoint = await seedPlan(page);
    await page.getByRole("button", { name: "Proposed documents", exact: true }).click();
    const proposals = page.getByRole("dialog", {
      name: "Proposed documents · version 1",
      exact: true,
    });
    await expect(
      proposals.getByLabel("Proposed contents of CONTEXT.md", { exact: true }),
    ).toHaveText(plan.proposedDocuments?.[0]?.markdown ?? "");
    await expect(proposals).toContainText("Provisional path");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Edit draft", exact: true }).click();
    const revisedGlossary = "# Report\nA named saved report remains readable after reload.\n";
    await page.getByLabel("Proposed Markdown 1", { exact: true }).fill(revisedGlossary);
    await page.getByRole("button", { name: "Remove proposed document 2", exact: true }).click();
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
    await page.getByRole("button", { name: "Proposed documents", exact: true }).click();
    const revisedProposals = page.getByRole("dialog", {
      name: "Proposed documents · version 2",
      exact: true,
    });
    await expect(
      revisedProposals.getByLabel("Proposed contents of CONTEXT.md", { exact: true }),
    ).toHaveText(revisedGlossary);
    await expect(
      revisedProposals.getByRole("region", {
        name: "Proposed docs/adr/0001-title-search.md",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: test.info().outputPath("factory-proposed-documents-narrow.png"),
      animations: "disabled",
    });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 900 });
    const original = FeaturePlanVersionSchema.parse(
      await page.evaluate(
        async (path) => (await fetch(path)).json() as Promise<unknown>,
        `${endpoint}/1`,
      ),
    );
    expect(original.document.proposedDocuments).toEqual(plan.proposedDocuments);
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
    await stalePage
      .getByRole("navigation", { name: "Projects", exact: true })
      .getByRole("link", { name: /kestrel/u })
      .click();
    await expect(stalePage).toHaveURL(`${stack.pwaUrl}/projects/${projectId}`);
    await expect(stalePage.getByRole("button", { name: /^Open planning chat:/u })).toHaveCount(0);
    const projectItem = stalePage.getByRole("button", {
      name: /^Open Work Item: Search saved reports ·/u,
    });
    await expect(projectItem).toContainText("After W1");
    await stalePage.screenshot({
      path: test.info().outputPath("factory-project-board-approved.png"),
      animations: "disabled",
    });
    await projectItem.click();
    await expect(stalePage.getByRole("tab", { name: "Board", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
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
