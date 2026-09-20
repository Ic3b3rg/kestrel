// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { FactoryGitHubIssues, Feature } from "@kestrel/contracts";
import { ProjectFactoryWorkspace } from "./ProjectFactoryWorkspace.js";
import type { AppRoute } from "./app-route.js";
import type * as apiModule from "./api.js";

const api = vi.hoisted(() => ({ features: vi.fn(), board: vi.fn(), issues: vi.fn() }));
vi.mock("./api.js", async (original) => ({
  ...(await original<typeof apiModule>()),
  fetchFeatures: api.features,
  fetchFactoryBoard: api.board,
  fetchFactoryGitHubIssues: api.issues,
}));
const projectId = "01991c36-7f90-7000-8000-000000000001";
const feature: Feature = {
  schemaVersion: 1,
  id: "01991c36-7f90-7000-8000-000000000002",
  projectId,
  state: "planning",
  title: "Saved report search",
  createdAt: "2026-09-08T12:00:00.000Z",
  updatedAt: "2026-09-08T12:00:00.000Z",
};
const githubIssues: FactoryGitHubIssues = {
  schemaVersion: 1,
  projectId,
  repository: { id: "901", owner: "example", name: "reports" },
  state: "available",
  failure: null,
  issues: [
    {
      repository: { id: "901", owner: "example", name: "reports" },
      id: "42",
      number: 42,
      url: "https://github.com/example/reports/issues/42",
      title: "Export saved reports",
      body: "Let operators export a saved report.",
      state: "open",
      dependencies: [],
    },
  ],
  page: 1,
  nextPage: null,
  limited: false,
};

it("loads open GitHub issues with the Project and shows them in To do", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.features.mockReset().mockResolvedValue({ schemaVersion: 1, features: [] });
  api.board.mockReset();
  api.issues.mockReset().mockResolvedValue(githubIssues);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      await Promise.resolve(
        root.render(
          createElement(ProjectFactoryWorkspace, {
            projectId,
            projectName: "Reports",
            online: true,
            onNavigate: vi.fn(),
            onAuthenticationError: () => false,
          }),
        ),
      );
    });
    const todo = container.querySelector('[aria-label="To do"]');
    expect(todo?.textContent).toContain("Export saved reports");
    expect(todo?.textContent).toContain("GitHub issue #42");
    expect(todo?.querySelector("a")?.href).toBe("https://github.com/example/reports/issues/42");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps the Project board usable when the GitHub issue request fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.features.mockReset().mockResolvedValue({ schemaVersion: 1, features: [feature] });
  api.board.mockReset();
  api.issues.mockReset().mockRejectedValue(new Error("provider unavailable"));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      await Promise.resolve(
        root.render(
          createElement(ProjectFactoryWorkspace, {
            projectId,
            projectName: "Reports",
            online: true,
            onNavigate: vi.fn(),
            onAuthenticationError: () => false,
          }),
        ),
      );
    });
    expect(container.textContent).toContain(feature.title);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "GitHub issues could not be read. Refresh the board to retry.",
    );
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows GitHub issue loading without hiding retained Project work", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const pendingIssues = Promise.withResolvers<FactoryGitHubIssues>();
  api.features.mockReset().mockResolvedValue({ schemaVersion: 1, features: [feature] });
  api.board.mockReset();
  api.issues.mockReset().mockReturnValue(pendingIssues.promise);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      await Promise.resolve(
        root.render(
          createElement(ProjectFactoryWorkspace, {
            projectId,
            projectName: "Reports",
            online: true,
            onNavigate: vi.fn(),
            onAuthenticationError: () => false,
          }),
        ),
      );
    });
    expect(container.textContent).toContain(feature.title);
    expect(container.textContent).toContain("Reading GitHub issues…");
    await act(async () => {
      pendingIssues.resolve(githubIssues);
      await pendingIssues.promise;
    });
    expect(container.textContent).not.toContain("Reading GitHub issues…");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("retries the GitHub issue catalog when the Operator refreshes the board", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.features.mockReset().mockResolvedValue({ schemaVersion: 1, features: [] });
  api.board.mockReset();
  api.issues
    .mockReset()
    .mockRejectedValueOnce(new Error("provider unavailable"))
    .mockResolvedValueOnce(githubIssues);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      await Promise.resolve(
        root.render(
          createElement(ProjectFactoryWorkspace, {
            projectId,
            projectName: "Reports",
            online: true,
            onNavigate: vi.fn(),
            onAuthenticationError: () => false,
          }),
        ),
      );
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh board"]')?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Export saved reports");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("opens a Project board with direct start, pull-request and settings actions without fetching planned Work Items", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.features.mockReset().mockResolvedValue({ schemaVersion: 1, features: [feature] });
  api.board.mockReset();
  api.issues.mockReset().mockResolvedValue(githubIssues);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const navigate = vi.fn<(route: AppRoute) => void>();
  try {
    await act(async () => {
      await Promise.resolve(
        root.render(
          createElement(ProjectFactoryWorkspace, {
            projectId,
            projectName: "Reports",
            online: true,
            onNavigate: navigate,
            onAuthenticationError: () => false,
          }),
        ),
      );
    });
    expect(container.textContent).toContain(feature.title);
    expect(api.board).not.toHaveBeenCalled();
    for (const name of ["New", "Pull requests", "Settings"]) {
      await act(async () => {
        await Promise.resolve(
          [...container.querySelectorAll("button")]
            .find((button) => button.textContent.trim() === name)
            ?.click(),
        );
      });
    }
    expect(navigate.mock.calls.map(([route]) => route)).toMatchObject([
      { kind: "planning", projectId },
      { kind: "project", projectId, view: "pull_requests" },
      { kind: "settings", projectId },
    ]);
    const route = navigate.mock.calls[0]?.[0];
    if (route?.kind !== "planning") throw new Error("Missing planning route");
    expect(route.requestId).toMatch(/^[a-f0-9-]{36}$/u);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("polls only after the preceding authoritative read completes and stops after navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const pending = Promise.withResolvers<{ schemaVersion: number; features: Feature[] }>();
  api.features
    .mockReset()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ schemaVersion: 1, features: [feature] });
  api.issues.mockReset().mockResolvedValue(githubIssues);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      await Promise.resolve(
        root.render(
          createElement(ProjectFactoryWorkspace, {
            projectId,
            projectName: "Reports",
            online: true,
            onNavigate: vi.fn(),
            onAuthenticationError: () => false,
          }),
        ),
      );
    });
    await act(async () => {
      await Promise.resolve(vi.advanceTimersByTimeAsync(6000));
    });
    expect(api.features).toHaveBeenCalledOnce();
    await act(async () => {
      await Promise.resolve(pending.resolve({ schemaVersion: 1, features: [feature] }));
    });
    await act(async () => {
      await Promise.resolve(vi.advanceTimersByTimeAsync(2000));
    });
    expect(api.features).toHaveBeenCalledTimes(2);
    await act(async () => {
      await Promise.resolve(root.render(null));
    });
    await act(async () => {
      await Promise.resolve(vi.advanceTimersByTimeAsync(6000));
    });
    expect(api.features).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
