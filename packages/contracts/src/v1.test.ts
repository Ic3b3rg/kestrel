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
  CredentialChangeCommandSchema,
  DiagnosticAcceptedSchema,
  EventCursorSchema,
  InstallationEventSchema,
  InstallationSnapshotSchema,
  LoginCommandSchema,
  OpenPublicGitHubPullRequestCommandSchema,
  ProjectInboxSchema,
  SessionSchema,
  StepUpCommandSchema,
  StepUpProofSchema,
  serializeCredentialChangeCommand,
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
        credentialVersion: "1",
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

  it("binds one step-up proof to the canonical sensitive credential command", () => {
    const command = CredentialChangeCommandSchema.parse({
      expectedVersion: "7",
      newPassword: "a newly chosen correct horse battery staple",
      username: "operator-renamed",
    });
    const requestDigest = "4".repeat(64);

    expect(serializeCredentialChangeCommand(command)).toBe(
      '{"expectedVersion":"7","newPassword":"a newly chosen correct horse battery staple","username":"operator-renamed"}',
    );
    expect(
      StepUpCommandSchema.parse({
        action: "operator_credentials_change",
        password: "current correct horse battery staple",
        requestDigest,
        targetId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
      }),
    ).not.toHaveProperty("newPassword");
    expect(
      StepUpProofSchema.parse({
        schemaVersion: 1,
        expiresAt: "2026-08-24T12:05:00.000Z",
        proof: "A".repeat(43),
      }),
    ).toBeDefined();
    expect(() => CredentialChangeCommandSchema.parse({ ...command, unexpected: true })).toThrow();
  });

  it("accepts only canonical public GitHub pull-request URLs", () => {
    expect(
      OpenPublicGitHubPullRequestCommandSchema.parse({
        url: "https://github.com/openai/openai-node/pull/1234",
      }),
    ).toEqual({ url: "https://github.com/openai/openai-node/pull/1234" });

    for (const url of [
      "http://github.com/openai/openai-node/pull/1234",
      "https://github.com.evil.example/openai/openai-node/pull/1234",
      "https://github.com/openai/openai-node/pull/1234/",
      "https://github.com/openai/openai-node/pull/01234",
      "https://github.com/openai/openai-node/pull/1234?diff=split",
      "https://github.com/openai/openai-node/issues/1234",
    ]) {
      expect(() => OpenPublicGitHubPullRequestCommandSchema.parse({ url })).toThrow();
    }
  });

  it("represents public source, provider context, synchronization, and model access separately", () => {
    expect(
      ProjectInboxSchema.parse({
        schemaVersion: 1,
        projects: [
          {
            id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
            repositoryAccess: {
              authentication: "none",
              kind: "public_github",
              synchronization: "manual",
            },
            repository: {
              canonicalUrl: "https://github.com/openai/openai-node",
              name: "openai-node",
              owner: "openai",
              providerId: "R_kgDOGx",
            },
            sourceAvailability: "available",
            providerContext: "public_pull_request",
            modelAccess: "not_configured",
            createdAt: "2026-08-24T12:00:00.000Z",
            updatedAt: "2026-08-24T12:01:00.000Z",
            changeProposals: [
              {
                id: "018f0f89-9192-755f-aa96-f72094c734dd",
                providerId: "PR_kwDOGx",
                number: 1234,
                title: "Keep repository access explicit",
                canonicalUrl: "https://github.com/openai/openai-node/pull/1234",
                proposalState: "open",
                base: { objectId: "a".repeat(40), ref: "main" },
                head: { objectId: "b".repeat(40), ref: "repository-access" },
                author: { login: "octocat", providerId: "U_kgDOA" },
                observedAt: "2026-08-24T12:01:00.000Z",
              },
            ],
          },
        ],
      }),
    ).toBeDefined();
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
        "/auth/logout": {},
        "/auth/login": {},
        "/auth/step-up": {},
        "/api/v1/session": {},
        "/api/v1/operator/credentials": {},
        "/api/v1/projects": {},
        "/api/v1/installation": {},
        "/api/v1/installation/diagnostics": {},
        "/api/v1/events": {},
      },
    });
    expect(openApiDocument).toMatchObject({
      paths: {
        "/auth/login": {
          post: {
            parameters: [{ in: "header", name: "Origin", required: true }],
            responses: { "403": {} },
          },
        },
        "/api/v1/events": { get: { responses: { "401": {} } } },
        "/api/v1/installation": { get: { responses: { "401": {} } } },
        "/api/v1/installation/diagnostics": {
          post: {
            parameters: [
              { in: "header", name: "Origin", required: true },
              { in: "header", name: "X-Kestrel-CSRF", required: true },
            ],
            responses: { "401": {}, "403": {} },
          },
        },
        "/api/v1/projects": {
          get: { responses: { "200": {}, "401": {}, "503": {} } },
          post: {
            parameters: [
              { in: "header", name: "Origin", required: true },
              { in: "header", name: "X-Kestrel-CSRF", required: true },
            ],
            responses: {
              "200": {},
              "400": {},
              "401": {},
              "404": {},
              "413": {},
              "415": {},
              "429": {},
              "503": {},
            },
          },
        },
        "/api/v1/openapi.json": { get: { responses: { "401": {} } } },
        "/api/v1/session": { get: { responses: { "401": {} } } },
      },
    });
    const paths = openApiDocument["paths"];
    if (typeof paths !== "object" || paths === null || Array.isArray(paths)) {
      throw new Error("OpenAPI paths must be an object");
    }
    expect(paths["/auth/login"]).toHaveProperty("post");
    expect(paths["/auth/logout"]).toHaveProperty("post");
    expect(paths["/auth/step-up"]).toHaveProperty("post");
    expect(paths["/api/v1/operator/credentials"]).toHaveProperty("post");
    expect(paths["/api/v1/session"]).not.toHaveProperty("post");
    expect(paths).not.toHaveProperty("/auth/reset");

    const first = serializeJson(openApiDocument);
    expect(serializeJson(openApiDocument)).toBe(first);
    expect(first).not.toContain("generatedAt");
    expect(first.endsWith("\n")).toBe(true);
  });
});
