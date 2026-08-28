import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  ApiErrorSchema,
  ChangeIntentVersionCreatedSchema,
  CreateChangeIntentVersionCommandSchema,
  KestrelIdSchema,
  apiErrorJsonSchema,
  changeIntentVersionCreatedJsonSchema,
  createChangeIntentVersionCommandJsonSchema,
  jsonSchemaForEmbedding,
  type ApiError,
  type ChangeIntentVersionCreated,
  type CreateChangeIntentVersionCommand,
} from "@kestrel/contracts";
import {
  ChangeIntentPersistenceError,
  createChangeIntentVersion,
  type DatabasePool,
} from "@kestrel/database";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";

export interface ChangeIntentServiceContext {
  actorId: string;
  changeProposalId: string;
  correlationId: string;
  projectId: string;
}

export interface ChangeIntentService {
  createVersion(
    command: CreateChangeIntentVersionCommand,
    context: ChangeIntentServiceContext,
  ): Promise<ChangeIntentVersionCreated>;
}

export function createDatabaseChangeIntentService(pool: DatabasePool): ChangeIntentService {
  return {
    createVersion: (command, context) =>
      createChangeIntentVersion(pool, {
        ...context,
        command,
      }),
  };
}

function apiError(request: FastifyRequest, code: ApiError["code"], message: string) {
  return ApiErrorSchema.parse({ schemaVersion: 1, code, message, correlationId: request.id });
}

export function registerChangeIntentRoutes(
  app: FastifyInstance,
  service: ChangeIntentService,
): void {
  app.post(
    "/api/v1/projects/:projectId/change-proposals/:changeProposalId/change-intents",
    {
      bodyLimit: 4 * 1024 * 1024,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        body: jsonSchemaForEmbedding(createChangeIntentVersionCommandJsonSchema),
        response: {
          201: jsonSchemaForEmbedding(changeIntentVersionCreatedJsonSchema),
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          403: jsonSchemaForEmbedding(apiErrorJsonSchema),
          404: jsonSchemaForEmbedding(apiErrorJsonSchema),
          409: jsonSchemaForEmbedding(apiErrorJsonSchema),
          413: jsonSchemaForEmbedding(apiErrorJsonSchema),
          415: jsonSchemaForEmbedding(apiErrorJsonSchema),
          500: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      const { projectId, changeProposalId } = request.params as {
        changeProposalId: string;
        projectId: string;
      };
      const parsedProjectId = KestrelIdSchema.safeParse(projectId);
      const parsedProposalId = KestrelIdSchema.safeParse(changeProposalId);
      const parsedCommand = CreateChangeIntentVersionCommandSchema.safeParse(request.body);
      if (!parsedProjectId.success || !parsedProposalId.success || !parsedCommand.success) {
        return reply
          .code(400)
          .send(apiError(request, "INVALID_REQUEST", "The Change Intent request is invalid"));
      }
      const session = request.operatorSession;
      if (session === null) {
        throw new Error("Authenticated Change Intent route has no Operator session");
      }
      try {
        const result = await service.createVersion(parsedCommand.data, {
          actorId: session.operator.id,
          changeProposalId: parsedProposalId.data,
          correlationId: request.id,
          projectId: parsedProjectId.data,
        });
        return reply.code(201).send(ChangeIntentVersionCreatedSchema.parse(result));
      } catch (error) {
        if (error instanceof ChangeIntentPersistenceError) {
          switch (error.code) {
            case "not_found":
              return reply
                .code(404)
                .send(apiError(request, "NOT_FOUND", "The Change Proposal is unavailable"));
            case "source_conflict":
              return reply
                .code(409)
                .send(
                  apiError(
                    request,
                    "CHANGE_INTENT_SOURCE_CONFLICT",
                    "The selected Change Intent sources are stale or unavailable",
                  ),
                );
            case "version_conflict":
              return reply
                .code(409)
                .send(
                  apiError(
                    request,
                    "CHANGE_PROPOSAL_VERSION_CONFLICT",
                    "The Change Proposal changed; refresh before creating a new version",
                  ),
                );
          }
        }
        request.log.error({ err: error, event: "change_intent.version_create_failed" });
        return reply
          .code(500)
          .send(apiError(request, "INTERNAL_ERROR", "The Change Intent version was not created"));
      }
    },
  );
}
