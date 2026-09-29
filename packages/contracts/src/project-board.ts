import { z } from "zod";
import { FeatureSchema } from "./factory.js";
import { FactoryWorkItemSchema } from "./factory-plan.js";
import { FactoryGitHubIssueSchema, FactoryProviderFailureSchema } from "./factory-issues.js";
import { KestrelIdSchema } from "./v1.js";

export const ProjectBoardWorkItemSchema = z.strictObject({
  feature: FeatureSchema.pick({ id: true, projectId: true, title: true }),
  queued: z.boolean().optional(),
  item: FactoryWorkItemSchema.pick({
    id: true,
    featureId: true,
    key: true,
    order: true,
    title: true,
    dependsOn: true,
    column: true,
    blocking: true,
    providerUrl: true,
    executionFeatureId: true,
    approvedVersion: true,
  }),
});
export const ProjectBoardSettingsSchema = z.strictObject({
  readyLabel: z.string().trim().min(1).max(100),
});
export const ProjectIssueStartSchema = z.strictObject({
  id: KestrelIdSchema,
  issueNumber: z.int().positive(),
  issueUrl: z.url(),
  title: z.string(),
  state: z.enum(["queued", "preparing", "running", "blocked", "done"]),
  featureId: KestrelIdSchema.nullable(),
  message: z.string().nullable(),
});
export type ProjectIssueStart = z.infer<typeof ProjectIssueStartSchema>;
export const StartProjectIssueCommandSchema = z.strictObject({
  requestId: z.uuid(),
  issueNumber: z.int().positive(),
});
export const ProjectIssueDiscussionSchema = z.strictObject({
  issue: FactoryGitHubIssueSchema,
  comments: z
    .array(
      z.strictObject({
        id: z.string(),
        body: z.string().max(65_536),
        url: z.url(),
        author: z.string().nullable(),
      }),
    )
    .max(100),
  nextPage: z.int().positive().nullable(),
  fetchedAt: z.iso.datetime(),
  checkedAt: z.iso.datetime().optional(),
  refreshing: z.boolean().optional(),
  failure: FactoryProviderFailureSchema.nullable(),
});
export type ProjectIssueDiscussion = z.infer<typeof ProjectIssueDiscussionSchema>;
export type ProjectBoardWorkItem = z.infer<typeof ProjectBoardWorkItemSchema>;
export const ProjectBoardSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: KestrelIdSchema,
  readAt: z.iso.datetime(),
  planningFeatures: z.array(FeatureSchema).max(200),
  workItems: z.array(ProjectBoardWorkItemSchema).max(8_000),
  settings: ProjectBoardSettingsSchema.optional(),
  starts: z.array(ProjectIssueStartSchema).optional(),
  github: z.strictObject({
    issues: z.array(FactoryGitHubIssueSchema.omit({ body: true, dependencies: true })).max(100),
    checkedAt: z.iso.datetime(),
    fetchedAt: z.iso.datetime().nullable(),
    failure: FactoryProviderFailureSchema.nullable(),
    limited: z.boolean(),
    retained: z.boolean(),
    refreshing: z.boolean().optional(),
    retryAt: z.iso.datetime().nullable().optional(),
  }),
});
export type ProjectBoardSnapshot = z.infer<typeof ProjectBoardSnapshotSchema>;
