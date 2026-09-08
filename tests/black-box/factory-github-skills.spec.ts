import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  FeatureChatSchema,
  FeatureSchema,
  GitHubPlanningSkillBundleSchema,
  InstallGitHubPlanningSkillCommandSchema,
  LocalRepositoryInventorySchema,
  ProjectUpsertedSchema,
  type InstallGitHubPlanningSkillCommand,
} from "@kestrel/contracts";
import { startStack, TEST_OPERATOR_CREDENTIALS, type RunningStack } from "./support/compose.js";
import { createGitFixture } from "./support/git-fixture.js";
import {
  createPlanningSkillGitHubFixture,
  readPlanningSkillGitHubState,
} from "./support/planning-skill-github-fixture.js";

test.describe("GitHub planning Skill imports", () => {
  let stack: RunningStack;
  let provider: Awaited<ReturnType<typeof createPlanningSkillGitHubFixture>>;
  let featurePath: string;
  const title = "Plan recovery with grounded questions";
  const cleanup: Array<() => Promise<void>> = [];
  const post = (path: string, body: unknown) =>
    stack.fetchApi(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  test.beforeAll(async () => {
    const repository = await createGitFixture();
    cleanup.push(() => repository.close());
    provider = await createPlanningSkillGitHubFixture();
    stack = await startStack({
      repositoryRoot: repository.rootPath,
      githubFixture: provider.githubFixture,
    });
    cleanup.push(() => stack.close());
    await stack.authenticateOperator();
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const source = inventory.repositories.find(({ displayName }) => displayName === "kestrel");
    if (source === undefined) throw new Error("The disposable Project source is missing");
    const opened = await post("/api/v1/projects/local", { repositoryId: source.repositoryId });
    const projectId = ProjectUpsertedSchema.parse(await opened.json()).project.id;
    const created = await post(`/api/v1/projects/${projectId}/features`, {
      requestId: randomUUID(),
      title,
    });
    expect(created.status).toBe(201);
    featurePath = `/projects/${projectId}/features/${FeatureSchema.parse(await created.json()).id}`;
  });
  test.afterAll(async () => {
    for (const close of cleanup.toReversed()) await close();
  });

  test("reviews the starter, retries a lost install after dialog closure, and restores selected provenance", async ({
    page,
  }) => {
    await page.goto(stack.pwaUrl);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password", { exact: true }).fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("region", { name: "Sign in to Kestrel" })).toHaveCount(0);
    await page.goto(`${stack.pwaUrl}${featurePath}`);
    await expect(page.getByRole("heading", { name: title, level: 1, exact: true })).toBeVisible();
    const skills = page.getByRole("dialog", { name: "Planning Skills", exact: true });
    const importer = page.getByRole("dialog", { name: "Import a planning Skill", exact: true });
    const readChat = async () =>
      FeatureChatSchema.parse(await (await stack.fetchApi(`/api/v1${featurePath}`)).json());
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await skills.getByRole("button", { name: "Import from GitHub", exact: true }).click();
    await expect(
      importer.getByRole("button", { name: "Install reviewed version", exact: true }),
    ).toHaveCount(0);
    const previewResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/planning-skills/github/preview") &&
        response.request().method() === "POST",
    );
    await importer.getByRole("button", { name: "Preview Skill", exact: true }).click();
    const response = await previewResponse;
    expect(response.status()).toBe(200);
    const preview = GitHubPlanningSkillBundleSchema.parse(await response.json());
    expect(preview.source.commitId).toBe(provider.originalCommit);
    expect(preview.files).toHaveLength(10);
    await expect(importer.getByText(provider.originalCommit, { exact: true }).last()).toBeVisible();
    await expect(importer.getByLabel("Previewed Skill instructions")).toContainText(
      "Kestrel grilling starter",
    );
    await importer.getByLabel("Instructions and references").selectOption("sources/LICENSE");
    await expect(importer.getByLabel("Previewed Skill instructions")).toContainText("MIT License");
    await expect(importer.getByLabel("Previewed Skill instructions")).toContainText("Matt Pocock");
    expect((await readChat()).skills?.skills).toEqual([]);
    expect((await readChat()).turns).toEqual([]);
    await page.setViewportSize({ width: 375, height: 812 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations,
    ).toEqual([]);

    const commands: InstallGitHubPlanningSkillCommand[] = [];
    await page.route("**/api/v1/planning-skills/github/install", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postData();
      if (body === null) throw new Error("The install request has no body");
      commands.push(InstallGitHubPlanningSkillCommandSchema.parse(JSON.parse(body) as unknown));
      if (commands.length !== 1) return route.continue();
      // The actual API commits; only its response is lost at the browser boundary.
      expect((await route.fetch()).status()).toBe(201);
      await route.abort("connectionfailed");
    });
    await importer.getByRole("button", { name: "Install reviewed version", exact: true }).click();
    await expect(
      importer.getByRole("button", { name: "Retry installation", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(importer).toHaveCount(0);
    await expect(skills).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(skills).toHaveCount(0);
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await skills.getByRole("button", { name: "Import from GitHub", exact: true }).click();
    await expect(importer.getByLabel("Source", { exact: true })).toBeDisabled();
    await expect(importer.getByText(provider.originalCommit, { exact: true }).last()).toBeVisible();
    await importer.getByRole("button", { name: "Retry installation", exact: true }).click();
    await expect(importer.getByRole("button", { name: "Installed", exact: true })).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]?.digest).toBe(preview.contentDigest);
    const installedCommand = commands[0];
    if (installedCommand === undefined) throw new Error("The reviewed install command is missing");
    const ledgerCount = await stack.executeWebModule(
      `import {createPool} from '@kestrel/database'; const pool=createPool(process.env.DATABASE_URL); try { const result=await pool.query('SELECT count(*) FROM factory_planning_skill_installs WHERE request_id=$1',[${JSON.stringify(installedCommand.requestId)}]); console.log(result.rows[0].count); } finally { await pool.end(); }`,
    );
    expect(ledgerCount.trim()).toBe("1");
    expect((await readChat()).skills?.skills).toEqual([]);
    await importer.getByRole("button", { name: "Back to Skills", exact: true }).click();
    await skills.getByRole("checkbox", { name: "Use $grilling-starter", exact: true }).check();
    await skills.getByRole("button", { name: "Use selected Skills", exact: true }).click();
    await expect(skills).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Skills (1)", exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Skills (1)", exact: true }).click();
    await expect(
      skills.getByRole("checkbox", { name: "Use $grilling-starter", exact: true }),
    ).toBeChecked();
    const retainedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/planning-skills/${preview.contentDigest}`) &&
        response.request().method() === "GET",
    );
    await skills.getByRole("button", { name: "Inspect $grilling-starter", exact: true }).click();
    const retained = GitHubPlanningSkillBundleSchema.parse(await (await retainedResponse).json());
    expect(retained).toEqual(preview);
    await expect(skills.getByText(provider.originalCommit, { exact: true }).last()).toBeVisible();
    await skills.getByLabel("Instructions and references").selectOption("sources/LICENSE");
    await expect(skills.getByLabel("Retained Skill instructions")).toContainText("MIT License");
    await skills.getByRole("button", { name: "Back to Skills", exact: true }).focus();
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations,
    ).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("github-skill-retained-mobile.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(skills).toHaveCount(0);
    const chat = await readChat();
    expect(chat.skills?.skills[0]?.contentDigest).toBe(preview.contentDigest);
    expect(chat.feature.state).toBe("planning");
    expect(chat.turns).toEqual([]);
    expect(
      (await readPlanningSkillGitHubState(stack)).calls.every(({ method }) => method === "GET"),
    ).toBe(true);
  });
});
