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

export function registerDiagnosticRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  retentionLimit: number,
): void {
  app.post(
    "/api/v1/installation/diagnostics",
    {
      schema: {
        body: jsonSchemaForEmbedding(diagnosticCommandJsonSchema),
        response: {
          202: jsonSchemaForEmbedding(diagnosticAcceptedJsonSchema),
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          409: jsonSchemaForEmbedding(apiErrorJsonSchema),
          500: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      try {
        const accepted = await enqueueDiagnostic(pool, boss, retentionLimit, request.id);
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
        throw error;
      }
    },
  );
}
