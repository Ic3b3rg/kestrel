import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiErrorSchema } from "@kestrel/contracts";

import { buildApp } from "./app.js";
import {
  createCsrfToken,
  createSessionToken,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "./session.js";

const sessionSigningKey = Buffer.alloc(32, 7);
const sessionToken = createSessionToken(
  {
    credentialVersion: "1",
    id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
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

describe("web error and readiness boundaries", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    const pool = {
      query: vi.fn().mockImplementation((statement: string) => {
        if (statement.includes("FROM operators")) {
          return Promise.resolve({
            rowCount: 1,
            rows: [
              {
                credential_version: "1",
                created_at: new Date("2026-08-24T12:00:00.000Z"),
                id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
                jwt_signing_generation: "1",
                password_hash: "invalid-test-hash",
                username: "operator",
              },
            ],
          });
        }
        return Promise.reject(new Error("required database state is unavailable"));
      }),
    };
    app = await buildApp({
      boss: { send: vi.fn() },
      eventRetentionLimit: 1_000,
      logger: false,
      pool: pool as never,
      sessionSigningKey,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns a versioned invalid-request error for malformed JSON", async () => {
    const response = await app.inject({
      headers: { ...authenticatedHeaders, "content-type": "application/json" },
      method: "POST",
      payload: "{",
      url: "/api/v1/installation/diagnostics",
    });

    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("limits anonymous access to the specified login route", async () => {
    const login = await app.inject({
      headers: { host: "kestrel.test", origin: "https://kestrel.test" },
      method: "POST",
      payload: { password: "correct horse battery staple", username: "operator" },
      url: "/auth/login",
    });
    const openApi = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const unknownProductRoute = await app.inject({ method: "GET", url: "/future-product" });

    expect(login.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(login.json())).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(openApi.statusCode).toBe(401);
    expect(ApiErrorSchema.parse(openApi.json())).toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
    expect(unknownProductRoute.statusCode).toBe(401);
    expect(ApiErrorSchema.parse(unknownProductRoute.json())).toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
  });

  it("preserves payload-too-large status in the versioned error", async () => {
    const response = await app.inject({
      headers: { ...authenticatedHeaders, "content-type": "application/json" },
      method: "POST",
      payload: JSON.stringify({ value: "x".repeat(1_025) }),
      url: "/api/v1/installation/diagnostics",
    });

    expect(response.statusCode).toBe(413);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("preserves unsupported-media-type status in the versioned error", async () => {
    const response = await app.inject({
      headers: { ...authenticatedHeaders, "content-type": "application/xml" },
      method: "POST",
      payload: "<diagnostic />",
      url: "/api/v1/installation/diagnostics",
    });

    expect(response.statusCode).toBe(415);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
  });

  it("does not collapse another expected 4xx status into 400", async () => {
    app.get("/api/v1/rate-limited-test", () => {
      const error = new Error("rate limit fixture") as Error & { statusCode: number };
      error.statusCode = 429;
      throw error;
    });

    const response = await app.inject({
      headers: authenticatedHeaders,
      method: "GET",
      url: "/api/v1/rate-limited-test",
    });

    expect(response.statusCode).toBe(429);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "REQUEST_REJECTED" });
  });

  it("returns a versioned not-found error for an unknown API route", async () => {
    const response = await app.inject({
      headers: authenticatedHeaders,
      method: "GET",
      url: "/api/v1/missing",
    });

    expect(response.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports an unavailable diagnostic dependency without exposing internals", async () => {
    const response = await app.inject({
      headers: { ...authenticatedHeaders, "content-type": "application/json" },
      method: "POST",
      payload: {},
      url: "/api/v1/installation/diagnostics",
    });

    expect(response.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("does not report ready when required database state is absent", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});
