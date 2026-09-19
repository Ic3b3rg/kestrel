import { z } from "zod";

import { FactoryVerificationResultSchema } from "./factory-execution.js";
import {
  FactoryFeaturePullRequestSchema,
  FactoryFeaturePublicationReviewSchema,
} from "./factory-feature-publication.js";
import { FeaturePlanDocumentSchema } from "./factory-plan.js";
import { FactoryFeatureVerificationSchema } from "./factory-verification.js";
import { GitObjectIdSchema, KestrelIdSchema } from "./v1.js";

const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const SafeRetainedPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !/[\p{Cc}\\]/u.test(value) &&
      !/^[a-z][a-z0-9+.-]*:/iu.test(value) &&
      !value.split("/").some((part) => part === "" || part === "." || part === ".."),
    "Retained source paths must be safe relative paths",
  );

export const ConceptualReviewIntentKindSchema = z.enum([
  "approved_feature_plan",
  "operator_confirmed",
  "pull_request_stated",
  "inferred",
  "missing",
]);
export type ConceptualReviewIntentKind = z.infer<typeof ConceptualReviewIntentKindSchema>;

export const FactoryConceptualReviewBasisSchema = z.strictObject({
  objective: FeaturePlanDocumentSchema.shape.objective,
  scope: FeaturePlanDocumentSchema.shape.scope,
  outcomes: z
    .array(
      FeaturePlanDocumentSchema.shape.acceptance.element.extend({
        intent: z.strictObject({
          kind: ConceptualReviewIntentKindSchema,
          label: z.string().min(1).max(256),
        }),
      }),
    )
    .min(1)
    .max(40),
  provenance: z.strictObject({
    planVersionId: KestrelIdSchema,
    version: z.int().min(1).max(200),
    author: z.enum(["operator", "assistant"]),
    approvalId: KestrelIdSchema,
    approvedByOperatorId: KestrelIdSchema,
    approvedAt: z.iso.datetime(),
    planDigest: Sha256DigestSchema,
  }),
});
export type FactoryConceptualReviewBasis = z.infer<typeof FactoryConceptualReviewBasisSchema>;

const FactoryConceptualReviewPublicationSchema = z
  .strictObject({
    pullRequest: FactoryFeaturePullRequestSchema,
    revision: FactoryFeaturePublicationReviewSchema.shape.revision,
    retainedManifestDigest: Sha256DigestSchema,
    certificate: FactoryFeatureVerificationSchema,
  })
  .superRefine((value, context) => {
    if (
      value.revision.state !== "available" ||
      value.pullRequest.baseCommitId !== value.revision.base.objectId ||
      value.pullRequest.headCommitId !== value.revision.head.objectId ||
      value.certificate.revision.baseCommitId !== value.revision.base.objectId ||
      value.certificate.revision.headCommitId !== value.revision.head.objectId
    ) {
      context.addIssue({
        code: "custom",
        message: "Conceptual Review publication must identify one exact retained revision",
      });
    }
  });

export const FactoryConceptualReviewBlockerSchema = z.enum([
  "publication_not_ready",
  "approved_plan_mismatch",
  "certificate_mismatch",
  "exact_revision_mismatch",
  "model_not_selected",
  "review_runtime_unavailable",
]);
export type FactoryConceptualReviewBlocker = z.infer<typeof FactoryConceptualReviewBlockerSchema>;

export const FactoryConceptualReviewPreparationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    projectId: KestrelIdSchema,
    featureId: KestrelIdSchema,
    changeProposalId: KestrelIdSchema.nullable(),
    preparationDigest: Sha256DigestSchema.nullable(),
    basis: FactoryConceptualReviewBasisSchema.nullable(),
    publication: FactoryConceptualReviewPublicationSchema.nullable(),
    evidence: z
      .strictObject({
        source: z.strictObject({
          baseCommitId: GitObjectIdSchema,
          headCommitId: GitObjectIdSchema,
          retainedManifestDigest: Sha256DigestSchema,
          limits: z.strictObject({
            catalogPageEntries: z.literal(200),
            fileBytes: z.literal(512 * 1024),
            lineRange: z.literal(200),
            responseBytes: z.literal(32 * 1024),
          }),
        }),
        checks: z.strictObject({
          runId: KestrelIdSchema,
          manifestDigest: Sha256DigestSchema,
          total: z.int().min(1).max(480),
          limits: z.strictObject({
            catalogPageEntries: z.literal(100),
            outputBytesPerStream: z.literal(8192),
          }),
        }),
      })
      .nullable(),
    configuration: z.strictObject({
      model: z.strictObject({
        route: z.literal("codex_subscription"),
        modelId: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
          .nullable(),
      }),
      runtimePolicy: z.strictObject({
        kind: z.literal("retained_source_review"),
        version: z.literal(1),
        sourceAccess: z.literal("retained_read_only"),
        networkAccess: z.literal(false),
        writeAccess: z.literal(false),
        status: z.enum(["available", "unavailable"]),
      }),
      resources: z.strictObject({
        maximumAttempts: z.int().min(1).max(10),
        timeoutSeconds: z.int().min(60).max(7200),
        maximumSourceReads: z.int().min(1).max(10_000),
        maximumGraphNodes: z.int().min(1).max(10_000),
        maximumOutputBytes: z
          .int()
          .min(1024)
          .max(16 * 1024 * 1024),
      }),
    }),
    readiness: z.strictObject({
      state: z.enum(["ready", "blocked"]),
      startAllowed: z.boolean(),
      blockers: z.array(FactoryConceptualReviewBlockerSchema).max(6),
    }),
  })
  .superRefine((value, context) => {
    const blockers = new Set(value.readiness.blockers);
    if (blockers.size !== value.readiness.blockers.length) {
      context.addIssue({ code: "custom", message: "Review blockers must be unique" });
    }
    const completeInputs =
      value.basis !== null &&
      value.publication !== null &&
      value.evidence !== null &&
      value.changeProposalId !== null &&
      value.configuration.model.modelId !== null;
    if (value.preparationDigest !== null && !completeInputs) {
      context.addIssue({
        code: "custom",
        message: "A Review preparation digest requires every immutable input",
      });
    }
    if (
      value.basis !== null &&
      value.publication !== null &&
      (value.basis.provenance.version !== value.publication.certificate.approvedVersion ||
        value.publication.certificate.featureId !== value.featureId)
    ) {
      context.addIssue({
        code: "custom",
        message: "The approved Feature plan and final certificate must identify the same Feature",
      });
    }
    if (
      value.publication !== null &&
      value.evidence !== null &&
      (value.evidence.source.baseCommitId !== value.publication.revision.base.objectId ||
        value.evidence.source.headCommitId !== value.publication.revision.head.objectId ||
        value.evidence.source.retainedManifestDigest !== value.publication.retainedManifestDigest ||
        value.evidence.checks.runId !== value.publication.certificate.runId ||
        value.evidence.checks.manifestDigest !== value.publication.certificate.manifestDigest ||
        value.evidence.checks.total !== value.publication.certificate.evidenceIds.length)
    ) {
      context.addIssue({
        code: "custom",
        message: "Review evidence must be bound to the published certificate and revision",
      });
    }
    const ready =
      completeInputs &&
      value.preparationDigest !== null &&
      value.configuration.runtimePolicy.status === "available" &&
      value.readiness.blockers.length === 0;
    if (
      (value.readiness.state === "ready") !== ready ||
      value.readiness.startAllowed !== ready ||
      (value.readiness.state === "blocked" && value.readiness.blockers.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Review readiness must reflect its exact inputs and runtime",
      });
    }
  });
export type FactoryConceptualReviewPreparation = z.infer<
  typeof FactoryConceptualReviewPreparationSchema
>;

export const FactoryConceptualReviewSourceSideSchema = z.enum(["base", "head"]);
const FactoryConceptualReviewSourceEntrySchema = z.strictObject({
  mode: z.enum(["040000", "100644", "100755", "120000", "160000"]),
  objectId: GitObjectIdSchema,
  path: SafeRetainedPathSchema,
  type: z.enum(["blob", "commit", "tree"]),
});

export const FactoryConceptualReviewSourceCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  side: FactoryConceptualReviewSourceSideSchema,
  commitId: GitObjectIdSchema,
  entries: z.array(FactoryConceptualReviewSourceEntrySchema).max(200),
  offset: z.int().min(0),
  total: z.int().min(0).max(100_000),
  nextOffset: z.int().min(1).nullable(),
});
export type FactoryConceptualReviewSourceCatalog = z.infer<
  typeof FactoryConceptualReviewSourceCatalogSchema
>;

export const FactoryConceptualReviewSourceLinesSchema = z.discriminatedUnion("status", [
  FactoryConceptualReviewSourceEntrySchema.extend({
    status: z.literal("available"),
    side: FactoryConceptualReviewSourceSideSchema,
    commitId: GitObjectIdSchema,
    startLine: z.int().min(1),
    endLine: z.int().min(1),
    totalLines: z.int().min(1),
    hasFinalNewline: z.boolean(),
    lineEndings: z
      .array(z.enum(["lf", "crlf", "none"]))
      .min(1)
      .max(200),
    text: z.string().max(32 * 1024),
  }),
  FactoryConceptualReviewSourceEntrySchema.extend({
    status: z.literal("unsupported"),
    side: FactoryConceptualReviewSourceSideSchema,
    commitId: GitObjectIdSchema,
    reason: z.enum(["binary", "symlink", "gitlink", "git_lfs_pointer", "directory"]),
  }),
]);
export type FactoryConceptualReviewSourceLines = z.infer<
  typeof FactoryConceptualReviewSourceLinesSchema
>;

const FactoryConceptualReviewCheckSummarySchema = z.strictObject({
  evidenceId: KestrelIdSchema,
  runId: KestrelIdSchema,
  manifestPosition: z.int().min(1).max(480),
  origins: z
    .array(
      z.strictObject({
        workItemKey: z.string().min(1).max(48),
        position: z.int().min(1).max(12),
      }),
    )
    .min(1)
    .max(480),
  command: FactoryVerificationResultSchema.shape.command,
  headCommitId: GitObjectIdSchema,
  treeId: GitObjectIdSchema,
  outcome: FactoryVerificationResultSchema.shape.outcome,
  exitCode: FactoryVerificationResultSchema.shape.exitCode,
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  durationMs: z.int().min(0),
  createdAt: z.iso.datetime(),
});

export const FactoryConceptualReviewCheckCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: KestrelIdSchema,
  manifestDigest: Sha256DigestSchema,
  checks: z.array(FactoryConceptualReviewCheckSummarySchema).max(100),
  offset: z.int().min(0),
  total: z.int().min(1).max(480),
  nextOffset: z.int().min(1).nullable(),
});
export type FactoryConceptualReviewCheckCatalog = z.infer<
  typeof FactoryConceptualReviewCheckCatalogSchema
>;

export const FactoryConceptualReviewCheckSchema = z.strictObject({
  schemaVersion: z.literal(1),
  evidenceId: KestrelIdSchema,
  runId: KestrelIdSchema,
  manifestPosition: z.int().min(1).max(480),
  origins: FactoryConceptualReviewCheckSummarySchema.shape.origins,
  result: FactoryVerificationResultSchema,
});
export type FactoryConceptualReviewCheck = z.infer<typeof FactoryConceptualReviewCheckSchema>;
