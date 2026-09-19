import { expect, it, vi } from "vitest";
import * as database from "@kestrel/database";

import { createFactoryFeatureMergeProcessor } from "./factory-feature-merge-processor.js";
import type { FactoryFeatureGitHubAdapter } from "./factory-feature-github.js";

vi.mock("@kestrel/database", async (original) => ({
  ...(await original<typeof database>()),
  claimFactoryFeatureMerge: vi.fn(),
  markFactoryFeatureMergeWrite: vi.fn(),
  completeFactoryFeatureMerge: vi.fn(),
  failFactoryFeatureMerge: vi.fn(),
  claimNextFactoryFeatureMergeIssue: vi.fn(),
  completeFactoryFeatureMergeIssue: vi.fn(),
  failFactoryFeatureMergeIssue: vi.fn(),
  finishFactoryFeatureMerge: vi.fn(),
  queueFactoryExecutions: vi.fn(() => Promise.resolve([])),
}));

const featureId = "01991c36-7f90-7000-8000-000000000001";
const projectId = "01991c36-7f90-7000-8000-000000000002";
const attemptId = "01991c36-7f90-7000-8000-000000000003";
const identity = {
  repository: { id: "42", owner: "example", name: "factory" },
  account: "operator",
};
const pullRequest = {
  repository: identity.repository,
  id: "9",
  nodeId: "PR_example",
  repositoryNodeId: "R_example",
  authorNodeId: "U_example",
  number: 9,
  url: "https://github.com/example/factory/pull/9",
  state: "open" as const,
  author: "operator",
  title: "Keep action visible",
  body: `Approved change\n<!-- kestrel:feature-pr:${featureId} -->`,
  marker: `<!-- kestrel:feature-pr:${featureId} -->`,
  baseRef: "master",
  headRef: `kestrel/feature/${featureId}`,
  baseCommitId: "a".repeat(40),
  headCommitId: "b".repeat(40),
};
const linked = {
  workItemId: projectId,
  key: "W1",
  title: "Persist action",
  issue: {
    repository: identity.repository,
    id: "1",
    number: 1,
    url: "https://github.com/example/factory/issues/1",
  },
};
const claim: database.ClaimedFactoryFeatureMerge = {
  id: attemptId,
  featureId,
  projectId,
  attemptId,
  approvedVersion: 1,
  identity,
  pullRequest,
  sourceReview: {
    workflowId: projectId,
    artifactId: attemptId,
    reviewRevisionId: featureId,
    baseCommitId: pullRequest.baseCommitId,
    headCommitId: pullRequest.headCommitId,
  },
  certificateId: featureId,
  mergeAttempted: false,
  provider: { merged: false, mergeCommitId: null, mergedAt: null },
  issues: [linked],
};

function arrange(
  observation: Partial<
    Awaited<ReturnType<FactoryFeatureGitHubAdapter["inspectPullRequestForMerge"]>>
  > = {},
) {
  vi.clearAllMocks();
  vi.mocked(database.claimFactoryFeatureMerge).mockResolvedValue(claim);
  vi.mocked(database.claimNextFactoryFeatureMergeIssue)
    .mockResolvedValueOnce({
      mergeId: claim.id,
      workItemId: linked.workItemId,
      key: linked.key,
      issue: linked.issue,
    })
    .mockResolvedValueOnce(null);
  const inspectPullRequestForMerge = vi.fn<
    FactoryFeatureGitHubAdapter["inspectPullRequestForMerge"]
  >(() =>
    Promise.resolve({
      baseCommitId: pullRequest.baseCommitId,
      headCommitId: pullRequest.headCommitId,
      state: "open",
      merged: false,
      mergeCommitId: null,
      mergedAt: null,
      mergeable: true,
      checks: [{ name: "ci", state: "success", required: true }],
      ...observation,
    }),
  );
  const mergePullRequest = vi.fn<FactoryFeatureGitHubAdapter["mergePullRequest"]>(() =>
    Promise.resolve({ state: "confirmed", value: { mergeCommitId: "c".repeat(40) } }),
  );
  const closeIssue = vi.fn<FactoryFeatureGitHubAdapter["closeIssue"]>(() =>
    Promise.resolve({ state: "confirmed", value: { closedAt: "2026-09-19T10:11:00.000Z" } }),
  );
  const identify = vi.fn<FactoryFeatureGitHubAdapter["identify"]>(() => Promise.resolve(identity));
  const processor = createFactoryFeatureMergeProcessor({
    pool: {} as never,
    boss: {} as never,
    github: { identify, inspectPullRequestForMerge, mergePullRequest, closeIssue },
  });
  return { processor, inspectPullRequestForMerge, mergePullRequest, closeIssue };
}

it("merges the exact ready head, closes issues, completes and releases the queue", async () => {
  const value = arrange();
  value.inspectPullRequestForMerge
    .mockResolvedValueOnce({
      baseCommitId: pullRequest.baseCommitId,
      headCommitId: pullRequest.headCommitId,
      state: "open",
      merged: false,
      mergeCommitId: null,
      mergedAt: null,
      mergeable: true,
      checks: [{ name: "ci", state: "success", required: true }],
    })
    .mockResolvedValueOnce({
      baseCommitId: pullRequest.headCommitId,
      headCommitId: pullRequest.headCommitId,
      state: "closed",
      merged: true,
      mergeCommitId: "c".repeat(40),
      mergedAt: "2026-09-19T10:10:00.000Z",
      mergeable: null,
      checks: [],
    });
  await value.processor.process({ featureId });
  expect(database.markFactoryFeatureMergeWrite).toHaveBeenCalledWith(expect.anything(), claim);
  expect(value.mergePullRequest).toHaveBeenCalledWith(
    identity,
    pullRequest,
    expect.any(AbortSignal),
  );
  expect(database.completeFactoryFeatureMerge).toHaveBeenCalledWith(expect.anything(), claim, {
    mergeCommitId: "c".repeat(40),
    mergedAt: "2026-09-19T10:10:00.000Z",
  });
  expect(database.queueFactoryExecutions).toHaveBeenCalledOnce();
  expect(database.completeFactoryFeatureMergeIssue).toHaveBeenCalledOnce();
  expect(database.finishFactoryFeatureMerge).toHaveBeenCalledWith(expect.anything(), claim);
});

it.each([
  ["moved head", { headCommitId: "d".repeat(40) }, "pull_request_changed"],
  ["failed check", { checks: [{ name: "ci", state: "failure", required: true }] }, "checks_failed"],
  [
    "pending check",
    { checks: [{ name: "ci", state: "pending", required: true }] },
    "checks_pending",
  ],
  ["conflict", { mergeable: false }, "merge_conflict"],
] as const)("blocks before the provider write for %s", async (_name, observation, failure) => {
  const value = arrange(observation as never);
  await value.processor.process({ featureId });
  expect(database.failFactoryFeatureMerge).toHaveBeenCalledWith(
    expect.anything(),
    claim,
    failure,
    false,
  );
  expect(database.markFactoryFeatureMergeWrite).not.toHaveBeenCalled();
  expect(value.mergePullRequest).not.toHaveBeenCalled();
});

it("retains an uncertain merge for read-before-write reconciliation", async () => {
  const value = arrange();
  value.mergePullRequest.mockResolvedValueOnce({ state: "uncertain", failure: "timeout" });
  await value.processor.process({ featureId });
  expect(database.failFactoryFeatureMerge).toHaveBeenCalledWith(
    expect.anything(),
    claim,
    "uncertain_write",
    true,
  );
  expect(database.completeFactoryFeatureMerge).not.toHaveBeenCalled();
  expect(value.closeIssue).not.toHaveBeenCalled();
});

it("reconciles an attempted merge after restart without a second provider write", async () => {
  vi.clearAllMocks();
  vi.mocked(database.claimFactoryFeatureMerge).mockResolvedValue({
    ...claim,
    mergeAttempted: true,
  });
  vi.mocked(database.claimNextFactoryFeatureMergeIssue).mockResolvedValue(null);
  const value = arrange({
    baseCommitId: pullRequest.headCommitId,
    state: "closed",
    merged: true,
    mergeCommitId: "c".repeat(40),
    mergedAt: "2026-09-19T10:10:00.000Z",
    mergeable: null,
    checks: [],
  });
  vi.mocked(database.claimFactoryFeatureMerge).mockResolvedValue({
    ...claim,
    mergeAttempted: true,
  });
  await value.processor.process({ featureId });
  expect(value.mergePullRequest).not.toHaveBeenCalled();
  expect(database.completeFactoryFeatureMerge).toHaveBeenCalledOnce();
});

it("keeps issue closure failure retryable without repeating a confirmed merge", async () => {
  vi.clearAllMocks();
  vi.mocked(database.claimFactoryFeatureMerge).mockResolvedValue({
    ...claim,
    mergeAttempted: true,
    provider: {
      merged: true,
      mergeCommitId: "c".repeat(40),
      mergedAt: "2026-09-19T10:10:00.000Z",
    },
  });
  vi.mocked(database.claimNextFactoryFeatureMergeIssue)
    .mockResolvedValueOnce({
      mergeId: claim.id,
      workItemId: linked.workItemId,
      key: linked.key,
      issue: linked.issue,
    })
    .mockResolvedValueOnce(null);
  const value = arrange();
  vi.mocked(database.claimFactoryFeatureMerge).mockResolvedValue({
    ...claim,
    mergeAttempted: true,
    provider: {
      merged: true,
      mergeCommitId: "c".repeat(40),
      mergedAt: "2026-09-19T10:10:00.000Z",
    },
  });
  vi.mocked(database.claimNextFactoryFeatureMergeIssue)
    .mockResolvedValueOnce({
      mergeId: claim.id,
      workItemId: linked.workItemId,
      key: linked.key,
      issue: linked.issue,
    })
    .mockResolvedValueOnce(null);
  value.closeIssue.mockResolvedValueOnce({ state: "uncertain", failure: "rate_limited" });
  await value.processor.process({ featureId });
  expect(value.mergePullRequest).not.toHaveBeenCalled();
  const failure = vi.mocked(database.failFactoryFeatureMergeIssue).mock.calls[0];
  expect(failure?.[1]).toMatchObject({ provider: { merged: true } });
  expect(failure?.[2]).toMatchObject({ workItemId: linked.workItemId });
  expect(failure?.[3]).toBe("rate_limited");
  expect(database.finishFactoryFeatureMerge).toHaveBeenCalledOnce();
});
