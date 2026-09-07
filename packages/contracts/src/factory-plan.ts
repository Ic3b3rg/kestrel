import { z } from "zod";

import { FeatureSchema, PlanningContextSchema, PlanningTurnSchema } from "./factory.js";
import { KestrelIdSchema } from "./v1.js";

const text = (max: number) => z.string().trim().min(1).max(max);
const key = text(48).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u);
// Codex's structured decoder accepts the hex escape; the equivalent \0 breaks its stream.
// eslint-disable-next-line no-control-regex -- NUL is deliberately forbidden in executable arguments.
const withoutNul = /^[^\x00]*$/u;
export const DEFAULT_FACTORY_LIMITS = {
  maxConcurrentProjects: 2,
  maxActiveFeaturesPerProject: 1,
  attemptTimeoutSeconds: 1800,
} as const;

export const FactoryVerificationCommandSchema = z.strictObject({
  program: text(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/u),
  args: z.array(z.string().max(2048).regex(withoutNul)).max(32),
  cwd: text(256).regex(withoutNul),
  timeoutSeconds: z.int().min(1).max(7200),
});

export const FactoryWorkItemDefinitionSchema = z.strictObject({
  key,
  importedIssueId: z.uuid().nullable().default(null),
  title: text(160),
  description: text(8000),
  requirementKeys: z.array(key).min(1).max(40),
  acceptance: z.array(text(2000)).min(1).max(20),
  dependsOn: z.array(key).max(40),
  verification: z.array(FactoryVerificationCommandSchema).min(1).max(12),
});

export const FeaturePlanDocumentSchema = z.strictObject({
  objective: text(4000),
  scope: z.strictObject({
    includes: z.array(text(2000)).min(1).max(20),
    excludes: z.array(text(2000)).max(20),
  }),
  acceptance: z
    .array(z.strictObject({ key, outcome: text(2000) }))
    .min(1)
    .max(40),
  workItems: z.array(FactoryWorkItemDefinitionSchema).min(1).max(40),
  limits: z.strictObject({
    maxConcurrentProjects: z.int().min(1).max(2),
    maxActiveFeaturesPerProject: z.literal(1),
    attemptTimeoutSeconds: z.int().min(60).max(7200),
  }),
});
export type FeaturePlanDocument = z.infer<typeof FeaturePlanDocumentSchema>;

/** Validate the small, ordered dependency graph without changing the Operator's displayed order. */
export function validateFeaturePlan(plan: FeaturePlanDocument): string[] {
  const errors: string[] = [];
  if (new TextEncoder().encode(JSON.stringify(plan)).length > 96_000)
    errors.push("Plan exceeds the detail limit; split or shorten its Work Items");
  const requirements = new Set<string>();
  for (const requirement of plan.acceptance) {
    if (requirements.has(requirement.key))
      errors.push(`Duplicate requirement key: ${requirement.key}`);
    requirements.add(requirement.key);
  }
  const positions = new Map<string, number>();
  plan.workItems.forEach((item, index) => {
    if (positions.has(item.key)) errors.push(`Duplicate Work Item key: ${item.key}`);
    positions.set(item.key, index);
  });
  const covered = new Set<string>();
  const imported = new Set<string>();
  plan.workItems.forEach((item, index) => {
    if (item.importedIssueId !== null) {
      if (imported.has(item.importedIssueId))
        errors.push(`Imported issue is assigned twice: ${item.key}`);
      imported.add(item.importedIssueId);
    }
    for (const requirement of item.requirementKeys) {
      if (!requirements.has(requirement))
        errors.push(`Unknown requirement ${requirement} in ${item.key}`);
      covered.add(requirement);
    }
    if (new Set(item.requirementKeys).size !== item.requirementKeys.length)
      errors.push(`Repeated requirement in ${item.key}`);
    if (new Set(item.dependsOn).size !== item.dependsOn.length)
      errors.push(`Repeated dependency in ${item.key}`);
    for (const dependency of item.dependsOn) {
      const position = positions.get(dependency);
      if (position === undefined) errors.push(`Unknown dependency ${dependency} in ${item.key}`);
      else if (dependency === item.key) errors.push(`${item.key} depends on itself`);
      else if (position >= index) errors.push(`${dependency} must appear before ${item.key}`);
    }
    for (const command of item.verification) {
      if (
        command.cwd.startsWith("/") ||
        /^[a-zA-Z]:/u.test(command.cwd) ||
        command.cwd.includes("\\") ||
        command.cwd.split("/").includes("..")
      )
        errors.push(`Verification for ${item.key} must use a relative Project directory`);
      if (command.timeoutSeconds > plan.limits.attemptTimeoutSeconds)
        errors.push(`Verification for ${item.key} exceeds the attempt limit`);
    }
  });
  for (const requirement of requirements) {
    if (!covered.has(requirement)) errors.push(`Requirement ${requirement} has no Work Item`);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (itemKey: string): boolean => {
    if (visiting.has(itemKey)) return true;
    if (visited.has(itemKey)) return false;
    visiting.add(itemKey);
    const position = positions.get(itemKey);
    const dependencies = position === undefined ? [] : (plan.workItems[position]?.dependsOn ?? []);
    const cycle = dependencies.some(visit);
    visiting.delete(itemKey);
    visited.add(itemKey);
    return cycle;
  };
  if (plan.workItems.some((item) => visit(item.key)))
    errors.push("Dependency cycle in the Work Items");
  return errors;
}

const version = z.int().min(1).max(200);
const versionCommand = z.strictObject({ requestId: z.uuid(), expectedVersion: version.nullable() });
export const GenerateFeaturePlanCommandSchema = versionCommand;
export const SaveFeaturePlanCommandSchema = versionCommand.extend({
  plan: FeaturePlanDocumentSchema,
});
export type SaveFeaturePlanCommand = z.infer<typeof SaveFeaturePlanCommandSchema>;
export const ApproveFeaturePlanCommandSchema = z.strictObject({ requestId: z.uuid() });
export const CancelFeatureCommandSchema = versionCommand;

export const FeaturePlanVersionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: KestrelIdSchema,
  featureId: KestrelIdSchema,
  projectId: KestrelIdSchema,
  version,
  document: FeaturePlanDocumentSchema,
  sourceContext: PlanningContextSchema.nullable(),
  planMarkdown: text(256_000),
  specMarkdown: text(256_000),
  author: z.enum(["operator", "assistant"]),
  createdAt: z.iso.datetime(),
});
export type FeaturePlanVersion = z.infer<typeof FeaturePlanVersionSchema>;

export const FeaturePlansSchema = z.strictObject({
  schemaVersion: z.literal(1),
  feature: FeatureSchema,
  current: FeaturePlanVersionSchema.nullable(),
  approval: z
    .strictObject({ version, operatorId: KestrelIdSchema, approvedAt: z.iso.datetime() })
    .nullable(),
  versions: z
    .array(
      z.strictObject({
        version,
        author: z.enum(["operator", "assistant"]),
        createdAt: z.iso.datetime(),
      }),
    )
    .max(200),
  generation: PlanningTurnSchema.nullable(),
});
export type FeaturePlans = z.infer<typeof FeaturePlansSchema>;

export const FactoryActivitySchema = z.strictObject({
  id: KestrelIdSchema,
  kind: z.enum([
    "draft_saved",
    "plan_generated",
    "plan_approved",
    "item_queued",
    "feature_cancelled",
    "issues_imported",
    "issue_published",
    "publication_failed",
    "publication_retried",
  ]),
  summary: text(2000),
  createdAt: z.iso.datetime(),
});
export const FactoryBoardColumnSchema = z.enum(["todo", "in_progress", "in_review", "completed"]);
export const FactoryWorkItemSchema = FactoryWorkItemDefinitionSchema.extend({
  id: KestrelIdSchema,
  featureId: KestrelIdSchema,
  order: z.int().min(1).max(40),
  column: FactoryBoardColumnSchema,
  blocking: z
    .strictObject({
      kind: z.enum(["dependency", "execution_unavailable", "publication", "cancelled"]),
      explanation: text(2000),
    })
    .nullable(),
  providerUrl: z.url({ protocol: /^https$/u }).nullable(),
  activity: z.array(FactoryActivitySchema).max(100),
});
export type FactoryWorkItem = z.infer<typeof FactoryWorkItemSchema>;
export const FactoryBoardSchema = z.strictObject({
  schemaVersion: z.literal(1),
  feature: FeatureSchema,
  approvedVersion: version.nullable(),
  executionReadiness: z.strictObject({
    state: z.literal("unavailable"),
    reason: z.literal("execution_not_available"),
  }),
  columns: z
    .array(
      z.strictObject({
        id: FactoryBoardColumnSchema,
        items: z.array(FactoryWorkItemSchema).max(40),
      }),
    )
    .length(4),
  activity: z.array(FactoryActivitySchema).max(100),
});
export type FactoryBoard = z.infer<typeof FactoryBoardSchema>;
