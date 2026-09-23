import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiErrorSchema, KestrelIdSchema, ProjectBoardSnapshotSchema } from "@kestrel/contracts";
import type { DatabasePool } from "@kestrel/database";
import { createFactoryGitHubAdapter, type FactoryGitHubAdapter } from "../factory-github.js";
import { createProjectBoardService } from "../project-board.js";
import { withRequestCancellation } from "../request-cancellation.js";
import { factoryError } from "./factory-planning.js";

const params = z.strictObject({ projectId: KestrelIdSchema });
const query = z.strictObject({ refreshProvider: z.enum(["0", "1"]).default("0") });
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7" });

export function registerProjectBoardRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  github: FactoryGitHubAdapter = createFactoryGitHubAdapter(),
) {
  const service = createProjectBoardService(pool, github);
  app.get(
    "/api/v1/projects/:projectId/board",
    {
      schema: {
        params: json(params),
        querystring: json(query),
        response: {
          200: json(ProjectBoardSnapshotSchema),
          400: json(ApiErrorSchema),
          401: json(ApiErrorSchema),
          404: json(ApiErrorSchema),
          409: json(ApiErrorSchema),
          500: json(ApiErrorSchema),
          503: json(ApiErrorSchema),
        },
      },
    },
    async (request, reply) => {
      try {
        const { projectId } = params.parse(request.params);
        const { refreshProvider } = query.parse(request.query);
        return await withRequestCancellation(request, reply, (signal) =>
          service.read(projectId, signal, refreshProvider === "1"),
        );
      } catch (error) {
        const failure = factoryError(request, error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
}
