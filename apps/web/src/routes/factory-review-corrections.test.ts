import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiErrorSchema, type FactoryReviewCorrection } from "@kestrel/contracts";
import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import {
  registerFactoryReviewCorrectionRoutes,
  type FactoryReviewCorrectionService,
} from "./factory-review-corrections.js";

const projectId = "01991c36-7f90-7000-8000-000000000001";
const featureId = "01991c36-7f90-7000-8000-000000000002";
const correctionId = "01991c36-7f90-7000-8000-000000000003";
const workflowId = "01991c36-7f90-7000-8000-000000000004";
const artifactId = "01991c36-7f90-7000-8000-000000000005";
const headCommitId = "a".repeat(40);
const at = "2026-09-19T12:00:00.000Z";
const correction: FactoryReviewCorrection = {
  schemaVersion: 1,
  id: correctionId,
  featureId,
  approvedVersion: 1,
  requestedByOperatorId: projectId,
  sourceReview: {
    workflowId,
    artifactId,
    reviewRevisionId: correctionId,
    baseCommitId: "b".repeat(40),
    headCommitId,
  },
  instruction: "Keep the action visible",
  findings: [],
  state: "executing",
  failure: null,
  canRetry: false,
  runId: correctionId,
  certificateId: null,
  replacementReview: null,
  createdAt: at,
  updatedAt: at,
  completedAt: null,
};
const root = `/api/v1/projects/${projectId}/features/${featureId}/review/corrections`;
let app: FastifyInstance;
let service: FactoryReviewCorrectionService;
let mutationConfigs: unknown[];
const currentService = vi.fn<FactoryReviewCorrectionService["current"]>();
const requestService = vi.fn<FactoryReviewCorrectionService["request"]>();
const retryService = vi.fn<FactoryReviewCorrectionService["retry"]>();

beforeEach(() => {
  mutationConfigs = [];
  currentService.mockReset().mockResolvedValue({ schemaVersion: 1, correction: null });
  requestService.mockReset().mockResolvedValue(correction);
  retryService.mockReset().mockResolvedValue(correction);
  service = {
    current: currentService,
    request: requestService,
    retry: retryService,
  };
  app = Fastify({
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.setErrorHandler((error, request, reply) => {
    const validation = error instanceof Error && "validation" in error;
    return reply.code(validation ? 400 : 500).send(
      ApiErrorSchema.parse({
        schemaVersion: 1,
        code: validation ? "INVALID_REQUEST" : "INTERNAL_ERROR",
        message: "Request failed",
        correlationId: request.id,
      }),
    );
  });
  app.decorateRequest("operatorSession", null);
  app.addHook("onRequest", (request, _reply, done) => {
    request.operatorSession = { operator: { id: projectId } } as never;
    done();
  });
  app.addHook("onRoute", (route) => {
    if (route.method === "POST") mutationConfigs.push(route.config);
  });
  registerFactoryReviewCorrectionRoutes(app, service);
});

afterEach(async () => app.close());

it("submits immutable current-review authority and exposes its durable state", async () => {
  const requestId = randomUUID();
  const response = await app.inject({
    method: "POST",
    url: root,
    payload: {
      requestId,
      expectedPlanVersion: 1,
      review: { workflowId, artifactId, headCommitId },
      instruction: "Keep the action visible",
      findingIds: [],
    },
  });
  expect(response.statusCode).toBe(202);
  expect(requestService).toHaveBeenCalledWith(
    { projectId, featureId },
    expect.objectContaining({ requestId, review: { workflowId, artifactId, headCommitId } }),
    projectId,
  );
  const current = await app.inject({ method: "GET", url: `${root}/current` });
  expect(current.statusCode).toBe(200);
  expect(currentService).toHaveBeenCalledWith({ projectId, featureId });
  expect(mutationConfigs).toEqual([
    expect.objectContaining(AUTHENTICATED_MUTATION_ROUTE_CONFIG),
    expect.objectContaining(AUTHENTICATED_MUTATION_ROUTE_CONFIG),
  ]);
});

it("rejects extra correction authority and retries by correction identity", async () => {
  const invalid = await app.inject({
    method: "POST",
    url: root,
    payload: {
      requestId: randomUUID(),
      expectedPlanVersion: 1,
      review: { workflowId, artifactId, headCommitId },
      instruction: "Keep the action visible",
      findingIds: [],
      changeRequirements: true,
    },
  });
  expect(invalid.statusCode).toBe(400);
  expect(requestService).not.toHaveBeenCalled();
  const requestId = randomUUID();
  const retry = await app.inject({
    method: "POST",
    url: `${root}/${correctionId}/retry`,
    payload: { requestId },
  });
  expect(retry.statusCode).toBe(202);
  expect(retryService).toHaveBeenCalledWith(
    { projectId, featureId },
    correctionId,
    projectId,
    requestId,
  );
});

it("preserves actionable frozen-profile errors at the authenticated command boundary", async () => {
  const { FactoryError } = await import("@kestrel/database");
  const detail =
    "The selected effort is unavailable. Choose a supported effort in Lifecycle settings.";
  requestService.mockRejectedValueOnce(new FactoryError("conflict", detail));
  const response = await app.inject({
    method: "POST",
    url: root,
    payload: {
      requestId: randomUUID(),
      expectedPlanVersion: 1,
      review: { workflowId, artifactId, headCommitId },
      instruction: "Keep the action visible",
      findingIds: [],
    },
  });
  expect(response.statusCode).toBe(409);
  expect(ApiErrorSchema.parse(response.json()).message).toBe(detail);
});
