import { z } from "zod";

import { FactoryFeaturePullRequestSchema } from "./factory-feature-publication.js";
import { GitObjectIdSchema, KestrelIdSchema } from "./v1.js";

const reviewIdentity = z.strictObject({
  workflowId: KestrelIdSchema,
  artifactId: KestrelIdSchema,
  headCommitId: GitObjectIdSchema,
});

export const ApproveFactoryFeatureMergeCommandSchema = z.strictObject({
  requestId: z.uuid(),
  decision: z.literal("approve_merge"),
  expectedPlanVersion: z.int().min(1).max(200),
  review: reviewIdentity,
});
export type ApproveFactoryFeatureMergeCommand = z.infer<
  typeof ApproveFactoryFeatureMergeCommandSchema
>;

export const RetryFactoryFeatureMergeCommandSchema = z.strictObject({ requestId: z.uuid() });
export type RetryFactoryFeatureMergeCommand = z.infer<typeof RetryFactoryFeatureMergeCommandSchema>;

export const FactoryFeatureMergeFailureSchema = z.enum([
  "review_required",
  "review_outdated",
  "review_partial",
  "certificate_stale",
  "active_correction",
  "pull_request_changed",
  "pull_request_closed",
  "checks_pending",
  "checks_failed",
  "merge_conflict",
  "uncertain_write",
  "issue_closure_failed",
  "needs_authentication",
  "access_denied",
  "rate_limited",
  "invalid_response",
  "unavailable",
  "timeout",
  "retry_limit",
]);
export type FactoryFeatureMergeFailure = z.infer<typeof FactoryFeatureMergeFailureSchema>;

const issueFailure = z.enum([
  "needs_authentication",
  "access_denied",
  "rate_limited",
  "invalid_response",
  "unavailable",
  "timeout",
]);

export const FactoryFeatureMergeIssueSchema = z
  .strictObject({
    workItemId: KestrelIdSchema,
    key: z.string().min(1).max(48),
    number: z.int().positive().max(2_147_483_647),
    url: z.url().max(512),
    state: z.enum(["pending", "closing", "closed", "failed"]),
    failure: issueFailure.nullable(),
    attempts: z.int().min(0).max(20),
    closedAt: z.iso.datetime().nullable(),
  })
  .superRefine((value, context) => {
    if ((value.state === "failed") !== (value.failure !== null))
      context.addIssue({ code: "custom", message: "Issue failure must match its state" });
    if ((value.state === "closed") !== (value.closedAt !== null))
      context.addIssue({ code: "custom", message: "Only a closed issue has closedAt" });
  });
export type FactoryFeatureMergeIssue = z.infer<typeof FactoryFeatureMergeIssueSchema>;

export const FactoryFeatureMergeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: KestrelIdSchema,
    featureId: KestrelIdSchema,
    approvedVersion: z.int().min(1).max(200),
    requestedByOperatorId: KestrelIdSchema,
    sourceReview: z.strictObject({
      workflowId: KestrelIdSchema,
      artifactId: KestrelIdSchema,
      reviewRevisionId: KestrelIdSchema,
      baseCommitId: GitObjectIdSchema,
      headCommitId: GitObjectIdSchema,
    }),
    pullRequest: FactoryFeaturePullRequestSchema,
    certificateId: KestrelIdSchema,
    state: z.enum([
      "queued",
      "checking",
      "merging",
      "uncertain",
      "closing_issues",
      "blocked",
      "completed",
    ]),
    failure: FactoryFeatureMergeFailureSchema.nullable(),
    canRetry: z.boolean(),
    provider: z.strictObject({
      merged: z.boolean(),
      mergeCommitId: GitObjectIdSchema.nullable(),
      mergedAt: z.iso.datetime().nullable(),
    }),
    issues: z.array(FactoryFeatureMergeIssueSchema).min(1).max(40),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .superRefine((value, context) => {
    if (value.pullRequest.headCommitId !== value.sourceReview.headCommitId)
      context.addIssue({ code: "custom", message: "Merge must retain the reviewed head" });
    const proofComplete =
      value.provider.mergeCommitId !== null &&
      value.provider.mergedAt !== null &&
      value.pullRequest.state === "closed";
    const confirmed = value.provider.merged && proofComplete;
    if (value.provider.merged !== proofComplete)
      context.addIssue({ code: "custom", message: "Provider merge proof must be complete" });
    if (["closing_issues", "completed"].includes(value.state) && !confirmed)
      context.addIssue({ code: "custom", message: "Post-merge states need provider proof" });
    if (value.state === "completed") {
      if (
        value.completedAt === null ||
        value.failure !== null ||
        value.issues.some((issue) => issue.state !== "closed")
      )
        context.addIssue({ code: "custom", message: "Completion requires every linked issue" });
    } else if (value.completedAt !== null) {
      context.addIssue({ code: "custom", message: "Only completed merges have completedAt" });
    }
    if (value.canRetry && !["blocked", "uncertain", "closing_issues"].includes(value.state))
      context.addIssue({ code: "custom", message: "Only recoverable states can be retried" });
    if (
      (["blocked", "uncertain"].includes(value.state) && value.failure === null) ||
      (["queued", "checking", "merging", "completed"].includes(value.state) &&
        value.failure !== null)
    )
      context.addIssue({ code: "custom", message: "Merge failure must match its state" });
    if (
      value.state === "closing_issues" &&
      value.issues.some((issue) => issue.state === "failed") !==
        (value.failure === "issue_closure_failed")
    )
      context.addIssue({ code: "custom", message: "Issue closure failure must remain visible" });
  });
export type FactoryFeatureMerge = z.infer<typeof FactoryFeatureMergeSchema>;

export const FactoryFeatureMergeCurrentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  merge: FactoryFeatureMergeSchema.nullable(),
});
export type FactoryFeatureMergeCurrent = z.infer<typeof FactoryFeatureMergeCurrentSchema>;
