import { z } from "zod";

import { GitObjectIdSchema, KestrelIdSchema } from "./v1.js";

export const PlanningContextSchema = z.strictObject({
  commitId: GitObjectIdSchema.nullable(),
  documents: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(512),
        objectId: GitObjectIdSchema,
        content: z.string().max(24_000),
      }),
    )
    .max(24),
  notice: z.string().max(2048).nullable(),
});
export type PlanningContext = z.infer<typeof PlanningContextSchema>;

export const CreateFeatureCommandSchema = z.strictObject({
  requestId: z.uuid(),
  title: z.string().trim().min(1).max(160),
});
export type CreateFeatureCommand = z.infer<typeof CreateFeatureCommandSchema>;

export const FeatureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: KestrelIdSchema,
  projectId: KestrelIdSchema,
  title: z.string().min(1).max(160),
  state: z.enum(["planning", "queued", "cancelled"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Feature = z.infer<typeof FeatureSchema>;

export const FeatureListSchema = z.strictObject({
  schemaVersion: z.literal(1),
  features: z.array(FeatureSchema).max(200),
});

export const SendPlanningMessageCommandSchema = z.strictObject({
  requestId: z.uuid(),
  text: z.string().trim().min(1).max(16_000),
});
export type SendPlanningMessageCommand = z.infer<typeof SendPlanningMessageCommandSchema>;

export const PlanningMessageSchema = z.strictObject({
  id: KestrelIdSchema,
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(32_000),
  createdAt: z.iso.datetime(),
});

export const PlanningFailureSchema = z.enum([
  "unavailable",
  "authentication",
  "usage_limit",
  "permission_required",
  "input_required",
  "timeout",
  "cancelled",
  "interrupted",
  "invalid_response",
  "source_unavailable",
]);
export type PlanningFailure = z.infer<typeof PlanningFailureSchema>;

export const PlanningTurnSchema = z.strictObject({
  id: KestrelIdSchema,
  messageId: KestrelIdSchema,
  state: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  failure: PlanningFailureSchema.nullable(),
  question: z.string().max(4_000).nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});
export type PlanningTurn = z.infer<typeof PlanningTurnSchema>;

export const PlanningTurnAcceptedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  turnId: KestrelIdSchema,
  messageId: KestrelIdSchema,
});
export type PlanningTurnAccepted = z.infer<typeof PlanningTurnAcceptedSchema>;

export const RetryPlanningTurnCommandSchema = z.strictObject({ requestId: z.uuid() });

export const FeatureChatSchema = z.strictObject({
  schemaVersion: z.literal(1),
  feature: FeatureSchema,
  messages: z.array(PlanningMessageSchema).max(200),
  turns: z.array(PlanningTurnSchema).max(400),
  context: PlanningContextSchema.nullable(),
});
export type FeatureChat = z.infer<typeof FeatureChatSchema>;
