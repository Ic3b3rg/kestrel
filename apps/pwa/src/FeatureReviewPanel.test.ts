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

  await renderAct(() => button("Browse head source").click());
  await renderAct(() => button("src/search.ts").click());
  expect(loadSourceLines).toHaveBeenCalledWith(projectId, featureId, "head", "src/search.ts", 1, 1);
  expect(container.textContent).toContain("refresh();");

  await renderAct(() => button("Inspect final checks").click());
  expect(container.textContent).toContain("npm test");
  await renderAct(() => button("Open result").click());
  expect(container.textContent).toContain("search passed");
});
