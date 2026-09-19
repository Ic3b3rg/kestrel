import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  ApiErrorSchema,
  FactoryConceptualReviewCheckCatalogSchema,
  FactoryConceptualReviewCheckSchema,
  FactoryConceptualReviewPreparationSchema,
  FactoryConceptualReviewSourceCatalogSchema,
  FactoryConceptualReviewSourceLinesSchema,
  KestrelIdSchema,
  type ApiError,
  type FactoryConceptualReviewCheck,
  type FactoryConceptualReviewCheckCatalog,
  type FactoryConceptualReviewPreparation,
  type FactoryConceptualReviewSourceCatalog,
  type FactoryConceptualReviewSourceLines,
} from "@kestrel/contracts";
import {
  FactoryConceptualReviewPersistenceError,
  readFactoryConceptualReviewCheck,
  readFactoryConceptualReviewChecks,
  readFactoryConceptualReviewPreparation,
  readFactoryConceptualReviewSourceBinding,
  type DatabasePool,
} from "@kestrel/database";
import {
  ConceptualReviewSourceError,
  LocalSourceError,
  readConceptualReviewSourceCatalog,
  readConceptualReviewSourceLines,
  type LocalSourceConfig,
} from "@kestrel/local-source";

export interface FactoryConceptualReviewContext {
  projectId: string;
  featureId: string;
}

export interface FactoryConceptualReviewService {
  prepare(context: FactoryConceptualReviewContext): Promise<FactoryConceptualReviewPreparation>;
  sourceCatalog(
    context: FactoryConceptualReviewContext,
    input: { side: "base" | "head"; offset: number; limit: number },
  ): Promise<FactoryConceptualReviewSourceCatalog>;
  sourceLines(
    context: FactoryConceptualReviewContext,
    input: {
      side: "base" | "head";
      path: string;
      startLine: number;
      endLine: number;
    },
  ): Promise<FactoryConceptualReviewSourceLines>;
  checks(
    context: FactoryConceptualReviewContext,
    input: { offset: number; limit: number },
  ): Promise<FactoryConceptualReviewCheckCatalog>;
  check(
    context: FactoryConceptualReviewContext,
    evidenceId: string,
  ): Promise<FactoryConceptualReviewCheck>;
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
): FactoryConceptualReviewService {
  const validateRetainedHead = async ({ projectId, featureId }: FactoryConceptualReviewContext) => {
    const [config, binding] = await Promise.all([
      readSourceConfig(),
      readFactoryConceptualReviewSourceBinding(pool, projectId, featureId, "head"),
    ]);
    await readConceptualReviewSourceCatalog(config, { ...binding, offset: 0, limit: 1 });
  };
  return {
    async prepare(context) {
      const preparation = await readFactoryConceptualReviewPreparation(
        pool,
        context.projectId,
        context.featureId,
        {
          // Slice #237 deliberately exposes preparation before the bounded Review runtime exists.
          runtimeAvailable: false,
        },
      );
      if (preparation.publication === null || preparation.evidence === null) return preparation;
      try {
        await validateRetainedHead(context);
        return preparation;
      } catch (error) {
        const blocked = blockPreparationForRetainedRevisionFailure(preparation, error);
        if (blocked !== null) return blocked;
        throw error;
      }
    },
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
      await validateRetainedHead(context);
      return readFactoryConceptualReviewChecks(
        pool,
        context.projectId,
        context.featureId,
        offset,
        limit,
      );
    },
    async check(context, evidenceId) {
      await validateRetainedHead(context);
      return readFactoryConceptualReviewCheck(
        pool,
        context.projectId,
        context.featureId,
        evidenceId,
      );
    },
  };
}

const params = z.strictObject({ projectId: KestrelIdSchema, featureId: KestrelIdSchema });
const checkParams = params.extend({ evidenceId: KestrelIdSchema });
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
