import { SourceAuthorizationError, createManagedSourceService } from "@kestrel/local-source";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CloneSourceCommandSchema,
  ManagedSourceSchema,
  ManagedSourcesSchema,
  ApiErrorSchema,
  KestrelIdSchema,
  SourceAuthorizationSchema,
} from "@kestrel/contracts";
import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import type { SourceOnboardingService } from "../source-onboarding.js";

export function registerSourceOnboardingRoutes(
  app: FastifyInstance,
  service: SourceOnboardingService,
): void {
  const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7" });
  const confirm = z.strictObject({ previewId: z.uuid() });
  const managed = createManagedSourceService();
  const rejectManaged = (error: unknown, correlationId: string) =>
    ApiErrorSchema.parse({
      schemaVersion: 1,
      code: "SERVICE_UNAVAILABLE",
      correlationId,
      message:
        error instanceof SourceAuthorizationError
          ? error.message
          : "Managed source access is unavailable. Check the workstation and retry.",
    });
  app.get(
    "/api/v1/managed-sources",
    { schema: { response: { 200: json(ManagedSourcesSchema), 503: json(ApiErrorSchema) } } },
    async (request, reply) => {
      try {
        return await managed.list();
      } catch (error) {
        return await reply.code(503).send(rejectManaged(error, request.id));
      }
    },
  );
  for (const action of ["clone", "refresh"] as const) {
    app.post(
      `/api/v1/managed-sources/${action}`,
      {
        config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
        schema: {
          body: json(
            action === "clone"
              ? CloneSourceCommandSchema
              : z.strictObject({ repositoryId: KestrelIdSchema }),
          ),
          response: { 200: json(ManagedSourceSchema), 503: json(ApiErrorSchema) },
        },
      },
      async (request, reply) => {
        const controller = new AbortController();
        const disconnected = () => {
          if (!reply.raw.writableEnded) controller.abort();
        };
        reply.raw.once("close", disconnected);
        try {
          const result =
            action === "clone"
              ? await managed.clone(
                  CloneSourceCommandSchema.parse(request.body).url,
                  controller.signal,
                )
              : await managed.refresh(
                  z.strictObject({ repositoryId: KestrelIdSchema }).parse(request.body)
                    .repositoryId,
                  controller.signal,
                );
          request.log.info({
            event: `managed_source.${action}`,
            repositoryId: result.repositoryId,
          });
          return ManagedSourceSchema.parse(result);
        } catch (error) {
          return await reply.code(503).send(rejectManaged(error, request.id));
        } finally {
          reply.raw.removeListener("close", disconnected);
        }
      },
    );
  }
  for (const operation of ["choose", "confirm"] as const) {
    app.post(
      `/api/v1/local-repository-sources/${operation}`,
      {
        config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
        schema: {
          body: json(operation === "choose" ? z.strictObject({}) : confirm),
          response: { 200: json(SourceAuthorizationSchema), 409: json(ApiErrorSchema) },
        },
      },
      async (request, reply) => {
        try {
          const result =
            operation === "choose"
              ? await service.chooseFolder()
              : await service.confirmFolder(confirm.parse(request.body).previewId);
          request.log.info({ event: `local_source.${operation}`, outcome: result.state });
          return SourceAuthorizationSchema.parse(result);
        } catch (error) {
          return reply.code(409).send(
            ApiErrorSchema.parse({
              schemaVersion: 1,
              code: "INVALID_REQUEST",
              correlationId: request.id,
              message:
                error instanceof SourceAuthorizationError
                  ? error.message
                  : "Source authorization could not complete. Choose the folder again.",
            }),
          );
        }
      },
    );
  }
}
