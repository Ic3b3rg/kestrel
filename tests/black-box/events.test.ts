import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ApiErrorSchema,
  DiagnosticAcceptedSchema,
  InstallationSnapshotSchema,
} from "@kestrel/contracts";

import { startStack, type RunningStack } from "./support/compose.js";
import { collectInstallationEvents } from "./support/sse.js";

async function runDiagnostic(apiUrl: string): Promise<void> {
  const response = await fetch(`${apiUrl}/api/v1/installation/diagnostics`, {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(response.status).toBe(202);
  const accepted = DiagnosticAcceptedSchema.parse(await response.json());

  await expect
    .poll(
      async () => {
        const snapshotResponse = await fetch(`${apiUrl}/api/v1/installation`);
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
  });

  afterAll(async () => {
    await stack?.close();
  });

  it("streams ordered transitions, replays a cursor, and requires refetch after retention", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;

    const streamedPromise = collectInstallationEvents(runningStack.apiUrl, {
      after: "0",
      count: 3,
    }).then(
      (events) => ({ events, ok: true }) as const,
      (error: unknown) => ({ error, ok: false }) as const,
    );
    await runDiagnostic(runningStack.apiUrl);
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
      count: 2,
      lastEventId: firstEvent.eventId,
    });
    expect(replayed.map((event) => event.eventId)).toEqual(["2", "3"]);

    const future = await fetch(`${runningStack.apiUrl}/api/v1/events`, {
      headers: { Accept: "text/event-stream", "Last-Event-ID": "999" },
    });
    expect(future.status).toBe(400);
    expect(ApiErrorSchema.parse(await future.json())).toMatchObject({ code: "INVALID_REQUEST" });

    await runDiagnostic(runningStack.apiUrl);
    await runDiagnostic(runningStack.apiUrl);
    await runDiagnostic(runningStack.apiUrl);

    const expired = await fetch(`${runningStack.apiUrl}/api/v1/events`, {
      headers: { Accept: "text/event-stream", "Last-Event-ID": "1" },
    });
    expect(expired.status).toBe(409);
    expect(ApiErrorSchema.parse(await expired.json())).toMatchObject({
      code: "EVENT_CURSOR_EXPIRED",
      refetch: "/api/v1/installation",
    });
  }, 60_000);
});
