import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  ApiErrorSchema,
  KestrelIdSchema,
  LocalRepositoryInventorySchema,
  LocalRepositoryReferencesSchema,
  apiErrorJsonSchema,
  jsonSchemaForEmbedding,
  localRepositoryInventoryJsonSchema,
  localRepositoryReferencesJsonSchema,
  type LocalRepositoryInventory,
  type LocalRepositoryReferences,
  type RetainReviewRevisionCommand,
} from "@kestrel/contracts";
import type { DatabasePool, LocalRepositorySourceObservation } from "@kestrel/database";
import {
  LocalSourceError,
  discoverResolvedRepositories,
  inspectRepository,
  listRepositoryReferences,
  quarantineUnattachedArtifact,
  resolveRepository,
  resolveSelectedRevision,
  retainRevision,
  type LocalSourceConfig,
  type RetainedArtifact,
  type SelectedRevision,
} from "@kestrel/local-source";

export interface PreparedReviewRevision {
  maxBytes: number;
  maxObjects: number;
  selected: SelectedRevision;
  source: LocalRepositorySourceObservation;
}

export interface LocalRepositoryService {
  listRepositories(): Promise<LocalRepositoryInventory>;
  listReferences(repositoryId: string): Promise<LocalRepositoryReferences>;
}

export interface LocalReviewRevisionSourceService extends LocalRepositoryService {
  prepare(command: RetainReviewRevisionCommand): Promise<PreparedReviewRevision>;
  quarantine(artifactLocator: string): Promise<void>;
  retain(input: {
    prepared: PreparedReviewRevision;
    projectId: string;
    revisionId: string;
  }): Promise<RetainedArtifact>;
}

export function isSkippableRepositoryInspectionError(error: unknown): boolean {
  return error instanceof LocalSourceError && error.code !== "git_inspection_failed";
}

export async function readAttachedLocalSourceKeys(
  pool: DatabasePool,
  observations: readonly { repositoryId: string; sourceIdentity: string }[],
): Promise<ReadonlySet<string>> {
  if (observations.length === 0) return new Set();
  const attached = await pool.query<{ repository_id: string; source_identity: string }>(
    `
      SELECT DISTINCT source.repository_id, source.source_identity
      FROM local_repository_sources AS source
      INNER JOIN unnest($1::uuid[], $2::text[]) AS observed(repository_id, source_identity)
        ON observed.repository_id = source.repository_id
       AND observed.source_identity = source.source_identity
      WHERE source.attachment_state = 'attached'
      LIMIT $3
    `,
    [
      observations.map(({ repositoryId }) => repositoryId),
      observations.map(({ sourceIdentity }) => sourceIdentity),
      observations.length,
    ],
  );
  return new Set(
    attached.rows.map(
      ({ repository_id, source_identity }) => `${repository_id}\0${source_identity}`,
    ),
  );
}

export function createLocalRepositoryService(
  config: LocalSourceConfig,
  pool: DatabasePool,
): LocalReviewRevisionSourceService {
  return {
    async listRepositories() {
      const inspected: Array<{
        candidate: Awaited<ReturnType<typeof discoverResolvedRepositories>>[number];
        sourceIdentity: string;
      }> = [];
      for (const candidate of await discoverResolvedRepositories(config)) {
        try {
          const inspection = await inspectRepository(config, candidate);
          inspected.push({ candidate, sourceIdentity: inspection.sourceIdentity });
        } catch (error) {
          if (isSkippableRepositoryInspectionError(error)) {
            continue;
          }
          throw error;
        }
      }
      const attachedIdentities = await readAttachedLocalSourceKeys(
        pool,
        inspected.map(({ candidate, sourceIdentity }) => ({
          repositoryId: candidate.repositoryId,
          sourceIdentity,
        })),
      );
      const repositories: LocalRepositoryInventory["repositories"] = inspected.map(
        ({ candidate, sourceIdentity }) => ({
          attachmentState: attachedIdentities.has(`${candidate.repositoryId}\0${sourceIdentity}`)
            ? "attached"
            : "unattached",
          displayName: candidate.displayName,
          repositoryId: candidate.repositoryId,
        }),
      );
      return LocalRepositoryInventorySchema.parse({ schemaVersion: 1, repositories });
    },
    async listReferences(repositoryId) {
      const resolved = await resolveRepository(config, repositoryId);
      const inventory = await listRepositoryReferences(config, resolved);
      return LocalRepositoryReferencesSchema.parse({ schemaVersion: 1, ...inventory });
    },
    async prepare(command) {
      const repository = await resolveRepository(config, command.repositoryId);
      const inventory = await listRepositoryReferences(config, repository);
      const selected = await resolveSelectedRevision(config, repository, inventory, command);
      return {
        maxBytes: config.maxBytes,
        maxObjects: config.maxObjects,
        selected,
        source: {
          displayName: repository.displayName,
          githubRepository: selected.githubRepository,
          objectFormat: selected.objectFormat,
          relativePath: repository.relativePath,
          repositoryId: repository.repositoryId,
          rootId: repository.rootId,
          sourceIdentity: selected.sourceIdentity,
        },
      };
    },
    quarantine: (artifactLocator) => quarantineUnattachedArtifact(config, artifactLocator),
    retain: ({ prepared, projectId, revisionId }) =>
      retainRevision(
        { ...config, maxBytes: prepared.maxBytes, maxObjects: prepared.maxObjects },
        { projectId, revisionId, selected: prepared.selected },
      ),
  };
}

export async function inspectLocalSourceAttachments(
  config: LocalSourceConfig,
): Promise<readonly { repositoryId: string; sourceIdentity: string }[]> {
  const observations: Array<{ repositoryId: string; sourceIdentity: string }> = [];
  for (const candidate of await discoverResolvedRepositories(config)) {
    try {
      const inspection = await inspectRepository(config, candidate);
      observations.push({
        repositoryId: candidate.repositoryId,
        sourceIdentity: inspection.sourceIdentity,
      });
    } catch (error) {
      if (isSkippableRepositoryInspectionError(error)) {
        continue;
      }
      throw error;
    }
  }
  return observations;
}

function apiError(
  request: FastifyRequest,
  code:
    | "INVALID_REQUEST"
    | "REPOSITORY_NOT_AVAILABLE"
    | "REFERENCE_NOT_AVAILABLE"
    | "REVISION_LIMIT_EXCEEDED"
    | "SOURCE_CONTAINMENT_VIOLATION"
    | "SERVICE_UNAVAILABLE",
  message: string,
) {
  return ApiErrorSchema.parse({
    schemaVersion: 1,
    code,
    message,
    correlationId: request.id,
  });
}

function sendLocalSourceError(
  error: LocalSourceError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  switch (error.code) {
    case "repository_not_available":
      return reply
        .code(404)
        .send(apiError(request, "REPOSITORY_NOT_AVAILABLE", "The repository is unavailable"));
    case "reference_not_available":
      return reply
        .code(404)
        .send(apiError(request, "REFERENCE_NOT_AVAILABLE", "The reference is unavailable"));
    case "source_containment_violation":
    case "repository_invalid":
      return reply
        .code(422)
        .send(
          apiError(
            request,
            "SOURCE_CONTAINMENT_VIOLATION",
            "The repository failed source containment validation",
          ),
        );
    case "discovery_limit_exceeded":
    case "reference_limit_exceeded":
    case "revision_limit_exceeded":
      return reply
        .code(413)
        .send(
          apiError(
            request,
            "REVISION_LIMIT_EXCEEDED",
            "The configured local-source limit was exceeded",
          ),
        );
    default:
      return reply
        .code(503)
        .send(
          apiError(request, "SERVICE_UNAVAILABLE", "Local repository inspection is unavailable"),
        );
  }
}

export function registerLocalRepositoryRoutes(
  app: FastifyInstance,
  service: LocalRepositoryService,
): void {
  app.get(
    "/api/v1/local-repository-sources",
    {
      schema: {
        response: {
          200: jsonSchemaForEmbedding(localRepositoryInventoryJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          413: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      try {
        return LocalRepositoryInventorySchema.parse(await service.listRepositories());
      } catch (error) {
        if (error instanceof LocalSourceError) {
          return sendLocalSourceError(error, request, reply);
        }
        request.log.error({ event: "local_source.inventory_failed" });
        return reply
          .code(503)
          .send(
            apiError(request, "SERVICE_UNAVAILABLE", "Local repository discovery is unavailable"),
          );
      }
    },
  );

  app.get(
    "/api/v1/local-repository-sources/:repositoryId/references",
    {
      schema: {
        params: {
          additionalProperties: false,
          properties: {
            repositoryId: {
              format: "uuid",
              pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
              type: "string",
            },
          },
          required: ["repositoryId"],
          type: "object",
        },
        response: {
          200: jsonSchemaForEmbedding(localRepositoryReferencesJsonSchema),
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          404: jsonSchemaForEmbedding(apiErrorJsonSchema),
          413: jsonSchemaForEmbedding(apiErrorJsonSchema),
          422: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      const params = request.params as { repositoryId: string };
      const parsedRepositoryId = KestrelIdSchema.safeParse(params.repositoryId);
      if (!parsedRepositoryId.success) {
        return reply
          .code(400)
          .send(apiError(request, "INVALID_REQUEST", "The repository ID is invalid"));
      }
      try {
        return LocalRepositoryReferencesSchema.parse(
          await service.listReferences(parsedRepositoryId.data),
        );
      } catch (error) {
        if (error instanceof LocalSourceError) {
          return sendLocalSourceError(error, request, reply);
        }
        request.log.error({ event: "local_source.references_failed" });
        return reply
          .code(503)
          .send(
            apiError(request, "SERVICE_UNAVAILABLE", "Local repository inspection is unavailable"),
          );
      }
    },
  );
}
