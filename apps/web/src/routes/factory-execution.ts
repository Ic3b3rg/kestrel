import {
  readLocalSourceConfig,
  openFeatureWorkspace,
  assertFeatureWorkspaceSnapshot,
  FeatureWorkspaceError,
  LocalSourceError,
} from "@kestrel/local-source";
import { readIssueStartContext } from "../factory-planning-source.js";
import { renderFeaturePlanArtifacts } from "../factory-plan-artifacts.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  ApiErrorSchema,
  StartFactoryWorkItemCommandSchema,
  FactoryWorkItemStartSchema,
  FactoryExecutionSchema,
  FactoryExecutionRunSchema,
  FactoryGateSchema,
  ResolveFactoryGateCommandSchema,
  KestrelIdSchema,
} from "@kestrel/contracts";
import {
  startFactoryWorkItem,
  readFactoryExecution,
  readFactoryExecutionRun,
  readFactoryGate,
  resolveFactoryGate,
  FactoryError,
  type DatabasePool,
} from "@kestrel/database";
import { factoryError } from "./factory-planning.js";
import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";

const featureParams = z.strictObject({ projectId: KestrelIdSchema, featureId: KestrelIdSchema });
const runParams = featureParams.extend({ runId: KestrelIdSchema });
const gateParams = featureParams.extend({ gateId: KestrelIdSchema });
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

export function registerFactoryExecutionRoutes(app: FastifyInstance, pool: DatabasePool): void {
  const itemParams = featureParams.extend({ workItemId: KestrelIdSchema });
  app.post(
    "/api/v1/projects/:projectId/features/:featureId/work-items/:workItemId/start",
    {
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        params: jsonSchema(itemParams),
        body: jsonSchema(StartFactoryWorkItemCommandSchema),
        response: { ...errors, 200: jsonSchema(FactoryWorkItemStartSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId, workItemId } = itemParams.parse(request.params);
      const actorId = request.operatorSession?.operator.id;
      if (actorId === undefined) throw new Error("Authenticated start has no Operator");
      try {
        return await startFactoryWorkItem(
          pool,
          projectId,
          featureId,
          workItemId,
          actorId,
          StartFactoryWorkItemCommandSchema.parse(request.body),
          renderFeaturePlanArtifacts,
          async (source, requiredCommits) =>
            readIssueStartContext(await readLocalSourceConfig(), source, requiredCommits),
        );
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );

  app.get(
    "/api/v1/projects/:projectId/features/:featureId/execution/gates/:gateId",
    {
      schema: {
        params: jsonSchema(gateParams),
        response: { ...errors, 200: jsonSchema(FactoryGateSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId, gateId } = gateParams.parse(request.params);
      try {
        return await readFactoryGate(pool, projectId, featureId, gateId);
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/features/:featureId/execution/gates/:gateId/resolve",
    {
      bodyLimit: 32_000,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        params: jsonSchema(gateParams),
        body: jsonSchema(ResolveFactoryGateCommandSchema),
        response: { ...errors, 200: jsonSchema(FactoryGateSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId, gateId } = gateParams.parse(request.params);
      const actorId = request.operatorSession?.operator.id;
      if (actorId === undefined) throw new Error("Authenticated gate answer has no Operator");
      try {
        return await resolveFactoryGate(
          pool,
          projectId,
          featureId,
          gateId,
          actorId,
          ResolveFactoryGateCommandSchema.parse(request.body),
          async (workspace) => {
            const config = await readLocalSourceConfig();
            try {
              const retained = await openFeatureWorkspace(config, workspace);
              await assertFeatureWorkspaceSnapshot(retained, workspace);
            } catch (error) {
              if (error instanceof FeatureWorkspaceError || error instanceof LocalSourceError)
                throw new FactoryError(
                  "conflict",
                  "The workspace does not match its saved revision. Restore the retained checkpoint before retrying.",
                );
              throw error;
            }
          },
        );
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
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
