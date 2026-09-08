import { z } from "zod";
import { FeatureSchema, PlanningTurnAcceptedSchema } from "./factory.js";
import { PlanningSkillDigestsSchema } from "./factory-skills.js";

export const StartPlanningFeatureCommandSchema = z.strictObject({
  requestId: z.uuid(),
  text: z.string().trim().min(1).max(16_000).regex(/\S/u),
  skillDigests: PlanningSkillDigestsSchema.default([]),
});
export type StartPlanningFeatureCommand = z.infer<typeof StartPlanningFeatureCommandSchema>;

export const PlanningFeatureStartedSchema = PlanningTurnAcceptedSchema.extend({
  feature: FeatureSchema,
});
export type PlanningFeatureStarted = z.infer<typeof PlanningFeatureStartedSchema>;
export const PlanningFeatureRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  feature: FeatureSchema.nullable(),
});

export const RenameFactoryFeatureCommandSchema = z.strictObject({
  requestId: z.uuid(),
  title: z.string().trim().min(1).max(160).regex(/\S/u),
});
export type RenameFactoryFeatureCommand = z.infer<typeof RenameFactoryFeatureCommandSchema>;

export const NamedPlanningReplySchema = z.strictObject({
  title: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(32_000),
});
