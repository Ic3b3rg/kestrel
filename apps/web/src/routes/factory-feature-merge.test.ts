import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiErrorSchema, type FactoryFeatureMerge } from "@kestrel/contracts";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import {
  registerFactoryFeatureMergeRoutes,
  type FactoryFeatureMergeService,
} from "./factory-feature-merge.js";

const projectId = "01991c36-7f90-7000-8000-000000000001";
const featureId = "01991c36-7f90-7000-8000-000000000002";
const mergeId = "01991c36-7f90-7000-8000-000000000003";
const workflowId = "01991c36-7f90-7000-8000-000000000004";
const artifactId = "01991c36-7f90-7000-8000-000000000005";
const revisionId = "01991c36-7f90-7000-8000-000000000006";
const headCommitId = "b".repeat(40);
const at = "2026-09-19T12:00:00.000Z";
const merge: FactoryFeatureMerge = {
  schemaVersion: 1,
  id: mergeId,
  featureId,
  approvedVersion: 1,
  requestedByOperatorId: projectId,
  sourceReview: {
    workflowId,
    artifactId,
    reviewRevisionId: revisionId,
    baseCommitId: "a".repeat(40),
    headCommitId,
  },
  pullRequest: {
    repository: { id: "1", owner: "example", name: "factory" },
    id: "2",
    nodeId: "PR_example",
    repositoryNodeId: "R_example",
    authorNodeId: "U_example",
    number: 3,
    url: "https://github.com/example/factory/pull/3",
    state: "open",
    author: "operator",
    title: "Feature",
    body: "Feature\n<!-- kestrel:feature-pr:test -->",
    marker: "<!-- kestrel:feature-pr:test -->",
    baseRef: "master",
    headRef: `kestrel/feature/${featureId}`,
    baseCommitId: "a".repeat(40),
    headCommitId,
  },
  certificateId: revisionId,
  state: "queued",
  failure: null,
  canRetry: false,
  provider: { merged: false, mergeCommitId: null, mergedAt: null },
  issues: [
    {
      workItemId: projectId,
      key: "W1",
      number: 10,
      url: "https://github.com/example/factory/issues/10",
      state: "pending",
      failure: null,
      attempts: 0,
      closedAt: null,
    },
  ],
  createdAt: at,
  updatedAt: at,
  completedAt: null,
};
const root = `/api/v1/projects/${projectId}/features/${featureId}/review/merge`;
let app: FastifyInstance;
let mutationConfigs: unknown[];
const current = vi.fn<FactoryFeatureMergeService["current"]>();
const approve = vi.fn<FactoryFeatureMergeService["approve"]>();
const retry = vi.fn<FactoryFeatureMergeService["retry"]>();

beforeEach(() => {
  mutationConfigs = [];
  current.mockReset().mockResolvedValue({ schemaVersion: 1, merge: null });
  approve.mockReset().mockResolvedValue(merge);
  retry.mockReset().mockResolvedValue(merge);
  app = Fastify({
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.setErrorHandler((error, request, reply) =>
    reply.code(error instanceof Error && "validation" in error ? 400 : 500).send(
      ApiErrorSchema.parse({
        schemaVersion: 1,
        code:
          error instanceof Error && "validation" in error ? "INVALID_REQUEST" : "INTERNAL_ERROR",
        message: "Request failed",
        correlationId: request.id,
      }),
    ),
  );
  app.decorateRequest("operatorSession", null);
  app.addHook("onRequest", (request, _reply, done) => {
    request.operatorSession = { operator: { id: projectId } } as never;
    done();
  });
  app.addHook("onRoute", (route) => {
    if (route.method === "POST") mutationConfigs.push(route.config);
  });
  registerFactoryFeatureMergeRoutes(app, { current, approve, retry });
});

afterEach(async () => app.close());

it("records explicit authority for the exact current review and exposes durable progress", async () => {
  const requestId = randomUUID();
  const response = await app.inject({
    method: "POST",
    url: root,
    payload: {
      requestId,
      decision: "approve_merge",
      expectedPlanVersion: 1,
      review: { workflowId, artifactId, headCommitId },
    },
  });
  expect(response.statusCode).toBe(202);
  expect(approve).toHaveBeenCalledWith(
    { projectId, featureId },
    expect.objectContaining({ requestId, decision: "approve_merge" }),
    projectId,
  );
  expect((await app.inject({ method: "GET", url: root })).statusCode).toBe(200);
  expect(current).toHaveBeenCalledWith({ projectId, featureId });
  expect(mutationConfigs).toEqual([
    expect.objectContaining(AUTHENTICATED_MUTATION_ROUTE_CONFIG),
    expect.objectContaining(AUTHENTICATED_MUTATION_ROUTE_CONFIG),
  ]);
});

it("rejects implicit merge authority and retries without accepting a new revision", async () => {
  const invalid = await app.inject({
    method: "POST",
    url: root,
    payload: {
      requestId: randomUUID(),
      decision: "approve_merge",
      expectedPlanVersion: 1,
      review: { workflowId, artifactId, headCommitId },
      force: true,
    },
  });
  expect(invalid.statusCode).toBe(400);
  expect(approve).not.toHaveBeenCalled();
  const requestId = randomUUID();
  expect(
    (
      await app.inject({
        method: "POST",
        url: `${root}/retry`,
        payload: { requestId },
      })
    ).statusCode,
  ).toBe(202);
  expect(retry).toHaveBeenCalledWith({ projectId, featureId }, projectId, { requestId });
});
