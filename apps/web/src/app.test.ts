import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiErrorSchema } from "@kestrel/contracts";

import { buildApp } from "./app.js";

describe("web error and readiness boundaries", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error("required database state is unavailable")),
    };
    app = await buildApp({
      boss: { send: vi.fn() },
      eventRetentionLimit: 1_000,
      logger: false,
      pool: pool as never,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns a versioned invalid-request error for malformed JSON", async () => {
    const response = await app.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: "{",
      url: "/api/v1/installation/diagnostics",
    });

    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("preserves payload-too-large status in the versioned error", async () => {
    const response = await app.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: JSON.stringify({ value: "x".repeat(1_048_576) }),
      url: "/api/v1/installation/diagnostics",
    });

    expect(response.statusCode).toBe(413);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("preserves unsupported-media-type status in the versioned error", async () => {
    const response = await app.inject({
      headers: { "content-type": "application/xml" },
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

    const response = await app.inject({ method: "GET", url: "/api/v1/rate-limited-test" });

    expect(response.statusCode).toBe(429);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "REQUEST_REJECTED" });
  });

  it("returns a versioned not-found error for an unknown API route", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/missing" });

    expect(response.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports an unavailable diagnostic dependency without exposing internals", async () => {
    const response = await app.inject({
      headers: { "content-type": "application/json" },
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
