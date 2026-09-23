// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FactoryConceptualReviewWorkflowRead, FactoryFeatureMerge } from "@kestrel/contracts";

import { FeatureMergePanel } from "./FeatureMergePanel.js";

const projectId = "01991c36-7f90-7000-8000-000000000001";
const featureId = "01991c36-7f90-7000-8000-000000000002";
const workflowId = "01991c36-7f90-7000-8000-000000000003";
const artifactId = "01991c36-7f90-7000-8000-000000000004";
const head = "b".repeat(40);
const at = "2026-09-19T12:00:00.000Z";
const pullRequest = {
  repository: { id: "1", owner: "example", name: "factory" },
  id: "2",
  nodeId: "PR_example",
  repositoryNodeId: "R_example",
  authorNodeId: "U_example",
  number: 8,
  url: "https://github.com/example/factory/pull/8",
  state: "open" as const,
  author: "operator",
  title: "Feature",
  body: "Feature\n<!-- kestrel:feature-pr:test -->",
  marker: "<!-- kestrel:feature-pr:test -->",
  baseRef: "master",
  headRef: `kestrel/feature/${featureId}`,
  baseCommitId: "a".repeat(40),
  headCommitId: head,
};
const publication = { certificate: { id: artifactId }, pullRequest };
const review = {
  schemaVersion: 1,
  workflow: {
    id: workflowId,
    requestId: workflowId,
    projectId,
    featureId,
    changeProposalId: featureId,
    inputDigest: "c".repeat(64),
    reviewRevisionId: artifactId,
    state: "published",
    attempt: { current: 1, maximum: 3 },
    failure: null,
    artifactId,
    requestedAt: at,
    startedAt: at,
    finishedAt: at,
  },
  artifact: {
    schemaVersion: 1,
    id: artifactId,
    workflowId,
    inputDigest: "c".repeat(64),
    reviewRevisionId: artifactId,
    baseCommitId: pullRequest.baseCommitId,
    headCommitId: head,
    status: "complete",
    evidenceScope: {
      source: "exact_retained_revision",
      executedChecks: "linked_final_certificate",
      narrativeAuthority: "host_resolved_evidence_model_judgment",
    },
    graph: {
      result: "complete",
      summary: "Delivered",
      outcomes: [],
      behavioralSteps: [],
      evidence: [],
      problems: [],
      edges: [],
      limitations: [],
    },
    createdAt: at,
  },
  currency: "up_to_date",
} as unknown as FactoryConceptualReviewWorkflowRead;
const queuedMerge: FactoryFeatureMerge = {
  schemaVersion: 1,
  id: artifactId,
  featureId,
  approvedVersion: 2,
  requestedByOperatorId: projectId,
  sourceReview: {
    workflowId,
    artifactId,
    reviewRevisionId: artifactId,
    baseCommitId: pullRequest.baseCommitId,
    headCommitId: head,
  },
  pullRequest,
  certificateId: artifactId,
  state: "queued",
  failure: null,
  canRetry: false,
  provider: { merged: false, mergeCommitId: null, mergedAt: null },
  issues: [
    {
      workItemId: projectId,
      key: "W1",
      number: 10,
      url: "https://github.com/example/factory/issues/10",
      state: "pending",
      failure: null,
      attempts: 0,
      closedAt: null,
    },
  ],
  createdAt: at,
  updatedAt: at,
  completedAt: null,
};

let root: Root;
let container: HTMLDivElement;
const renderAct = async (action: () => unknown) => {
  await act(async () => {
    await Promise.resolve(action());
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => "c9a433e0-ad98-4d05-ad90-7b0d75ddf84b" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await renderAct(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("requires an explicit acknowledgement before approving the exact reviewed head", async () => {
  const approve = vi.fn(() => Promise.resolve(queuedMerge));
  await renderAct(() =>
    root.render(
      createElement(FeatureMergePanel, {
        projectId,
        featureId,
        approvedVersion: 2,
        review,
        publication,
        online: true,
        onAuthenticationError: vi.fn(() => false),
        loadCurrent: vi.fn(() => Promise.resolve({ schemaVersion: 1 as const, merge: null })),
        approveMerge: approve,
        retryMerge: vi.fn(),
      }),
    ),
  );
  expect(container.textContent).toContain("Approve exact reviewed head");
  expect(container.textContent).toContain("All final checks are linked");
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent.includes("Approve and merge"),
  );
  const checkbox = container.querySelector('[role="checkbox"]');
  if (button === undefined || !(checkbox instanceof HTMLElement))
    throw new Error("Missing explicit merge controls");
  expect(button.disabled).toBe(true);
  await renderAct(() => checkbox.click());
  expect(button.disabled).toBe(false);
  await renderAct(() => {
    button.click();
    button.click();
  });
  expect(approve).toHaveBeenCalledOnce();
  expect(approve).toHaveBeenCalledWith(projectId, featureId, {
    requestId: "c9a433e0-ad98-4d05-ad90-7b0d75ddf84b",
    decision: "approve_merge",
    expectedPlanVersion: 2,
    review: { workflowId, artifactId, headCommitId: head },
  });
});

it("shows per-issue closure failure and retries without new merge authority", async () => {
  const failed: FactoryFeatureMerge = {
    ...queuedMerge,
    pullRequest: { ...pullRequest, state: "closed" },
    state: "closing_issues",
    failure: "issue_closure_failed",
    canRetry: true,
    provider: { merged: true, mergeCommitId: "d".repeat(40), mergedAt: at },
    issues: [
      {
        workItemId: projectId,
        key: "W1",
        number: 10,
        url: "https://github.com/example/factory/issues/10",
        state: "failed",
        failure: "rate_limited",
        attempts: 1,
        closedAt: null,
      },
    ],
  };
  const retry = vi
    .fn()
    .mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValueOnce(failed);
  const onFeatureChanged = vi.fn();
  await renderAct(() =>
    root.render(
      createElement(FeatureMergePanel, {
        projectId,
        featureId,
        approvedVersion: 2,
        review,
        publication,
        online: true,
        onAuthenticationError: vi.fn(() => false),
        onFeatureChanged,
        loadCurrent: vi.fn(() => Promise.resolve({ schemaVersion: 1 as const, merge: failed })),
        approveMerge: vi.fn(),
        retryMerge: retry,
      }),
    ),
  );
  expect(container.textContent).toContain("PR merged");
  expect(container.textContent).toContain("W1 · issue #10");
  expect(container.textContent).toContain("rate limited");
  expect(onFeatureChanged).toHaveBeenCalledOnce();
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent.includes("Retry remaining work"),
  );
  if (button === undefined) throw new Error("Missing merge retry");
  await renderAct(() => button.click());
  await renderAct(() => button.click());
  expect(retry).toHaveBeenCalledTimes(2);
  expect(retry).toHaveBeenNthCalledWith(1, projectId, featureId, {
    requestId: "c9a433e0-ad98-4d05-ad90-7b0d75ddf84b",
  });
  expect(retry).toHaveBeenNthCalledWith(2, projectId, featureId, {
    requestId: "c9a433e0-ad98-4d05-ad90-7b0d75ddf84b",
  });
});
