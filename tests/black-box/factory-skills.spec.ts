import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { FeatureChatSchema, FeatureListSchema } from "@kestrel/contracts";
import { startStack, TEST_OPERATOR_CREDENTIALS, type RunningStack } from "./support/compose.js";
import { createGitFixture, type GitFixture } from "./support/git-fixture.js";

test.describe("Planning Skills in the chat", () => {
  let fixture: GitFixture | undefined;
  let stack: RunningStack | undefined;
  let skillFile: string;
  function requireStack(): RunningStack {
    if (stack === undefined) throw new Error("The planning Skill fixture is unavailable");
    return stack;
  }
  const entry = (version: string) =>
    `---\nname: recovery-checklist\ndescription: Clarify recovery requirements.\n---\nFollow the [recovery checklist](references/recovery.md). ${version}\n`;
  test.beforeAll(async () => {
    fixture = await createGitFixture();
    const root = join(fixture.rootPath, "planning-skills");
    const skill = join(root, "recovery-checklist");
    await mkdir(join(skill, "references"), { recursive: true });
    skillFile = join(skill, "SKILL.md");
    await writeFile(skillFile, entry("Original procedure."));
    await writeFile(
      join(skill, "references/recovery.md"),
      "Ask which saved reports must survive a process restart.\n",
    );
    const research = join(root, "research");
    await mkdir(research, { recursive: true });
    await writeFile(
      join(research, "SKILL.md"),
      "---\nname: research\ndescription: Check primary sources.\n---\nVerify the source before planning.\n",
    );
    stack = await startStack({
      connectedCodexFixture: true,
      repositoryRoot: fixture.rootPath,
      planningSkillRoot: root,
    });
    await requireStack().bootstrapOperator(TEST_OPERATOR_CREDENTIALS);
  });
  test.afterAll(async () => {
    await stack?.close();
    await fixture?.close();
  });
  test("imports real instructions, uses a selected version, and keeps its preview after an update", async ({
    page,
  }) => {
    await page.goto(requireStack().pwaUrl);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password", { exact: true }).fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Open Project", exact: true }).click();
    const repositoryDialog = page.getByRole("dialog", { name: "Open an authorized repository" });
    const repositoryId = await repositoryDialog
      .getByRole("option")
      .filter({ hasText: "kestrel" })
      .first()
      .getAttribute("value");
    if (repositoryId === null) throw new Error("Fixture repository has no identity");
    await repositoryDialog.getByLabel("Repository", { exact: true }).selectOption(repositoryId);
    await repositoryDialog.getByRole("button", { name: "Open selected Project" }).click();
    await expect(repositoryDialog).toHaveCount(0);
    const projectUrl = page.url();
    const featuresPath = `/api/v1${new URL(page.url()).pathname}/features`;
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("link", { name: "Skills" })
      .click();
    const library = page.getByRole("region", { name: "Installed Skills" });
    const workstation = page.getByRole("region", { name: "Import from workstation" });
    await workstation
      .getByLabel("Host Skill to import")
      .selectOption({ label: "recovery-checklist" });
    await workstation.getByRole("button", { name: "Import Skill", exact: true }).click();
    await expect(library.getByRole("button", { name: "Inspect recovery-checklist" })).toBeVisible();
    await library.getByRole("button", { name: "Inspect recovery-checklist" }).click();
    const firstInstructions = page.getByRole("dialog", { name: "Installed Skill instructions" });
    await expect(firstInstructions.getByLabel("Retained Skill instructions")).toContainText(
      "Original procedure.",
    );
    await firstInstructions
      .getByLabel("Instructions and references")
      .selectOption("references/recovery.md");
    await expect(firstInstructions.getByLabel("Retained Skill instructions")).toContainText(
      "survive a process restart",
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await page.goto(projectUrl);
    await page.getByRole("button", { name: "New plan", exact: true }).click();
    await expect(page.getByRole("button", { name: "Skills", exact: true })).toHaveCount(0);
    expect(
      FeatureListSchema.parse(
        await page.evaluate(
          async (path) => (await fetch(path)).json() as Promise<unknown>,
          featuresPath,
        ),
      ).features,
    ).toEqual([]);
    await page
      .getByLabel("Describe the change", { exact: true })
      .fill("$recovery-checklist Help me specify recovering saved reports.");
    await page.getByRole("main").getByRole("button", { name: "Start plan", exact: true }).click();
    await expect(page.getByText("Codex is unavailable", { exact: true })).toBeVisible();
    const path = `/api/v1${new URL(page.url()).pathname}`;
    const chat = async () =>
      FeatureChatSchema.parse(
        await page.evaluate(async (path) => (await fetch(path)).json() as Promise<unknown>, path),
      );
    expect((await chat()).skills?.version).toBe(1);
    const original = (await chat()).turns[0]?.skills?.[0];
    expect(original?.name).toBe("recovery-checklist");
    if (original === undefined) throw new Error("The accepted turn did not retain its Skill");
    const featureUrl = page.url();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/profile$/u);
    const sections = page.getByRole("navigation", { name: "Settings sections" });
    await sections.getByRole("link", { name: "Skills" }).click();
    await expect(page).toHaveURL(/\/settings\/skills$/u);
    await expect(library).toContainText("$recovery-checklist");
    await expect(library).toContainText("Clarify recovery requirements.");
    await expect(library).toContainText(original.contentDigest.slice(0, 12));
    await page.reload();
    const inspectInstalled = library.getByRole("button", { name: "Inspect recovery-checklist" });
    await inspectInstalled.focus();
    await page.keyboard.press("Enter");
    const installedInstructions = page.getByRole("dialog", {
      name: "Installed Skill instructions",
    });
    await expect(installedInstructions.getByLabel("Retained Skill instructions")).toContainText(
      "Original procedure.",
    );
    await installedInstructions
      .getByLabel("Instructions and references")
      .selectOption("references/recovery.md");
    await expect(installedInstructions.getByLabel("Retained Skill instructions")).toContainText(
      "survive a process restart",
    );
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(installedInstructions).toHaveCount(0);
    await expect(inspectInstalled).toBeFocused();
    await page.screenshot({
      path: test.info().outputPath("skills-library-mobile.png"),
      animations: "disabled",
    });
    await page.context().setOffline(true);
    await expect(library).toContainText("Skill Library is offline");
    await expect(library).not.toContainText("Clarify recovery requirements.");
    await page.context().setOffline(false);
    await expect(library).toContainText("Clarify recovery requirements.");
    await page.goBack();
    await expect(page).toHaveURL(/\/settings\/profile$/u);
    await page.goForward();
    await expect(page).toHaveURL(/\/settings\/skills$/u);
    await page.goto(new URL("/settings/skills", requireStack().pwaUrl).toString());
    await expect(library).toContainText("Clarify recovery requirements.");
    await page.setViewportSize({ width: 1024, height: 800 });
    await writeFile(skillFile, entry("Updated procedure for future turns."));
    await workstation
      .getByLabel("Host Skill to import")
      .selectOption({ label: "recovery-checklist" });
    await workstation.getByRole("button", { name: "Import Skill", exact: true }).click();
    await expect(library.getByRole("button", { name: "Inspect recovery-checklist" })).toHaveCount(
      1,
    );
    await library.getByRole("button", { name: "Inspect recovery-checklist" }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Installed Skill instructions" })
        .getByLabel("Retained Skill instructions"),
    ).toContainText("Updated procedure for future turns.");
    await page.keyboard.press("Escape");
    await page.goto(featureUrl);
    const activeSkills = page.getByRole("region", { name: "Active Planning Skills" });
    await expect(activeSkills).toContainText("$recovery-checklist");
    await activeSkills.getByRole("button", { name: "Remove recovery-checklist" }).click();
    await expect(activeSkills).toHaveCount(0);
    await page
      .getByLabel("Message", { exact: true })
      .fill("/recovery-checklist Continue planning with the updated procedure.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(
      page.getByText("/recovery-checklist Continue planning with the updated procedure."),
    ).toBeVisible();
    await page.reload();
    await page
      .getByRole("button", {
        name: `Used $recovery-checklist · ${original.contentDigest.slice(0, 8)}`,
        exact: true,
      })
      .click();
    const retained = page.getByRole("dialog", {
      name: "Skill used for this artifact",
      exact: true,
    });
    await expect(retained.getByLabel("Retained Skill instructions")).toContainText(
      "Original procedure.",
    );
    await expect(retained.getByLabel("Retained Skill instructions")).not.toContainText(
      "Updated procedure",
    );
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: test.info().outputPath("planning-skill-retained.png"),
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(retained).toHaveCount(0);
    const latestChat = await chat();
    expect(latestChat.skills?.skills).toHaveLength(1);
    expect(latestChat.skills?.skills[0]?.contentDigest).not.toBe(original.contentDigest);
    expect(latestChat.turns[0]?.skills?.[0]?.contentDigest).toBe(original.contentDigest);
  });

  test("invokes two installed Skills inline in both composers and rejects an unknown first message atomically", async ({
    page,
  }) => {
    await page.goto(requireStack().pwaUrl);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password", { exact: true }).fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Open Project", exact: true }).click();
    const repositoryDialog = page.getByRole("dialog", { name: "Open an authorized repository" });
    const repositoryId = await repositoryDialog
      .getByRole("option")
      .filter({ hasText: "kestrel" })
      .first()
      .getAttribute("value");
    if (repositoryId === null) throw new Error("Fixture repository has no identity");
    await repositoryDialog.getByLabel("Repository", { exact: true }).selectOption(repositoryId);
    await repositoryDialog.getByRole("button", { name: "Open selected Project" }).click();
    await expect(repositoryDialog).toHaveCount(0);
    const projectUrl = page.url();
    const featuresPath = `/api/v1${new URL(projectUrl).pathname}/features`;
    const featureCount = async () =>
      FeatureListSchema.parse(
        await page.evaluate(
          async (path) => (await fetch(path)).json() as Promise<unknown>,
          featuresPath,
        ),
      ).features.length;
    const before = await featureCount();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("link", { name: "Skills" })
      .click();
    const workstation = page.getByRole("region", { name: "Import from workstation" });
    for (const name of ["recovery-checklist", "research"]) {
      await workstation.getByLabel("Host Skill to import").selectOption({ label: name });
      await workstation.getByRole("button", { name: "Import Skill", exact: true }).click();
      await expect(page.getByRole("region", { name: "Installed Skills" })).toContainText(
        `$${name}`,
      );
    }
    await page.goto(projectUrl);
    await page.getByRole("button", { name: "New plan", exact: true }).click();
    const prompt = page.getByLabel("Describe the change", { exact: true });
    await prompt.fill("/missing Help plan reports");
    await page.getByRole("main").getByRole("button", { name: "Start plan", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("not installed");
    await expect(
      page.getByRole("alert").getByRole("link", { name: "Open Settings → Skills" }),
    ).toBeVisible();
    expect(await featureCount()).toBe(before);
    await page.setViewportSize({ width: 375, height: 812 });
    await prompt.fill("/rec");
    await expect(page.getByRole("option", { name: /\/recovery-checklist/u })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await prompt.press("Enter");
    await expect(prompt).toHaveValue("/recovery-checklist ");
    await prompt.pressSequentially("/rese");
    await expect(page.getByRole("option", { name: /\/research/u })).toBeVisible();
    await prompt.press("Enter");
    await prompt.pressSequentially("Help plan reports");
    const authored = "/recovery-checklist /research Help plan reports";
    await expect(prompt).toHaveValue(authored);
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.getByRole("main").getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByText("Codex is unavailable", { exact: true })).toBeVisible();
    expect(await featureCount()).toBe(before + 1);
    const featureUrl = page.url();
    const chatPath = `/api/v1${new URL(featureUrl).pathname}`;
    const readChat = async () =>
      FeatureChatSchema.parse(
        await page.evaluate(
          async (path) => (await fetch(path)).json() as Promise<unknown>,
          chatPath,
        ),
      );
    let chat = await readChat();
    expect(chat.messages[0]?.content).toBe(authored);
    expect(chat.turns[0]?.skills?.map((skill) => skill.name).sort()).toEqual([
      "recovery-checklist",
      "research",
    ]);
    await page.reload();
    const activeSkills = page.getByRole("region", { name: "Active Planning Skills" });
    await expect(activeSkills).toContainText("$recovery-checklist");
    await expect(activeSkills).toContainText("$research");
    await activeSkills.getByRole("button", { name: "Remove research" }).focus();
    await page.keyboard.press("Enter");
    await expect(activeSkills).not.toContainText("$research");
    await page.reload();
    await expect(activeSkills).toContainText("$recovery-checklist");
    await expect(activeSkills).not.toContainText("$research");
    expect((await readChat()).turns[0]?.skills?.map((skill) => skill.name).sort()).toEqual([
      "recovery-checklist",
      "research",
    ]);
    const followup = page.getByLabel("Message", { exact: true });
    await followup.fill("Continue with /recovery-checklist.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByText("Continue with /recovery-checklist.")).toBeVisible();
    await page.reload();
    chat = await readChat();
    expect(chat.messages.at(-1)?.content).toBe("Continue with /recovery-checklist.");
    expect(
      chat.turns
        .at(-1)
        ?.skills?.map((skill) => skill.name)
        .sort(),
    ).toEqual(["recovery-checklist"]);
    await page.setViewportSize({ width: 375, height: 812 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});
