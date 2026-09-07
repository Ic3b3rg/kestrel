// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FactoryExecution, FactoryExecutionRun } from "@kestrel/contracts";
import { FeatureExecutionPanel } from "./FeatureExecutionPanel.js";
import { ApiClientError } from "./api.js";
import { WorkspaceSuspendedContext } from "./components/ui/workspace-suspension.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const featureId = "018f0f89-9192-755f-aa96-f72094c734df";
const itemId = "018f0f89-949a-75a8-8f61-6df78a843b1f";
const runId = "018f0f89-949a-75a8-8f61-6df78a843b20";
const createdAt = "2026-09-07T12:00:00.000Z";
const head = "a".repeat(40);
const tree = "b".repeat(40);
const command = {
  program: "node",
  args: ["--test", "tests/export report.test.mjs"],
  cwd: "packages/reports",
  timeoutSeconds: 45,
};
const run: FactoryExecutionRun = {
  schemaVersion: 1,
  id: runId,
  featureId,
  approvedVersion: 2,
  workItemId: itemId,
  attempt: 1,
  state: "blocked",
  failure: "verification_failed",
  writerStopped: true,
  createdAt,
  startedAt: createdAt,
  completedAt: createdAt,
  question: "Should archived notes appear in reports?",
  revision: {
    baseCommitId: "c".repeat(40),
    headCommitId: head,
    treeId: tree,
    branch: "feature/reports",
  },
  runtime: {
    kind: "codex",
    model: "gpt-5.4",
    threadId: "thread-1",
    turnId: "turn-1",
    containerId: null,
  },
  acceptedCommands: [command],
  activity: [
    {
      id: itemId,
      kind: "verification",
      summary: "Report export failed its declared check.",
      createdAt,
    },
  ],
  verification: [
    {
      id: projectId,
      round: 1,
      position: 1,
      command,
      headCommitId: head,
      treeId: tree,
      outcome: "failed",
      exitCode: 1,
      stdout: "<script>untrusted()</script>\u001b[31mExpected two notes\u001b[0m",
      stderr: "Assertion failed",
      stdoutTruncated: true,
      stderrTruncated: false,
      durationMs: 123,
      createdAt,
    },
  ],
};
const execution: FactoryExecution = {
  schemaVersion: 1,
  featureId,
  state: "blocked",
  failure: "verification_failed",
  question: run.question,
  revision: run.revision,
  workItems: [
    {
      id: itemId,
      key: "REPORTS-1",
      runs: [
        {
          id: runId,
          workItemId: itemId,
          attempt: 1,
          state: run.state,
          failure: run.failure,
          writerStopped: true,
          createdAt,
          startedAt: createdAt,
          completedAt: createdAt,
        },
      ],
    },
  ],
};
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(props: Partial<Parameters<typeof FeatureExecutionPanel>[0]> = {}) {
  await act(async () => {
    root.render(createElement(FeatureExecutionPanel, { projectId, featureId, ...props }));
    await Promise.resolve();
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((value) =>
    value.textContent.includes(label),
  );
  if (button === undefined) throw new Error(`Button unavailable: ${label}`);
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

it("loads an attempt only when selected and shows its exact checks as inert text", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>((url) =>
    Promise.resolve(Response.json(requestUrl(url).endsWith(`/runs/${runId}`) ? run : execution)),
  );
  vi.stubGlobal("fetch", fetch);
  await render();
  expect(container.textContent).toContain("Execution needs attention");
  expect(container.textContent).toContain("Should archived notes appear in reports?");
  expect(fetch).toHaveBeenCalledTimes(1);
  await click("Attempt 1");
  expect(container.textContent).toContain("Approved plan · version 2");
  expect(container.textContent).toContain('["node","--test","tests/export report.test.mjs"]');
  expect(container.textContent).toContain("packages/reports");
  expect(container.textContent).toContain("45 seconds");
  expect(container.textContent).toContain("Exit code 1");
  expect(container.textContent).toContain("Output truncated");
  expect(container.textContent).toContain(head);
  expect(container.textContent).toContain(tree);
  expect(container.textContent).toContain("Report export failed its declared check.");
  expect(container.textContent).toContain("<script>untrusted()</script>");
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).not.toContain("\u001b");
  expect(
    fetch.mock.calls.filter(([url]) => requestUrl(url).endsWith(`/runs/${runId}`)),
  ).toHaveLength(1);
});

it("waits for a slow execution read before polling again and stops after verification", async () => {
  vi.useFakeTimers();
  let finishRead!: (response: Response) => void;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({ ...execution, state: "running", failure: null, question: null }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
  vi.stubGlobal("fetch", fetch);
  await render();
  expect(container.textContent).toContain("Implementing the approved plan");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => {
    finishRead(Response.json({ ...execution, state: "verified", failure: null, question: null }));
    await Promise.resolve();
  });
  expect(container.textContent).toContain("Implementation verified");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("keeps an unconfirmed cancellation visibly reserved without offering a replay", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        ...execution,
        state: "cancelled",
        failure: "cancelled",
        question: null,
        workItems: [
          {
            id: itemId,
            key: "REPORTS-1",
            runs: [
              {
                ...execution.workItems[0]?.runs[0],
                state: "cancelled",
                failure: "cancelled",
                writerStopped: false,
              },
            ],
          },
        ],
      }),
    ),
  );
  await render();
  expect(container.textContent).toContain("Cancellation requested");
  expect(container.textContent).toContain("Kestrel keeps this Project reserved");
  expect(container.textContent).not.toContain("Execution cancelled");
  expect(
    [...container.querySelectorAll("button")].some((button) =>
      /retry|resume|run again/i.test(button.textContent),
    ),
  ).toBe(false);
});

it("cancels a pending attempt read on a Feature switch and ignores its late response", async () => {
  const nextFeature = "018f0f89-949a-75a8-8f61-6df78a843b21";
  let finishRead!: (response: Response) => void;
  let attemptSignal: AbortSignal | null | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (url, options) => {
      if (requestUrl(url).endsWith(`/runs/${runId}`)) {
        attemptSignal = options?.signal;
        return new Promise((resolve) => {
          finishRead = resolve;
        });
      }
      return Response.json(
        requestUrl(url).includes(nextFeature)
          ? {
              ...execution,
              featureId: nextFeature,
              state: "pending",
              failure: null,
              question: null,
              revision: null,
              workItems: [],
            }
          : execution,
      );
    }),
  );
  await render();
  await click("Attempt 1");
  expect(container.textContent).toContain("Loading attempt details");
  await render({ featureId: nextFeature });
  expect(attemptSignal?.aborted).toBe(true);
  await act(async () => {
    finishRead(Response.json(run));
    await Promise.resolve();
  });
  expect(container.textContent).toContain("Waiting to start execution");
  expect(container.textContent).not.toContain("REPORTS-1");
  expect(container.textContent).not.toContain("Accepted verification commands");
  expect(container.textContent).not.toContain("Should archived notes");
});

it("retains a selected attempt while offline and restores polling on reconnect", async () => {
  let disconnected = false;
  const fetch = vi.fn<typeof globalThis.fetch>((url) => {
    if (disconnected) return Promise.reject(new TypeError("Network disconnected"));
    return Promise.resolve(
      Response.json(requestUrl(url).endsWith(`/runs/${runId}`) ? run : execution),
    );
  });
  vi.stubGlobal("fetch", fetch);
  await render();
  await click("Attempt 1");
  disconnected = true;
  await click("Refresh execution");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "could not be refreshed",
  );
  expect(container.textContent).toContain("Accepted verification commands");
  await render({ online: false });
  expect(container.textContent).toContain("Reconnect to refresh execution");
  expect(container.textContent).toContain("Accepted verification commands");
  disconnected = false;
  await render({ online: true });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('button[aria-expanded="true"]')?.textContent).toContain(
    "Attempt 1",
  );
});

it("asks to reconnect instead of pretending to load an uncached attempt offline", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(execution));
  vi.stubGlobal("fetch", fetch);
  await render();
  await render({ online: false });
  await click("Attempt 1");
  expect(container.querySelector('[aria-label="Attempt 1 details"]')?.textContent).toContain(
    "Reconnect to load attempt details",
  );
  expect(container.textContent).not.toContain("Loading attempt details");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("delegates an expired session to the authentication boundary and stops polling", async () => {
  vi.useFakeTimers();
  const onAuthenticationError = vi.fn(() => true);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({ ...execution, state: "running", failure: null, question: null }),
    )
    .mockResolvedValueOnce(
      Response.json(
        {
          schemaVersion: 1,
          code: "AUTHENTICATION_REQUIRED",
          message: "Sign in to continue",
          correlationId: projectId,
        },
        { status: 401 },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  await render({ onAuthenticationError });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(onAuthenticationError).toHaveBeenCalledWith(expect.any(ApiClientError));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("suspends reads during session verification and retains the selected attempt", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>((url) =>
    Promise.resolve(Response.json(requestUrl(url).endsWith(`/runs/${runId}`) ? run : execution)),
  );
  vi.stubGlobal("fetch", fetch);
  const renderWorkspace = async (suspended: boolean) => {
    await act(async () => {
      root.render(
        createElement(
          WorkspaceSuspendedContext.Provider,
          { value: suspended },
          createElement(FeatureExecutionPanel, { projectId, featureId }),
        ),
      );
      await Promise.resolve();
    });
  };
  await renderWorkspace(false);
  await click("Attempt 1");
  const callsBeforeSuspension = fetch.mock.calls.length;
  await renderWorkspace(true);
  expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  expect(container.textContent).toContain("Accepted verification commands");
  expect(fetch).toHaveBeenCalledTimes(callsBeforeSuspension);
  await renderWorkspace(false);
  expect(container.querySelector('button[aria-expanded="true"]')?.textContent).toContain(
    "Attempt 1",
  );
  expect(fetch).toHaveBeenCalledTimes(callsBeforeSuspension + 1);
});

it("rejects attempt evidence belonging to another Work Item", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>((url) =>
      Promise.resolve(
        Response.json(
          requestUrl(url).endsWith(`/runs/${runId}`)
            ? { ...run, workItemId: projectId }
            : execution,
        ),
      ),
    ),
  );
  await render();
  await click("Attempt 1");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "could not be refreshed",
  );
  expect(container.textContent).not.toContain("Accepted verification commands");
  expect(container.textContent).not.toContain("Report export failed its declared check.");
});
