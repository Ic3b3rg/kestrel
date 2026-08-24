import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ApiError,
  DiagnosticAccepted,
  InstallationEvent,
  InstallationSnapshot,
} from "@kestrel/contracts";

import { fetchInstallation, runDiagnostic, streamInstallationEvents } from "./api.js";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PWA API client", () => {
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

    await expect(runDiagnostic()).resolves.toEqual(accepted);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/installation/diagnostics",
      expect.objectContaining({ body: "{}", method: "POST" }),
    );
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
      .mockResolvedValueOnce(eventStreamResponse(succeededEvent));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const onCursorExpired = vi.fn().mockResolvedValue("9");
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
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/events");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Last-Event-ID")).toBe("9");
  });
});
