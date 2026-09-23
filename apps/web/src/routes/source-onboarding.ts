import { SourceAuthorizationError } from "@kestrel/local-source";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiErrorSchema, KestrelIdSchema, SourceAuthorizationSchema } from "@kestrel/contracts";
import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import type { SourceOnboardingService } from "../source-onboarding.js";

export function registerSourceOnboardingRoutes(
  app: FastifyInstance,
  service: SourceOnboardingService,
): void {
  const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7" });
  const confirm = z.strictObject({ previewId: KestrelIdSchema });
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
          return reply
            .code(409)
            .send(
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
