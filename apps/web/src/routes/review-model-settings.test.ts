import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiErrorSchema,
  CodexReviewModelPreferenceSchema,
  type CodexReviewModelPreference,
  type CodexSubscriptionConnection,
} from "@kestrel/contracts";

import { buildApp } from "../app.js";
import {
  createCsrfToken,
  createSessionToken,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../session.js";
import {
  ReviewModelPreferenceError,
  createDatabaseCodexReviewModelPreferenceService,
  type CodexReviewModelPreferenceService,
} from "./review-model-settings.js";

const sessionSigningKey = Buffer.alloc(32, 7);
const operatorId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
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
const authenticatedHeaders = {
  cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
  host: "kestrel.test",
  origin: "https://kestrel.test",
  "x-kestrel-csrf": csrfToken,
};
const preference: CodexReviewModelPreference = {
  schemaVersion: 1,
  route: "codex_subscription",
  selectedModelId: "gpt-5.6-sol",
  updatedAt: "2026-09-07T12:00:00.000Z",
};
const readyConnection: CodexSubscriptionConnection = {
  schemaVersion: 1,
  state: "ready",
  reason: null,
  cli: { version: "0.152.1", supported: true, protocol: "app_server_v2" },
  account: { authentication: "chatgpt", email: null, plan: "plus" },
  models: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isDefault: true }],
  usage: { availability: "available", primary: null, secondary: null },
  checkedAt: "2026-09-07T12:00:00.000Z",
};

describe("Codex review model preference service", () => {
  it("uses a fresh validated catalog and never stores a missing model", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          selected_model_id: "gpt-5.6-sol",
          updated_at: new Date("2026-09-07T12:00:00.000Z"),
        },
      ],
    });
    const readConnection = vi
      .fn()
      .mockResolvedValueOnce(readyConnection)
      .mockResolvedValueOnce({ ...readyConnection, models: [] });
    const service = createDatabaseCodexReviewModelPreferenceService(
      { query } as never,
      { readConnection },
    );

    await expect(service.select({ modelId: "gpt-5.6-sol" })).resolves.toEqual(preference);
    await expect(service.select({ modelId: "gpt-removed" })).rejects.toMatchObject({
      code: "model_unavailable",
    });
    expect(readConnection).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledOnce();
  });
});

describe("Codex review model Settings route", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const read = vi.fn<CodexReviewModelPreferenceService["read"]>();
  const select = vi.fn<CodexReviewModelPreferenceService["select"]>();

  beforeEach(async () => {
    read.mockReset().mockResolvedValue(preference);
    select.mockReset().mockResolvedValue(preference);
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
      codexReviewModelPreferenceService: { read, select },
      eventRetentionLimit: 1_000,
      logger: false,
      pool: pool as never,
      sessionSigningKey,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("reads and selects the Installation preference through authenticated contracts", async () => {
    const current = await app.inject({
      headers: authenticatedHeaders,
      method: "GET",
      url: "/api/v1/settings/review-model",
    });
    const selected = await app.inject({
      headers: authenticatedHeaders,
      method: "PUT",
      payload: { modelId: "gpt-5.6-sol" },
      url: "/api/v1/settings/review-model",
    });

    expect(CodexReviewModelPreferenceSchema.parse(current.json())).toEqual(preference);
    expect(CodexReviewModelPreferenceSchema.parse(selected.json())).toEqual(preference);
    expect(read).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith(
      { modelId: "gpt-5.6-sol" },
      expect.any(AbortSignal),
    );
  });

  it("rejects invalid input and a model absent from the fresh catalog", async () => {
    const invalid = await app.inject({
      headers: authenticatedHeaders,
      method: "PUT",
      payload: { modelId: "gpt-safe; rm -rf /" },
      url: "/api/v1/settings/review-model",
    });
    select.mockRejectedValueOnce(new ReviewModelPreferenceError("model_unavailable"));
    const removed = await app.inject({
      headers: authenticatedHeaders,
      method: "PUT",
      payload: { modelId: "gpt-removed" },
      url: "/api/v1/settings/review-model",
    });

    expect(invalid.statusCode).toBe(400);
    expect(removed.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(removed.json())).toMatchObject({
      code: "REQUEST_REJECTED",
      message: "The selected Codex model is no longer available",
    });
    expect(select).toHaveBeenCalledOnce();
  });

  it("requires an Operator session and CSRF validation", async () => {
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/settings/review-model",
    });
    const missingCsrf = await app.inject({
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
      method: "PUT",
      payload: { modelId: "gpt-5.6-sol" },
      url: "/api/v1/settings/review-model",
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(missingCsrf.statusCode).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
});
