import { expect, it } from "vitest";

import {
  FactoryReviewCorrectionCommandSchema,
  FactoryReviewCorrectionSchema,
  RetryFactoryReviewCorrectionCommandSchema,
} from "./factory-review-corrections.js";

const id = "01991c36-7f90-7000-8000-000000000001";
const secondId = "01991c36-7f90-7000-8000-000000000002";
const thirdId = "01991c36-7f90-7000-8000-000000000003";
const at = "2026-09-19T20:00:00.000Z";

it("binds correction authority to one current review and explicit selected Findings", () => {
  const command = {
    requestId: id,
    expectedPlanVersion: 2,
    review: { workflowId: secondId, artifactId: thirdId, headCommitId: "a".repeat(40) },
    instruction: "Keep the empty-state action visible after refresh.",
    findingIds: ["finding.empty-state"],
  };

  expect(FactoryReviewCorrectionCommandSchema.parse(command)).toEqual(command);
  expect(
    FactoryReviewCorrectionCommandSchema.safeParse({ ...command, findingIds: ["step.behavior"] })
      .success,
  ).toBe(true);
  expect(
    FactoryReviewCorrectionCommandSchema.safeParse({
      ...command,
      findingIds: ["finding.empty-state", "finding.empty-state"],
    }).success,
  ).toBe(false);
  expect(
    FactoryReviewCorrectionCommandSchema.safeParse({ ...command, instruction: "   " }).success,
  ).toBe(false);
});

const executing = {
  schemaVersion: 1,
  id,
  featureId: secondId,
  approvedVersion: 2,
  requestedByOperatorId: thirdId,
  sourceReview: {
    workflowId: secondId,
    artifactId: thirdId,
    reviewRevisionId: id,
    baseCommitId: "b".repeat(40),
    headCommitId: "a".repeat(40),
  },
  instruction: "Keep the empty-state action visible after refresh.",
  findings: [{ id: "finding.empty-state", title: "Action disappears", riskLevel: "medium" }],
  state: "executing",
  failure: null,
  canRetry: false,
  runId: thirdId,
  certificateId: null,
  replacementReview: null,
  createdAt: at,
  updatedAt: at,
  completedAt: null,
};

it("does not report a completed correction without a replacement exact-revision review", () => {
  expect(FactoryReviewCorrectionSchema.parse(executing)).toEqual(executing);
  expect(
    FactoryReviewCorrectionSchema.safeParse({ ...executing, state: "completed" }).success,
  ).toBe(false);
  expect(
    FactoryReviewCorrectionSchema.safeParse({
      ...executing,
      state: "completed",
      runId: thirdId,
      certificateId: id,
      replacementReview: {
        workflowId: id,
        artifactId: secondId,
        headCommitId: "c".repeat(40),
      },
      completedAt: at,
    }).success,
  ).toBe(true);
});

it("allows retry only for a visible reconcilable publication failure", () => {
  expect(
    FactoryReviewCorrectionSchema.safeParse({
      ...executing,
      state: "uncertain",
      failure: "uncertain_write",
      canRetry: true,
      certificateId: id,
    }).success,
  ).toBe(true);
  expect(FactoryReviewCorrectionSchema.safeParse({ ...executing, canRetry: true }).success).toBe(
    false,
  );
  expect(RetryFactoryReviewCorrectionCommandSchema.parse({ requestId: id })).toEqual({
    requestId: id,
  });
});

it("settles a correction when its Feature is cancelled before verification", () => {
  expect(
    FactoryReviewCorrectionSchema.safeParse({
      ...executing,
      state: "cancelled",
      failure: "cancelled",
    }).success,
  ).toBe(true);
});
