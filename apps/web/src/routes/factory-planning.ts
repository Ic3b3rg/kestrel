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
  FeaturePlansSchema,
  FeaturePlanVersionSchema,
  SaveFeaturePlanCommandSchema,
  FactoryBoardSchema,
  ApproveFeaturePlanCommandSchema,
  CancelFeatureCommandSchema,
  GenerateFeaturePlanCommandSchema,
} from "@kestrel/contracts";
import {
  createFactoryFeature,
  acceptPlanningMessage,
  cancelPlanningTurn,
  retryPlanningTurn,
  FactoryError,
  listFactoryFeatures,
  readFactoryChat,
  readFactoryPlans,
  readFactoryPlanVersion,
  saveFactoryPlan,
  readFactoryBoard,
  approveFactoryPlan,
  cancelFactoryFeature,
  type DatabasePool,
  type DiagnosticJobSender,
} from "@kestrel/database";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import { renderFeaturePlanArtifacts } from "../factory-plan-artifacts.js";
import { validateFactoryPublication } from "../factory-issue-content.js";

const projectParams = z.strictObject({ projectId: KestrelIdSchema });
const featureParams = projectParams.extend({ featureId: KestrelIdSchema });
const turnParams = featureParams.extend({ turnId: KestrelIdSchema });
const planParams = featureParams.extend({ version: z.coerce.number().int().min(1).max(200) });
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

export function factoryError(request: FastifyRequest, error: unknown) {
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
    invalid_plan: [400, "INVALID_REQUEST", "The plan is not valid"],
    plan_limit: [
      409,
      "REQUEST_REJECTED",
      "The plan version limit was reached; start a new feature",
    ],
  } as const;
  const [status, code, message] = states[error.code];
  return {
    status,
    body: ApiErrorSchema.parse({
      schemaVersion: 1,
      code,
      message: error.detail ?? message,
      correlationId: request.id,
    }),
  };
}

export function registerFactoryPlanningRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  boss: DiagnosticJobSender,
): void {
  app.post(
    "/api/v1/projects/:projectId/features/:featureId/plans/generate",
    {
      bodyLimit: 512,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        params: jsonSchema(featureParams),
        body: jsonSchema(GenerateFeaturePlanCommandSchema),
        response: { ...errors, 202: jsonSchema(PlanningTurnAcceptedSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId } = featureParams.parse(request.params);
      const command = GenerateFeaturePlanCommandSchema.parse(request.body);
      try {
        return await reply.code(202).send(
          await acceptPlanningMessage(
            pool,
            boss,
            projectId,
            featureId,
            {
              requestId: command.requestId,
              text: "Generate a detailed plan from our discussion and the current draft for me to inspect before approval.",
              ...(command.skillSelectionVersion === undefined
                ? {}
                : { skillSelectionVersion: command.skillSelectionVersion }),
            },
            { expectedVersion: command.expectedVersion },
          ),
        );
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/features/:featureId/cancel",
    {
      bodyLimit: 256,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        params: jsonSchema(featureParams),
        body: jsonSchema(CancelFeatureCommandSchema),
        response: { ...errors, 200: jsonSchema(FactoryBoardSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId } = featureParams.parse(request.params);
      try {
        return await cancelFactoryFeature(
          pool,
          projectId,
          featureId,
          CancelFeatureCommandSchema.parse(request.body),
        );
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/features/:featureId/board",
    {
      schema: {
        params: jsonSchema(featureParams),
        response: { ...errors, 200: jsonSchema(FactoryBoardSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId } = featureParams.parse(request.params);
      try {
        return await readFactoryBoard(pool, projectId, featureId);
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/features/:featureId/plans/:version/approve",
    {
      bodyLimit: 256,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        params: jsonSchema(planParams),
        body: jsonSchema(ApproveFeaturePlanCommandSchema),
        response: { ...errors, 200: jsonSchema(FactoryBoardSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId, version } = planParams.parse(request.params);
      const actorId = request.operatorSession?.operator.id;
      if (actorId === undefined) throw new Error("Authenticated approval has no Operator");
      try {
        return await approveFactoryPlan(
          pool,
          projectId,
          featureId,
          actorId,
          version,
          ApproveFeaturePlanCommandSchema.parse(request.body).requestId,
          `${request.protocol}://${request.host}/projects/${projectId}/features/${featureId}?view=board`,
          validateFactoryPublication,
        );
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/features/:featureId/plans",
    {
      schema: {
        params: jsonSchema(featureParams),
        response: { ...errors, 200: jsonSchema(FeaturePlansSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId } = featureParams.parse(request.params);
      try {
        return await readFactoryPlans(pool, projectId, featureId);
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/features/:featureId/plans/:version",
    {
      schema: {
        params: jsonSchema(planParams),
        response: { ...errors, 200: jsonSchema(FeaturePlanVersionSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId, version } = planParams.parse(request.params);
      try {
        return await readFactoryPlanVersion(pool, projectId, featureId, version);
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/features/:featureId/plans",
    {
      bodyLimit: 1_000_000,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        params: jsonSchema(featureParams),
        body: jsonSchema(SaveFeaturePlanCommandSchema),
        response: { ...errors, 201: jsonSchema(FeaturePlanVersionSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId } = featureParams.parse(request.params);
      const actorId = request.operatorSession?.operator.id;
      if (actorId === undefined) throw new Error("Authenticated plan request has no Operator");
      try {
        return await reply
          .code(201)
          .send(
            await saveFactoryPlan(
              pool,
              projectId,
              featureId,
              actorId,
              SaveFeaturePlanCommandSchema.parse(request.body),
              renderFeaturePlanArtifacts,
            ),
          );
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
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
