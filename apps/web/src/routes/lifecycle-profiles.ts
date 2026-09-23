import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ApiErrorSchema,
  KestrelIdSchema,
  LifecyclePhaseSchema,
  LifecycleProfileViewSchema,
  SaveLifecycleProfileCommandSchema,
} from "@kestrel/contracts";
import { readLifecycleProfile, saveLifecycleProfile, type DatabasePool } from "@kestrel/database";
import type { CodexAgentRuntimePort } from "../codex-app-server.js";
import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import { factoryError } from "./factory-planning.js";

export function registerLifecycleProfileRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  runtime: CodexAgentRuntimePort,
): void {
  const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7" });
  const params = z.strictObject({
    phase: LifecyclePhaseSchema,
    projectId: KestrelIdSchema.optional(),
  });
  for (const path of [
    "/api/v1/lifecycle-profiles/:phase",
    "/api/v1/projects/:projectId/lifecycle-profiles/:phase",
  ]) {
    app.get(
      path,
      {
        schema: {
          params: json(params),
          response: {
            200: json(LifecycleProfileViewSchema),
            400: json(ApiErrorSchema),
            404: json(ApiErrorSchema),
            409: json(ApiErrorSchema),
            503: json(ApiErrorSchema),
          },
        },
      },
      async (request, reply) => {
        const { phase, projectId } = params.parse(request.params);
        try {
          return await readLifecycleProfile(
            pool,
            phase,
            projectId ?? null,
            await runtime.readConnection(),
          );
        } catch (error) {
          const failure = factoryError(request, error);
          return reply.code(failure.status).send(failure.body);
        }
      },
    );
    app.put(
      path,
      {
        config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
        schema: {
          params: json(params),
          body: json(SaveLifecycleProfileCommandSchema),
          response: {
            200: json(LifecycleProfileViewSchema),
            400: json(ApiErrorSchema),
            404: json(ApiErrorSchema),
            409: json(ApiErrorSchema),
            503: json(ApiErrorSchema),
          },
        },
      },
      async (request, reply) => {
        const { phase, projectId } = params.parse(request.params);
        try {
          await saveLifecycleProfile(pool, phase, projectId ?? null, request.body);
          return await readLifecycleProfile(
            pool,
            phase,
            projectId ?? null,
            await runtime.readConnection(),
          );
        } catch (error) {
          const failure = factoryError(request, error);
          return reply.code(failure.status).send(failure.body);
        }
      },
    );
  }
}
