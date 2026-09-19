import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { FactoryConceptualReviewPreparation } from "@kestrel/contracts";
import { ApiErrorSchema } from "@kestrel/contracts";
import { FactoryConceptualReviewPersistenceError } from "@kestrel/database";

import {
  registerFactoryConceptualReviewRoutes,
  type FactoryConceptualReviewService,
} from "./factory-conceptual-review.js";

const projectId = "01991c36-7f90-7000-8000-000000000001";
const featureId = "01991c36-7f90-7000-8000-000000000002";
const evidenceId = "01991c36-7f90-7000-8000-000000000003";
const baseCommitId = "a".repeat(40);
const headCommitId = "b".repeat(40);
const treeId = "c".repeat(40);
const digest = "d".repeat(64);
const at = "2026-09-19T12:00:00.000Z";
const command = { program: "npm", args: ["test"], cwd: ".", timeoutSeconds: 60 };
const preparation: FactoryConceptualReviewPreparation = {
  schemaVersion: 1,
  projectId,
  featureId,
  changeProposalId: featureId,
  preparationDigest: digest,
  basis: {
    objective: "Refresh search",
    scope: { includes: ["New results"], excludes: [] },
    outcomes: [
      {
        key: "refresh",
        outcome: "New result appears",
        intent: { kind: "approved_feature_plan", label: "Approved Feature plan · version 1" },
      },
    ],
    provenance: {
      planVersionId: projectId,
      version: 1,
      author: "assistant",
      approvalId: featureId,
      approvedByOperatorId: projectId,
      approvedAt: at,
      planDigest: digest,
    },
  },
  publication: {
    pullRequest: {
      repository: { id: "42", owner: "example", name: "search" },
      id: "9",
      nodeId: "PR_example",
      repositoryNodeId: "R_example",
      authorNodeId: "U_example",
      author: "operator",
      number: 9,
      url: "https://github.com/example/search/pull/9",
      state: "open",
      title: "Refresh search",
      body: "Approved Feature\n<!-- exact -->",
      marker: "<!-- exact -->",
      baseRef: "master",
      headRef: "kestrel/search",
      baseCommitId,
      headCommitId,
    },
    revision: {
      id: projectId,
      state: "available",
      objectFormat: "sha1",
      base: { objectId: baseCommitId, ref: "master" },
      head: { objectId: headCommitId, ref: "kestrel/search" },
      objectCount: 4,
      retainedBytes: 100,
      failureReason: null,
      createdAt: at,
      availableAt: at,
    },
    retainedManifestDigest: digest,
    certificate: {
      id: projectId,
      featureId,
      approvedVersion: 1,
      runId: featureId,
      source: { repositoryId: projectId, identity: digest },
      revision: { baseCommitId, headCommitId, treeId, branch: "refs/heads/kestrel/search" },
      manifest: [{ position: 1, command, origins: [{ workItemKey: "search", position: 1 }] }],
      manifestDigest: digest,
      evidenceIds: [evidenceId],
      createdAt: at,
    },
  },
  evidence: {
    source: {
      baseCommitId,
      headCommitId,
      retainedManifestDigest: digest,
      limits: {
        catalogPageEntries: 200,
        fileBytes: 524288,
        lineRange: 200,
        responseBytes: 32768,
      },
    },
    checks: {
      runId: featureId,
      manifestDigest: digest,
      total: 1,
      limits: { catalogPageEntries: 100, outputBytesPerStream: 8192 },
    },
  },
  configuration: {
    model: { route: "codex_subscription", modelId: "gpt-6-astra" },
    runtimePolicy: {
      kind: "retained_source_review",
      version: 1,
      sourceAccess: "retained_read_only",
      networkAccess: false,
      writeAccess: false,
      status: "unavailable",
    },
    resources: {
      maximumAttempts: 3,
      timeoutSeconds: 900,
      maximumSourceReads: 400,
      maximumGraphNodes: 800,
      maximumOutputBytes: 262144,
    },
  },
  readiness: {
    state: "blocked",
    startAllowed: false,
    blockers: ["review_runtime_unavailable"],
  },
};
const sourceLines = {
  status: "available" as const,
  side: "head" as const,
  commitId: headCommitId,
  mode: "100644" as const,
  type: "blob" as const,
  objectId: treeId,
  path: "src/search.ts",
  startLine: 4,
  endLine: 4,
  totalLines: 9,
  hasFinalNewline: true,
  lineEndings: ["lf" as const],
  text: "refresh();\n",
};
const check = {
  schemaVersion: 1 as const,
  evidenceId,
  runId: featureId,
  manifestPosition: 1,
  origins: [{ workItemKey: "search", position: 1 }],
  result: {
    id: evidenceId,
    round: 1,
    position: 1,
    command,
    headCommitId,
    treeId,
    outcome: "passed" as const,
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 123,
    createdAt: at,
  },
};

let app: FastifyInstance;
let service: FactoryConceptualReviewService;
let prepare: ReturnType<typeof vi.fn>;
let sourceCatalog: ReturnType<typeof vi.fn>;
let sourceLinesReader: ReturnType<typeof vi.fn>;
beforeEach(() => {
  prepare = vi.fn(() => Promise.resolve(preparation));
  sourceCatalog = vi.fn(() =>
    Promise.resolve({
      schemaVersion: 1 as const,
      side: "head" as const,
      commitId: headCommitId,
      entries: [],
      offset: 0,
      total: 0,
      nextOffset: null,
    }),
  );
  sourceLinesReader = vi.fn(() => Promise.resolve(sourceLines));
  service = {
    prepare,
    sourceCatalog,
    sourceLines: sourceLinesReader,
    checks: vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1 as const,
        runId: featureId,
        manifestDigest: digest,
        checks: [],
        offset: 0,
        total: 1,
        nextOffset: 1,
      }),
    ),
    check: vi.fn(() => Promise.resolve(check)),
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
  registerFactoryConceptualReviewRoutes(app, service);
});
afterEach(async () => app.close());

const root = `/api/v1/projects/${projectId}/features/${featureId}/review`;

it("reads preparation without creating a workflow or invoking a model", async () => {
  const response = await app.inject({ method: "GET", url: `${root}/preparation` });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(preparation);
  expect(prepare).toHaveBeenCalledWith({ projectId, featureId });
});

it("reads bounded retained lines through canonical Feature scope", async () => {
  const response = await app.inject({
    method: "GET",
    url: `${root}/source/lines?side=head&path=src%2Fsearch.ts&startLine=4&endLine=4`,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(sourceLines);
  expect(sourceLinesReader).toHaveBeenCalledWith(
    { projectId, featureId },
    { side: "head", path: "src/search.ts", startLine: 4, endLine: 4 },
  );
});

it("rejects traversal before retained storage is consulted", async () => {
  const response = await app.inject({
    method: "GET",
    url: `${root}/source/lines?side=head&path=..%2Fsecret&startLine=1&endLine=1`,
  });
  expect(response.statusCode).toBe(400);
  expect(sourceLinesReader).not.toHaveBeenCalled();
});

it("reads the bounded check catalog and one exact stored result", async () => {
  const catalog = await app.inject({ method: "GET", url: `${root}/checks?offset=0&limit=100` });
  const detail = await app.inject({ method: "GET", url: `${root}/checks/${evidenceId}` });
  expect(catalog.statusCode).toBe(200);
  expect(detail.statusCode).toBe(200);
  expect(detail.json()).toEqual(check);
});

it("returns a readable conflict while exact retained evidence is not ready", async () => {
  sourceCatalog.mockRejectedValue(new FactoryConceptualReviewPersistenceError("not_ready"));
  const response = await app.inject({ method: "GET", url: `${root}/source?side=head` });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ code: "REVIEW_NOT_READY" });
});
