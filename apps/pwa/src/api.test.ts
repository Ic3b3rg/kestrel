import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import type {
  ApiError,
  DiagnosticAccepted,
  InstallationEvent,
  InstallationSnapshot,
  ProjectInbox,
  Session,
} from "@kestrel/contracts";

import {
  fetchInstallation,
  fetchProjectInbox,
  fetchSession,
  loginOperator,
  logoutOperator,
  openPublicGitHubPullRequest,
  runDiagnostic,
  streamInstallationEvents,
  updateOperatorCredentials,
} from "./api.js";

const installationId = "018f0f89-8f75-7cc4-9860-3fda5f75d697";
const diagnosticId = "018f0f89-9192-755f-aa96-f72094c734dd";

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
          head: { objectId: "b".repeat(40), ref: "repository-access" },
          id: "018f0f89-9192-755f-aa96-f72094c734dd",
          number: 1234,
          observedAt: "2026-08-24T12:01:00.000Z",
          proposalState: "open",
          providerId: "PR_kwDOGx",
          title: "Keep repository access explicit",
        },
      ],
      createdAt: "2026-08-24T12:00:00.000Z",
      id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
      modelAccess: "not_configured",
      providerContext: "public_pull_request",
      repository: {
        canonicalUrl: "https://github.com/openai/openai-node",
        name: "openai-node",
        owner: "openai",
        providerId: "R_kgDOGx",
      },
      repositoryAccess: {
        authentication: "none",
        kind: "public_github",
        synchronization: "manual",
      },
      sourceAvailability: "available",
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
