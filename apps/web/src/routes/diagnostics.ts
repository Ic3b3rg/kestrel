import type { FastifyInstance } from "fastify";

import {
  apiErrorJsonSchema,
  diagnosticAcceptedJsonSchema,
  diagnosticCommandJsonSchema,
  jsonSchemaForEmbedding,
} from "@kestrel/contracts";
import {
  enqueueDiagnostic,
  InstallationTransitionConflictError,
  type DatabasePool,
  type DiagnosticJobSender,
} from "@kestrel/database";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";

export function registerDiagnosticRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  retentionLimit: number,
): void {
  app.post(
    "/api/v1/installation/diagnostics",
    {
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        body: jsonSchemaForEmbedding(diagnosticCommandJsonSchema),
        response: {
          202: jsonSchemaForEmbedding(diagnosticAcceptedJsonSchema),
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          409: jsonSchemaForEmbedding(apiErrorJsonSchema),
          413: jsonSchemaForEmbedding(apiErrorJsonSchema),
          415: jsonSchemaForEmbedding(apiErrorJsonSchema),
          500: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      try {
        const accepted = await enqueueDiagnostic(pool, boss, retentionLimit, request.id);
        request.log.info({
          correlationId: request.id,
          diagnosticId: accepted.diagnostic.id,
          event: "diagnostic.queued",
          installationId: accepted.installation.id,
        });
        reply.code(202);
        return accepted;
      } catch (error) {
        if (error instanceof InstallationTransitionConflictError) {
          reply.code(409);
          return {
            schemaVersion: 1,
            code: "INSTALLATION_TRANSITION_CONFLICT",
            message: error.message,
            correlationId: request.id,
          };
        }
        request.log.error({ err: error, event: "diagnostic.enqueue_failed" });
        reply.code(503);
        return {
          schemaVersion: 1,
          code: "SERVICE_UNAVAILABLE",
          message: "The diagnostic service is unavailable",
          correlationId: request.id,
        };
      }
    },
  );
}
