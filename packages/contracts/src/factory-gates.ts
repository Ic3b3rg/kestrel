import { z } from "zod";

import { KestrelIdSchema } from "./v1.js";

export const FactoryExecutionFailureSchema = z.enum([
  "unavailable",
  "authentication",
  "usage_limit",
  "sandbox_unavailable",
  "source_unavailable",
  "source_changed",
  "permission_required",
  "input_required",
  "timeout",
  "cancelled",
  "interrupted",
  "invalid_response",
  "verification_failed",
  "revision_changed",
  "stop_unconfirmed",
]);
export type FactoryExecutionFailure = z.infer<typeof FactoryExecutionFailureSchema>;

const gateDecision = z.enum(["resume_within_plan", "requires_plan_change"]);
const gateAnswer = z.string().trim().min(1).max(4000).regex(/\S/u);

export const ResolveFactoryGateCommandSchema = z.strictObject({
  requestId: KestrelIdSchema,
  expectedPlanVersion: z.int().min(1).max(200),
  decision: gateDecision,
  answer: gateAnswer,
});
export type ResolveFactoryGateCommand = z.infer<typeof ResolveFactoryGateCommandSchema>;

export const FactoryGateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: KestrelIdSchema,
  featureId: KestrelIdSchema,
  workItemId: KestrelIdSchema,
  runId: KestrelIdSchema,
  approvedVersion: z.int().min(1).max(200),
  reason: FactoryExecutionFailureSchema,
  question: z.string().min(1).max(4000),
  requiredDecision: z.enum([
    "clarify_within_plan",
    "retry_within_plan",
    "inspect_workspace",
    "inspect_environment",
  ]),
  createdAt: z.iso.datetime(),
  resolution: z
    .strictObject({
      requestId: KestrelIdSchema,
      operatorId: KestrelIdSchema,
      decision: gateDecision,
      answer: gateAnswer,
      resolvedAt: z.iso.datetime(),
    })
    .nullable(),
  successorRunId: KestrelIdSchema.nullable(),
  canResume: z.boolean(),
  resumeBlockedReason: z
    .enum([
      "unconfirmed_stop",
      "workspace_uncertain",
      "cancelled",
      "stale_gate",
      "attempt_limit",
      "plan_change_required",
      "already_resolved",
    ])
    .nullable(),
});
export type FactoryGate = z.infer<typeof FactoryGateSchema>;
