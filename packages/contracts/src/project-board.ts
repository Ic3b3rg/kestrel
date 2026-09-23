import { z } from "zod";
import { FeatureSchema } from "./factory.js";
import { FactoryWorkItemSchema } from "./factory-plan.js";
import { FactoryGitHubIssueSchema, FactoryProviderFailureSchema } from "./factory-issues.js";
import { KestrelIdSchema } from "./v1.js";

export const ProjectBoardWorkItemSchema = z.strictObject({
  feature: FeatureSchema.pick({ id: true, projectId: true, title: true }),
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
  }),
});
export type ProjectBoardWorkItem = z.infer<typeof ProjectBoardWorkItemSchema>;
export const ProjectBoardSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: KestrelIdSchema,
  readAt: z.iso.datetime(),
  planningFeatures: z.array(FeatureSchema).max(200),
  workItems: z.array(ProjectBoardWorkItemSchema).max(8_000),
  github: z.strictObject({
    issues: z.array(FactoryGitHubIssueSchema.omit({ body: true, dependencies: true })).max(100),
    checkedAt: z.iso.datetime(),
    fetchedAt: z.iso.datetime().nullable(),
    failure: FactoryProviderFailureSchema.nullable(),
    limited: z.boolean(),
    retained: z.boolean(),
  }),
});
export type ProjectBoardSnapshot = z.infer<typeof ProjectBoardSnapshotSchema>;
