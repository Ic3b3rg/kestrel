import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ApiErrorSchema,
  DiagnosticAcceptedSchema,
  InstallationSnapshotSchema,
} from "@kestrel/contracts";

import { startStack, type RunningStack } from "./support/compose.js";
import { collectInstallationEvents } from "./support/sse.js";

async function runDiagnostic(stack: RunningStack): Promise<void> {
  const response = await stack.fetchApi("/api/v1/installation/diagnostics", {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(response.status).toBe(202);
  const accepted = DiagnosticAcceptedSchema.parse(await response.json());

  await expect
    .poll(
      async () => {
        const snapshotResponse = await stack.fetchApi("/api/v1/installation");
        return InstallationSnapshotSchema.parse(await snapshotResponse.json()).diagnostic?.status;
      },
      { interval: 250, timeout: 15_000 },
    )
    .toBe("succeeded");
  expect(accepted.diagnostic.status).toBe("queued");
}

describe("replayable Installation events", () => {
  let stack: RunningStack | undefined;

  beforeAll(async () => {
    stack = await startStack();
    await stack.authenticateOperator();
  });

  afterAll(async () => {
    await stack?.close();
  });

  it("streams ordered transitions, replays a cursor, and requires refetch after retention", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;

    const streamedPromise = collectInstallationEvents(runningStack.apiUrl, {
      after: "0",
      cookie: runningStack.sessionCookie,
      count: 3,
    }).then(
      (events) => ({ events, ok: true }) as const,
      (error: unknown) => ({ error, ok: false }) as const,
    );
    await runDiagnostic(runningStack);
    const streamedResult = await streamedPromise;
    if (!streamedResult.ok) {
      throw streamedResult.error;
    }
    const streamed = streamedResult.events;
    expect(streamed.map((event) => event.eventId)).toEqual(["1", "2", "3"]);
    expect(streamed.map((event) => event.eventType)).toEqual([
      "installation.diagnostic.queued",
      "installation.diagnostic.running",
      "installation.diagnostic.succeeded",
    ]);
    const firstEvent = streamed[0];
    if (!firstEvent) {
      throw new Error("Expected the queued event");
    }

    const replayed = await collectInstallationEvents(runningStack.apiUrl, {
      after: "0",
      cookie: runningStack.sessionCookie,
      count: 2,
      lastEventId: firstEvent.eventId,
    });
    expect(replayed.map((event) => event.eventId)).toEqual(["2", "3"]);

    const future = await runningStack.fetchApi("/api/v1/events", {
      headers: { Accept: "text/event-stream", "Last-Event-ID": "999" },
    });
    expect(future.status).toBe(400);
    expect(ApiErrorSchema.parse(await future.json())).toMatchObject({ code: "INVALID_REQUEST" });

    await runDiagnostic(runningStack);
    await runDiagnostic(runningStack);
    await runDiagnostic(runningStack);

    const expired = await runningStack.fetchApi("/api/v1/events", {
      headers: { Accept: "text/event-stream", "Last-Event-ID": "1" },
    });
    expect(expired.status).toBe(409);
    expect(ApiErrorSchema.parse(await expired.json())).toMatchObject({
      code: "EVENT_CURSOR_EXPIRED",
      refetch: "/api/v1/installation",
    });

    const refetchedResponse = await runningStack.fetchApi("/api/v1/installation");
    const refetched = InstallationSnapshotSchema.parse(await refetchedResponse.json());
    const resumedPromise = collectInstallationEvents(runningStack.apiUrl, {
      after: refetched.eventCursor,
      cookie: runningStack.sessionCookie,
      count: 3,
    });
    await runDiagnostic(runningStack);
    expect((await resumedPromise).map((event) => event.eventId)).toEqual(["13", "14", "15"]);
  }, 60_000);

  it("keeps Installation queries available while the SSE listener pool is full", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    const snapshotResponse = await runningStack.fetchApi("/api/v1/installation");
    const snapshot = InstallationSnapshotSchema.parse(await snapshotResponse.json());
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const streams: Response[] = [];

    try {
      streams.push(
        ...(await Promise.all(
          controllers.map((controller) =>
            runningStack.fetchApi("/api/v1/events", {
              headers: {
                Accept: "text/event-stream",
                "Last-Event-ID": snapshot.eventCursor,
              },
              signal: controller.signal,
            }),
          ),
        )),
      );
      expect(streams.every((response) => response.status === 200)).toBe(true);

      const controlResponse = await runningStack.fetchApi("/api/v1/installation", {
        signal: AbortSignal.timeout(3_000),
      });
      expect(controlResponse.status).toBe(200);
      InstallationSnapshotSchema.parse(await controlResponse.json());
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.all(
        streams.map(async (response) => response.body?.cancel().catch(() => undefined)),
      );
    }
  }, 30_000);
});
