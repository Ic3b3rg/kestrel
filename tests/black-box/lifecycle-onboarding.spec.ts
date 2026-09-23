import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  bootstrapOperator,
  createPool,
  createPgBoss,
  migrate,
  openLocalProject,
  FACTORY_PLANNING_QUEUE,
  FACTORY_PLANNING_QUEUE_OPTIONS,
} from "@kestrel/database";
import { createManagedSourceService, readLocalSourceConfig } from "@kestrel/local-source";
import { buildApp } from "../../apps/web/src/app.js";
import { createCodexAppServerAgentRuntime } from "../../apps/web/src/codex-app-server.js";
import { hashPassword } from "../../apps/web/src/password.js";
import { createSourceOnboardingService } from "../../apps/web/src/source-onboarding.js";
import { createLocalRepositoryService } from "../../apps/web/src/routes/local-repository-sources.js";
import { createDatabaseProjectService } from "../../apps/web/src/routes/projects.js";
import { codexConnectionFixture } from "./support/codex-connection-fixture.js";

const run = promisify(execFile);

test("authorizes folders, recovers a clone and freezes a Project profile through real HTTP and storage", async ({
  page,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "kestrel-ux-browser-")));
  const container = `kestrel-ux-browser-${randomUUID()}`;
  const docker =
    process.platform === "darwin"
      ? "/Applications/Docker.app/Contents/Resources/bin/docker"
      : "docker";
  const dockerRun = (args: string[]) => run(docker, args, { timeout: 30_000, maxBuffer: 65536 });
  const state = join(directory, "state");
  const repository = join(directory, "sources", "notes");
  const env = {
    KESTREL_STATE_ROOT: state,
    ARTIFACT_ROOT: join(state, "artifacts"),
    LOCAL_REPOSITORY_ROOTS_FILE: join(state, "roots.json"),
    LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
    REVIEW_REVISION_MAX_BYTES: "1048576",
    REVIEW_REVISION_MAX_OBJECTS: "1000",
  };
  const credentials = { username: "ux-operator", password: `Fixture-${randomUUID()}` };
  const previousSkillRoot = process.env.KESTREL_PLANNING_SKILL_ROOT;
  let owner: ReturnType<typeof createPool> | undefined;
  let pool: ReturnType<typeof createPool> | undefined;
  let boss: ReturnType<typeof createPgBoss> | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await mkdir(repository, { recursive: true });
    await mkdir(env.ARTIFACT_ROOT, { recursive: true, mode: 0o700 });
    await mkdir(join(directory, "skills"));
    process.env.KESTREL_PLANNING_SKILL_ROOT = join(directory, "skills");
    await run("/usr/bin/git", ["init", "--initial-branch=main", repository]);
    await writeFile(join(repository, "README.md"), "# Disposable notes\n");
    await run("/usr/bin/git", ["-C", repository, "add", "."]);
    await run("/usr/bin/git", [
      "-C",
      repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Initial notes",
    ]);
    const codex = join(directory, "codex-fixture");
    await writeFile(
      codex,
      codexConnectionFixture.replace("#!/usr/local/bin/node", `#!${process.execPath}`),
      { mode: 0o700 },
    );
    await dockerRun([
      "run",
      "--detach",
      "--rm",
      "--pull=never",
      "--name",
      container,
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "--env",
      "POSTGRES_DB=kestrel",
      "--publish",
      "127.0.0.1::5432",
      "postgres:18.6-alpine",
    ]);
    for (let attempt = 0; ; attempt++) {
      try {
        await dockerRun([
          "exec",
          container,
          "pg_isready",
          "--host=127.0.0.1",
          "--username=postgres",
        ]);
        break;
      } catch (error) {
        if (attempt >= 50) throw error;
        await delay(200);
      }
    }
    const { stdout: binding } = await dockerRun(["port", container, "5432/tcp"]);
    const port = /^127\.0\.0\.1:(\d+)\s*$/u.exec(binding)?.[1];
    if (!port) throw new Error("Owned database did not bind to loopback");
    const databaseUrl = `postgres://postgres@127.0.0.1:${port}/kestrel`;
    owner = createPool(databaseUrl, "ux-browser-migrate");
    boss = createPgBoss({ applicationName: "ux-browser-migrate", databaseUrl, migrate: true });
    await boss.start();
    await migrate(owner);
    await boss.createQueue(FACTORY_PLANNING_QUEUE, FACTORY_PLANNING_QUEUE_OPTIONS);
    await bootstrapOperator(owner, {
      username: credentials.username,
      passwordHash: await hashPassword(credentials.password),
    });
    await owner.query("ALTER ROLE kestrel_runtime LOGIN");
    await boss.stop();
    const runtimeUrl = `postgres://kestrel_runtime@127.0.0.1:${port}/kestrel`;
    pool = createPool(runtimeUrl, "ux-browser-runtime");
    boss = createPgBoss({ applicationName: "ux-browser-runtime", databaseUrl: runtimeUrl });
    await boss.start();
    const runtimePool = pool;
    const reload = () => readLocalSourceConfig(env);
    const local = createLocalRepositoryService(await reload(), pool, reload);
    let chooseCount = 0;
    let cloneCount = 0;
    const managed = createManagedSourceService(env, async ({ destination }) => {
      cloneCount++;
      if (cloneCount === 1) {
        await mkdir(destination);
        throw new Error("Interrupted transport");
      }
      await run("/usr/bin/git", ["clone", "--quiet", "--no-local", repository, destination]);
    });
    const options = {
      pool,
      boss,
      eventRetentionLimit: 100,
      logger: false,
      sessionSigningKey: randomBytes(32),
      pwaRoot: resolve("apps/pwa/dist"),
      codexAgentRuntime: createCodexAppServerAgentRuntime({ executable: codex }),
      sourceOnboardingService: createSourceOnboardingService(env, async () =>
        ++chooseCount === 1 ? null : join(directory, "sources"),
      ),
      managedSourceService: managed,
      localRepositoryService: local,
      projectService: createDatabaseProjectService(pool, boss, async (command, context) =>
        openLocalProject(runtimePool, {
          ...context,
          source: await local.inspectProjectSource(command.repositoryId),
        }),
      ),
    };
    app = await buildApp(options);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    await page.goto(origin);
    await page.getByLabel("Username").fill(credentials.username);
    await page.getByLabel("Password", { exact: true }).fill(credentials.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Open Project", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Open an authorized repository" });
    await dialog.getByRole("button", { name: "Local folder", exact: true }).click();
    await expect(dialog.getByText("Folder selection cancelled.", { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: "Local folder", exact: true }).click();
    await expect(dialog.getByText("Authorize these repositories?", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("option").filter({ hasText: "notes" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Authorize repositories", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("option").filter({ hasText: "notes" })).toHaveCount(1);
    await dialog.getByRole("button", { name: "Clone from Git URL", exact: true }).click();
    const url = dialog.getByLabel("Git URL", { exact: true });
    await url.fill("https://github.com/example/remote-notes.git");
    await dialog.getByRole("button", { name: "Clone repository", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeFocused();
    await expect(url).toHaveValue("https://github.com/example/remote-notes.git");
    await dialog.getByRole("button", { name: "Clone repository", exact: true }).click();
    await expect(dialog.getByRole("option").filter({ hasText: "remote-notes" })).toHaveCount(1);
    expect(cloneCount).toBe(2);
    await page.setViewportSize({ width: 375, height: 812 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("onboarding-narrow.png"),
      animations: "disabled",
    });
    const sourceId = await dialog
      .getByRole("option")
      .filter({ hasText: /^notes/u })
      .getAttribute("value");
    if (!sourceId) throw new Error("Authorized fixture source is absent");
    await dialog.getByLabel("Repository", { exact: true }).selectOption(sourceId);
    await dialog.getByRole("button", { name: "Open selected Project", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const projectUrl = page.url();
    const projectId = new URL(projectUrl).pathname.split("/")[2];
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${origin}/projects/${projectId}/settings`);
    await page.getByLabel("Model", { exact: true }).selectOption("value:gpt-6-astra");
    await page.getByLabel("Reasoning effort", { exact: true }).selectOption("value:high");
    await page.getByLabel("Speed", { exact: true }).selectOption("standard");
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect(page.getByText("Profile saved for future work.", { exact: false })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("value:gpt-6-astra");
    await page.goto(projectUrl);
    await page.getByRole("button", { name: "New plan", exact: true }).click();
    await page
      .getByLabel("Describe the change", { exact: true })
      .fill("Export all notes without changing them.");
    await expect(
      page.getByText("gpt-6-astra · Effort: high · Speed: Standard", { exact: true }),
    ).toBeVisible();
    await page.getByRole("main").getByRole("button", { name: "Start plan", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "New plan", exact: true, level: 1 }),
    ).toBeVisible();
    const frozen = await owner.query<{
      lifecycle_profile: { modelId: string; effort: string; serviceTier: string };
    }>(
      "SELECT lifecycle_profile FROM factory_planning_turns WHERE feature_id IN (SELECT id FROM factory_features WHERE project_id = $1)",
      [projectId],
    );
    expect(frozen.rows).toHaveLength(1);
    expect(frozen.rows[0]?.lifecycle_profile).toMatchObject({
      modelId: "gpt-6-astra",
      effort: "high",
      serviceTier: "default",
    });
    await app.close();
    app = await buildApp(options);
    await app.listen({ host: "127.0.0.1", port: Number(new URL(origin).port) });
    await page.reload();
    await expect(
      page.getByText("Export all notes without changing them.", { exact: true }),
    ).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  } finally {
    await app?.close();
    await boss?.stop({ graceful: false });
    await pool?.end();
    await owner?.end();
    await dockerRun(["rm", "--force", container]).catch(() => undefined);
    if (previousSkillRoot === undefined) delete process.env.KESTREL_PLANNING_SKILL_ROOT;
    else process.env.KESTREL_PLANNING_SKILL_ROOT = previousSkillRoot;
    await rm(directory, { recursive: true, force: true });
  }
});
