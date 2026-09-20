import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiErrorSchema,
  FactoryConceptualReviewPreparationSchema,
  FactoryConceptualReviewWorkflowReadSchema,
  type FactoryConceptualReviewPreparation,
  type FactoryConceptualReviewWorkflowRead,
} from "@kestrel/contracts";
import { FactoryConceptualReviewWorkflowPersistenceError } from "@kestrel/database";

import { buildApp } from "../app.js";
import {
  createCsrfToken,
  createSessionToken,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../session.js";

const sessionSigningKey = Buffer.alloc(32, 7);
const operatorId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const projectId = "018f0f89-a21d-7e31-8d27-aa4383f22991";
const changeProposalId = "018f0f89-a3fb-75ee-bccc-08c031ce5f10";
const revisionId = "018f0f89-9a21-7271-b92d-f1cb0d48bb47";
const workflowId = "018f0f89-a45f-79af-8544-650e9f15c211";
const requestId = "65cc9964-10c2-49d1-86c4-8f13f5019e86";
const baseCommitId = "a".repeat(40);
const headCommitId = "b".repeat(40);
const treeId = "c".repeat(40);
const digest = "d".repeat(64);
const at = "2026-08-24T12:00:00.000Z";
const sessionToken = createSessionToken(
  {
    credentialVersion: "1",
    id: operatorId,
    sessionGeneration: "1",
    username: "operator",
  },
  sessionSigningKey,
).token;
const csrfToken = createCsrfToken(sessionToken, sessionSigningKey, Buffer.alloc(32, 3));
const mutationHeaders = {
  cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
  host: "kestrel.test",
  origin: "https://kestrel.test",
  "content-type": "application/json",
  "x-kestrel-csrf": csrfToken,
};

const preparation: FactoryConceptualReviewPreparation =
  FactoryConceptualReviewPreparationSchema.parse({
    schemaVersion: 1,
    projectId,
    featureId: null,
    changeProposalId,
    preparationDigest: digest,
    basis: {
      objective: "Review the authorization boundary",
      scope: { includes: ["The exact pull request change"], excludes: [] },
      outcomes: [
        {
          key: "stated_intent",
          outcome: "Review the authorization boundary",
          intent: { kind: "pull_request_stated", label: "GitHub title" },
        },
      ],
      provenance: {
        kind: "change_intent",
        changeIntentId: revisionId,
        version: 1,
        sourceDigest: digest,
        resolution: "unresolved",
        sources: [{ kind: "pull_request_stated", label: "GitHub title" }],
      },
      limitations: ["No acceptance outcomes were confirmed by the Operator."],
    },
    publication: {
      kind: "external_pull_request",
      pullRequest: {
        repository: { id: "42", owner: "example", name: "search" },
        author: "contributor",
        number: 9,
        url: "https://github.com/example/search/pull/9",
        state: "open",
        title: "Review the authorization boundary",
        body: null,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/review-source",
        baseCommitId,
        headCommitId,
      },
      revision: {
        id: revisionId,
        state: "available",
        objectFormat: "sha1",
        base: { objectId: baseCommitId, ref: "refs/heads/main" },
        head: { objectId: headCommitId, ref: "refs/heads/review-source" },
        objectCount: 7,
        retainedBytes: 4096,
        failureReason: null,
        createdAt: at,
        availableAt: at,
      },
      retainedManifestDigest: digest,
      certificate: null,
    },
    evidence: {
      source: {
        baseCommitId,
        headCommitId,
        headTreeId: treeId,
        retainedManifestDigest: digest,
        limits: {
          catalogPageEntries: 200,
          fileBytes: 524288,
          lineRange: 200,
          responseBytes: 32768,
        },
      },
      checks: null,
    },
    configuration: {
      model: { route: "codex_subscription", modelId: "gpt-6-astra" },
      runtimePolicy: {
        kind: "retained_source_review",
        version: 1,
        adapter: "codex_app_server",
        adapterVersion: 1,
        containerImage: `sha256:${"1".repeat(64)}`,
        containerUser: "501:20",
        codexExecutable: "/usr/local/bin/codex",
        codexExecutableDigest: "e".repeat(64),
        codexVersion: "0.155.1",
        codexProtocol: "app_server_v2",
        sourceAccess: "retained_read_only",
        networkAccess: false,
        writeAccess: false,
        status: "available",
      },
      resources: {
        maximumAttempts: 3,
        timeoutSeconds: 900,
        maximumEvidenceItems: 400,
        maximumWorkspaceFiles: 20000,
        maximumWorkspaceBytes: 268435456,
        maximumGraphNodes: 800,
        maximumOutputBytes: 131072,
        containerPidsLimit: 128,
        containerMemoryBytes: 1073741824,
        containerNanoCpus: 2000000000,
        containerTmpfsBytes: 67108864,
      },
    },
    readiness: { state: "ready", startAllowed: true, blockers: [] },
  });

const accepted: FactoryConceptualReviewWorkflowRead =
  FactoryConceptualReviewWorkflowReadSchema.parse({
    schemaVersion: 1,
    workflow: {
      id: workflowId,
      requestId,
      projectId,
      featureId: null,
      changeProposalId,
      inputDigest: digest,
      reviewRevisionId: revisionId,
      state: "queued",
      attempt: { current: 0, maximum: 3 },
      failure: null,
      artifactId: null,
      requestedAt: at,
      startedAt: null,
      finishedAt: null,
    },
    artifact: null,
    currency: "unknown",
  });

describe("External Conceptual Review routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const externalConceptualReviewService = {
    prepare: vi.fn().mockResolvedValue(preparation),
    start: vi.fn().mockResolvedValue(accepted),
    current: vi.fn().mockResolvedValue({ schemaVersion: 1, review: accepted }),
    workflow: vi.fn().mockResolvedValue(accepted),
    history: vi
      .fn()
      .mockResolvedValue({ schemaVersion: 1, reviews: [], offset: 0, total: 0, nextOffset: null }),
    artifact: vi.fn().mockResolvedValue(null),
    workflowSourceLines: vi.fn(),
    artifactSourceLines: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    externalConceptualReviewService.prepare.mockResolvedValue(preparation);
    externalConceptualReviewService.start.mockResolvedValue(accepted);
    const pool = {
      query: vi.fn().mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            credential_version: "1",
            created_at: new Date(at),
            id: operatorId,
            jwt_signing_generation: "1",
            password_hash: "invalid-test-hash",
            username: "operator",
          },
        ],
      }),
    };
    app = await buildApp({
      boss: { send: vi.fn() },
      eventRetentionLimit: 1000,
      logger: false,
      pool: pool as never,
      externalConceptualReviewService,
      sessionSigningKey,
    });
  });

  afterEach(async () => app.close());

  it("reads the exact preparation without starting or mutating the provider", async () => {
    const response = await app.inject({
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`, host: "kestrel.test" },
      method: "GET",
      url: `/api/v1/projects/${projectId}/change-proposals/${changeProposalId}/review/preparation`,
    });

    expect(response.statusCode).toBe(200);
    expect(FactoryConceptualReviewPreparationSchema.parse(response.json())).toEqual(preparation);
    expect(externalConceptualReviewService.prepare).toHaveBeenCalledWith({
      projectId,
      changeProposalId,
    });
    expect(externalConceptualReviewService.start).not.toHaveBeenCalled();
  });

  it("starts the real durable review from the server-issued digest", async () => {
    const command = { requestId, preparationDigest: digest };
    const response = await app.inject({
      headers: mutationHeaders,
      method: "POST",
      payload: command,
      url: `/api/v1/projects/${projectId}/change-proposals/${changeProposalId}/review/workflows`,
    });

    expect(response.statusCode).toBe(202);
    expect(FactoryConceptualReviewWorkflowReadSchema.parse(response.json())).toEqual(accepted);
    expect(externalConceptualReviewService.start).toHaveBeenCalledWith(
      { projectId, changeProposalId },
      command,
      expect.objectContaining({ actorId: operatorId }),
    );
  });

  it.each([
    ["not_ready", "REVIEW_NOT_READY"],
    ["preparation_conflict", "REVIEW_PREPARATION_CONFLICT"],
    ["active_review", "REQUEST_REJECTED"],
  ] as const)("makes the %s start failure explicit", async (kind, code) => {
    externalConceptualReviewService.start.mockRejectedValueOnce(
      new FactoryConceptualReviewWorkflowPersistenceError(kind),
    );
    const response = await app.inject({
      headers: mutationHeaders,
      method: "POST",
      payload: { requestId, preparationDigest: digest },
      url: `/api/v1/projects/${projectId}/change-proposals/${changeProposalId}/review/workflows`,
    });

    expect(response.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code });
  });

  it("reads durable status, history, saved review, and exact source evidence", async () => {
    const source = {
      status: "available" as const,
      side: "head" as const,
      commitId: headCommitId,
      mode: "100644" as const,
      objectId: treeId,
      path: "src/review.ts",
      type: "blob" as const,
      startLine: 10,
      endLine: 11,
      totalLines: 40,
      hasFinalNewline: true,
      lineEndings: ["lf" as const, "lf" as const],
      text: "review();\nreport();\n",
    };
    externalConceptualReviewService.artifact.mockResolvedValueOnce(accepted);
    externalConceptualReviewService.artifactSourceLines.mockResolvedValueOnce(source);

    const [current, history, artifact, lines] = await Promise.all([
      app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`, host: "kestrel.test" },
        method: "GET",
        url: `/api/v1/projects/${projectId}/change-proposals/${changeProposalId}/review/workflows/current`,
      }),
      app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`, host: "kestrel.test" },
        method: "GET",
        url: `/api/v1/projects/${projectId}/change-proposals/${changeProposalId}/review/artifacts?offset=0&limit=20`,
      }),
      app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`, host: "kestrel.test" },
        method: "GET",
        url: `/api/v1/projects/${projectId}/change-proposals/${changeProposalId}/review/artifacts/${workflowId}`,
      }),
      app.inject({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`, host: "kestrel.test" },
        method: "GET",
        url: `/api/v1/projects/${projectId}/change-proposals/${changeProposalId}/review/artifacts/${workflowId}/source/lines?side=head&path=src%2Freview.ts&startLine=10&endLine=11`,
      }),
    ]);

    expect(current.statusCode).toBe(200);
    expect(history.statusCode).toBe(200);
    expect(artifact.statusCode).toBe(200);
    expect(lines.statusCode).toBe(200);
    expect(lines.json()).toEqual(source);
    expect(externalConceptualReviewService.artifactSourceLines).toHaveBeenCalledWith(
      { projectId, changeProposalId },
      workflowId,
      { side: "head", path: "src/review.ts", startLine: 10, endLine: 11 },
    );
  });
});
