import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiErrorSchema,
  ReviewPreparationSchema,
  ReviewWorkflowAcceptedSchema,
  type ReviewPreparation,
  type ReviewWorkflowAccepted,
} from "@kestrel/contracts";
import { ReviewWorkflowPersistenceError } from "@kestrel/database";

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

const preparation: ReviewPreparation = ReviewPreparationSchema.parse({
  schemaVersion: 1,
  projectId,
  changeProposalId,
  proposal: {
    version: 4,
    base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
    head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
  },
  reviewRevision: {
    id: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
    state: "available",
    objectFormat: "sha1",
    base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
    head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
    objectCount: 7,
    retainedBytes: 4096,
    failureReason: null,
    createdAt: "2026-08-24T12:00:30.000Z",
    availableAt: "2026-08-24T12:01:00.000Z",
  },
  changeIntent: {
    id: "018f0f89-9a20-79f9-9990-dda80c9b917e",
    version: 2,
    text: "Review the local authorization boundary.",
    objective: "Review the local authorization boundary.",
    scopeBoundaries: ["Do not add provider write authority."],
    acceptanceOutcomes: ["Review uses only the retained exact revision."],
    sources: [
      {
        id: "operator_input",
        kind: "operator_input",
        label: "Operator input",
        text: "Review the local authorization boundary.",
        version: "2",
        provenance: { kind: "operator_input" },
      },
    ],
    sourceDigest: "c".repeat(64),
    resolution: { state: "resolved", issues: [] },
    createdAt: "2026-08-24T12:02:00.000Z",
  },
  source: {
    localRepositorySource: {
      id: "018f0f89-9a1d-7484-b224-866ef9d69990",
      repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
      displayName: "kestrel",
      state: "attached",
      objectFormat: "sha1",
      createdAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T12:03:00.000Z",
    },
    providerObservation: null,
  },
  analysisConfiguration: null,
  authority: { action: "start_review", operatorId, state: "available" },
  resourceEnvelope: {
    id: "review-first-v1-default",
    version: 1,
    displayName: "Review First V1 default envelope",
    digest: "e".repeat(64),
  },
  readiness: "blocked",
  blockers: ["model_route_not_available"],
  preparationDigest: null,
});

const accepted: ReviewWorkflowAccepted = ReviewWorkflowAcceptedSchema.parse({
  schemaVersion: 1,
  workflow: {
    id: "018f0f89-a45f-79af-8544-650e9f15c211",
    projectId,
    changeProposalId,
    reviewRevisionId: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
    changeIntentId: "018f0f89-9a20-79f9-9990-dda80c9b917e",
    inputDigest: "f".repeat(64),
    analysisConfiguration: {
      id: "018f0f89-a21d-7e31-8d27-aa4383f22992",
      version: 1,
      displayName: "Direct API review profile",
      modelRoute: "direct_api",
      digest: "d".repeat(64),
    },
    authority: { action: "start_review", operatorId, state: "available" },
    resourceEnvelope: {
      id: "review-first-v1-default",
      version: 1,
      displayName: "Review First V1 default envelope",
      digest: "e".repeat(64),
    },
    state: "queued",
    requestedAt: "2026-08-24T12:04:00.000Z",
  },
});

describe("Review Workflow routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const reviewWorkflowService = {
    prepare: vi.fn().mockResolvedValue(preparation),
    start: vi.fn().mockResolvedValue(accepted),
  };

  beforeEach(async () => {
    reviewWorkflowService.prepare.mockClear();
    reviewWorkflowService.start.mockClear();
    const pool = {
      query: vi.fn().mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            credential_version: "1",
            created_at: new Date("2026-08-24T12:00:00.000Z"),
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
      eventRetentionLimit: 1_000,
      logger: false,
      pool: pool as never,
      reviewWorkflowService,
      sessionSigningKey,
    });
  });

  afterEach(async () => app.close());

  it("reads the exact Review preparation without a mutation or provider command", async () => {
    const response = await app.inject({
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
        host: "kestrel.test",
      },
      method: "GET",
      url: `/api/v1/projects/${projectId}/change-proposals/${changeProposalId}/review-preparation`,
    });

    expect(response.statusCode).toBe(200);
    expect(ReviewPreparationSchema.parse(response.json())).toEqual(preparation);
    expect(reviewWorkflowService.prepare).toHaveBeenCalledWith({
      actorId: operatorId,
      changeProposalId,
      projectId,
    });
  });

  it("starts a Review Workflow from the server-issued preparation digest", async () => {
    const command = { preparationDigest: "f".repeat(64) };
    const response = await app.inject({
      headers: mutationHeaders,
      method: "POST",
      payload: command,
      url: `/api/v1/projects/${projectId}/change-proposals/${changeProposalId}/review-workflows`,
    });

    expect(response.statusCode).toBe(202);
    expect(ReviewWorkflowAcceptedSchema.parse(response.json())).toEqual(accepted);
    expect(reviewWorkflowService.start).toHaveBeenCalledOnce();
    expect(reviewWorkflowService.start.mock.calls[0]?.[0]).toEqual(command);
    expect(reviewWorkflowService.start.mock.calls[0]?.[1]).toMatchObject({
      actorId: operatorId,
      changeProposalId,
      projectId,
    });
  });

  it.each([
    ["not_ready", "REVIEW_NOT_READY"],
    ["preparation_conflict", "REVIEW_PREPARATION_CONFLICT"],
  ] as const)("rejects the %s command conflict", async (kind, code) => {
    reviewWorkflowService.start.mockRejectedValueOnce(new ReviewWorkflowPersistenceError(kind));

    const response = await app.inject({
      headers: mutationHeaders,
      method: "POST",
      payload: { preparationDigest: "f".repeat(64) },
      url: `/api/v1/projects/${projectId}/change-proposals/${changeProposalId}/review-workflows`,
    });

    expect(response.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code });
  });
});
