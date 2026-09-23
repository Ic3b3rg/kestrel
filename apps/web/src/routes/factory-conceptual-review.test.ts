import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi, type MockedFunction } from "vitest";

import type {
  FactoryConceptualReviewPreparation,
  FactoryConceptualReviewWorkflowRead,
} from "@kestrel/contracts";
import { ApiErrorSchema, FactoryConceptualReviewHistorySchema } from "@kestrel/contracts";
import {
  FactoryConceptualReviewPersistenceError,
  FactoryError,
  FactoryConceptualReviewWorkflowPersistenceError,
} from "@kestrel/database";
import { LocalSourceError } from "@kestrel/local-source";
import { FactoryGitHubError } from "../factory-github.js";

import {
  blockPreparationForRetainedRevisionFailure,
  refreshFactoryConceptualReviewCurrency,
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
const requestId = "65cc9964-10c2-49d1-86c4-8f13f5019e86";
const workflowId = "01991c36-7f90-7000-8000-000000000009";
const artifactId = "01991c36-7f90-7000-8000-000000000010";
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
      adapter: "codex_app_server",
      adapterVersion: 1,
      containerImage: null,
      containerUser: null,
      codexExecutable: null,
      codexExecutableDigest: null,
      codexVersion: null,
      codexProtocol: "app_server_v2",
      sourceAccess: "retained_read_only",
      networkAccess: false,
      writeAccess: false,
      status: "unavailable",
    },
    resources: {
      maximumAttempts: 3,
      timeoutSeconds: 900,
      maximumEvidenceItems: 400,
      maximumWorkspaceFiles: 20_000,
      maximumWorkspaceBytes: 268435456,
      maximumGraphNodes: 800,
      maximumOutputBytes: 131072,
      containerPidsLimit: 128,
      containerMemoryBytes: 1073741824,
      containerNanoCpus: 2000000000,
      containerTmpfsBytes: 67108864,
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
const workflowRead = {
  schemaVersion: 1 as const,
  workflow: {
    id: workflowId,
    requestId,
    projectId,
    featureId,
    changeProposalId: featureId,
    inputDigest: digest,
    reviewRevisionId: projectId,
    state: "queued" as const,
    attempt: { current: 0, maximum: 3 },
    failure: null,
    artifactId: null,
    requestedAt: at,
    startedAt: null,
    finishedAt: null,
  },
  artifact: null,
  currency: "up_to_date" as const,
};
const publishedRead: FactoryConceptualReviewWorkflowRead = {
  ...workflowRead,
  workflow: {
    ...workflowRead.workflow,
    state: "published",
    artifactId,
    startedAt: at,
    finishedAt: at,
  },
  artifact: {
    schemaVersion: 1,
    id: artifactId,
    workflowId,
    inputDigest: digest,
    reviewRevisionId: projectId,
    baseCommitId,
    headCommitId,
    status: "partial",
    evidenceScope: {
      source: "exact_retained_revision",
      executedChecks: "not_linked",
      narrativeAuthority: "source_only_model_interpretation",
    },
    graph: {
      result: "partial",
      summary: "The approved outcome remains unclear.",
      outcomes: [
        {
          id: "outcome:refresh",
          outcomeKey: "refresh",
          title: "New result appears",
          coverage: "unclear",
          behavioralStepIds: [],
          reason: "No adequate support was linked.",
        },
      ],
      behavioralSteps: [],
      evidence: [],
      problems: [],
      edges: [],
      limitations: ["No check was linked."],
    },
    createdAt: at,
  },
  currency: "outdated",
};

let app: FastifyInstance;
let service: FactoryConceptualReviewService;
let prepare: MockedFunction<FactoryConceptualReviewService["prepare"]>;
let sourceCatalog: MockedFunction<FactoryConceptualReviewService["sourceCatalog"]>;
let sourceLinesReader: MockedFunction<FactoryConceptualReviewService["sourceLines"]>;
let workflowSourceLinesReader: MockedFunction<
  FactoryConceptualReviewService["workflowSourceLines"]
>;
let startWorkflow: MockedFunction<FactoryConceptualReviewService["start"]>;
let artifactReader: MockedFunction<FactoryConceptualReviewService["artifact"]>;
let artifactSourceLinesReader: MockedFunction<
  FactoryConceptualReviewService["artifactSourceLines"]
>;
let artifactCheckReader: MockedFunction<FactoryConceptualReviewService["artifactCheck"]>;
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
  workflowSourceLinesReader = vi.fn(() => Promise.resolve(sourceLines));
  startWorkflow = vi.fn(() => Promise.resolve(workflowRead));
  artifactReader = vi.fn(() => Promise.resolve(publishedRead));
  artifactSourceLinesReader = vi.fn(() => Promise.resolve(sourceLines));
  artifactCheckReader = vi.fn(() => Promise.resolve(check));
  service = {
    prepare,
    sourceCatalog,
    sourceLines: sourceLinesReader,
    workflowSourceLines: workflowSourceLinesReader,
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
    start: startWorkflow,
    current: vi.fn(() => Promise.resolve({ schemaVersion: 1 as const, review: workflowRead })),
    workflow: vi.fn(() => Promise.resolve(workflowRead)),
    history: vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1 as const,
        reviews: [
          {
            artifactId,
            workflowId,
            status: "partial" as const,
            headCommitId,
            requestedAt: at,
            finishedAt: at,
            currency: "outdated" as const,
          },
        ],
        offset: 0,
        total: 1,
        nextOffset: null,
      }),
    ),
    artifact: artifactReader,
    artifactSourceLines: artifactSourceLinesReader,
    artifactCheck: artifactCheckReader,
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

it("starts one explicit workflow and durably reads it after reload", async () => {
  const started = await app.inject({
    method: "POST",
    url: `${root}/workflows`,
    payload: { requestId, preparationDigest: digest },
  });
  expect(started.statusCode).toBe(202);
  expect(started.json()).toEqual(workflowRead);
  expect(startWorkflow).toHaveBeenCalledWith(
    { projectId, featureId },
    { requestId, preparationDigest: digest },
    expect.objectContaining({ actorId: projectId }),
  );
  const current = await app.inject({ method: "GET", url: `${root}/workflows/current` });
  const exact = await app.inject({ method: "GET", url: `${root}/workflows/${workflowId}` });
  expect(current.json()).toEqual({ schemaVersion: 1, review: workflowRead });
  expect(exact.json()).toEqual(workflowRead);
});

it("replays an accepted request after its first HTTP response is lost", async () => {
  const payload = { requestId, preparationDigest: digest };
  const first = await app.inject({ method: "POST", url: `${root}/workflows`, payload });
  const replay = await app.inject({ method: "POST", url: `${root}/workflows`, payload });

  expect(first.statusCode).toBe(202);
  expect(replay.statusCode).toBe(202);
  expect(replay.json()).toEqual(first.json());
  expect(startWorkflow).toHaveBeenCalledTimes(2);
});

it.each([
  ["preparation_conflict", "REVIEW_PREPARATION_CONFLICT"],
  ["active_review", "REQUEST_REJECTED"],
] as const)("returns a readable conflict for %s", async (failureCode, apiCode) => {
  startWorkflow.mockRejectedValueOnce(
    new FactoryConceptualReviewWorkflowPersistenceError(failureCode),
  );

  const response = await app.inject({
    method: "POST",
    url: `${root}/workflows`,
    payload: { requestId, preparationDigest: digest },
  });

  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ code: apiCode });
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

it("reads published evidence through the workflow's frozen revision", async () => {
  const response = await app.inject({
    method: "GET",
    url: `${root}/workflows/${workflowId}/source/lines?side=head&path=src%2Fsearch.ts&startLine=4&endLine=4`,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(sourceLines);
  expect(workflowSourceLinesReader).toHaveBeenCalledWith({ projectId, featureId }, workflowId, {
    side: "head",
    path: "src/search.ts",
    startLine: 4,
    endLine: 4,
  });
  expect(sourceLinesReader).not.toHaveBeenCalled();
});

it("reopens the selected immutable artifact with its own source and check evidence", async () => {
  const history = await app.inject({ method: "GET", url: `${root}/artifacts?offset=0&limit=20` });
  const artifact = await app.inject({ method: "GET", url: `${root}/artifacts/${artifactId}` });
  const source = await app.inject({
    method: "GET",
    url: `${root}/artifacts/${artifactId}/source/lines?side=head&path=src%2Fsearch.ts&startLine=4&endLine=4`,
  });
  const evidence = await app.inject({
    method: "GET",
    url: `${root}/artifacts/${artifactId}/checks/${evidenceId}`,
  });
  expect(history.statusCode).toBe(200);
  const historyBody = FactoryConceptualReviewHistorySchema.parse(history.json());
  expect(historyBody.reviews[0]).toMatchObject({ artifactId, workflowId });
  expect(artifact.json()).toEqual(publishedRead);
  expect(source.json()).toEqual(sourceLines);
  expect(evidence.json()).toEqual(check);
  expect(artifactReader).toHaveBeenCalledWith({ projectId, featureId }, artifactId);
  expect(artifactSourceLinesReader).toHaveBeenCalledWith({ projectId, featureId }, artifactId, {
    side: "head",
    path: "src/search.ts",
    startLine: 4,
    endLine: 4,
  });
  expect(artifactCheckReader).toHaveBeenCalledWith(
    { projectId, featureId },
    artifactId,
    evidenceId,
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

it("turns a missing retained revision directory into a readable preparation blocker", () => {
  const blocked = blockPreparationForRetainedRevisionFailure(
    preparation,
    new LocalSourceError("path_not_retained"),
  );
  expect(blocked).toMatchObject({
    preparationDigest: null,
    evidence: null,
    readiness: {
      state: "blocked",
      startAllowed: false,
      blockers: ["exact_revision_mismatch", "review_runtime_unavailable"],
    },
  });
});

it("refreshes published review currency from the live PR and degrades provider failures to unknown", async () => {
  const review = {
    ...workflowRead,
    workflow: { ...workflowRead.workflow, state: "published" },
    artifact: { headCommitId },
    currency: "up_to_date",
  } as FactoryConceptualReviewWorkflowRead;
  const pullRequest = preparation.publication?.pullRequest;
  if (pullRequest === undefined) throw new Error("Test preparation has no pull request");
  const movedHead = "e".repeat(40);
  const recordHead = vi.fn(() => Promise.resolve());
  const observed = await refreshFactoryConceptualReviewCurrency(review, {
    readPullRequest: vi.fn(() => Promise.resolve(pullRequest)),
    observePullRequest: vi.fn(() =>
      Promise.resolve({ baseCommitId, headCommitId: movedHead, state: "open" as const }),
    ),
    recordHead,
  });
  expect(observed?.currency).toBe("outdated");
  expect(recordHead).toHaveBeenCalledWith(movedHead);

  const unavailable = await refreshFactoryConceptualReviewCurrency(review, {
    readPullRequest: vi.fn(() => Promise.resolve(pullRequest)),
    observePullRequest: vi.fn(() => Promise.reject(new FactoryGitHubError("unavailable"))),
    recordHead: vi.fn(),
  });
  expect(unavailable?.currency).toBe("unknown");
});

it("keeps a missing profile Project distinct from provider unavailability", async () => {
  prepare.mockRejectedValueOnce(new FactoryError("not_found"));
  const response = await app.inject({ method: "GET", url: `${root}/preparation` });
  expect(response.statusCode).toBe(404);
  expect(ApiErrorSchema.parse(response.json()).code).toBe("NOT_FOUND");
});
