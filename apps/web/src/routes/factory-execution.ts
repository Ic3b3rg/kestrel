import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  ApiErrorSchema,
  FactoryExecutionSchema,
  FactoryExecutionRunSchema,
  KestrelIdSchema,
} from "@kestrel/contracts";
import {
  readFactoryExecution,
  readFactoryExecutionRun,
  type DatabasePool,
} from "@kestrel/database";
import { factoryError } from "./factory-planning.js";

const featureParams = z.strictObject({ projectId: KestrelIdSchema, featureId: KestrelIdSchema });
const runParams = featureParams.extend({ runId: KestrelIdSchema });
const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7" });
const errors = {
  400: jsonSchema(ApiErrorSchema),
  401: jsonSchema(ApiErrorSchema),
  403: jsonSchema(ApiErrorSchema),
  404: jsonSchema(ApiErrorSchema),
  409: jsonSchema(ApiErrorSchema),
  500: jsonSchema(ApiErrorSchema),
  503: jsonSchema(ApiErrorSchema),
};

export function registerFactoryExecutionRoutes(app: FastifyInstance, pool: DatabasePool): void {
  app.get(
    "/api/v1/projects/:projectId/features/:featureId/execution",
    {
      schema: {
        params: jsonSchema(featureParams),
        response: { ...errors, 200: jsonSchema(FactoryExecutionSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId } = featureParams.parse(request.params);
      try {
        return await readFactoryExecution(pool, projectId, featureId);
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/features/:featureId/execution/runs/:runId",
    {
      schema: {
        params: jsonSchema(runParams),
        response: { ...errors, 200: jsonSchema(FactoryExecutionRunSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId, runId } = runParams.parse(request.params);
      try {
        return await readFactoryExecutionRun(pool, projectId, featureId, runId);
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
}
