import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  FactoryIssueImportsSchema,
  FactoryIssuePublicationSchema,
  FeaturePlanVersionSchema,
  type FeaturePlanDocument,
} from "@kestrel/contracts";
import { startStack, TEST_OPERATOR_CREDENTIALS, type RunningStack } from "./support/compose.js";
import { factoryGitHubFixture } from "./support/factory-github-fixture.js";
import { createGitFixture, type GitFixture } from "./support/git-fixture.js";

const plan: FeaturePlanDocument = {
  objective: "Find saved reports by their title.",
  scope: { includes: ["Search local report titles"], excludes: ["Search report contents"] },
  acceptance: [{ key: "R1", outcome: "An Operator can find a saved report by title." }],
  workItems: [
    {
      key: "W1",
      title: "Index report titles",
      description: "Create a local title index using the approved requirements.",
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

async function createFeature(page: Page, url: string): Promise<string> {
  await page.goto(url);
  await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
  await page.getByLabel("Password", { exact: true }).fill(TEST_OPERATOR_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Open Project", exact: true }).click();
  const repository = page.getByRole("dialog", { name: "Open an authorized repository" });
  const repositoryId = await repository
    .getByRole("option")
    .filter({ hasText: "kestrel" })
    .first()
    .getAttribute("value");
  if (repositoryId === null) throw new Error("The fixture has no repository identity");
  await repository.getByLabel("Repository", { exact: true }).selectOption(repositoryId);
  await repository.getByRole("button", { name: "Open selected Project" }).click();
  await expect(repository).toHaveCount(0);
  await page.getByRole("button", { name: "New feature", exact: true }).click();
  const feature = page.getByRole("dialog", { name: "New feature", exact: true });
  const title = "Deliver report search from existing issues";
  await feature.getByLabel("Feature name", { exact: true }).fill(title);
  await feature.getByRole("button", { name: "Create feature", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
  return `/api/v1${new URL(page.url()).pathname}`;
}

async function readJson(page: Page, endpoint: string): Promise<unknown> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Read failed: ${await response.text()}`);
    return response.json() as Promise<unknown>;
  }, endpoint);
}

async function seedPlan(page: Page, endpoint: string): Promise<void> {
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
}

test.describe("Factory GitHub issues", () => {
  let stack: RunningStack | undefined;
  let fixture: GitFixture | undefined;
  test.beforeAll(async () => {
    fixture = await createGitFixture();
    stack = await startStack({
      repositoryRoot: fixture.rootPath,
      githubFixture: factoryGitHubFixture,
    });
    await stack.bootstrapOperator(TEST_OPERATOR_CREDENTIALS);
  });
  test.afterAll(async () => {
    await stack?.close();
    await fixture?.close();
  });

  test("imports a snapshot, binds it through normal plan fields, and resumes partial publication without duplicates", async ({
    page,
  }) => {
    if (stack === undefined) throw new Error("The GitHub issue stack is unavailable");
    const endpoint = await createFeature(page, stack.pwaUrl);
    const importsEndpoint = `${endpoint}/imports`;
    const importRequests: string[] = [];
    await page.route(`**${importsEndpoint}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postData();
      if (body === null) throw new Error("The import command has no body");
      importRequests.push(body);
      if (importRequests.length !== 1) return route.continue();
      expect((await route.fetch()).status()).toBe(201);
      await route.abort("connectionfailed");
    });
    const opener = page.getByRole("button", { name: "GitHub issues", exact: true });
    await opener.click();
    const issues = page.getByRole("dialog", { name: "GitHub issues", exact: true });
    await issues.getByRole("checkbox", { name: "Select issue #12", exact: true }).check();
    await issues.getByRole("button", { name: "Import selected issues (1)", exact: true }).click();
    await issues.getByRole("button", { name: "Retry import", exact: true }).click();
    await expect(issues.getByRole("button", { name: "Retry import", exact: true })).toHaveCount(0);
    expect(importRequests).toHaveLength(2);
    expect(importRequests[1]).toBe(importRequests[0]);
    const imported = FactoryIssueImportsSchema.parse(await readJson(page, importsEndpoint));
    expect(imported.issues).toHaveLength(1);
    const source = imported.issues[0];
    if (source === undefined) throw new Error("The imported issue snapshot is missing");
    expect(source.issue.number).toBe(12);
    await expect(issues.getByLabel("Issue #12 body", { exact: true })).toHaveText(
      source.issue.body,
    );
    await expect(issues.getByText("Untrusted planning context.", { exact: false })).toBeVisible();
    expect(await page.evaluate(() => Reflect.has(window, "fixtureExecuted"))).toBe(false);
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
    await page.reload();
    await opener.click();
    await expect(issues.getByLabel("Issue #12 body", { exact: true })).toHaveText(
      source.issue.body,
    );
    await expect(
      issues.getByRole("checkbox", { name: "Select issue #13", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: test.info().outputPath("factory-github-import-desktop.png"),
      animations: "disabled",
    });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: test.info().outputPath("factory-github-import-narrow.png"),
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(issues).toBeVisible();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1024, height: 800 });

    await seedPlan(page, `${endpoint}/plans`);
    await page.getByRole("tab", { name: "Plan", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Approve version 1", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByText("Assign #12 · Existing issue 12 to a Work Item", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Edit draft", exact: true }).click();
    await page.getByLabel("GitHub issue 1", { exact: true }).selectOption(source.id);
    await expect(page.getByLabel("Objective", { exact: true })).toHaveValue(plan.objective);
    await page.getByRole("button", { name: "Save new version", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Plan · version 2", exact: true }),
    ).toBeVisible();
    const saved = FeaturePlanVersionSchema.parse(await readJson(page, `${endpoint}/plans/2`));
    expect(saved.document).toEqual({
      ...plan,
      workItems: plan.workItems.map((item, index) => ({
        ...item,
        importedIssueId: index === 0 ? source.id : null,
      })),
    });
    await page.getByRole("button", { name: "Inspect imported snapshot", exact: true }).click();
    const snapshot = page.getByRole("dialog", { name: "Imported issue #12", exact: true });
    await expect(snapshot.getByLabel("Issue #12 body", { exact: true })).toHaveText(
      source.issue.body,
    );
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: test.info().outputPath("factory-github-snapshot-narrow.png"),
      animations: "disabled",
    });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1024, height: 800 });
    await opener.click();
    await expect(issues.getByRole("checkbox")).toHaveCount(0);
    await expect(issues.getByText("Import is unavailable", { exact: false })).toBeVisible();
    await page.keyboard.press("Escape");

    await stack.executeWebModule(`
      import { readFile, writeFile } from "node:fs/promises";
      const path = "/tmp/kestrel-factory-github.json";
      const state = JSON.parse(await readFile(path, "utf8"));
      state.controls = { rejectCreate: true };
      await writeFile(path, JSON.stringify(state));
    `);
    await page.getByRole("button", { name: "Approve version 2", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Board", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const publicationEndpoint = `${endpoint}/publication`;
    const readPublication = async () =>
      FactoryIssuePublicationSchema.parse(await readJson(page, publicationEndpoint));
    await expect.poll(async () => (await readPublication()).state).toBe("blocked");
    const partial = await readPublication();
    if (partial.items[0]?.state !== "published")
      await test.info().attach("unexpected-publication.json", {
        body: JSON.stringify({
          publication: partial,
          provider: await stack.executeWebModule(`
            import { readFile } from "node:fs/promises";
            const path = "/tmp/kestrel-factory-github.json";
            console.log(JSON.stringify({
              state: JSON.parse(await readFile(path, "utf8")),
            }));
          `),
        }),
        contentType: "application/json",
      });
    await expect(
      page.getByRole("heading", { name: "GitHub publication needs attention", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("1 of 2 Work Items published", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "#12", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("1 of 2 Work Items published", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "#12", exact: true })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("factory-github-publication-partial.png"),
      animations: "disabled",
    });

    await stack.executeWebModule(`
      import { readFile, writeFile } from "node:fs/promises";
      const path = "/tmp/kestrel-factory-github.json";
      const state = JSON.parse(await readFile(path, "utf8"));
      state.controls = {};
      await writeFile(path, JSON.stringify(state));
    `);
    const retryRequests: string[] = [];
    await page.route(`**${publicationEndpoint}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postData();
      if (body === null) throw new Error("The publication retry has no body");
      retryRequests.push(body);
      if (retryRequests.length !== 1) return route.continue();
      expect((await route.fetch()).status()).toBe(202);
      await route.abort("connectionfailed");
    });
    await page.getByRole("button", { name: "Retry publication", exact: true }).click();
    await page.getByRole("button", { name: "Retry request", exact: true }).click();
    expect(retryRequests).toHaveLength(2);
    expect(retryRequests[1]).toBe(retryRequests[0]);
    await expect.poll(async () => (await readPublication()).state).toBe("published");
    await expect(
      page.getByRole("heading", { name: "GitHub issues published", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByText("2 of 2 Work Items published", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "#100", exact: true })).toBeVisible();
    await expect(page.getByText("Execution is not available yet.", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Completed", exact: true })).toContainText(
      "No Work Items",
    );
    await page.getByRole("button", { name: "2. Search saved reports", exact: true }).click();
    const card = page.getByRole("dialog", { name: "Search saved reports", exact: true });
    await expect(
      card.getByRole("link", { name: "Open linked issue", exact: true }),
    ).toHaveAttribute("href", "https://github.com/Ic3b3rg/kestrel/issues/100");
    await expect(card.getByText("W1", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: test.info().outputPath("factory-github-board-desktop.png"),
      animations: "disabled",
    });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: test.info().outputPath("factory-github-board-narrow.png"),
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const publication = await readPublication();
    expect(publication.items.map((item) => item.issue?.number)).toEqual([12, 100]);
    expect(publication.items[1]?.dependencyMode).toBe("native");
    const evidence: unknown = JSON.parse(
      await stack.executeWebModule(`
      import { readFile } from "node:fs/promises";
      const state = JSON.parse(await readFile("/tmp/kestrel-factory-github.json", "utf8"));
      console.log(JSON.stringify({
        originalBody: state.issues.find((issue) => issue.number === 12).body,
        created: state.issues.filter((issue) => issue.number >= 100).map((issue) => issue.number),
        comments: state.comments.filter((comment) => comment.number === 12).length,
        dependencies: state.edges,
        allIssuesOpen: state.issues.every((issue) => issue.state === "open"),
      }));
    `),
    );
    expect(evidence).toEqual({
      originalBody: source.issue.body,
      created: [100],
      comments: 1,
      dependencies: [{ number: 100, id: "1012" }],
      allIssuesOpen: true,
    });
  });
});
