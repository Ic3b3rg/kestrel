// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { FactoryConceptualReviewPreparation } from "@kestrel/contracts";
import { FeatureReviewPanel } from "./FeatureReviewPanel.js";

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
      sourceAccess: "retained_read_only",
      networkAccess: false,
      writeAccess: false,
      status: "unavailable",
    },
    resources: {
      maximumAttempts: 3,
      timeoutSeconds: 900,
      maximumSourceReads: 400,
      maximumGraphNodes: 800,
      maximumOutputBytes: 262144,
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
  expect(container.textContent).toContain("400 source reads");
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
