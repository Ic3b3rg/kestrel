import { z } from "zod";

import { GitObjectIdSchema, KestrelIdSchema } from "./v1.js";

const ReviewNodeIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u);

export const FactoryReviewCorrectionCommandSchema = z.strictObject({
  requestId: z.uuid(),
  expectedPlanVersion: z.int().min(1).max(200),
  review: z.strictObject({
    workflowId: KestrelIdSchema,
    artifactId: KestrelIdSchema,
    headCommitId: GitObjectIdSchema,
  }),
  instruction: z.string().trim().min(1).max(4_000),
  findingIds: z
    .array(ReviewNodeIdSchema)
    .max(40)
    .refine((values) => new Set(values).size === values.length, "Finding IDs must be unique"),
});
export type FactoryReviewCorrectionCommand = z.infer<typeof FactoryReviewCorrectionCommandSchema>;

export const RetryFactoryReviewCorrectionCommandSchema = z.strictObject({ requestId: z.uuid() });
export type RetryFactoryReviewCorrectionCommand = z.infer<
  typeof RetryFactoryReviewCorrectionCommandSchema
>;

export const FactoryReviewCorrectionFailureSchema = z.enum([
  "authentication_required",
  "usage_limit",
  "runtime_unavailable",
  "input_required",
  "verification_failed",
  "source_changed",
  "head_changed",
  "push_rejected",
  "uncertain_write",
  "retention_unavailable",
  "review_failed",
  "unavailable",
  "timeout",
  "cancelled",
  "retry_limit",
]);
export type FactoryReviewCorrectionFailure = z.infer<typeof FactoryReviewCorrectionFailureSchema>;

export const FactoryReviewCorrectionSchema = z
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
    instruction: FactoryReviewCorrectionCommandSchema.shape.instruction,
    findings: z
      .array(
        z.strictObject({
          id: ReviewNodeIdSchema,
          title: z.string().trim().min(1).max(4_000),
          riskLevel: z.enum(["low", "medium", "high", "critical"]),
        }),
      )
      .max(40),
    state: z.enum([
      "executing",
      "gated",
      "publishing",
      "blocked",
      "uncertain",
      "reviewing",
      "completed",
      "failed",
      "cancelled",
    ]),
    failure: FactoryReviewCorrectionFailureSchema.nullable(),
    canRetry: z.boolean(),
    runId: KestrelIdSchema,
    certificateId: KestrelIdSchema.nullable(),
    replacementReview: z
      .strictObject({
        workflowId: KestrelIdSchema,
        artifactId: KestrelIdSchema.nullable(),
        headCommitId: GitObjectIdSchema,
      })
      .nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .superRefine((value, context) => {
    const afterExecution = [
      "publishing",
      "blocked",
      "uncertain",
      "reviewing",
      "completed",
      "failed",
    ].includes(value.state);
    if (afterExecution && value.certificateId === null)
      context.addIssue({ code: "custom", message: "Post-execution correction states need proof" });
    if (value.state === "completed") {
      if (
        value.failure !== null ||
        value.replacementReview?.artifactId == null ||
        value.completedAt === null
      )
        context.addIssue({
          code: "custom",
          message: "A completed correction needs its replacement review artifact",
        });
    } else if (value.completedAt !== null) {
      context.addIssue({ code: "custom", message: "Only completed corrections have completedAt" });
    }
    if (value.canRetry && !["blocked", "uncertain"].includes(value.state))
      context.addIssue({
        code: "custom",
        message: "Only a reconcilable publication state can be retried",
      });
    if (
      (["gated", "blocked", "uncertain", "failed", "cancelled"].includes(value.state) &&
        value.failure === null) ||
      (["executing", "publishing", "reviewing", "completed"].includes(value.state) &&
        value.failure !== null)
    )
      context.addIssue({ code: "custom", message: "Correction failure must match its state" });
    if (
      ["reviewing", "completed"].includes(value.state) &&
      (value.replacementReview === null ||
        value.replacementReview.headCommitId === value.sourceReview.headCommitId)
    )
      context.addIssue({
        code: "custom",
        message: "Replacement review must identify the corrected head",
      });
  });
export type FactoryReviewCorrection = z.infer<typeof FactoryReviewCorrectionSchema>;

export const FactoryReviewCorrectionCurrentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  correction: FactoryReviewCorrectionSchema.nullable(),
});
export type FactoryReviewCorrectionCurrent = z.infer<typeof FactoryReviewCorrectionCurrentSchema>;
