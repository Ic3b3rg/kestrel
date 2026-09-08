import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  FeatureChatSchema,
  PlanningSkillBundleSchema,
  PlanningSkillCandidatesSchema,
  FeatureListSchema,
  FeatureSchema,
  FeaturePlanVersionSchema,
  FeaturePlansSchema,
  FactoryBoardSchema,
  LocalRepositoryInventorySchema,
  PlanningTurnAcceptedSchema,
  ProjectUpsertedSchema,
} from "@kestrel/contracts";
import {
  bootstrapOperator,
  createPgBoss,
  createPool,
  FACTORY_PLANNING_QUEUE,
  FACTORY_PLANNING_QUEUE_OPTIONS,
  FACTORY_PUBLICATION_QUEUE,
  FACTORY_PUBLICATION_QUEUE_OPTIONS,
  migrate,
  openLocalProject,
} from "@kestrel/database";
import { readLocalSourceConfig } from "@kestrel/local-source";

import { buildApp } from "./app.js";
import { createCodexAppServerAgentRuntime } from "./codex-app-server.js";
import { createCodexPlanningRuntime } from "./codex-planning-runtime.js";
import {
  createFactoryPlanningProcessor,
  FACTORY_PLANNING_WORK_OPTIONS,
} from "./factory-planning.js";
import { hashPassword } from "./password.js";
import { createLocalRepositoryService } from "./routes/local-repository-sources.js";
import { createDatabaseProjectService } from "./routes/projects.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "./session.js";

const execFileAsync = promisify(execFile);

async function executable(name: string): Promise<string> {
  if (name === "docker" && process.platform === "darwin") {
    const bundled = "/Applications/Docker.app/Contents/Resources/bin/docker";
    if (
      await access(bundled).then(
        () => true,
        () => false,
      )
    )
      return bundled;
  }
  const { stdout } = await execFileAsync("/usr/bin/which", [name], {
    timeout: 5_000,
    maxBuffer: 1_024,
  });
  return realpath(stdout.trim());
}

describe.runIf(process.env.KESTREL_LIVE_CODEX === "1")(
  "Factory planning live HTTP conformance",
  () => {
    it("saves and resumes chat, generates a versioned plan and approves its board through real Codex", async () => {
      const [docker, git, codex] = await Promise.all([
        executable("docker"),
        executable("git"),
        process.env.KESTREL_CODEX_EXECUTABLE === undefined
          ? executable("codex")
          : realpath(process.env.KESTREL_CODEX_EXECUTABLE),
      ]);
      const directory = await realpath(await mkdtemp(join(tmpdir(), "kestrel-factory-live-")));
      const container = `kestrel-factory-live-${randomUUID()}`;
      const runDocker = (args: string[]) =>
        execFileAsync(docker, args, { timeout: 25_000, maxBuffer: 65_536 });
      const repositoryRoot = join(directory, "repositories");
      const repository = join(repositoryRoot, "notes");
      const artifactRoot = join(directory, "artifacts");
      const skillRoot = join(directory, "planning-skills");
      const previousSkillRoot = process.env.KESTREL_PLANNING_SKILL_ROOT;
      const runGit = (args: string[]) =>
        execFileAsync(git, args, {
          cwd: repository,
          timeout: 5_000,
          maxBuffer: 65_536,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
          },
        });
      let owner: ReturnType<typeof createPool> | undefined;
      let pool: ReturnType<typeof createPool> | undefined;
      let migrator: ReturnType<typeof createPgBoss> | undefined;
      let boss: ReturnType<typeof createPgBoss> | undefined;
      let app: Awaited<ReturnType<typeof buildApp>> | undefined;
      let queueFailed = false;
      const committed =
        "# Notes fixture\nNotes have a title and Markdown body. Export is requested, but format and scope are undecided.\n";
      const dirty =
        "# DIRTY_CANARY\nThis uncommitted text must never enter the planning context.\n";
      const untracked = "UNTRACKED_CANARY: preserve this operator file.\n";
      try {
        await mkdir(repository, { recursive: true });
        await mkdir(artifactRoot, { mode: 0o700 });
        await mkdir(join(skillRoot, "unicode-export"), { recursive: true });
        await writeFile(
          join(skillRoot, "unicode-export/SKILL.md"),
          "---\nname: unicode-export\ndescription: Clarify Unicode export guarantees.\n---\nFollow the [Unicode checklist](unicode-checklist.md) when discussing exports and generating their plan.\n",
        );
        await writeFile(
          join(skillRoot, "unicode-export/unicode-checklist.md"),
          "Before finalizing the export, ask whether accented characters and emoji must remain unchanged. Include the exact phrase Unicode round-trip in that question. Once the Operator agrees, preserve that guarantee in the generated plan and include an explicit Unicode or emoji example in an acceptance outcome.\n",
        );
        process.env.KESTREL_PLANNING_SKILL_ROOT = skillRoot;
        await runGit(["init", "--initial-branch=main"]);
        await writeFile(join(repository, "CONTEXT.md"), committed);
        await writeFile(
          join(repository, "AGENTS.md"),
          "# Repository instructions\nDiscuss acceptance criteria before proposing implementation.\n",
        );
        await runGit(["add", "CONTEXT.md", "AGENTS.md"]);
        await runGit([
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "Create disposable planning context",
        ]);
        const { stdout: commitOutput } = await runGit(["rev-parse", "HEAD"]);
        await writeFile(join(repository, "CONTEXT.md"), dirty);
        await writeFile(join(repository, "untracked.md"), untracked);
        const before = await runGit(["status", "--porcelain=v1"]);

        await runDocker([
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
        const readyUntil = Date.now() + 20_000;
        let databaseReady = false;
        while (!databaseReady && Date.now() < readyUntil) {
          try {
            await runDocker([
              "exec",
              container,
              "pg_isready",
              "--host=127.0.0.1",
              "--username=postgres",
              "--dbname=kestrel",
            ]);
            databaseReady = true;
          } catch {
            await delay(100);
          }
        }
        if (!databaseReady) throw new Error("Disposable PostgreSQL did not become ready");
        const { stdout: binding } = await runDocker(["port", container, "5432/tcp"]);
        const port = /^127\.0\.0\.1:(\d+)\s*$/u.exec(binding)?.[1];
        if (port === undefined) throw new Error("Disposable PostgreSQL did not bind to loopback");
        const databaseUrl = `postgres://postgres@127.0.0.1:${port}/kestrel`;
        owner = createPool(databaseUrl, "factory-live-migrate");
        migrator = createPgBoss({
          applicationName: "factory-live-migrate",
          databaseUrl,
          migrate: true,
        });
        migrator.on("error", () => {
          queueFailed = true;
        });
        await migrator.start();
        await migrate(owner);
        await migrator.createQueue(FACTORY_PLANNING_QUEUE, FACTORY_PLANNING_QUEUE_OPTIONS);
        await migrator.createQueue(FACTORY_PUBLICATION_QUEUE, FACTORY_PUBLICATION_QUEUE_OPTIONS);
        const credentials = { username: "factory-fixture", password: `Fixture-${randomUUID()}` };
        await bootstrapOperator(owner, {
          username: credentials.username,
          passwordHash: await hashPassword(credentials.password),
        });
        // Only the owned loopback fixture trusts connections; application queries use the production role grants.
        await owner.query("ALTER ROLE kestrel_runtime LOGIN");
        await migrator.stop({ graceful: false });
        migrator = undefined;
        const runtimeUrl = `postgres://kestrel_runtime@127.0.0.1:${port}/kestrel`;
        pool = createPool(runtimeUrl, "factory-live-runtime");
        boss = createPgBoss({ applicationName: "factory-live-runtime", databaseUrl: runtimeUrl });
        boss.on("error", () => {
          queueFailed = true;
        });
        await boss.start();
        const sourceConfig = await readLocalSourceConfig({
          LOCAL_REPOSITORY_ROOTS: JSON.stringify([repositoryRoot]),
          ARTIFACT_ROOT: artifactRoot,
          LOCAL_GIT_EXECUTABLE: git,
          REVIEW_REVISION_MAX_BYTES: "1000000",
          REVIEW_REVISION_MAX_OBJECTS: "1000",
        });
        const localRepositoryService = createLocalRepositoryService(sourceConfig, pool);
        const connection = createCodexAppServerAgentRuntime({ executable: codex });
        const runtime = createCodexPlanningRuntime({ executable: codex, timeoutMs: 45_000 });
        const processor = createFactoryPlanningProcessor({
          pool,
          connection,
          runtime,
          readSourceConfig: () => Promise.resolve(sourceConfig),
        });
        await boss.work<unknown>(
          FACTORY_PLANNING_QUEUE,
          FACTORY_PLANNING_WORK_OPTIONS,
          async (jobs) => {
            const job = jobs[0];
            if (job !== undefined) await processor.process(job.data, job.signal);
          },
        );
        const runtimePool = pool;
        app = await buildApp({
          pool,
          boss,
          logger: false,
          eventRetentionLimit: 100,
          sessionSigningKey: randomBytes(32),
          codexAgentRuntime: connection,
          localRepositoryService,
          projectService: createDatabaseProjectService(pool, boss, async (command, context) =>
            openLocalProject(runtimePool, {
              ...context,
              source: await localRepositoryService.inspectProjectSource(command.repositoryId),
            }),
          ),
        });
        const origin = await app.listen({ host: "127.0.0.1", port: 0 });
        expect(
          (await fetch(`${origin}/api/v1/projects`, { signal: AbortSignal.timeout(5_000) })).status,
        ).toBe(401);
        const login = await fetch(`${origin}/auth/login`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify(credentials),
          signal: AbortSignal.timeout(5_000),
        });
        expect(login.status).toBe(200);
        const cookies = login.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0] ?? "");
        const csrf = cookies
          .find((cookie) => cookie.startsWith(`${CSRF_COOKIE_NAME}=`))
          ?.slice(CSRF_COOKIE_NAME.length + 1);
        if (csrf === undefined) throw new Error("HTTP login did not issue the CSRF cookie");
        const request = (path: string, body?: unknown) =>
          fetch(`${origin}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              origin,
              cookie: cookies.join("; "),
              [CSRF_HEADER_NAME]: csrf,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(5_000),
          });
        const inventory = LocalRepositoryInventorySchema.parse(
          await (await request("/api/v1/local-repository-sources")).json(),
        );
        expect(inventory.repositories).toHaveLength(1);
        const opened = ProjectUpsertedSchema.parse(
          await (
            await request("/api/v1/projects/local", {
              repositoryId: inventory.repositories[0]?.repositoryId,
            })
          ).json(),
        );
        const collection = `/api/v1/projects/${opened.project.id}/features`;
        const creation = await request(collection, {
          requestId: randomUUID(),
          title: "Export notes",
        });
        expect(creation.status).toBe(201);
        const feature = FeatureSchema.parse(await creation.json());
        const path = `${collection}/${feature.id}`;
        const readChat = async () => FeatureChatSchema.parse(await (await request(path)).json());
        const candidates = PlanningSkillCandidatesSchema.parse(
          await (await request("/api/v1/planning-skills/candidates")).json(),
        );
        expect(candidates.candidates).toHaveLength(1);
        const imported = await request("/api/v1/planning-skills/install", {
          requestId: randomUUID(),
          candidateId: candidates.candidates[0]?.candidateId,
        });
        expect(imported.status).toBe(201);
        const skill = PlanningSkillBundleSchema.parse(await imported.json());
        expect(skill.files.map((file) => file.path)).toEqual(["SKILL.md", "unicode-checklist.md"]);
        expect(
          (
            await request(`${path}/skills`, {
              requestId: randomUUID(),
              expectedVersion: 0,
              digests: [skill.contentDigest],
            })
          ).status,
        ).toBe(200);
        for (const text of [
          "Voglio esportare le note. Fai una domanda breve sul requisito mancante, citando CONTEXT.md.",
          "Confermo Markdown e tutte le note. I caratteri accentati e le emoji devono restare identici. Registra la decisione e chiedi un ultimo criterio verificabile, in modo breve.",
        ]) {
          const sent = await request(`${path}/messages`, {
            requestId: randomUUID(),
            text,
            skillSelectionVersion: 1,
          });
          expect(sent.status).toBe(202);
          const accepted = PlanningTurnAcceptedSchema.parse(await sent.json());
          const until = Date.now() + 55_000;
          let completed = false;
          while (!completed && Date.now() < until) {
            const chat = await readChat();
            const turn = chat.turns.find(({ id }) => id === accepted.turnId);
            expect(
              chat.messages.some(
                ({ id, content }) => id === accepted.messageId && content === text,
              ),
            ).toBe(true);
            if (turn !== undefined && turn.state !== "queued" && turn.state !== "running") {
              expect({ state: turn.state, failure: turn.failure }).toEqual({
                state: "completed",
                failure: null,
              });
              completed = true;
            } else {
              await delay(250);
            }
          }
          if (!completed)
            throw new Error("Accepted planning turn did not reach a durable terminal state");
        }
        const chat = await readChat();
        expect(chat.messages.map(({ role }) => role)).toEqual([
          "user",
          "assistant",
          "user",
          "assistant",
        ]);
        for (const message of chat.messages.filter(({ role }) => role === "assistant")) {
          expect(message.content.length).toBeGreaterThan(10);
          expect(message.content.length).toBeLessThanOrEqual(32_000);
        }
        expect(chat.messages.find((message) => message.role === "assistant")?.content).toContain(
          "Unicode round-trip",
        );
        expect(
          chat.turns.every((turn) => turn.skills?.[0]?.contentDigest === skill.contentDigest),
        ).toBe(true);
        expect(chat.context?.skills?.[0]?.contentDigest).toBe(skill.contentDigest);
        expect(chat.context?.commitId).toBe(commitOutput.trim());
        expect(
          chat.context?.documents.find(({ path: documentPath }) => documentPath === "CONTEXT.md")
            ?.content,
        ).toBe(committed);
        expect(
          chat.context?.documents.some(({ path: documentPath }) => documentPath === "AGENTS.md"),
        ).toBe(true);
        const publicResponse = JSON.stringify(chat);
        expect(publicResponse).not.toContain(directory);
        expect(publicResponse).not.toContain(homedir());
        expect(publicResponse).not.toMatch(
          /DIRTY_CANARY|UNTRACKED_CANARY|runtime_thread_id|auth\.json|access_token|refresh_token/u,
        );
        expect(
          FeatureListSchema.parse(await (await request(collection)).json()).features.map(
            ({ id }) => id,
          ),
        ).toEqual([feature.id]);
        // The Operator makes the remaining acceptance and verification decisions in an editable draft.
        const draft = await request(`${path}/plans`, {
          requestId: randomUUID(),
          expectedVersion: null,
          plan: {
            objective: "Export all notes to Markdown",
            scope: {
              includes: ["Export every note title and Markdown body to one Markdown document"],
              excludes: ["Other formats", "Selected-note export", "Changes to notes"],
            },
            acceptance: [
              {
                key: "export",
                outcome:
                  "The export contains every note title and unchanged body, in the existing note order",
              },
            ],
            workItems: [
              {
                key: "export",
                importedIssueId: null,
                title: "Implement and verify the Markdown export",
                description:
                  "Add one export operation without changing stored notes. Include all note titles and unchanged bodies in current order. Add the Node regression file tests/export.test.mjs as part of the work.",
                requirementKeys: ["export"],
                acceptance: [
                  "All notes appear in existing order with unchanged content",
                  "Stored notes remain unchanged after export",
                ],
                dependsOn: [],
                verification: [
                  {
                    program: "node",
                    args: ["--test", "tests/export.test.mjs"],
                    cwd: ".",
                    timeoutSeconds: 60,
                  },
                ],
              },
            ],
            limits: {
              maxConcurrentProjects: 2,
              maxActiveFeaturesPerProject: 1,
              attemptTimeoutSeconds: 1800,
            },
          },
        });
        expect(draft.status).toBe(201);
        expect(FeaturePlanVersionSchema.parse(await draft.json()).version).toBe(1);
        const generation = await request(`${path}/plans/generate`, {
          requestId: randomUUID(),
          expectedVersion: 1,
          skillSelectionVersion: 1,
        });
        expect(generation.status).toBe(202);
        const generatedTurn = PlanningTurnAcceptedSchema.parse(await generation.json());
        await expect
          .poll(
            async () => {
              const plans = FeaturePlansSchema.parse(await (await request(`${path}/plans`)).json());
              return (
                plans.generation !== null && !["queued", "running"].includes(plans.generation.state)
              );
            },
            { timeout: 55_000, interval: 500 },
          )
          .toBe(true);
        const plans = FeaturePlansSchema.parse(await (await request(`${path}/plans`)).json());
        expect(plans.generation).toMatchObject({ state: "completed", failure: null });
        expect(plans.generation?.id).toBe(generatedTurn.turnId);
        expect(plans.current?.version).toBe(2);
        expect(plans.current?.author).toBe("assistant");
        expect(plans.current?.sourceContext?.commitId).toBe(commitOutput.trim());
        expect(plans.current?.planMarkdown).toContain(commitOutput.trim());
        expect(plans.current?.sourceContext?.skills?.[0]?.contentDigest).toBe(skill.contentDigest);
        expect(plans.current?.planMarkdown).toContain(skill.contentDigest);
        expect(JSON.stringify(plans.current?.document.acceptance)).toMatch(
          /unicode|emoji|accent/iu,
        );
        expect(plans.current?.document.workItems.length).toBeGreaterThan(0);
        expect(plans.current?.document.limits.attemptTimeoutSeconds).toBe(1800);
        const approval = await request(`${path}/plans/2/approve`, { requestId: randomUUID() });
        expect(approval.status).toBe(200);
        const board = FactoryBoardSchema.parse(await approval.json());
        expect(board.feature.state).toBe("queued");
        expect(board.columns[0]?.items).toHaveLength(plans.current?.document.workItems.length ?? 0);
        expect(board.columns.slice(1).every(({ items }) => items.length === 0)).toBe(true);
        expect(await readFile(join(repository, "CONTEXT.md"), "utf8")).toBe(dirty);
        expect(await readFile(join(repository, "untracked.md"), "utf8")).toBe(untracked);
        expect((await runGit(["status", "--porcelain=v1"])).stdout).toBe(before.stdout);
        expect((await runGit(["rev-parse", "HEAD"])).stdout).toBe(commitOutput);
        expect(queueFailed).toBe(false);
      } finally {
        if (previousSkillRoot === undefined) delete process.env.KESTREL_PLANNING_SKILL_ROOT;
        else process.env.KESTREL_PLANNING_SKILL_ROOT = previousSkillRoot;
        await Promise.allSettled([
          app?.close(),
          boss?.stop({ graceful: false }),
          migrator?.stop({ graceful: false }),
        ]);
        await Promise.allSettled([pool?.end(), owner?.end()]);
        await runDocker(["rm", "--force", container]).catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    }, 210_000);
  },
);
