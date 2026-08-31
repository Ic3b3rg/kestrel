import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import type {
  ApiError,
  ChangeIntentVersionCreated,
  DiagnosticAccepted,
  DirectApiProfileResponse,
  ConfigureDirectApiProfileCommand,
  InstallationEvent,
  InstallationSnapshot,
  ProjectInbox,
  LocalRepositoryInventory,
  LocalRepositoryReferences,
  ReviewPreparation,
  ReviewWorkflowAccepted,
  Session,
} from "@kestrel/contracts";

import {
  createChangeIntentVersion,
  configureDirectApiProfile,
  fetchDirectApiProfile,
  fetchInstallation,
  fetchProjectInbox,
  fetchLocalRepositories,
  fetchLocalRepositoryReferences,
  fetchReviewPreparation,
  fetchSession,
  loginOperator,
  logoutOperator,
  openPublicGitHubPullRequest,
  runDiagnostic,
  retainReviewRevision,
  startReviewWorkflow,
  streamInstallationEvents,
  testDirectApiProfile,
  updateOperatorCredentials,
} from "./api.js";

const installationId = "018f0f89-8f75-7cc4-9860-3fda5f75d697";
const diagnosticId = "018f0f89-9192-755f-aa96-f72094c734dd";
const directApiProjectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const directApiCommand: ConfigureDirectApiProfileCommand = {
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
const directApiResponse: DirectApiProfileResponse = {
  schemaVersion: 1,
  profile: {
    id: "018f0f89-a3fb-75ee-bccc-08c031ce5f10",
    projectId: directApiProjectId,
    availability: "available",
    availabilityReasons: [],
    displayName: directApiCommand.displayName,
    effectiveIdentity: {
      apiSurface: "responses",
      apiVersion: "2020-10-01",
      endpointOrigin: "https://api.openai.com",
      endpointPath: "/v1/responses",
      model: directApiCommand.model,
      openAiProjectId: directApiCommand.openAiProjectId,
      organizationId: directApiCommand.organizationId,
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
    dataPolicy: directApiCommand.dataPolicy,
    limits: directApiCommand.limits,
    priceSnapshot: directApiCommand.priceSnapshot,
    profileDigest: "6".repeat(64),
    lastTest: {
      observedApiVersion: "2020-10-01",
      observedModel: directApiCommand.model.expectedResolvedId,
      observedOrganizationId: directApiCommand.organizationId,
      passedAt: "2026-08-31T12:01:00.000Z",
      requestId: "req_synthetic_example",
    },
    createdAt: "2026-08-31T12:01:00.000Z",
    updatedAt: "2026-08-31T12:01:00.000Z",
  },
};

const snapshot: InstallationSnapshot = {
  schemaVersion: 1,
  installation: {
    id: installationId,
    state: "ready",
    currentDiagnosticId: null,
    revision: "0",
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-24T12:00:00.000Z",
  },
  diagnostic: null,
  eventCursor: "0",
};

const accepted: DiagnosticAccepted = {
  schemaVersion: 1,
  installation: {
    ...snapshot.installation,
    state: "diagnostic_queued",
    currentDiagnosticId: diagnosticId,
    revision: "1",
    updatedAt: "2026-08-24T12:01:00.000Z",
  },
  diagnostic: {
    id: diagnosticId,
    status: "queued",
    requestedAt: "2026-08-24T12:01:00.000Z",
    startedAt: null,
    completedAt: null,
  },
  eventCursor: "1",
};

const succeededEvent: InstallationEvent = {
  schemaVersion: 1,
  eventId: "10",
  aggregateType: "installation",
  aggregateId: installationId,
  aggregateVersion: "3",
  eventType: "installation.diagnostic.succeeded",
  occurredAt: "2026-08-24T12:01:02.000Z",
  correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
  causationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
  locator: { diagnosticId, installationId },
};

const session: Session = {
  schemaVersion: 1,
  credentialVersion: "1",
  operator: {
    id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
    username: "operator",
  },
  issuedAt: "2026-08-24T12:00:00.000Z",
  expiresAt: "2026-08-31T12:00:00.000Z",
};

const projectInbox: ProjectInbox = {
  schemaVersion: 1,
  projects: [
    {
      changeProposals: [
        {
          author: { login: "octocat", providerId: "U_kgDOA" },
          base: { objectId: "a".repeat(40), ref: "main" },
          canonicalUrl: "https://github.com/openai/openai-node/pull/1234",
          changeIntent: null,
          changeIntentCandidates: [],
          head: { objectId: "b".repeat(40), ref: "provider-observation" },
          id: "018f0f89-9192-755f-aa96-f72094c734dd",
          kind: "provider_observed",
          number: 1234,
          observedAt: "2026-08-24T12:01:00.000Z",
          proposalState: "open",
          providerId: "PR_kwDOGx",
          reviewRevisions: [],
          title: "Keep repository access explicit",
          version: 1,
        },
      ],
      createdAt: "2026-08-24T12:00:00.000Z",
      id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
      localRepositorySource: null,
      modelAccess: "not_configured",
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
      updatedAt: "2026-08-24T12:01:00.000Z",
    },
  ],
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function eventStreamResponse(event: InstallationEvent): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `id: ${event.eventId}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

function emptyEventStreamResponse(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PWA API client", () => {
  it("configures a Project profile through one bound password step-up and can re-test it", async () => {
    const proof = {
      schemaVersion: 1 as const,
      expiresAt: "2026-08-31T12:05:00.000Z",
      proof: "C".repeat(43),
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ schemaVersion: 1, profile: null }))
      .mockResolvedValueOnce(jsonResponse(proof))
      .mockResolvedValueOnce(jsonResponse(directApiResponse, 201))
      .mockResolvedValueOnce(jsonResponse(directApiResponse));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", {
      cookie: `__Host-kestrel-csrf=${"A".repeat(43)}.${"B".repeat(43)}`,
    });

    await expect(fetchDirectApiProfile(directApiProjectId)).resolves.toEqual({
      schemaVersion: 1,
      profile: null,
    });
    await expect(
      configureDirectApiProfile(
        directApiProjectId,
        directApiCommand,
        "current correct horse battery staple",
      ),
    ).resolves.toEqual(directApiResponse);
    await expect(testDirectApiProfile(directApiProjectId)).resolves.toEqual(directApiResponse);

    const requestDigest = createHash("sha256")
      .update(JSON.stringify(directApiCommand), "utf8")
      .digest("hex");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/auth/step-up",
      expect.objectContaining({
        body: JSON.stringify({
          action: "model_credentials_change",
          password: "current correct horse battery staple",
          requestDigest,
          targetId: directApiProjectId,
        }),
        method: "POST",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/v1/projects/${directApiProjectId}/model-profiles/direct-api`,
      expect.objectContaining({ body: JSON.stringify(directApiCommand), method: "POST" }),
    );
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("X-Kestrel-Step-Up")).toBe(
      proof.proof,
    );
    expect(fetchMock.mock.calls[2]?.[1]?.body).not.toContain("current correct horse");
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      `/api/v1/projects/${directApiProjectId}/model-profiles/direct-api/test`,
      expect.objectContaining({ body: "{}", method: "POST" }),
    );
  });
  it("reads Review preparation without mutation and starts from only its digest", async () => {
    const projectId = "018f0f89-9a22-7864-aac2-8df71bf60420";
    const proposalId = "018f0f89-9192-755f-aa96-f72094c734dd";
    const preparation: ReviewPreparation = {
      schemaVersion: 1,
      projectId,
      changeProposalId: proposalId,
      proposal: {
        version: 2,
        base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
        head: { objectId: "b".repeat(40), ref: "refs/heads/topic" },
      },
      reviewRevision: null,
      changeIntent: null,
      source: { localRepositorySource: null, providerObservation: null },
      analysisConfiguration: null,
      modelRouteAvailability: "unavailable",
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
      readiness: "blocked",
      blockers: [
        "revision_not_available",
        "change_intent_not_resolved",
        "model_route_not_available",
      ],
      preparationDigest: null,
    };
    const command = { preparationDigest: "f".repeat(64) };
    const resourceEnvelope = preparation.resourceEnvelope;
    if (resourceEnvelope === null) throw new Error("Review preparation fixture is incomplete");
    const accepted: ReviewWorkflowAccepted = {
      schemaVersion: 1,
      workflow: {
        id: "018f0f89-a45f-79af-8544-650e9f15c212",
        projectId,
        changeProposalId: proposalId,
        reviewRevisionId: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
        changeIntentId: "018f0f89-9a20-79f9-9990-dda80c9b917e",
        inputDigest: command.preparationDigest,
        analysisConfiguration: {
          id: "018f0f89-a45f-79af-8544-650e9f15c211",
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
        resourceEnvelope,
        state: "queued",
        requestedAt: "2026-08-24T12:04:00.000Z",
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(preparation))
      .mockResolvedValueOnce(jsonResponse(accepted, 202));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", {
      cookie: `__Host-kestrel-csrf=${"A".repeat(43)}.${"B".repeat(43)}`,
    });

    await expect(fetchReviewPreparation(projectId, proposalId)).resolves.toEqual(preparation);
    await expect(startReviewWorkflow(projectId, proposalId, command)).resolves.toEqual(accepted);
    const path = `/api/v1/projects/${projectId}/change-proposals/${proposalId}`;
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${path}/review-preparation`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${path}/review-workflows`,
      expect.objectContaining({ body: JSON.stringify(command), method: "POST" }),
    );
  });

  it("creates a Change Intent version with opaque source IDs", async () => {
    const projectId = "018f0f89-9a22-7864-aac2-8df71bf60420";
    const proposalId = "018f0f89-9192-755f-aa96-f72094c734dd";
    const command = {
      acceptanceOutcomes: ["The Proposal version advances."],
      expectedProposalVersion: 3,
      objective: "Keep repository access explicit.",
      operatorInput: null,
      scopeBoundaries: ["No provider writes."],
      selectedSourceIds: ["provider_title"],
      unresolvedIssues: [],
    };
    const response: ChangeIntentVersionCreated = {
      schemaVersion: 1,
      projectId,
      changeProposalId: proposalId,
      proposalVersion: 4,
      changeIntent: {
        acceptanceOutcomes: [...command.acceptanceOutcomes],
        createdAt: "2026-08-24T12:02:00.000Z",
        id: "018f0f89-9a20-79f9-9990-dda80c9b917e",
        objective: command.objective,
        resolution: { state: "resolved", issues: [] },
        scopeBoundaries: [...command.scopeBoundaries],
        sourceDigest: "a".repeat(64),
        sources: [
          {
            id: "provider_title",
            kind: "provider_field",
            label: "GitHub title",
            text: "Keep repository access explicit",
            version: "2026-08-24T12:01:00.000Z",
            provenance: {
              canonicalUrl: "https://github.com/openai/openai-node/pull/1234",
              field: "title",
              kind: "provider_field",
              observedAt: "2026-08-24T12:01:00.000Z",
              provider: "github",
            },
          },
        ],
        text: command.objective,
        version: 2,
      },
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(response, 201));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", {
      cookie: `__Host-kestrel-csrf=${"A".repeat(43)}.${"B".repeat(43)}`,
    });

    await expect(createChangeIntentVersion(projectId, proposalId, command)).resolves.toEqual(
      response,
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/projects/${projectId}/change-proposals/${proposalId}/change-intents`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") throw new Error("Change Intent request body is unavailable");
    expect(JSON.parse(body)).toEqual(command);
    expect(body).not.toContain("provenance");
  });

  it("uses only opaque local repository identities and enumerated refs", async () => {
    const inventory: LocalRepositoryInventory = {
      schemaVersion: 1,
      repositories: [
        {
          repositoryId: "018f0f89-9a1d-7484-b224-866ef9d69990",
          displayName: "kestrel",
          attachmentState: "unattached",
        },
      ],
    };
    const repository = inventory.repositories[0];
    if (repository === undefined) {
      throw new Error("Repository fixture is missing");
    }
    const references: LocalRepositoryReferences = {
      schemaVersion: 1,
      repositoryId: repository.repositoryId,
      objectFormat: "sha1",
      references: [
        {
          ref: "refs/heads/main",
          displayName: "main",
          kind: "local_branch",
          commitObjectId: "a".repeat(40),
          commitSubjectSuggestion: null,
        },
      ],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(inventory))
      .mockResolvedValueOnce(jsonResponse(references))
      .mockResolvedValueOnce(jsonResponse({ invalid: true }, 201));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", {
      cookie: `__Host-kestrel-csrf=${"A".repeat(43)}.${"B".repeat(43)}`,
    });

    await expect(fetchLocalRepositories()).resolves.toEqual(inventory);
    await expect(fetchLocalRepositoryReferences(repository.repositoryId)).resolves.toEqual(
      references,
    );
    await expect(
      retainReviewRevision({
        repositoryId: repository.repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/topic",
        changeIntent: "Review authorization boundaries",
      }),
    ).rejects.toThrow("invalid Review Revision response");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/local-repository-sources");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/local-repository-sources/${repository.repositoryId}/references`,
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/review-revisions");
    const mutation = fetchMock.mock.calls[2]?.[1];
    expect(mutation).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          repositoryId: repository.repositoryId,
          baseRef: "refs/heads/main",
          headRef: "refs/heads/topic",
          changeIntent: "Review authorization boundaries",
        }),
        method: "POST",
      }),
    );
    expect(JSON.stringify(mutation)).not.toContain("path");
  });

  it("sends only opaque Project and proposal IDs for observed PR acquisition", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ invalid: true }, 201));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", {
      cookie: `__Host-kestrel-csrf=${"A".repeat(43)}.${"B".repeat(43)}`,
    });
    const command = {
      projectId: "018f0f89-9a22-7864-aac2-8df71bf60420",
      changeProposalId: "018f0f89-9192-755f-aa96-f72094c734dd",
      changeIntent: "Review the exact observed pull request",
    };

    await expect(retainReviewRevision(command)).rejects.toThrow("invalid Review Revision response");
    const mutation = fetchMock.mock.calls[0]?.[1];
    expect(mutation).toEqual(
      expect.objectContaining({ body: JSON.stringify(command), method: "POST" }),
    );
    expect(JSON.stringify(mutation)).not.toMatch(/objectId|remote|ref|repository|url/iu);
  });

  it("reads and creates the Operator session without exposing a token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(jsonResponse(session));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSession()).resolves.toEqual(session);
    await expect(
      loginOperator({ username: "operator", password: "correct horse battery staple" }),
    ).resolves.toEqual(session);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/session",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/auth/login",
      expect.objectContaining({
        body: JSON.stringify({
          username: "operator",
          password: "correct horse battery staple",
        }),
        credentials: "same-origin",
        method: "POST",
      }),
    );
    expect(session).not.toHaveProperty("token");
  });

  it("parses the authoritative Installation snapshot", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(snapshot));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchInstallation()).resolves.toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/installation",
      expect.objectContaining({ method: "GET" }),
    );

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...snapshot, unexpected: true }));
    await expect(fetchInstallation()).rejects.toThrow();
  });

  it("posts an empty diagnostic command and parses the accepted transition", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(accepted, 202));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", {
      cookie: `__Host-kestrel-csrf=${"A".repeat(43)}.${"B".repeat(43)}`,
    });

    await expect(runDiagnostic()).resolves.toEqual(accepted);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/installation/diagnostics");
    expect(request).toEqual(expect.objectContaining({ body: "{}", method: "POST" }));
    expect(new Headers(request?.headers).get("X-Kestrel-CSRF")).toBe(
      `${"A".repeat(43)}.${"B".repeat(43)}`,
    );
  });

  it("reads the Project inbox and opens a public PR with CSRF protection", async () => {
    const created = { schemaVersion: 1 as const, project: projectInbox.projects[0] };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(projectInbox))
      .mockResolvedValueOnce(jsonResponse(created));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", {
      cookie: `__Host-kestrel-csrf=${"A".repeat(43)}.${"B".repeat(43)}`,
    });

    await expect(fetchProjectInbox()).resolves.toEqual(projectInbox);
    await expect(
      openPublicGitHubPullRequest({
        url: "https://github.com/openai/openai-node/pull/1234",
      }),
    ).resolves.toEqual(created);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/projects",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
    const mutation = fetchMock.mock.calls[1]?.[1];
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/projects");
    expect(mutation).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ url: "https://github.com/openai/openai-node/pull/1234" }),
        credentials: "same-origin",
        method: "POST",
      }),
    );
    expect(new Headers(mutation?.headers).get("X-Kestrel-CSRF")).toBe(
      `${"A".repeat(43)}.${"B".repeat(43)}`,
    );
  });

  it("logs out with CSRF proof and changes credentials through one bound step-up", async () => {
    const csrfToken = `${"A".repeat(43)}.${"B".repeat(43)}`;
    const stepUpProof = {
      schemaVersion: 1 as const,
      expiresAt: "2026-08-24T12:05:00.000Z",
      proof: "C".repeat(43),
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(stepUpProof))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", { cookie: `__Host-kestrel-csrf=${csrfToken}` });

    await expect(logoutOperator()).resolves.toEqual({ auditError: null });
    await expect(
      updateOperatorCredentials({
        currentPassword: "current correct horse battery staple",
        newPassword: "newly selected correct horse battery staple",
        session,
        username: "operator-renamed",
      }),
    ).resolves.toBeUndefined();

    const command = {
      expectedVersion: session.credentialVersion,
      newPassword: "newly selected correct horse battery staple",
      username: "operator-renamed",
    };
    const requestDigest = createHash("sha256")
      .update(JSON.stringify(command), "utf8")
      .digest("hex");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/auth/logout",
      expect.objectContaining({ body: "{}", method: "POST" }),
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Kestrel-CSRF")).toBe(
      csrfToken,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/auth/step-up",
      expect.objectContaining({
        body: JSON.stringify({
          action: "operator_credentials_change",
          password: "current correct horse battery staple",
          requestDigest,
          targetId: session.operator.id,
        }),
        method: "POST",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/v1/operator/credentials",
      expect.objectContaining({ body: JSON.stringify(command), method: "POST" }),
    );
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("X-Kestrel-Step-Up")).toBe(
      stepUpProof.proof,
    );
  });

  it("reports an audit warning after the server has cleared logout cookies", async () => {
    const auditError: ApiError = {
      schemaVersion: 1,
      code: "SERVICE_UNAVAILABLE",
      message: "Operator logout audit is unavailable",
      correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(auditError, 503)));
    vi.stubGlobal("document", {
      cookie: `__Host-kestrel-csrf=${"A".repeat(43)}.${"B".repeat(43)}`,
    });

    await expect(logoutOperator()).resolves.toEqual({ auditError });
  });

  it("refetches an expired cursor and reconnects from the returned snapshot cursor", async () => {
    const expired: ApiError = {
      schemaVersion: 1,
      code: "EVENT_CURSOR_EXPIRED",
      message: "The event cursor is outside retained history",
      correlationId: "51cfb6e7-5310-4e71-a637-3c418cc67b86",
      firstAvailableEventId: "9",
      refetch: "/api/v1/installation",
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(expired, 409))
      .mockResolvedValueOnce(jsonResponse({ ...snapshot, eventCursor: "9" }))
      .mockResolvedValueOnce(eventStreamResponse(succeededEvent));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const onCursorExpired = vi.fn(async () => (await fetchInstallation()).eventCursor);
    const received: InstallationEvent[] = [];

    await streamInstallationEvents({
      after: "1",
      signal: controller.signal,
      onCursorExpired,
      onEvent(event) {
        received.push(event);
        controller.abort();
      },
    });

    expect(onCursorExpired).toHaveBeenCalledWith(expired);
    expect(received).toEqual([succeededEvent]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/events");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Last-Event-ID")).toBe("1");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/installation");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/events");
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("Last-Event-ID")).toBe("9");
  });

  it("increases reconnect backoff when accepted streams close before becoming stable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const controller = new AbortController();
    const attemptTimes: number[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => {
      attemptTimes.push(Date.now());
      if (attemptTimes.length === 4) {
        controller.abort();
      }
      return Promise.resolve(emptyEventStreamResponse());
    });
    vi.stubGlobal("fetch", fetchMock);

    const streaming = streamInstallationEvents({
      after: "0",
      signal: controller.signal,
      onCursorExpired: () => "0",
      onEvent: vi.fn(),
    });
    await vi.runAllTimersAsync();
    await streaming;

    expect(attemptTimes).toEqual([0, 250, 750, 1_750]);
  });
});
