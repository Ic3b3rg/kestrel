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
  LocalRepositoryInventorySchema,
  LocalRepositoryReferencesSchema,
  OpenPublicGitHubPullRequestCommandSchema,
  ProjectInboxSchema,
  RetainReviewRevisionCommandSchema,
  ReviewRevisionAvailableSchema,
  ReviewRevisionSchema,
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

  it("accepts only opaque local-repository acquisition input", () => {
    const command = {
      repositoryId: "018f0f89-9a1d-7484-b224-866ef9d69990",
      baseRef: "refs/heads/main",
      headRef: "refs/heads/review-source",
      changeIntent: "Review the authorization boundary without changing repository state.",
    };

    expect(RetainReviewRevisionCommandSchema.parse(command)).toEqual(command);
    expect(() =>
      RetainReviewRevisionCommandSchema.parse({
        ...command,
        path: "/Users/operator/repository",
      }),
    ).toThrow();
    expect(() =>
      RetainReviewRevisionCommandSchema.parse({
        ...command,
        headObjectId: "b".repeat(40),
      }),
    ).toThrow();
    expect(() =>
      RetainReviewRevisionCommandSchema.parse({ ...command, headRef: command.baseRef }),
    ).toThrow("different");
  });

  it("accepts only opaque observed pull-request acquisition input", () => {
    const command = {
      projectId: "018f0f89-a21d-7e31-8d27-aa4383f22991",
      changeProposalId: "018f0f89-a3fb-75ee-bccc-08c031ce5f10",
      changeIntent: "Review the observed pull request from the attached local repository source.",
    };

    expect(RetainReviewRevisionCommandSchema.parse(command)).toEqual(command);

    for (const untrustedPointer of [
      { repositoryId: "018f0f89-9a1d-7484-b224-866ef9d69990" },
      { baseRef: "refs/heads/main" },
      { headRef: "refs/pull/42/head" },
      { baseObjectId: "a".repeat(40) },
      { headObjectId: "b".repeat(40) },
      { remoteUrl: "https://github.com/kestrel/review-source.git" },
      { pullRequestNumber: 42 },
    ]) {
      expect(() =>
        RetainReviewRevisionCommandSchema.parse({ ...command, ...untrustedPointer }),
      ).toThrow();
    }
  });

  it("lists bounded local repositories and committed refs without filesystem paths", () => {
    const repositoryId = "018f0f89-9a1d-7484-b224-866ef9d69990";
    const inventory = {
      schemaVersion: 1,
      repositories: [
        {
          repositoryId,
          displayName: "kestrel",
          attachmentState: "unattached",
        },
      ],
    } as const;
    const references = {
      schemaVersion: 1,
      repositoryId,
      objectFormat: "sha1",
      references: [
        {
          ref: "refs/heads/main",
          displayName: "main",
          kind: "local_branch",
          commitObjectId: "a".repeat(40),
          commitSubjectSuggestion: "Keep local source read-only",
        },
      ],
    } as const;

    expect(LocalRepositoryInventorySchema.parse(inventory)).toEqual(inventory);
    expect(LocalRepositoryReferencesSchema.parse(references)).toEqual(references);
    expect(() =>
      LocalRepositoryInventorySchema.parse({
        ...inventory,
        repositories: [{ ...inventory.repositories[0], path: "/private/repository" }],
      }),
    ).toThrow();
    expect(() =>
      LocalRepositoryReferencesSchema.parse({
        ...references,
        references: [{ ...references.references[0], commitObjectId: "a".repeat(64) }],
      }),
    ).toThrow();
  });

  it("keeps a public GitHub Provider Observation separate from source and model access", () => {
    const inbox = ProjectInboxSchema.parse({
      schemaVersion: 1,
      projects: [
        {
          id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
          providerObservation: {
            authentication: "none",
            kind: "public_github",
            refresh: "manual",
          },
          repository: {
            canonicalUrl: "https://github.com/openai/openai-node",
            name: "openai-node",
            owner: "openai",
            providerId: "R_kgDOGx",
          },
          sourceAvailability: "not_acquired",
          modelAccess: "not_configured",
          createdAt: "2026-08-24T12:00:00.000Z",
          updatedAt: "2026-08-24T12:01:00.000Z",
          changeProposals: [
            {
              changeIntent: null,
              kind: "provider_observed",
              id: "018f0f89-9192-755f-aa96-f72094c734dd",
              providerId: "PR_kwDOGx",
              number: 1234,
              title: "Keep repository access explicit",
              canonicalUrl: "https://github.com/openai/openai-node/pull/1234",
              proposalState: "open",
              reviewRevisions: [],
              base: { objectId: "a".repeat(40), ref: "main" },
              head: { objectId: "b".repeat(40), ref: "provider-observation" },
              author: { login: "octocat", providerId: "U_kgDOA" },
              observedAt: "2026-08-24T12:01:00.000Z",
            },
          ],
          localRepositorySource: null,
        },
      ],
    });

    expect(inbox.projects[0]).toMatchObject({
      providerObservation: {
        authentication: "none",
        kind: "public_github",
        refresh: "manual",
      },
      sourceAvailability: "not_acquired",
    });
    expect(inbox.projects[0]).not.toHaveProperty("repositoryAccess");
  });

  it("represents local source, Revision State, provider metadata, and model access independently", () => {
    const project = ProjectInboxSchema.parse({
      schemaVersion: 1,
      projects: [
        {
          id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
          providerObservation: null,
          repository: null,
          localRepositorySource: {
            id: "018f0f89-9a1d-7484-b224-866ef9d69990",
            repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
            displayName: "kestrel",
            state: "attached",
            objectFormat: "sha1",
            createdAt: "2026-08-24T12:00:00.000Z",
            updatedAt: "2026-08-24T12:01:00.000Z",
          },
          sourceAvailability: "available",
          modelAccess: "not_configured",
          createdAt: "2026-08-24T12:00:00.000Z",
          updatedAt: "2026-08-24T12:01:00.000Z",
          changeProposals: [
            {
              kind: "local",
              id: "018f0f89-9192-755f-aa96-f72094c734dd",
              title: "Review local authorization changes",
              base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
              head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
              changeIntent: {
                id: "018f0f89-9a20-79f9-9990-dda80c9b917d",
                version: 1,
                text: "Review the authorization boundary.",
                createdAt: "2026-08-24T12:00:30.000Z",
              },
              reviewRevisions: [
                {
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
              ],
              createdAt: "2026-08-24T12:00:30.000Z",
              updatedAt: "2026-08-24T12:01:00.000Z",
            },
          ],
        },
      ],
    }).projects[0];

    expect(project).toMatchObject({
      providerObservation: null,
      repository: null,
      localRepositorySource: { state: "attached" },
      sourceAvailability: "available",
      modelAccess: "not_configured",
      changeProposals: [{ kind: "local", reviewRevisions: [{ state: "available" }] }],
    });

    const localSource = project?.localRepositorySource;
    const originalProposal = project?.changeProposals[0];
    if (
      project === undefined ||
      localSource === null ||
      localSource === undefined ||
      originalProposal?.kind !== "local"
    ) {
      throw new Error("Local Review Revision contract fixture is unavailable");
    }
    const retainedRevision = originalProposal.reviewRevisions[0];
    if (retainedRevision === undefined) {
      throw new Error("Retained Review Revision contract fixture is unavailable");
    }
    const acquisitionChangeIntent = originalProposal.changeIntent;
    const currentChangeIntent = {
      ...acquisitionChangeIntent,
      id: "018f0f89-9a20-79f9-9990-dda80c9b917e",
      text: "Review the next exact revision.",
      version: 2,
    };
    const currentProposal = { ...originalProposal, changeIntent: currentChangeIntent };
    const published = ReviewRevisionAvailableSchema.parse({
      schemaVersion: 1,
      project: { ...project, changeProposals: [currentProposal] },
      localRepositorySource: localSource,
      changeProposal: currentProposal,
      acquisitionChangeIntent,
      reviewRevision: retainedRevision,
    });

    expect(published.acquisitionChangeIntent.version).toBe(1);
    expect(published.changeProposal.changeIntent?.version).toBe(2);
  });

  it("rejects partial lifecycle fields and publishes only an available Review Revision", () => {
    const revision = {
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
    } as const;
    expect(ReviewRevisionSchema.parse(revision)).toEqual(revision);
    expect(() =>
      ReviewRevisionSchema.parse({
        ...revision,
        state: "acquiring",
        objectCount: null,
        retainedBytes: null,
        failureReason: "object_missing",
        availableAt: null,
      }),
    ).toThrow();
    expect(() =>
      ReviewRevisionSchema.parse({
        ...revision,
        state: "unavailable",
        objectCount: 1,
        retainedBytes: null,
        failureReason: "object_missing",
        availableAt: null,
      }),
    ).toThrow();
    expect(() => ReviewRevisionSchema.parse({ ...revision, objectCount: 0 })).toThrow();
    expect(() =>
      ReviewRevisionAvailableSchema.parse({ schemaVersion: 1, reviewRevision: revision }),
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
        "/auth/logout": {},
        "/auth/login": {},
        "/auth/step-up": {},
        "/api/v1/session": {},
        "/api/v1/operator/credentials": {},
        "/api/v1/projects": {},
        "/api/v1/local-repository-sources": {},
        "/api/v1/local-repository-sources/{repositoryId}/references": {},
        "/api/v1/review-revisions": {},
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
