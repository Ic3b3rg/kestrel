// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectBoardSnapshot } from "@kestrel/contracts";
import {
  ProjectFactoryWorkspace,
  type ProjectFactoryWorkspaceProps,
} from "./ProjectFactoryWorkspace.js";
import type * as apiModule from "./api.js";
const api = vi.hoisted(() => ({ board: vi.fn<typeof apiModule.fetchProjectBoard>() }));
vi.mock("./api.js", async (original) => ({
  ...(await original<typeof apiModule>()),
  fetchProjectBoard: api.board,
}));
const projectId = "01991c36-7f90-7000-8000-000000000001";
const otherId = "01991c36-7f90-7000-8000-000000000009";
const at = "2026-09-23T12:00:00.000Z";
const snapshot: ProjectBoardSnapshot = {
  schemaVersion: 1,
  projectId,
  readAt: at,
  planningFeatures: [
    {
      schemaVersion: 1,
      id: "01991c36-7f90-7000-8000-000000000002",
      projectId,
      state: "planning",
      title: "Saved report search",
      createdAt: at,
      updatedAt: at,
    },
  ],
  workItems: [],
  github: {
    checkedAt: at,
    fetchedAt: at,
    failure: null,
    limited: false,
    retained: false,
    issues: [
      {
        repository: { id: "901", owner: "example", name: "reports" },
        id: "42",
        number: 42,
        url: "https://github.com/example/reports/issues/42",
        title: "Export saved reports",
        state: "open",
      },
    ],
  },
};
let root: Root;
let container: HTMLDivElement;
const navigate = vi.fn<ProjectFactoryWorkspaceProps["onNavigate"]>();
const authError = vi.fn(() => false);
const render = async (props: Partial<ProjectFactoryWorkspaceProps> = {}) => {
  await act(async () => {
    await Promise.resolve();
    root.render(
      createElement(ProjectFactoryWorkspace, {
        projectId,
        projectName: "Reports",
        online: true,
        onNavigate: navigate,
        onAuthenticationError: authError,
        ...props,
      }),
    );
  });
};
const refresh = async () =>
  act(async () => {
    await Promise.resolve();
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh board"]')?.click();
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  api.board.mockReset().mockResolvedValue(snapshot);
  navigate.mockReset();
  authError.mockReset().mockReturnValue(false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("uses one snapshot read for local and provider cards with direct Project actions", async () => {
  await render();
  expect(api.board).toHaveBeenCalledOnce();
  expect(api.board.mock.calls[0]?.[0]).toBe(projectId);
  expect(container.textContent).toContain("Saved report search");
  expect(container.textContent).toContain("Export saved reports");
  expect(container.querySelector('a[target="_blank"]')?.getAttribute("href")).toBe(
    snapshot.github.issues[0]?.url,
  );
  await act(async () => {
    await Promise.resolve();
    container.querySelector<HTMLButtonElement>('[aria-label="New plan"]')?.click();
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Pull requests"))
      ?.click();
    container
      .querySelector<HTMLAnchorElement>(`a[href="/projects/${projectId}/settings"]`)
      ?.click();
    container
      .querySelector<HTMLButtonElement>('[aria-label="Open planning chat: Saved report search"]')
      ?.click();
  });
  expect(navigate.mock.calls.map(([route]) => route)).toMatchObject([
    { kind: "planning", projectId },
    { kind: "project", projectId, view: "pull_requests" },
    { kind: "project_settings", projectId },
    { kind: "feature", projectId, featureId: snapshot.planningFeatures[0]?.id },
  ]);
});

it("keeps local cards usable and reports provider failure, retained data and truncation", async () => {
  api.board.mockResolvedValue({
    ...snapshot,
    github: { ...snapshot.github, failure: "rate_limited", retained: true, limited: true },
  });
  await render();
  expect(container.textContent).toContain("Saved report search");
  expect(container.textContent).toContain("Export saved reports");
  expect(container.textContent).toContain("GitHub has limited requests");
  expect(container.textContent).toContain("Showing the last available GitHub issues");
  expect(container.textContent).toContain("More open GitHub issues may exist");
});

it("retains the last snapshot while refreshing and after a failed read", async () => {
  await render();
  const pending = Promise.withResolvers<ProjectBoardSnapshot>();
  api.board.mockReturnValueOnce(pending.promise);
  await refresh();
  expect(container.textContent).toContain("Saved report search");
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  await act(async () => {
    await Promise.resolve(pending.reject(new Error("offline")));
  });
  expect(container.textContent).toContain("Its last read remains visible");
  expect(container.textContent).toContain("Export saved reports");
});

it("refreshes GitHub only on the first read requested by Refresh, then resumes ordinary polling", async () => {
  await render();
  await refresh();
  expect(api.board.mock.calls[1]?.[2]).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(api.board.mock.calls[2]?.[2]).toBe(false);
});

it("retains same-Project data offline, cancels work and stops polling", async () => {
  await render();
  const signal = api.board.mock.calls[0]?.[1];
  await render({ online: false });
  expect(signal?.aborted).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(6_000));
  expect(api.board).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Saved report search");
  expect(container.textContent).toContain("Reconnect to refresh");
});

it("rejects a late response after changing Project and never shows retained cards from the old scope", async () => {
  const pending = Promise.withResolvers<ProjectBoardSnapshot>();
  api.board.mockReturnValueOnce(pending.promise).mockResolvedValue({
    ...snapshot,
    projectId: otherId,
    planningFeatures: [],
    github: { ...snapshot.github, issues: [] },
  });
  await render();
  const signal = api.board.mock.calls[0]?.[1];
  await render({ projectId: otherId, projectName: "Other" });
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    await Promise.resolve(pending.resolve(snapshot));
  });
  expect(container.textContent).not.toContain("Saved report search");
  expect(container.textContent).not.toContain("Export saved reports");
});

it("waits for a read before polling again and stops on navigation", async () => {
  const pending = Promise.withResolvers<ProjectBoardSnapshot>();
  api.board.mockReturnValueOnce(pending.promise);
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(6_000));
  expect(api.board).toHaveBeenCalledOnce();
  await act(async () => {
    await Promise.resolve(pending.resolve(snapshot));
  });
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(api.board).toHaveBeenCalledTimes(2);
  await act(async () => {
    await Promise.resolve(root.render(null));
  });
  expect(api.board.mock.calls[1]?.[1]?.aborted).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(6_000));
  expect(api.board).toHaveBeenCalledTimes(2);
});

it("routes authentication failure to the session boundary", async () => {
  const error = new Error("session expired");
  api.board.mockRejectedValue(error);
  authError.mockReturnValue(true);
  await render();
  expect(authError).toHaveBeenCalledWith(error);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
