import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { FeatureChatSchema } from "@kestrel/contracts";
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
    stack = await startStack({ repositoryRoot: fixture.rootPath, planningSkillRoot: root });
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
    await page.getByRole("button", { name: "New feature", exact: true }).click();
    const creation = page.getByRole("dialog", { name: "New feature", exact: true });
    await creation.getByLabel("Feature name", { exact: true }).fill("Recover saved reports");
    await creation.getByRole("button", { name: "Create feature", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Recover saved reports", level: 1 }),
    ).toBeVisible();
    const path = `/api/v1${new URL(page.url()).pathname}`;
    const chat = async () =>
      FeatureChatSchema.parse(
        await page.evaluate(async (path) => (await fetch(path)).json() as Promise<unknown>, path),
      );
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    const skills = page.getByRole("dialog", { name: "Planning Skills", exact: true });
    await skills.getByLabel("Host Skill to import").selectOption({ label: "recovery-checklist" });
    await skills.getByRole("button", { name: "Import Skill", exact: true }).click();
    await expect(skills.getByLabel("Retained Skill instructions")).toContainText(
      "Original procedure.",
    );
    await skills.getByLabel("Instructions and references").selectOption("references/recovery.md");
    await expect(skills.getByLabel("Retained Skill instructions")).toContainText(
      "survive a process restart",
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await skills.getByRole("button", { name: "Back to Skills" }).click();
    await skills.getByRole("checkbox", { name: "Use $recovery-checklist", exact: true }).check();
    await skills.getByRole("button", { name: "Use selected Skills" }).click();
    await expect(skills).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Skills (1)", exact: true })).toBeVisible();
    await page
      .getByLabel("Message", { exact: true })
      .fill("$recovery-checklist Help me specify recovering saved reports.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByText("Codex is unavailable", { exact: true })).toBeVisible();
    const original = (await chat()).turns[0]?.skills?.[0];
    expect(original?.name).toBe("recovery-checklist");
    if (original === undefined) throw new Error("The accepted turn did not retain its Skill");
    await writeFile(skillFile, entry("Updated procedure for future turns."));
    await page.getByRole("button", { name: "Skills (1)", exact: true }).click();
    await skills.getByLabel("Host Skill to import").selectOption({ label: "recovery-checklist" });
    await skills.getByRole("button", { name: "Import Skill", exact: true }).click();
    await expect(skills.getByLabel("Retained Skill instructions")).toContainText(
      "Updated procedure",
    );
    await skills.getByRole("button", { name: "Back to Skills" }).click();
    await expect(skills.getByRole("checkbox")).toHaveCount(2);
    const latest = skills.locator('input[type="checkbox"]:not(:checked)');
    await latest.check();
    await skills.getByRole("button", { name: "Use selected Skills" }).click();
    await expect(skills).toHaveCount(0);
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
});
