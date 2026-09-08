import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as database from "@kestrel/database";
import { registerFactoryFeaturePublicationRoutes } from "./factory-feature-publication.js";
import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import { ApiErrorSchema } from "@kestrel/contracts";

vi.mock("@kestrel/database", async (original) => ({
  ...(await original<typeof database>()),
  readFactoryFeaturePublication: vi.fn(),
  retryFactoryFeaturePublication: vi.fn(),
}));
const projectId = "01991c36-7f90-7000-8000-000000000001";
const featureId = "01991c36-7f90-7000-8000-000000000002";
const state = {
  schemaVersion: 1 as const,
  featureId,
  approvedVersion: 1,
  state: "uncertain" as const,
  cancelled: false,
  failure: "uncertain_write" as const,
  canRetry: true,
  updatedAt: null,
  certificate: null,
  issues: [],
  pullRequest: null,
  review: null,
};
const path = `/api/v1/projects/${projectId}/features/${featureId}/pull-request`;
let app: FastifyInstance;
let mutationConfig: unknown;
beforeEach(() => {
  vi.resetAllMocks();
  app = Fastify({
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.setErrorHandler((error, request, reply) => {
    const validation = error instanceof Error && "validation" in error;
    return reply
      .code(validation ? 400 : 500)
      .send(
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
    if (route.method === "POST") mutationConfig = route.config;
  });
  vi.mocked(database.readFactoryFeaturePublication).mockResolvedValue(state);
  vi.mocked(database.retryFactoryFeaturePublication).mockResolvedValue({
    ...state,
    state: "pending",
    canRetry: false,
  });
  registerFactoryFeaturePublicationRoutes(app, {} as database.DatabasePool);
});
afterEach(async () => {
  await app.close();
});

it("reads the scoped retained state without starting another publication", async () => {
  const response = await app.inject({ method: "GET", url: path });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(state);
  expect(database.readFactoryFeaturePublication).toHaveBeenCalledWith(
    expect.anything(),
    projectId,
    featureId,
  );
  expect(database.retryFactoryFeaturePublication).not.toHaveBeenCalled();
});

it("queues an idempotent retry under the authenticated Operator without accepting new authority", async () => {
  const requestId = randomUUID();
  const response = await app.inject({
    method: "POST",
    url: `${path}/retry`,
    payload: { requestId },
  });
  expect(response.statusCode).toBe(202);
  expect(database.retryFactoryFeaturePublication).toHaveBeenCalledWith(
    expect.anything(),
    projectId,
    featureId,
    projectId,
    requestId,
  );
  expect(mutationConfig).toMatchObject(AUTHENTICATED_MUTATION_ROUTE_CONFIG);
  const forged = await app.inject({
    method: "POST",
    url: `${path}/retry`,
    payload: { requestId, headCommitId: "b".repeat(40) },
  });
  expect(forged.statusCode).toBe(400);
  expect(database.retryFactoryFeaturePublication).toHaveBeenCalledOnce();
});

it("returns a scoped conflict for a retry that can no longer be admitted", async () => {
  vi.mocked(database.retryFactoryFeaturePublication).mockRejectedValue(
    new database.FactoryError("conflict"),
  );
  const response = await app.inject({
    method: "POST",
    url: `${path}/retry`,
    payload: { requestId: randomUUID() },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ code: "REQUEST_REJECTED" });
});
