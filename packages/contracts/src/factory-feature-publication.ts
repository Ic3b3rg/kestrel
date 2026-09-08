import { z } from "zod";
import { FactoryGitHubRepositorySchema, FactoryGitHubIssueSchema } from "./factory-issues.js";
import {
  FactoryFeatureVerificationSchema,
  FactoryExecutionRevisionSchema,
} from "./factory-verification.js";
import {
  GitObjectIdSchema,
  KestrelIdSchema,
  RepositorySnapshotSchema,
  ReviewRevisionSchema,
} from "./v1.js";

const branch = z
  .string()
  .min(1)
  .max(244)
  .refine(
    (value) =>
      !value.startsWith("refs/") &&
      !value.startsWith("-") &&
      !/[\s~^:?*[\\]/u.test(value) &&
      !/\p{Cc}/u.test(value) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.endsWith(".") &&
      value
        .split("/")
        .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock")),
  );
const payload = z.strictObject({
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(65_536),
  marker: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => !/[\r\n]/u.test(value)),
  baseRef: branch,
  headRef: branch,
  baseCommitId: GitObjectIdSchema,
  headCommitId: GitObjectIdSchema,
});
const validPayload = (value: z.infer<typeof payload>) =>
  value.baseRef !== value.headRef &&
  value.body.split(/\r?\n/u).some((line) => line === value.marker);
export const FactoryFeaturePullRequestPayloadSchema = payload.refine(validPayload);
export type FactoryFeaturePullRequestPayload = z.infer<
  typeof FactoryFeaturePullRequestPayloadSchema
>;
export const FactoryFeaturePullRequestSchema = payload
  .extend({
    repository: FactoryGitHubRepositorySchema,
    id: z
      .string()
      .regex(/^[1-9][0-9]*$/u)
      .max(32),
    nodeId: RepositorySnapshotSchema.shape.providerId,
    repositoryNodeId: RepositorySnapshotSchema.shape.providerId,
    authorNodeId: RepositorySnapshotSchema.shape.providerId,
    number: z.int().positive().max(2_147_483_647),
    url: z.url().max(512),
    state: z.enum(["open", "closed"]),
    author: z.string().min(1).max(100),
  })
  .refine(validPayload)
  .refine(
    (value) =>
      value.url.toLowerCase() ===
      `https://github.com/${value.repository.owner}/${value.repository.name}/pull/${String(value.number)}`.toLowerCase(),
  );
export type FactoryFeaturePullRequest = z.infer<typeof FactoryFeaturePullRequestSchema>;

export const FactoryFeaturePublicationIssueSchema = z.strictObject({
  workItemId: KestrelIdSchema,
  key: z.string().min(1).max(48),
  title: z.string().min(1).max(160),
  issue: FactoryGitHubIssueSchema.pick({ repository: true, id: true, number: true, url: true }),
});
export type FactoryFeaturePublicationIssue = z.infer<typeof FactoryFeaturePublicationIssueSchema>;
export const FactoryFeaturePublicationIdentitySchema = z.strictObject({
  repository: FactoryGitHubRepositorySchema,
  account: z.string().min(1).max(100),
});

/** Server-side frozen operation inputs. Configured remote strings are never part of the public view. */
export const FactoryFeaturePublicationTargetSchema = z.strictObject({
  certificateId: KestrelIdSchema,
  approvedVersion: z.int().min(1).max(200),
  approvalId: KestrelIdSchema,
  source: FactoryFeatureVerificationSchema.shape.source,
  revision: FactoryExecutionRevisionSchema,
  identity: FactoryFeaturePublicationIdentitySchema,
  remote: z.strictObject({
    repository: FactoryGitHubRepositorySchema.pick({ owner: true, name: true }),
    remoteName: z.literal("origin"),
    configuredUrl: z.string().min(1).max(4096),
    configuredPushUrl: z.string().min(1).max(4096).nullable(),
    canonicalUrl: z.string().min(1).max(512),
    targetRef: z.string().startsWith("refs/heads/").max(255),
  }),
});
export type FactoryFeaturePublicationTarget = z.infer<typeof FactoryFeaturePublicationTargetSchema>;
export const FactoryFeaturePublicationOperationSchema = z
  .strictObject({
    id: KestrelIdSchema,
    featureId: KestrelIdSchema,
    target: FactoryFeaturePublicationTargetSchema,
    issues: z.array(FactoryFeaturePublicationIssueSchema).min(1).max(40),
    payload: FactoryFeaturePullRequestPayloadSchema,
  })
  .refine(
    ({ target, payload, featureId }) =>
      payload.baseCommitId === target.revision.baseCommitId &&
      payload.headCommitId === target.revision.headCommitId &&
      `refs/heads/${payload.headRef}` === target.revision.branch &&
      payload.headRef === `kestrel/feature/${featureId}` &&
      `refs/heads/${payload.baseRef}` === target.remote.targetRef &&
      target.identity.repository.owner.toLowerCase() ===
        target.remote.repository.owner.toLowerCase() &&
      target.identity.repository.name.toLowerCase() === target.remote.repository.name.toLowerCase(),
  );
export type FactoryFeaturePublicationOperation = z.infer<
  typeof FactoryFeaturePublicationOperationSchema
>;

export const FactoryFeaturePublicationFailureSchema = z.enum([
  "verification_required",
  "certificate_stale",
  "issue_identity_missing",
  "source_changed",
  "remote_changed",
  "target_changed",
  "target_unavailable",
  "feature_ref_conflict",
  "workspace_changed",
  "unavailable",
  "cancelled",
  "timeout",
  "push_rejected",
  "needs_authentication",
  "access_denied",
  "rate_limited",
  "invalid_response",
  "project_not_supported",
  "repository_changed",
  "uncertain_write",
  "reconciliation_limit",
  "retention_unavailable",
  "retry_limit",
]);
export type FactoryFeaturePublicationFailure = z.infer<
  typeof FactoryFeaturePublicationFailureSchema
>;
export const FactoryFeaturePublicationReviewSchema = z.strictObject({
  projectId: KestrelIdSchema,
  changeProposalId: KestrelIdSchema,
  revision: ReviewRevisionSchema,
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type FactoryFeaturePublicationReview = z.infer<typeof FactoryFeaturePublicationReviewSchema>;
export const FactoryFeaturePublicationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    featureId: KestrelIdSchema,
    approvedVersion: z.int().min(1).max(200).nullable(),
    state: z.enum(["pending", "publishing", "blocked", "uncertain", "published", "cancelled"]),
    cancelled: z.boolean(),
    failure: FactoryFeaturePublicationFailureSchema.nullable(),
    canRetry: z.boolean(),
    updatedAt: z.iso.datetime().nullable(),
    certificate: FactoryFeatureVerificationSchema.nullable(),
    issues: z.array(FactoryFeaturePublicationIssueSchema).max(40),
    pullRequest: FactoryFeaturePullRequestSchema.nullable(),
    review: FactoryFeaturePublicationReviewSchema.nullable(),
  })
  .superRefine((value, context) => {
    const certificate = value.certificate;
    if (
      (value.state === "published" &&
        (certificate === null ||
          value.pullRequest === null ||
          value.review?.revision.state !== "available" ||
          value.cancelled)) ||
      (certificate !== null &&
        (certificate.featureId !== value.featureId ||
          certificate.approvedVersion !== value.approvedVersion)) ||
      (value.pullRequest !== null &&
        (certificate === null ||
          value.pullRequest.baseCommitId !== certificate.revision.baseCommitId ||
          value.pullRequest.headCommitId !== certificate.revision.headCommitId)) ||
      (value.review !== null &&
        (value.review.revision.state !== "available" ||
          certificate === null ||
          value.review.revision.base.objectId !== certificate.revision.baseCommitId ||
          value.review.revision.head.objectId !== certificate.revision.headCommitId))
    )
      context.addIssue({
        code: "custom",
        message: "Publication must retain its exact certified revision",
      });
  });
export type FactoryFeaturePublication = z.infer<typeof FactoryFeaturePublicationSchema>;
export const RetryFactoryFeaturePublicationCommandSchema = z.strictObject({ requestId: z.uuid() });
export type RetryFactoryFeaturePublicationCommand = z.infer<
  typeof RetryFactoryFeaturePublicationCommandSchema
>;
