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
  ChangeOverviewPathAreaSchema,
  ChangeOverviewModelRenderingSchema,
  ChangeOverviewSchema,
  ChangeOverviewSourceFactsSchema,
  ChangeIntentSchema,
  ChangeIntentVersionCreatedSchema,
  ConfigureDirectApiProfileCommandSchema,
  CreateChangeIntentVersionCommandSchema,
  CredentialChangeCommandSchema,
  DiagnosticAcceptedSchema,
  DirectApiProfileResponseSchema,
  EventCursorSchema,
  InstallationEventSchema,
  InstallationSnapshotSchema,
  LoginCommandSchema,
  LocalRepositoryInventorySchema,
  LocalRepositoryReferencesSchema,
  OpenLocalProjectCommandSchema,
  OpenPublicGitHubPullRequestCommandSchema,
  ProjectInboxSchema,
  RetainReviewRevisionCommandSchema,
  ReviewPreparationSchema,
  ReviewRevisionAvailableSchema,
  ReviewRevisionSchema,
  ReviewWorkflowAcceptedSchema,
  SessionSchema,
  StartReviewWorkflowCommandSchema,
  StepUpCommandSchema,
  StepUpProofSchema,
  serializeConfigureDirectApiProfileCommand,
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

  it("binds one step-up proof to a complete Project-exclusive Direct API profile", () => {
    const command = ConfigureDirectApiProfileCommandSchema.parse({
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
    });

    expect(serializeConfigureDirectApiProfileCommand(command)).toBe(JSON.stringify(command));
    expect(command).not.toHaveProperty("endpoint");
    expect(command).not.toHaveProperty("tools");
    expect(
      StepUpCommandSchema.parse({
        action: "model_credentials_change",
        password: "current correct horse battery staple",
        requestDigest: "5".repeat(64),
        targetId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
      }),
    ).not.toHaveProperty("apiKey");
    expect(() =>
      ConfigureDirectApiProfileCommandSchema.parse({
        ...command,
        endpoint: "https://attacker.example/v1/responses",
      }),
    ).toThrow();
  });

  it("exposes the effective Direct API identity without credential material", () => {
    const response = DirectApiProfileResponseSchema.parse({
      schemaVersion: 1,
      profile: {
        id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
        projectId: "018f0f89-8f75-7cc4-9860-3fda5f75d697",
        availability: "available",
        availabilityReasons: [],
        displayName: "OpenAI direct review",
        effectiveIdentity: {
          apiSurface: "responses",
          apiVersion: "2020-10-01",
          endpointOrigin: "https://api.openai.com",
          endpointPath: "/v1/responses",
          model: {
            expectedResolvedId: "gpt-test-2026-08-01",
            requestedId: "gpt-test-2026-08-01",
            versionPolicy: "pinned",
          },
          openAiProjectId: "proj_example",
          organizationId: "org_example",
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
        limits: {
          maximumAttempts: 1,
          maximumConcurrentRequests: 1,
          maximumCostUsd: "2.500000",
          maximumInputTokens: 100_000,
          maximumOutputTokens: 8_192,
          maximumRequestBytes: 1_048_576,
          requestTimeoutMilliseconds: 60_000,
        },
        priceSnapshot: {
          cachedInputPerMillionTokensUsd: "0.125000",
          capturedAt: "2026-08-31T12:00:00.000Z",
          currency: "USD",
          effectiveAt: "2026-08-01T00:00:00.000Z",
          inputPerMillionTokensUsd: "1.250000",
          outputPerMillionTokensUsd: "10.000000",
          sourceUrl: "https://developers.openai.com/api/docs/pricing",
        },
        profileDigest: "6".repeat(64),
        lastTest: {
          attributedOpenAiProjectId: "proj_example",
          observedApiVersion: "2020-10-01",
          observedModel: "gpt-test-2026-08-01",
          observedOrganizationId: "org_example",
          passedAt: "2026-08-31T12:01:00.000Z",
          requestId: "req_synthetic_example",
        },
        createdAt: "2026-08-31T12:01:00.000Z",
        updatedAt: "2026-08-31T12:01:00.000Z",
      },
    });

    expect(JSON.stringify(response)).not.toContain("sk-project-exclusive");
    expect(response.profile).not.toHaveProperty("credentialHandle");
    expect(response.profile).not.toHaveProperty("apiKey");
    if (response.profile === null) throw new Error("Expected a configured Direct API profile");
    const configuredProfile = response.profile;
    expect(() =>
      DirectApiProfileResponseSchema.parse({
        ...response,
        profile: {
          ...configuredProfile,
          lastTest: { ...configuredProfile.lastTest, attributedOpenAiProjectId: "proj_other" },
        },
      }),
    ).toThrow();
    expect(() =>
      DirectApiProfileResponseSchema.parse({
        ...response,
        profile: { ...configuredProfile, credentialHandle: "secret_handle" },
      }),
    ).toThrow();
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

  it("opens a local Project from only an opaque repository identity", () => {
    const command = {
      repositoryId: "018f0f89-9a1d-7484-b224-866ef9d69990",
    };

    expect(OpenLocalProjectCommandSchema.parse(command)).toEqual(command);
    expect(() =>
      OpenLocalProjectCommandSchema.parse({
        ...command,
        path: "/Users/operator/repository",
      }),
    ).toThrow();
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
      { headRepositoryUrl: "https://github.com/untrusted/fork.git" },
      { headRepository: { name: "fork", owner: "untrusted" } },
      { pullRequestNumber: 42 },
    ]) {
      expect(() =>
        RetainReviewRevisionCommandSchema.parse({ ...command, ...untrustedPointer }),
      ).toThrow();
    }
  });

  it("accepts structured Change Intent input without trusting source snapshots from the client", () => {
    const command = {
      expectedProposalVersion: 3,
      objective: "Keep repository access explicit and read-only.",
      scopeBoundaries: ["Do not add provider write authority."],
      acceptanceOutcomes: [
        "The Operator can inspect the selected repository without exposing its path.",
        "Provider metadata remains optional context.",
      ],
      selectedSourceIds: ["provider_title", "head_commit_message"],
      operatorInput: "Focus the review on the local authorization boundary.",
      unresolvedIssues: [],
    } as const;

    expect(CreateChangeIntentVersionCommandSchema.parse(command)).toEqual(command);
    expect(() =>
      CreateChangeIntentVersionCommandSchema.parse({
        ...command,
        selectedSources: [
          {
            id: "provider_title",
            text: "Client-forged provider title",
            provenance: { kind: "provider_field", field: "title" },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      CreateChangeIntentVersionCommandSchema.parse({
        ...command,
        selectedSourceIds: ["provider_title", "provider_title"],
      }),
    ).toThrow();
    expect(() =>
      CreateChangeIntentVersionCommandSchema.parse({
        ...command,
        selectedSourceIds: Array.from({ length: 20 }, (_, index) => `source_${String(index)}`),
      }),
    ).toThrow("20 selected sources");
    expect(() =>
      CreateChangeIntentVersionCommandSchema.parse({
        expectedProposalVersion: 3,
        objective: null,
        scopeBoundaries: [],
        acceptanceOutcomes: [],
        selectedSourceIds: [],
        operatorInput: null,
        unresolvedIssues: [],
      }),
    ).toThrow("intent material");
  });

  it("represents a resolved Change Intent with immutable source provenance", () => {
    const source = {
      id: "provider_title",
      kind: "provider_field",
      label: "GitHub title",
      text: "Keep repository access explicit",
      version: "2026-08-24T12:01:00.000Z",
      provenance: {
        kind: "provider_field",
        provider: "github",
        field: "title",
        observedAt: "2026-08-24T12:01:00.000Z",
        canonicalUrl: "https://github.com/openai/openai-node/pull/1234",
      },
    } as const;
    const intent = {
      id: "018f0f89-9a20-79f9-9990-dda80c9b917e",
      version: 2,
      text: "Keep repository access explicit and read-only.",
      objective: "Keep repository access explicit and read-only.",
      scopeBoundaries: ["Do not add provider write authority."],
      acceptanceOutcomes: ["Provider metadata remains optional context."],
      sources: [source],
      sourceDigest: "a".repeat(64),
      resolution: { state: "resolved", issues: [] },
      createdAt: "2026-08-24T12:02:00.000Z",
    } as const;

    expect(ChangeIntentSchema.parse(intent)).toEqual(intent);
    expect(
      ChangeIntentVersionCreatedSchema.parse({
        schemaVersion: 1,
        projectId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
        changeProposalId: "018f0f89-9192-755f-aa96-f72094c734dd",
        proposalVersion: 4,
        changeIntent: intent,
      }),
    ).toMatchObject({ proposalVersion: 4, changeIntent: { resolution: { state: "resolved" } } });
    expect(() => ChangeIntentSchema.parse({ ...intent, sourceDigest: "not-a-digest" })).toThrow();
    expect(() => ChangeIntentSchema.parse({ ...intent, objective: null })).toThrow(
      "Resolved Change Intent",
    );
    expect(() => ChangeIntentSchema.parse({ ...intent, sources: [source, source] })).toThrow(
      "source identity",
    );
  });

  it("publishes only source-linked deterministic Change Overview facts", () => {
    const changeIntent = {
      id: "018f0f89-9a20-79f9-9990-dda80c9b917e",
      version: 2,
      text: "Keep repository access explicit and read-only.",
      objective: "Keep repository access explicit and read-only.",
      scopeBoundaries: ["Do not add provider write authority."],
      acceptanceOutcomes: ["Provider metadata remains optional context."],
      sources: [
        {
          id: "provider_title",
          kind: "provider_field",
          label: "GitHub title",
          text: "Keep repository access explicit",
          version: "2026-08-24T12:01:00.000Z",
          provenance: {
            kind: "provider_field",
            provider: "github",
            field: "title",
            observedAt: "2026-08-24T12:01:00.000Z",
            canonicalUrl: "https://github.com/openai/openai-node/pull/1234",
          },
        },
      ],
      sourceDigest: "a".repeat(64),
      resolution: { state: "resolved", issues: [] },
      createdAt: "2026-08-24T12:02:00.000Z",
    } as const;
    const overview = {
      state: "ready",
      createdAt: "2026-08-24T12:03:00.000Z",
      exactRevision: {
        id: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
        objectFormat: "sha1",
        base: {
          objectId: "b".repeat(40),
          ref: "refs/heads/main",
          author: "Base Author",
          subject: "Establish the source boundary",
        },
        head: {
          objectId: "c".repeat(40),
          ref: "refs/heads/review-source",
          author: "Head Author",
          subject: "Keep repository access explicit",
        },
      },
      changeIntent,
      providerObservation: {
        canonicalUrl: "https://github.com/openai/openai-node/pull/1234",
        observedAt: "2026-08-24T12:01:00.000Z",
        title: "Keep repository access explicit",
        description: "Retain only the exact committed source.",
      },
      modelRendering: {
        state: "ready",
        requestedAt: "2026-08-24T12:03:00.000Z",
        startedAt: "2026-08-24T12:03:00.050Z",
        completedAt: "2026-08-24T12:03:01.175Z",
        providerRequestId: "req_overview_1",
        sentences: [
          {
            text: "The retained change modifies 2 files under `src`.",
            sourceFactIds: ["file_statistics", "path_area_001"],
          },
        ],
        performance: {
          queueMilliseconds: 50,
          modelMilliseconds: 1_000,
          kestrelMilliseconds: 125,
          totalMilliseconds: 1_175,
        },
      },
      sourceFacts: {
        ruleVersion: 1,
        commitStatistics: { baseTreeFileCount: 1, headTreeFileCount: 2 },
        fileStatistics: { added: 1, modified: 1, deleted: 0, total: 2 },
        changedFiles: [
          {
            path: "src/review.ts",
            status: "modified",
            base: { mode: "100644", objectId: "d".repeat(40), type: "blob" },
            head: { mode: "100644", objectId: "e".repeat(40), type: "blob" },
          },
          {
            path: "src/source.ts",
            status: "added",
            base: null,
            head: { mode: "100644", objectId: "f".repeat(40), type: "blob" },
          },
        ],
        pathAreas: [
          {
            pathPrefix: "src",
            changedFileCount: 2,
            samplePaths: ["src/review.ts", "src/source.ts"],
          },
        ],
        warnings: [],
      },
    } as const;

    expect(ChangeOverviewSchema.parse(overview)).toEqual(overview);
    expect(
      ChangeOverviewSchema.parse({
        state: "awaiting_source",
        exactHeadObjectId: "c".repeat(40),
      }),
    ).toEqual({ state: "awaiting_source", exactHeadObjectId: "c".repeat(40) });
    expect(() => ChangeOverviewSchema.parse({ ...overview, graph: [] })).toThrow();
    expect(() =>
      ChangeOverviewSchema.parse({
        ...overview,
        sourceFacts: {
          ...overview.sourceFacts,
          findings: [{ riskLevel: "high" }],
        },
      }),
    ).toThrow();

    expect(
      ChangeOverviewModelRenderingSchema.parse({
        state: "unavailable",
        requestedAt: "2026-08-24T12:03:00.000Z",
        completedAt: "2026-08-24T12:03:00.125Z",
        reason: "profile_not_configured",
        performance: {
          queueMilliseconds: 25,
          modelMilliseconds: 0,
          kestrelMilliseconds: 100,
          totalMilliseconds: 125,
        },
      }),
    ).toMatchObject({ state: "unavailable", reason: "profile_not_configured" });
    expect(
      ChangeOverviewModelRenderingSchema.parse({
        state: "queued",
        requestedAt: "2026-08-24T12:03:00.000Z",
      }),
    ).toMatchObject({ state: "queued" });
    expect(() =>
      ChangeOverviewModelRenderingSchema.parse({
        ...overview.modelRendering,
        performance: { ...overview.modelRendering.performance, totalMilliseconds: 1_176 },
      }),
    ).toThrow("latencies");
    expect(() =>
      ChangeOverviewModelRenderingSchema.parse({
        ...overview.modelRendering,
        sentences: [
          {
            text: "Duplicate citations are ambiguous.",
            sourceFactIds: ["file_statistics", "file_statistics"],
          },
        ],
      }),
    ).toThrow("source fact identities");

    expect(
      ChangeOverviewPathAreaSchema.parse({
        pathPrefix: "a".repeat(256),
        changedFileCount: 1,
        samplePaths: [`${"a".repeat(256)}/review.ts`],
      }),
    ).toEqual({
      pathPrefix: "a".repeat(256),
      changedFileCount: 1,
      samplePaths: [`${"a".repeat(256)}/review.ts`],
    });
    expect(
      ChangeOverviewSourceFactsSchema.parse({
        ...overview.sourceFacts,
        pathAreas: [
          { pathPrefix: null, changedFileCount: 1, samplePaths: ["README.md"] },
          {
            pathPrefix: "repository_root",
            changedFileCount: 1,
            samplePaths: ["repository_root/review.ts"],
          },
        ],
      }).pathAreas,
    ).toHaveLength(2);
  });

  it("lists bounded local repositories and committed refs without filesystem paths", () => {
    const repositoryId = "018f0f89-9a1d-7484-b224-866ef9d69990";
    const inventory = {
      schemaVersion: 1,
      inventoryState: "ready",
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
    expect(
      LocalRepositoryInventorySchema.parse({
        schemaVersion: 1,
        inventoryState: "no_configured_roots",
        repositories: [],
      }),
    ).toEqual({
      schemaVersion: 1,
      inventoryState: "no_configured_roots",
      repositories: [],
    });
    expect(
      LocalRepositoryInventorySchema.parse({
        schemaVersion: 1,
        inventoryState: "no_repositories_found",
        repositories: [],
      }),
    ).toEqual({
      schemaVersion: 1,
      inventoryState: "no_repositories_found",
      repositories: [],
    });
    expect(() =>
      LocalRepositoryInventorySchema.parse({
        schemaVersion: 1,
        inventoryState: "ready",
        repositories: [],
      }),
    ).toThrow();
    expect(() =>
      LocalRepositoryInventorySchema.parse({
        ...inventory,
        inventoryState: "no_configured_roots",
      }),
    ).toThrow();
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
              changeIntentCandidates: [
                {
                  id: "provider_title",
                  kind: "provider_field",
                  label: "GitHub title",
                  text: "Keep repository access explicit",
                  version: "2026-08-24T12:01:00.000Z",
                  provenance: {
                    kind: "provider_field",
                    provider: "github",
                    field: "title",
                    observedAt: "2026-08-24T12:01:00.000Z",
                    canonicalUrl: "https://github.com/openai/openai-node/pull/1234",
                  },
                },
              ],
              kind: "provider_observed",
              id: "018f0f89-9192-755f-aa96-f72094c734dd",
              version: 1,
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
              version: 1,
              title: "Review local authorization changes",
              base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
              head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
              changeIntent: {
                id: "018f0f89-9a20-79f9-9990-dda80c9b917d",
                version: 1,
                text: "Review the authorization boundary.",
                objective: "Review the authorization boundary.",
                scopeBoundaries: [],
                acceptanceOutcomes: [],
                sources: [
                  {
                    id: "operator_input",
                    kind: "operator_input",
                    label: "Operator input",
                    text: "Review the authorization boundary.",
                    version: "1",
                    provenance: { kind: "operator_input" },
                  },
                ],
                sourceDigest: "b".repeat(64),
                resolution: {
                  state: "unresolved",
                  issues: [
                    { kind: "missing", field: "scope_boundaries" },
                    { kind: "missing", field: "acceptance_outcomes" },
                  ],
                },
                createdAt: "2026-08-24T12:00:30.000Z",
              },
              changeIntentCandidates: [],
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
      objective: "Review the next exact revision.",
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

  it("binds only complete exact inputs into a ready Review preparation", () => {
    const preparation = {
      schemaVersion: 1,
      projectId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
      changeProposalId: "018f0f89-9192-755f-aa96-f72094c734dd",
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
          state: "detached",
          objectFormat: "sha1",
          createdAt: "2026-08-24T12:00:00.000Z",
          updatedAt: "2026-08-24T12:03:00.000Z",
        },
        providerObservation: {
          route: {
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
          proposal: {
            canonicalUrl: "https://github.com/openai/openai-node/pull/1234",
            number: 1234,
            observedAt: "2026-08-24T12:01:00.000Z",
            providerId: "PR_kwDOGx",
          },
        },
      },
      analysisConfiguration: {
        id: "018f0f89-a21d-7e31-8d27-aa4383f22991",
        version: 3,
        displayName: "Direct API review profile",
        modelRoute: "direct_api",
        digest: "d".repeat(64),
      },
      modelRouteAvailability: "available",
      authority: {
        action: "start_review",
        operatorId: "018f0f89-a3fb-75ee-bccc-08c031ce5f10",
        state: "available",
      },
      resourceEnvelope: {
        id: "review-first-v1-default",
        version: 1,
        displayName: "Review First V1 default envelope",
        limits: {
          maximumMemoryBytes: 1_073_741_824,
          maximumProcesses: 64,
          maximumWritableDiskBytes: 2_147_483_648,
          maximumCpuMillicores: 1_000,
          maximumConcurrentAttempts: 1,
        },
        terminalBoundary: {
          onExhaustion: "partial_or_failed",
          requiresUncoveredAreaDisclosure: true,
        },
        digest: "e".repeat(64),
      },
      readiness: "ready",
      blockers: [],
      preparationDigest: "f".repeat(64),
    } as const;

    expect(ReviewPreparationSchema.parse(preparation)).toEqual(preparation);
    expect(() =>
      ReviewPreparationSchema.parse({
        ...preparation,
        reviewRevision: null,
      }),
    ).toThrow("Ready Review preparation requires complete valid inputs");

    const blocked = {
      ...preparation,
      modelRouteAvailability: "unavailable",
      readiness: "blocked",
      blockers: ["model_route_not_available"],
      preparationDigest: null,
    } as const;
    expect(ReviewPreparationSchema.parse(blocked)).toEqual(blocked);
    expect(blocked.analysisConfiguration).toEqual(preparation.analysisConfiguration);
    expect(() =>
      ReviewPreparationSchema.parse({
        ...preparation,
        analysisConfiguration: null,
      }),
    ).toThrow("Available model route requires a selected Analysis Configuration");
  });

  it("starts a Review Workflow from only the server-issued preparation digest", () => {
    const command = { preparationDigest: "f".repeat(64) } as const;
    expect(StartReviewWorkflowCommandSchema.parse(command)).toEqual(command);
    expect(() =>
      StartReviewWorkflowCommandSchema.parse({
        ...command,
        reviewRevisionId: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
      }),
    ).toThrow();

    const accepted = {
      schemaVersion: 1,
      workflow: {
        id: "018f0f89-a45f-79af-8544-650e9f15c211",
        projectId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
        changeProposalId: "018f0f89-9192-755f-aa96-f72094c734dd",
        reviewRevisionId: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
        changeIntentId: "018f0f89-9a20-79f9-9990-dda80c9b917e",
        inputDigest: command.preparationDigest,
        analysisConfiguration: {
          id: "018f0f89-a21d-7e31-8d27-aa4383f22991",
          version: 3,
          displayName: "Direct API review profile",
          modelRoute: "direct_api",
          digest: "d".repeat(64),
        },
        authority: {
          action: "start_review",
          operatorId: "018f0f89-a3fb-75ee-bccc-08c031ce5f10",
          state: "available",
        },
        resourceEnvelope: {
          id: "review-first-v1-default",
          version: 1,
          displayName: "Review First V1 default envelope",
          limits: {
            maximumMemoryBytes: 1_073_741_824,
            maximumProcesses: 64,
            maximumWritableDiskBytes: 2_147_483_648,
            maximumCpuMillicores: 1_000,
            maximumConcurrentAttempts: 1,
          },
          terminalBoundary: {
            onExhaustion: "partial_or_failed",
            requiresUncoveredAreaDisclosure: true,
          },
          digest: "e".repeat(64),
        },
        state: "queued",
        requestedAt: "2026-08-24T12:04:00.000Z",
      },
    } as const;

    expect(ReviewWorkflowAcceptedSchema.parse(accepted)).toEqual(accepted);
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
    for (const failureReason of [
      "base_revision_unresolvable",
      "head_revision_unresolvable",
      "pull_ref_mismatch",
      "provider_authentication_required",
      "provider_resource_unavailable",
    ] as const) {
      expect(
        ReviewRevisionSchema.parse({
          ...revision,
          state: "unavailable",
          objectCount: null,
          retainedBytes: null,
          failureReason,
          availableAt: null,
        }),
      ).toMatchObject({ failureReason, state: "unavailable" });
    }
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
        "/api/v1/projects/{projectId}/model-profiles/direct-api": {},
        "/api/v1/projects/{projectId}/model-profiles/direct-api/test": {},
        "/api/v1/projects/{projectId}/change-proposals/{changeProposalId}/change-intents": {},
        "/api/v1/projects/{projectId}/change-proposals/{changeProposalId}/review-preparation": {},
        "/api/v1/projects/{projectId}/change-proposals/{changeProposalId}/review-workflows": {},
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
        "/api/v1/projects/{projectId}/model-profiles/direct-api": {
          get: { responses: { "200": {}, "400": {}, "401": {}, "404": {}, "503": {} } },
          post: {
            parameters: [
              { in: "header", name: "Origin", required: true },
              { in: "header", name: "X-Kestrel-CSRF", required: true },
              { in: "header", name: "X-Kestrel-Step-Up", required: true },
              { in: "path", name: "projectId", required: true },
            ],
            responses: {
              "201": {},
              "400": {},
              "401": {},
              "403": {},
              "404": {},
              "409": {},
              "413": {},
              "415": {},
              "422": {},
              "429": {},
              "503": {},
            },
          },
        },
        "/api/v1/projects/{projectId}/model-profiles/direct-api/test": {
          post: {
            parameters: [
              { in: "header", name: "Origin", required: true },
              { in: "header", name: "X-Kestrel-CSRF", required: true },
              { in: "path", name: "projectId", required: true },
            ],
            responses: {
              "200": {},
              "400": {},
              "401": {},
              "403": {},
              "404": {},
              "409": {},
              "429": {},
              "503": {},
            },
          },
        },
        "/api/v1/projects/{projectId}/change-proposals/{changeProposalId}/change-intents": {
          post: {
            parameters: [
              { in: "header", name: "Origin", required: true },
              { in: "header", name: "X-Kestrel-CSRF", required: true },
              { in: "path", name: "projectId", required: true },
              { in: "path", name: "changeProposalId", required: true },
            ],
            responses: {
              "201": {},
              "400": {},
              "401": {},
              "403": {},
              "404": {},
              "409": {},
              "413": {},
              "415": {},
              "500": {},
            },
          },
        },
        "/api/v1/projects/{projectId}/change-proposals/{changeProposalId}/review-preparation": {
          get: {
            responses: { "200": {}, "400": {}, "401": {}, "404": {}, "503": {} },
          },
        },
        "/api/v1/projects/{projectId}/change-proposals/{changeProposalId}/review-workflows": {
          post: {
            parameters: [
              { in: "header", name: "Origin", required: true },
              { in: "header", name: "X-Kestrel-CSRF", required: true },
              { in: "path", name: "projectId", required: true },
              { in: "path", name: "changeProposalId", required: true },
            ],
            responses: {
              "202": {},
              "400": {},
              "401": {},
              "403": {},
              "404": {},
              "409": {},
              "413": {},
              "415": {},
              "500": {},
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
