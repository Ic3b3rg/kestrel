import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { FeatureChatSchema, FeatureListSchema, KestrelIdSchema } from "@kestrel/contracts";
import { startStack, TEST_OPERATOR_CREDENTIALS, type RunningStack } from "./support/compose.js";
import { createGitFixture, type GitFixture } from "./support/git-fixture.js";

const execFileAsync = promisify(execFile);
const featureTitle = "Make saved reports searchable";
const requestText = "Help me define searching saved reports before we approve any implementation.";

async function openProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Open Project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Open an authorized repository" });
  const option = dialog.getByRole("option").filter({ hasText: name }).first();
  const repositoryId = await option.getAttribute("value");
  if (repositoryId === null) throw new Error("Fixture repository has no identity");
  await dialog.getByLabel("Repository", { exact: true }).selectOption(repositoryId);
  await dialog.getByRole("button", { name: "Open selected Project" }).click();
  await expect(dialog).toHaveCount(0);
}

async function createFeature(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "New feature", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New feature", exact: true });
  await dialog.getByLabel("Feature name", { exact: true }).fill(title);
  await dialog.getByRole("button", { name: "Create feature", exact: true }).click();
}

test.describe("Factory planning chat", () => {
  let stack: RunningStack | undefined;
  let fixture: GitFixture | undefined;

  test.beforeAll(async () => {
    fixture = await createGitFixture();
    await fixture.createSibling("falcon", "falcon");
    await writeFile(
      join(fixture.repositoryPath, "README.md"),
      "# Saved reports\n\nReports are retained locally and must remain readable after reload.\n",
    );
    await execFileAsync("/usr/bin/git", ["-C", fixture.repositoryPath, "add", "README.md"]);
    await execFileAsync("/usr/bin/git", [
      "-C",
      fixture.repositoryPath,
      "commit",
      "-m",
      "Document the planning fixture",
    ]);
    stack = await startStack({ repositoryRoot: fixture.rootPath });
    await stack.bootstrapOperator(TEST_OPERATOR_CREDENTIALS);
  });

  test.afterAll(async () => {
    await stack?.close();
    await fixture?.close();
  });

  test("saves a real conversation, reconciles uncertain commands, and restores each Project chat", async ({
    page,
  }) => {
    if (stack === undefined) throw new Error("Factory browser stack is unavailable");
    await page.goto(stack.pwaUrl);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password", { exact: true }).fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await openProject(page, "kestrel");
    const projectId = new URL(page.url()).pathname.split("/")[2];
    if (projectId === undefined) throw new Error("The opened Project has no identity");

    const creationIds: string[] = [];
    await page.route(`**/api/v1/projects/${projectId}/features`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataJSON() as { requestId: string };
      creationIds.push(body.requestId);
      if (creationIds.length === 1) {
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await createFeature(page, featureTitle);
    const creationDialog = page.getByRole("dialog", { name: "New feature", exact: true });
    await expect(creationDialog.getByRole("alert")).toContainText("could not confirm");
    await creationDialog.getByRole("button", { name: "Retry creation", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: featureTitle, exact: true }),
    ).toBeVisible();
    expect(creationIds).toHaveLength(2);
    expect(new Set(creationIds).size).toBe(1);
    const featureUrl = page.url();
    const featureId = new URL(featureUrl).pathname.split("/")[4];
    if (featureId === undefined) throw new Error("The created feature has no identity");
    const chatEndpoint = `/api/v1/projects/${projectId}/features/${featureId}`;

    const messageIds: string[] = [];
    await page.route(`**${chatEndpoint}/messages`, async (route) => {
      const body = route.request().postDataJSON() as { requestId: string };
      messageIds.push(body.requestId);
      if (messageIds.length === 1) {
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await page.getByLabel("Message", { exact: true }).fill(requestText);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "could not confirm" })).toBeVisible();
    await page.getByRole("button", { name: "Retry send", exact: true }).click();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
    await expect(
      page
        .getByRole("list", { name: "Conversation", exact: true })
        .getByText(requestText, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Codex is unavailable", { exact: true })).toBeVisible();
    expect(messageIds).toHaveLength(2);
    expect(new Set(messageIds).size).toBe(1);
    const readChat = async () =>
      FeatureChatSchema.parse(
        await page.evaluate(async (path) => {
          const response = await fetch(path, { headers: { Accept: "application/json" } });
          return response.json() as Promise<unknown>;
        }, chatEndpoint),
      );
    const firstChat = await readChat();
    expect(firstChat.messages).toHaveLength(1);
    expect(firstChat.turns).toHaveLength(1);
    expect(firstChat.turns[0]?.state).toBe("failed");
    expect(firstChat.context?.documents.some(({ path }) => path === "README.md")).toBe(true);
    const features = FeatureListSchema.parse(
      await page.evaluate(async (path) => {
        const response = await fetch(path, { headers: { Accept: "application/json" } });
        return response.json() as Promise<unknown>;
      }, `/api/v1/projects/${projectId}/features`),
    );
    expect(features.features).toHaveLength(1);

    await page.getByRole("button", { name: "Project documents", exact: true }).click();
    const documents = page.getByRole("dialog", { name: "Project documents", exact: true });
    await documents.getByRole("button", { name: "README.md", exact: true }).click();
    await expect(
      documents.getByText("Reports are retained locally", { exact: false }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page).toHaveURL(featureUrl);
    await expect(
      page
        .getByRole("list", { name: "Conversation", exact: true })
        .getByText(requestText, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Codex is unavailable", { exact: true })).toBeVisible();

    await openProject(page, "falcon");
    await createFeature(page, "Clarify report export");
    await expect(
      page.getByRole("heading", { level: 1, name: "Clarify report export" }),
    ).toBeVisible();
    const secondUrl = page.url();
    await page
      .getByRole("navigation", { name: "Projects", exact: true })
      .getByRole("link", { name: /kestrel/u })
      .click();
    await expect(page).toHaveURL(featureUrl);
    await expect(
      page
        .getByRole("list", { name: "Conversation", exact: true })
        .getByText(requestText, { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Retry planning", exact: true }).click();
    await expect.poll(async () => (await readChat()).turns.length).toBe(2);
    await expect(page.getByText("Codex is unavailable", { exact: true })).toBeVisible();
    expect((await readChat()).messages).toHaveLength(1);
    await page.screenshot({
      path: test.info().outputPath("factory-chat-desktop.png"),
      animations: "disabled",
    });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await page.setViewportSize({ width: 375, height: 812 });
    const opener = page.getByRole("button", { name: "Open navigation", exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("dialog", { name: "Workspace navigation", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
    await page.keyboard.press("Enter");
    const featureLink = page
      .getByRole("navigation", { name: "Feature chats", exact: true })
      .getByRole("link", { name: featureTitle, exact: true });
    await featureLink.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
    await expect(
      page.getByRole("dialog", { name: "Workspace navigation", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("factory-chat-narrow.png"),
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await opener.click();
    await page
      .getByRole("navigation", { name: "Projects", exact: true })
      .getByRole("link", { name: /falcon/u })
      .click();
    await expect(page).toHaveURL(secondUrl);
    await expect(
      page.getByRole("heading", { level: 1, name: "Clarify report export" }),
    ).toBeVisible();
    await opener.click();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("kestrel.feature-navigation"))).toBe(
      null,
    );
  });

  test("restores an aliased Project bookmark without adding a browser Back loop", async ({
    page,
  }) => {
    if (stack === undefined) throw new Error("Factory browser stack is unavailable");
    await page.goto(stack.pwaUrl);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password", { exact: true }).fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await openProject(page, "kestrel");
    const title = "Keep saved chat bookmarks";
    await createFeature(page, title);
    await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
    const canonicalUrl = page.url();
    const routeParts = new URL(canonicalUrl).pathname.split("/");
    const canonicalProjectId = KestrelIdSchema.parse(routeParts[2]);
    const featureId = KestrelIdSchema.parse(routeParts[4]);
    const aliasProjectId = "018f0f89-949a-75a8-8f61-6df78a843b20";
    await stack.executeSql(`
      INSERT INTO projects (id, installation_id, canonical_project_id)
      SELECT '${aliasProjectId}', installation_id, id
      FROM projects WHERE id = '${canonicalProjectId}';
    `);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    const previousUrl = page.url();
    await page.evaluate(
      ({ projectId, featureId }) => {
        sessionStorage.setItem(
          "kestrel.feature-navigation",
          JSON.stringify({ [projectId]: featureId }),
        );
      },
      { projectId: aliasProjectId, featureId },
    );
    await page.goto(`${stack.pwaUrl}/projects/${aliasProjectId}/features/${featureId}`);
    await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
    await expect(page).toHaveURL(canonicalUrl);
    await expect(
      page
        .getByRole("navigation", { name: "Feature chats", exact: true })
        .getByRole("link", { name: title, exact: true }),
    ).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => sessionStorage.getItem("kestrel.feature-navigation"))).toBe(
      JSON.stringify({ [canonicalProjectId]: featureId }),
    );
    await page.goBack();
    await expect(page).toHaveURL(previousUrl);
    await page.goForward();
    await expect(page).toHaveURL(canonicalUrl);
    await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
  });
});
