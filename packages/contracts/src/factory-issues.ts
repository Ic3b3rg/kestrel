import { z } from "zod";

import { FeatureSchema } from "./factory.js";
import { KestrelIdSchema } from "./v1.js";

const providerId = z
  .string()
  .regex(/^[1-9][0-9]*$/u)
  .max(32);
const issueNumber = z.int().positive().max(2_147_483_647);
const issueUrl = z
  .url()
  .regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/[1-9][0-9]*$/u)
  .max(512);

export const FactoryGitHubRepositorySchema = z.strictObject({
  id: providerId,
  owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/u),
  name: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/u),
});
export type FactoryGitHubRepository = z.infer<typeof FactoryGitHubRepositorySchema>;

const dependency = z.strictObject({
  id: providerId,
  number: issueNumber,
  url: issueUrl,
  title: z.string().min(1).max(512),
});
export const FactoryGitHubIssueSchema = z.strictObject({
  repository: FactoryGitHubRepositorySchema,
  id: providerId,
  number: issueNumber,
  url: issueUrl,
  title: z.string().min(1).max(512),
  body: z.string().max(65_536),
  state: z.enum(["open", "closed"]),
  // Null means dependency metadata was not available; the original body is still retained.
  dependencies: z.array(dependency).max(100).nullable(),
});
export type FactoryGitHubIssue = z.infer<typeof FactoryGitHubIssueSchema>;

export const FactoryProviderFailureSchema = z.enum([
  "unavailable",
  "needs_authentication",
  "access_denied",
  "rate_limited",
  "invalid_response",
  "timeout",
  "cancelled",
  "project_not_supported",
  "repository_changed",
  "uncertain_write",
  "issue_already_bound",
  "reconciliation_limit",
]);
export type FactoryProviderFailure = z.infer<typeof FactoryProviderFailureSchema>;

export const FactoryGitHubIssuesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: KestrelIdSchema,
  repository: FactoryGitHubRepositorySchema.nullable(),
  state: z.enum(["available", "unavailable"]),
  failure: FactoryProviderFailureSchema.nullable(),
  issues: z.array(FactoryGitHubIssueSchema).max(20),
  page: z.int().min(1).max(5),
  nextPage: z.int().min(1).max(5).nullable(),
  limited: z.boolean(),
});
export type FactoryGitHubIssues = z.infer<typeof FactoryGitHubIssuesSchema>;

export const ImportedFactoryIssueSchema = z.strictObject({
  id: KestrelIdSchema,
  featureId: KestrelIdSchema,
  issue: FactoryGitHubIssueSchema,
  importedAt: z.iso.datetime(),
});
export type ImportedFactoryIssue = z.infer<typeof ImportedFactoryIssueSchema>;
export const FactoryIssueImportsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  feature: FeatureSchema,
  canImport: z.boolean(),
  issues: z.array(ImportedFactoryIssueSchema).max(20),
});
export type FactoryIssueImports = z.infer<typeof FactoryIssueImportsSchema>;
export const ImportFactoryIssuesCommandSchema = z.strictObject({
  requestId: z.uuid(),
  issueNumbers: z.array(issueNumber).min(1).max(20),
});
export type ImportFactoryIssuesCommand = z.infer<typeof ImportFactoryIssuesCommandSchema>;

export const FactoryIssuePublicationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  featureId: KestrelIdSchema,
  state: z.enum(["not_approved", "pending", "publishing", "blocked", "published", "cancelled"]),
  failure: FactoryProviderFailureSchema.nullable(),
  items: z
    .array(
      z.strictObject({
        workItemId: KestrelIdSchema,
        key: z.string().min(1).max(48),
        state: z.enum(["pending", "publishing", "reconciling", "published", "blocked"]),
        issue: z.strictObject({ number: issueNumber, url: issueUrl }).nullable(),
        failure: FactoryProviderFailureSchema.nullable(),
        dependencyMode: z.enum(["native", "textual"]).nullable(),
      }),
    )
    .max(40),
  updatedAt: z.iso.datetime().nullable(),
});
export type FactoryIssuePublication = z.infer<typeof FactoryIssuePublicationSchema>;
export const RetryFactoryPublicationCommandSchema = z.strictObject({ requestId: z.uuid() });
