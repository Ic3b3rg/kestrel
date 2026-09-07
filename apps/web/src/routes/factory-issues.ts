import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ApiErrorSchema,
  KestrelIdSchema,
  FactoryGitHubIssuesSchema,
  FactoryIssueImportsSchema,
  ImportFactoryIssuesCommandSchema,
  FactoryIssuePublicationSchema,
  RetryFactoryPublicationCommandSchema,
} from "@kestrel/contracts";
import {
  FactoryError,
  readProjectGitHubCoordinates,
  readFactoryIssueImports,
  readFactoryImportRequest,
  importFactoryIssues,
  readFactoryIssuePublication,
  retryFactoryPublication,
  type DatabasePool,
} from "@kestrel/database";
import {
  createFactoryGitHubAdapter,
  FactoryGitHubError,
  type FactoryGitHubAdapter,
} from "../factory-github.js";
import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import { withRequestCancellation } from "../request-cancellation.js";
import { factoryError } from "./factory-planning.js";

const projectParams = z.strictObject({ projectId: KestrelIdSchema });
const featureParams = projectParams.extend({ featureId: KestrelIdSchema });
const query = z.strictObject({ page: z.coerce.number().int().min(1).max(5).default(1) });
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7" });
const errors = {
  400: json(ApiErrorSchema),
  401: json(ApiErrorSchema),
  403: json(ApiErrorSchema),
  404: json(ApiErrorSchema),
  409: json(ApiErrorSchema),
  413: json(ApiErrorSchema),
  415: json(ApiErrorSchema),
  500: json(ApiErrorSchema),
  503: json(ApiErrorSchema),
};

export function registerFactoryIssueRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  github: FactoryGitHubAdapter = createFactoryGitHubAdapter(),
) {
  app.get(
    "/api/v1/projects/:projectId/github-issues",
    {
      schema: {
        params: json(projectParams),
        querystring: json(query),
        response: { ...errors, 200: json(FactoryGitHubIssuesSchema) },
      },
    },
    async (request, reply) => {
      const { projectId } = projectParams.parse(request.params);
      const { page } = query.parse(request.query);
      try {
        const selected = await pool.query<{ id: string }>(
          "SELECT COALESCE(canonical_project_id, id) AS id FROM projects WHERE id = $1",
          [projectId],
        );
        const canonicalId = selected.rows[0]?.id;
        if (canonicalId === undefined) throw new FactoryError("not_found");
        try {
          const coordinates = await readProjectGitHubCoordinates(pool, canonicalId);
          if (coordinates === null) throw new FactoryGitHubError("project_not_supported");
          return await withRequestCancellation(request, reply, async (signal) => {
            const identity = await github.identify(
              { owner: coordinates.owner, name: coordinates.repository },
              signal,
            );
            const result = await github.listIssues(identity, page, signal);
            return FactoryGitHubIssuesSchema.parse({
              schemaVersion: 1,
              projectId: canonicalId,
              repository: identity.repository,
              state: "available",
              failure: null,
              ...result,
            });
          });
        } catch (error) {
          if (!(error instanceof FactoryGitHubError)) throw error;
          return FactoryGitHubIssuesSchema.parse({
            schemaVersion: 1,
            projectId: canonicalId,
            repository: null,
            state: "unavailable",
            failure: error.failure,
            issues: [],
            page,
            nextPage: null,
            limited: false,
          });
        }
      } catch (error) {
        const failure = factoryError(request, error);
        return await reply.code(failure.status).send(failure.body);
      }
    },
  );

  app.get(
    "/api/v1/projects/:projectId/features/:featureId/imports",
    {
      schema: {
        params: json(featureParams),
        response: { ...errors, 200: json(FactoryIssueImportsSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId } = featureParams.parse(request.params);
      try {
        return await readFactoryIssueImports(pool, projectId, featureId);
      } catch (error) {
        const failure = factoryError(request, error);
        return await reply.code(failure.status).send(failure.body);
      }
    },
  );

  app.post(
    "/api/v1/projects/:projectId/features/:featureId/imports",
    {
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      bodyLimit: 1024,
      schema: {
        params: json(featureParams),
        body: json(ImportFactoryIssuesCommandSchema),
        response: { ...errors, 201: json(FactoryIssueImportsSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId } = featureParams.parse(request.params);
      const command = ImportFactoryIssuesCommandSchema.parse(request.body);
      try {
        const duplicate = await readFactoryImportRequest(pool, projectId, featureId, command);
        if (duplicate !== null) return await reply.code(201).send(duplicate);
        const current = await readFactoryIssueImports(pool, projectId, featureId);
        if (!current.canImport)
          throw new FactoryError(
            "conflict",
            "Import before the first saved plan, with no planning turn in progress",
          );
        const coordinates = await readProjectGitHubCoordinates(pool, current.feature.projectId);
        if (coordinates === null) throw new FactoryGitHubError("project_not_supported");
        const snapshots = await withRequestCancellation(request, reply, async (requestSignal) => {
          const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(60_000)]);
          const identity = await github.identify(
            { owner: coordinates.owner, name: coordinates.repository },
            signal,
          );
          const results = [];
          for (let start = 0; start < command.issueNumbers.length; start += 4)
            results.push(
              ...(await Promise.all(
                command.issueNumbers
                  .slice(start, start + 4)
                  .map((number) => github.readIssue(identity, number, signal)),
              )),
            );
          return results;
        });
        return await reply
          .code(201)
          .send(await importFactoryIssues(pool, projectId, featureId, command, snapshots));
      } catch (error) {
        if (error instanceof FactoryGitHubError)
          return await reply.code(503).send(
            ApiErrorSchema.parse({
              schemaVersion: 1,
              code: "SERVICE_UNAVAILABLE",
              message: `GitHub issue import is unavailable: ${error.failure}`,
              correlationId: request.id,
            }),
          );
        const failure = factoryError(request, error);
        return await reply.code(failure.status).send(failure.body);
      }
    },
  );

  app.get(
    "/api/v1/projects/:projectId/features/:featureId/publication",
    {
      schema: {
        params: json(featureParams),
        response: { ...errors, 200: json(FactoryIssuePublicationSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId } = featureParams.parse(request.params);
      try {
        return await readFactoryIssuePublication(pool, projectId, featureId);
      } catch (error) {
        const failure = factoryError(request, error);
        return await reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/features/:featureId/publication",
    {
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      bodyLimit: 256,
      schema: {
        params: json(featureParams),
        body: json(RetryFactoryPublicationCommandSchema),
        response: { ...errors, 202: json(FactoryIssuePublicationSchema) },
      },
    },
    async (request, reply) => {
      const { projectId, featureId } = featureParams.parse(request.params);
      try {
        const result = await retryFactoryPublication(
          pool,
          projectId,
          featureId,
          RetryFactoryPublicationCommandSchema.parse(request.body).requestId,
        );
        return await reply.code(202).send(result);
      } catch (error) {
        const failure = factoryError(request, error);
        return await reply.code(failure.status).send(failure.body);
      }
    },
  );
}
