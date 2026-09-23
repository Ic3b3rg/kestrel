import {
  createCodexAppServerAgentRuntime,
  type CodexAgentRuntimePort,
} from "../codex-app-server.js";
import type { CodexSubscriptionConnection } from "@kestrel/contracts";
import { readLifecycleProfile } from "@kestrel/database";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  ApiErrorSchema,
  FactoryConceptualReviewCurrentSchema,
  FactoryConceptualReviewHistorySchema,
  FactoryConceptualReviewPreparationSchema,
  FactoryConceptualReviewSourceLinesSchema,
  FactoryConceptualReviewStartCommandSchema,
  FactoryConceptualReviewWorkflowReadSchema,
  KestrelIdSchema,
  type ApiError,
  type FactoryConceptualReviewCurrent,
  type FactoryConceptualReviewHistory,
  type FactoryConceptualReviewPreparation,
  type FactoryConceptualReviewSourceLines,
  type FactoryConceptualReviewStartCommand,
  type FactoryConceptualReviewWorkflowRead,
} from "@kestrel/contracts";
import {
  FactoryConceptualReviewPersistenceError,
  FactoryConceptualReviewWorkflowPersistenceError,
  readCurrentExternalConceptualReviewWorkflow,
  readExternalConceptualReviewArtifact,
  readExternalConceptualReviewHistory,
  readExternalConceptualReviewPreparation,
  readExternalConceptualReviewSourceReference,
  readExternalConceptualReviewWorkflow,
  readFactoryConceptualReviewWorkflowSourceBinding,
  startExternalConceptualReviewWorkflow,
  type DatabasePool,
  type DiagnosticJobSender,
  type FactoryConceptualReviewRuntimeReadiness,
} from "@kestrel/database";
import {
  ConceptualReviewSourceError,
  LocalSourceError,
  readConceptualReviewSourceLines,
  readRetainedRevisionIdentity,
  type LocalSourceConfig,
} from "@kestrel/local-source";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";

export interface ExternalConceptualReviewContext {
  projectId: string;
  changeProposalId: string;
}

interface SourceLineInput {
  side: "base" | "head";
  path: string;
  startLine: number;
  endLine: number;
}

export interface ExternalConceptualReviewService {
  prepare(context: ExternalConceptualReviewContext): Promise<FactoryConceptualReviewPreparation>;
  start(
    context: ExternalConceptualReviewContext,
    command: FactoryConceptualReviewStartCommand,
    actor: { actorId: string; correlationId: string },
  ): Promise<FactoryConceptualReviewWorkflowRead>;
  current(context: ExternalConceptualReviewContext): Promise<FactoryConceptualReviewCurrent>;
  workflow(
    context: ExternalConceptualReviewContext,
    workflowId: string,
  ): Promise<FactoryConceptualReviewWorkflowRead | null>;
  history(
    context: ExternalConceptualReviewContext,
    input: { offset: number; limit: number },
  ): Promise<FactoryConceptualReviewHistory>;
  artifact(
    context: ExternalConceptualReviewContext,
    artifactId: string,
  ): Promise<FactoryConceptualReviewWorkflowRead | null>;
  workflowSourceLines(
    context: ExternalConceptualReviewContext,
    workflowId: string,
    input: SourceLineInput,
  ): Promise<FactoryConceptualReviewSourceLines>;
  artifactSourceLines(
    context: ExternalConceptualReviewContext,
    artifactId: string,
    input: SourceLineInput,
  ): Promise<FactoryConceptualReviewSourceLines>;
}

export function createDatabaseExternalConceptualReviewService(
  pool: DatabasePool,
  readSourceConfig: () => Promise<LocalSourceConfig>,
  options: {
    boss?: DiagnosticJobSender;
    connection?: Pick<CodexAgentRuntimePort, "readConnection">;
    runtimeProfile?: FactoryConceptualReviewRuntimeReadiness["profile"];
  } = {},
): ExternalConceptualReviewService {
  const connection = options.connection ?? createCodexAppServerAgentRuntime();
  const prepare = async (
    database: DatabasePool,
    context: ExternalConceptualReviewContext,
    catalog: CodexSubscriptionConnection,
  ) => {
    const lifecycle = await readLifecycleProfile(database, "review", context.projectId, catalog);
    const reference = await readExternalConceptualReviewSourceReference(
      database,
      context.projectId,
      context.changeProposalId,
    );
    let verifiedSource = null;
    if (reference !== null) {
      try {
        const config = await readSourceConfig();
        const identity = await readRetainedRevisionIdentity(config, reference);
        if (
          identity.base.commitObjectId === reference.baseCommitId &&
          identity.head.commitObjectId === reference.headCommitId
        ) {
          verifiedSource = {
            revisionId: reference.revisionId,
            manifestDigest: reference.manifestDigest,
            headTreeId: identity.head.treeObjectId,
          };
        }
      } catch (error) {
        if (
          !(error instanceof LocalSourceError) &&
          !(error instanceof ConceptualReviewSourceError)
        ) {
          throw error;
        }
      }
    }
    return readExternalConceptualReviewPreparation(
      database,
      context.projectId,
      context.changeProposalId,
      {
        profile: options.runtimeProfile ?? null,
        lifecycleProfile: lifecycle.resolved,
        profileBlocker: lifecycle.blocked,
      },
      verifiedSource,
    );
  };
  const sourceLines = async (workflowId: string, input: SourceLineInput) => {
    const [config, binding] = await Promise.all([
      readSourceConfig(),
      readFactoryConceptualReviewWorkflowSourceBinding(pool, workflowId),
    ]);
    return FactoryConceptualReviewSourceLinesSchema.parse(
      await readConceptualReviewSourceLines(config, { ...binding, ...input }),
    );
  };
  return {
    prepare: async (context) => prepare(pool, context, await connection.readConnection()),
    async start(context, command, actor) {
      const catalog = await connection.readConnection();
      if (options.boss === undefined) {
        throw new FactoryConceptualReviewWorkflowPersistenceError("not_ready");
      }
      return startExternalConceptualReviewWorkflow(
        pool,
        options.boss,
        { ...context, ...actor, command },
        (database) => prepare(database, context, catalog),
      );
    },
    async current(context) {
      return FactoryConceptualReviewCurrentSchema.parse({
        schemaVersion: 1,
        review: await readCurrentExternalConceptualReviewWorkflow(
          pool,
          context.projectId,
          context.changeProposalId,
        ),
      });
    },
    workflow: (context, workflowId) =>
      readExternalConceptualReviewWorkflow(
        pool,
        context.projectId,
        context.changeProposalId,
        workflowId,
      ),
    history: (context, input) =>
      readExternalConceptualReviewHistory(
        pool,
        context.projectId,
        context.changeProposalId,
        input.offset,
        input.limit,
      ),
    artifact: (context, artifactId) =>
      readExternalConceptualReviewArtifact(
        pool,
        context.projectId,
        context.changeProposalId,
        artifactId,
      ),
    async workflowSourceLines(context, workflowId, input) {
      const workflow = await readExternalConceptualReviewWorkflow(
        pool,
        context.projectId,
        context.changeProposalId,
        workflowId,
      );
      if (workflow === null) throw new FactoryConceptualReviewWorkflowPersistenceError("not_found");
      return sourceLines(workflow.workflow.id, input);
    },
    async artifactSourceLines(context, artifactId, input) {
      const review = await readExternalConceptualReviewArtifact(
        pool,
        context.projectId,
        context.changeProposalId,
        artifactId,
      );
      if (review === null) throw new FactoryConceptualReviewWorkflowPersistenceError("not_found");
      return sourceLines(review.workflow.id, input);
    },
  };
}

const params = z.strictObject({
  projectId: KestrelIdSchema,
  changeProposalId: KestrelIdSchema,
});
const workflowParams = params.extend({ workflowId: KestrelIdSchema });
const artifactParams = params.extend({ artifactId: KestrelIdSchema });
const sourceLinesQuery = z.strictObject({
  side: z.enum(["base", "head"]),
  path: z
    .string()
    .min(1)
    .refine(
      (value) =>
        new TextEncoder().encode(value).length <= 4096 &&
        !/[\p{Cc}\\]/u.test(value) &&
        !/^[a-z][a-z0-9+.-]*:/iu.test(value) &&
        !value.split("/").some((part) => part === "" || part === "." || part === ".."),
    ),
  startLine: z.coerce.number().int().min(1),
  endLine: z.coerce.number().int().min(1),
});
const historyQuery = z.strictObject({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7" });
const errors = {
  400: json(ApiErrorSchema),
  401: json(ApiErrorSchema),
  404: json(ApiErrorSchema),
  409: json(ApiErrorSchema),
  413: json(ApiErrorSchema),
  500: json(ApiErrorSchema),
  503: json(ApiErrorSchema),
};

function apiError(request: FastifyRequest, code: ApiError["code"], message: string) {
  return ApiErrorSchema.parse({ schemaVersion: 1, code, message, correlationId: request.id });
}

function failure(request: FastifyRequest, error: unknown) {
  if (error instanceof z.ZodError) {
    return {
      status: 400 as const,
      body: apiError(request, "INVALID_REQUEST", "The Review request is invalid"),
    };
  }
  if (error instanceof FactoryConceptualReviewPersistenceError) {
    if (error.code === "not_found") {
      return {
        status: 404 as const,
        body: apiError(request, "NOT_FOUND", "The pull request is unavailable"),
      };
    }
    if (error.code === "not_ready") {
      return {
        status: 409 as const,
        body: apiError(request, "REVIEW_NOT_READY", "The exact Review inputs are not ready"),
      };
    }
  }
  if (error instanceof FactoryConceptualReviewWorkflowPersistenceError) {
    if (error.code === "not_found") {
      return {
        status: 404 as const,
        body: apiError(request, "NOT_FOUND", "The Conceptual Review is unavailable"),
      };
    }
    if (error.code === "not_ready") {
      return {
        status: 409 as const,
        body: apiError(request, "REVIEW_NOT_READY", "The exact Review inputs are not ready"),
      };
    }
    if (error.code === "preparation_conflict") {
      return {
        status: 409 as const,
        body: apiError(request, "REVIEW_PREPARATION_CONFLICT", "The Review inputs changed"),
      };
    }
    if (error.code === "active_review") {
      return {
        status: 409 as const,
        body: apiError(request, "REQUEST_REJECTED", "A Conceptual Review is already active"),
      };
    }
  }
  if (error instanceof ConceptualReviewSourceError || error instanceof LocalSourceError) {
    return {
      status: 503 as const,
      body: apiError(request, "SERVICE_UNAVAILABLE", "Retained source is unavailable"),
    };
  }
  request.log.error({ err: error, event: "external_conceptual_review.failed" });
  return {
    status: 503 as const,
    body: apiError(request, "SERVICE_UNAVAILABLE", "Conceptual Review is unavailable"),
  };
}

export function registerExternalConceptualReviewRoutes(
  app: FastifyInstance,
  service: ExternalConceptualReviewService,
): void {
  const root = "/api/v1/projects/:projectId/change-proposals/:changeProposalId/review";

  const preparationHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return FactoryConceptualReviewPreparationSchema.parse(
        await service.prepare(params.parse(request.params)),
      );
    } catch (error) {
      const mapped = failure(request, error);
      return reply.code(mapped.status).send(mapped.body);
    }
  };
  app.get(`${root}/preparation`, {
    schema: {
      params: json(params),
      response: { ...errors, 200: json(FactoryConceptualReviewPreparationSchema) },
    },
    handler: preparationHandler,
  });

  const startHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const context = params.parse(request.params);
      const actorId = request.operatorSession?.operator.id;
      if (actorId === undefined) throw new Error("Authenticated Review start has no Operator");
      const result = await service.start(
        context,
        FactoryConceptualReviewStartCommandSchema.parse(request.body),
        { actorId, correlationId: request.id },
      );
      return await reply.code(202).send(FactoryConceptualReviewWorkflowReadSchema.parse(result));
    } catch (error) {
      const mapped = failure(request, error);
      return reply.code(mapped.status).send(mapped.body);
    }
  };
  app.post(`${root}/workflows`, {
    config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
    bodyLimit: 512,
    schema: {
      params: json(params),
      body: json(FactoryConceptualReviewStartCommandSchema),
      response: { ...errors, 202: json(FactoryConceptualReviewWorkflowReadSchema) },
    },
    handler: startHandler,
  });

  app.get(`${root}/workflows/current`, {
    schema: {
      params: json(params),
      response: { ...errors, 200: json(FactoryConceptualReviewCurrentSchema) },
    },
    handler: async (request, reply) => {
      try {
        return FactoryConceptualReviewCurrentSchema.parse(
          await service.current(params.parse(request.params)),
        );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  });
  app.get(`${root}/workflows/:workflowId`, {
    schema: {
      params: json(workflowParams),
      response: { ...errors, 200: json(FactoryConceptualReviewWorkflowReadSchema) },
    },
    handler: async (request, reply) => {
      try {
        const { workflowId, ...context } = workflowParams.parse(request.params);
        const result = await service.workflow(context, workflowId);
        if (result === null)
          return await reply
            .code(404)
            .send(apiError(request, "NOT_FOUND", "The Conceptual Review is unavailable"));
        return FactoryConceptualReviewWorkflowReadSchema.parse(result);
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  });
  app.get(`${root}/workflows/:workflowId/source/lines`, {
    schema: {
      params: json(workflowParams),
      querystring: json(sourceLinesQuery),
      response: { ...errors, 200: json(FactoryConceptualReviewSourceLinesSchema) },
    },
    handler: async (request, reply) => {
      try {
        const { workflowId, ...context } = workflowParams.parse(request.params);
        return FactoryConceptualReviewSourceLinesSchema.parse(
          await service.workflowSourceLines(
            context,
            workflowId,
            sourceLinesQuery.parse(request.query),
          ),
        );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  });
  app.get(`${root}/artifacts`, {
    schema: {
      params: json(params),
      querystring: json(historyQuery),
      response: { ...errors, 200: json(FactoryConceptualReviewHistorySchema) },
    },
    handler: async (request, reply) => {
      try {
        return FactoryConceptualReviewHistorySchema.parse(
          await service.history(params.parse(request.params), historyQuery.parse(request.query)),
        );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  });
  app.get(`${root}/artifacts/:artifactId`, {
    schema: {
      params: json(artifactParams),
      response: { ...errors, 200: json(FactoryConceptualReviewWorkflowReadSchema) },
    },
    handler: async (request, reply) => {
      try {
        const { artifactId, ...context } = artifactParams.parse(request.params);
        const result = await service.artifact(context, artifactId);
        if (result === null)
          return await reply
            .code(404)
            .send(apiError(request, "NOT_FOUND", "The Conceptual Review artifact is unavailable"));
        return FactoryConceptualReviewWorkflowReadSchema.parse(result);
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  });
  app.get(`${root}/artifacts/:artifactId/source/lines`, {
    schema: {
      params: json(artifactParams),
      querystring: json(sourceLinesQuery),
      response: { ...errors, 200: json(FactoryConceptualReviewSourceLinesSchema) },
    },
    handler: async (request, reply) => {
      try {
        const { artifactId, ...context } = artifactParams.parse(request.params);
        return FactoryConceptualReviewSourceLinesSchema.parse(
          await service.artifactSourceLines(
            context,
            artifactId,
            sourceLinesQuery.parse(request.query),
          ),
        );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  });
}
