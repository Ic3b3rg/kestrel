import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ApiErrorSchema,
  ApproveFactoryFeatureMergeCommandSchema,
  FactoryFeatureMergeCurrentSchema,
  FactoryFeatureMergeSchema,
  KestrelIdSchema,
  RetryFactoryFeatureMergeCommandSchema,
  type ApiError,
  type ApproveFactoryFeatureMergeCommand,
  type FactoryFeatureMerge,
  type FactoryFeatureMergeCurrent,
  type RetryFactoryFeatureMergeCommand,
} from "@kestrel/contracts";
import {
  approveFactoryFeatureMerge,
  FactoryError,
  FactoryFeatureMergeError,
  readCurrentFactoryFeatureMerge,
  retryFactoryFeatureMerge,
  type DatabasePool,
  type DiagnosticJobSender,
} from "@kestrel/database";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";

export interface FactoryFeatureMergeContext {
  projectId: string;
  featureId: string;
}

export interface FactoryFeatureMergeService {
  current(context: FactoryFeatureMergeContext): Promise<FactoryFeatureMergeCurrent>;
  approve(
    context: FactoryFeatureMergeContext,
    command: ApproveFactoryFeatureMergeCommand,
    actorId: string,
  ): Promise<FactoryFeatureMerge>;
  retry(
    context: FactoryFeatureMergeContext,
    actorId: string,
    command: RetryFactoryFeatureMergeCommand,
  ): Promise<FactoryFeatureMerge>;
}

export function createDatabaseFactoryFeatureMergeService(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
): FactoryFeatureMergeService {
  return {
    current: ({ projectId, featureId }) =>
      readCurrentFactoryFeatureMerge(pool, projectId, featureId),
    approve: ({ projectId, featureId }, command, actorId) =>
      approveFactoryFeatureMerge(pool, boss, projectId, featureId, actorId, command),
    retry: ({ projectId, featureId }, actorId, command) =>
      retryFactoryFeatureMerge(pool, boss, projectId, featureId, actorId, command),
  };
}

const params = z.strictObject({ projectId: KestrelIdSchema, featureId: KestrelIdSchema });
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7" });
const errors = {
  400: json(ApiErrorSchema),
  401: json(ApiErrorSchema),
  404: json(ApiErrorSchema),
  409: json(ApiErrorSchema),
  500: json(ApiErrorSchema),
  503: json(ApiErrorSchema),
};

function apiError(request: FastifyRequest, code: ApiError["code"], message: string) {
  return ApiErrorSchema.parse({ schemaVersion: 1, code, message, correlationId: request.id });
}

function failure(request: FastifyRequest, error: unknown) {
  if (error instanceof z.ZodError)
    return {
      status: 400 as const,
      body: apiError(request, "INVALID_REQUEST", "The merge approval is invalid"),
    };
  if (error instanceof FactoryFeatureMergeError) {
    if (error.code === "not_found")
      return {
        status: 404 as const,
        body: apiError(request, "NOT_FOUND", "The merge is unavailable"),
      };
    const message =
      error.code === "review_outdated"
        ? "The selected review no longer matches the current Feature revision"
        : error.code === "review_partial"
          ? "Only a complete Conceptual Review can be approved for merge"
          : error.code === "active_correction"
            ? "Finish the active correction and its replacement review before merging"
            : "The Feature cannot be merged in its current state";
    return {
      status: 409 as const,
      body: apiError(request, "REQUEST_REJECTED", message),
    };
  }
  if (error instanceof FactoryError) {
    if (error.code === "not_found")
      return {
        status: 404 as const,
        body: apiError(request, "NOT_FOUND", "The Feature is unavailable"),
      };
    if (error.code === "conflict")
      return {
        status: 409 as const,
        body: apiError(request, "REQUEST_REJECTED", "The merge conflicts with current state"),
      };
  }
  request.log.error({ err: error, event: "factory_feature_merge.failed" });
  return {
    status: 500 as const,
    body: apiError(request, "INTERNAL_ERROR", "The merge request failed"),
  };
}

export function registerFactoryFeatureMergeRoutes(
  app: FastifyInstance,
  service: FactoryFeatureMergeService,
) {
  const root = "/api/v1/projects/:projectId/features/:featureId/review/merge";
  app.get(
    root,
    {
      schema: {
        params: json(params),
        response: { ...errors, 200: json(FactoryFeatureMergeCurrentSchema) },
      },
    },
    async (request, reply) => {
      try {
        return FactoryFeatureMergeCurrentSchema.parse(
          await service.current(params.parse(request.params)),
        );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
  app.post(
    root,
    {
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      bodyLimit: 4096,
      schema: {
        params: json(params),
        body: json(ApproveFactoryFeatureMergeCommandSchema),
        response: { ...errors, 202: json(FactoryFeatureMergeSchema) },
      },
    },
    async (request, reply) => {
      try {
        const actorId = request.operatorSession?.operator.id;
        if (actorId === undefined) throw new Error("Authenticated merge has no Operator");
        const result = await service.approve(
          params.parse(request.params),
          ApproveFactoryFeatureMergeCommandSchema.parse(request.body),
          actorId,
        );
        return await reply.code(202).send(FactoryFeatureMergeSchema.parse(result));
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
  app.post(
    `${root}/retry`,
    {
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      bodyLimit: 512,
      schema: {
        params: json(params),
        body: json(RetryFactoryFeatureMergeCommandSchema),
        response: { ...errors, 202: json(FactoryFeatureMergeSchema) },
      },
    },
    async (request, reply) => {
      try {
        const actorId = request.operatorSession?.operator.id;
        if (actorId === undefined) throw new Error("Authenticated merge retry has no Operator");
        const result = await service.retry(
          params.parse(request.params),
          actorId,
          RetryFactoryFeatureMergeCommandSchema.parse(request.body),
        );
        return await reply.code(202).send(FactoryFeatureMergeSchema.parse(result));
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
}
