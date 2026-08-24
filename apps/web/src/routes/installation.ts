import type { FastifyInstance } from "fastify";

import {
  apiErrorJsonSchema,
  InstallationSnapshotSchema,
  installationSnapshotJsonSchema,
  jsonSchemaForEmbedding,
} from "@kestrel/contracts";
import { readInstallationSnapshot, type DatabasePool } from "@kestrel/database";

export function registerInstallationRoutes(app: FastifyInstance, pool: DatabasePool): void {
  app.get(
    "/api/v1/installation",
    {
      schema: {
        response: {
          200: jsonSchemaForEmbedding(installationSnapshotJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      try {
        return InstallationSnapshotSchema.parse(await readInstallationSnapshot(pool));
      } catch {
        request.log.warn({ event: "installation.read_failed" });
        return reply.code(503).send({
          schemaVersion: 1,
          code: "SERVICE_UNAVAILABLE",
          message: "Installation state is unavailable",
          correlationId: request.id,
        });
      }
    },
  );
}
