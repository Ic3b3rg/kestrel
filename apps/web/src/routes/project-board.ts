import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ApiErrorSchema,
  KestrelIdSchema,
  ProjectBoardSnapshotSchema,
  ProjectBoardSettingsSchema,
  ProjectIssueDiscussionSchema,
  StartProjectIssueCommandSchema,
} from "@kestrel/contracts";
import {
  changeIssueDispatch,
  FactoryError,
  readProjectBoardSettings,
  saveProjectBoardSettings,
  findProjectIssueStart,
  enqueueProjectIssue,
  type DatabasePool,
} from "@kestrel/database";
import {
  FactoryGitHubError,
  createFactoryGitHubAdapter,
  type FactoryGitHubAdapter,
} from "../factory-github.js";
import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import { createProjectIssueReader } from "../project-issue-reader.js";
import { createProjectBoardService } from "../project-board.js";
import { withRequestCancellation } from "../request-cancellation.js";
import { factoryError } from "./factory-planning.js";

const params = z.strictObject({ projectId: KestrelIdSchema });
const query = z.strictObject({ refreshProvider: z.enum(["0", "1"]).default("0") });
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7" });
const errors = {
  400: json(ApiErrorSchema),
  401: json(ApiErrorSchema),
  404: json(ApiErrorSchema),
  409: json(ApiErrorSchema),
  500: json(ApiErrorSchema),
  503: json(ApiErrorSchema),
};

export function registerProjectBoardRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  github: FactoryGitHubAdapter = createFactoryGitHubAdapter(),
) {
  const service = createProjectBoardService(pool, github);
  const readIssue = createProjectIssueReader(pool, github);
  const failureReply = (request: Parameters<typeof factoryError>[0], error: unknown) =>
    factoryError(
      request,
      error instanceof FactoryGitHubError
        ? new FactoryError(
            "unavailable",
            `GitHub issue access is unavailable (${error.failure.replaceAll("_", " ")}). Retry after access is restored.`,
          )
        : error,
    );
  app.get(
    "/api/v1/projects/:projectId/board/settings",
    {
      schema: {
        params: json(params),
        response: { ...errors, 200: json(ProjectBoardSettingsSchema) },
      },
    },
    async (request, reply) => {
      try {
        return await readProjectBoardSettings(pool, params.parse(request.params).projectId);
      } catch (error) {
        const f = failureReply(request, error);
        return reply.code(f.status).send(f.body);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/board/settings",
    {
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      bodyLimit: 1024,
      schema: {
        params: json(params),
        body: json(ProjectBoardSettingsSchema),
        response: { ...errors, 200: json(ProjectBoardSettingsSchema) },
      },
    },
    async (request, reply) => {
      try {
        return await saveProjectBoardSettings(
          pool,
          params.parse(request.params).projectId,
          request.body,
        );
      } catch (error) {
        const f = failureReply(request, error);
        return reply.code(f.status).send(f.body);
      }
    },
  );
  const issueParams = params.extend({ number: z.coerce.number().int().positive().max(2147483647) });
  const issueQuery = z.strictObject({ page: z.coerce.number().int().min(1).max(1000).default(1) });
  app.get(
    "/api/v1/projects/:projectId/board/issues/:number",
    {
      schema: {
        params: json(issueParams),
        querystring: json(issueQuery),
        response: { ...errors, 200: json(ProjectIssueDiscussionSchema) },
      },
    },
    async (request, reply) => {
      try {
        const p = issueParams.parse(request.params);
        return await readIssue(p.projectId, p.number, issueQuery.parse(request.query).page);
      } catch (error) {
        const f = failureReply(request, error);
        return reply.code(f.status).send(f.body);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/board/start",
    {
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      bodyLimit: 1024,
      schema: {
        params: json(params),
        body: json(StartProjectIssueCommandSchema),
        response: { ...errors, 202: json(z.strictObject({ id: KestrelIdSchema })) },
      },
    },
    async (request, reply) => {
      try {
        const { projectId } = params.parse(request.params);
        const command = StartProjectIssueCommandSchema.parse(request.body);
        const actor = request.operatorSession?.operator.id;
        if (actor === undefined) throw new Error("Authenticated board start has no Operator");
        const replay = await findProjectIssueStart(pool, projectId, actor, command);
        const id =
          replay ??
          (await enqueueProjectIssue(
            pool,
            projectId,
            actor,
            command,
            (await readIssue(projectId, command.issueNumber, 1, true)).issue,
          ));
        return await reply.code(202).send({ id });
      } catch (error) {
        const f = failureReply(request, error);
        return reply.code(f.status).send(f.body);
      }
    },
  );
  for (const action of ["retry", "cancel"] as const) {
    const startParams = params.extend({ id: KestrelIdSchema });
    app.post(
      `/api/v1/projects/:projectId/board/starts/:id/${action}`,
      {
        config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
        bodyLimit: 256,
        schema: {
          params: json(startParams),
          body: json(z.strictObject({})),
          response: { ...errors, 200: json(z.strictObject({ id: KestrelIdSchema })) },
        },
      },
      async (request, reply) => {
        try {
          const p = startParams.parse(request.params);
          return await changeIssueDispatch(pool, p.projectId, p.id, action);
        } catch (error) {
          const f = failureReply(request, error);
          return reply.code(f.status).send(f.body);
        }
      },
    );
  }
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
