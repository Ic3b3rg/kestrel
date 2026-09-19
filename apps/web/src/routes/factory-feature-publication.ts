import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ApiErrorSchema,
  KestrelIdSchema,
  FactoryFeaturePublicationSchema,
  RetryFactoryFeaturePublicationCommandSchema,
} from "@kestrel/contracts";
import {
  readFactoryFeaturePublication,
  retryFactoryFeaturePublication,
  type DatabasePool,
} from "@kestrel/database";
import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import { factoryError } from "./factory-planning.js";

const params = z.strictObject({ projectId: KestrelIdSchema, featureId: KestrelIdSchema });
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7" });
const errors = {
  400: json(ApiErrorSchema),
  401: json(ApiErrorSchema),
  403: json(ApiErrorSchema),
  404: json(ApiErrorSchema),
  409: json(ApiErrorSchema),
  413: json(ApiErrorSchema),
  415: json(ApiErrorSchema),
  500: json(ApiErrorSchema),
  503: json(ApiErrorSchema),
};

export function registerFactoryFeaturePublicationRoutes(app: FastifyInstance, pool: DatabasePool) {
  app.get(
    "/api/v1/projects/:projectId/features/:featureId/pull-request",
    {
      schema: {
        params: json(params),
        response: { ...errors, 200: json(FactoryFeaturePublicationSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId } = params.parse(request.params);
      try {
        return await readFactoryFeaturePublication(pool, projectId, featureId);
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/features/:featureId/pull-request/retry",
    {
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      bodyLimit: 256,
      schema: {
        params: json(params),
        body: json(RetryFactoryFeaturePublicationCommandSchema),
        response: { ...errors, 202: json(FactoryFeaturePublicationSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId } = params.parse(request.params);
      const actorId = request.operatorSession?.operator.id;
      if (actorId === undefined) throw new Error("Authenticated publication retry has no Operator");
      try {
        const command = RetryFactoryFeaturePublicationCommandSchema.parse(request.body);
        return await reply
          .code(202)
          .send(
            await retryFactoryFeaturePublication(
              pool,
              projectId,
              featureId,
              actorId,
              command.requestId,
            ),
          );
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
}
