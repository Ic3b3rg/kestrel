import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  ApiErrorSchema,
  KestrelIdSchema,
  ReviewPreparationSchema,
  ReviewWorkflowAcceptedSchema,
  StartReviewWorkflowCommandSchema,
  apiErrorJsonSchema,
  jsonSchemaForEmbedding,
  reviewPreparationJsonSchema,
  reviewWorkflowAcceptedJsonSchema,
  startReviewWorkflowCommandJsonSchema,
  type ApiError,
  type ReviewPreparation,
  type ReviewWorkflowAccepted,
  type StartReviewWorkflowCommand,
} from "@kestrel/contracts";
import {
  readReviewPreparation,
  ReviewWorkflowPersistenceError,
  startReviewWorkflow,
  type DatabasePool,
  type ReviewExecutionProfile,
} from "@kestrel/database";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";

export interface ReviewPreparationContext {
  actorId: string;
  changeProposalId: string;
  projectId: string;
}

export interface StartReviewWorkflowContext extends ReviewPreparationContext {
  correlationId: string;
}

export interface ReviewWorkflowService {
  prepare(context: ReviewPreparationContext): Promise<ReviewPreparation>;
  start(
    command: StartReviewWorkflowCommand,
    context: StartReviewWorkflowContext,
  ): Promise<ReviewWorkflowAccepted>;
}

const executionProfile = {
  analysisConfiguration: null,
  modelRouteAvailability: "unavailable",
  resourceEnvelope: null,
} satisfies ReviewExecutionProfile;

export function createDatabaseReviewWorkflowService(pool: DatabasePool): ReviewWorkflowService {
  return {
    prepare: (context) => readReviewPreparation(pool, context, executionProfile),
    start: (command, context) =>
      startReviewWorkflow(pool, { ...context, command }, executionProfile),
  };
}

function apiError(request: FastifyRequest, code: ApiError["code"], message: string) {
  return ApiErrorSchema.parse({ schemaVersion: 1, code, message, correlationId: request.id });
}

export function registerReviewWorkflowRoutes(
  app: FastifyInstance,
  service: ReviewWorkflowService,
): void {
  app.get(
    "/api/v1/projects/:projectId/change-proposals/:changeProposalId/review-preparation",
    {
      schema: {
        response: {
          200: jsonSchemaForEmbedding(reviewPreparationJsonSchema),
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          404: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
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
      if (!parsedProjectId.success || !parsedProposalId.success) {
        return reply
          .code(400)
          .send(apiError(request, "INVALID_REQUEST", "The Review preparation request is invalid"));
      }
      const session = request.operatorSession;
      if (session === null) {
        throw new Error("Authenticated Review preparation route has no Operator session");
      }
      try {
        return ReviewPreparationSchema.parse(
          await service.prepare({
            actorId: session.operator.id,
            changeProposalId: parsedProposalId.data,
            projectId: parsedProjectId.data,
          }),
        );
      } catch (error) {
        if (error instanceof ReviewWorkflowPersistenceError && error.code === "not_found") {
          return reply
            .code(404)
            .send(apiError(request, "NOT_FOUND", "The Change Proposal is unavailable"));
        }
        request.log.error({ err: error, event: "review_preparation.read_failed" });
        return reply
          .code(503)
          .send(apiError(request, "SERVICE_UNAVAILABLE", "Review preparation is unavailable"));
      }
    },
  );

  app.post(
    "/api/v1/projects/:projectId/change-proposals/:changeProposalId/review-workflows",
    {
      bodyLimit: 512,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        body: jsonSchemaForEmbedding(startReviewWorkflowCommandJsonSchema),
        response: {
          202: jsonSchemaForEmbedding(reviewWorkflowAcceptedJsonSchema),
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
      const parsedCommand = StartReviewWorkflowCommandSchema.safeParse(request.body);
      if (!parsedProjectId.success || !parsedProposalId.success || !parsedCommand.success) {
        return reply
          .code(400)
          .send(apiError(request, "INVALID_REQUEST", "The Review command is invalid"));
      }
      const session = request.operatorSession;
      if (session === null) {
        throw new Error("Authenticated Review Workflow route has no Operator session");
      }
      try {
        const accepted = await service.start(parsedCommand.data, {
          actorId: session.operator.id,
          changeProposalId: parsedProposalId.data,
          correlationId: request.id,
          projectId: parsedProjectId.data,
        });
        return await reply.code(202).send(ReviewWorkflowAcceptedSchema.parse(accepted));
      } catch (error) {
        if (error instanceof ReviewWorkflowPersistenceError && error.code === "not_found") {
          return reply
            .code(404)
            .send(apiError(request, "NOT_FOUND", "The Change Proposal is unavailable"));
        }
        if (error instanceof ReviewWorkflowPersistenceError && error.code === "not_ready") {
          return reply
            .code(409)
            .send(apiError(request, "REVIEW_NOT_READY", "The Review inputs are not ready"));
        }
        if (
          error instanceof ReviewWorkflowPersistenceError &&
          error.code === "preparation_conflict"
        ) {
          return reply
            .code(409)
            .send(
              apiError(
                request,
                "REVIEW_PREPARATION_CONFLICT",
                "The Review inputs changed after preparation",
              ),
            );
        }
        request.log.error({ err: error, event: "review_workflow.start_failed" });
        return reply
          .code(500)
          .send(apiError(request, "INTERNAL_ERROR", "The Review Workflow was not started"));
      }
    },
  );
}
