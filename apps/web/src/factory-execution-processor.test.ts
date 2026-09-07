import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as database from "@kestrel/database";
import {
  claimFactoryExecution,
  createPool,
  finishFactoryExecution,
  heartbeatFactoryExecution,
  identifyFactoryExecutionContainer,
  initializeFactoryFeatureWorkspace,
  readCodexReviewModelPreference,
  readFactoryFeatureWorkspace,
  recordFactoryExecutionActivity,
  recordFactoryExecutionCheckpoint,
  reserveFactoryExecutionContainer,
  saveFactoryExecutionRuntime,
  saveFactoryVerification,
  stopFactoryExecutionContainer,
  type ClaimedFactoryExecution,
  type FactoryFeatureWorkspace,
} from "@kestrel/database";
import {
  discoverRepositories,
  inspectRepository,
  resolveRepository,
  type LocalSourceConfig,
} from "@kestrel/local-source";
import type { CodexAgentRuntimePort } from "./codex-app-server.js";
import type {
  CodexExecutionLifecycle,
  CodexExecutionRuntime,
  CodexVerificationResult,
} from "./codex-execution-runtime.js";
import { createFactoryExecutionProcessor } from "./factory-execution-processor.js";

vi.mock("@kestrel/database", async (importOriginal) => ({
  ...(await importOriginal<typeof database>()),
  claimFactoryExecution: vi.fn(),
  finishFactoryExecution: vi.fn(),
  heartbeatFactoryExecution: vi.fn(),
  identifyFactoryExecutionContainer: vi.fn(),
  initializeFactoryFeatureWorkspace: vi.fn(),
  readCodexReviewModelPreference: vi.fn(),
  readFactoryFeatureWorkspace: vi.fn(),
  recordFactoryExecutionActivity: vi.fn(),
  recordFactoryExecutionCheckpoint: vi.fn(),
  reserveFactoryExecutionContainer: vi.fn(),
  saveFactoryExecutionRuntime: vi.fn(),
  saveFactoryVerification: vi.fn(),
  stopFactoryExecutionContainer: vi.fn(),
}));

const execFileAsync = promisify(execFile);
const pool = createPool("postgres://127.0.0.1:1/unused", "factory-execution-processor-test");
const processors: ReturnType<typeof createFactoryExecutionProcessor>[] = [];
const readConnection = vi.fn<CodexAgentRuntimePort["readConnection"]>();
const runTurn = vi.fn<CodexExecutionRuntime["runTurn"]>();
const runVerification = vi.fn<CodexExecutionRuntime["runVerification"]>();
let root: string;
let repository: string;
let config: LocalSourceConfig;
let run: ClaimedFactoryExecution;
let storedWorkspace: FactoryFeatureWorkspace | null;
let events: string[];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("/usr/bin/git", ["-C", cwd, ...args])).stdout.trim();
}

async function container<T>(
  input: CodexExecutionLifecycle,
  id: string,
  action: () => Promise<T>,
): Promise<T> {
  const digest = createHash("sha256").update(id).digest("hex");
  const identity = { name: `kestrel-factory-${digest.slice(0, 32)}`, id: digest };
  await input.beforeContainerCreate(identity.name);
  await input.onContainer(identity);
  try {
    return await action();
  } finally {
    await input.onStopped(identity);
  }
}

function processor(options: Partial<Parameters<typeof createFactoryExecutionProcessor>[0]> = {}) {
  const result = createFactoryExecutionProcessor({
    pool,
    readSourceConfig: () => Promise.resolve(config),
    connection: { readConnection },
    runtime: { runTurn, runVerification },
    ...options,
  });
  processors.push(result);
  return result;
}

beforeEach(async () => {
  vi.resetAllMocks();
  events = [];
  storedWorkspace = null;
  root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-execution-processing-")));
  repository = join(root, "repositories", "fixture");
  await mkdir(repository, { recursive: true });
  const artifactRoot = join(root, "artifacts");
  await mkdir(artifactRoot, { mode: 0o700 });
  await chmod(artifactRoot, 0o700);
  await git(repository, "init", "--initial-branch=main");
  await git(repository, "config", "user.name", "Fixture");
  await git(repository, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(repository, "value.mjs"), "export const value = 1;\n");
  await writeFile(
    join(repository, "feature.test.mjs"),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './value.mjs';\ntest('approved behavior', () => assert.equal(value, 2));\n",
  );
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "Fixture source");
  const base = await git(repository, "rev-parse", "HEAD");
  await writeFile(join(repository, "value.mjs"), "operator dirty bytes\n");
  await writeFile(join(repository, "untracked.txt"), "operator untracked bytes\n");
  config = {
    artifactRoot,
    gitExecutable: "/usr/bin/git",
    gitObjectReadTimeoutMs: 10_000,
    maxBytes: 1_000_000,
    maxObjects: 1000,
    repositoryRoots: [{ id: randomUUID(), path: join(root, "repositories") }],
  };
  const candidate = (await discoverRepositories(config))[0];
  if (candidate === undefined) throw new Error("Fixture source unavailable");
  const inspection = await inspectRepository(
    config,
    await resolveRepository(config, candidate.repositoryId),
  );
  run = {
    id: "01991c36-7f90-7000-8000-000000000001",
    ownerInstanceId: randomUUID(),
    projectId: randomUUID(),
    featureId: randomUUID(),
    title: "Deliver two",
    workItemId: randomUUID(),
    key: "value",
    attempt: 1,
    version: 1,
    plan: {
      objective: "Expose value two",
      scope: { includes: ["Return two"], excludes: ["Provider writes"] },
      acceptance: [{ key: "two", outcome: "The exported value is two." }],
      workItems: [
        {
          key: "value",
          importedIssueId: null,
          title: "Return two",
          description: "Change the approved exported value",
          requirementKeys: ["two"],
          acceptance: ["The existing check passes"],
          dependsOn: [],
          verification: [
            { program: "node", args: ["--test", "feature.test.mjs"], cwd: ".", timeoutSeconds: 10 },
          ],
        },
      ],
      limits: {
        maxConcurrentProjects: 2,
        maxActiveFeaturesPerProject: 1,
        attemptTimeoutSeconds: 60,
      },
    },
    planMarkdown: "# Approved plan\nReturn two only.",
    specMarkdown: "# Approved scope\nNo provider writes.",
    context: { commitId: base, documents: [], notice: null },
    source: { repositoryId: candidate.repositoryId, identity: inspection.sourceIdentity },
    completed: [],
  };
  vi.mocked(claimFactoryExecution).mockImplementation((_pool, id, ownerInstanceId) => {
    events.push("claim");
    return Promise.resolve(id === run.id ? { ...run, ownerInstanceId } : null);
  });
  vi.mocked(heartbeatFactoryExecution).mockResolvedValue(true);
  vi.mocked(readFactoryFeatureWorkspace).mockImplementation(() => Promise.resolve(storedWorkspace));
  vi.mocked(initializeFactoryFeatureWorkspace).mockImplementation((_pool, _run, workspace) => {
    events.push("initialize");
    storedWorkspace = { ...workspace };
    return Promise.resolve(workspace);
  });
  vi.mocked(recordFactoryExecutionCheckpoint).mockImplementation((_pool, _run, checkpoint) => {
    if (storedWorkspace === null) throw new Error("Missing initialized workspace");
    events.push("checkpoint");
    storedWorkspace = {
      ...storedWorkspace,
      headCommitId: checkpoint.headCommitId,
      treeId: checkpoint.treeId,
    };
    return Promise.resolve({
      baseCommitId: storedWorkspace.baseCommitId,
      branch: storedWorkspace.branch,
      headCommitId: checkpoint.headCommitId,
      treeId: checkpoint.treeId,
    });
  });
  vi.mocked(reserveFactoryExecutionContainer).mockImplementation((_pool, _run, _name, phase) => {
    events.push(`reserve:${phase}`);
    return Promise.resolve();
  });
  vi.mocked(identifyFactoryExecutionContainer).mockResolvedValue();
  vi.mocked(stopFactoryExecutionContainer).mockImplementation(() => {
    events.push("stopped");
    return Promise.resolve();
  });
  vi.mocked(recordFactoryExecutionActivity).mockResolvedValue();
  vi.mocked(saveFactoryExecutionRuntime).mockResolvedValue();
  vi.mocked(saveFactoryVerification).mockImplementation(() => {
    events.push("evidence");
    return Promise.resolve();
  });
  vi.mocked(finishFactoryExecution).mockImplementation(() => {
    events.push("finish");
    return Promise.resolve();
  });
  vi.mocked(readCodexReviewModelPreference).mockResolvedValue({
    schemaVersion: 1,
    route: "codex_subscription",
    selectedModelId: null,
    updatedAt: null,
  });
  readConnection.mockResolvedValue({
    schemaVersion: 1,
    state: "ready",
    reason: null,
    cli: { version: "0.153.4", supported: true, protocol: "app_server_v2" },
    account: { authentication: "chatgpt", email: null, plan: "pro" },
    models: [{ id: "fixture-model", displayName: "Fixture", isDefault: true }],
    usage: { availability: "available", primary: null, secondary: null },
    checkedAt: "2026-09-07T18:00:00.000Z",
  });
  runTurn.mockImplementation((input) =>
    container(input, input.requestId, async () => {
      events.push("implementation");
      await input.onThread("thread");
      await input.onTurn("turn");
      await writeFile(join(input.cwd, "value.mjs"), "export const value = 2;\n");
      return {
        threadId: "thread",
        turnId: "turn",
        text: JSON.stringify({
          status: "completed",
          summary: "The approved value is implemented.",
          question: null,
        }),
      };
    }),
  );
  runVerification.mockImplementation((input) =>
    container(input, input.processId, async () => {
      events.push("verification");
      const started = performance.now();
      return new Promise<CodexVerificationResult>((resolveResult) => {
        execFile(
          input.command[0] ?? "",
          input.command.slice(1),
          { cwd: join(input.workspaceCwd, input.cwd) },
          (error, stdout, stderr) => {
            resolveResult({
              processId: input.processId,
              exitCode: error === null ? 0 : 1,
              stdout,
              stderr,
              stdoutTruncated: false,
              stderrTruncated: false,
              durationMs: Math.round(performance.now() - started),
            });
          },
        );
      });
    }),
  );
});

afterEach(async () => {
  for (const processing of processors.splice(0)) await processing.stop();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await pool.end();
});

it("claims, freezes source, closes implementation, checkpoints and verifies exact argv before finishing", async () => {
  await processor().process({ runId: run.id });
  expect(finishFactoryExecution).toHaveBeenCalledWith(
    pool,
    expect.objectContaining({ id: run.id }),
    { verified: true, writerStopped: true, failure: null, question: null },
  );
  const turn = runTurn.mock.calls[0]?.[0];
  if (turn === undefined) throw new Error("Runtime was not invoked");
  expect(events).toEqual([
    "claim",
    "initialize",
    "reserve:implementation",
    "implementation",
    "stopped",
    "checkpoint",
    "reserve:verification",
    "verification",
    "stopped",
    "evidence",
    "finish",
  ]);
  expect(turn.requestId).toBe(`${run.id}:implementation:1`);
  expect(turn.model).toBe("fixture-model");
  expect(turn.prompt).toContain("Provider writes");
  expect(turn.prompt).toContain(".kestrel/plan.md");
  expect(turn.prompt).not.toContain(root);
  expect(await readFile(join(turn.cwd, ".kestrel", "spec.md"), "utf8")).toBe(run.specMarkdown);
  expect(await readFile(join(repository, "value.mjs"), "utf8")).toBe("operator dirty bytes\n");
  const command = runVerification.mock.calls[0]?.[0];
  expect(command?.command).toEqual(["node", "--test", "feature.test.mjs"]);
  expect(command?.processId).toBe(`${run.id}:verification:1:1`);
  const check = vi.mocked(saveFactoryVerification).mock.calls[0]?.[2];
  expect(check).toMatchObject({
    round: 1,
    position: 1,
    exitCode: 0,
    outcome: "passed",
    command: run.plan.workItems[0]?.verification[0],
  });
  expect(check?.headCommitId).toBe(await git(turn.cwd, "rev-parse", "HEAD"));
  expect(check?.treeId).toBe(await git(turn.cwd, "rev-parse", "HEAD^{tree}"));
  expect(await git(turn.cwd, "show", "HEAD:value.mjs")).toBe("export const value = 2;");
});
