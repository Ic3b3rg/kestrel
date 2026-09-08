import { z } from "zod";

import { FactoryVerificationCommandSchema } from "./factory-plan.js";
import { FactoryExecutionFailureSchema, FactoryGateSchema } from "./factory-gates.js";
import { GitObjectIdSchema, KestrelIdSchema } from "./v1.js";
import {
  FactoryExecutionRevisionSchema,
  FactoryVerificationManifestSchema,
  FactoryFeatureVerificationSchema,
} from "./factory-verification.js";
export {
  FactoryExecutionRevisionSchema,
  type FactoryExecutionRevision,
} from "./factory-verification.js";

export { FactoryExecutionFailureSchema, type FactoryExecutionFailure } from "./factory-gates.js";

const runSummary = z.strictObject({
  id: KestrelIdSchema,
  attempt: z.int().min(1).max(20),
  state: z.enum([
    "queued",
    "running",
    "verifying",
    "stopping",
    "verified",
    "blocked",
    "cancelled",
    "interrupted",
  ]),
  failure: FactoryExecutionFailureSchema.nullable(),
  writerStopped: z.boolean(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});
const workItemSummary = runSummary.extend({
  purpose: z.literal("work_item").optional(),
  workItemId: KestrelIdSchema,
});
const featureSummary = runSummary.extend({
  purpose: z.literal("feature_verification"),
  workItemId: z.null(),
});
export const FactoryExecutionRunSummarySchema = z.union([workItemSummary, featureSummary]);
export type FactoryExecutionRunSummary = z.infer<typeof FactoryExecutionRunSummarySchema>;

export const FactoryVerificationResultSchema = z.strictObject({
  id: KestrelIdSchema,
  round: z.int().min(1).max(3),
  position: z.int().min(1).max(480),
  command: FactoryVerificationCommandSchema,
  headCommitId: GitObjectIdSchema,
  treeId: GitObjectIdSchema,
  outcome: z.enum(["passed", "failed", "timeout", "cancelled", "unavailable"]),
  exitCode: z.int().nullable(),
  stdout: z.string().max(8192),
  stderr: z.string().max(8192),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  durationMs: z.int().min(0),
  createdAt: z.iso.datetime(),
});
export type FactoryVerificationResult = z.infer<typeof FactoryVerificationResultSchema>;

const runDetails = {
  schemaVersion: z.literal(1),
  featureId: KestrelIdSchema,
  approvedVersion: z.int().min(1).max(200),
  question: z.string().min(1).max(4000).nullable(),
  gate: FactoryGateSchema.nullable().optional(),
  revision: FactoryExecutionRevisionSchema.nullable(),
  runtime: z
    .strictObject({
      kind: z.literal("codex"),
      model: z.string().min(1).max(200),
      threadId: z.string().max(256).nullable(),
      turnId: z.string().max(256).nullable(),
      containerId: z.string().max(128).nullable(),
    })
    .nullable(),
  activity: z
    .array(
      z.strictObject({
        id: KestrelIdSchema,
        kind: z.enum([
          "runtime",
          "command",
          "file_change",
          "question",
          "verification",
          "lifecycle",
        ]),
        summary: z.string().min(1).max(2000),
        createdAt: z.iso.datetime(),
      }),
    )
    .max(100),
};
export const FactoryExecutionRunSchema = z.union([
  workItemSummary.extend({
    ...runDetails,
    acceptedCommands: z.array(FactoryVerificationCommandSchema).min(1).max(12),
    verification: z
      .array(FactoryVerificationResultSchema.extend({ position: z.int().min(1).max(12) }))
      .max(36),
  }),
  featureSummary.extend({
    ...runDetails,
    acceptedCommands: z.array(FactoryVerificationCommandSchema).min(1).max(480),
    verificationManifest: FactoryVerificationManifestSchema,
    initialRevision: FactoryExecutionRevisionSchema,
    verification: z.array(FactoryVerificationResultSchema).max(1440),
  }),
]);
export type FactoryExecutionRun = z.infer<typeof FactoryExecutionRunSchema>;

export const FactoryExecutionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  featureId: KestrelIdSchema,
  state: z.enum([
    "not_approved",
    "pending",
    "running",
    "stopping",
    "blocked",
    "verified",
    "cancelled",
  ]),
  failure: FactoryExecutionFailureSchema.nullable(),
  question: z.string().min(1).max(4000).nullable(),
  gate: FactoryGateSchema.nullable().optional(),
  revision: FactoryExecutionRevisionSchema.nullable(),
  finalVerification: z
    .strictObject({
      runs: z.array(featureSummary).max(20),
      certificate: FactoryFeatureVerificationSchema.nullable(),
      progress: z
        .strictObject({
          round: z.int().min(1).max(3),
          checked: z.int().min(0).max(480),
          passed: z.int().min(0).max(480),
          total: z.int().min(1).max(480),
        })
        .nullable(),
    })
    .optional(),
  workItems: z
    .array(
      z.strictObject({
        id: KestrelIdSchema,
        key: z.string().min(1).max(48),
        runs: z.array(workItemSummary).max(20),
      }),
    )
    .max(40),
});
export type FactoryExecution = z.infer<typeof FactoryExecutionSchema>;
