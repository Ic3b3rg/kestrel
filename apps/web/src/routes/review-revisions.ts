import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  ApiErrorSchema,
  RetainReviewRevisionCommandSchema,
  ReviewRevisionAvailableSchema,
  apiErrorJsonSchema,
  jsonSchemaForEmbedding,
  retainReviewRevisionCommandJsonSchema,
  reviewRevisionAvailableJsonSchema,
  type ApiError,
  type Project,
  type RetainObservedReviewRevisionCommand,
  type RetainReviewRevisionCommand,
  type ReviewRevisionAvailable,
  type ReviewRevisionFailureReason,
} from "@kestrel/contracts";
import {
  ReviewRevisionPersistenceError,
  completeReviewRevision,
  failReviewRevision,
  readProject,
  withArtifactAcquisitionLock,
  withReviewRevisionAcquisitionLease,
  type DatabasePool,
} from "@kestrel/database";
import { LocalSourceError, type LocalSourceErrorCode } from "@kestrel/local-source";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import type {
  LocalReviewRevisionSourceService,
  ObservedReviewRevisionSelection,
  PreparedReviewRevision,
} from "./local-repository-sources.js";

export interface ReviewRevisionServiceContext {
  actorId: string;
  correlationId: string;
  signal?: AbortSignal | undefined;
}

export interface ReviewRevisionServiceResult {
  created: boolean;
  value: ReviewRevisionAvailable;
}

export interface ReviewRevisionService {
  retain(
    command: RetainReviewRevisionCommand,
    context: ReviewRevisionServiceContext,
  ): Promise<ReviewRevisionServiceResult>;
}

export type ReviewRevisionRouteErrorCode =
  LocalSourceErrorCode | "change_proposal_mismatch" | "revision_acquiring";

interface ReviewRevisionLogMetadata {
  objectCount?: number | undefined;
  projectId?: string | undefined;
  retainedBytes?: number | undefined;
  revisionId?: string | undefined;
  revisionState: "acquiring" | "available" | "unavailable" | "unknown";
}

export class ReviewRevisionRouteError extends Error {
  constructor(
    public readonly code: ReviewRevisionRouteErrorCode,
    public readonly metadata: ReviewRevisionLogMetadata = { revisionState: "unknown" },
  ) {
    super(`Review Revision request failed: ${code}`);
    this.name = "ReviewRevisionRouteError";
  }
}

class ObservedReviewRevisionError extends Error {
  constructor(
    public readonly metadata: ReviewRevisionLogMetadata,
    cause: unknown,
  ) {
    super("Review Revision acquisition failed after reservation", { cause });
    this.name = "ObservedReviewRevisionError";
  }
}

function reviewRevisionLogMetadata(error: unknown): ReviewRevisionLogMetadata {
  return error instanceof ReviewRevisionRouteError || error instanceof ObservedReviewRevisionError
    ? error.metadata
    : { revisionState: "unknown" };
}

const REVIEW_REVISION_ROUTE_ERROR_CODES = new Set<ReviewRevisionRouteErrorCode>([
  "acquisition_cancelled",
  "configuration_invalid",
  "discovery_limit_exceeded",
  "git_inspection_failed",
  "object_missing",
  "object_verification_failed",
  "path_not_retained",
  "reference_limit_exceeded",
  "reference_not_available",
  "repository_invalid",
  "repository_not_available",
  "revision_limit_exceeded",
  "source_containment_violation",
  "change_proposal_mismatch",
  "revision_acquiring",
]);

function routeErrorCode(error: unknown): ReviewRevisionRouteErrorCode | null {
  if (error instanceof ReviewRevisionRouteError) return error.code;
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  ) {
    return null;
  }
  return REVIEW_REVISION_ROUTE_ERROR_CODES.has(error.code as ReviewRevisionRouteErrorCode)
    ? (error.code as ReviewRevisionRouteErrorCode)
    : null;
}

function persistenceFailure(error: unknown): ReviewRevisionRouteError | null {
  if (!(error instanceof ReviewRevisionPersistenceError)) {
    return null;
  }
  if (error.code === "change_proposal_mismatch") {
    return new ReviewRevisionRouteError("change_proposal_mismatch");
  }
  if (error.code === "revision_limit_exceeded") {
    return new ReviewRevisionRouteError("revision_limit_exceeded");
  }
  return null;
}

function artifactFailureReason(error: unknown): ReviewRevisionFailureReason {
  if (!(error instanceof LocalSourceError)) {
    return "artifact_finalization_failed";
  }
  switch (error.code) {
    case "acquisition_cancelled":
      return "acquisition_interrupted";
    case "repository_not_available":
      return "source_not_available";
    case "source_containment_violation":
    case "repository_invalid":
      return "source_containment_violation";
    case "reference_not_available":
      return "reference_not_available";
    case "discovery_limit_exceeded":
    case "reference_limit_exceeded":
    case "revision_limit_exceeded":
      return "revision_limit_exceeded";
    case "object_missing":
      return "object_missing";
    case "object_verification_failed":
      return "object_verification_failed";
    default:
      return "artifact_finalization_failed";
  }
}

function observedSelectionMismatch(): never {
  throw new ReviewRevisionRouteError("change_proposal_mismatch");
}

export function resolveObservedReviewRevisionSelection(
  project: Project,
  command: RetainObservedReviewRevisionCommand,
): ObservedReviewRevisionSelection {
  const repository = project.repository;
  const localSource = project.localRepositorySource;
  const proposal = project.changeProposals.find(({ id }) => id === command.changeProposalId);
  if (
    project.id !== command.projectId ||
    repository === null ||
    project.providerObservation === null ||
    localSource === null ||
    localSource.state !== "attached" ||
    proposal?.kind !== "provider_observed"
  ) {
    return observedSelectionMismatch();
  }
  const repositoryUrl = `https://github.com/${repository.owner}/${repository.name}`;
  const proposalUrl = `${repositoryUrl}/pull/${String(proposal.number)}`;
  const objectIdPattern =
    localSource.objectFormat === "sha1" ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u;
  if (
    repository.canonicalUrl.toLocaleLowerCase("en-US") !==
      repositoryUrl.toLocaleLowerCase("en-US") ||
    proposal.canonicalUrl.toLocaleLowerCase("en-US") !== proposalUrl.toLocaleLowerCase("en-US") ||
    !objectIdPattern.test(proposal.base.objectId) ||
    !objectIdPattern.test(proposal.head.objectId)
  ) {
    return observedSelectionMismatch();
  }
  return {
    base: proposal.base,
    head: proposal.head,
    objectFormat: localSource.objectFormat,
    projectId: project.id,
    pullRequestNumber: proposal.number,
    repository: { name: repository.name, owner: repository.owner },
    repositoryId: localSource.repositoryId,
  };
}

export function buildReviewRevisionResponse(
  project: Awaited<ReturnType<typeof readProject>>,
  proposalId: string,
  acquisitionChangeIntent: ReviewRevisionAvailable["acquisitionChangeIntent"],
  reviewRevision: ReviewRevisionAvailable["reviewRevision"],
): ReviewRevisionAvailable {
  const localRepositorySource = project.localRepositorySource;
  const changeProposal =
    project.changeProposals.find(({ id }) => id === proposalId) ??
    project.changeProposals.find(({ reviewRevisions }) =>
      reviewRevisions.some(({ id }) => id === reviewRevision.id),
    );
  if (localRepositorySource == null || changeProposal === undefined) {
    throw new Error("Review Revision response association is unavailable");
  }
  return ReviewRevisionAvailableSchema.parse({
    schemaVersion: 1,
    project,
    localRepositorySource,
    changeProposal,
    acquisitionChangeIntent,
    reviewRevision,
  });
}

export async function recoverCompletionFailure(
  recordUnavailable: (beforeUnavailable: () => Promise<void>) => Promise<void>,
  quarantine: () => Promise<void>,
): Promise<void> {
  try {
    await recordUnavailable(quarantine);
  } catch {
    return;
  }
}

async function recordReviewRevisionFailure(
  primaryPool: DatabasePool,
  fallbackPool: DatabasePool,
  input: Parameters<typeof failReviewRevision>[1],
  beforeUnavailable?: () => Promise<void>,
): Promise<void> {
  try {
    await failReviewRevision(primaryPool, input, beforeUnavailable);
  } catch {
    await failReviewRevision(fallbackPool, input, beforeUnavailable);
  }
}

export function createReviewRevisionService(
  pool: DatabasePool,
  source: LocalReviewRevisionSourceService,
): ReviewRevisionService {
  return {
    async retain(command, context) {
      let prepared: PreparedReviewRevision;
      try {
        if ("repositoryId" in command) {
          prepared = await source.prepare(command);
        } else {
          const project = await readProject(pool, command.projectId);
          prepared = await source.prepareObserved(
            resolveObservedReviewRevisionSelection(project, command),
            context.signal,
          );
        }
      } catch (error) {
        if (error instanceof LocalSourceError) {
          throw new ReviewRevisionRouteError(error.code);
        }
        throw error;
      }
      try {
        return await withReviewRevisionAcquisitionLease(
          pool,
          {
            actorId: context.actorId,
            base: prepared.selected.base,
            changeIntent: command.changeIntent,
            ...(prepared.acquisition.kind === "github_pull_request"
              ? { expectedProjectId: prepared.acquisition.expectedProjectId }
              : {}),
            ...(command.changeProposalId === undefined
              ? {}
              : { changeProposalId: command.changeProposalId }),
            correlationId: context.correlationId,
            head: prepared.selected.head,
            maxBytes: prepared.maxBytes,
            maxObjects: prepared.maxObjects,
            source: prepared.source,
          },
          async (begun, leasedPool) => {
            if (begun.outcome === "acquiring") {
              throw new ReviewRevisionRouteError("revision_acquiring", {
                projectId: begun.projectId,
                revisionId: begun.revision.id,
                revisionState: "acquiring",
              });
            }
            if (begun.outcome === "already_available") {
              try {
                const project = await readProject(leasedPool, begun.projectId, begun.revision.id);
                return {
                  created: false,
                  value: buildReviewRevisionResponse(
                    project,
                    begun.changeProposalId,
                    begun.changeIntent,
                    begun.revision,
                  ),
                };
              } catch (error) {
                throw new ObservedReviewRevisionError(
                  {
                    objectCount: begun.revision.objectCount ?? undefined,
                    projectId: begun.projectId,
                    retainedBytes: begun.revision.retainedBytes ?? undefined,
                    revisionId: begun.revision.id,
                    revisionState: "available",
                  },
                  error,
                );
              }
            }

            return withArtifactAcquisitionLock(leasedPool, async (lockedPool) => {
              const acquisition: PreparedReviewRevision = {
                ...prepared,
                maxBytes: begun.maxBytes,
                maxObjects: begun.maxObjects,
                selected: {
                  ...prepared.selected,
                  base: begun.revision.base,
                  head: begun.revision.head,
                  objectFormat: begun.revision.objectFormat,
                },
              };
              let artifact: Awaited<ReturnType<LocalReviewRevisionSourceService["retain"]>>;
              try {
                artifact = await source.retain({
                  prepared: acquisition,
                  projectId: begun.artifactProjectId,
                  revisionId: begun.revision.id,
                  ...(context.signal === undefined ? {} : { signal: context.signal }),
                });
              } catch (error) {
                await recordReviewRevisionFailure(lockedPool, pool, {
                  actorId: context.actorId,
                  correlationId: context.correlationId,
                  failureReason: artifactFailureReason(error),
                  revisionId: begun.revision.id,
                });
                if (error instanceof LocalSourceError) {
                  throw new ReviewRevisionRouteError(error.code, {
                    projectId: begun.projectId,
                    revisionId: begun.revision.id,
                    revisionState: "unavailable",
                  });
                }
                throw new ObservedReviewRevisionError(
                  {
                    projectId: begun.projectId,
                    revisionId: begun.revision.id,
                    revisionState: "unavailable",
                  },
                  error,
                );
              }
              let revision;
              try {
                revision = await completeReviewRevision(lockedPool, {
                  actorId: context.actorId,
                  artifact,
                  base: begun.revision.base,
                  correlationId: context.correlationId,
                  head: begun.revision.head,
                  objectFormat: begun.revision.objectFormat,
                  projectId: begun.artifactProjectId,
                  revisionId: begun.revision.id,
                });
              } catch (error) {
                await recoverCompletionFailure(
                  async (beforeUnavailable) => {
                    await recordReviewRevisionFailure(
                      lockedPool,
                      pool,
                      {
                        actorId: context.actorId,
                        correlationId: context.correlationId,
                        failureReason: "artifact_finalization_failed",
                        revisionId: begun.revision.id,
                      },
                      beforeUnavailable,
                    );
                  },
                  async () => source.quarantine(artifact.artifactLocator),
                );
                throw new ObservedReviewRevisionError(
                  {
                    objectCount: artifact.objectCount,
                    projectId: begun.projectId,
                    retainedBytes: artifact.retainedBytes,
                    revisionId: begun.revision.id,
                    revisionState: "unknown",
                  },
                  error,
                );
              }
              try {
                const project = await readProject(lockedPool, begun.projectId, revision.id);
                return {
                  created: true,
                  value: buildReviewRevisionResponse(
                    project,
                    begun.changeProposalId,
                    begun.changeIntent,
                    revision,
                  ),
                };
              } catch (error) {
                throw new ObservedReviewRevisionError(
                  {
                    objectCount: revision.objectCount ?? undefined,
                    projectId: begun.projectId,
                    retainedBytes: revision.retainedBytes ?? undefined,
                    revisionId: revision.id,
                    revisionState: "available",
                  },
                  error,
                );
              }
            });
          },
        );
      } catch (error) {
        throw persistenceFailure(error) ?? error;
      }
    },
  };
}

function responseError(request: FastifyRequest, code: ApiError["code"], message: string) {
  return ApiErrorSchema.parse({ schemaVersion: 1, code, message, correlationId: request.id });
}

function sendExpectedError(
  code: ReviewRevisionRouteErrorCode,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  switch (code) {
    case "repository_not_available":
      return reply
        .code(404)
        .send(responseError(request, "REPOSITORY_NOT_AVAILABLE", "The repository is unavailable"));
    case "reference_not_available":
      return reply
        .code(404)
        .send(responseError(request, "REFERENCE_NOT_AVAILABLE", "The reference is unavailable"));
    case "object_missing":
      return reply
        .code(404)
        .send(
          responseError(request, "OBJECT_MISSING", "A required committed object is unavailable"),
        );
    case "source_containment_violation":
    case "repository_invalid":
      return reply
        .code(422)
        .send(
          responseError(
            request,
            "SOURCE_CONTAINMENT_VIOLATION",
            "The source failed containment validation",
          ),
        );
    case "object_verification_failed":
      return reply
        .code(422)
        .send(
          responseError(
            request,
            "OBJECT_VERIFICATION_FAILED",
            "A committed object failed verification",
          ),
        );
    case "revision_limit_exceeded":
    case "reference_limit_exceeded":
    case "discovery_limit_exceeded":
      return reply
        .code(413)
        .send(
          responseError(
            request,
            "REVISION_LIMIT_EXCEEDED",
            "The configured Review Revision limit was exceeded",
          ),
        );
    case "change_proposal_mismatch":
      return reply
        .code(409)
        .send(
          responseError(
            request,
            "CHANGE_PROPOSAL_MISMATCH",
            "The selected Change Proposal does not match the exact revision",
          ),
        );
    case "revision_acquiring":
      return reply
        .code(409)
        .send(
          responseError(
            request,
            "REVISION_ACQUIRING",
            "The exact Review Revision is already acquiring",
          ),
        );
    default:
      return reply
        .code(503)
        .send(
          responseError(
            request,
            "SERVICE_UNAVAILABLE",
            "Review Revision acquisition is unavailable",
          ),
        );
  }
}

async function withRequestCancellation<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  try {
    return await task(controller.signal);
  } finally {
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
  }
}

export function registerReviewRevisionRoutes(
  app: FastifyInstance,
  service: ReviewRevisionService,
): void {
  app.post(
    "/api/v1/review-revisions",
    {
      bodyLimit: 128 * 1024,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        body: jsonSchemaForEmbedding(retainReviewRevisionCommandJsonSchema),
        response: {
          200: jsonSchemaForEmbedding(reviewRevisionAvailableJsonSchema),
          201: jsonSchemaForEmbedding(reviewRevisionAvailableJsonSchema),
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          403: jsonSchemaForEmbedding(apiErrorJsonSchema),
          404: jsonSchemaForEmbedding(apiErrorJsonSchema),
          409: jsonSchemaForEmbedding(apiErrorJsonSchema),
          413: jsonSchemaForEmbedding(apiErrorJsonSchema),
          415: jsonSchemaForEmbedding(apiErrorJsonSchema),
          422: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      const startedAt = performance.now();
      const durationMs = () =>
        Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000);
      const parsedCommand = RetainReviewRevisionCommandSchema.safeParse(request.body);
      if (!parsedCommand.success) {
        return reply
          .code(400)
          .send(responseError(request, "INVALID_REQUEST", "The request body is invalid"));
      }
      const command = parsedCommand.data;
      const session = request.operatorSession;
      if (session === null) {
        throw new Error("Authenticated Review Revision route has no Operator session");
      }
      try {
        const result = await withRequestCancellation(request, reply, (signal) =>
          service.retain(command, {
            actorId: session.operator.id,
            correlationId: request.id,
            signal,
          }),
        );
        request.log.info({
          correlationId: request.id,
          created: result.created,
          durationMs: durationMs(),
          event: "review_revision.available",
          objectCount: result.value.reviewRevision.objectCount,
          projectId: result.value.project.id,
          retainedBytes: result.value.reviewRevision.retainedBytes,
          revisionId: result.value.reviewRevision.id,
          revisionState: "available",
        });
        return await reply.code(result.created ? 201 : 200).send(result.value);
      } catch (error) {
        const code = routeErrorCode(error);
        const metadata = reviewRevisionLogMetadata(error);
        if (code !== null) {
          request.log.warn({
            correlationId: request.id,
            durationMs: durationMs(),
            event: "review_revision.expected_failure",
            kind: code,
            objectCount: metadata.objectCount ?? null,
            projectId: metadata.projectId ?? null,
            retainedBytes: metadata.retainedBytes ?? null,
            revisionId: metadata.revisionId ?? null,
            revisionState: metadata.revisionState,
          });
          return sendExpectedError(code, request, reply);
        }
        request.log.error({
          correlationId: request.id,
          errorCode:
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string" &&
            /^[A-Z0-9_]{1,64}$/u.test(error.code)
              ? error.code
              : "UNCLASSIFIED",
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorSummary:
            error instanceof Error &&
            /^permission denied for (?:table|function|sequence) [a-z_]+$/u.test(error.message)
              ? error.message
              : "UNAVAILABLE",
          durationMs: durationMs(),
          event: "review_revision.acquisition_failed",
          objectCount: metadata.objectCount ?? null,
          projectId: metadata.projectId ?? null,
          retainedBytes: metadata.retainedBytes ?? null,
          revisionId: metadata.revisionId ?? null,
          revisionState: metadata.revisionState,
        });
        return reply
          .code(503)
          .send(
            responseError(
              request,
              "SERVICE_UNAVAILABLE",
              "Review Revision acquisition is unavailable",
            ),
          );
      }
    },
  );
}
