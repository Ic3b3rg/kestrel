import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiErrorSchema,
  DirectApiProfileResponseSchema,
  type ConfigureDirectApiProfileCommand,
  type DirectApiProfile,
} from "@kestrel/contracts";

import { buildApp } from "../app.js";
import {
  createCsrfToken,
  createSessionToken,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../session.js";
import {
  DirectApiProfileServiceError,
  type DirectApiProfileService,
} from "./direct-api-profiles.js";

const signingKey = Buffer.alloc(32, 7);
const operatorId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const projectId = "018f0f89-a21d-7e31-8d27-aa4383f22991";
const sessionToken = createSessionToken(
  {
    credentialVersion: "1",
    id: operatorId,
    sessionGeneration: "1",
    username: "operator",
  },
  signingKey,
).token;
const csrfToken = createCsrfToken(sessionToken, signingKey, Buffer.alloc(32, 3));
const headers = {
  cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
  host: "kestrel.test",
  origin: "https://kestrel.test",
  "content-type": "application/json",
  "x-kestrel-csrf": csrfToken,
};

const command: ConfigureDirectApiProfileCommand = {
  apiKey: "sk-project-exclusive-test-key-1234567890",
  dataPolicy: {
    abuseMonitoring: "modified",
    attestedAt: "2026-08-31T12:00:00.000Z",
    evidenceUrl: "https://developers.openai.com/api/docs/guides/your-data",
    expiresAt: "2026-09-30T12:00:00.000Z",
    humanReview: "restricted",
    processingRegions: ["US"],
    storageRegions: ["US"],
    trainingUse: "not_used_without_opt_in",
  },
  displayName: "OpenAI direct review",
  limits: {
    maximumAttempts: 1,
    maximumConcurrentRequests: 1,
    maximumCostUsd: "2.500000",
    maximumInputTokens: 100_000,
    maximumOutputTokens: 8_192,
    maximumRequestBytes: 1_048_576,
    requestTimeoutMilliseconds: 60_000,
  },
  model: {
    expectedResolvedId: "gpt-test-2026-08-01",
    requestedId: "gpt-test-2026-08-01",
    versionPolicy: "pinned",
  },
  openAiProjectId: "proj_example",
  organizationId: "org_example",
  priceSnapshot: {
    cachedInputPerMillionTokensUsd: "0.125000",
    capturedAt: "2026-08-31T12:00:00.000Z",
    currency: "USD",
    effectiveAt: "2026-08-01T00:00:00.000Z",
    inputPerMillionTokensUsd: "1.250000",
    outputPerMillionTokensUsd: "10.000000",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
  },
};

const profile: DirectApiProfile = {
  id: "018f0f89-a3fb-75ee-bccc-08c031ce5f10",
  projectId,
  availability: "available",
  availabilityReasons: [],
  displayName: command.displayName,
  effectiveIdentity: {
    apiSurface: "responses",
    apiVersion: "2020-10-01",
    endpointOrigin: "https://api.openai.com",
    endpointPath: "/v1/responses",
    model: command.model,
    openAiProjectId: command.openAiProjectId,
    organizationId: command.organizationId,
    provider: "openai",
  },
  executionPolicy: {
    arbitraryOptions: "disabled",
    callbacks: "disabled",
    files: "disabled",
    inputModality: "text",
    privilegedInstructions: "developer",
    retrieval: "disabled",
    statefulness: "stateless",
    structuredOutput: "json_schema_strict",
    tools: "disabled",
    urls: "disabled",
  },
  dataPolicy: command.dataPolicy,
  limits: command.limits,
  priceSnapshot: command.priceSnapshot,
  profileDigest: "6".repeat(64),
  lastTest: {
    observedApiVersion: "2020-10-01",
    observedModel: command.model.expectedResolvedId,
    observedOrganizationId: command.organizationId,
    passedAt: "2026-08-31T12:01:00.000Z",
    requestId: "req_synthetic_example",
  },
  createdAt: "2026-08-31T12:01:00.000Z",
  updatedAt: "2026-08-31T12:01:00.000Z",
};

describe("Direct API profile routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const service = {
    configure: vi.fn<DirectApiProfileService["configure"]>(),
    read: vi.fn<DirectApiProfileService["read"]>(),
    test: vi.fn<DirectApiProfileService["test"]>(),
  };

  beforeEach(async () => {
    service.configure.mockReset().mockResolvedValue({ credentialCleanupFailed: false, profile });
    service.read.mockReset().mockResolvedValue({ profile, projectFound: true });
    service.test.mockReset().mockResolvedValue(profile);
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
      directApiProfileService: service,
      eventRetentionLimit: 1_000,
      logger: false,
      pool: pool as never,
      sessionSigningKey: signingKey,
    });
  });

  afterEach(async () => app.close());

  it("returns only the safe effective profile", async () => {
    const response = await app.inject({
      headers,
      method: "GET",
      url: `/api/v1/projects/${projectId}/model-profiles/direct-api`,
    });

    expect(response.statusCode).toBe(200);
    expect(DirectApiProfileResponseSchema.parse(response.json())).toEqual({
      schemaVersion: 1,
      profile,
    });
    expect(response.body).not.toContain(command.apiKey);
    expect(response.body).not.toContain("credentialHandle");
  });

  it("requires a bound step-up proof to configure or replace a profile", async () => {
    const rejected = await app.inject({
      headers,
      method: "POST",
      payload: command,
      url: `/api/v1/projects/${projectId}/model-profiles/direct-api`,
    });
    expect(rejected.statusCode).toBe(403);
    expect(service.configure).not.toHaveBeenCalled();

    const configured = await app.inject({
      headers: { ...headers, "x-kestrel-step-up": "p".repeat(43) },
      method: "POST",
      payload: command,
      url: `/api/v1/projects/${projectId}/model-profiles/direct-api`,
    });
    expect(configured.statusCode).toBe(201);
    expect(service.configure).toHaveBeenCalledWith(command, {
      actorId: operatorId,
      correlationId: expect.any(String),
      credentialVersion: "1",
      projectId,
      stepUpProof: "p".repeat(43),
    });
    expect(configured.body).not.toContain(command.apiKey);
  });

  it("maps a failed synthetic test without leaking credential material", async () => {
    service.configure.mockRejectedValueOnce(
      new DirectApiProfileServiceError("profile_test_failed"),
    );
    const response = await app.inject({
      headers: { ...headers, "x-kestrel-step-up": "p".repeat(43) },
      method: "POST",
      payload: command,
      url: `/api/v1/projects/${projectId}/model-profiles/direct-api`,
    });

    expect(response.statusCode).toBe(422);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "REQUEST_REJECTED" });
    expect(response.body).not.toContain(command.apiKey);
  });
});
