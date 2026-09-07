import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  ApiErrorSchema,
  CodexReviewModelPreferenceSchema,
  SelectCodexReviewModelCommandSchema,
  apiErrorJsonSchema,
  codexReviewModelPreferenceJsonSchema,
  jsonSchemaForEmbedding,
  selectCodexReviewModelCommandJsonSchema,
  type ApiError,
  type CodexReviewModelPreference,
  type SelectCodexReviewModelCommand,
} from "@kestrel/contracts";
import {
  readCodexReviewModelPreference,
  selectCodexReviewModel,
  type DatabasePool,
} from "@kestrel/database";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import type { CodexAgentRuntimePort } from "../codex-app-server.js";
import { withRequestCancellation } from "../request-cancellation.js";

export class ReviewModelPreferenceError extends Error {
  constructor(public readonly code: "model_unavailable") {
    super(`Codex review model preference failed: ${code}`);
    this.name = "ReviewModelPreferenceError";
  }
}

export interface CodexReviewModelPreferenceService {
  read(): Promise<CodexReviewModelPreference>;
  select(
    command: SelectCodexReviewModelCommand,
    signal?: AbortSignal,
  ): Promise<CodexReviewModelPreference>;
}

export function createDatabaseCodexReviewModelPreferenceService(
  pool: DatabasePool,
  runtime: CodexAgentRuntimePort,
): CodexReviewModelPreferenceService {
  return {
    read: () => readCodexReviewModelPreference(pool),
    async select(command, signal) {
      const connection = await runtime.readConnection(signal);
      if (!connection.models.some(({ id }) => id === command.modelId)) {
        throw new ReviewModelPreferenceError("model_unavailable");
      }
      return selectCodexReviewModel(pool, command.modelId);
    },
  };
}

function apiError(request: FastifyRequest, code: ApiError["code"], message: string) {
  return ApiErrorSchema.parse({ schemaVersion: 1, code, message, correlationId: request.id });
}

export function registerCodexReviewModelPreferenceRoutes(
  app: FastifyInstance,
  service: CodexReviewModelPreferenceService,
): void {
  app.get(
    "/api/v1/settings/review-model",
    {
      schema: {
        response: {
          200: jsonSchemaForEmbedding(codexReviewModelPreferenceJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      try {
        return CodexReviewModelPreferenceSchema.parse(await service.read());
      } catch (error) {
        request.log.error({ err: error, event: "review_model_preference.read_failed" });
        return reply
          .code(503)
          .send(apiError(request, "SERVICE_UNAVAILABLE", "Review model preference is unavailable"));
      }
    },
  );

  app.put(
    "/api/v1/settings/review-model",
    {
      bodyLimit: 256,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        body: jsonSchemaForEmbedding(selectCodexReviewModelCommandJsonSchema),
        response: {
          200: jsonSchemaForEmbedding(codexReviewModelPreferenceJsonSchema),
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          403: jsonSchemaForEmbedding(apiErrorJsonSchema),
          409: jsonSchemaForEmbedding(apiErrorJsonSchema),
          413: jsonSchemaForEmbedding(apiErrorJsonSchema),
          415: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      const command = SelectCodexReviewModelCommandSchema.safeParse(request.body);
      if (!command.success) {
        return reply
          .code(400)
          .send(apiError(request, "INVALID_REQUEST", "The review model selection is invalid"));
      }
      try {
        return CodexReviewModelPreferenceSchema.parse(
          await withRequestCancellation(request, reply, (signal) =>
            service.select(command.data, signal),
          ),
        );
      } catch (error) {
        if (error instanceof ReviewModelPreferenceError) {
          return reply
            .code(409)
            .send(
              apiError(
                request,
                "REQUEST_REJECTED",
                "The selected Codex model is no longer available",
              ),
            );
        }
        request.log.error({ err: error, event: "review_model_preference.select_failed" });
        return reply
          .code(503)
          .send(apiError(request, "SERVICE_UNAVAILABLE", "Review model preference is unavailable"));
      }
    },
  );
}
