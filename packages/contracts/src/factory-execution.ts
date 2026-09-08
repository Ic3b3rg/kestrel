import { z } from "zod";

import { FactoryVerificationCommandSchema } from "./factory-plan.js";
import { FactoryExecutionFailureSchema, FactoryGateSchema } from "./factory-gates.js";
import { GitObjectIdSchema, KestrelIdSchema } from "./v1.js";

export { FactoryExecutionFailureSchema, type FactoryExecutionFailure } from "./factory-gates.js";

export const FactoryExecutionRevisionSchema = z.strictObject({
  baseCommitId: GitObjectIdSchema,
  headCommitId: GitObjectIdSchema,
  treeId: GitObjectIdSchema,
  branch: z.string().min(1).max(200),
});
export type FactoryExecutionRevision = z.infer<typeof FactoryExecutionRevisionSchema>;

export const FactoryExecutionRunSummarySchema = z.strictObject({
  id: KestrelIdSchema,
  workItemId: KestrelIdSchema,
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
export type FactoryExecutionRunSummary = z.infer<typeof FactoryExecutionRunSummarySchema>;

export const FactoryVerificationResultSchema = z.strictObject({
  id: KestrelIdSchema,
  round: z.int().min(1).max(3),
  position: z.int().min(1).max(12),
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

export const FactoryExecutionRunSchema = FactoryExecutionRunSummarySchema.extend({
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
  acceptedCommands: z.array(FactoryVerificationCommandSchema).min(1).max(12),
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
  verification: z.array(FactoryVerificationResultSchema).max(36),
});
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
  workItems: z
    .array(
      z.strictObject({
        id: KestrelIdSchema,
        key: z.string().min(1).max(48),
        runs: z.array(FactoryExecutionRunSummarySchema).max(20),
      }),
    )
    .max(40),
});
export type FactoryExecution = z.infer<typeof FactoryExecutionSchema>;
