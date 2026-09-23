import {
  createCodexAppServerAgentRuntime,
  type CodexAgentRuntimePort,
} from "../codex-app-server.js";
import type { CodexSubscriptionConnection } from "@kestrel/contracts";
import { readLifecycleProfile } from "@kestrel/database";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  ApiErrorSchema,
  FactoryConceptualReviewCheckCatalogSchema,
  FactoryConceptualReviewCheckSchema,
  FactoryConceptualReviewCurrentSchema,
  FactoryConceptualReviewHistorySchema,
  FactoryConceptualReviewPreparationSchema,
  FactoryConceptualReviewStartCommandSchema,
  FactoryConceptualReviewSourceCatalogSchema,
  FactoryConceptualReviewSourceLinesSchema,
  FactoryConceptualReviewWorkflowReadSchema,
  KestrelIdSchema,
  type ApiError,
  type FactoryConceptualReviewCheck,
  type FactoryConceptualReviewCheckCatalog,
  type FactoryConceptualReviewCurrent,
  type FactoryConceptualReviewHistory,
  type FactoryConceptualReviewPreparation,
  type FactoryConceptualReviewStartCommand,
  type FactoryConceptualReviewSourceCatalog,
  type FactoryConceptualReviewSourceLines,
  type FactoryConceptualReviewWorkflowRead,
  type FactoryFeaturePullRequest,
} from "@kestrel/contracts";
import {
  FactoryConceptualReviewPersistenceError,
  FactoryConceptualReviewWorkflowPersistenceError,
  readCurrentFactoryConceptualReviewWorkflow,
  readFactoryConceptualReviewArtifact,
  readFactoryConceptualReviewCheck,
  readFactoryConceptualReviewChecks,
  readFactoryConceptualReviewPreparation,
  readFactoryConceptualReviewHistory,
  readFactoryConceptualReviewSourceBinding,
  readFactoryConceptualReviewWorkflow,
  readFactoryConceptualReviewWorkflowCheck,
  readFactoryConceptualReviewWorkflowPullRequest,
  readFactoryConceptualReviewWorkflowSourceBinding,
  observePublishedFactoryConceptualReviewHead,
  startFactoryConceptualReviewWorkflow,
  type DatabasePool,
  type DiagnosticJobSender,
} from "@kestrel/database";
import {
  ConceptualReviewSourceError,
  LocalSourceError,
  readConceptualReviewSourceCatalog,
  readConceptualReviewSourceLines,
  type LocalSourceConfig,
} from "@kestrel/local-source";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import {
  createFactoryFeatureGitHubAdapter,
  type FactoryFeatureGitHubAdapter,
} from "../factory-feature-github.js";
import { FactoryGitHubError } from "../factory-github.js";

export interface FactoryConceptualReviewContext {
  projectId: string;
  featureId: string;
}

export interface FactoryConceptualReviewSourceLineInput {
  side: "base" | "head";
  path: string;
  startLine: number;
  endLine: number;
}

export interface FactoryConceptualReviewService {
  prepare(context: FactoryConceptualReviewContext): Promise<FactoryConceptualReviewPreparation>;
  sourceCatalog(
    context: FactoryConceptualReviewContext,
    input: { side: "base" | "head"; offset: number; limit: number },
  ): Promise<FactoryConceptualReviewSourceCatalog>;
  sourceLines(
    context: FactoryConceptualReviewContext,
    input: FactoryConceptualReviewSourceLineInput,
  ): Promise<FactoryConceptualReviewSourceLines>;
  checks(
    context: FactoryConceptualReviewContext,
    input: { offset: number; limit: number },
  ): Promise<FactoryConceptualReviewCheckCatalog>;
  check(
    context: FactoryConceptualReviewContext,
    evidenceId: string,
  ): Promise<FactoryConceptualReviewCheck>;
  start(
    context: FactoryConceptualReviewContext,
    command: FactoryConceptualReviewStartCommand,
    actor: { actorId: string; correlationId: string },
  ): Promise<FactoryConceptualReviewWorkflowRead>;
  current(context: FactoryConceptualReviewContext): Promise<FactoryConceptualReviewCurrent>;
  workflow(
    context: FactoryConceptualReviewContext,
    workflowId: string,
  ): Promise<FactoryConceptualReviewWorkflowRead | null>;
  history(
    context: FactoryConceptualReviewContext,
    input: { offset: number; limit: number },
  ): Promise<FactoryConceptualReviewHistory>;
  artifact(
    context: FactoryConceptualReviewContext,
    artifactId: string,
  ): Promise<FactoryConceptualReviewWorkflowRead | null>;
  workflowSourceLines(
    context: FactoryConceptualReviewContext,
    workflowId: string,
    input: FactoryConceptualReviewSourceLineInput,
  ): Promise<FactoryConceptualReviewSourceLines>;
  artifactSourceLines(
    context: FactoryConceptualReviewContext,
    artifactId: string,
    input: FactoryConceptualReviewSourceLineInput,
  ): Promise<FactoryConceptualReviewSourceLines>;
  artifactCheck(
    context: FactoryConceptualReviewContext,
    artifactId: string,
    evidenceId: string,
  ): Promise<FactoryConceptualReviewCheck>;
}

export async function refreshFactoryConceptualReviewCurrency(
  review: FactoryConceptualReviewWorkflowRead | null,
  dependencies: {
    readPullRequest(): Promise<FactoryFeaturePullRequest>;
    observePullRequest: FactoryFeatureGitHubAdapter["observePullRequest"];
    recordHead(headCommitId: string): Promise<void>;
  },
): Promise<FactoryConceptualReviewWorkflowRead | null> {
  if (review === null || review.workflow.state !== "published" || review.artifact === null)
    return review;
  try {
    const pullRequest = await dependencies.readPullRequest();
    const observation = await dependencies.observePullRequest(
      { repository: pullRequest.repository, account: pullRequest.author },
      pullRequest,
    );
    await dependencies.recordHead(observation.headCommitId);
    return {
      ...review,
      currency:
        review.artifact.headCommitId === observation.headCommitId ? "up_to_date" : "outdated",
    };
  } catch (error) {
    if (error instanceof FactoryGitHubError) return { ...review, currency: "unknown" };
    throw error;
  }
}

export function blockPreparationForRetainedRevisionFailure(
  preparation: FactoryConceptualReviewPreparation,
  error: unknown,
): FactoryConceptualReviewPreparation | null {
  const mismatch =
    (error instanceof ConceptualReviewSourceError && error.code === "revision_mismatch") ||
    (error instanceof LocalSourceError &&
      [
        "object_missing",
        "object_verification_failed",
        "path_not_retained",
        "source_containment_violation",
      ].includes(error.code));
  if (!mismatch) return null;
  return FactoryConceptualReviewPreparationSchema.parse({
    ...preparation,
    preparationDigest: null,
    evidence: null,
    readiness: {
      state: "blocked",
      startAllowed: false,
      blockers: [
        "exact_revision_mismatch",
        ...preparation.readiness.blockers.filter(
          (blocker) => blocker !== "exact_revision_mismatch",
        ),
      ],
    },
  });
}

export function createDatabaseFactoryConceptualReviewService(
  pool: DatabasePool,
  readSourceConfig: () => Promise<LocalSourceConfig>,
  options: {
    boss?: DiagnosticJobSender;
    connection?: Pick<CodexAgentRuntimePort, "readConnection">;
    runtimeProfile?: {
      containerImage: string;
      containerUser: string;
      codexExecutable: string;
      codexExecutableDigest: string;
      codexVersion: string;
    } | null;
    github?: Pick<FactoryFeatureGitHubAdapter, "observePullRequest">;
  } = {},
): FactoryConceptualReviewService {
  const github = options.github ?? createFactoryFeatureGitHubAdapter();
  const refreshCurrency = (review: FactoryConceptualReviewWorkflowRead | null) =>
    refreshFactoryConceptualReviewCurrency(review, {
      readPullRequest: () => {
        if (review === null) throw new FactoryConceptualReviewWorkflowPersistenceError("not_found");
        return readFactoryConceptualReviewWorkflowPullRequest(pool, review.workflow.id);
      },
      observePullRequest: github.observePullRequest,
      recordHead: (headCommitId) => {
        if (review === null) throw new FactoryConceptualReviewWorkflowPersistenceError("not_found");
        return observePublishedFactoryConceptualReviewHead(pool, review.workflow.id, headCommitId);
      },
    });
  const validateRetainedHead = async (
    database: DatabasePool,
    { projectId, featureId }: FactoryConceptualReviewContext,
  ) => {
    const [config, binding] = await Promise.all([
      readSourceConfig(),
      readFactoryConceptualReviewSourceBinding(database, projectId, featureId, "head"),
    ]);
    await readConceptualReviewSourceCatalog(config, { ...binding, offset: 0, limit: 1 });
  };
  const connection = options.connection ?? createCodexAppServerAgentRuntime();
  const prepare = async (
    database: DatabasePool,
    context: FactoryConceptualReviewContext,
    catalog: CodexSubscriptionConnection,
  ) => {
    const lifecycle = await readLifecycleProfile(database, "review", context.projectId, catalog);
    const preparation = await readFactoryConceptualReviewPreparation(
      database,
      context.projectId,
      context.featureId,
      {
        profile: options.runtimeProfile ?? null,
        lifecycleProfile: lifecycle.resolved,
        profileBlocker: lifecycle.blocked,
      },
    );
    if (preparation.publication === null || preparation.evidence === null) return preparation;
    try {
      await validateRetainedHead(database, context);
      return preparation;
    } catch (error) {
      const blocked = blockPreparationForRetainedRevisionFailure(preparation, error);
      if (blocked !== null) return blocked;
      throw error;
    }
  };
  return {
    prepare: async (context) => prepare(pool, context, await connection.readConnection()),
    async sourceCatalog({ projectId, featureId }, input) {
      const [config, binding] = await Promise.all([
        readSourceConfig(),
        readFactoryConceptualReviewSourceBinding(pool, projectId, featureId, input.side),
      ]);
      return FactoryConceptualReviewSourceCatalogSchema.parse({
        schemaVersion: 1,
        ...(await readConceptualReviewSourceCatalog(config, { ...binding, ...input })),
      });
    },
    async sourceLines({ projectId, featureId }, input) {
      const [config, binding] = await Promise.all([
        readSourceConfig(),
        readFactoryConceptualReviewSourceBinding(pool, projectId, featureId, input.side),
      ]);
      return FactoryConceptualReviewSourceLinesSchema.parse(
        await readConceptualReviewSourceLines(config, { ...binding, ...input }),
      );
    },
    async checks(context, { offset, limit }) {
      await validateRetainedHead(pool, context);
      return readFactoryConceptualReviewChecks(
        pool,
        context.projectId,
        context.featureId,
        offset,
        limit,
      );
    },
    async check(context, evidenceId) {
      await validateRetainedHead(pool, context);
      return readFactoryConceptualReviewCheck(
        pool,
        context.projectId,
        context.featureId,
        evidenceId,
      );
    },
    async start(context, command, actor) {
      const catalog = await connection.readConnection();
      if (options.boss === undefined)
        throw new FactoryConceptualReviewWorkflowPersistenceError("not_ready");
      return startFactoryConceptualReviewWorkflow(
        pool,
        options.boss,
        { ...context, ...actor, command },
        (database) => prepare(database, context, catalog),
      );
    },
    async current(context) {
      const review = await readCurrentFactoryConceptualReviewWorkflow(
        pool,
        context.projectId,
        context.featureId,
      );
      return FactoryConceptualReviewCurrentSchema.parse({
        schemaVersion: 1,
        review: await refreshCurrency(review),
      });
    },
    async workflow(context, workflowId) {
      const review = await readFactoryConceptualReviewWorkflow(
        pool,
        context.projectId,
        context.featureId,
        workflowId,
      );
      return refreshCurrency(review);
    },
    history: (context, { offset, limit }) =>
      readFactoryConceptualReviewHistory(pool, context.projectId, context.featureId, offset, limit),
    async artifact(context, artifactId) {
      const review = await readFactoryConceptualReviewArtifact(
        pool,
        context.projectId,
        context.featureId,
        artifactId,
      );
      return refreshCurrency(review);
    },
    async workflowSourceLines(context, workflowId, input) {
      const workflow = await readFactoryConceptualReviewWorkflow(
        pool,
        context.projectId,
        context.featureId,
        workflowId,
      );
      if (workflow === null) throw new FactoryConceptualReviewWorkflowPersistenceError("not_found");
      const [config, binding] = await Promise.all([
        readSourceConfig(),
        readFactoryConceptualReviewWorkflowSourceBinding(pool, workflowId),
      ]);
      return readConceptualReviewSourceLines(config, { ...binding, ...input });
    },
    async artifactSourceLines(context, artifactId, input) {
      const review = await readFactoryConceptualReviewArtifact(
        pool,
        context.projectId,
        context.featureId,
        artifactId,
      );
      if (review === null || review.artifact === null)
        throw new FactoryConceptualReviewWorkflowPersistenceError("not_found");
      const [config, binding] = await Promise.all([
        readSourceConfig(),
        readFactoryConceptualReviewWorkflowSourceBinding(pool, review.workflow.id),
      ]);
      return readConceptualReviewSourceLines(config, { ...binding, ...input });
    },
    async artifactCheck(context, artifactId, evidenceId) {
      const review = await readFactoryConceptualReviewArtifact(
        pool,
        context.projectId,
        context.featureId,
        artifactId,
      );
      if (review === null || review.artifact === null)
        throw new FactoryConceptualReviewWorkflowPersistenceError("not_found");
      return readFactoryConceptualReviewWorkflowCheck(
        pool,
        context.projectId,
        context.featureId,
        review.workflow.id,
        evidenceId,
      );
    },
  };
}

const params = z.strictObject({ projectId: KestrelIdSchema, featureId: KestrelIdSchema });
const checkParams = params.extend({ evidenceId: KestrelIdSchema });
const workflowParams = params.extend({ workflowId: KestrelIdSchema });
const artifactParams = params.extend({ artifactId: KestrelIdSchema });
const artifactCheckParams = artifactParams.extend({ evidenceId: KestrelIdSchema });
const side = z.enum(["base", "head"]);
const sourceCatalogQuery = z.strictObject({
  side,
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(200),
});
const safePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      new TextEncoder().encode(value).length <= 4096 &&
      !/[\p{Cc}\\]/u.test(value) &&
      !/^[a-z][a-z0-9+.-]*:/iu.test(value) &&
      !value.split("/").some((part) => part === "" || part === "." || part === ".."),
  );
const sourceLinesQuery = z.strictObject({
  side,
  path: safePath,
  startLine: z.coerce.number().int().min(1),
  endLine: z.coerce.number().int().min(1),
});
const checksQuery = z.strictObject({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(100),
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
  if (error instanceof z.ZodError)
    return {
      status: 400 as const,
      body: apiError(request, "INVALID_REQUEST", "The Review evidence request is invalid"),
    };
  if (error instanceof FactoryConceptualReviewPersistenceError) {
    if (error.code === "not_found" || error.code === "evidence_not_found")
      return {
        status: 404 as const,
        body: apiError(request, "NOT_FOUND", "Review evidence is unavailable"),
      };
    if (error.code === "not_ready")
      return {
        status: 409 as const,
        body: apiError(request, "REVIEW_NOT_READY", "The exact Review inputs are not ready"),
      };
    return {
      status: 400 as const,
      body: apiError(request, "INVALID_REQUEST", "The Review evidence request is invalid"),
    };
  }
  if (error instanceof FactoryConceptualReviewWorkflowPersistenceError) {
    if (error.code === "not_found")
      return {
        status: 404 as const,
        body: apiError(request, "NOT_FOUND", "The Conceptual Review is unavailable"),
      };
    if (error.code === "not_ready")
      return {
        status: 409 as const,
        body: apiError(request, "REVIEW_NOT_READY", "The exact Review inputs are not ready"),
      };
    if (error.code === "preparation_conflict")
      return {
        status: 409 as const,
        body: apiError(request, "REVIEW_PREPARATION_CONFLICT", "The Review inputs changed"),
      };
    if (error.code === "active_review")
      return {
        status: 409 as const,
        body: apiError(request, "REQUEST_REJECTED", "A Conceptual Review is already active"),
      };
  }
  if (error instanceof ConceptualReviewSourceError) {
    if (error.code === "revision_mismatch")
      return {
        status: 409 as const,
        body: apiError(request, "REVIEW_PREPARATION_CONFLICT", "The retained revision changed"),
      };
    if (["file_too_large", "response_too_large"].includes(error.code))
      return {
        status: 413 as const,
        body: apiError(
          request,
          "PAYLOAD_TOO_LARGE",
          "The retained source response exceeds its limit",
        ),
      };
    return {
      status: 400 as const,
      body: apiError(request, "INVALID_REQUEST", "The retained source range is invalid"),
    };
  }
  if (error instanceof LocalSourceError) {
    if (error.code === "path_not_retained")
      return {
        status: 404 as const,
        body: apiError(request, "NOT_FOUND", "The source path is unavailable"),
      };
    return {
      status: 503 as const,
      body: apiError(request, "SERVICE_UNAVAILABLE", "Retained source is unavailable"),
    };
  }
  request.log.error({ err: error, event: "factory_conceptual_review.read_failed" });
  return {
    status: 503 as const,
    body: apiError(request, "SERVICE_UNAVAILABLE", "Conceptual Review inputs are unavailable"),
  };
}

export function registerFactoryConceptualReviewRoutes(
  app: FastifyInstance,
  service: FactoryConceptualReviewService,
): void {
  const root = "/api/v1/projects/:projectId/features/:featureId/review";
  app.post(
    `${root}/workflows`,
    {
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      bodyLimit: 512,
      schema: {
        params: json(params),
        body: json(FactoryConceptualReviewStartCommandSchema),
        response: { ...errors, 202: json(FactoryConceptualReviewWorkflowReadSchema) },
      },
    },
    async (request, reply) => {
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
    },
  );
  app.get(
    `${root}/workflows/current`,
    {
      schema: {
        params: json(params),
        response: { ...errors, 200: json(FactoryConceptualReviewCurrentSchema) },
      },
    },
    async (request, reply) => {
      try {
        return FactoryConceptualReviewCurrentSchema.parse(
          await service.current(params.parse(request.params)),
        );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
  app.get(
    `${root}/workflows/:workflowId`,
    {
      schema: {
        params: json(workflowParams),
        response: { ...errors, 200: json(FactoryConceptualReviewWorkflowReadSchema) },
      },
    },
    async (request, reply) => {
      try {
        const { projectId, featureId, workflowId } = workflowParams.parse(request.params);
        const result = await service.workflow({ projectId, featureId }, workflowId);
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
  );
  app.get(
    `${root}/workflows/:workflowId/source/lines`,
    {
      schema: {
        params: json(workflowParams),
        querystring: json(sourceLinesQuery),
        response: { ...errors, 200: json(FactoryConceptualReviewSourceLinesSchema) },
      },
    },
    async (request, reply) => {
      try {
        const { projectId, featureId, workflowId } = workflowParams.parse(request.params);
        return FactoryConceptualReviewSourceLinesSchema.parse(
          await service.workflowSourceLines(
            { projectId, featureId },
            workflowId,
            sourceLinesQuery.parse(request.query),
          ),
        );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
  app.get(
    `${root}/artifacts`,
    {
      schema: {
        params: json(params),
        querystring: json(historyQuery),
        response: { ...errors, 200: json(FactoryConceptualReviewHistorySchema) },
      },
    },
    async (request, reply) => {
      try {
        return FactoryConceptualReviewHistorySchema.parse(
          await service.history(params.parse(request.params), historyQuery.parse(request.query)),
        );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
  app.get(
    `${root}/artifacts/:artifactId`,
    {
      schema: {
        params: json(artifactParams),
        response: { ...errors, 200: json(FactoryConceptualReviewWorkflowReadSchema) },
      },
    },
    async (request, reply) => {
      try {
        const { projectId, featureId, artifactId } = artifactParams.parse(request.params);
        const result = await service.artifact({ projectId, featureId }, artifactId);
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
  );
  app.get(
    `${root}/artifacts/:artifactId/source/lines`,
    {
      schema: {
        params: json(artifactParams),
        querystring: json(sourceLinesQuery),
        response: { ...errors, 200: json(FactoryConceptualReviewSourceLinesSchema) },
      },
    },
    async (request, reply) => {
      try {
        const { projectId, featureId, artifactId } = artifactParams.parse(request.params);
        return FactoryConceptualReviewSourceLinesSchema.parse(
          await service.artifactSourceLines(
            { projectId, featureId },
            artifactId,
            sourceLinesQuery.parse(request.query),
          ),
        );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
  app.get(
    `${root}/artifacts/:artifactId/checks/:evidenceId`,
    {
      schema: {
        params: json(artifactCheckParams),
        response: { ...errors, 200: json(FactoryConceptualReviewCheckSchema) },
      },
    },
    async (request, reply) => {
      try {
        const { projectId, featureId, artifactId, evidenceId } = artifactCheckParams.parse(
          request.params,
        );
        return FactoryConceptualReviewCheckSchema.parse(
          await service.artifactCheck({ projectId, featureId }, artifactId, evidenceId),
        );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
  app.get(
    `${root}/preparation`,
    {
      schema: {
        params: json(params),
        response: { ...errors, 200: json(FactoryConceptualReviewPreparationSchema) },
      },
    },
    async (request, reply) => {
      try {
        const context = params.parse(request.params);
        return FactoryConceptualReviewPreparationSchema.parse(await service.prepare(context));
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
  app.get(
    `${root}/source`,
    {
      schema: {
        params: json(params),
        querystring: json(sourceCatalogQuery),
        response: { ...errors, 200: json(FactoryConceptualReviewSourceCatalogSchema) },
      },
    },
    async (request, reply) => {
      try {
        return FactoryConceptualReviewSourceCatalogSchema.parse(
          await service.sourceCatalog(
            params.parse(request.params),
            sourceCatalogQuery.parse(request.query),
          ),
        );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
  app.get(
    `${root}/source/lines`,
    {
      schema: {
        params: json(params),
        querystring: json(sourceLinesQuery),
        response: { ...errors, 200: json(FactoryConceptualReviewSourceLinesSchema) },
      },
    },
    async (request, reply) => {
      try {
        return FactoryConceptualReviewSourceLinesSchema.parse(
          await service.sourceLines(
            params.parse(request.params),
            sourceLinesQuery.parse(request.query),
          ),
        );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
  app.get(
    `${root}/checks`,
    {
      schema: {
        params: json(params),
        querystring: json(checksQuery),
        response: { ...errors, 200: json(FactoryConceptualReviewCheckCatalogSchema) },
      },
    },
    async (request, reply) => {
      try {
        return FactoryConceptualReviewCheckCatalogSchema.parse(
          await service.checks(params.parse(request.params), checksQuery.parse(request.query)),
        );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
  app.get(
    `${root}/checks/:evidenceId`,
    {
      schema: {
        params: json(checkParams),
        response: { ...errors, 200: json(FactoryConceptualReviewCheckSchema) },
      },
    },
    async (request, reply) => {
      try {
        const { projectId, featureId, evidenceId } = checkParams.parse(request.params);
        return FactoryConceptualReviewCheckSchema.parse(
          await service.check({ projectId, featureId }, evidenceId),
        );
      } catch (error) {
        const mapped = failure(request, error);
        return reply.code(mapped.status).send(mapped.body);
      }
    },
  );
}
