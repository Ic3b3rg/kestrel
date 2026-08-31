import { z } from "zod";

export const SchemaVersionSchema = z.literal(1);
export const EventCursorSchema = z
  .string()
  .max(19)
  .regex(/^(0|[1-9][0-9]*)$/u);
export const CredentialVersionSchema = z
  .string()
  .max(18)
  .regex(/^[1-9][0-9]*$/u);
export const KestrelIdSchema = z.uuidv7();
export const CorrelationIdSchema = z.uuid();
export const UtcDateTimeSchema = z.iso.datetime({ offset: false });
export const RequestDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const OperatorUsernameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

const GitHubOwnerSchema = z
  .string()
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u);
const GitHubRepositoryNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/u);
const GitHubOpaqueIdSchema = z.string().min(1).max(256);
export const GitObjectFormatSchema = z.enum(["sha1", "sha256"]);
export const GitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const GitReferenceSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\p{Cc}]+$/u);

export const ChangeIntentTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(20_000)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 20_000, {
    message: "Change Intent must be at most 20000 UTF-8 bytes",
  });

export const ChangeIntentSourceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_:-]*$/u);

export const ChangeIntentUnresolvedIssueInputSchema = z.strictObject({
  kind: z.enum(["ambiguous", "contradictory"]),
  description: ChangeIntentTextSchema,
});

export const CreateChangeIntentVersionCommandSchema = z
  .strictObject({
    expectedProposalVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    objective: ChangeIntentTextSchema.nullable(),
    scopeBoundaries: z.array(ChangeIntentTextSchema).max(20),
    acceptanceOutcomes: z.array(ChangeIntentTextSchema).max(50),
    selectedSourceIds: z.array(ChangeIntentSourceIdSchema).max(20),
    operatorInput: ChangeIntentTextSchema.nullable(),
    unresolvedIssues: z.array(ChangeIntentUnresolvedIssueInputSchema).max(20),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, sourceId] of value.selectedSourceIds.entries()) {
      if (seen.has(sourceId)) {
        context.addIssue({
          code: "custom",
          message: "A Change Intent source may be selected only once",
          path: ["selectedSourceIds", index],
        });
      }
      seen.add(sourceId);
    }
    if (
      value.objective === null &&
      value.operatorInput === null &&
      value.selectedSourceIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "A Change Intent version requires intent material",
      });
    }
    if (value.operatorInput !== null && value.selectedSourceIds.length === 20) {
      context.addIssue({
        code: "custom",
        message: "Operator input cannot be combined with 20 selected sources",
        path: ["selectedSourceIds"],
      });
    }
  });

export const RetainLocalReviewRevisionCommandSchema = z
  .strictObject({
    repositoryId: KestrelIdSchema,
    baseRef: GitReferenceSchema,
    headRef: GitReferenceSchema,
    changeIntent: ChangeIntentTextSchema,
    changeProposalId: KestrelIdSchema.optional(),
  })
  .refine(({ baseRef, headRef }) => baseRef !== headRef, {
    message: "Base and head references must be different",
    path: ["headRef"],
  });

export const RetainObservedReviewRevisionCommandSchema = z.strictObject({
  projectId: KestrelIdSchema,
  changeProposalId: KestrelIdSchema,
  changeIntent: ChangeIntentTextSchema,
});

export const RetainReviewRevisionCommandSchema = z.union([
  RetainLocalReviewRevisionCommandSchema,
  RetainObservedReviewRevisionCommandSchema,
]);

export const LocalRepositoryInventoryItemSchema = z.strictObject({
  repositoryId: KestrelIdSchema,
  displayName: z.string().min(1).max(256),
  attachmentState: z.enum(["unattached", "attached"]),
});

export const LocalRepositoryInventorySchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  repositories: z.array(LocalRepositoryInventoryItemSchema).max(100),
});

export const LocalRepositoryReferenceSchema = z.strictObject({
  ref: GitReferenceSchema,
  displayName: z.string().min(1).max(255),
  kind: z.enum(["head", "local_branch", "remote_branch", "tag"]),
  commitObjectId: GitObjectIdSchema,
  commitSubjectSuggestion: z.string().max(512).nullable(),
});

export const LocalRepositoryReferencesSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    repositoryId: KestrelIdSchema,
    objectFormat: GitObjectFormatSchema,
    references: z.array(LocalRepositoryReferenceSchema).max(500),
  })
  .superRefine((value, context) => {
    const expectedLength = value.objectFormat === "sha1" ? 40 : 64;
    for (const [index, reference] of value.references.entries()) {
      if (reference.commitObjectId.length !== expectedLength) {
        context.addIssue({
          code: "custom",
          message: `Expected a ${value.objectFormat} object ID`,
          path: ["references", index, "commitObjectId"],
        });
      }
    }
  });

export const PublicGitHubPullRequestUrlSchema = z
  .string()
  .max(256)
  .regex(
    /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9][0-9]{0,9}$/u,
  );

export const OpenPublicGitHubPullRequestCommandSchema = z.strictObject({
  url: PublicGitHubPullRequestUrlSchema,
});

export const HostGitHubPullRequestGroupSchema = z.enum(["review_requested", "authored", "other"]);

export const HostGitHubStatusSchema = z.strictObject({
  executableVersion: z.string().min(1).max(128).nullable(),
  availability: z.enum(["available", "unavailable"]),
  host: z.string().min(1).max(253),
  authentication: z.enum(["authenticated", "needs_authentication", "access_denied", "unknown"]),
  account: z.string().min(1).max(100).nullable(),
});

export const HostGitHubPullRequestSummarySchema = z.strictObject({
  number: z.number().int().positive().max(9_999_999_999),
  title: z.string().min(1).max(512),
  body: z.string().max(65_536),
  url: PublicGitHubPullRequestUrlSchema,
  author: z.string().min(1).max(100).nullable(),
  updatedAt: UtcDateTimeSchema,
  group: HostGitHubPullRequestGroupSchema,
});

export const HostGitHubProjectInboxSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  projectId: KestrelIdSchema,
  route: z.literal("host_gh"),
  limitations: z.array(z.string().min(1).max(256)).max(10),
  status: HostGitHubStatusSchema,
  pullRequests: z.array(HostGitHubPullRequestSummarySchema).max(300),
  observedAt: UtcDateTimeSchema,
});

export const ObserveHostGitHubPullRequestCommandSchema = z.strictObject({
  number: z.number().int().positive().max(9_999_999_999),
});

export const ProviderObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    authentication: z.literal("none"),
    kind: z.literal("public_github"),
    refresh: z.literal("manual"),
  }),
  z.strictObject({
    authentication: z.literal("host_session"),
    kind: z.literal("host_gh"),
    refresh: z.literal("manual"),
    host: z.string().min(1).max(253),
    account: z.string().min(1).max(100),
  }),
]);

export const RepositorySnapshotSchema = z.strictObject({
  canonicalUrl: z
    .string()
    .max(240)
    .regex(
      /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/u,
    ),
  name: GitHubRepositoryNameSchema,
  owner: GitHubOwnerSchema,
  providerId: GitHubOpaqueIdSchema,
});

export const GitRevisionPointerSchema = z.strictObject({
  objectId: GitObjectIdSchema,
  ref: GitReferenceSchema,
});

const ChangeIntentSourceTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(65_536)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 65_536, {
    message: "Change Intent source text must be at most 65536 UTF-8 bytes",
  });

export const ChangeIntentSourceProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("provider_field"),
    provider: z.literal("github"),
    field: z.enum(["title", "description"]),
    observedAt: UtcDateTimeSchema,
    canonicalUrl: PublicGitHubPullRequestUrlSchema,
  }),
  z.strictObject({
    kind: z.literal("commit_author"),
    side: z.enum(["base", "head"]),
    objectId: GitObjectIdSchema,
    ref: GitReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal("commit_message"),
    side: z.enum(["base", "head"]),
    objectId: GitObjectIdSchema,
    ref: GitReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal("operator_input"),
  }),
]);

export const ChangeIntentSourceSchema = z
  .strictObject({
    id: ChangeIntentSourceIdSchema,
    kind: z.enum(["provider_field", "commit_author", "commit_message", "operator_input"]),
    label: z.string().trim().min(1).max(256),
    text: ChangeIntentSourceTextSchema,
    version: z.string().min(1).max(128),
    provenance: ChangeIntentSourceProvenanceSchema,
  })
  .superRefine((value, context) => {
    if (value.kind !== value.provenance.kind) {
      context.addIssue({
        code: "custom",
        message: "Change Intent source kind and provenance must match",
        path: ["provenance", "kind"],
      });
    }
  });

export const ChangeIntentResolutionIssueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("missing"),
    field: z.enum(["objective", "scope_boundaries", "acceptance_outcomes", "sources"]),
  }),
  z.strictObject({
    kind: z.literal("ambiguous"),
    description: ChangeIntentTextSchema,
  }),
  z.strictObject({
    kind: z.literal("contradictory"),
    description: ChangeIntentTextSchema,
  }),
]);

export interface ChangeIntentResolutionMaterial {
  acceptanceOutcomes: readonly string[];
  objective: string | null;
  scopeBoundaries: readonly string[];
  sourceCount: number;
  unresolvedIssues: readonly z.infer<typeof ChangeIntentUnresolvedIssueInputSchema>[];
}

export function evaluateChangeIntentResolution(
  material: ChangeIntentResolutionMaterial,
): z.infer<typeof ChangeIntentResolutionSchema> {
  const issues: z.infer<typeof ChangeIntentResolutionIssueSchema>[] = [];
  if (material.objective === null) issues.push({ kind: "missing", field: "objective" });
  if (material.scopeBoundaries.length === 0) {
    issues.push({ kind: "missing", field: "scope_boundaries" });
  }
  if (material.acceptanceOutcomes.length === 0) {
    issues.push({ kind: "missing", field: "acceptance_outcomes" });
  }
  if (material.sourceCount === 0) issues.push({ kind: "missing", field: "sources" });
  issues.push(...material.unresolvedIssues);
  return { state: issues.length === 0 ? "resolved" : "unresolved", issues };
}

export const ChangeIntentResolutionSchema = z
  .strictObject({
    state: z.enum(["unresolved", "resolved"]),
    issues: z.array(ChangeIntentResolutionIssueSchema).max(24),
  })
  .superRefine((value, context) => {
    if (
      (value.state === "resolved" && value.issues.length !== 0) ||
      (value.state === "unresolved" && value.issues.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Change Intent resolution state and issues are inconsistent",
      });
    }
  });

export const ChangeIntentSchema = z
  .strictObject({
    id: KestrelIdSchema,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    text: ChangeIntentTextSchema,
    objective: ChangeIntentTextSchema.nullable(),
    scopeBoundaries: z.array(ChangeIntentTextSchema).max(20),
    acceptanceOutcomes: z.array(ChangeIntentTextSchema).max(50),
    sources: z.array(ChangeIntentSourceSchema).max(20),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    resolution: ChangeIntentResolutionSchema,
    createdAt: UtcDateTimeSchema,
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, source] of value.sources.entries()) {
      if (seen.has(source.id)) {
        context.addIssue({
          code: "custom",
          message: "A Change Intent source identity may appear only once",
          path: ["sources", index, "id"],
        });
      }
      seen.add(source.id);
    }
    const materialResolution = evaluateChangeIntentResolution({
      acceptanceOutcomes: value.acceptanceOutcomes,
      objective: value.objective,
      scopeBoundaries: value.scopeBoundaries,
      sourceCount: value.sources.length,
      unresolvedIssues: [],
    });
    if (value.resolution.state === "resolved" && materialResolution.state !== "resolved") {
      context.addIssue({
        code: "custom",
        message: "Resolved Change Intent fields are incomplete",
      });
    }
  });

export const ChangeIntentVersionCreatedSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  projectId: KestrelIdSchema,
  changeProposalId: KestrelIdSchema,
  proposalVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  changeIntent: ChangeIntentSchema,
});

export const ReviewRevisionFailureReasonSchema = z.enum([
  "source_not_available",
  "source_containment_violation",
  "reference_not_available",
  "base_revision_unresolvable",
  "head_revision_unresolvable",
  "pull_ref_mismatch",
  "provider_authentication_required",
  "provider_resource_unavailable",
  "revision_limit_exceeded",
  "object_missing",
  "object_verification_failed",
  "artifact_finalization_failed",
  "acquisition_interrupted",
]);

export const ReviewRevisionSchema = z
  .strictObject({
    id: KestrelIdSchema,
    state: z.enum(["acquiring", "available", "unavailable"]),
    objectFormat: GitObjectFormatSchema,
    base: GitRevisionPointerSchema,
    head: GitRevisionPointerSchema,
    objectCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    retainedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    failureReason: ReviewRevisionFailureReasonSchema.nullable(),
    createdAt: UtcDateTimeSchema,
    availableAt: UtcDateTimeSchema.nullable(),
  })
  .superRefine((value, context) => {
    const expectedLength = value.objectFormat === "sha1" ? 40 : 64;
    for (const side of ["base", "head"] as const) {
      if (value[side].objectId.length !== expectedLength) {
        context.addIssue({
          code: "custom",
          message: `Expected a ${value.objectFormat} object ID`,
          path: [side, "objectId"],
        });
      }
    }
    const availableFields =
      value.objectCount !== null &&
      value.objectCount > 0 &&
      value.retainedBytes !== null &&
      value.availableAt !== null &&
      value.failureReason === null;
    const acquiringFields =
      value.objectCount === null &&
      value.retainedBytes === null &&
      value.availableAt === null &&
      value.failureReason === null;
    const unavailableFields =
      value.objectCount === null &&
      value.retainedBytes === null &&
      value.availableAt === null &&
      value.failureReason !== null;
    if (
      (value.state === "available" && !availableFields) ||
      (value.state === "acquiring" && !acquiringFields) ||
      (value.state === "unavailable" && !unavailableFields)
    ) {
      context.addIssue({ code: "custom", message: "Revision State fields are inconsistent" });
    }
  });

export const LocalRepositorySourceSchema = z.strictObject({
  id: KestrelIdSchema,
  repositoryId: KestrelIdSchema,
  displayName: z.string().min(1).max(256),
  state: z.enum(["attached", "detached"]),
  objectFormat: GitObjectFormatSchema,
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
});

export const ProviderObservedChangeProposalSchema = z.strictObject({
  kind: z.literal("provider_observed"),
  id: KestrelIdSchema,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  providerId: GitHubOpaqueIdSchema,
  number: z.number().int().positive().max(9_999_999_999),
  title: z.string().min(1).max(512),
  body: z.string().max(65_536).optional(),
  canonicalUrl: PublicGitHubPullRequestUrlSchema,
  proposalState: z.enum(["open", "merged", "closed", "unknown"]),
  base: GitRevisionPointerSchema,
  head: GitRevisionPointerSchema,
  author: z
    .strictObject({
      login: z.string().min(1).max(100),
      providerId: GitHubOpaqueIdSchema,
    })
    .nullable(),
  observedAt: UtcDateTimeSchema,
  changeIntent: ChangeIntentSchema.nullable(),
  changeIntentCandidates: z.array(ChangeIntentSourceSchema).max(20),
  reviewRevisions: z.array(ReviewRevisionSchema).max(20),
});

export const LocalChangeProposalSchema = z.strictObject({
  kind: z.literal("local"),
  id: KestrelIdSchema,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  title: z.string().min(1).max(512),
  base: GitRevisionPointerSchema,
  head: GitRevisionPointerSchema,
  changeIntent: ChangeIntentSchema,
  changeIntentCandidates: z.array(ChangeIntentSourceSchema).max(20),
  reviewRevisions: z.array(ReviewRevisionSchema).max(20),
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
});

export const ChangeProposalSchema = z.discriminatedUnion("kind", [
  ProviderObservedChangeProposalSchema,
  LocalChangeProposalSchema,
]);

export const ProjectSchema = z.strictObject({
  id: KestrelIdSchema,
  providerObservation: ProviderObservationSchema.nullable(),
  repository: RepositorySnapshotSchema.nullable(),
  localRepositorySource: LocalRepositorySourceSchema.nullable(),
  sourceAvailability: z.enum(["not_acquired", "available", "unavailable"]),
  modelAccess: z.enum(["not_configured"]),
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
  changeProposals: z.array(ChangeProposalSchema).max(100),
});

export const ProjectInboxSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  projects: z.array(ProjectSchema).max(100),
});

export const ProjectUpsertedSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  project: ProjectSchema,
});

export const ReviewPreparationBlockerSchema = z.enum([
  "revision_not_available",
  "change_intent_not_resolved",
  "revision_identity_incoherent",
  "model_route_not_available",
  "operator_authority_not_available",
  "resource_envelope_not_available",
]);

export const ReviewAnalysisConfigurationSchema = z.strictObject({
  id: KestrelIdSchema,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  displayName: z.string().min(1).max(256),
  modelRoute: z.enum(["direct_api", "subscription_acp"]),
  digest: RequestDigestSchema,
});

export const ReviewModelRouteAvailabilitySchema = z.enum(["available", "unavailable"]);

export const ReviewAuthoritySchema = z
  .strictObject({
    action: z.literal("start_review"),
    operatorId: KestrelIdSchema.nullable(),
    state: z.enum(["available", "unavailable"]),
  })
  .refine(
    ({ operatorId, state }) =>
      (state === "available" && operatorId !== null) ||
      (state === "unavailable" && operatorId === null),
    { message: "Review authority identity and state are inconsistent" },
  );

const ReviewResourceEnvelopeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u);

export const ReviewResourceEnvelopeSchema = z.strictObject({
  id: ReviewResourceEnvelopeIdSchema,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  displayName: z.string().min(1).max(256),
  limits: z.strictObject({
    maximumMemoryBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maximumProcesses: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maximumWritableDiskBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maximumCpuMillicores: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maximumConcurrentAttempts: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  terminalBoundary: z.strictObject({
    onExhaustion: z.literal("partial_or_failed"),
    requiresUncoveredAreaDisclosure: z.literal(true),
  }),
  digest: RequestDigestSchema,
});

export const ReviewProviderObservationSchema = z.strictObject({
  route: ProviderObservationSchema,
  repository: RepositorySnapshotSchema,
  proposal: z.strictObject({
    canonicalUrl: PublicGitHubPullRequestUrlSchema,
    number: z.number().int().positive().max(9_999_999_999),
    observedAt: UtcDateTimeSchema,
    providerId: GitHubOpaqueIdSchema,
  }),
});

export const ReviewPreparationSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    projectId: KestrelIdSchema,
    changeProposalId: KestrelIdSchema,
    proposal: z.strictObject({
      version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      base: GitRevisionPointerSchema,
      head: GitRevisionPointerSchema,
    }),
    reviewRevision: ReviewRevisionSchema.nullable(),
    changeIntent: ChangeIntentSchema.nullable(),
    source: z.strictObject({
      localRepositorySource: LocalRepositorySourceSchema.nullable(),
      providerObservation: ReviewProviderObservationSchema.nullable(),
    }),
    analysisConfiguration: ReviewAnalysisConfigurationSchema.nullable(),
    modelRouteAvailability: ReviewModelRouteAvailabilitySchema,
    authority: ReviewAuthoritySchema,
    resourceEnvelope: ReviewResourceEnvelopeSchema.nullable(),
    readiness: z.enum(["ready", "blocked"]),
    blockers: z.array(ReviewPreparationBlockerSchema).max(6),
    preparationDigest: RequestDigestSchema.nullable(),
  })
  .superRefine((value, context) => {
    const blockers = new Set(value.blockers);
    if (blockers.size !== value.blockers.length) {
      context.addIssue({ code: "custom", message: "Review preparation blockers must be unique" });
    }

    const revision = value.reviewRevision;
    const exactRevision =
      revision !== null &&
      revision.state === "available" &&
      revision.base.objectId === value.proposal.base.objectId &&
      revision.head.objectId === value.proposal.head.objectId &&
      revision.objectFormat === value.source.localRepositorySource?.objectFormat;
    const complete =
      exactRevision &&
      value.changeIntent?.resolution.state === "resolved" &&
      value.analysisConfiguration !== null &&
      value.modelRouteAvailability === "available" &&
      value.authority.state === "available" &&
      value.resourceEnvelope !== null &&
      value.blockers.length === 0 &&
      value.preparationDigest !== null;

    if (value.readiness === "ready" && !complete) {
      context.addIssue({
        code: "custom",
        message: "Ready Review preparation requires complete valid inputs",
      });
    }
    if (value.modelRouteAvailability === "available" && value.analysisConfiguration === null) {
      context.addIssue({
        code: "custom",
        message: "Available model route requires a selected Analysis Configuration",
      });
    }
    if (
      value.readiness === "blocked" &&
      (value.blockers.length === 0 || value.preparationDigest !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Blocked Review preparation requires blockers and no digest",
      });
    }
  });

export const StartReviewWorkflowCommandSchema = z.strictObject({
  preparationDigest: RequestDigestSchema,
});

export const ReviewWorkflowSchema = z.strictObject({
  id: KestrelIdSchema,
  projectId: KestrelIdSchema,
  changeProposalId: KestrelIdSchema,
  reviewRevisionId: KestrelIdSchema,
  changeIntentId: KestrelIdSchema,
  inputDigest: RequestDigestSchema,
  analysisConfiguration: ReviewAnalysisConfigurationSchema,
  authority: ReviewAuthoritySchema,
  resourceEnvelope: ReviewResourceEnvelopeSchema,
  state: z.literal("queued"),
  requestedAt: UtcDateTimeSchema,
});

export const ReviewWorkflowAcceptedSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  workflow: ReviewWorkflowSchema,
});

export const ReviewRevisionAvailableSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    project: ProjectSchema,
    localRepositorySource: LocalRepositorySourceSchema,
    changeProposal: ChangeProposalSchema,
    acquisitionChangeIntent: ChangeIntentSchema,
    reviewRevision: ReviewRevisionSchema,
  })
  .superRefine((value, context) => {
    if (value.reviewRevision.state !== "available") {
      context.addIssue({
        code: "custom",
        message: "Only an available Review Revision may be published",
        path: ["reviewRevision", "state"],
      });
    }
    if (value.project.localRepositorySource?.id !== value.localRepositorySource.id) {
      context.addIssue({
        code: "custom",
        message: "Local Repository Source is not attached to Project",
      });
    }
    const proposal = value.project.changeProposals.find(({ id }) => id === value.changeProposal.id);
    if (proposal === undefined) {
      context.addIssue({ code: "custom", message: "Change Proposal is not attached to Project" });
    } else {
      if (!proposal.reviewRevisions.some(({ id }) => id === value.reviewRevision.id)) {
        context.addIssue({
          code: "custom",
          message: "Review Revision is not attached to Change Proposal",
        });
      }
    }
  });

export const OperatorSchema = z.strictObject({
  id: KestrelIdSchema,
  username: OperatorUsernameSchema,
});

export const LoginCommandSchema = z.strictObject({
  username: OperatorUsernameSchema,
  password: z.string().min(1).max(128),
});

export const NewOperatorPasswordSchema = z.string().min(12).max(128);

export const SessionSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  operator: OperatorSchema,
  credentialVersion: CredentialVersionSchema,
  issuedAt: UtcDateTimeSchema,
  expiresAt: UtcDateTimeSchema,
});

export const StepUpActionSchema = z.enum([
  "operator_credentials_change",
  "provider_connect",
  "provider_disconnect",
  "provider_replace",
  "model_credentials_change",
  "project_delete",
  "installation_update",
]);

export const StepUpProofTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export const StepUpCommandSchema = z.strictObject({
  action: StepUpActionSchema,
  password: z.string().min(1).max(128),
  requestDigest: RequestDigestSchema,
  targetId: KestrelIdSchema,
});

export const StepUpProofSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  expiresAt: UtcDateTimeSchema,
  proof: StepUpProofTokenSchema,
});

export const CredentialChangeCommandSchema = z.strictObject({
  expectedVersion: CredentialVersionSchema,
  newPassword: NewOperatorPasswordSchema,
  username: OperatorUsernameSchema,
});

export const LogoutCommandSchema = z.strictObject({});

const DirectApiIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const DirectApiRegionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/u);
const DirectApiUsdAmountSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,6})?$/u);
const HttpsUrlSchema = z.url().refine((value) => value.startsWith("https://"), {
  message: "Only HTTPS evidence references are accepted",
});
const DirectApiRegionsSchema = z
  .array(DirectApiRegionSchema)
  .min(1)
  .max(16)
  .refine((regions) => new Set(regions).size === regions.length, {
    message: "Regions must be unique",
  });

export const DirectApiDataPolicySchema = z
  .strictObject({
    abuseMonitoring: z.enum(["standard", "modified", "zero_data_retention"]),
    attestedAt: UtcDateTimeSchema,
    evidenceUrl: HttpsUrlSchema,
    expiresAt: UtcDateTimeSchema,
    humanReview: z.enum(["possible", "restricted", "none_attested"]),
    processingRegions: DirectApiRegionsSchema,
    storageRegions: DirectApiRegionsSchema,
    trainingUse: z.enum(["not_used_without_opt_in", "provider_may_train"]),
  })
  .refine(({ attestedAt, expiresAt }) => expiresAt > attestedAt, {
    message: "Data-policy attestation expiry must follow its observation",
    path: ["expiresAt"],
  });

export const DirectApiLimitsSchema = z.strictObject({
  maximumAttempts: z.literal(1),
  maximumConcurrentRequests: z.number().int().min(1).max(16),
  maximumCostUsd: DirectApiUsdAmountSchema,
  maximumInputTokens: z.number().int().min(1).max(2_000_000),
  maximumOutputTokens: z.number().int().min(16).max(100_000),
  maximumRequestBytes: z
    .number()
    .int()
    .min(1_024)
    .max(64 * 1_024 * 1_024),
  requestTimeoutMilliseconds: z.number().int().min(1_000).max(120_000),
});

export const DirectApiModelTargetSchema = z
  .strictObject({
    expectedResolvedId: DirectApiIdentifierSchema,
    requestedId: DirectApiIdentifierSchema,
    versionPolicy: z.literal("pinned"),
  })
  .refine(({ expectedResolvedId, requestedId }) => expectedResolvedId === requestedId, {
    message: "A pinned Direct API target must resolve to the requested model",
    path: ["expectedResolvedId"],
  });

export const DirectApiPriceSnapshotSchema = z
  .strictObject({
    cachedInputPerMillionTokensUsd: DirectApiUsdAmountSchema.nullable(),
    capturedAt: UtcDateTimeSchema,
    currency: z.literal("USD"),
    effectiveAt: UtcDateTimeSchema,
    inputPerMillionTokensUsd: DirectApiUsdAmountSchema,
    outputPerMillionTokensUsd: DirectApiUsdAmountSchema,
    sourceUrl: HttpsUrlSchema,
  })
  .refine(({ capturedAt, effectiveAt }) => capturedAt >= effectiveAt, {
    message: "A price snapshot cannot be captured before it becomes effective",
    path: ["capturedAt"],
  });

export const ConfigureDirectApiProfileCommandSchema = z.strictObject({
  apiKey: z
    .string()
    .min(20)
    .max(512)
    .regex(/^[A-Za-z0-9._-]+$/u),
  dataPolicy: DirectApiDataPolicySchema,
  displayName: z.string().trim().min(1).max(256),
  limits: DirectApiLimitsSchema,
  model: DirectApiModelTargetSchema,
  openAiProjectId: DirectApiIdentifierSchema,
  organizationId: DirectApiIdentifierSchema,
  priceSnapshot: DirectApiPriceSnapshotSchema,
});

export const DirectApiProfileAvailabilityReasonSchema = z.enum([
  "attestation_expired",
  "credential_unavailable",
  "identity_drift",
  "provider_unavailable",
  "synthetic_test_expired",
  "synthetic_test_failed",
]);

export const DirectApiEffectiveIdentitySchema = z.strictObject({
  apiSurface: z.literal("responses"),
  apiVersion: z.literal("2020-10-01"),
  endpointOrigin: z.literal("https://api.openai.com"),
  endpointPath: z.literal("/v1/responses"),
  model: DirectApiModelTargetSchema,
  openAiProjectId: DirectApiIdentifierSchema,
  organizationId: DirectApiIdentifierSchema,
  provider: z.literal("openai"),
});

export const DirectApiExecutionPolicySchema = z.strictObject({
  arbitraryOptions: z.literal("disabled"),
  callbacks: z.literal("disabled"),
  files: z.literal("disabled"),
  inputModality: z.literal("text"),
  privilegedInstructions: z.literal("developer"),
  retrieval: z.literal("disabled"),
  statefulness: z.literal("stateless"),
  structuredOutput: z.literal("json_schema_strict"),
  tools: z.literal("disabled"),
  urls: z.literal("disabled"),
});

export const DirectApiSyntheticTestSchema = z.strictObject({
  observedApiVersion: z.literal("2020-10-01"),
  observedModel: DirectApiIdentifierSchema,
  observedOrganizationId: DirectApiIdentifierSchema,
  passedAt: UtcDateTimeSchema,
  requestId: DirectApiIdentifierSchema,
});

export const DirectApiProfileSchema = z
  .strictObject({
    id: KestrelIdSchema,
    projectId: KestrelIdSchema,
    availability: z.enum(["available", "stale", "unavailable"]),
    availabilityReasons: z.array(DirectApiProfileAvailabilityReasonSchema).max(6),
    displayName: z.string().trim().min(1).max(256),
    effectiveIdentity: DirectApiEffectiveIdentitySchema,
    executionPolicy: DirectApiExecutionPolicySchema,
    dataPolicy: DirectApiDataPolicySchema,
    limits: DirectApiLimitsSchema,
    priceSnapshot: DirectApiPriceSnapshotSchema,
    profileDigest: RequestDigestSchema,
    lastTest: DirectApiSyntheticTestSchema,
    createdAt: UtcDateTimeSchema,
    updatedAt: UtcDateTimeSchema,
  })
  .superRefine(({ availability, availabilityReasons, createdAt, lastTest, updatedAt }, context) => {
    if ((availability === "available") !== (availabilityReasons.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Only an available Direct API profile may omit availability reasons",
        path: ["availabilityReasons"],
      });
    }
    if (updatedAt < createdAt || updatedAt < lastTest.passedAt) {
      context.addIssue({
        code: "custom",
        message: "Direct API profile timestamps are inconsistent",
        path: ["updatedAt"],
      });
    }
  });

export const DirectApiProfileResponseSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  profile: DirectApiProfileSchema.nullable(),
});

export function serializeCredentialChangeCommand(command: CredentialChangeCommand): string {
  const validated = CredentialChangeCommandSchema.parse(command);
  return JSON.stringify({
    expectedVersion: validated.expectedVersion,
    newPassword: validated.newPassword,
    username: validated.username,
  });
}

export function serializeConfigureDirectApiProfileCommand(
  command: ConfigureDirectApiProfileCommand,
): string {
  return JSON.stringify(ConfigureDirectApiProfileCommandSchema.parse(command));
}

export const InstallationStateSchema = z.enum([
  "ready",
  "diagnostic_queued",
  "diagnostic_running",
  "diagnostic_succeeded",
]);

export const DiagnosticStatusSchema = z.enum(["queued", "running", "succeeded"]);

export const InstallationSchema = z.strictObject({
  id: KestrelIdSchema,
  state: InstallationStateSchema,
  currentDiagnosticId: KestrelIdSchema.nullable(),
  revision: EventCursorSchema,
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
});

export const DiagnosticSchema = z.strictObject({
  id: KestrelIdSchema,
  status: DiagnosticStatusSchema,
  requestedAt: UtcDateTimeSchema,
  startedAt: UtcDateTimeSchema.nullable(),
  completedAt: UtcDateTimeSchema.nullable(),
});

export const InstallationSnapshotSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  installation: InstallationSchema,
  diagnostic: DiagnosticSchema.nullable(),
  eventCursor: EventCursorSchema,
});

export const DiagnosticCommandSchema = z.strictObject({});

export const DiagnosticAcceptedSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  installation: InstallationSchema,
  diagnostic: DiagnosticSchema,
  eventCursor: EventCursorSchema,
});

export const InstallationEventTypeSchema = z.enum([
  "installation.diagnostic.queued",
  "installation.diagnostic.running",
  "installation.diagnostic.succeeded",
]);

export const InstallationEventSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  eventId: EventCursorSchema,
  aggregateType: z.literal("installation"),
  aggregateId: KestrelIdSchema,
  aggregateVersion: EventCursorSchema,
  eventType: InstallationEventTypeSchema,
  occurredAt: UtcDateTimeSchema,
  correlationId: CorrelationIdSchema,
  causationId: CorrelationIdSchema.nullable(),
  locator: z.strictObject({
    installationId: KestrelIdSchema,
    diagnosticId: KestrelIdSchema,
  }),
});

const StandardApiErrorSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  code: z.enum([
    "INVALID_REQUEST",
    "AUTHENTICATION_FAILED",
    "AUTHENTICATION_REQUIRED",
    "RATE_LIMITED",
    "PAYLOAD_TOO_LARGE",
    "UNSUPPORTED_MEDIA_TYPE",
    "REQUEST_REJECTED",
    "NOT_FOUND",
    "INSTALLATION_TRANSITION_CONFLICT",
    "OPERATOR_VERSION_CONFLICT",
    "SERVICE_UNAVAILABLE",
    "INTERNAL_ERROR",
    "REPOSITORY_NOT_AVAILABLE",
    "REFERENCE_NOT_AVAILABLE",
    "BASE_REVISION_UNRESOLVABLE",
    "HEAD_REVISION_UNRESOLVABLE",
    "PULL_REF_MISMATCH",
    "PROVIDER_AUTHENTICATION_REQUIRED",
    "PROVIDER_RESOURCE_UNAVAILABLE",
    "SOURCE_CONTAINMENT_VIOLATION",
    "REVISION_LIMIT_EXCEEDED",
    "OBJECT_MISSING",
    "OBJECT_VERIFICATION_FAILED",
    "CHANGE_PROPOSAL_MISMATCH",
    "CHANGE_PROPOSAL_VERSION_CONFLICT",
    "CHANGE_INTENT_SOURCE_CONFLICT",
    "REVISION_ACQUIRING",
    "REVIEW_NOT_READY",
    "REVIEW_PREPARATION_CONFLICT",
  ]),
  message: z.string().min(1),
  correlationId: CorrelationIdSchema,
});

const ExpiredCursorApiErrorSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  code: z.literal("EVENT_CURSOR_EXPIRED"),
  message: z.string().min(1),
  correlationId: CorrelationIdSchema,
  firstAvailableEventId: EventCursorSchema,
  refetch: z.literal("/api/v1/installation"),
});

export const ApiErrorSchema = z.discriminatedUnion("code", [
  StandardApiErrorSchema,
  ExpiredCursorApiErrorSchema,
]);

export const HealthStatusSchema = z.strictObject({
  status: z.enum(["live", "ready"]),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ConfigureDirectApiProfileCommand = z.infer<
  typeof ConfigureDirectApiProfileCommandSchema
>;
export type DirectApiDataPolicy = z.infer<typeof DirectApiDataPolicySchema>;
export type DirectApiEffectiveIdentity = z.infer<typeof DirectApiEffectiveIdentitySchema>;
export type DirectApiExecutionPolicy = z.infer<typeof DirectApiExecutionPolicySchema>;
export type DirectApiLimits = z.infer<typeof DirectApiLimitsSchema>;
export type DirectApiModelTarget = z.infer<typeof DirectApiModelTargetSchema>;
export type DirectApiPriceSnapshot = z.infer<typeof DirectApiPriceSnapshotSchema>;
export type DirectApiProfile = z.infer<typeof DirectApiProfileSchema>;
export type DirectApiProfileAvailabilityReason = z.infer<
  typeof DirectApiProfileAvailabilityReasonSchema
>;
export type DirectApiProfileResponse = z.infer<typeof DirectApiProfileResponseSchema>;
export type DirectApiSyntheticTest = z.infer<typeof DirectApiSyntheticTestSchema>;
export type CredentialChangeCommand = z.infer<typeof CredentialChangeCommandSchema>;
export type CredentialVersion = z.infer<typeof CredentialVersionSchema>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type DiagnosticAccepted = z.infer<typeof DiagnosticAcceptedSchema>;
export type DiagnosticCommand = z.infer<typeof DiagnosticCommandSchema>;
export type EventCursor = z.infer<typeof EventCursorSchema>;
export type Installation = z.infer<typeof InstallationSchema>;
export type InstallationEvent = z.infer<typeof InstallationEventSchema>;
export type InstallationEventType = z.infer<typeof InstallationEventTypeSchema>;
export type InstallationSnapshot = z.infer<typeof InstallationSnapshotSchema>;
export type InstallationState = z.infer<typeof InstallationStateSchema>;
export type ChangeIntent = z.infer<typeof ChangeIntentSchema>;
export type ChangeIntentSource = z.infer<typeof ChangeIntentSourceSchema>;
export type ChangeIntentVersionCreated = z.infer<typeof ChangeIntentVersionCreatedSchema>;
export type CreateChangeIntentVersionCommand = z.infer<
  typeof CreateChangeIntentVersionCommandSchema
>;
export type ChangeProposal = z.infer<typeof ChangeProposalSchema>;
export type LoginCommand = z.infer<typeof LoginCommandSchema>;
export type LocalRepositoryInventory = z.infer<typeof LocalRepositoryInventorySchema>;
export type LocalRepositoryInventoryItem = z.infer<typeof LocalRepositoryInventoryItemSchema>;
export type LocalRepositoryReference = z.infer<typeof LocalRepositoryReferenceSchema>;
export type LocalRepositoryReferences = z.infer<typeof LocalRepositoryReferencesSchema>;
export type LocalRepositorySource = z.infer<typeof LocalRepositorySourceSchema>;
export type HostGitHubProjectInbox = z.infer<typeof HostGitHubProjectInboxSchema>;
export type HostGitHubPullRequestSummary = z.infer<typeof HostGitHubPullRequestSummarySchema>;
export type HostGitHubStatus = z.infer<typeof HostGitHubStatusSchema>;
export type ObserveHostGitHubPullRequestCommand = z.infer<
  typeof ObserveHostGitHubPullRequestCommandSchema
>;
export type OpenPublicGitHubPullRequestCommand = z.infer<
  typeof OpenPublicGitHubPullRequestCommandSchema
>;
export type RetainLocalReviewRevisionCommand = z.infer<
  typeof RetainLocalReviewRevisionCommandSchema
>;
export type RetainObservedReviewRevisionCommand = z.infer<
  typeof RetainObservedReviewRevisionCommandSchema
>;
export type RetainReviewRevisionCommand = z.infer<typeof RetainReviewRevisionCommandSchema>;
export type NewOperatorPassword = z.infer<typeof NewOperatorPasswordSchema>;
export type LogoutCommand = z.infer<typeof LogoutCommandSchema>;
export type Operator = z.infer<typeof OperatorSchema>;
export type OperatorUsername = z.infer<typeof OperatorUsernameSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectInbox = z.infer<typeof ProjectInboxSchema>;
export type ProjectUpserted = z.infer<typeof ProjectUpsertedSchema>;
export type ProviderObservedChangeProposal = z.infer<typeof ProviderObservedChangeProposalSchema>;
export type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>;
export type ReviewRevision = z.infer<typeof ReviewRevisionSchema>;
export type ReviewRevisionAvailable = z.infer<typeof ReviewRevisionAvailableSchema>;
export type ReviewRevisionFailureReason = z.infer<typeof ReviewRevisionFailureReasonSchema>;
export type ReviewAnalysisConfiguration = z.infer<typeof ReviewAnalysisConfigurationSchema>;
export type ReviewAuthority = z.infer<typeof ReviewAuthoritySchema>;
export type ReviewModelRouteAvailability = z.infer<typeof ReviewModelRouteAvailabilitySchema>;
export type ReviewPreparation = z.infer<typeof ReviewPreparationSchema>;
export type ReviewPreparationBlocker = z.infer<typeof ReviewPreparationBlockerSchema>;
export type ReviewProviderObservation = z.infer<typeof ReviewProviderObservationSchema>;
export type ReviewResourceEnvelope = z.infer<typeof ReviewResourceEnvelopeSchema>;
export type ReviewWorkflow = z.infer<typeof ReviewWorkflowSchema>;
export type ReviewWorkflowAccepted = z.infer<typeof ReviewWorkflowAcceptedSchema>;
export type StartReviewWorkflowCommand = z.infer<typeof StartReviewWorkflowCommandSchema>;
export type PublicGitHubPullRequestUrl = z.infer<typeof PublicGitHubPullRequestUrlSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type StepUpAction = z.infer<typeof StepUpActionSchema>;
export type StepUpCommand = z.infer<typeof StepUpCommandSchema>;
export type StepUpProof = z.infer<typeof StepUpProofSchema>;
export type StepUpProofToken = z.infer<typeof StepUpProofTokenSchema>;
