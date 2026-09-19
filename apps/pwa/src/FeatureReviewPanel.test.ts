// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type {
  FactoryConceptualReviewPreparation,
  FactoryConceptualReviewDraft,
  FactoryConceptualReviewStartCommand,
  FactoryConceptualReviewWorkflowRead,
} from "@kestrel/contracts";
import { FeatureReviewPanel } from "./FeatureReviewPanel.js";
import { ReviewEvidenceInspector } from "./ReviewEvidenceInspector.js";

const projectId = "01991c36-7f90-7000-8000-000000000001";
const featureId = "01991c36-7f90-7000-8000-000000000002";
const evidenceId = "01991c36-7f90-7000-8000-000000000003";
const baseCommitId = "a".repeat(40);
const headCommitId = "b".repeat(40);
const treeId = "c".repeat(40);
const digest = "d".repeat(64);
const at = "2026-09-19T12:00:00.000Z";
const command = { program: "npm", args: ["test"], cwd: ".", timeoutSeconds: 60 };
const preparation: FactoryConceptualReviewPreparation = {
  schemaVersion: 1,
  projectId,
  featureId,
  changeProposalId: featureId,
  preparationDigest: digest,
  basis: {
    objective: "Refresh search results automatically",
    scope: { includes: ["Refresh visible results"], excludes: ["Change ranking"] },
    outcomes: [
      {
        key: "refresh",
        outcome: "A new result appears without reopening the page",
        intent: { kind: "approved_feature_plan", label: "Approved Feature plan · version 1" },
      },
    ],
    provenance: {
      planVersionId: projectId,
      version: 1,
      author: "assistant",
      approvalId: featureId,
      approvedByOperatorId: projectId,
      approvedAt: at,
      planDigest: digest,
    },
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
      title: "Refresh search results",
      body: "Approved Feature\n<!-- exact -->",
      marker: "<!-- exact -->",
      baseRef: "master",
      headRef: "kestrel/search",
      baseCommitId,
      headCommitId,
    },
    revision: {
      id: projectId,
      state: "available",
      objectFormat: "sha1",
      base: { objectId: baseCommitId, ref: "master" },
      head: { objectId: headCommitId, ref: "kestrel/search" },
      objectCount: 4,
      retainedBytes: 100,
      failureReason: null,
      createdAt: at,
      availableAt: at,
    },
    retainedManifestDigest: digest,
    certificate: {
      id: projectId,
      featureId,
      approvedVersion: 1,
      runId: featureId,
      source: { repositoryId: projectId, identity: digest },
      revision: { baseCommitId, headCommitId, treeId, branch: "refs/heads/kestrel/search" },
      manifest: [{ position: 1, command, origins: [{ workItemKey: "search", position: 1 }] }],
      manifestDigest: digest,
      evidenceIds: [evidenceId],
      createdAt: at,
    },
  },
  evidence: {
    source: {
      baseCommitId,
      headCommitId,
      retainedManifestDigest: digest,
      limits: { catalogPageEntries: 200, fileBytes: 524288, lineRange: 200, responseBytes: 32768 },
    },
    checks: {
      runId: featureId,
      manifestDigest: digest,
      total: 1,
      limits: { catalogPageEntries: 100, outputBytesPerStream: 8192 },
    },
  },
  configuration: {
    model: { route: "codex_subscription", modelId: "gpt-6-astra" },
    runtimePolicy: {
      kind: "retained_source_review",
      version: 1,
      adapter: "codex_app_server",
      adapterVersion: 1,
      containerImage: null,
      containerUser: null,
      codexExecutable: null,
      codexExecutableDigest: null,
      codexVersion: null,
      codexProtocol: "app_server_v2",
      sourceAccess: "retained_read_only",
      networkAccess: false,
      writeAccess: false,
      status: "unavailable",
    },
    resources: {
      maximumAttempts: 3,
      timeoutSeconds: 900,
      maximumEvidenceItems: 400,
      maximumWorkspaceFiles: 20_000,
      maximumWorkspaceBytes: 268435456,
      maximumGraphNodes: 800,
      maximumOutputBytes: 131072,
      containerPidsLimit: 128,
      containerMemoryBytes: 1073741824,
      containerNanoCpus: 2000000000,
      containerTmpfsBytes: 67108864,
    },
  },
  readiness: { state: "blocked", startAllowed: false, blockers: ["review_runtime_unavailable"] },
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const renderAct = async (action: () => unknown) => {
  await act(async () => {
    await Promise.resolve(action());
  });
};
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find((node) =>
    node.textContent.includes(label),
  );
  if (found === undefined) throw new Error(`No button: ${label}`);
  return found;
};

it("explains the exact approved basis and exposes source and check inspectors without starting review", async () => {
  const loadPreparation = vi.fn(() => Promise.resolve(preparation));
  const loadSourceCatalog = vi.fn(() =>
    Promise.resolve({
      schemaVersion: 1 as const,
      side: "head" as const,
      commitId: headCommitId,
      entries: [
        { mode: "100644" as const, type: "blob" as const, objectId: treeId, path: "src/search.ts" },
      ],
      offset: 0,
      total: 1,
      nextOffset: null,
    }),
  );
  const loadSourceLines = vi.fn(() =>
    Promise.resolve({
      status: "available" as const,
      side: "head" as const,
      commitId: headCommitId,
      mode: "100644" as const,
      type: "blob" as const,
      objectId: treeId,
      path: "src/search.ts",
      startLine: 1,
      endLine: 1,
      totalLines: 4,
      hasFinalNewline: true,
      lineEndings: ["lf" as const],
      text: "refresh();\n",
    }),
  );
  const loadChecks = vi.fn(() =>
    Promise.resolve({
      schemaVersion: 1 as const,
      runId: featureId,
      manifestDigest: digest,
      checks: [
        {
          evidenceId,
          runId: featureId,
          manifestPosition: 1,
          origins: [{ workItemKey: "search", position: 1 }],
          command,
          headCommitId,
          treeId,
          outcome: "passed" as const,
          exitCode: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 123,
          createdAt: at,
        },
      ],
      offset: 0,
      total: 1,
      nextOffset: null,
    }),
  );
  const loadCheck = vi.fn(() =>
    Promise.resolve({
      schemaVersion: 1 as const,
      evidenceId,
      runId: featureId,
      manifestPosition: 1,
      origins: [{ workItemKey: "search", position: 1 }],
      result: {
        id: evidenceId,
        round: 1,
        position: 1,
        command,
        headCommitId,
        treeId,
        outcome: "passed" as const,
        exitCode: 0,
        stdout: "search passed\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 123,
        createdAt: at,
      },
    }),
  );
  await renderAct(() =>
    root.render(
      createElement(FeatureReviewPanel, {
        projectId,
        featureId,
        online: true,
        onAuthenticationError: vi.fn(() => false),
        loadPreparation,
        loadCurrentReview: vi.fn(() =>
          Promise.resolve({ schemaVersion: 1 as const, review: null }),
        ),
        loadSourceCatalog,
        loadSourceLines,
        loadChecks,
        loadCheck,
      }),
    ),
  );
  expect(container.textContent).toContain("Refresh search results automatically");
  expect(container.textContent).toContain("A new result appears without reopening the page");
  expect(container.textContent).toContain("Outcome → behavior → evidence → problem");
  expect(
    container.querySelector('a[href="https://github.com/example/search/pull/9"]'),
  ).not.toBeNull();
  expect(button("Start review")).toHaveProperty("disabled", true);
  expect(container.textContent).toContain("review runner is not available yet");
  expect(container.textContent).toContain(digest);
  expect(container.textContent).toContain("gpt-6-astra");
  expect(container.textContent).toContain("400 source evidence items");
  expect(container.textContent).toContain("128 container processes");
  expect(container.textContent).toContain("67108864 aggregate tmpfs bytes");
  expect(container.textContent).toContain("200 paths per page");

  await renderAct(() => button("Browse head source").click());
  await renderAct(() => button("src/search.ts").click());
  expect(loadSourceLines).toHaveBeenCalledWith(projectId, featureId, "head", "src/search.ts", 1, 1);
  expect(container.textContent).toContain("refresh();");

  await renderAct(() => button("Inspect final checks").click());
  expect(container.textContent).toContain("npm test");
  await renderAct(() => button("Open result").click());
  expect(container.textContent).toContain("search passed");
});

it("pages every bounded catalog and reads an operator-selected exact source range", async () => {
  const secondEvidenceId = "01991c36-7f90-7000-8000-000000000004";
  const loadSourceCatalog = vi
    .fn()
    .mockResolvedValueOnce({
      schemaVersion: 1 as const,
      side: "head" as const,
      commitId: headCommitId,
      entries: [],
      offset: 0,
      total: 201,
      nextOffset: 200,
    })
    .mockResolvedValueOnce({
      schemaVersion: 1 as const,
      side: "head" as const,
      commitId: headCommitId,
      entries: [
        { mode: "100644" as const, type: "blob" as const, objectId: treeId, path: "src/last.ts" },
      ],
      offset: 200,
      total: 201,
      nextOffset: null,
    });
  const loadSourceLines = vi.fn(
    (
      _project: string,
      _feature: string,
      side: "base" | "head",
      path: string,
      startLine: number,
      endLine: number,
    ) =>
      Promise.resolve({
        status: "available" as const,
        side,
        commitId: headCommitId,
        mode: "100644" as const,
        type: "blob" as const,
        objectId: treeId,
        path,
        startLine,
        endLine,
        totalLines: 500,
        hasFinalNewline: true,
        lineEndings: ["lf" as const],
        text: `lines ${String(startLine)}-${String(endLine)}\n`,
      }),
  );
  const checkSummary = (id: string, position: number) => ({
    evidenceId: id,
    runId: featureId,
    manifestPosition: position,
    origins: [{ workItemKey: "search", position }],
    command,
    headCommitId,
    treeId,
    outcome: "passed" as const,
    exitCode: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 123,
    createdAt: at,
  });
  const loadChecks = vi
    .fn()
    .mockResolvedValueOnce({
      schemaVersion: 1 as const,
      runId: featureId,
      manifestDigest: digest,
      checks: [checkSummary(evidenceId, 1)],
      offset: 0,
      total: 101,
      nextOffset: 100,
    })
    .mockResolvedValueOnce({
      schemaVersion: 1 as const,
      runId: featureId,
      manifestDigest: digest,
      checks: [checkSummary(secondEvidenceId, 101)],
      offset: 100,
      total: 101,
      nextOffset: null,
    });
  await renderAct(() =>
    root.render(
      createElement(FeatureReviewPanel, {
        projectId,
        featureId,
        online: true,
        onAuthenticationError: vi.fn(() => false),
        loadPreparation: vi.fn(() => Promise.resolve(preparation)),
        loadCurrentReview: vi.fn(() =>
          Promise.resolve({ schemaVersion: 1 as const, review: null }),
        ),
        loadSourceCatalog,
        loadSourceLines,
        loadChecks,
        loadCheck: vi.fn(),
      }),
    ),
  );

  await renderAct(() => button("Browse head source").click());
  await renderAct(() => button("Next source page").click());
  expect(loadSourceCatalog).toHaveBeenLastCalledWith(projectId, featureId, "head", 200, 200);
  await renderAct(() => button("src/last.ts").click());
  expect(loadSourceLines).toHaveBeenLastCalledWith(
    projectId,
    featureId,
    "head",
    "src/last.ts",
    1,
    1,
  );

  const setNumber = async (label: string, value: string) => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (input === null) throw new Error(`No input: ${label}`);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its concrete input.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("Native input setter unavailable");
    await renderAct(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await setNumber("Start line", "201");
  await setNumber("End line", "350");
  await renderAct(() => button("Read source range").click());
  expect(loadSourceLines).toHaveBeenLastCalledWith(
    projectId,
    featureId,
    "head",
    "src/last.ts",
    201,
    350,
  );

  await renderAct(() => button("Inspect final checks").click());
  await renderAct(() => button("Next checks page").click());
  expect(loadChecks).toHaveBeenLastCalledWith(projectId, featureId, 100, 100);
});

it("clears loaded evidence when refreshed preparation no longer matches", async () => {
  const blocked: FactoryConceptualReviewPreparation = {
    ...preparation,
    preparationDigest: null,
    evidence: null,
    readiness: {
      state: "blocked",
      startAllowed: false,
      blockers: ["exact_revision_mismatch", "review_runtime_unavailable"],
    },
  };
  const loadPreparation = vi.fn().mockResolvedValueOnce(preparation).mockResolvedValueOnce(blocked);
  await renderAct(() =>
    root.render(
      createElement(FeatureReviewPanel, {
        projectId,
        featureId,
        online: true,
        onAuthenticationError: vi.fn(() => false),
        loadPreparation,
        loadCurrentReview: vi.fn(() =>
          Promise.resolve({ schemaVersion: 1 as const, review: null }),
        ),
        loadSourceCatalog: vi.fn(() =>
          Promise.resolve({
            schemaVersion: 1 as const,
            side: "head" as const,
            commitId: headCommitId,
            entries: [
              {
                mode: "100644" as const,
                type: "blob" as const,
                objectId: treeId,
                path: "src/old.ts",
              },
            ],
            offset: 0,
            total: 1,
            nextOffset: null,
          }),
        ),
        loadSourceLines: vi.fn(() =>
          Promise.resolve({
            status: "available" as const,
            side: "head" as const,
            commitId: headCommitId,
            mode: "100644" as const,
            type: "blob" as const,
            objectId: treeId,
            path: "src/old.ts",
            startLine: 1,
            endLine: 1,
            totalLines: 1,
            hasFinalNewline: true,
            lineEndings: ["lf" as const],
            text: "stale exact evidence\n",
          }),
        ),
        loadChecks: vi.fn(),
        loadCheck: vi.fn(),
      }),
    ),
  );
  await renderAct(() => button("Browse head source").click());
  await renderAct(() => button("src/old.ts").click());
  expect(container.textContent).toContain("stale exact evidence");

  await renderAct(() => button("Refresh exact inputs").click());
  expect(container.textContent).toContain("retained source does not match");
  expect(container.textContent).not.toContain("stale exact evidence");
  expect(container.textContent).not.toContain("src/old.ts");
});

it("starts a durable review, survives polling, and traverses outcome to exact finding", async () => {
  vi.useFakeTimers();
  const ready: FactoryConceptualReviewPreparation = {
    ...preparation,
    configuration: {
      ...preparation.configuration,
      runtimePolicy: {
        ...preparation.configuration.runtimePolicy,
        containerImage: `sha256:${"1".repeat(64)}`,
        containerUser: "501:20",
        codexExecutable: "/usr/local/bin/codex",
        codexExecutableDigest: "e".repeat(64),
        codexVersion: "0.155.1",
        status: "available",
      },
    },
    readiness: { state: "ready", startAllowed: true, blockers: [] },
  };
  const workflow = {
    id: "01991c36-7f90-7000-8000-000000000009",
    requestId: "65cc9964-10c2-49d1-86c4-8f13f5019e86",
    projectId,
    featureId,
    changeProposalId: featureId,
    inputDigest: digest,
    reviewRevisionId: projectId,
    attempt: { current: 0, maximum: 3 },
    failure: null,
    artifactId: null,
    requestedAt: at,
    startedAt: null,
    finishedAt: null,
  };
  const queued: FactoryConceptualReviewWorkflowRead = {
    schemaVersion: 1,
    workflow: { ...workflow, state: "queued" },
    artifact: null,
    currency: "up_to_date",
  };
  const artifact = {
    schemaVersion: 1 as const,
    id: "01991c36-7f90-7000-8000-000000000010",
    workflowId: workflow.id,
    inputDigest: digest,
    reviewRevisionId: projectId,
    baseCommitId,
    headCommitId,
    status: "partial" as const,
    evidenceScope: {
      source: "exact_retained_revision" as const,
      executedChecks: "not_linked" as const,
      narrativeAuthority: "source_only_model_interpretation" as const,
    },
    createdAt: at,
    graph: {
      result: "partial" as const,
      summary: "Search refresh is implemented with one edge-case risk.",
      outcomes: [
        {
          id: "outcome:refresh",
          outcomeKey: "refresh",
          title: "Refresh visible results",
          coverage: "mapped" as const,
          behavioralStepIds: ["step:refresh"],
          reason: "The head updates results.",
        },
      ],
      behavioralSteps: [
        {
          id: "step:refresh",
          title: "Replace the visible list",
          description: "The completed request replaces current results.",
          change: "modified" as const,
          outcomeKeys: ["refresh"],
          evidenceIds: ["source:refresh"],
        },
      ],
      evidence: [
        {
          id: "source:refresh",
          type: "source" as const,
          side: "head" as const,
          path: "src/search.ts",
          startLine: 4,
          endLine: 4,
          description: "Search completion handler",
          sufficiency: "Shows the result replacement.",
          limitations: [],
        },
      ],
      problems: [
        {
          id: "finding:stale",
          type: "finding" as const,
          title: "Older responses can win",
          condition: "Two requests finish out of order.",
          consequence: "Stale results replace the latest query.",
          reasoning: "The handler has no request identity check.",
          evidenceIds: ["source:refresh"],
          riskLevel: "medium" as const,
          sufficiency: "The exact head assigns every response.",
          limitations: [],
        },
      ],
      edges: [
        { from: "outcome:refresh", to: "step:refresh", kind: "implemented_by" as const },
        { from: "step:refresh", to: "source:refresh", kind: "supported_by" as const },
        { from: "source:refresh", to: "finding:stale", kind: "reveals" as const },
      ],
      limitations: ["Browser interaction was not observed."],
    },
  };
  const published: FactoryConceptualReviewWorkflowRead = {
    schemaVersion: 1,
    workflow: {
      ...workflow,
      state: "published",
      attempt: { current: 1, maximum: 3 },
      artifactId: artifact.id,
      startedAt: at,
      finishedAt: at,
    },
    artifact,
    currency: "outdated",
  };
  const cleanupPending: FactoryConceptualReviewWorkflowRead = {
    schemaVersion: 1,
    workflow: {
      ...workflow,
      state: "failed",
      attempt: { current: 1, maximum: 3 },
      failure: "stop_unconfirmed",
      startedAt: at,
      finishedAt: at,
    },
    artifact: null,
    currency: "unknown",
  };
  const startReview = vi
    .fn<
      (
        projectId: string,
        featureId: string,
        command: FactoryConceptualReviewStartCommand,
        signal?: AbortSignal,
      ) => Promise<FactoryConceptualReviewWorkflowRead>
    >()
    .mockRejectedValueOnce(new Error("accepted response was lost"))
    .mockResolvedValueOnce(queued);
  const loadReviewWorkflow = vi
    .fn()
    .mockRejectedValueOnce(new Error("temporary status read failure"))
    .mockResolvedValueOnce(cleanupPending)
    .mockResolvedValueOnce(published);
  const loadPreparation = vi.fn(() => Promise.resolve(ready));
  const loadSourceLines = vi.fn(() =>
    Promise.resolve({
      status: "available" as const,
      side: "head" as const,
      commitId: headCommitId,
      mode: "100644" as const,
      type: "blob" as const,
      objectId: treeId,
      path: "src/search.ts",
      startLine: 4,
      endLine: 4,
      totalLines: 9,
      hasFinalNewline: true,
      lineEndings: ["lf" as const],
      text: "setResults(response);\n",
    }),
  );
  let resolveStaleCurrent!: (value: { schemaVersion: 1; review: null }) => void;
  const staleCurrent = new Promise<{ schemaVersion: 1; review: null }>((resolve) => {
    resolveStaleCurrent = resolve;
  });
  const loadCurrentReview = vi.fn<
    (
      projectId: string,
      featureId: string,
      signal?: AbortSignal,
    ) => Promise<{ schemaVersion: 1; review: FactoryConceptualReviewWorkflowRead | null }>
  >(() => staleCurrent);
  await renderAct(() =>
    root.render(
      createElement(FeatureReviewPanel, {
        projectId,
        featureId,
        online: true,
        onAuthenticationError: vi.fn(() => false),
        loadPreparation,
        loadCurrentReview,
        loadReviewWorkflow,
        startReview,
        loadSourceCatalog: vi.fn(),
        loadReviewSourceLines: loadSourceLines,
        loadChecks: vi.fn(),
        loadCheck: vi.fn(),
      }),
    ),
  );
  await renderAct(() => button("Start review").click());
  expect(container.textContent).toContain("Conceptual Review was not started");
  const firstCommand = startReview.mock.calls[0]?.[2];
  await renderAct(() => button("Start review").click());
  expect(startReview).toHaveBeenCalledTimes(2);
  expect(startReview.mock.calls[1]?.[2]).toEqual(firstCommand);
  expect(container.textContent).toContain("Review queued");
  await renderAct(() => resolveStaleCurrent({ schemaVersion: 1, review: null }));
  expect(container.textContent).toContain("Review queued");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(container.textContent).toContain("The running review status is unavailable");
  expect(container.textContent).toContain("Review queued");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(loadReviewWorkflow).toHaveBeenCalledWith(
    projectId,
    featureId,
    workflow.id,
    expect.any(AbortSignal),
  );
  expect(loadReviewWorkflow).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("The running review status is unavailable");
  expect(container.textContent).toContain("environment cleanup is still pending");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(loadReviewWorkflow).toHaveBeenCalledTimes(3);
  expect(container.textContent).toContain("Search refresh is implemented");
  expect(container.textContent).toContain("Outdated · PR head moved");
  expect(container.textContent).toContain("model interpretation of exact retained source");
  expect(container.querySelector("aside")?.className).toContain("[overflow-wrap:anywhere]");
  expect(container.querySelector("aside")?.hasAttribute("aria-live")).toBe(false);
  await renderAct(() => button("Search completion handler").click());
  expect(container.textContent).toContain("setResults(response)");
  const sourceStatus = container.querySelector('[role="status"]');
  expect(sourceStatus?.textContent).toBe("Loaded source evidence src/search.ts");
  expect(sourceStatus?.querySelector("pre")).toBeNull();
  expect(loadSourceLines).toHaveBeenCalledWith(
    projectId,
    featureId,
    workflow.id,
    "head",
    "src/search.ts",
    4,
    4,
    expect.any(AbortSignal),
  );
  await renderAct(() => button("Older responses can win").click());
  expect(container.textContent).toContain("medium risk");
  expect(container.textContent).toContain("Stale results replace the latest query");
  loadPreparation.mockResolvedValueOnce({
    ...ready,
    preparationDigest: "f".repeat(64),
    configuration: {
      ...ready.configuration,
      model: { ...ready.configuration.model, modelId: "gpt-6-astra-v2" },
    },
  });
  loadCurrentReview.mockResolvedValueOnce({ schemaVersion: 1, review: published });
  await renderAct(() => button("Refresh exact inputs").click());
  expect(container.textContent).toContain("Review inputs changed");
  expect(container.textContent).toContain("earlier immutable review");
  loadPreparation.mockResolvedValueOnce({
    ...ready,
    preparationDigest: null,
    readiness: {
      state: "blocked",
      startAllowed: false,
      blockers: ["review_runtime_unavailable"],
    },
  });
  loadCurrentReview.mockResolvedValueOnce({ schemaVersion: 1, review: published });
  await renderAct(() => button("Refresh exact inputs").click());
  expect(container.textContent).toContain("Review inputs changed");
  expect(container.textContent).toContain("earlier immutable review");
  vi.useRealTimers();
});

it("clears the previous Project review immediately when switching while offline", async () => {
  await renderAct(() =>
    root.render(
      createElement(FeatureReviewPanel, {
        projectId,
        featureId,
        online: true,
        onAuthenticationError: vi.fn(() => false),
        loadPreparation: vi.fn(() => Promise.resolve(preparation)),
        loadCurrentReview: vi.fn(() =>
          Promise.resolve({ schemaVersion: 1 as const, review: null }),
        ),
        loadSourceCatalog: vi.fn(),
        loadChecks: vi.fn(),
        loadCheck: vi.fn(),
      }),
    ),
  );
  expect(container.textContent).toContain("Refresh search results automatically");

  await renderAct(() =>
    root.render(
      createElement(FeatureReviewPanel, {
        projectId: "01991c36-7f90-7000-8000-000000000099",
        featureId: "01991c36-7f90-7000-8000-000000000098",
        online: false,
        onAuthenticationError: vi.fn(() => false),
        loadPreparation: vi.fn(),
        loadCurrentReview: vi.fn(),
        loadSourceCatalog: vi.fn(),
        loadChecks: vi.fn(),
        loadCheck: vi.fn(),
      }),
    ),
  );

  expect(container.textContent).toContain("Reconnect to inspect review");
  expect(container.textContent).not.toContain("Refresh search results automatically");
});

it("never renders source from the previously selected Evidence under new metadata", async () => {
  const graph: FactoryConceptualReviewDraft = {
    result: "partial",
    summary: "Source-only review.",
    outcomes: [],
    behavioralSteps: [],
    evidence: [
      {
        id: "source:a",
        type: "source",
        side: "head",
        path: "src/a.ts",
        startLine: 1,
        endLine: 1,
        description: "Evidence A",
        sufficiency: "A support",
        limitations: [],
      },
      {
        id: "source:b",
        type: "source",
        side: "head",
        path: "src/b.ts",
        startLine: 2,
        endLine: 2,
        description: "Evidence B",
        sufficiency: "B support",
        limitations: [],
      },
    ],
    problems: [],
    edges: [],
    limitations: [],
  };
  let resolveA!: (value: never) => void;
  let resolveB!: (value: never) => void;
  const pendingA = new Promise<never>((resolve) => {
    resolveA = resolve;
  });
  const pendingB = new Promise<never>((resolve) => {
    resolveB = resolve;
  });
  const loadSourceLines = vi.fn((_project, _feature, _workflow, _side, path: string) =>
    path === "src/a.ts" ? pendingA : pendingB,
  );
  const props = {
    graph,
    projectId,
    featureId,
    workflowId: projectId,
    loadSourceLines,
    onAuthenticationError: vi.fn(() => false),
  };

  await renderAct(() =>
    root.render(createElement(ReviewEvidenceInspector, { ...props, selectedId: "source:a" })),
  );
  await renderAct(() =>
    root.render(createElement(ReviewEvidenceInspector, { ...props, selectedId: "source:b" })),
  );
  expect(container.textContent).toContain("Evidence B");
  expect(container.textContent).toContain("Loading exact retained lines");

  await renderAct(() =>
    resolveA({
      status: "available",
      side: "head",
      commitId: headCommitId,
      mode: "100644",
      objectId: treeId,
      path: "src/a.ts",
      type: "blob",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      hasFinalNewline: true,
      lineEndings: ["lf"],
      text: "old source A\n",
    } as never),
  );
  expect(container.textContent).not.toContain("old source A");

  await renderAct(() =>
    resolveB({
      status: "available",
      side: "head",
      commitId: headCommitId,
      mode: "100644",
      objectId: treeId,
      path: "src/b.ts",
      type: "blob",
      startLine: 2,
      endLine: 2,
      totalLines: 2,
      hasFinalNewline: true,
      lineEndings: ["lf"],
      text: "current source B\n",
    } as never),
  );
  expect(container.textContent).toContain("current source B");
});
