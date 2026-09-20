import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  CodexSubscriptionConnectionSchema,
  FactoryConceptualReviewPreparationSchema,
  FactoryConceptualReviewWorkflowReadSchema,
  FactoryBoardSchema,
  FactoryExecutionSchema,
  FactoryExecutionRunSchema,
  FactoryFeaturePublicationSchema,
  FeatureChatSchema,
  FeatureSchema,
  LocalRepositoryInventorySchema,
  PlanningFeatureStartedSchema,
  ProjectUpsertedSchema,
  type Feature,
  type FeaturePlanDocument,
} from "@kestrel/contracts";
import { bootstrapOperator, createPool } from "@kestrel/database";
import { createFactoryFeaturePublicationFixture } from "./support/factory-feature-publication-fixture.js";
import { hashPassword } from "../../apps/web/src/password.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../apps/web/src/session.js";

const exec = promisify(execFile);
const rootDirectory = resolve(import.meta.dirname, "../..");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No loopback port");
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
  return address.port;
}

describe.runIf(process.env.KESTREL_LIVE_FACTORY_EXECUTION === "1")(
  "Factory execution live HTTP conformance",
  () => {
    it.each(["complete", "shutdown", "recovery", "recovery_removed"])(
      "runs the real Factory server through %s with an isolated Operator checkout",
      async (scenario) => {
        const image = process.env.KESTREL_FACTORY_EXECUTION_IMAGE;
        if (image === undefined)
          throw new Error("Prepare the executor image and set KESTREL_FACTORY_EXECUTION_IMAGE");
        const docker =
          process.env.KESTREL_FACTORY_DOCKER_EXECUTABLE ??
          (process.platform === "darwin"
            ? "/Applications/Docker.app/Contents/Resources/bin/docker"
            : "docker");
        const codex =
          process.env.KESTREL_CODEX_EXECUTABLE ??
          (await exec("/usr/bin/which", ["codex"])).stdout.trim();
        const git = (await exec("/usr/bin/which", ["git"])).stdout.trim();
        const directory = await realpath(
          await mkdtemp(join(tmpdir(), "kestrel-factory-execution-live-")),
        );
        const repositories = join(directory, "repositories");
        const repository = join(repositories, "fixture");
        const artifacts = join(directory, "artifacts");
        const secrets = join(directory, "secrets");
        const provider = join(directory, "github-fixture");
        const providerState = join(directory, "github-state.json");
        const publicationRemote = join(directory, "publication-remote.git");
        const publicationGit = join(directory, "publication-git");
        const publicationRemoteUrl = "https://github.com/fixture/factory-disposable.git";
        const databaseContainer = `kestrel-execution-live-${randomUUID()}`;
        const runDocker = (args: string[]) =>
          exec(docker, args, { timeout: 30_000, maxBuffer: 256_000 });
        const runGit = (args: string[]) =>
          exec(git, args, {
            cwd: repository,
            timeout: 10_000,
            maxBuffer: 1_000_000,
            env: {
              ...process.env,
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_SYSTEM: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_OPTIONAL_LOCKS: "0",
              GIT_TERMINAL_PROMPT: "0",
            },
          });
        let owner: ReturnType<typeof createPool> | undefined;
        let server: ChildProcess | undefined;
        let logs = "";
        const serverGroups = new Set<number>();
        const stopServerGroup = (pid: number) => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
          serverGroups.delete(pid);
        };
        const eventsAbort = new AbortController();
        const shutdownServer = async () => {
          const child = server;
          server = undefined;
          if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
          const closed = new Promise<void>((resolveClose) =>
            child.once("close", () => resolveClose()),
          );
          child.kill("SIGTERM");
          const force = setTimeout(() => child.kill("SIGKILL"), 40_000);
          try {
            await closed;
            if (child.pid !== undefined) stopServerGroup(child.pid);
          } finally {
            clearTimeout(force);
          }
        };
        try {
          await mkdir(repository, { recursive: true });
          await mkdir(artifacts, { mode: 0o700 });
          await mkdir(secrets, { mode: 0o700 });
          await runGit(["init", "--initial-branch=main"]);
          await runGit(["config", "user.name", "Factory fixture"]);
          await runGit(["config", "user.email", "factory@example.invalid"]);
          await runGit([
            "remote",
            "add",
            "origin",
            "https://github.com/fixture/factory-disposable.git",
          ]);
          await writeFile(
            join(repository, "CONTEXT.md"),
            "# Disposable Factory fixture\nThis Project exports a numeric value and a label. Only approved source modules should change.\n",
          );
          await writeFile(join(repository, ".gitignore"), "ignored-canary.txt\n");
          await writeFile(join(repository, "value.mjs"), "export const value = 1;\n");
          await writeFile(
            join(repository, "label.mjs"),
            "export function label() { return 'old'; }\n",
          );
          await writeFile(
            join(repository, "value.test.mjs"),
            "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './value.mjs'; test('approved value',()=>assert.equal(value,2));\n",
          );
          await writeFile(
            join(repository, "label.test.mjs"),
            "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './value.mjs'; import {label} from './label.mjs'; test('approved dependent label',()=>{assert.equal(value,2);assert.equal(label(),'Value 2');});\n",
          );
          await runGit(["add", "."]);
          await runGit([
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "Create disposable execution contract",
          ]);
          const base = (await runGit(["rev-parse", "HEAD"])).stdout.trim();
          await exec(git, ["clone", "--bare", "--no-local", repository, publicationRemote], {
            timeout: 10_000,
            maxBuffer: 1_000_000,
          });
          await writeFile(
            publicationGit,
            `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2).map(value=>value===${JSON.stringify(publicationRemoteUrl)}?${JSON.stringify(publicationRemote)}:value==='protocol.file.allow=never'?'protocol.file.allow=always':value);\nconst result=spawnSync(${JSON.stringify(git)},args,{env:process.env,stdio:'inherit'});\nif(result.error)throw result.error;process.exit(result.status??1);\n`,
            { mode: 0o700 },
          );
          await writeFile(
            join(repository, "value.mjs"),
            "export const value = 999; // DIRTY_OPERATOR_CANARY\n",
          );
          await writeFile(
            join(repository, "label.mjs"),
            "export function label() { return 'STAGED_OPERATOR_CANARY'; }\n",
          );
          await runGit(["add", "label.mjs"]);
          await writeFile(join(repository, "untracked.txt"), "UNTRACKED_OPERATOR_CANARY\n");
          await writeFile(join(repository, "ignored-canary.txt"), "IGNORED_OPERATOR_CANARY\n");
          const sourceBefore = (await runGit(["status", "--porcelain=v1", "--untracked-files=all"]))
            .stdout;
          const indexBefore = createHash("sha256")
            .update(await readFile(join(repository, ".git", "index")))
            .digest("hex");
          await writeFile(
            provider,
            createFactoryFeaturePublicationFixture({
              remotePath: publicationRemote,
              statePath: providerState,
            }).replace("#!/usr/local/bin/node", `#!${process.execPath}`),
            { mode: 0o700 },
          );
          await chmod(provider, 0o700);
          await runDocker([
            "run",
            "--detach",
            "--rm",
            "--pull=never",
            "--name",
            databaseContainer,
            "--env",
            "POSTGRES_HOST_AUTH_METHOD=trust",
            "--env",
            "POSTGRES_DB=kestrel",
            "--publish",
            "127.0.0.1::5432",
            "postgres:18.6-alpine",
          ]);
          await expect
            .poll(
              async () =>
                runDocker([
                  "exec",
                  databaseContainer,
                  "pg_isready",
                  "--host=127.0.0.1",
                  "--username=postgres",
                  "--dbname=kestrel",
                ]).then(
                  () => true,
                  () => false,
                ),
              { timeout: 25_000 },
            )
            .toBe(true);
          const binding = (await runDocker(["port", databaseContainer, "5432/tcp"])).stdout;
          const databasePort = /^127\.0\.0\.1:(\d+)\s*$/u.exec(binding)?.[1];
          if (databasePort === undefined) throw new Error("Database did not bind to loopback");
          const databaseUrl = `postgres://postgres@127.0.0.1:${databasePort}/kestrel`;
          await exec(process.execPath, ["packages/database/dist/migrate-cli.js"], {
            cwd: rootDirectory,
            env: { ...process.env, DATABASE_URL: databaseUrl },
            timeout: 30_000,
            maxBuffer: 256_000,
          });
          owner = createPool(databaseUrl, "execution-live-owner");
          await owner.query("ALTER ROLE kestrel_runtime LOGIN");
          const credentials = {
            username: "execution-fixture",
            password: `Fixture-${randomUUID()}`,
          };
          await bootstrapOperator(owner, {
            username: credentials.username,
            passwordHash: await hashPassword(credentials.password),
          });
          const port = await freePort();
          const origin = `http://127.0.0.1:${String(port)}`;
          const environment = {
            ...process.env,
            DATABASE_URL: `postgres://kestrel_runtime@127.0.0.1:${databasePort}/kestrel`,
            HOST: "127.0.0.1",
            PORT: String(port),
            ARTIFACT_ROOT: artifacts,
            MODEL_PROVIDER_SECRET_ROOT: secrets,
            LOCAL_REPOSITORY_ROOTS: JSON.stringify([repositories]),
            LOCAL_GIT_EXECUTABLE: publicationGit,
            REVIEW_REVISION_MAX_BYTES: "10000000",
            REVIEW_REVISION_MAX_OBJECTS: "10000",
            SESSION_SIGNING_KEY: randomBytes(32).toString("base64url"),
            KESTREL_CODEX_EXECUTABLE: codex,
            KESTREL_GH_EXECUTABLE: provider,
            KESTREL_FACTORY_DOCKER_EXECUTABLE: docker,
            KESTREL_FACTORY_EXECUTION_IMAGE: image,
          };
          const startServer = async () => {
            server = spawn(process.execPath, ["apps/web/dist/server.js"], {
              cwd: rootDirectory,
              env: environment,
              stdio: ["ignore", "pipe", "pipe"],
              detached: true,
            });
            if (server.pid !== undefined) serverGroups.add(server.pid);
            for (const stream of [server.stdout, server.stderr])
              stream?.on("data", (chunk: Buffer) => {
                logs = `${logs}${chunk.toString("utf8")}`.slice(-32_000);
              });
            await expect
              .poll(
                async () =>
                  fetch(`${origin}/api/v1/projects`).then(
                    (response) => response.status,
                    () => 0,
                  ),
                { timeout: 20_000 },
              )
              .toBe(401);
          };
          await startServer();
          const login = await fetch(`${origin}/auth/login`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify(credentials),
          });
          expect(login.status).toBe(200);
          const cookies = login.headers
            .getSetCookie()
            .map((cookie) => cookie.split(";", 1)[0] ?? "");
          const csrf = cookies
            .find((cookie) => cookie.startsWith(`${CSRF_COOKIE_NAME}=`))
            ?.slice(CSRF_COOKIE_NAME.length + 1);
          if (csrf === undefined) throw new Error("No CSRF cookie");
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
          const project = ProjectUpsertedSchema.parse(
            await (
              await request("/api/v1/projects/local", {
                repositoryId: inventory.repositories[0]?.repositoryId,
              })
            ).json(),
          ).project;
          let feature: Feature;
          if (scenario === "complete") {
            const startedResponse = await request(`/api/v1/projects/${project.id}/planning`, {
              requestId: randomUUID(),
              text: "Plan a small change: export value 2, then make label() return Value 2. Ask one concise acceptance question before implementation.",
              skillDigests: [],
            });
            expect(startedResponse.status, await startedResponse.clone().text()).toBe(202);
            const started = PlanningFeatureStartedSchema.parse(await startedResponse.json());
            feature = started.feature;
            await expect
              .poll(
                async () => {
                  const chat = FeatureChatSchema.parse(
                    await (
                      await request(`/api/v1/projects/${project.id}/features/${feature.id}`)
                    ).json(),
                  );
                  return chat.turns.find(({ id }) => id === started.turnId)?.state;
                },
                { timeout: 60_000, interval: 500 },
              )
              .toBe("completed");
          } else {
            feature = FeatureSchema.parse(
              await (
                await request(`/api/v1/projects/${project.id}/features`, {
                  requestId: randomUUID(),
                  title: "Approved value and dependent label",
                })
              ).json(),
            );
          }
          const path = `/api/v1/projects/${project.id}/features/${feature.id}`;
          const plan: FeaturePlanDocument = {
            objective: "Export value 2, then implement a label derived from that value.",
            scope: {
              includes: ["Only value.mjs and label.mjs"],
              excludes: [
                "Test changes",
                "Other files",
                "Network access",
                "Dependency installation",
              ],
            },
            acceptance: [
              { key: "value", outcome: "value is 2" },
              { key: "label", outcome: "label() returns Value 2 by using value" },
            ],
            workItems: [
              {
                key: "value",
                title: "Set the approved value",
                description:
                  "Change only value.mjs to export const value = 2. Tests are the frozen acceptance contract; do not edit them.",
                importedIssueId: null,
                requirementKeys: ["value"],
                acceptance: ["value.test.mjs passes"],
                dependsOn: [],
                verification: [
                  {
                    program: "node",
                    args:
                      scenario !== "complete"
                        ? [
                            "--eval",
                            "console.log('FACTORY_SHUTDOWN_CHECK_STARTED'); setInterval(() => {}, 1000)",
                          ]
                        : ["--test", "value.test.mjs"],
                    cwd: ".",
                    timeoutSeconds: 30,
                  },
                ],
              },
              {
                key: "label",
                title: "Derive the label from the verified value",
                description:
                  "Change only label.mjs: import value from ./value.mjs; label() returns the string Value followed by a space and value. Do not edit tests or value.mjs.",
                importedIssueId: null,
                requirementKeys: ["label"],
                acceptance: ["label.test.mjs passes using the verified value"],
                dependsOn: ["value"],
                verification: [
                  {
                    program: "node",
                    args: ["--test", "label.test.mjs"],
                    cwd: ".",
                    timeoutSeconds: 30,
                  },
                ],
              },
            ],
            limits: {
              maxConcurrentProjects: 2,
              maxActiveFeaturesPerProject: 1,
              attemptTimeoutSeconds: 120,
            },
          };
          expect(
            (
              await request(`${path}/plans`, {
                requestId: randomUUID(),
                expectedVersion: null,
                plan,
              })
            ).status,
          ).toBe(201);
          const approved = await request(`${path}/plans/1/approve`, { requestId: randomUUID() });
          expect(approved.status, await approved.clone().text()).toBe(200);
          if (scenario !== "complete") {
            await expect
              .poll(
                async () => {
                  const containers = await owner?.query<{ container_id: string }>(
                    "SELECT container_id FROM factory_execution_containers WHERE phase = 'verification' AND stopped_at IS NULL AND container_id IS NOT NULL",
                  );
                  const id = containers?.rows[0]?.container_id;
                  if (id === undefined) return false;
                  return (
                    (
                      await runDocker(["inspect", "--format", "{{.State.Running}}", id])
                    ).stdout.trim() === "true"
                  );
                },
                { timeout: 90_000, interval: 250 },
              )
              .toBe(true);
            if (scenario === "recovery" || scenario === "recovery_removed") {
              const abandoned = server;
              if (abandoned?.pid === undefined) throw new Error("No owned server process");
              const exited = new Promise<void>((resolveExit) =>
                abandoned.once("close", () => resolveExit()),
              );
              process.kill(-abandoned.pid, "SIGKILL");
              await exited;
              serverGroups.delete(abandoned.pid);
              server = undefined;
              const interrupted = await owner.query<{
                name: string;
                container_id: string;
                daemon_id: string;
              }>(
                "SELECT name, container_id, daemon_id FROM factory_execution_containers WHERE phase='verification' AND stopped_at IS NULL",
              );
              expect(interrupted.rows).toHaveLength(1);
              const container = interrupted.rows[0];
              if (container === undefined) throw new Error("Interrupted environment missing");
              expect(container.daemon_id).toBe(
                (await runDocker(["info", "--format", "{{.ID}}"])).stdout.trim(),
              );
              if (scenario === "recovery_removed") {
                // Same durable state as losing the controller after rm but before stopped_at.
                await runDocker(["rm", "--force", container.container_id]);
              }
              await owner.query(
                "UPDATE factory_execution_runs SET heartbeat_at=clock_timestamp()-interval '1 minute' WHERE reservation_released_at IS NULL",
              );
              await startServer();
              const recovered = FactoryExecutionSchema.parse(
                await (await request(`${path}/execution`)).json(),
              );
              expect(recovered.state).toBe("blocked");
              const recoveredGate = recovered.gate;
              if (recoveredGate == null) throw new Error("Recovered Human Gate missing");
              expect(recovered.workItems.map((item) => item.runs.length)).toEqual([1, 0]);
              expect(recovered.gate).toMatchObject({
                approvedVersion: 1,
                canResume: true,
                reason: "interrupted",
              });
              expect(recovered.workItems[0]?.runs[0]?.writerStopped).toBe(true);
              expect(
                (
                  await runDocker([
                    "container",
                    "ls",
                    "--all",
                    "--quiet",
                    "--filter",
                    `name=^/${container.name}$`,
                  ])
                ).stdout.trim(),
              ).toBe("");
              expect(
                (
                  await owner.query(
                    "SELECT id FROM factory_execution_runs WHERE reservation_released_at IS NULL",
                  )
                ).rows,
              ).toEqual([]);
              expect(
                (await runGit(["status", "--porcelain=v1", "--untracked-files=all"])).stdout,
              ).toBe(sourceBefore);
              expect(
                createHash("sha256")
                  .update(await readFile(join(repository, ".git", "index")))
                  .digest("hex"),
              ).toBe(indexBefore);
              // An explicit answer alone authorizes one successor. Hold its delivery so
              // this recovery conformance case cannot start an unrelated extra model run.
              await owner.query(`CREATE FUNCTION hold_recovered_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='factory-execution-v1' THEN NEW.start_after=clock_timestamp()+interval '1 hour'; END IF; RETURN NEW; END $$;
                CREATE TRIGGER hold_recovered_delivery BEFORE INSERT ON pgboss.job FOR EACH ROW EXECUTE FUNCTION hold_recovered_delivery();`);
              const answer = {
                requestId: randomUUID(),
                expectedPlanVersion: 1,
                decision: "resume_within_plan",
                answer:
                  "The verification process was interrupted. Retry within the same approved requirements and checks.",
              };
              expect(
                (await request(`${path}/execution/gates/${recoveredGate.id}/resolve`, answer))
                  .status,
              ).toBe(200);
              await expect
                .poll(
                  async () =>
                    FactoryExecutionSchema.parse(await (await request(`${path}/execution`)).json())
                      .workItems[0]?.runs.length,
                  { timeout: 10_000 },
                )
                .toBe(2);
              expect(
                (await request(`${path}/execution/gates/${recoveredGate.id}/resolve`, answer))
                  .status,
              ).toBe(200);
              expect(
                (await request(`${path}/cancel`, { requestId: randomUUID(), expectedVersion: 1 }))
                  .status,
              ).toBe(200);
              expect(
                FactoryExecutionSchema.parse(await (await request(`${path}/execution`)).json())
                  .state,
              ).toBe("cancelled");
              return;
            }
            const events = await fetch(`${origin}/api/v1/events`, {
              headers: { Accept: "text/event-stream", Cookie: cookies.join("; ") },
              signal: eventsAbort.signal,
            });
            expect(events.status).toBe(200);
            const reader = events.body?.getReader();
            if (reader === undefined) throw new Error("No event stream body");
            expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
            const stoppingChild = server;
            const stoppedAt = Date.now();
            await shutdownServer();
            expect(stoppingChild?.exitCode).toBe(0);
            expect(Date.now() - stoppedAt).toBeLessThan(20_000);
            const streamClosed = (async () => {
              try {
                while (!(await reader.read()).done) {
                  /* Drain any buffered events. */
                }
              } catch (error) {
                // Bounded HTTP shutdown may close the socket without a final SSE chunk.
                if (!(error instanceof TypeError && error.message === "terminated")) throw error;
              }
            })();
            await expect(
              Promise.race([streamClosed.then(() => true), delay(1000).then(() => false)]),
            ).resolves.toBe(true);
            const stopped = await owner.query<{ all_stopped: boolean; released: boolean }>(
              "SELECT NOT EXISTS (SELECT 1 FROM factory_execution_containers WHERE stopped_at IS NULL) AS all_stopped, NOT EXISTS (SELECT 1 FROM factory_execution_runs WHERE reservation_released_at IS NULL) AS released",
            );
            expect(stopped.rows).toEqual([{ all_stopped: true, released: true }]);
            await startServer();
            const execution = FactoryExecutionSchema.parse(
              await (await request(`${path}/execution`)).json(),
            );
            expect(execution.state).toBe("blocked");
            expect(execution.workItems.map((item) => item.runs.length)).toEqual([1, 0]);
            return;
          }
          // No browser, persistent HTTP stream or client heartbeat is required to keep this work alive.
          await delay(4_000);
          const executionDeadline = Date.now() + 300_000;
          let resolvedLiveGate = false;
          let executionVerified = false;
          let lastExecutionState = "pending";
          do {
            const current = FactoryExecutionSchema.parse(
              await (await request(`${path}/execution`)).json(),
            );
            lastExecutionState = current.state;
            if (current.state === "verified") {
              executionVerified = true;
              break;
            }
            if (current.state === "blocked") {
              const gate = current.gate;
              if (
                resolvedLiveGate ||
                gate === undefined ||
                gate === null ||
                gate.reason !== "input_required" ||
                !gate.canResume
              )
                throw new Error(
                  `Execution blocked: ${current.failure ?? "unknown"}; ${current.question ?? ""}`,
                );
              const resolution = await request(`${path}/execution/gates/${gate.id}/resolve`, {
                requestId: randomUUID(),
                expectedPlanVersion: 1,
                decision: "resume_within_plan",
                answer:
                  "Use the authorized remote workspace tools already provided by Kestrel. Read .kestrel/plan.md and .kestrel/spec.md, make only the approved source change, and run the approved verification command.",
              });
              expect(resolution.status, await resolution.clone().text()).toBe(200);
              resolvedLiveGate = true;
            } else if (["stopping", "cancelled"].includes(current.state)) {
              throw new Error(
                `Execution ${current.state}: ${current.failure ?? "unknown"}; ${current.question ?? ""}`,
              );
            }
            await delay(1_000);
          } while (Date.now() < executionDeadline);
          if (!executionVerified)
            throw new Error(`Live execution timed out in ${lastExecutionState}`);
          const execution = FactoryExecutionSchema.parse(
            await (await request(`${path}/execution`)).json(),
          );
          expect(
            execution.workItems.every((item) => item.runs.length >= 1 && item.runs.length <= 2),
          ).toBe(true);
          if (resolvedLiveGate)
            expect(execution.workItems.some((item) => item.runs.length === 2)).toBe(true);
          const final = execution.finalVerification;
          if (final === undefined || final.certificate === null)
            throw new Error("The final cumulative verification record was not retained");
          expect(final.runs).toHaveLength(1);
          const finalRun = FactoryExecutionRunSchema.parse(
            await (await request(`${path}/execution/runs/${final.certificate.runId}`)).json(),
          );
          expect(finalRun).toMatchObject({
            purpose: "feature_verification",
            workItemId: null,
            state: "verified",
            writerStopped: true,
            runtime: null,
            revision: execution.revision,
          });
          expect(finalRun.acceptedCommands).toEqual(
            plan.workItems.flatMap((item) => item.verification),
          );
          expect(finalRun.verification).toHaveLength(2);
          expect(
            finalRun.verification.every(
              (check) =>
                check.outcome === "passed" &&
                check.exitCode === 0 &&
                check.headCommitId === execution.revision?.headCommitId &&
                check.treeId === execution.revision.treeId,
            ),
          ).toBe(true);
          expect(final.certificate.revision).toEqual(execution.revision);
          expect(final.certificate.evidenceIds).toEqual(
            finalRun.verification.map((check) => check.id),
          );
          expect(final.certificate.manifest.map(({ origins }) => origins)).toEqual([
            [{ workItemKey: "value", position: 1 }],
            [{ workItemKey: "label", position: 1 }],
          ]);
          expect(final.progress).toEqual({ round: 1, checked: 2, passed: 2, total: 2 });
          const details = await Promise.all(
            execution.workItems.map(async (item) => {
              const run = item.runs.at(-1);
              if (run === undefined) throw new Error(`Work Item ${item.key} has no live run`);
              return FactoryExecutionRunSchema.parse(
                await (await request(`${path}/execution/runs/${run.id}`)).json(),
              );
            }),
          );
          expect(details.every((run) => run.state === "verified" && run.writerStopped)).toBe(true);
          expect(
            details.map((run) => run.verification.map((check) => [check.outcome, check.exitCode])),
          ).toEqual([[["passed", 0]], [["passed", 0]]]);
          expect(details.map((run) => run.acceptedCommands)).toEqual(
            plan.workItems.map((item) => item.verification),
          );
          expect(new Set(details.map((run) => run.runtime?.threadId)).size).toBe(2);
          expect(execution.revision?.baseCommitId).toBe(base);
          expect(details[0]?.completedAt).not.toBeNull();
          expect(Date.parse(details[1]?.startedAt ?? "")).toBeGreaterThanOrEqual(
            Date.parse(details[0]?.completedAt ?? ""),
          );
          expect(Date.parse(finalRun.startedAt ?? "")).toBeGreaterThanOrEqual(
            Date.parse(details[1]?.completedAt ?? ""),
          );
          const board = FactoryBoardSchema.parse(await (await request(`${path}/board`)).json());
          expect(board.columns.map((column) => column.items.length)).toEqual([0, 0, 2, 0]);
          expect(board.columns[2]?.items.every((item) => item.blocking === null)).toBe(true);
          const publicationDeadline = Date.now() + 90_000;
          let publicationReady = false;
          let lastPublicationState = "pending";
          do {
            const response = await request(`${path}/pull-request`);
            expect(response.status, await response.clone().text()).toBe(200);
            const current = FactoryFeaturePublicationSchema.parse(await response.json());
            lastPublicationState = current.state;
            if (current.state === "published") {
              publicationReady = true;
              break;
            }
            if (["blocked", "uncertain", "cancelled"].includes(current.state))
              throw new Error(
                `Live pull-request publication stopped: ${current.state}/${current.failure ?? "unknown"}`,
              );
            await delay(500);
          } while (Date.now() < publicationDeadline);
          if (!publicationReady)
            throw new Error(`Live pull-request publication timed out in ${lastPublicationState}`);
          const publication = FactoryFeaturePublicationSchema.parse(
            await (await request(`${path}/pull-request`)).json(),
          );
          expect(publication.pullRequest).toMatchObject({
            baseCommitId: base,
            headCommitId: execution.revision?.headCommitId,
            state: "open",
          });
          expect(publication.review?.revision.state).toBe("available");

          const connectionResponse = await request("/api/v1/connections/codex");
          expect(connectionResponse.status, await connectionResponse.clone().text()).toBe(200);
          const connection = CodexSubscriptionConnectionSchema.parse(
            await connectionResponse.json(),
          );
          const reviewModel =
            connection.models.find(({ isDefault }) => isDefault)?.id ?? connection.models[0]?.id;
          if (reviewModel === undefined) throw new Error("Codex has no live review model");
          const selectedModel = await fetch(`${origin}/api/v1/settings/review-model`, {
            method: "PUT",
            headers: {
              origin,
              cookie: cookies.join("; "),
              [CSRF_HEADER_NAME]: csrf,
              "content-type": "application/json",
            },
            body: JSON.stringify({ modelId: reviewModel }),
            signal: AbortSignal.timeout(10_000),
          });
          expect(selectedModel.status, await selectedModel.clone().text()).toBe(200);
          const reviewRoot = `${path}/review`;
          let preparation = FactoryConceptualReviewPreparationSchema.parse(
            await (await request(`${reviewRoot}/preparation`)).json(),
          );
          await expect
            .poll(
              async () => {
                preparation = FactoryConceptualReviewPreparationSchema.parse(
                  await (await request(`${reviewRoot}/preparation`)).json(),
                );
                return preparation.readiness.state;
              },
              { timeout: 20_000, interval: 500 },
            )
            .toBe("ready");
          if (preparation.preparationDigest === null)
            throw new Error(
              `Live review preparation is blocked: ${preparation.readiness.blockers.join(", ")}`,
            );
          const reviewStartedResponse = await request(`${reviewRoot}/workflows`, {
            requestId: randomUUID(),
            preparationDigest: preparation.preparationDigest,
          });
          expect(reviewStartedResponse.status, await reviewStartedResponse.clone().text()).toBe(
            202,
          );
          const reviewStarted = FactoryConceptualReviewWorkflowReadSchema.parse(
            await reviewStartedResponse.json(),
          );
          let review = reviewStarted;
          await expect
            .poll(
              async () => {
                review = FactoryConceptualReviewWorkflowReadSchema.parse(
                  await (
                    await request(`${reviewRoot}/workflows/${reviewStarted.workflow.id}`)
                  ).json(),
                );
                if (review.workflow.state === "failed")
                  throw new Error(
                    `Live Conceptual Review failed: ${review.workflow.failure ?? "unknown"}`,
                  );
                return review.workflow.state;
              },
              { timeout: 180_000, interval: 1_000 },
            )
            .toBe("published");
          expect(review.artifact).not.toBeNull();
          expect(review.artifact).toMatchObject({
            baseCommitId: base,
            headCommitId: execution.revision?.headCommitId,
            evidenceScope: { executedChecks: "linked_final_certificate" },
          });
          expect(
            review.artifact?.graph.outcomes.map(({ outcomeKey }) => outcomeKey).sort(),
          ).toEqual(["label", "value"]);
          expect(review.artifact?.graph.behavioralSteps.length).toBeGreaterThan(0);
          expect(review.artifact?.graph.evidence.length).toBeGreaterThan(0);
          expect((await runGit(["rev-parse", "HEAD"])).stdout.trim()).toBe(base);
          expect((await runGit(["status", "--porcelain=v1", "--untracked-files=all"])).stdout).toBe(
            sourceBefore,
          );
          expect(
            createHash("sha256")
              .update(await readFile(join(repository, ".git", "index")))
              .digest("hex"),
          ).toBe(indexBefore);
          expect(await readFile(join(repository, "value.mjs"), "utf8")).toContain(
            "DIRTY_OPERATOR_CANARY",
          );
          expect(await readFile(join(repository, "label.mjs"), "utf8")).toContain(
            "STAGED_OPERATOR_CANARY",
          );
          expect(await readFile(join(repository, "untracked.txt"), "utf8")).toContain(
            "UNTRACKED_OPERATOR_CANARY",
          );
          expect(await readFile(join(repository, "ignored-canary.txt"), "utf8")).toContain(
            "IGNORED_OPERATOR_CANARY",
          );
          const workspaceRoot = join(
            artifacts,
            "projects",
            project.id,
            "feature-workspaces",
            feature.id,
          );
          const metadata = join(workspaceRoot, "control", "repository.git");
          const parent = (
            await exec(
              git,
              [
                "--git-dir",
                metadata,
                "show",
                "--no-patch",
                "--format=%P",
                execution.revision?.headCommitId ?? "",
              ],
              { timeout: 10_000 },
            )
          ).stdout.trim();
          expect(parent).toBe(details[0]?.revision?.headCommitId);
          await shutdownServer();
          await startServer();
          expect(
            FactoryExecutionSchema.parse(await (await request(`${path}/execution`)).json()),
          ).toEqual(execution);
          const restoredReview = FactoryConceptualReviewWorkflowReadSchema.parse(
            await (await request(`${path}/review/workflows/${reviewStarted.workflow.id}`)).json(),
          );
          expect(restoredReview).toEqual(review);
          const containers = await owner.query("SELECT name FROM factory_execution_containers");
          for (const row of containers.rows as Array<{ name: string }>) {
            expect(
              (
                await runDocker([
                  "container",
                  "ls",
                  "--all",
                  "--quiet",
                  "--filter",
                  `name=^/${row.name}$`,
                ])
              ).stdout.trim(),
            ).toBe("");
          }
        } catch (error) {
          await writeFile("/tmp/kestrel-factory-execution-live-server.log", logs, { mode: 0o600 });
          throw error;
        } finally {
          eventsAbort.abort();
          await shutdownServer();
          for (const pid of serverGroups) stopServerGroup(pid);
          if (owner !== undefined) {
            const containers = await owner
              .query<{ name: string }>("SELECT name FROM factory_execution_containers")
              .catch(() => ({ rows: [] }));
            for (const { name } of containers.rows)
              await runDocker(["rm", "--force", name]).catch(() => undefined);
            await owner.end();
          }
          await runDocker(["rm", "--force", databaseContainer]).catch(() => undefined);
          await exec("/bin/chmod", ["-R", "u+rwX", directory]).catch(() => undefined);
          await rm(directory, { recursive: true, force: true });
        }
      },
      700_000,
    );
  },
);
