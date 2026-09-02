import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  ApiErrorSchema,
  CodexSubscriptionConnectionSchema,
  HostGitHubConnectionSchema,
  KestrelIdSchema,
  apiErrorJsonSchema,
  codexSubscriptionConnectionJsonSchema,
  hostGitHubConnectionJsonSchema,
  jsonSchemaForEmbedding,
  type HostGitHubConnection,
} from "@kestrel/contracts";
import { readProjectGitHubCoordinates, type DatabasePool } from "@kestrel/database";

import { createHostGitHubCli } from "../host-github.js";
import type { CodexAgentRuntimePort } from "../codex-app-server.js";
import { withRequestCancellation } from "../request-cancellation.js";

const QuerySchema = z.strictObject({ projectId: KestrelIdSchema.optional() });

interface HostGitHubConnectionReader {
  readConnection(
    project: {
      projectId: string;
      coordinates: { owner: string; repository: string } | null;
    } | null,
    signal?: AbortSignal,
  ): Promise<HostGitHubConnection>;
}

export interface HostGitHubConnectionService {
  read(projectId: string | null, signal?: AbortSignal): Promise<HostGitHubConnection>;
}

function codexApiError(request: FastifyRequest) {
  return ApiErrorSchema.parse({
    schemaVersion: 1,
    code: "SERVICE_UNAVAILABLE",
    message: "Codex connection verification is unavailable",
    correlationId: request.id,
  });
}

export function registerCodexSubscriptionConnectionRoutes(
  app: FastifyInstance,
  runtime: CodexAgentRuntimePort,
): void {
  app.get(
    "/api/v1/connections/codex",
    {
      schema: {
        response: {
          200: jsonSchemaForEmbedding(codexSubscriptionConnectionJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      try {
        return CodexSubscriptionConnectionSchema.parse(
          await withRequestCancellation(request, reply, (signal) => runtime.readConnection(signal)),
        );
      } catch {
        request.log.error({ event: "connection.codex_probe_failed" });
        return reply.code(503).send(codexApiError(request));
      }
    },
  );
}

export function createHostGitHubConnectionService(
  pool: DatabasePool,
  reader: HostGitHubConnectionReader = createHostGitHubCli(),
): HostGitHubConnectionService {
  return {
    async read(projectId, signal) {
      if (projectId === null) return reader.readConnection(null, signal);
      const coordinates = await readProjectGitHubCoordinates(pool, projectId);
      return reader.readConnection(
        {
          projectId,
          coordinates:
            coordinates === null
              ? null
              : { owner: coordinates.owner, repository: coordinates.repository },
        },
        signal,
      );
    },
  };
}

function apiError(request: FastifyRequest) {
  return ApiErrorSchema.parse({
    schemaVersion: 1,
    code: "SERVICE_UNAVAILABLE",
    message: "GitHub connection verification is unavailable",
    correlationId: request.id,
  });
}

export function registerHostGitHubConnectionRoutes(
  app: FastifyInstance,
  service: HostGitHubConnectionService,
): void {
  app.get(
    "/api/v1/connections/github",
    {
      schema: {
        querystring: {
          additionalProperties: false,
          properties: { projectId: { format: "uuid", type: "string" } },
          type: "object",
        },
        response: {
          200: jsonSchemaForEmbedding(hostGitHubConnectionJsonSchema),
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      const parsed = QuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send(
          ApiErrorSchema.parse({
            schemaVersion: 1,
            code: "INVALID_REQUEST",
            message: "The GitHub connection request is invalid",
            correlationId: request.id,
          }),
        );
      }
      try {
        return HostGitHubConnectionSchema.parse(
          await withRequestCancellation(request, reply, (signal) =>
            service.read(parsed.data.projectId ?? null, signal),
          ),
        );
      } catch {
        request.log.error({ event: "connection.host_github_probe_failed" });
        return reply.code(503).send(apiError(request));
      }
    },
  );
}
