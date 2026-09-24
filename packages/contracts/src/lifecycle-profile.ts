import { z } from "zod";
import { CodexSubscriptionModelSchema } from "./v1.js";
import {
  PlanningSkillSummarySchema,
  PlanningSkillBundleSchema,
  PlanningSkillDigestsSchema,
} from "./factory-skills.js";

const identifier = z.string().min(1).max(128);
export const RuntimeProfileResultSchema = z.strictObject({
  model: identifier.nullable(),
  effort: identifier.nullable(),
  serviceTier: identifier.nullable(),
});
export const LifecyclePhaseSchema = z.enum(["planning", "implementation", "review", "corrections"]);
export type LifecyclePhase = z.infer<typeof LifecyclePhaseSchema>;
const choice = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("runtime_default") }),
  z.strictObject({ kind: z.literal("explicit"), value: identifier }),
]);
const speed = z.union([choice, z.strictObject({ kind: z.literal("standard") })]);
export const LifecycleSettingsSchema = z.strictObject({
  runtimeId: identifier,
  model: choice,
  effort: choice,
  speed,
  skillDigests: PlanningSkillDigestsSchema,
});
export const LifecycleOverridesSchema = LifecycleSettingsSchema.partial();
export const PlanningComposerSettingsSchema = LifecycleSettingsSchema.pick({
  runtimeId: true,
  model: true,
  effort: true,
}).partial();
export type PlanningComposerSettings = z.infer<typeof PlanningComposerSettingsSchema>;
export type LifecycleSettings = z.infer<typeof LifecycleSettingsSchema>;
export type LifecycleOverrides = z.infer<typeof LifecycleOverridesSchema>;
export const defaultLifecycleSettings: LifecycleSettings = {
  runtimeId: "codex_subscription",
  model: { kind: "runtime_default" },
  effort: { kind: "runtime_default" },
  speed: { kind: "runtime_default" },
  skillDigests: [],
};
export const LifecycleVersionsSchema = z.strictObject({
  installation: z.number().int().nonnegative(),
  project: z.number().int().nonnegative(),
});
export const ResolvedLifecycleProfileSchema = z.strictObject({
  runtimeId: identifier,
  modelId: identifier,
  model: identifier,
  effort: identifier.nullable(),
  serviceTier: identifier.nullable(),
  requested: LifecycleSettingsSchema,
  inherited: z.array(z.enum(["runtimeId", "model", "effort", "speed", "skillDigests"])),
});
export const FrozenLifecycleProfileSchema = ResolvedLifecycleProfileSchema.extend({
  phase: LifecyclePhaseSchema,
  versions: LifecycleVersionsSchema,
  skills: z.array(PlanningSkillBundleSchema).max(20),
});
export const LifecycleProfileEvidenceSchema = FrozenLifecycleProfileSchema.extend({
  skills: z.array(PlanningSkillSummarySchema).max(20),
});
export function lifecycleProfileEvidence(value: unknown) {
  const profile = FrozenLifecycleProfileSchema.parse(value);
  return LifecycleProfileEvidenceSchema.parse({
    ...profile,
    skills: profile.skills.map((skill) => PlanningSkillSummarySchema.strip().parse(skill)),
  });
}
export type FrozenLifecycleProfile = z.infer<typeof FrozenLifecycleProfileSchema>;
export function assertLifecycleProfileAvailable(
  profile: z.infer<typeof ResolvedLifecycleProfileSchema>,
  models: z.infer<typeof CodexSubscriptionModelSchema>[],
) {
  const model = models.find((candidate) => candidate.id === profile.modelId);
  if (
    profile.runtimeId !== "codex_subscription" ||
    model === undefined ||
    (model.model ?? model.id) !== profile.model
  )
    throw new Error(
      "The frozen model is unavailable. Restore that model before retrying, or authorize new work with an available profile.",
    );
  if (
    profile.effort !== null &&
    model.defaultReasoningEffort !== profile.effort &&
    !model.supportedReasoningEfforts?.some((option) => option.reasoningEffort === profile.effort)
  )
    throw new Error(
      "The frozen effort is unavailable. Restore that capability before retrying, or authorize new work with an available profile.",
    );
  if (
    profile.serviceTier !== null &&
    (profile.serviceTier === "default"
      ? model.serviceTiers === undefined
      : !model.serviceTiers?.some((tier) => tier.id === profile.serviceTier))
  )
    throw new Error(
      "The frozen speed is unavailable. Restore that capability before retrying, or authorize new work with an available profile.",
    );
}
export const LifecycleProfileViewSchema = z.strictObject({
  phase: LifecyclePhaseSchema,
  versions: LifecycleVersionsSchema,
  defaults: LifecycleSettingsSchema,
  overrides: LifecycleOverridesSchema,
  models: z.array(CodexSubscriptionModelSchema).max(500),
  resolved: FrozenLifecycleProfileSchema.nullable(),
  blocked: z.string().max(1024).nullable(),
});
export type LifecycleProfileView = z.infer<typeof LifecycleProfileViewSchema>;
export const SaveLifecycleProfileCommandSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  settings: LifecycleOverridesSchema,
});

export function resolveLifecycleProfile(
  defaults: LifecycleSettings,
  overrides: LifecycleOverrides,
  models: z.infer<typeof CodexSubscriptionModelSchema>[],
) {
  const requested = LifecycleSettingsSchema.parse({ ...defaults, ...overrides });
  if (requested.runtimeId !== "codex_subscription")
    throw new Error(
      "The selected runtime is unavailable. Choose a connected runtime in Lifecycle settings.",
    );
  const model =
    requested.model.kind === "runtime_default"
      ? models.find((model) => model.isDefault)
      : models.find(
          (model) =>
            model.id === (requested.model.kind === "explicit" ? requested.model.value : ""),
        );
  if (model === undefined)
    throw new Error(
      "The selected model is unavailable. Choose an available model in Lifecycle settings.",
    );
  const effort =
    requested.effort.kind === "runtime_default"
      ? (model.defaultReasoningEffort ?? null)
      : requested.effort.value;
  if (
    requested.effort.kind === "explicit" &&
    effort !== null &&
    !model.supportedReasoningEfforts?.some((option) => option.reasoningEffort === effort)
  )
    throw new Error(
      "The selected effort is unavailable. Choose a supported effort in Lifecycle settings.",
    );
  const serviceTier =
    requested.speed.kind === "standard"
      ? "default"
      : requested.speed.kind === "explicit"
        ? requested.speed.value
        : model.defaultServiceTier === undefined
          ? null
          : (model.defaultServiceTier ?? "default");
  if (
    requested.speed.kind === "explicit" &&
    !model.serviceTiers?.some((tier) => tier.id === serviceTier)
  )
    throw new Error(
      "The selected speed is unavailable. Choose a supported speed in Lifecycle settings.",
    );
  if (requested.speed.kind === "standard" && model.serviceTiers === undefined)
    throw new Error(
      "This runtime cannot select standard speed explicitly. Update the runtime or choose Runtime default.",
    );
  return ResolvedLifecycleProfileSchema.parse({
    runtimeId: requested.runtimeId,
    modelId: model.id,
    model: model.model ?? model.id,
    effort,
    serviceTier,
    requested,
    inherited: Object.keys(defaults).filter((field) => !(field in overrides)),
  });
}
