import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  ApiErrorSchema,
  HostGitHubProjectInboxSchema,
  KestrelIdSchema,
  ObserveHostGitHubPullRequestCommandSchema,
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
  type HostGitHubProjectInbox,
} from "@kestrel/contracts";
import {
  readProjectInbox,
  readProjectGitHubCoordinates,
  upsertPublicGitHubProject,
  upsertHostGitHubProject,
  type ChangeOverviewRenderingJobCoordinator,
  type DatabasePool,
  type UpsertPublicGitHubProjectInput,
} from "@kestrel/database";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import {
  PublicGitHubReadError,
  createPublicGitHubReader,
  type PublicGitHubReader,
} from "../public-github.js";
import { createHostGitHubCli, HostGitHubError } from "../host-github.js";

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

export interface HostGitHubProjectService {
  read(projectId: string, refresh: boolean, signal?: AbortSignal): Promise<HostGitHubProjectInbox>;
  observe(
    projectId: string,
    number: number,
    context: ProjectServiceContext,
    signal?: AbortSignal,
  ): Promise<ProjectUpserted>;
}

export function createHostGitHubProjectService(
  pool: DatabasePool,
  renderingCoordinator: ChangeOverviewRenderingJobCoordinator,
): HostGitHubProjectService {
  const cli = createHostGitHubCli();
  const cache = new Map<string, { expiresAt: number; value: HostGitHubProjectInbox }>();
  const coordinates = async (projectId: string) => {
    const value = await readProjectGitHubCoordinates(pool, projectId);
    if (value === null) throw new HostGitHubError("project_not_supported");
    return value;
  };
  return {
    async read(projectId, refresh, signal) {
      const projectCoordinates = await coordinates(projectId);
      const prefix = `${projectCoordinates.installationId}\0${projectId}\0github.com\0`;
      if (refresh) {
        for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
      }
      let value: HostGitHubProjectInbox;
      let executableVersion: string | null = null;
      try {
        executableVersion = await cli.readVersion(signal);
        const account = await cli.readActiveAccount(signal);
        const key = `${prefix}${account}`;
        const cached = cache.get(key);
        if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
        value = await cli.readProjectInbox(projectId, projectCoordinates, signal);
        if (value.status.account !== account) throw new HostGitHubError("access_denied");
        cache.set(key, { expiresAt: Date.now() + 30_000, value });
      } catch (error) {
        if (!(error instanceof HostGitHubError) || error.kind === "project_not_supported")
          throw error;
        return HostGitHubProjectInboxSchema.parse({
          schemaVersion: 1,
          projectId,
          route: "host_gh",
          limitations: ["Manual refresh only", "The failed observation was not cached"],
          status: {
            executableVersion,
            availability: error.kind === "unavailable" ? "unavailable" : "available",
            host: "github.com",
            authentication:
              error.kind === "needs_authentication"
                ? "needs_authentication"
                : error.kind === "access_denied"
                  ? "access_denied"
                  : "unknown",
            account: null,
          },
          pullRequests: [],
          observedAt: new Date().toISOString(),
        });
      }
      return value;
    },
    async observe(projectId, number, context, signal) {
      const projectCoordinates = await coordinates(projectId);
      const status = await cli.readProjectInbox(projectId, projectCoordinates, signal);
      const account = status.status.account;
      if (account === null) throw new HostGitHubError("needs_authentication");
      const observation = await cli.observePullRequest(projectCoordinates, number, account, signal);
      return upsertHostGitHubProject(
        pool,
        {
          ...context,
          observation,
          route: {
            kind: "host_gh",
            host: status.status.host,
            account: status.status.account ?? "",
          },
        },
        renderingCoordinator,
      );
    },
  };
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

export function createDatabaseProjectService(
  pool: DatabasePool,
  renderingCoordinator: ChangeOverviewRenderingJobCoordinator,
): ProjectService {
  return createProjectService(createPublicGitHubReader(), {
    readInbox: () => readProjectInbox(pool),
    upsert: (input) => upsertPublicGitHubProject(pool, input, renderingCoordinator),
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

async function withRequestCancellation<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  try {
    return await task(controller.signal);
  } finally {
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
  }
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

export function registerProjectRoutes(
  app: FastifyInstance,
  service: ProjectService,
  hostGitHub?: HostGitHubProjectService,
): void {
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

  if (hostGitHub === undefined) return;
  app.get("/api/v1/projects/:projectId/provider/github", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const parsed = KestrelIdSchema.safeParse(projectId);
    if (!parsed.success)
      return reply
        .code(400)
        .send(apiError(request, "INVALID_REQUEST", "The Project ID is invalid"));
    try {
      return HostGitHubProjectInboxSchema.parse(
        await withRequestCancellation(request, reply, (signal) =>
          hostGitHub.read(
            parsed.data,
            (request.query as { refresh?: string }).refresh === "true",
            signal,
          ),
        ),
      );
    } catch (error) {
      if (error instanceof HostGitHubError) {
        request.log.warn({ event: "project.host_github_read_failed", kind: error.kind });
        return reply
          .code(error.kind === "access_denied" ? 404 : 503)
          .send(
            apiError(
              request,
              error.kind === "access_denied" ? "NOT_FOUND" : "SERVICE_UNAVAILABLE",
              "Host GitHub observation is unavailable",
            ),
          );
      }
      throw error;
    }
  });
  app.post(
    "/api/v1/projects/:projectId/provider/github/pull-requests/observe",
    { bodyLimit: 128, config: AUTHENTICATED_MUTATION_ROUTE_CONFIG },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const parsedProject = KestrelIdSchema.safeParse(projectId);
      const parsedCommand = ObserveHostGitHubPullRequestCommandSchema.safeParse(request.body);
      if (!parsedProject.success || !parsedCommand.success)
        return reply
          .code(400)
          .send(apiError(request, "INVALID_REQUEST", "The observation request is invalid"));
      const session = request.operatorSession;
      if (session === null)
        throw new Error("Authenticated host GitHub route has no Operator session");
      try {
        return ProjectUpsertedSchema.parse(
          await withRequestCancellation(request, reply, (signal) =>
            hostGitHub.observe(
              parsedProject.data,
              parsedCommand.data.number,
              { actorId: session.operator.id, correlationId: request.id },
              signal,
            ),
          ),
        );
      } catch (error) {
        if (error instanceof HostGitHubError)
          return reply
            .code(503)
            .send(
              apiError(request, "SERVICE_UNAVAILABLE", "Host GitHub observation is unavailable"),
            );
        throw error;
      }
    },
  );
}
