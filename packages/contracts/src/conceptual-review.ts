import { z } from "zod";

import { FactoryVerificationResultSchema } from "./factory-execution.js";
import {
  FactoryFeaturePullRequestSchema,
  FactoryFeaturePublicationReviewSchema,
} from "./factory-feature-publication.js";
import { FeaturePlanDocumentSchema } from "./factory-plan.js";
import { FactoryFeatureVerificationSchema } from "./factory-verification.js";
import { GitObjectIdSchema, KestrelIdSchema, RepositorySnapshotSchema } from "./v1.js";

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

const ConceptualReviewOutcomesSchema = z
  .array(
    FeaturePlanDocumentSchema.shape.acceptance.element.extend({
      intent: z.strictObject({
        kind: ConceptualReviewIntentKindSchema,
        label: z.string().min(1).max(256),
      }),
    }),
  )
  .min(1)
  .max(50);

export const FactoryConceptualReviewBasisSchema = z.strictObject({
  objective: FeaturePlanDocumentSchema.shape.objective,
  scope: FeaturePlanDocumentSchema.shape.scope,
  outcomes: ConceptualReviewOutcomesSchema,
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

export const ExternalConceptualReviewBasisSchema = z.strictObject({
  objective: FeaturePlanDocumentSchema.shape.objective,
  scope: FeaturePlanDocumentSchema.shape.scope,
  outcomes: ConceptualReviewOutcomesSchema,
  provenance: z.strictObject({
    kind: z.literal("change_intent"),
    changeIntentId: KestrelIdSchema,
    version: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
    sourceDigest: Sha256DigestSchema,
    resolution: z.enum(["resolved", "unresolved"]),
    sources: z
      .array(
        z.strictObject({
          kind: ConceptualReviewIntentKindSchema.exclude(["approved_feature_plan"]),
          label: z.string().min(1).max(256),
        }),
      )
      .max(20),
  }),
  limitations: z.array(z.string().trim().min(1).max(4000)).max(24),
});
export type ExternalConceptualReviewBasis = z.infer<typeof ExternalConceptualReviewBasisSchema>;

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

const ExternalConceptualReviewPullRequestSchema = z.strictObject({
  repository: z.strictObject({
    id: RepositorySnapshotSchema.shape.providerId,
    owner: RepositorySnapshotSchema.shape.owner,
    name: RepositorySnapshotSchema.shape.name,
  }),
  author: z.string().min(1).max(100).nullable(),
  number: z.int().positive().max(2_147_483_647),
  url: z.url().max(512),
  state: z.enum(["open", "closed", "merged", "unknown"]),
  title: z.string().min(1).max(512),
  body: z.string().max(65_536).nullable(),
  baseRef: z.string().min(1).max(512),
  headRef: z.string().min(1).max(512),
  baseCommitId: GitObjectIdSchema,
  headCommitId: GitObjectIdSchema,
});

const ExternalConceptualReviewPublicationSchema = z
  .strictObject({
    kind: z.literal("external_pull_request"),
    pullRequest: ExternalConceptualReviewPullRequestSchema,
    revision: FactoryFeaturePublicationReviewSchema.shape.revision,
    retainedManifestDigest: Sha256DigestSchema,
    certificate: z.null(),
  })
  .superRefine((value, context) => {
    if (
      value.revision.state !== "available" ||
      value.pullRequest.baseCommitId !== value.revision.base.objectId ||
      value.pullRequest.headCommitId !== value.revision.head.objectId
    ) {
      context.addIssue({
        code: "custom",
        message: "External Review publication must identify one exact retained revision",
      });
    }
  });

export const FactoryConceptualReviewBlockerSchema = z.enum([
  "publication_not_ready",
  "approved_plan_mismatch",
  "certificate_mismatch",
  "exact_revision_mismatch",
  "change_intent_not_available",
  "model_not_selected",
  "review_runtime_unavailable",
]);
export type FactoryConceptualReviewBlocker = z.infer<typeof FactoryConceptualReviewBlockerSchema>;

const ConceptualReviewConfigurationSchema = z.strictObject({
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
    adapter: z.literal("codex_app_server"),
    adapterVersion: z.literal(1),
    containerImage: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .nullable(),
    containerUser: z
      .string()
      .regex(/^[1-9]\d{0,9}:[1-9]\d{0,9}$/u)
      .nullable(),
    codexExecutable: z.string().min(1).max(4096).regex(/^\//u).nullable(),
    codexExecutableDigest: Sha256DigestSchema.nullable(),
    codexVersion: z
      .string()
      .min(1)
      .max(128)
      .regex(/^\d+\.\d+\.[0-9A-Za-z.+-]+$/u)
      .nullable(),
    codexProtocol: z.literal("app_server_v2"),
    sourceAccess: z.literal("retained_read_only"),
    networkAccess: z.literal(false),
    writeAccess: z.literal(false),
    status: z.enum(["available", "unavailable"]),
  }),
  resources: z.strictObject({
    maximumAttempts: z.int().min(1).max(10),
    timeoutSeconds: z.int().min(60).max(7200),
    maximumEvidenceItems: z.int().min(1).max(10_000),
    maximumWorkspaceFiles: z.int().min(1).max(100_000),
    maximumWorkspaceBytes: z
      .int()
      .min(1024)
      .max(4 * 1024 * 1024 * 1024),
    maximumGraphNodes: z.int().min(1).max(10_000),
    maximumOutputBytes: z
      .int()
      .min(1024)
      .max(16 * 1024 * 1024),
    containerPidsLimit: z.literal(128),
    containerMemoryBytes: z.literal(1024 * 1024 * 1024),
    containerNanoCpus: z.literal(2_000_000_000),
    containerTmpfsBytes: z.literal(64 * 1024 * 1024),
  }),
});

const ConceptualReviewReadinessSchema = z.strictObject({
  state: z.enum(["ready", "blocked"]),
  startAllowed: z.boolean(),
  blockers: z.array(FactoryConceptualReviewBlockerSchema).max(6),
});

const ConceptualReviewSourceEvidenceInputSchema = z.strictObject({
  baseCommitId: GitObjectIdSchema,
  headCommitId: GitObjectIdSchema,
  retainedManifestDigest: Sha256DigestSchema,
  limits: z.strictObject({
    catalogPageEntries: z.literal(200),
    fileBytes: z.literal(512 * 1024),
    lineRange: z.literal(200),
    responseBytes: z.literal(32 * 1024),
  }),
});

export const FactoryFeatureConceptualReviewPreparationSchema = z
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
        source: ConceptualReviewSourceEvidenceInputSchema,
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
    configuration: ConceptualReviewConfigurationSchema,
    readiness: ConceptualReviewReadinessSchema,
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
      value.configuration.runtimePolicy.containerImage !== null &&
      value.configuration.runtimePolicy.containerUser !== null &&
      value.configuration.runtimePolicy.codexExecutable !== null &&
      value.configuration.runtimePolicy.codexExecutableDigest !== null &&
      value.configuration.runtimePolicy.codexVersion !== null &&
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

export const ExternalConceptualReviewPreparationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    projectId: KestrelIdSchema,
    featureId: z.null(),
    changeProposalId: KestrelIdSchema,
    preparationDigest: Sha256DigestSchema.nullable(),
    basis: ExternalConceptualReviewBasisSchema.nullable(),
    publication: ExternalConceptualReviewPublicationSchema.nullable(),
    evidence: z
      .strictObject({
        source: ConceptualReviewSourceEvidenceInputSchema.extend({
          headTreeId: GitObjectIdSchema,
        }),
        checks: z.null(),
      })
      .nullable(),
    configuration: ConceptualReviewConfigurationSchema,
    readiness: ConceptualReviewReadinessSchema,
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
      value.configuration.model.modelId !== null;
    if (value.preparationDigest !== null && !completeInputs) {
      context.addIssue({
        code: "custom",
        message: "A Review preparation digest requires every immutable input",
      });
    }
    if (
      value.publication !== null &&
      value.evidence !== null &&
      (value.evidence.source.baseCommitId !== value.publication.revision.base.objectId ||
        value.evidence.source.headCommitId !== value.publication.revision.head.objectId ||
        value.evidence.source.retainedManifestDigest !== value.publication.retainedManifestDigest)
    ) {
      context.addIssue({
        code: "custom",
        message: "Review evidence must be bound to the retained pull request revision",
      });
    }
    const ready =
      completeInputs &&
      value.preparationDigest !== null &&
      value.configuration.runtimePolicy.status === "available" &&
      value.configuration.runtimePolicy.containerImage !== null &&
      value.configuration.runtimePolicy.containerUser !== null &&
      value.configuration.runtimePolicy.codexExecutable !== null &&
      value.configuration.runtimePolicy.codexExecutableDigest !== null &&
      value.configuration.runtimePolicy.codexVersion !== null &&
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

export const FactoryConceptualReviewPreparationSchema = z.union([
  FactoryFeatureConceptualReviewPreparationSchema,
  ExternalConceptualReviewPreparationSchema,
]);
export type FactoryFeatureConceptualReviewPreparation = z.infer<
  typeof FactoryFeatureConceptualReviewPreparationSchema
>;
export type ExternalConceptualReviewPreparation = z.infer<
  typeof ExternalConceptualReviewPreparationSchema
>;
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

export const FactoryConceptualReviewCheckSummarySchema = z.strictObject({
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
export type FactoryConceptualReviewCheckSummary = z.infer<
  typeof FactoryConceptualReviewCheckSummarySchema
>;

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

const FactoryConceptualReviewNodeIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u);
const ReviewTextSchema = z.string().trim().min(1).max(4000);
const ReviewLimitationsSchema = z.array(ReviewTextSchema).max(20);

const FactoryConceptualReviewOutcomeSchema = z.strictObject({
  id: FactoryConceptualReviewNodeIdSchema,
  outcomeKey: FeaturePlanDocumentSchema.shape.acceptance.element.shape.key,
  title: ReviewTextSchema,
  coverage: z.enum(["mapped", "not_applicable", "gap", "unclear"]),
  behavioralStepIds: z.array(FactoryConceptualReviewNodeIdSchema).max(80),
  reason: ReviewTextSchema,
});
const FactoryConceptualReviewBehavioralStepSchema = z.strictObject({
  id: FactoryConceptualReviewNodeIdSchema,
  title: ReviewTextSchema,
  description: ReviewTextSchema,
  change: z.enum(["added", "modified", "removed", "context"]),
  outcomeKeys: z.array(FeaturePlanDocumentSchema.shape.acceptance.element.shape.key).min(1).max(50),
  evidenceIds: z.array(FactoryConceptualReviewNodeIdSchema).min(1).max(80),
});
export const FactoryConceptualReviewSourceEvidenceSchema = z
  .strictObject({
    id: FactoryConceptualReviewNodeIdSchema,
    type: z.literal("source"),
    side: FactoryConceptualReviewSourceSideSchema,
    path: SafeRetainedPathSchema,
    startLine: z.int().min(1),
    endLine: z.int().min(1),
    description: ReviewTextSchema,
    sufficiency: ReviewTextSchema,
    limitations: ReviewLimitationsSchema,
  })
  .superRefine((value, context) => {
    if (value.endLine < value.startLine || value.endLine - value.startLine + 1 > 200)
      context.addIssue({
        code: "custom",
        message: "Source evidence must identify at most 200 consecutive lines",
      });
  });
export type FactoryConceptualReviewSourceEvidence = z.infer<
  typeof FactoryConceptualReviewSourceEvidenceSchema
>;

export const FactoryConceptualReviewCheckEvidenceSchema = z
  .strictObject({
    id: FactoryConceptualReviewNodeIdSchema,
    type: z.literal("check"),
    evidenceId: KestrelIdSchema,
    relation: z.enum(["supports", "refutes"]),
    proposition: ReviewTextSchema,
    description: ReviewTextSchema,
    sufficiency: ReviewTextSchema,
    limitations: ReviewLimitationsSchema,
    record: FactoryConceptualReviewCheckSummarySchema.extend({
      outcome: z.literal("passed"),
      exitCode: z.literal(0),
    }),
  })
  .superRefine((value, context) => {
    if (value.evidenceId !== value.record.evidenceId)
      context.addIssue({
        code: "custom",
        message: "Check evidence identity must match its server-resolved record",
      });
  });
export type FactoryConceptualReviewCheckEvidence = z.infer<
  typeof FactoryConceptualReviewCheckEvidenceSchema
>;

export const FactoryConceptualReviewEvidenceSchema = z.discriminatedUnion("type", [
  FactoryConceptualReviewSourceEvidenceSchema,
  FactoryConceptualReviewCheckEvidenceSchema,
]);
export type FactoryConceptualReviewEvidence = z.infer<typeof FactoryConceptualReviewEvidenceSchema>;

const FindingSchema = z.strictObject({
  id: FactoryConceptualReviewNodeIdSchema,
  type: z.literal("finding"),
  title: ReviewTextSchema,
  condition: ReviewTextSchema,
  consequence: ReviewTextSchema,
  reasoning: ReviewTextSchema,
  evidenceIds: z.array(FactoryConceptualReviewNodeIdSchema).min(1).max(80),
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  sufficiency: ReviewTextSchema,
  limitations: ReviewLimitationsSchema,
});
const ObservationSchema = z.strictObject({
  id: FactoryConceptualReviewNodeIdSchema,
  type: z.literal("observation"),
  title: ReviewTextSchema,
  description: ReviewTextSchema,
  evidenceIds: z.array(FactoryConceptualReviewNodeIdSchema).max(80),
  limitations: ReviewLimitationsSchema,
});
const UnverifiedConcernSchema = z.strictObject({
  id: FactoryConceptualReviewNodeIdSchema,
  type: z.literal("unverified_concern"),
  title: ReviewTextSchema,
  condition: ReviewTextSchema,
  possibleConsequence: ReviewTextSchema,
  reasonUnverified: ReviewTextSchema,
  evidenceIds: z.array(FactoryConceptualReviewNodeIdSchema).max(80),
  limitations: ReviewLimitationsSchema.min(1),
});
export const FactoryConceptualReviewProblemSchema = z.discriminatedUnion("type", [
  FindingSchema,
  ObservationSchema,
  UnverifiedConcernSchema,
]);
export type FactoryConceptualReviewProblem = z.infer<typeof FactoryConceptualReviewProblemSchema>;

const FactoryConceptualReviewEdgeSchema = z.strictObject({
  from: FactoryConceptualReviewNodeIdSchema,
  to: FactoryConceptualReviewNodeIdSchema,
  kind: z.enum(["implemented_by", "supported_by", "reveals"]),
});

function reviewEdgeKey(from: string, kind: string, to: string): string {
  return JSON.stringify([from, kind, to]);
}

export const FactoryConceptualReviewDraftSchema = z
  .strictObject({
    result: z.enum(["complete", "partial"]),
    summary: ReviewTextSchema,
    outcomes: z.array(FactoryConceptualReviewOutcomeSchema).min(1).max(50),
    behavioralSteps: z.array(FactoryConceptualReviewBehavioralStepSchema).max(800),
    evidence: z.array(FactoryConceptualReviewEvidenceSchema).max(800),
    problems: z.array(FactoryConceptualReviewProblemSchema).max(800),
    edges: z.array(FactoryConceptualReviewEdgeSchema).max(2400),
    limitations: ReviewLimitationsSchema,
  })
  .superRefine((value, context) => {
    const groups = [value.outcomes, value.behavioralSteps, value.evidence, value.problems];
    const all = groups.flatMap((group) => group.map(({ id }) => id));
    const ids = new Set(all);
    if (ids.size !== all.length)
      context.addIssue({ code: "custom", message: "Review graph node IDs must be unique" });
    const outcomesByKey = new Map(value.outcomes.map((outcome) => [outcome.outcomeKey, outcome]));
    const outcomeKeys = new Set(outcomesByKey.keys());
    const steps = new Map(value.behavioralSteps.map((step) => [step.id, step]));
    const evidence = new Map(value.evidence.map((item) => [item.id, item]));
    const problems = new Map(value.problems.map((problem) => [problem.id, problem]));
    const expectedEdgeKeys = new Set([
      ...value.outcomes.flatMap((outcome) =>
        outcome.behavioralStepIds.map((stepId) =>
          reviewEdgeKey(outcome.id, "implemented_by", stepId),
        ),
      ),
      ...value.behavioralSteps.flatMap((step) =>
        step.evidenceIds.map((evidenceId) => reviewEdgeKey(step.id, "supported_by", evidenceId)),
      ),
      ...value.problems.flatMap((problem) =>
        problem.evidenceIds.map((evidenceId) => reviewEdgeKey(evidenceId, "reveals", problem.id)),
      ),
    ]);
    const edgeKeys = new Set<string>();
    for (const edge of value.edges) {
      const key = reviewEdgeKey(edge.from, edge.kind, edge.to);
      if (edgeKeys.has(key))
        context.addIssue({ code: "custom", message: "Review graph edges must be unique" });
      edgeKeys.add(key);
      if (!ids.has(edge.from) || !ids.has(edge.to))
        context.addIssue({ code: "custom", message: "Review graph edges must resolve" });
      const compatible =
        (edge.kind === "implemented_by" &&
          value.outcomes.some(({ id }) => id === edge.from) &&
          steps.has(edge.to)) ||
        (edge.kind === "supported_by" && steps.has(edge.from) && evidence.has(edge.to)) ||
        (edge.kind === "reveals" && evidence.has(edge.from) && problems.has(edge.to));
      if (!compatible)
        context.addIssue({ code: "custom", message: "Review graph edge kinds must be compatible" });
      if (!expectedEdgeKeys.has(key))
        context.addIssue({
          code: "custom",
          message: "Review graph edges must match declared relationships",
        });
    }
    for (const outcome of value.outcomes) {
      const mapped = outcome.coverage === "mapped";
      if (
        (mapped && outcome.behavioralStepIds.length === 0) ||
        (["gap", "not_applicable"].includes(outcome.coverage) &&
          outcome.behavioralStepIds.length > 0)
      )
        context.addIssue({
          code: "custom",
          message: "Outcome coverage must identify only relevant Behavioral Steps",
        });
      if (
        mapped &&
        !outcome.behavioralStepIds.some((stepId) => {
          const step = steps.get(stepId);
          return step !== undefined && step.change !== "context";
        })
      )
        context.addIssue({
          code: "custom",
          message: "Mapped outcomes require an added, modified, or removed behavior",
        });
      for (const stepId of outcome.behavioralStepIds)
        if (
          !steps.get(stepId)?.outcomeKeys.includes(outcome.outcomeKey) ||
          !edgeKeys.has(reviewEdgeKey(outcome.id, "implemented_by", stepId))
        )
          context.addIssue({
            code: "custom",
            message: "Outcome mappings must resolve in the graph",
          });
    }
    for (const step of value.behavioralSteps) {
      if (step.outcomeKeys.some((key) => !outcomeKeys.has(key)))
        context.addIssue({ code: "custom", message: "Behavioral Steps must resolve outcomes" });
      for (const outcomeKey of step.outcomeKeys) {
        const outcome = outcomesByKey.get(outcomeKey);
        if (
          outcome !== undefined &&
          (!outcome.behavioralStepIds.includes(step.id) ||
            !edgeKeys.has(reviewEdgeKey(outcome.id, "implemented_by", step.id)))
        )
          context.addIssue({
            code: "custom",
            message: "Behavioral Step outcomes must resolve in the graph",
          });
      }
      for (const evidenceId of step.evidenceIds)
        if (
          !evidence.has(evidenceId) ||
          !edgeKeys.has(reviewEdgeKey(step.id, "supported_by", evidenceId))
        )
          context.addIssue({ code: "custom", message: "Behavioral Step evidence must resolve" });
      const evidenceSides = step.evidenceIds.flatMap((id) => {
        const item = evidence.get(id);
        return item?.type === "source" ? [item.side] : [];
      });
      if (["added", "modified"].includes(step.change) && !evidenceSides.includes("head"))
        context.addIssue({
          code: "custom",
          message: "Added and modified behaviors require exact-head evidence",
        });
      if (step.change === "removed" && !evidenceSides.includes("base"))
        context.addIssue({
          code: "custom",
          message: "Removed behaviors require exact-base evidence",
        });
    }
    for (const problem of value.problems) {
      for (const evidenceId of problem.evidenceIds)
        if (
          !evidence.has(evidenceId) ||
          !edgeKeys.has(reviewEdgeKey(evidenceId, "reveals", problem.id))
        )
          context.addIssue({ code: "custom", message: "Problem evidence must resolve" });
      if (
        problem.type === "finding" &&
        problem.evidenceIds.some((id) => {
          const item = evidence.get(id);
          return item?.type === "source" && item.side !== "head";
        })
      )
        context.addIssue({
          code: "custom",
          message: "Findings require exact-head source evidence",
        });
    }
    const referencedEvidence = new Set([
      ...value.behavioralSteps.flatMap((step) => step.evidenceIds),
      ...value.problems.flatMap((problem) => problem.evidenceIds),
    ]);
    for (const evidenceId of evidence.keys())
      if (!referencedEvidence.has(evidenceId))
        context.addIssue({
          code: "custom",
          message: "Every evidence node must support a behavior or problem",
        });
    const uncovered = value.outcomes.some(({ coverage }) => ["gap", "unclear"].includes(coverage));
    if (uncovered && value.result !== "partial")
      context.addIssue({ code: "custom", message: "Uncovered outcomes require a Partial review" });
  });
export type FactoryConceptualReviewDraft = z.infer<typeof FactoryConceptualReviewDraftSchema>;

export const FactoryConceptualReviewStartCommandSchema = z.strictObject({
  requestId: z.uuid(),
  preparationDigest: Sha256DigestSchema,
});
export type FactoryConceptualReviewStartCommand = z.infer<
  typeof FactoryConceptualReviewStartCommandSchema
>;

export const FactoryConceptualReviewArtifactSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: KestrelIdSchema,
    workflowId: KestrelIdSchema,
    inputDigest: Sha256DigestSchema,
    reviewRevisionId: KestrelIdSchema,
    baseCommitId: GitObjectIdSchema,
    headCommitId: GitObjectIdSchema,
    status: z.enum(["complete", "partial"]),
    evidenceScope: z.union([
      z.strictObject({
        source: z.literal("exact_retained_revision"),
        executedChecks: z.literal("not_linked"),
        narrativeAuthority: z.literal("source_only_model_interpretation"),
      }),
      z.strictObject({
        source: z.literal("exact_retained_revision"),
        executedChecks: z.literal("linked_final_certificate"),
        narrativeAuthority: z.literal("host_resolved_evidence_model_judgment"),
      }),
    ]),
    graph: FactoryConceptualReviewDraftSchema,
    createdAt: z.iso.datetime(),
  })
  .superRefine((value, context) => {
    if (value.status !== value.graph.result)
      context.addIssue({ code: "custom", message: "Artifact status must match graph coverage" });
    const hasCheckEvidence = value.graph.evidence.some(({ type }) => type === "check");
    if ((value.evidenceScope.executedChecks === "linked_final_certificate") !== hasCheckEvidence)
      context.addIssue({
        code: "custom",
        message: "Artifact check evidence must match its declared evidence scope",
      });
    if (value.evidenceScope.executedChecks === "not_linked" && value.status !== "partial")
      context.addIssue({
        code: "custom",
        message: "A review without linked executed checks must remain Partial",
      });
    if (
      value.evidenceScope.executedChecks === "linked_final_certificate" &&
      value.status === "complete"
    ) {
      const evidence = new Map(value.graph.evidence.map((item) => [item.id, item]));
      const missingCheck = value.graph.behavioralSteps.some(
        (step) =>
          step.change !== "context" &&
          !step.evidenceIds.some((id) => {
            const item = evidence.get(id);
            return item?.type === "check" && item.relation === "supports";
          }),
      );
      const uncovered = value.graph.outcomes.some(({ coverage }) =>
        ["gap", "unclear"].includes(coverage),
      );
      if (missingCheck || uncovered)
        context.addIssue({
          code: "custom",
          message: "A Complete review requires supported final checks for every changed behavior",
        });
    }
  });
export type FactoryConceptualReviewArtifact = z.infer<typeof FactoryConceptualReviewArtifactSchema>;

export const FactoryConceptualReviewFailureSchema = z.enum([
  "runtime_unavailable",
  "authentication_required",
  "usage_limit",
  "timeout",
  "invalid_output",
  "source_unavailable",
  "check_unavailable",
  "resource_exhausted",
  "interrupted",
  "stop_unconfirmed",
  "internal_error",
]);
export type FactoryConceptualReviewFailure = z.infer<typeof FactoryConceptualReviewFailureSchema>;
export const FactoryConceptualReviewWorkflowSchema = z.strictObject({
  id: KestrelIdSchema,
  requestId: z.uuid(),
  projectId: KestrelIdSchema,
  featureId: KestrelIdSchema.nullable(),
  changeProposalId: KestrelIdSchema,
  inputDigest: Sha256DigestSchema,
  reviewRevisionId: KestrelIdSchema,
  state: z.enum(["queued", "running", "published", "failed"]),
  attempt: z.strictObject({ current: z.int().min(0).max(10), maximum: z.int().min(1).max(10) }),
  failure: FactoryConceptualReviewFailureSchema.nullable(),
  artifactId: KestrelIdSchema.nullable(),
  requestedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type FactoryConceptualReviewWorkflow = z.infer<typeof FactoryConceptualReviewWorkflowSchema>;

export const FactoryConceptualReviewWorkflowReadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    workflow: FactoryConceptualReviewWorkflowSchema,
    artifact: FactoryConceptualReviewArtifactSchema.nullable(),
    currency: z.enum(["up_to_date", "outdated", "unknown"]),
  })
  .superRefine((value, context) => {
    if (
      (value.workflow.artifactId === null) !== (value.artifact === null) ||
      (value.artifact !== null &&
        (value.artifact.id !== value.workflow.artifactId ||
          value.artifact.workflowId !== value.workflow.id ||
          value.artifact.inputDigest !== value.workflow.inputDigest))
    )
      context.addIssue({ code: "custom", message: "Workflow and artifact identity must match" });
  });
export type FactoryConceptualReviewWorkflowRead = z.infer<
  typeof FactoryConceptualReviewWorkflowReadSchema
>;

export const FactoryConceptualReviewCurrentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  review: FactoryConceptualReviewWorkflowReadSchema.nullable(),
});
export type FactoryConceptualReviewCurrent = z.infer<typeof FactoryConceptualReviewCurrentSchema>;

export const FactoryConceptualReviewHistorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  reviews: z
    .array(
      z.strictObject({
        artifactId: KestrelIdSchema,
        workflowId: KestrelIdSchema,
        status: z.enum(["complete", "partial"]),
        headCommitId: GitObjectIdSchema,
        requestedAt: z.iso.datetime(),
        finishedAt: z.iso.datetime(),
        currency: z.enum(["up_to_date", "outdated", "unknown"]),
      }),
    )
    .max(50),
  offset: z.int().min(0),
  total: z.int().min(0),
  nextOffset: z.int().min(1).nullable(),
});
export type FactoryConceptualReviewHistory = z.infer<typeof FactoryConceptualReviewHistorySchema>;
