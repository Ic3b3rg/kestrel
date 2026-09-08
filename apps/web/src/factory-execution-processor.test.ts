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
import {
  CodexExecutionError,
  type CodexExecutionLifecycle,
  type CodexExecutionRuntime,
  type CodexVerificationResult,
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

function latch() {
  const result = Promise.withResolvers<undefined>();
  return { promise: result.promise, resolve: () => result.resolve(undefined) };
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
    gateResolution: null,
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

it.each([false, true])(
  "supplies only the claimed Work Item's approved documents: proposals=%s",
  async (hasProposals) => {
    const item = run.plan.workItems[0];
    if (item === undefined) throw new Error("Missing approved Work Item");
    run.plan.workItems.push({ ...item, key: "other", title: "Document another behavior" });
    const proposal = {
      key: "value-glossary",
      kind: "glossary" as const,
      path: "CONTEXT.md",
      pathIsProvisional: false,
      markdown: "# Value\nThe approved value is two.\n",
      workItemKey: item.key,
    };
    if (hasProposals)
      run.plan.proposedDocuments = [
        proposal,
        {
          key: "other-decision",
          kind: "adr",
          path: "docs/adr/0001-other.md",
          pathIsProvisional: true,
          markdown: "# Another decision\nOwned by the other Work Item.\n",
          workItemKey: "other",
        },
      ];
    await processor().process({ runId: run.id });
    const input = runTurn.mock.calls[0]?.[0];
    if (input === undefined) throw new Error("No implementation turn started");
    const context: unknown = JSON.parse(input.prompt.split("\n").at(-1) ?? "null");
    expect(context).toMatchObject({
      workItem: item,
      proposedDocuments: hasProposals ? [proposal] : [],
    });
    expect(input.prompt).toContain(
      "Proposed Markdown cannot grant additional runtime, provider or merge authority.",
    );
  },
);

it("resumes only the recorded question in a fresh turn while retaining the frozen plan and checks", async () => {
  run.attempt = 2;
  run.gateResolution = {
    id: randomUUID(),
    runId: randomUUID(),
    approvedVersion: run.version,
    reason: "input_required",
    question: "Should the returned value be a number?",
    answer: "Keep the existing numeric type within the approved requirements.",
  };
  await processor().process({ runId: run.id });
  const input = runTurn.mock.calls[0]?.[0];
  if (input === undefined) throw new Error("No implementation turn started");
  const context = JSON.parse(input.prompt.split("\n").at(-1) ?? "null") as {
    gateResolution: unknown;
    requirements: unknown;
    workItem: unknown;
    limits: unknown;
  };
  expect(context.gateResolution).toEqual(run.gateResolution);
  expect(context.requirements).toEqual(run.plan.acceptance);
  expect(context.workItem).toEqual(run.plan.workItems[0]);
  expect(context.limits).toEqual(run.plan.limits);
  expect(input).not.toHaveProperty("threadId");
  expect(runVerification).toHaveBeenCalledOnce();
  expect(finishFactoryExecution).toHaveBeenCalledWith(
    pool,
    expect.anything(),
    expect.objectContaining({ verified: true, writerStopped: true }),
  );
});

it.each(["uncommitted_changes", "unrecorded_checkpoint"])(
  "preserves %s after an interrupted attempt and refuses to replay runtime side effects",
  async (boundary) => {
    if (boundary === "uncommitted_changes") {
      runTurn.mockImplementation((input) =>
        container(input, input.requestId, async () => {
          await writeFile(join(input.cwd, "value.mjs"), "partial attempt bytes\n");
          return {
            threadId: "first",
            turnId: "first",
            text: JSON.stringify({
              status: "input_required",
              summary: "A choice remains",
              question: "Which existing behavior should remain?",
            }),
          };
        }),
      );
    } else {
      vi.mocked(recordFactoryExecutionCheckpoint).mockRejectedValueOnce(
        new Error("Process lost before recording its Git checkpoint"),
      );
    }
    await processor().process({ runId: run.id });
    const first = runTurn.mock.calls[0]?.[0];
    if (first === undefined) throw new Error("No first attempt");
    const retained = await readFile(join(first.cwd, "value.mjs"), "utf8");
    const retainedHead = await git(first.cwd, "rev-parse", "HEAD");
    const previousRunId = run.id;
    run.id = "01991c36-7f90-7000-8000-000000000002";
    run.attempt = 2;
    run.gateResolution = {
      id: randomUUID(),
      runId: previousRunId,
      approvedVersion: run.version,
      reason: "input_required",
      question: "Which existing behavior should remain?",
      answer: "Keep the existing approved numeric behavior.",
    };
    await processor().process({ runId: run.id });
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runVerification).not.toHaveBeenCalled();
    expect(await readFile(join(first.cwd, "value.mjs"), "utf8")).toBe(retained);
    expect(await git(first.cwd, "rev-parse", "HEAD")).toBe(retainedHead);
    expect(finishFactoryExecution).toHaveBeenLastCalledWith(
      pool,
      expect.objectContaining({ id: run.id }),
      expect.objectContaining({ verified: false, writerStopped: true, failure: "source_changed" }),
    );
  },
);

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

it("retains failed evidence when an exit-zero verification mutates the checkpoint", async () => {
  runVerification.mockImplementation((input) =>
    container(input, input.processId, async () => {
      await writeFile(join(input.workspaceCwd, "value.mjs"), "source modified by verification\n");
      return {
        processId: input.processId,
        exitCode: 0,
        stdout: "check claimed success",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
      };
    }),
  );
  await processor().process({ runId: run.id });
  expect(saveFactoryVerification).toHaveBeenCalledWith(
    pool,
    expect.objectContaining({ id: run.id }),
    expect.objectContaining({ outcome: "failed", exitCode: 0, stdout: "check claimed success" }),
  );
  expect(finishFactoryExecution).toHaveBeenCalledWith(
    pool,
    expect.anything(),
    expect.objectContaining({ verified: false, writerStopped: true, failure: "revision_changed" }),
  );
  expect(runTurn).toHaveBeenCalledTimes(1);
});

it("waits for verification teardown on durable cancellation and saves its cancelled evidence", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const started = latch();
  const aborted = latch();
  const stopped = latch();
  runVerification.mockImplementation((input) =>
    container(input, input.processId, async () => {
      started.resolve();
      try {
        await new Promise<void>((_resolve, reject) =>
          input.signal?.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(new CodexExecutionError("cancelled"));
            },
            { once: true },
          ),
        );
        throw new Error("Unreachable fixture completion");
      } finally {
        await stopped.promise;
      }
    }),
  );
  const processing = processor().process({ runId: run.id });
  await started.promise;
  vi.mocked(heartbeatFactoryExecution).mockResolvedValue(false);
  try {
    await vi.advanceTimersByTimeAsync(1000);
    await aborted.promise;
    expect(finishFactoryExecution).not.toHaveBeenCalled();
    expect(saveFactoryVerification).not.toHaveBeenCalled();
  } finally {
    stopped.resolve();
  }
  await processing;
  expect(saveFactoryVerification).toHaveBeenCalledWith(
    pool,
    expect.anything(),
    expect.objectContaining({ outcome: "cancelled", exitCode: null }),
  );
  expect(finishFactoryExecution).toHaveBeenCalledWith(
    pool,
    expect.anything(),
    expect.objectContaining({ verified: false, writerStopped: true, failure: "cancelled" }),
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("retains the reservation when runtime teardown is unconfirmed", async () => {
  runTurn.mockImplementation(async (input) => {
    const identity = { name: "kestrel-factory-unconfirmed", id: "a".repeat(64) };
    await input.beforeContainerCreate(identity.name);
    await input.onContainer(identity);
    throw new CodexExecutionError("stop_unconfirmed");
  });
  await processor().process({ runId: run.id });
  expect(recordFactoryExecutionCheckpoint).not.toHaveBeenCalled();
  expect(runVerification).not.toHaveBeenCalled();
  expect(finishFactoryExecution).toHaveBeenCalledWith(
    pool,
    expect.anything(),
    expect.objectContaining({ verified: false, writerStopped: false, failure: "stop_unconfirmed" }),
  );
});

it("rejects a claimed completion without a durable container lifecycle witness", async () => {
  runTurn.mockResolvedValue({
    threadId: "thread",
    turnId: "turn",
    text: JSON.stringify({ status: "completed", summary: "Unproven completion", question: null }),
  });
  await processor().process({ runId: run.id });
  expect(recordFactoryExecutionCheckpoint).not.toHaveBeenCalled();
  expect(finishFactoryExecution).toHaveBeenCalledWith(
    pool,
    expect.anything(),
    expect.objectContaining({ verified: false, writerStopped: false, failure: "stop_unconfirmed" }),
  );
});

it.each([
  "not JSON",
  JSON.stringify({ status: "input_required", summary: "Need input", question: null }),
  JSON.stringify({ status: "completed", summary: "Done", question: "Change scope?" }),
])("gates invalid or contradictory implementation output", async (text) => {
  runTurn.mockImplementation((input) =>
    container(input, input.requestId, () =>
      Promise.resolve({ threadId: "thread", turnId: "turn", text }),
    ),
  );
  await processor().process({ runId: run.id });
  expect(recordFactoryExecutionCheckpoint).not.toHaveBeenCalled();
  expect(runVerification).not.toHaveBeenCalled();
  expect(finishFactoryExecution).toHaveBeenCalledWith(
    pool,
    expect.anything(),
    expect.objectContaining({ verified: false, writerStopped: true, failure: "invalid_response" }),
  );
});

it("records an explicit requirements question without checkpointing or answering it", async () => {
  runTurn.mockImplementation((input) =>
    container(input, input.requestId, () =>
      Promise.resolve({
        threadId: "thread",
        turnId: "turn",
        text: JSON.stringify({
          status: "input_required",
          summary: "Scope question",
          question: "May the exported value change for existing callers?",
        }),
      }),
    ),
  );
  await processor().process({ runId: run.id });
  expect(recordFactoryExecutionCheckpoint).not.toHaveBeenCalled();
  expect(runVerification).not.toHaveBeenCalled();
  expect(finishFactoryExecution).toHaveBeenCalledWith(pool, expect.anything(), {
    verified: false,
    writerStopped: true,
    failure: "input_required",
    question: "May the exported value change for existing callers?",
  });
});

it("acknowledges a runtime permission question and aborts with its actionable gate", async () => {
  let acknowledged = false;
  runTurn.mockImplementation((input) =>
    container(input, input.requestId, async () => {
      await input.onQuestion({
        code: "permission_required",
        question: "May this command write outside the approved workspace?",
      });
      acknowledged = true;
      throw new CodexExecutionError(
        "permission_required",
        "May this command write outside the approved workspace?",
      );
    }),
  );
  await processor().process({ runId: run.id });
  expect(acknowledged).toBe(true);
  expect(runTurn.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  expect(recordFactoryExecutionCheckpoint).not.toHaveBeenCalled();
  expect(runVerification).not.toHaveBeenCalled();
  expect(finishFactoryExecution).toHaveBeenCalledWith(pool, expect.anything(), {
    verified: false,
    writerStopped: true,
    failure: "permission_required",
    question: "May this command write outside the approved workspace?",
  });
});

it("repairs technical failures in a fresh turn and rechecks every exact command on a new checkpoint", async () => {
  run.plan.workItems[0]?.verification.push({
    program: "node",
    args: ["-e", "process.stdout.write('second approved check')"],
    cwd: ".",
    timeoutSeconds: 10,
  });
  let round = 0;
  runTurn.mockImplementation((input) =>
    container(input, input.requestId, async () => {
      round++;
      await input.onThread(`thread-${String(round)}`);
      await input.onTurn(`turn-${String(round)}`);
      await writeFile(
        join(input.cwd, "value.mjs"),
        `export const value = ${round === 1 ? "0" : "2"};\n`,
      );
      return {
        threadId: `thread-${String(round)}`,
        turnId: `turn-${String(round)}`,
        text: JSON.stringify({
          status: "completed",
          summary: "Implementation round completed.",
          question: null,
        }),
      };
    }),
  );
  await processor().process({ runId: run.id });
  expect(runTurn).toHaveBeenCalledTimes(2);
  expect(runVerification).toHaveBeenCalledTimes(4);
  expect(runVerification.mock.calls.map((call) => call[0].command)).toEqual([
    ["node", "--test", "feature.test.mjs"],
    ["node", "-e", "process.stdout.write('second approved check')"],
    ["node", "--test", "feature.test.mjs"],
    ["node", "-e", "process.stdout.write('second approved check')"],
  ]);
  expect(runTurn.mock.calls[1]?.[0].requestId).toBe(`${run.id}:implementation:2`);
  expect(runTurn.mock.calls[1]?.[0].prompt).toContain('"outcome":"failed"');
  expect(runTurn.mock.calls[1]?.[0].prompt).toContain("approved behavior");
  const checks = vi.mocked(saveFactoryVerification).mock.calls.map((call) => call[2]);
  expect(checks.map((check) => [check.round, check.outcome])).toEqual([
    [1, "failed"],
    [1, "passed"],
    [2, "passed"],
    [2, "passed"],
  ]);
  const cwd = runTurn.mock.calls[1]?.[0].cwd;
  if (cwd === undefined) throw new Error("No second implementation");
  expect(checks[0]?.headCommitId).toBe(await git(cwd, "rev-parse", "HEAD^"));
  expect(checks[2]?.headCommitId).toBe(await git(cwd, "rev-parse", "HEAD"));
  expect(finishFactoryExecution).toHaveBeenCalledWith(pool, expect.anything(), {
    verified: true,
    writerStopped: true,
    failure: null,
    question: null,
  });
});

it("gates persistent verification failures after at most three technical rounds", async () => {
  runTurn.mockImplementation((input) =>
    container(input, input.requestId, async () => {
      await writeFile(join(input.cwd, "value.mjs"), "export const value = 0;\n");
      return {
        threadId: "thread",
        turnId: "turn",
        text: JSON.stringify({
          status: "completed",
          summary: "Implementation needs verification",
          question: null,
        }),
      };
    }),
  );
  await processor().process({ runId: run.id });
  expect(runTurn).toHaveBeenCalledTimes(3);
  expect(runVerification).toHaveBeenCalledTimes(3);
  expect(
    vi.mocked(saveFactoryVerification).mock.calls.map((call) => [call[2].round, call[2].outcome]),
  ).toEqual([
    [1, "failed"],
    [2, "failed"],
    [3, "failed"],
  ]);
  expect(finishFactoryExecution).toHaveBeenCalledWith(
    pool,
    expect.anything(),
    expect.objectContaining({
      verified: false,
      writerStopped: true,
      failure: "verification_failed",
    }),
  );
});

it("shares one approved deadline across repair rounds", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  const secondRound = latch();
  let round = 0;
  runTurn.mockImplementation((input) =>
    container(input, input.requestId, async () => {
      round++;
      if (round === 1) {
        await vi.advanceTimersByTimeAsync(20_000);
        await writeFile(join(input.cwd, "value.mjs"), "export const value = 0;\n");
        return {
          threadId: "first",
          turnId: "first",
          text: JSON.stringify({ status: "completed", summary: "First round", question: null }),
        };
      }
      secondRound.resolve();
      return new Promise<never>((_resolve, reject) =>
        input.signal?.addEventListener(
          "abort",
          () => reject(new CodexExecutionError("cancelled")),
          { once: true },
        ),
      );
    }),
  );
  const processing = processor().process({ runId: run.id });
  await secondRound.promise;
  await vi.advanceTimersByTimeAsync(39_999);
  expect(runTurn.mock.calls[1]?.[0].signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await processing;
  expect(runTurn).toHaveBeenCalledTimes(2);
  expect(recordFactoryExecutionCheckpoint).toHaveBeenCalledTimes(1);
  expect(finishFactoryExecution).toHaveBeenCalledWith(
    pool,
    expect.anything(),
    expect.objectContaining({ verified: false, writerStopped: true, failure: "timeout" }),
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("deduplicates local deliveries and drains teardown and an outstanding heartbeat before stop completes", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const started = latch();
  const release = latch();
  const stopped = latch();
  const heartbeat = Promise.withResolvers<boolean>();
  vi.mocked(heartbeatFactoryExecution).mockImplementation(() => heartbeat.promise);
  vi.mocked(stopFactoryExecutionContainer).mockImplementation(() => {
    stopped.resolve();
    return Promise.resolve();
  });
  runTurn.mockImplementation((input) =>
    container(input, input.requestId, async () => {
      started.resolve();
      try {
        return await new Promise<never>((_resolve, reject) =>
          input.signal?.addEventListener(
            "abort",
            () => reject(new CodexExecutionError("cancelled")),
            { once: true },
          ),
        );
      } finally {
        await release.promise;
      }
    }),
  );
  const processing = processor();
  const running = processing.process({ runId: run.id });
  expect(processing.process({ runId: run.id })).toBe(running);
  await started.promise;
  await vi.advanceTimersByTimeAsync(1000);
  const stopping = processing.stop();
  try {
    expect(finishFactoryExecution).not.toHaveBeenCalled();
    release.resolve();
    await stopped.promise;
    expect(finishFactoryExecution).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    heartbeat.resolve(false);
  }
  await Promise.all([running, stopping]);
  expect(claimFactoryExecution).toHaveBeenCalledTimes(1);
  expect(recordFactoryExecutionCheckpoint).not.toHaveBeenCalled();
  expect(finishFactoryExecution).toHaveBeenCalledWith(
    pool,
    expect.anything(),
    expect.objectContaining({ verified: false, writerStopped: true, failure: "interrupted" }),
  );
  await expect(processing.process({ runId: run.id })).rejects.toThrow("interrupted");
  expect(vi.getTimerCount()).toBe(0);
});

it("does no filesystem or runtime work when the delivery was not claimed", async () => {
  const readSourceConfig = vi.fn(() => Promise.resolve(config));
  vi.mocked(claimFactoryExecution).mockResolvedValue(null);
  await processor({ readSourceConfig }).process({ runId: run.id });
  expect(readSourceConfig).not.toHaveBeenCalled();
  expect(readConnection).not.toHaveBeenCalled();
  expect(runTurn).not.toHaveBeenCalled();
  expect(finishFactoryExecution).not.toHaveBeenCalled();
});

it("reports a missing sandbox image as a recoverable run failure", async () => {
  const processing = createFactoryExecutionProcessor({
    pool,
    readSourceConfig: () => Promise.resolve(config),
    connection: { readConnection },
  });
  processors.push(processing);
  await processing.process({ runId: run.id });
  expect(initializeFactoryFeatureWorkspace).not.toHaveBeenCalled();
  expect(runTurn).not.toHaveBeenCalled();
  expect(finishFactoryExecution).toHaveBeenCalledWith(
    pool,
    expect.anything(),
    expect.objectContaining({
      verified: false,
      writerStopped: true,
      failure: "sandbox_unavailable",
    }),
  );
  expect(vi.mocked(finishFactoryExecution).mock.calls[0]?.[2].question).toContain(
    "container image",
  );
});

it("keeps an unavailable selected model as a gate without falling back", async () => {
  vi.mocked(readCodexReviewModelPreference).mockResolvedValue({
    schemaVersion: 1,
    route: "codex_subscription",
    selectedModelId: "missing-model",
    updatedAt: "2026-09-07T18:00:00.000Z",
  });
  await processor().process({ runId: run.id });
  expect(initializeFactoryFeatureWorkspace).not.toHaveBeenCalled();
  expect(runTurn).not.toHaveBeenCalled();
  expect(finishFactoryExecution).toHaveBeenCalledWith(
    pool,
    expect.anything(),
    expect.objectContaining({ verified: false, writerStopped: true, failure: "unavailable" }),
  );
});

it("keeps the first captured source and Feature head when a dependent item starts after Operator HEAD changes", async () => {
  const item = run.plan.workItems[0];
  if (item === undefined) throw new Error("Fixture item unavailable");
  run.plan.workItems.push({ ...item, key: "dependent", dependsOn: [item.key] });
  run.context = null;
  const base = await git(repository, "rev-parse", "HEAD");
  const processing = processor();
  await processing.process({ runId: run.id });
  const frozen = await readFactoryFeatureWorkspace(pool, run);
  if (frozen === null) throw new Error("No frozen Feature workspace");
  const firstCwd = runTurn.mock.calls[0]?.[0].cwd;
  await writeFile(join(repository, "later.txt"), "Later Operator commit\n");
  await git(repository, "add", "later.txt");
  await git(repository, "commit", "-m", "Advance Operator source");
  expect(await git(repository, "rev-parse", "HEAD")).not.toBe(base);
  run = {
    ...run,
    id: "01991c36-7f90-7000-8000-000000000002",
    key: "dependent",
    workItemId: randomUUID(),
    completed: [
      {
        key: item.key,
        revision: {
          baseCommitId: frozen.baseCommitId,
          headCommitId: frozen.headCommitId,
          treeId: frozen.treeId,
          branch: frozen.branch,
        },
      },
    ],
  };
  await processing.process({ runId: run.id });
  expect(initializeFactoryFeatureWorkspace).toHaveBeenCalledTimes(1);
  const turn = runTurn.mock.calls[1]?.[0];
  if (turn === undefined) throw new Error("Dependent item was not executed");
  expect(turn.cwd).toBe(firstCwd);
  expect(turn.prompt).toContain(`"baseCommitId":"${base}"`);
  expect(turn.prompt).toContain(
    `"dependencies":[{"key":"value","revision":{"baseCommitId":"${base}","headCommitId":"${frozen.headCommitId}"`,
  );
  expect(await readFile(join(turn.cwd, "later.txt"), "utf8").catch(() => null)).toBeNull();
  expect(await readFile(join(repository, "value.mjs"), "utf8")).toBe("operator dirty bytes\n");
  expect(finishFactoryExecution).toHaveBeenLastCalledWith(pool, expect.anything(), {
    verified: true,
    writerStopped: true,
    failure: null,
    question: null,
  });
});

it("bounds verification evidence as UTF-8 and redacts private paths", async () => {
  runVerification.mockImplementation((input) =>
    container(input, input.processId, () =>
      Promise.resolve({
        processId: input.processId,
        exitCode: 0,
        stdout: `${input.workspaceCwd}\n${"🙂".repeat(4000)}`,
        stderr: "é".repeat(5000),
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
      }),
    ),
  );
  await processor().process({ runId: run.id });
  const evidence = vi.mocked(saveFactoryVerification).mock.calls[0]?.[2];
  if (evidence === undefined) throw new Error("Verification evidence unavailable");
  expect(Buffer.byteLength(evidence.stdout)).toBeLessThanOrEqual(8192);
  expect(Buffer.byteLength(evidence.stderr)).toBeLessThanOrEqual(8192);
  expect(evidence.stdout).not.toContain(root);
  expect(evidence.stdout).not.toContain("�");
  expect(evidence.stderr).not.toContain("�");
  expect(evidence).toMatchObject({
    stdoutTruncated: true,
    stderrTruncated: true,
    outcome: "passed",
  });
});
