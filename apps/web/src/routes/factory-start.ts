import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ApiErrorSchema,
  FeatureSchema,
  KestrelIdSchema,
  PlanningFeatureRequestSchema,
  PlanningFeatureStartedSchema,
  RenameFactoryFeatureCommandSchema,
  StartPlanningFeatureCommandSchema,
} from "@kestrel/contracts";
import {
  readPlanningFeatureRequest,
  renameFactoryFeature,
  startPlanningFeature,
  type DatabasePool,
  type DiagnosticJobSender,
} from "@kestrel/database";
import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import { factoryError } from "./factory-planning.js";

const projectParams = z.strictObject({ projectId: KestrelIdSchema });
const requestParams = projectParams.extend({ requestId: z.uuid() });
const featureParams = projectParams.extend({ featureId: KestrelIdSchema });
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: "draft-7" });
const errorSchema = schema(ApiErrorSchema);
const errors = {
  400: errorSchema,
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
  413: errorSchema,
  415: errorSchema,
  500: errorSchema,
  503: errorSchema,
};

export function registerFactoryStartRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  boss: DiagnosticJobSender,
): void {
  app.get(
    "/api/v1/projects/:projectId/planning/:requestId",
    {
      schema: {
        params: schema(requestParams),
        response: { ...errors, 200: schema(PlanningFeatureRequestSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, requestId } = requestParams.parse(request.params);
      const actorId = request.operatorSession?.operator.id;
      if (actorId === undefined) throw new Error("Authenticated planning lookup has no Operator");
      try {
        return await readPlanningFeatureRequest(pool, projectId, actorId, requestId);
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/planning",
    {
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      bodyLimit: 100_000,
      schema: {
        params: schema(projectParams),
        body: schema(StartPlanningFeatureCommandSchema),
        response: { ...errors, 202: schema(PlanningFeatureStartedSchema) },
      },
    },
    async (request, reply) => {
      const { projectId } = projectParams.parse(request.params);
      const actorId = request.operatorSession?.operator.id;
      if (actorId === undefined) throw new Error("Authenticated planning start has no Operator");
      try {
        return await reply
          .code(202)
          .send(
            await startPlanningFeature(
              pool,
              boss,
              projectId,
              actorId,
              StartPlanningFeatureCommandSchema.parse(request.body),
            ),
          );
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/features/:featureId/title",
    {
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      bodyLimit: 4000,
      schema: {
        params: schema(featureParams),
        body: schema(RenameFactoryFeatureCommandSchema),
        response: { ...errors, 200: schema(FeatureSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId } = featureParams.parse(request.params);
      const actorId = request.operatorSession?.operator.id;
      if (actorId === undefined) throw new Error("Authenticated Feature rename has no Operator");
      try {
        return await renameFactoryFeature(
          pool,
          projectId,
          featureId,
          actorId,
          RenameFactoryFeatureCommandSchema.parse(request.body),
        );
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
}
