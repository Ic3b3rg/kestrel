import { z } from "zod";

export const PlanningSkillDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const PlanningSkillSourceSchema = z.strictObject({
  kind: z.literal("host"),
  label: z.string().min(1).max(160),
  candidateId: PlanningSkillDigestSchema,
});
export const PlanningSkillSummarySchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    .max(64),
  description: z.string().trim().min(1).max(2_000),
  contentDigest: PlanningSkillDigestSchema,
  source: PlanningSkillSourceSchema,
});
export type PlanningSkillSummary = z.infer<typeof PlanningSkillSummarySchema>;

export const PlanningSkillBundleSchema = PlanningSkillSummarySchema.extend({
  files: z
    .array(
      z.strictObject({
        path: z
          .string()
          .min(1)
          .max(512)
          .refine(
            (path) =>
              !path.startsWith("/") &&
              !path.includes("\\") &&
              !path.includes("\0") &&
              path.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
            "Skill files must have relative paths within the bundle",
          ),
        content: z.string().max(128 * 1024),
      }),
    )
    .min(1)
    .max(32),
}).superRefine(({ files }, context) => {
  if (!files.some(({ path }) => path === "SKILL.md"))
    context.addIssue({
      code: "custom",
      message: "The Skill entry point is missing",
      path: ["files"],
    });
  if (new Set(files.map(({ path }) => path)).size !== files.length)
    context.addIssue({
      code: "custom",
      message: "Skill file paths must be unique",
      path: ["files"],
    });
  if (
    files.reduce((sum, file) => sum + new TextEncoder().encode(file.content).byteLength, 0) >
    128 * 1024
  )
    context.addIssue({ code: "custom", message: "The Skill exceeds 128 KiB", path: ["files"] });
});
export type PlanningSkillBundle = z.infer<typeof PlanningSkillBundleSchema>;

export const PlanningSkillCandidatesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  configured: z.boolean(),
  candidates: z
    .array(
      z.strictObject({ candidateId: PlanningSkillDigestSchema, label: z.string().min(1).max(160) }),
    )
    .max(200),
});
export const PlanningSkillCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  skills: z.array(PlanningSkillSummarySchema).max(200),
});
export const InstallPlanningSkillCommandSchema = z.strictObject({
  requestId: z.uuid(),
  candidateId: PlanningSkillDigestSchema,
});
export type InstallPlanningSkillCommand = z.infer<typeof InstallPlanningSkillCommandSchema>;

export const PlanningSkillDigestsSchema = z
  .array(PlanningSkillDigestSchema)
  .max(8)
  .refine((digests) => new Set(digests).size === digests.length, "Select each Skill once");
export const SelectPlanningSkillsCommandSchema = z.strictObject({
  requestId: z.uuid(),
  expectedVersion: z.number().int().min(0).max(1_000),
  digests: PlanningSkillDigestsSchema,
});
export type SelectPlanningSkillsCommand = z.infer<typeof SelectPlanningSkillsCommandSchema>;
export const FeaturePlanningSkillsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: z.number().int().min(0).max(1_000),
  skills: z.array(PlanningSkillSummarySchema).max(8),
});
export type FeaturePlanningSkills = z.infer<typeof FeaturePlanningSkillsSchema>;
