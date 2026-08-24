import { describe, expect, it } from "vitest";

import {
  apiErrorJsonSchema,
  diagnosticAcceptedJsonSchema,
  installationSnapshotJsonSchema,
  jsonSchemaForEmbedding,
  openApiDocument,
  serializeJson,
} from "./openapi.js";
import {
  DiagnosticAcceptedSchema,
  EventCursorSchema,
  InstallationEventSchema,
  InstallationSnapshotSchema,
  LoginCommandSchema,
  SessionSchema,
} from "./v1.js";

const installation = {
  id: "018f0f89-8f75-7cc4-9860-3fda5f75d697",
  state: "ready",
  currentDiagnosticId: null,
  revision: "0",
  createdAt: "2026-08-24T12:00:00.000Z",
  updatedAt: "2026-08-24T12:00:00.000Z",
} as const;

const diagnostic = {
  id: "018f0f89-9192-755f-aa96-f72094c734dd",
  status: "queued",
  requestedAt: "2026-08-24T12:01:00.000Z",
  startedAt: null,
  completedAt: null,
} as const;

describe("V1 public contracts", () => {
  it("accepts a canonical Installation snapshot", () => {
    const snapshot = {
      schemaVersion: 1,
      installation,
      diagnostic: null,
      eventCursor: "0",
    } as const;

    expect(InstallationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("rejects unsafe cursor representations and unknown snapshot fields", () => {
    expect(() => EventCursorSchema.parse(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => EventCursorSchema.parse("01")).toThrow();
    expect(() => EventCursorSchema.parse("10000000000000000000")).toThrow();
    expect(() =>
      InstallationSnapshotSchema.parse({
        schemaVersion: 1,
        installation,
        diagnostic: null,
        eventCursor: "0",
        extra: true,
      }),
    ).toThrow();
  });

  it("shares one diagnostic shape between command responses and events", () => {
    expect(
      DiagnosticAcceptedSchema.parse({
        schemaVersion: 1,
        installation: {
          ...installation,
          state: "diagnostic_queued",
          currentDiagnosticId: diagnostic.id,
          revision: "1",
        },
        diagnostic,
        eventCursor: "1",
      }),
    ).toBeDefined();

    expect(
      InstallationEventSchema.parse({
        schemaVersion: 1,
        eventId: "1",
        aggregateType: "installation",
        aggregateId: installation.id,
        aggregateVersion: "1",
        eventType: "installation.diagnostic.queued",
        occurredAt: diagnostic.requestedAt,
        correlationId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
        causationId: null,
        locator: {
          installationId: installation.id,
          diagnosticId: diagnostic.id,
        },
      }),
    ).toBeDefined();
  });

  it("defines a password-only login command and a secret-free Operator session", () => {
    expect(
      LoginCommandSchema.parse({
        username: "operator",
        password: "correct horse battery staple",
      }),
    ).toEqual({
      username: "operator",
      password: "correct horse battery staple",
    });

    expect(
      SessionSchema.parse({
        schemaVersion: 1,
        operator: {
          id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
          username: "operator",
        },
        issuedAt: "2026-08-24T12:00:00.000Z",
        expiresAt: "2026-08-31T12:00:00.000Z",
      }),
    ).not.toHaveProperty("password");
    expect(() =>
      LoginCommandSchema.parse({
        username: "operator",
        password: "correct horse battery staple",
        rememberMe: true,
      }),
    ).toThrow();
  });

  it("generates strict JSON Schema and a deterministic OpenAPI 3.1 document", () => {
    expect(installationSnapshotJsonSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
    });
    expect(diagnosticAcceptedJsonSchema).toMatchObject({ additionalProperties: false });
    expect(jsonSchemaForEmbedding(diagnosticAcceptedJsonSchema)).not.toHaveProperty("$schema");
    expect(apiErrorJsonSchema).toHaveProperty("oneOf");
    expect(openApiDocument).toMatchObject({
      openapi: "3.1.1",
      paths: {
        "/auth/login": {},
        "/api/v1/session": {},
        "/api/v1/installation": {},
        "/api/v1/installation/diagnostics": {},
        "/api/v1/events": {},
      },
    });
    expect(openApiDocument).toMatchObject({
      paths: {
        "/api/v1/events": { get: { responses: { "401": {} } } },
        "/api/v1/installation": { get: { responses: { "401": {} } } },
        "/api/v1/installation/diagnostics": { post: { responses: { "401": {} } } },
        "/api/v1/openapi.json": { get: { responses: { "401": {} } } },
        "/api/v1/session": { get: { responses: { "401": {} } } },
      },
    });
    const paths = openApiDocument["paths"];
    if (typeof paths !== "object" || paths === null || Array.isArray(paths)) {
      throw new Error("OpenAPI paths must be an object");
    }
    expect(paths["/auth/login"]).toHaveProperty("post");
    expect(paths["/api/v1/session"]).not.toHaveProperty("post");

    const first = serializeJson(openApiDocument);
    expect(serializeJson(openApiDocument)).toBe(first);
    expect(first).not.toContain("generatedAt");
    expect(first.endsWith("\n")).toBe(true);
  });
});
