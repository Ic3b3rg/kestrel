import {
  createCodexAppServerAgentRuntime,
  type CodexAgentRuntimePort,
} from "../codex-app-server.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ApiErrorSchema,
  FactoryReviewCorrectionCommandSchema,
  FactoryReviewCorrectionCurrentSchema,
  FactoryReviewCorrectionSchema,
  KestrelIdSchema,
  RetryFactoryReviewCorrectionCommandSchema,
  type ApiError,
  type FactoryReviewCorrection,
  type FactoryReviewCorrectionCommand,
  type FactoryReviewCorrectionCurrent,
} from "@kestrel/contracts";
import {
  FactoryError,
  FactoryReviewCorrectionError,
  observePublishedFactoryConceptualReviewHead,
  readCurrentFactoryReviewCorrection,
  readFactoryConceptualReviewWorkflow,
  readFactoryConceptualReviewWorkflowPullRequest,
  replayFactoryReviewCorrectionRequest,
  requestFactoryReviewCorrection,
  retryFactoryReviewCorrection,
  type DatabasePool,
  type DiagnosticJobSender,
} from "@kestrel/database";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import {
  createFactoryFeatureGitHubAdapter,
  type FactoryFeatureGitHubAdapter,
} from "../factory-feature-github.js";
import { FactoryGitHubError } from "../factory-github.js";

export interface FactoryReviewCorrectionContext {
  projectId: string;
  featureId: string;
}

export interface FactoryReviewCorrectionService {
  current(context: FactoryReviewCorrectionContext): Promise<FactoryReviewCorrectionCurrent>;
  request(
    context: FactoryReviewCorrectionContext,
    command: FactoryReviewCorrectionCommand,
    actorId: string,
  ): Promise<FactoryReviewCorrection>;
  retry(
    context: FactoryReviewCorrectionContext,
    correctionId: string,
    actorId: string,
    requestId: string,
  ): Promise<FactoryReviewCorrection>;
}

export function createDatabaseFactoryReviewCorrectionService(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  github: Pick<
    FactoryFeatureGitHubAdapter,
    "observePullRequest"
  > = createFactoryFeatureGitHubAdapter(),
  connection: Pick<CodexAgentRuntimePort, "readConnection"> = createCodexAppServerAgentRuntime(),
): FactoryReviewCorrectionService {
  return {
    current: ({ projectId, featureId }) =>
      readCurrentFactoryReviewCorrection(pool, projectId, featureId),
    async request({ projectId, featureId }, command, actorId) {
      const replay = await replayFactoryReviewCorrectionRequest(
        pool,
        projectId,
        featureId,
        actorId,
        command,
      );
      if (replay !== null) return replay;
      const selected = await readFactoryConceptualReviewWorkflow(
        pool,
        projectId,
        featureId,
        command.review.workflowId,
      );
      if (selected === null) throw new FactoryReviewCorrectionError("review_outdated");
      const pullRequest = await readFactoryConceptualReviewWorkflowPullRequest(
        pool,
        command.review.workflowId,
      );
      const observation = await github.observePullRequest(
        { repository: pullRequest.repository, account: pullRequest.author },
        pullRequest,
      );
      await observePublishedFactoryConceptualReviewHead(
        pool,
        command.review.workflowId,
        observation.headCommitId,
      );
      if (
        observation.state !== "open" ||
        observation.baseCommitId !== pullRequest.baseCommitId ||
        observation.headCommitId !== command.review.headCommitId
      )
        throw new FactoryReviewCorrectionError("review_outdated");
      return requestFactoryReviewCorrection(
        pool,
        boss,
        projectId,
        featureId,
        actorId,
        command,
        await connection.readConnection(),
      );
    },
    retry: ({ projectId, featureId }, correctionId, actorId, requestId) =>
      retryFactoryReviewCorrection(pool, projectId, featureId, correctionId, actorId, requestId),
  };
}

const params = z.strictObject({ projectId: KestrelIdSchema, featureId: KestrelIdSchema });
const correctionParams = params.extend({ correctionId: KestrelIdSchema });
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7" });
const errors = {
  400: json(ApiErrorSchema),
  401: json(ApiErrorSchema),
  404: json(ApiErrorSchema),
  409: json(ApiErrorSchema),
  500: json(ApiErrorSchema),
  503: json(ApiErrorSchema),
};

function apiError(request: FastifyRequest, code: ApiError["code"], message: string) {
  return ApiErrorSchema.parse({ schemaVersion: 1, code, message, correlationId: request.id });
}

function failure(request: FastifyRequest, error: unknown) {
  if (error instanceof z.ZodError)
    return {
      status: 400 as const,
      body: apiError(request, "INVALID_REQUEST", "The correction request is invalid"),
    };
  if (error instanceof FactoryReviewCorrectionError) {
    if (error.code === "not_found")
      return {
        status: 404 as const,
        body: apiError(request, "NOT_FOUND", "The correction is unavailable"),
      };
    return {
      status: 409 as const,
      body: apiError(
        request,
        "REQUEST_REJECTED",
        error.code === "review_outdated"
          ? "The selected review no longer matches the pull request head"
          : "The correction cannot be accepted in its current state",
      ),
    };
  }
  if (error instanceof FactoryError) {
    if (error.code === "not_found")
      return {
        status: 404 as const,
        body: apiError(request, "NOT_FOUND", "The Feature is unavailable"),
      };
    if (error.code === "conflict")
      return {
        status: 409 as const,
        body: apiError(
          request,
          "REQUEST_REJECTED",
          error.detail ?? "The correction conflicts with current state",
        ),
      };
  }
  if (error instanceof FactoryGitHubError)
    return {
      status: 503 as const,
      body: apiError(request, "SERVICE_UNAVAILABLE", "GitHub could not verify the current head"),
    };
  request.log.error({ err: error, event: "factory_review_correction.failed" });
  return {
    status: 500 as const,
    body: apiError(request, "INTERNAL_ERROR", "The correction request failed"),
  };
}

export function registerFactoryReviewCorrectionRoutes(
  app: FastifyInstance,
  service: FactoryReviewCorrectionService,
) {
  const root = "/api/v1/projects/:projectId/features/:featureId/review/corrections";
  app.get(
    `${root}/current`,
    {
      schema: {
        params: json(params),
        response: { ...errors, 200: json(FactoryReviewCorrectionCurrentSchema) },
      },
    },
    async (request, reply) => {
      try {
        return FactoryReviewCorrectionCurrentSchema.parse(
          await service.current(params.parse(request.params)),
        );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
  app.post(
    root,
    {
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      bodyLimit: 16_384,
      schema: {
        params: json(params),
        body: json(FactoryReviewCorrectionCommandSchema),
        response: { ...errors, 202: json(FactoryReviewCorrectionSchema) },
      },
    },
    async (request, reply) => {
      try {
        const actorId = request.operatorSession?.operator.id;
        if (actorId === undefined) throw new Error("Authenticated correction has no Operator");
        const result = await service.request(
          params.parse(request.params),
          FactoryReviewCorrectionCommandSchema.parse(request.body),
          actorId,
        );
        return await reply.code(202).send(FactoryReviewCorrectionSchema.parse(result));
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
  app.post(
    `${root}/:correctionId/retry`,
    {
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      bodyLimit: 512,
      schema: {
        params: json(correctionParams),
        body: json(RetryFactoryReviewCorrectionCommandSchema),
        response: { ...errors, 202: json(FactoryReviewCorrectionSchema) },
      },
    },
    async (request, reply) => {
      try {
        const { projectId, featureId, correctionId } = correctionParams.parse(request.params);
        const actorId = request.operatorSession?.operator.id;
        if (actorId === undefined) throw new Error("Authenticated retry has no Operator");
        const { requestId } = RetryFactoryReviewCorrectionCommandSchema.parse(request.body);
        return await reply
          .code(202)
          .send(
            FactoryReviewCorrectionSchema.parse(
              await service.retry({ projectId, featureId }, correctionId, actorId, requestId),
            ),
          );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
}
