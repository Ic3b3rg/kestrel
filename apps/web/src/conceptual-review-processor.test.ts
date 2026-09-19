import { expect, it, vi } from "vitest";

import type {
  FactoryConceptualReviewDraft,
  FactoryConceptualReviewPreparation,
} from "@kestrel/contracts";
import { FactoryConceptualReviewDraftSchema } from "@kestrel/contracts";
import type { CodexReviewRuntime } from "./codex-review-runtime.js";
import { CodexExecutionError, type CodexExecutionTurnInput } from "./codex-execution-runtime.js";
import { FactoryGitHubError } from "./factory-github.js";

const db = vi.hoisted(() => ({
  claim: vi.fn(),
  fail: vi.fn(),
  heartbeat: vi.fn(),
  identifyContainer: vi.fn(),
  observeHead: vi.fn(),
  publish: vi.fn(),
  readCheck: vi.fn(),
  readChecks: vi.fn(),
  readBinding: vi.fn(),
  recordResourceDisposal: vi.fn(),
  recordSession: vi.fn(),
  reserveContainer: vi.fn(),
  stopContainer: vi.fn(),
}));
const source = vi.hoisted(() => ({
  disposeControl: vi.fn(),
  openReader: vi.fn(),
  prepareControl: vi.fn(),
  readChange: vi.fn(),
  readLines: vi.fn(),
}));
const reviewRuntime = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@kestrel/database", () => ({
  FactoryConceptualReviewWorkflowPersistenceError: class extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
  claimFactoryConceptualReviewWorkflow: db.claim,
  failFactoryConceptualReviewWorkflow: db.fail,
  heartbeatFactoryConceptualReviewWorkflow: db.heartbeat,
  identifyFactoryConceptualReviewContainer: db.identifyContainer,
  observeFactoryConceptualReviewHead: db.observeHead,
  publishFactoryConceptualReview: db.publish,
  readFactoryConceptualReviewWorkflowCheck: db.readCheck,
  readFactoryConceptualReviewWorkflowChecks: db.readChecks,
  readFactoryConceptualReviewWorkflowSourceBinding: db.readBinding,
  recordFactoryConceptualReviewResourceDisposal: db.recordResourceDisposal,
  recordFactoryConceptualReviewSession: db.recordSession,
  reserveFactoryConceptualReviewContainer: db.reserveContainer,
  stopFactoryConceptualReviewContainer: db.stopContainer,
}));
vi.mock("@kestrel/local-source", () => ({
  ConceptualReviewSourceError: class extends Error {},
  disposeConceptualReviewControlDirectory: source.disposeControl,
  LocalSourceError: class extends Error {},
  materializeConceptualReviewWorkspace: vi.fn(),
  openConceptualReviewSourceReader: source.openReader,
  prepareConceptualReviewControlDirectory: source.prepareControl,
}));
vi.mock("./codex-review-runtime.js", () => ({
  CERTIFIED_CODEX_REVIEW_VERSION: "0.155.1",
  createCodexReviewRuntime: reviewRuntime.create,
}));

import { createFactoryConceptualReviewProcessor } from "./conceptual-review-processor.js";

const workflowId = "01991c36-7f90-7000-8000-000000000005";
const attemptId = "85cc9964-10c2-49d1-86c4-8f13f5019e86";
const projectId = "01991c36-7f90-7000-8000-000000000001";
const featureId = "01991c36-7f90-7000-8000-000000000002";
const digest = "d".repeat(64);
const checkEvidenceId = "01991c36-7f90-7000-8000-000000000006";
const runId = "01991c36-7f90-7000-8000-000000000007";
const verificationCommand = {
  program: "npm",
  args: ["test"],
  cwd: ".",
  timeoutSeconds: 60,
};

const preparation = {
  projectId,
  featureId,
  preparationDigest: digest,
  basis: {
    objective: "Expose the known behavior",
    scope: { includes: ["Search"], excludes: [] },
    outcomes: [{ key: "search", outcome: "Search updates the results" }],
  },
  publication: {
    pullRequest: {
      repository: { id: "42", owner: "example", name: "search" },
      id: "9",
      nodeId: "PR_example",
      repositoryNodeId: "R_example",
      authorNodeId: "U_example",
      author: "operator",
      number: 9,
      url: "https://github.com/example/search/pull/9",
      state: "open",
      title: "Expose search",
      body: "Approved Feature\n<!-- exact -->",
      marker: "<!-- exact -->",
      baseRef: "master",
      headRef: "kestrel/search",
      baseCommitId: "a".repeat(40),
      headCommitId: "b".repeat(40),
    },
    revision: {
      base: { objectId: "a".repeat(40) },
      head: { objectId: "b".repeat(40) },
    },
    certificate: {
      runId,
      revision: { headCommitId: "b".repeat(40), treeId: "c".repeat(40) },
      manifest: [
        {
          position: 1,
          command: verificationCommand,
          origins: [{ workItemKey: "search", position: 1 }],
        },
      ],
      evidenceIds: [checkEvidenceId],
    },
  },
  evidence: {
    checks: { runId, manifestDigest: digest, total: 1 },
  },
  configuration: {
    model: { modelId: "gpt-6-astra" },
    runtimePolicy: {
      kind: "retained_source_review",
      version: 1,
      adapter: "codex_app_server",
      adapterVersion: 1,
      containerImage: `sha256:${"1".repeat(64)}`,
      containerUser: "501:20",
      codexExecutable: "/usr/local/bin/codex",
      codexExecutableDigest: "e".repeat(64),
      codexVersion: "0.155.1",
      codexProtocol: "app_server_v2",
      sourceAccess: "retained_read_only",
      networkAccess: false,
      writeAccess: false,
      status: "available",
    },
    resources: {
      maximumAttempts: 3,
      timeoutSeconds: 60,
      maximumEvidenceItems: 20,
      maximumWorkspaceFiles: 1_000,
      maximumWorkspaceBytes: 16777216,
      maximumGraphNodes: 100,
      maximumOutputBytes: 131072,
      containerPidsLimit: 128,
      containerMemoryBytes: 1073741824,
      containerNanoCpus: 2000000000,
      containerTmpfsBytes: 67108864,
    },
  },
} as unknown as FactoryConceptualReviewPreparation;

const draft: FactoryConceptualReviewDraft = {
  result: "partial",
  summary: "0 of 1 approved outcomes map to exact retained source; 0 problems are identified.",
  outcomes: [
    {
      id: "outcome:search",
      outcomeKey: "search",
      title: "Search updates the results",
      coverage: "unclear",
      behavioralStepIds: ["step:search"],
      reason: "The handler maps this behavior.",
    },
  ],
  behavioralSteps: [
    {
      id: "step:search",
      title: "Update results",
      description: "The handler replaces results after the query.",
      change: "modified",
      outcomeKeys: ["search"],
      evidenceIds: ["source:search"],
    },
  ],
  evidence: [
    {
      id: "source:search",
      type: "source",
      side: "head",
      path: "src/search.ts",
      startLine: 2,
      endLine: 4,
      description: "The result update.",
      sufficiency: "Shows the implemented behavior.",
      limitations: [],
    },
  ],
  problems: [],
  edges: [
    { from: "outcome:search", to: "step:search", kind: "implemented_by" },
    { from: "step:search", to: "source:search", kind: "supported_by" },
  ],
  limitations: ["Browser interaction was not observed."],
};

const modelDraft = {
  ...draft,
  evidence: draft.evidence.map((evidence) =>
    evidence.type === "source"
      ? { ...evidence, evidenceId: null, relation: null, proposition: null }
      : evidence,
  ),
};

async function completeRuntimeTurn(input: CodexExecutionTurnInput, text: string) {
  const container = {
    name: `kestrel-factory-${"a".repeat(32)}`,
    id: "a".repeat(64),
  };
  await input.beforeContainerCreate(container.name, "daemon-1");
  await input.onContainer(container);
  await input.onThread("review-thread");
  await input.onTurn("review-turn");
  await input.onStopped(container);
  return { threadId: "review-thread", turnId: "review-turn", text };
}

function arrange(
  processorOverrides: Omit<
    Partial<Parameters<typeof createFactoryConceptualReviewProcessor>[0]>,
    "runtime"
  > & { runtime?: CodexReviewRuntime | undefined } = {},
) {
  vi.clearAllMocks();
  db.claim.mockResolvedValue({
    workflowId,
    attemptId,
    attemptNumber: 1,
    preparation,
  });
  db.heartbeat.mockResolvedValue(true);
  db.readBinding.mockResolvedValue({
    artifactLocator: `projects/${projectId}/revisions/${workflowId}`,
    manifestDigest: digest,
    expectedBaseCommitId: "a".repeat(40),
    expectedHeadCommitId: "b".repeat(40),
    expectedHeadTreeId: "c".repeat(40),
  });
  db.readChecks.mockResolvedValue({
    schemaVersion: 1,
    runId,
    manifestDigest: digest,
    checks: [
      {
        evidenceId: checkEvidenceId,
        runId,
        manifestPosition: 1,
        origins: [{ workItemKey: "search", position: 1 }],
        command: verificationCommand,
        headCommitId: "b".repeat(40),
        treeId: "c".repeat(40),
        outcome: "passed",
        exitCode: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 123,
        createdAt: "2026-09-19T12:00:00.000Z",
      },
    ],
    offset: 0,
    total: 1,
    nextOffset: null,
  });
  db.readCheck.mockResolvedValue({
    schemaVersion: 1,
    evidenceId: checkEvidenceId,
    runId,
    manifestPosition: 1,
    origins: [{ workItemKey: "search", position: 1 }],
    result: {
      id: checkEvidenceId,
      round: 1,
      position: 1,
      command: verificationCommand,
      headCommitId: "b".repeat(40),
      treeId: "c".repeat(40),
      outcome: "passed",
      exitCode: 0,
      stdout: "<check>passed</check>\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 123,
      createdAt: "2026-09-19T12:00:00.000Z",
    },
  });
  for (const callback of [
    db.reserveContainer,
    db.identifyContainer,
    db.observeHead,
    db.recordSession,
    db.stopContainer,
    db.publish,
    db.recordResourceDisposal,
  ])
    callback.mockResolvedValue(undefined);
  db.fail.mockResolvedValue("failed");
  source.openReader.mockResolvedValue({
    readLines: source.readLines,
    readChange: source.readChange,
  });
  source.prepareControl.mockResolvedValue("/private/review-control");
  source.disposeControl.mockResolvedValue(undefined);
  source.readLines.mockResolvedValue({
    status: "available",
    side: "head",
    commitId: "b".repeat(40),
    mode: "100644",
    objectId: "e".repeat(40),
    path: "src/search.ts",
    type: "blob",
    startLine: 2,
    endLine: 4,
    totalLines: 4,
    hasFinalNewline: true,
    lineEndings: ["lf", "lf", "lf"],
    text: "two\nthree\nfour\n",
  });
  source.readChange.mockResolvedValue({ status: "modified", rangeChanged: true });
  const workspace = {
    path: "/private/materialized-review",
    files: { base: 2, head: 2 },
    verify: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => Promise.resolve()),
  };
  const runTurn = vi.fn((input: CodexExecutionTurnInput) =>
    completeRuntimeTurn(input, JSON.stringify(modelDraft)),
  );
  const runtime: CodexReviewRuntime = { runTurn };
  reviewRuntime.create.mockReturnValue(runtime);
  const { runtime: overriddenRuntime, ...remainingOverrides } = processorOverrides;
  const runtimeOption = Object.hasOwn(processorOverrides, "runtime")
    ? overriddenRuntime === undefined
      ? {}
      : { runtime: overriddenRuntime }
    : { runtime };
  const observePullRequest = vi.fn(() =>
    Promise.resolve({
      baseCommitId: "a".repeat(40),
      headCommitId: "c".repeat(40),
      state: "open" as const,
    }),
  );
  const processor = createFactoryConceptualReviewProcessor({
    pool: {} as never,
    boss: { send: vi.fn() },
    readSourceConfig: vi.fn(() => Promise.resolve({} as never)),
    ...runtimeOption,
    materialize: vi.fn(() => Promise.resolve(workspace)),
    github: { observePullRequest },
    ...remainingOverrides,
  });
  return { processor, runTurn, workspace, observePullRequest };
}

it("refuses to retarget a queued review when the configured runtime profile changes", async () => {
  const { processor } = arrange({
    runtime: undefined,
    containerImage: `sha256:${"2".repeat(64)}`,
    containerUser: "501:20",
    codexExecutable: "/usr/local/bin/codex",
    codexExecutableDigest: "e".repeat(64),
    codexVersion: "0.155.1",
  });

  await processor.process({ workflowId });

  expect(reviewRuntime.create).not.toHaveBeenCalled();
  expect(db.publish).not.toHaveBeenCalled();
  expect(db.fail).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ workflowId, attemptId }),
    "runtime_unavailable",
    true,
    expect.any(Number),
  );
});

it("runs with the exact frozen image, host Codex identity, and container limits", async () => {
  const { processor } = arrange({
    runtime: undefined,
    containerImage: `sha256:${"1".repeat(64)}`,
    containerUser: "501:20",
    codexExecutable: "/usr/local/bin/codex",
    codexExecutableDigest: "e".repeat(64),
    codexVersion: "0.155.1",
  });

  await processor.process({ workflowId });

  expect(reviewRuntime.create).toHaveBeenCalledWith(
    expect.objectContaining({
      containerImage: `sha256:${"1".repeat(64)}`,
      containerUser: "501:20",
      executable: "/usr/local/bin/codex",
      expectedExecutableDigest: "e".repeat(64),
      expectedCodexVersion: "0.155.1",
      containerResources: {
        pidsLimit: 128,
        memoryBytes: 1073741824,
        nanoCpus: 2000000000,
        tmpfsBytes: 67108864,
      },
    }),
  );
  expect(db.publish).toHaveBeenCalledOnce();
});

it("reads source omitted from the prompt, validates it, and publishes once after teardown", async () => {
  const { processor, runTurn, workspace } = arrange();
  await processor.process({ workflowId });
  const turn = runTurn.mock.calls[0]?.[0];
  expect(turn?.prompt).toContain("/workspace/base");
  expect(turn?.prompt).toContain("/workspace/head");
  expect(turn?.prompt).toContain('path:"src/file.ts"');
  expect(turn?.prompt).toContain("mapped outcomes must name at least one Behavioral Step ID");
  expect(turn?.prompt).toContain("Finding evidenceIds may reference head-side evidence only");
  expect(turn?.prompt).toContain('"finalCheckCatalog"');
  expect(turn?.prompt).toContain(checkEvidenceId);
  expect(turn?.prompt).not.toContain('"stdout"');
  expect(turn?.prompt).not.toContain("two\\nthree");
  expect(turn?.outputSchema).toBeDefined();
  expect(source.openReader).toHaveBeenCalledOnce();
  expect(source.readLines).toHaveBeenCalledWith(
    expect.objectContaining({ side: "head", path: "src/search.ts", startLine: 2, endLine: 4 }),
  );
  expect(workspace.verify).toHaveBeenCalledTimes(2);
  expect(workspace.dispose).toHaveBeenCalledOnce();
  expect(db.recordResourceDisposal).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ workflowId, attemptId }),
    expect.any(Number),
  );
  expect(db.observeHead).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ workflowId, attemptId }),
    "c".repeat(40),
    expect.any(Number),
  );
  expect(db.publish).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ workflowId, attemptId }),
    draft,
    expect.any(AbortSignal),
    expect.any(Number),
  );
  expect(db.fail).not.toHaveBeenCalled();
});

it("publishes only server-resolved final-check provenance and never puts output in the prompt", async () => {
  const checkDraft = {
    ...modelDraft,
    result: "complete",
    outcomes: modelDraft.outcomes.map((outcome) => ({ ...outcome, coverage: "mapped" })),
    behavioralSteps: [
      {
        ...draft.behavioralSteps[0],
        evidenceIds: ["source:search", "check:search"],
      },
    ],
    evidence: [
      modelDraft.evidence[0],
      {
        id: "check:search",
        type: "check",
        side: null,
        path: null,
        startLine: null,
        endLine: null,
        evidenceId: checkEvidenceId,
        relation: "supports",
        proposition: "The approved verification command succeeds on the reviewed head.",
        description: "Final Feature verification.",
        sufficiency: "Establishes command success; the behavioral link remains model judgment.",
        limitations: ["No browser timing assertion."],
      },
    ],
    edges: [...draft.edges, { from: "step:search", to: "check:search", kind: "supported_by" }],
    limitations: [],
  };
  const { processor, runTurn } = arrange();
  runTurn.mockImplementationOnce((input) => completeRuntimeTurn(input, JSON.stringify(checkDraft)));

  await processor.process({ workflowId });

  const turn = runTurn.mock.calls[0]?.[0];
  expect(turn?.prompt).toContain(checkEvidenceId);
  expect(turn?.prompt).not.toContain("<check>passed</check>");
  expect(db.readCheck).toHaveBeenCalledWith(
    expect.anything(),
    projectId,
    featureId,
    workflowId,
    checkEvidenceId,
  );
  const publishedInput: unknown = db.publish.mock.calls[0]?.[2];
  const published = FactoryConceptualReviewDraftSchema.parse(publishedInput);
  expect(published.result).toBe("complete");
  const publishedCheck = published.evidence.find(
    (item) => item.type === "check" && item.evidenceId === checkEvidenceId,
  );
  expect(publishedCheck?.type).toBe("check");
  if (publishedCheck?.type !== "check") throw new Error("Expected published check evidence");
  expect(publishedCheck.record).toMatchObject({ runId, outcome: "passed", exitCode: 0 });
});

it("provides all 480 bounded final-check summaries without copying any command output", async () => {
  const { processor, runTurn } = arrange();
  const summaries = Array.from({ length: 480 }, (_, index) => ({
    evidenceId: `01991c36-7f90-7000-8000-${String(index + 1).padStart(12, "0")}`,
    runId,
    manifestPosition: index + 1,
    origins: [
      { workItemKey: `item-${String(Math.floor(index / 12) + 1)}`, position: (index % 12) + 1 },
    ],
    command: {
      program: "npm",
      args: ["test", `check-${String(index + 1)}-${"x".repeat(2_048)}-COMMAND_TAIL_CANARY`],
      cwd: ".",
      timeoutSeconds: 60,
    },
    headCommitId: "b".repeat(40),
    treeId: "c".repeat(40),
    outcome: "passed" as const,
    exitCode: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: index,
    createdAt: "2026-09-19T12:00:00.000Z",
  }));
  db.claim.mockResolvedValue({
    workflowId,
    attemptId,
    attemptNumber: 1,
    preparation: {
      ...preparation,
      evidence: { checks: { runId, manifestDigest: digest, total: summaries.length } },
    },
  });
  db.readChecks.mockImplementation(
    (
      _pool: unknown,
      _project: string,
      _feature: string,
      _workflow: string,
      offset: number,
      limit: number,
    ) => {
      const checks = summaries.slice(offset, offset + limit);
      return Promise.resolve({
        schemaVersion: 1,
        runId,
        manifestDigest: digest,
        checks,
        offset,
        total: summaries.length,
        nextOffset: offset + checks.length < summaries.length ? offset + checks.length : null,
      });
    },
  );

  await processor.process({ workflowId });

  const prompt = runTurn.mock.calls[0]?.[0].prompt ?? "";
  expect(db.readChecks).toHaveBeenCalledTimes(5);
  expect(prompt).toContain(summaries[0]?.evidenceId);
  expect(prompt).toContain(summaries[479]?.evidenceId);
  expect(prompt).not.toContain("FULL_OUTPUT_CANARY");
  expect(prompt).not.toContain("COMMAND_TAIL_CANARY");
  expect(prompt).toContain('"truncated":true');
  expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(512 * 1024);
  expect(db.publish).toHaveBeenCalledOnce();
});

it("fails visibly and never publishes when the model invents a source range", async () => {
  const { processor } = arrange();
  source.readLines.mockResolvedValueOnce({
    status: "unsupported",
    side: "head",
    commitId: "b".repeat(40),
    mode: "120000",
    objectId: "e".repeat(40),
    path: "src/search.ts",
    type: "blob",
    reason: "symlink",
  });
  await processor.process({ workflowId });
  expect(db.publish).not.toHaveBeenCalled();
  expect(db.fail).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ workflowId, attemptId }),
    "source_unavailable",
    false,
    expect.any(Number),
  );
});

it("fails visibly and retries without publishing malformed model JSON", async () => {
  const { processor, runTurn, workspace, observePullRequest } = arrange();
  runTurn.mockImplementationOnce((input) => completeRuntimeTurn(input, "{not-json"));

  await processor.process({ workflowId });

  expect(db.publish).not.toHaveBeenCalled();
  expect(observePullRequest).not.toHaveBeenCalled();
  expect(workspace.verify).toHaveBeenCalledTimes(2);
  expect(db.fail).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ workflowId, attemptId }),
    "invalid_output",
    true,
    expect.any(Number),
  );
});

it("stops for an exhausted Codex usage limit without burning another attempt", async () => {
  const { processor, runTurn } = arrange();
  runTurn.mockImplementationOnce(async (input) => {
    await completeRuntimeTurn(input, JSON.stringify(draft));
    throw new CodexExecutionError("usage_limit");
  });

  await processor.process({ workflowId });

  expect(db.publish).not.toHaveBeenCalled();
  expect(db.fail).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ workflowId, attemptId }),
    "usage_limit",
    false,
    expect.any(Number),
  );
});

it("publishes a validated frozen review when GitHub currency is unavailable", async () => {
  const { processor, observePullRequest } = arrange();
  observePullRequest.mockRejectedValueOnce(new FactoryGitHubError("unavailable"));

  await processor.process({ workflowId });

  expect(db.observeHead).not.toHaveBeenCalled();
  expect(db.publish).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ workflowId, attemptId }),
    draft,
    expect.any(AbortSignal),
    expect.any(Number),
  );
  expect(db.fail).not.toHaveBeenCalled();
});

it("does not publish when the deadline expires during the final provider observation", async () => {
  const controller = new AbortController();
  const { processor } = arrange();
  db.observeHead.mockImplementationOnce(() => {
    controller.abort(new CodexExecutionError("timeout"));
  });

  await processor.process({ workflowId }, controller.signal);

  expect(db.publish).not.toHaveBeenCalled();
  expect(db.fail).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ workflowId, attemptId }),
    "timeout",
    true,
    expect.any(Number),
  );
});

it("rolls back publication when the deadline expires after entering the durable publish", async () => {
  const controller = new AbortController();
  const { processor } = arrange();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  db.publish.mockImplementationOnce(async (_pool, _claim, _draft, signal?: AbortSignal) => {
    enter();
    await released;
    signal?.throwIfAborted();
  });

  const processing = processor.process({ workflowId }, controller.signal);
  await entered;
  controller.abort(new CodexExecutionError("timeout"));
  release();
  await processing;

  expect(db.fail).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ workflowId, attemptId }),
    "timeout",
    true,
    expect.any(Number),
  );
});

it("classifies a plain job abort during durable publication as interrupted", async () => {
  const controller = new AbortController();
  const { processor } = arrange();
  db.publish.mockImplementationOnce((_pool, _claim, _draft, signal?: AbortSignal) => {
    controller.abort();
    signal?.throwIfAborted();
  });

  await processor.process({ workflowId }, controller.signal);

  expect(db.publish).toHaveBeenCalledOnce();
  expect(db.fail).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ workflowId, attemptId }),
    "interrupted",
    true,
    expect.any(Number),
  );
});
