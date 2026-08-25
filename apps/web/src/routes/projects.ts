import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  ApiErrorSchema,
  OpenPublicGitHubPullRequestCommandSchema,
  ProjectInboxSchema,
  ProjectUpsertedSchema,
  apiErrorJsonSchema,
  jsonSchemaForEmbedding,
  openPublicGitHubPullRequestCommandJsonSchema,
  projectInboxJsonSchema,
  projectUpsertedJsonSchema,
  type OpenPublicGitHubPullRequestCommand,
  type ProjectInbox,
  type ProjectUpserted,
} from "@kestrel/contracts";
import {
  readProjectInbox,
  upsertPublicGitHubProject,
  type DatabasePool,
  type UpsertPublicGitHubProjectInput,
} from "@kestrel/database";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import {
  PublicGitHubReadError,
  createPublicGitHubReader,
  type PublicGitHubReader,
} from "../public-github.js";

export interface ProjectServiceContext {
  actorId: string;
  correlationId: string;
}

export interface ProjectService {
  openPublicGitHubPullRequest(
    command: OpenPublicGitHubPullRequestCommand,
    context: ProjectServiceContext,
  ): Promise<ProjectUpserted>;
  readInbox(): Promise<ProjectInbox>;
}

export interface ProjectStore {
  readInbox(): Promise<ProjectInbox>;
  upsert(input: UpsertPublicGitHubProjectInput): Promise<ProjectUpserted>;
}

export function createProjectService(
  reader: PublicGitHubReader,
  store: ProjectStore,
): ProjectService {
  return {
    async openPublicGitHubPullRequest(command, context) {
      const observation = await reader.read(command.url);
      return store.upsert({ ...context, observation });
    },
    readInbox: () => store.readInbox(),
  };
}

export function createDatabaseProjectService(pool: DatabasePool): ProjectService {
  return createProjectService(createPublicGitHubReader(), {
    readInbox: () => readProjectInbox(pool),
    upsert: (input) => upsertPublicGitHubProject(pool, input),
  });
}

function apiError(
  request: FastifyRequest,
  code: "INVALID_REQUEST" | "NOT_FOUND" | "RATE_LIMITED" | "SERVICE_UNAVAILABLE",
  message: string,
) {
  return ApiErrorSchema.parse({
    schemaVersion: 1,
    code,
    message,
    correlationId: request.id,
  });
}

function rateLimitRetryAfter(reset: string | null): string {
  if (reset === null) {
    return "60";
  }
  const seconds = Number(reset) - Math.floor(Date.now() / 1_000);
  return String(Math.max(1, Math.min(3_600, seconds)));
}

function sendPublicGitHubError(
  error: PublicGitHubReadError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  switch (error.kind) {
    case "redirected":
      return reply
        .code(400)
        .send(
          apiError(
            request,
            "INVALID_REQUEST",
            "GitHub redirected this pull request; use its current canonical URL",
          ),
        );
    case "not_found":
      return reply
        .code(404)
        .send(apiError(request, "NOT_FOUND", "The public pull request is unavailable"));
    case "rate_limited":
      return reply
        .header("Retry-After", rateLimitRetryAfter(error.rateLimitReset))
        .code(429)
        .send(
          apiError(request, "RATE_LIMITED", "GitHub public access is temporarily rate limited"),
        );
    case "invalid_response":
    case "unavailable":
      return reply
        .code(503)
        .send(apiError(request, "SERVICE_UNAVAILABLE", "Public GitHub access is unavailable"));
  }
}

export function registerProjectRoutes(app: FastifyInstance, service: ProjectService): void {
  app.get(
    "/api/v1/projects",
    {
      schema: {
        response: {
          200: jsonSchemaForEmbedding(projectInboxJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      try {
        return ProjectInboxSchema.parse(await service.readInbox());
      } catch (error) {
        request.log.error({ err: error, event: "project.inbox_unavailable" });
        return reply
          .code(503)
          .send(apiError(request, "SERVICE_UNAVAILABLE", "Project storage is unavailable"));
      }
    },
  );

  app.post(
    "/api/v1/projects",
    {
      bodyLimit: 512,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        body: jsonSchemaForEmbedding(openPublicGitHubPullRequestCommandJsonSchema),
        response: {
          200: jsonSchemaForEmbedding(projectUpsertedJsonSchema),
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          403: jsonSchemaForEmbedding(apiErrorJsonSchema),
          404: jsonSchemaForEmbedding(apiErrorJsonSchema),
          413: jsonSchemaForEmbedding(apiErrorJsonSchema),
          415: jsonSchemaForEmbedding(apiErrorJsonSchema),
          429: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      const command = OpenPublicGitHubPullRequestCommandSchema.parse(request.body);
      const session = request.operatorSession;
      if (session === null) {
        throw new Error("Authenticated Project route has no Operator session");
      }
      try {
        return ProjectUpsertedSchema.parse(
          await service.openPublicGitHubPullRequest(command, {
            actorId: session.operator.id,
            correlationId: request.id,
          }),
        );
      } catch (error) {
        if (error instanceof PublicGitHubReadError) {
          request.log.warn({ event: "project.public_github_read_failed", kind: error.kind });
          return sendPublicGitHubError(error, request, reply);
        }
        request.log.error({ err: error, event: "project.public_github_open_failed" });
        return reply
          .code(503)
          .send(apiError(request, "SERVICE_UNAVAILABLE", "Project storage is unavailable"));
      }
    },
  );
}
