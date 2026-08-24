import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ApiErrorSchema,
  DiagnosticAcceptedSchema,
  InstallationSnapshotSchema,
} from "@kestrel/contracts";

import { startStack, type RunningStack } from "./support/compose.js";
import { collectInstallationEvents } from "./support/sse.js";

async function readSnapshot(apiUrl: string) {
  const response = await fetch(`${apiUrl}/api/v1/installation`);
  expect(response.status).toBe(200);
  return InstallationSnapshotSchema.parse(await response.json());
}

describe("durable Installation diagnostic", () => {
  let stack: RunningStack | undefined;

  beforeAll(async () => {
    stack = await startStack();
  });

  afterAll(async () => {
    await stack?.close();
  });

  it("rolls back domain state when transactional job enqueue fails", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    const before = await readSnapshot(runningStack.apiUrl);
    const rejectJobSql = `
      CREATE FUNCTION public.kestrel_test_reject_job()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'injected pg-boss enqueue failure';
      END;
      $$;
      CREATE TRIGGER kestrel_test_reject_job
      BEFORE INSERT ON pgboss.job
      FOR EACH ROW
      WHEN (NEW.name = 'installation-diagnostic-v1')
      EXECUTE FUNCTION public.kestrel_test_reject_job();
    `;
    const restoreJobSql = `
      DROP TRIGGER kestrel_test_reject_job ON pgboss.job;
      DROP FUNCTION public.kestrel_test_reject_job();
    `;

    await runningStack.executeSql(rejectJobSql);
    try {
      const failed = await fetch(`${runningStack.apiUrl}/api/v1/installation/diagnostics`, {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(failed.status).toBe(503);
      expect(ApiErrorSchema.parse(await failed.json())).toMatchObject({
        code: "SERVICE_UNAVAILABLE",
      });
      expect(await readSnapshot(runningStack.apiUrl)).toEqual(before);
    } finally {
      await runningStack.executeSql(restoreJobSql);
    }

    const streamedPromise = collectInstallationEvents(runningStack.apiUrl, {
      after: before.eventCursor,
      count: 3,
    });
    const acceptedResponse = await fetch(`${runningStack.apiUrl}/api/v1/installation/diagnostics`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(acceptedResponse.status).toBe(202);
    DiagnosticAcceptedSchema.parse(await acceptedResponse.json());
    await expect
      .poll(async () => (await readSnapshot(runningStack.apiUrl)).diagnostic?.status, {
        interval: 250,
        timeout: 20_000,
      })
      .toBe("succeeded");
    expect((await streamedPromise).map((event) => event.eventId)).toEqual(["2", "3", "4"]);
  }, 60_000);

  it("commits work while the worker is down and completes it after recovery", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    await runningStack.stop("worker");

    const response = await fetch(`${runningStack.apiUrl}/api/v1/installation/diagnostics`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(202);
    const accepted = DiagnosticAcceptedSchema.parse(await response.json());
    expect(accepted.diagnostic.status).toBe("queued");

    expect(await readSnapshot(runningStack.apiUrl)).toMatchObject({
      diagnostic: { id: accepted.diagnostic.id, status: "queued" },
      installation: { state: "diagnostic_queued" },
    });

    const conflictResponse = await fetch(`${runningStack.apiUrl}/api/v1/installation/diagnostics`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(conflictResponse.status).toBe(409);
    expect(ApiErrorSchema.parse(await conflictResponse.json())).toMatchObject({
      code: "INSTALLATION_TRANSITION_CONFLICT",
    });

    const invalidResponse = await fetch(`${runningStack.apiUrl}/api/v1/installation/diagnostics`, {
      body: JSON.stringify({ unexpected: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(invalidResponse.status).toBe(400);
    expect(ApiErrorSchema.parse(await invalidResponse.json())).toMatchObject({
      code: "INVALID_REQUEST",
    });

    await runningStack.start("worker");
    await expect
      .poll(async () => (await readSnapshot(runningStack.apiUrl)).diagnostic?.status, {
        interval: 250,
        timeout: 20_000,
      })
      .toBe("succeeded");

    const completed = await readSnapshot(runningStack.apiUrl);
    await runningStack.restart("web", "worker");
    expect(await readSnapshot(runningStack.apiUrl)).toEqual(completed);
  }, 60_000);
});
