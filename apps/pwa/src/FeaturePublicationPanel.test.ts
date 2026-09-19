// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FactoryFeaturePublication } from "@kestrel/contracts";
import { FeaturePublicationPanel } from "./FeaturePublicationPanel.js";
import { WorkspaceSuspendedContext } from "./components/ui/workspace-suspension.js";

const projectId = "01991c36-7f90-7000-8000-000000000001";
const featureId = "01991c36-7f90-7000-8000-000000000002";
const at = "2026-09-08T12:00:00.000Z";
const revision = {
  baseCommitId: "a".repeat(40),
  headCommitId: "b".repeat(40),
  treeId: "c".repeat(40),
  branch: `refs/heads/kestrel/feature/${featureId}`,
};
const pending: FactoryFeaturePublication = {
  schemaVersion: 1,
  featureId,
  approvedVersion: 1,
  state: "pending",
  cancelled: false,
  failure: null,
  canRetry: false,
  updatedAt: null,
  certificate: null,
  issues: [],
  pullRequest: null,
  review: null,
};
const repository = { id: "42", owner: "example", name: "reports" };
const certified: FactoryFeaturePublication = {
  ...pending,
  state: "published",
  updatedAt: at,
  certificate: {
    id: projectId,
    featureId,
    approvedVersion: 1,
    runId: projectId,
    source: { repositoryId: projectId, identity: "d".repeat(64) },
    revision,
    manifest: [
      {
        position: 1,
        command: { program: "node", args: ["--test"], cwd: ".", timeoutSeconds: 10 },
        origins: [{ workItemKey: "W1", position: 1 }],
      },
    ],
    manifestDigest: "e".repeat(64),
    evidenceIds: [projectId],
    createdAt: at,
  },
  issues: [
    {
      workItemId: projectId,
      key: "W1",
      title: "Export CSV",
      issue: {
        repository,
        id: "10",
        number: 10,
        url: "https://github.com/example/reports/issues/10",
      },
    },
  ],
  pullRequest: {
    repository,
    id: "99",
    number: 7,
    nodeId: "PR_example",
    repositoryNodeId: "R_example",
    authorNodeId: "U_example",
    author: "operator",
    url: "https://github.com/example/reports/pull/7",
    state: "open",
    title: "Export reports",
    body: "Approved Feature\n<!-- exact -->",
    marker: "<!-- exact -->",
    baseRef: "master",
    headRef: `kestrel/feature/${featureId}`,
    baseCommitId: revision.baseCommitId,
    headCommitId: revision.headCommitId,
  },
  review: {
    projectId,
    changeProposalId: featureId,
    manifestDigest: "f".repeat(64),
    revision: {
      id: projectId,
      state: "available",
      objectFormat: "sha1",
      base: { objectId: revision.baseCommitId, ref: "master" },
      head: { objectId: revision.headCommitId, ref: `kestrel/feature/${featureId}` },
      objectCount: 4,
      retainedBytes: 100,
      failureReason: null,
      createdAt: at,
      availableAt: at,
    },
  },
};
const uncertain: FactoryFeaturePublication = {
  ...certified,
  state: "uncertain",
  failure: "uncertain_write",
  canRetry: true,
  pullRequest: null,
  review: null,
};
async function renderAct(action: () => unknown): Promise<void> {
  await act(async () => {
    await Promise.resolve(action());
  });
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    `__Host-kestrel-csrf=${"a".repeat(43)}.${"b".repeat(43)}`,
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await renderAct(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const props = () => ({
  projectId,
  featureId,
  online: true,
  onOpenRevision: vi.fn(),
  onAuthenticationError: vi.fn(() => false),
});
const button = (text: string) => {
  const found = [...container.querySelectorAll("button")].find((node) =>
    node.textContent.includes(text),
  );
  if (found === undefined) throw new Error(`No button: ${text}`);
  return found;
};

it("shows publication waiting for the certificate without inventing a PR or a retry", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(response(pending))),
  );
  await renderAct(() => root.render(createElement(FeaturePublicationPanel, props())));
  expect(container.textContent).toContain("Waiting for final verification");
  expect(container.querySelector('a[href*="/pull/"]')).toBeNull();
  expect(container.textContent).not.toContain("Retry publication");
});

it("opens the exact retained revision and preserves ordered Work Item links", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(response(certified))),
  );
  const selected = props();
  await renderAct(() => root.render(createElement(FeaturePublicationPanel, selected)));
  expect(container.textContent).toContain("Pull request published");
  expect(
    container.querySelector('a[href="https://github.com/example/reports/pull/7"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('a[href="https://github.com/example/reports/issues/10"]')?.textContent,
  ).toContain("W1");
  expect(container.textContent).toContain(revision.headCommitId);
  expect(container.textContent).toContain("e".repeat(64));
  await renderAct(() => button("Open Feature review").click());
  expect(selected.onOpenRevision).toHaveBeenCalledWith(certified.review);
});

it("retries an uncertain command with the same request identity after a lost HTTP response", async () => {
  let posts = 0;
  const fetcher = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts += 1;
      return posts === 1
        ? Promise.reject(new TypeError("Response lost"))
        : Promise.resolve(response({ ...uncertain, state: "pending", canRetry: false }));
    }
    return Promise.resolve(response(uncertain));
  });
  vi.stubGlobal("fetch", fetcher);
  await renderAct(() => root.render(createElement(FeaturePublicationPanel, props())));
  expect(container.textContent).toContain("Publication outcome is uncertain");
  await renderAct(() => button("Retry publication").click());
  expect(container.textContent).toContain("could not be confirmed");
  await renderAct(() => button("Retry publication").click());
  const mutations = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(mutations).toHaveLength(2);
  expect(mutations[0]?.[1]?.body).toEqual(mutations[1]?.[1]?.body);
  expect(new Headers(mutations[0]?.[1]?.headers).get("X-Kestrel-CSRF")).toBe(
    `${"a".repeat(43)}.${"b".repeat(43)}`,
  );
});

it("does not start requests while the workspace is suspended", async () => {
  const fetcher = vi.fn(() => Promise.resolve(response(uncertain)));
  vi.stubGlobal("fetch", fetcher);
  await renderAct(() =>
    root.render(
      createElement(
        WorkspaceSuspendedContext.Provider,
        { value: true },
        createElement(FeaturePublicationPanel, props()),
      ),
    ),
  );
  expect(fetcher).not.toHaveBeenCalled();
});

it("retains the last confirmed state and disables retry when the browser goes offline", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(response(uncertain))),
  );
  await renderAct(() => root.render(createElement(FeaturePublicationPanel, props())));
  await renderAct(() => window.dispatchEvent(new Event("offline")));
  expect(container.textContent).toContain("Publication outcome is uncertain");
  expect(button("Retry publication").disabled).toBe(true);
});

it("explains retry exhaustion without offering an impossible retry", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        response({ ...uncertain, state: "blocked", failure: "retry_limit", canRetry: false }),
      ),
    ),
  );
  await renderAct(() => root.render(createElement(FeaturePublicationPanel, props())));
  expect(container.textContent).toContain("reached its retry limit");
  expect(container.textContent).not.toContain("Retry publication");
});

it("does not let a late response replace another Feature's publication state", async () => {
  let settle: ((result: Response) => void) | undefined;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    )
    .mockImplementation(() => Promise.resolve(response({ ...pending, featureId: projectId })));
  vi.stubGlobal("fetch", fetcher);
  await renderAct(() => root.render(createElement(FeaturePublicationPanel, props())));
  await renderAct(() =>
    root.render(createElement(FeaturePublicationPanel, { ...props(), featureId: projectId })),
  );
  await renderAct(() => {
    settle?.(response(certified));
  });
  expect(container.textContent).toContain("Waiting for final verification");
  expect(container.textContent).not.toContain("Pull request published");
});

it("rejects publication data for a different Feature", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(response({ ...pending, featureId: projectId }))),
  );
  await renderAct(() => root.render(createElement(FeaturePublicationPanel, props())));
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Waiting for final verification");
});

it("polls a pending publication through to its confirmed PR and revision", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(response(pending)))
      .mockImplementation(() => Promise.resolve(response(certified))),
  );
  await renderAct(() => root.render(createElement(FeaturePublicationPanel, props())));
  await renderAct(() => vi.advanceTimersByTimeAsync(2_000));
  expect(container.textContent).toContain("Pull request published");
  expect(button("Open Feature review").disabled).toBe(false);
});

it("does not let an older status poll overwrite a confirmed retry", async () => {
  vi.useFakeTimers();
  let reads = 0;
  let settle: ((result: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(response(certified));
      reads += 1;
      if (reads === 2)
        return new Promise<Response>((resolve) => {
          settle = resolve;
        });
      return Promise.resolve(response(reads === 1 ? uncertain : certified));
    }),
  );
  await renderAct(() => root.render(createElement(FeaturePublicationPanel, props())));
  await renderAct(() => vi.advanceTimersByTimeAsync(2_000));
  await renderAct(() => button("Retry publication").click());
  await renderAct(() => {
    settle?.(response(uncertain));
  });
  expect(container.textContent).toContain("Pull request published");
  expect(container.textContent).not.toContain("Publication outcome is uncertain");
});

it("ignores a retry response after navigation to another Feature", async () => {
  let settle: ((result: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return new Promise<Response>((resolve) => {
          settle = resolve;
        });
      return Promise.resolve(
        response(
          url.includes(`/features/${featureId}/`)
            ? uncertain
            : { ...pending, featureId: projectId },
        ),
      );
    }),
  );
  await renderAct(() => root.render(createElement(FeaturePublicationPanel, props())));
  await renderAct(() => button("Retry publication").click());
  await renderAct(() =>
    root.render(createElement(FeaturePublicationPanel, { ...props(), featureId: projectId })),
  );
  await renderAct(() => {
    settle?.(response(certified));
  });
  expect(container.textContent).toContain("Waiting for final verification");
  expect(container.textContent).not.toContain("Pull request published");
});
