import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  ApiErrorSchema,
  CreateFeatureCommandSchema,
  FeatureChatSchema,
  FeatureListSchema,
  FeatureSchema,
  KestrelIdSchema,
  PlanningTurnAcceptedSchema,
  SendPlanningMessageCommandSchema,
  RetryPlanningTurnCommandSchema,
} from "@kestrel/contracts";
import {
  createFactoryFeature,
  acceptPlanningMessage,
  cancelPlanningTurn,
  retryPlanningTurn,
  FactoryError,
  listFactoryFeatures,
  readFactoryChat,
  type DatabasePool,
  type DiagnosticJobSender,
} from "@kestrel/database";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";

const projectParams = z.strictObject({ projectId: KestrelIdSchema });
const featureParams = projectParams.extend({ featureId: KestrelIdSchema });
const turnParams = featureParams.extend({ turnId: KestrelIdSchema });
const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7" });
const errors = {
  400: jsonSchema(ApiErrorSchema),
  401: jsonSchema(ApiErrorSchema),
  403: jsonSchema(ApiErrorSchema),
  404: jsonSchema(ApiErrorSchema),
  409: jsonSchema(ApiErrorSchema),
  413: jsonSchema(ApiErrorSchema),
  415: jsonSchema(ApiErrorSchema),
  500: jsonSchema(ApiErrorSchema),
  503: jsonSchema(ApiErrorSchema),
};

function factoryError(request: FastifyRequest, error: unknown) {
  if (!(error instanceof FactoryError)) throw error;
  const states = {
    not_found: [404, "NOT_FOUND", "The Project or feature is unavailable"],
    conflict: [409, "REQUEST_REJECTED", "The feature changed; refresh before trying again"],
    unavailable: [503, "SERVICE_UNAVAILABLE", "Feature planning is unavailable"],
    conversation_limit: [
      409,
      "REQUEST_REJECTED",
      "The conversation limit was reached; start a new feature chat",
    ],
    feature_limit: [409, "REQUEST_REJECTED", "The Project feature limit was reached"],
  } as const;
  const [status, code, message] = states[error.code];
  return {
    status,
    body: ApiErrorSchema.parse({ schemaVersion: 1, code, message, correlationId: request.id }),
  };
}

export function registerFactoryPlanningRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  boss: DiagnosticJobSender,
): void {
  app.post(
    "/api/v1/projects/:projectId/features",
    {
      bodyLimit: 2048,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        params: jsonSchema(projectParams),
        body: jsonSchema(CreateFeatureCommandSchema),
        response: { ...errors, 201: jsonSchema(FeatureSchema) },
      },
    },
    async (request, reply) => {
      const { projectId } = projectParams.parse(request.params);
      const actorId = request.operatorSession?.operator.id;
      if (actorId === undefined) throw new Error("Authenticated feature request has no Operator");
      try {
        return await reply
          .code(201)
          .send(
            await createFactoryFeature(
              pool,
              projectId,
              actorId,
              CreateFeatureCommandSchema.parse(request.body),
            ),
          );
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/features",
    {
      schema: {
        params: jsonSchema(projectParams),
        response: { ...errors, 200: jsonSchema(FeatureListSchema) },
      },
    },
    async (request, reply) => {
      try {
        return {
          schemaVersion: 1,
          features: await listFactoryFeatures(pool, projectParams.parse(request.params).projectId),
        };
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/features/:featureId",
    {
      schema: {
        params: jsonSchema(featureParams),
        response: { ...errors, 200: jsonSchema(FeatureChatSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId } = featureParams.parse(request.params);
      try {
        return await readFactoryChat(pool, projectId, featureId);
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/features/:featureId/messages",
    {
      bodyLimit: 96_000,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        params: jsonSchema(featureParams),
        body: jsonSchema(SendPlanningMessageCommandSchema),
        response: { ...errors, 202: jsonSchema(PlanningTurnAcceptedSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId } = featureParams.parse(request.params);
      try {
        return await reply
          .code(202)
          .send(
            await acceptPlanningMessage(
              pool,
              boss,
              projectId,
              featureId,
              SendPlanningMessageCommandSchema.parse(request.body),
            ),
          );
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/features/:featureId/turns/:turnId/cancel",
    {
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        params: jsonSchema(turnParams),
        response: { ...errors, 200: jsonSchema(FeatureChatSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId, turnId } = turnParams.parse(request.params);
      try {
        return await cancelPlanningTurn(pool, projectId, featureId, turnId);
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/features/:featureId/turns/:turnId/retry",
    {
      bodyLimit: 256,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        params: jsonSchema(turnParams),
        body: jsonSchema(RetryPlanningTurnCommandSchema),
        response: { ...errors, 202: jsonSchema(PlanningTurnAcceptedSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId, turnId } = turnParams.parse(request.params);
      try {
        return await reply
          .code(202)
          .send(
            await retryPlanningTurn(
              pool,
              boss,
              projectId,
              featureId,
              turnId,
              RetryPlanningTurnCommandSchema.parse(request.body).requestId,
            ),
          );
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
}
