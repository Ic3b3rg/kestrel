import { expect, it } from "vitest";

import {
  ApproveFactoryFeatureMergeCommandSchema,
  FactoryFeatureMergeSchema,
  RetryFactoryFeatureMergeCommandSchema,
} from "./factory-feature-merge.js";

const featureId = "01991c36-7f90-7000-8000-000000000001";
const operationId = "01991c36-7f90-7000-8000-000000000002";
const operatorId = "01991c36-7f90-7000-8000-000000000003";
const workflowId = "01991c36-7f90-7000-8000-000000000004";
const artifactId = "01991c36-7f90-7000-8000-000000000005";
const revisionId = "01991c36-7f90-7000-8000-000000000006";
const certificateId = "01991c36-7f90-7000-8000-000000000007";
const workItemId = "01991c36-7f90-7000-8000-000000000008";
const now = "2026-09-19T10:00:00.000Z";
const head = "b".repeat(40);

const command = {
  requestId: "c9a433e0-ad98-4d05-ad90-7b0d75ddf84b",
  decision: "approve_merge",
  expectedPlanVersion: 1,
  review: { workflowId, artifactId, headCommitId: head },
} as const;

const merge = {
  schemaVersion: 1,
  id: operationId,
  featureId,
  approvedVersion: 1,
  requestedByOperatorId: operatorId,
  sourceReview: {
    workflowId,
    artifactId,
    reviewRevisionId: revisionId,
    baseCommitId: "a".repeat(40),
    headCommitId: head,
  },
  pullRequest: {
    repository: { id: "1", owner: "example", name: "reports" },
    id: "2",
    nodeId: "PR_example",
    repositoryNodeId: "R_example",
    authorNodeId: "U_example",
    number: 3,
    url: "https://github.com/example/reports/pull/3",
    state: "open",
    author: "operator",
    title: "Export reports",
    body: "Approved report export\n\n<!-- kestrel:feature-pr:operation -->",
    marker: "<!-- kestrel:feature-pr:operation -->",
    baseRef: "master",
    headRef: `kestrel/feature/${featureId}`,
    baseCommitId: "a".repeat(40),
    headCommitId: head,
  },
  certificateId,
  state: "queued",
  failure: null,
  canRetry: false,
  provider: { merged: false, mergeCommitId: null, mergedAt: null },
  issues: [
    {
      workItemId,
      key: "WORK-001",
      number: 12,
      url: "https://github.com/example/reports/issues/12",
      state: "pending",
      failure: null,
      attempts: 0,
      closedAt: null,
    },
  ],
  createdAt: now,
  updatedAt: now,
  completedAt: null,
} as const;

it("makes an Operator approve one exact current review head explicitly", () => {
  expect(ApproveFactoryFeatureMergeCommandSchema.parse(command)).toEqual(command);
  expect(
    ApproveFactoryFeatureMergeCommandSchema.safeParse({ ...command, decision: "merge_later" })
      .success,
  ).toBe(false);
});

it("does not report completion until the provider merge is confirmed", () => {
  expect(FactoryFeatureMergeSchema.parse(merge)).toEqual(merge);
  expect(
    FactoryFeatureMergeSchema.safeParse({ ...merge, state: "completed", completedAt: now }).success,
  ).toBe(false);
  expect(
    FactoryFeatureMergeSchema.safeParse({
      ...merge,
      pullRequest: { ...merge.pullRequest, state: "closed" },
      provider: { merged: false, mergeCommitId: "c".repeat(40), mergedAt: now },
    }).success,
  ).toBe(false);
});

it("retains per-issue closure failures after a confirmed merge", () => {
  const partial = {
    ...merge,
    state: "closing_issues",
    failure: "issue_closure_failed",
    provider: { merged: true, mergeCommitId: "c".repeat(40), mergedAt: now },
    pullRequest: { ...merge.pullRequest, state: "closed" },
    issues: [
      {
        ...merge.issues[0],
        state: "failed",
        failure: "rate_limited",
        attempts: 1,
      },
    ],
  } as const;
  expect(FactoryFeatureMergeSchema.parse(partial)).toEqual(partial);
  expect(
    FactoryFeatureMergeSchema.parse({
      ...partial,
      state: "blocked",
      failure: "retry_limit",
      canRetry: false,
    }),
  ).toMatchObject({ state: "blocked", failure: "retry_limit", provider: { merged: true } });
});

it("accepts only an idempotent browser retry identity", () => {
  const retry = { requestId: "9c99b00c-5dca-44bd-9507-d9ccb3ab2df7" };
  expect(RetryFactoryFeatureMergeCommandSchema.parse(retry)).toEqual(retry);
  expect(
    RetryFactoryFeatureMergeCommandSchema.safeParse({ ...retry, headCommitId: head }).success,
  ).toBe(false);
});
