// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { FactoryBoard, FactoryIssuePublication } from "@kestrel/contracts";
import { FeatureBoardPanel } from "./FeatureBoardPanel.js";

// Execution's own request/polling behavior is covered by FeatureExecutionPanel.test.ts.
vi.mock("./FeatureExecutionPanel.js", () => ({ FeatureExecutionPanel: () => null }));

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const featureId = "018f0f89-9192-755f-aa96-f72094c734df";
const firstId = "018f0f89-949a-75a8-8f61-6df78a843b1f";
const secondId = "018f0f89-949a-75a8-8f61-6df78a843b20";
const createdAt = "2026-09-07T12:00:00.000Z";
const board: FactoryBoard = {
  schemaVersion: 1,
  feature: {
    schemaVersion: 1,
    id: featureId,
    projectId,
    title: "Reports",
    state: "queued",
    createdAt,
    updatedAt: createdAt,
  },
  approvedVersion: 1,
  executionReadiness: { state: "enabled", reason: "automatic_execution" },
  activity: [],
  columns: (["todo", "in_progress", "in_review", "completed"] as const).map((id) => ({
    id,
    items: [],
  })),
};
const blocked: FactoryIssuePublication = {
  schemaVersion: 1,
  featureId,
  state: "blocked",
  failure: "uncertain_write",
  updatedAt: createdAt,
  items: [
    {
      workItemId: firstId,
      key: "W1",
      state: "published",
      issue: { number: 42, url: "https://github.com/reports/app/issues/42" },
      failure: null,
      dependencyMode: "native",
    },
    {
      workItemId: secondId,
      key: "W2",
      state: "blocked",
      issue: null,
      failure: "uncertain_write",
      dependencyMode: null,
    },
  ],
};

it("retains successful links and retries the same uncertain publication request after reconnect", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let publication = blocked;
  const loadBoard = vi.fn(() => Promise.resolve(board));
  const loadPublication = vi.fn(() => Promise.resolve(publication));
  const retryPublication = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Response lost"))
    .mockImplementationOnce(() => {
      publication = { ...blocked, state: "pending", failure: null };
      return Promise.resolve(publication);
    });
  const onAuthenticationError = vi.fn(() => false);
  const render = async (online: boolean) => {
    await act(async () => {
      root.render(
        createElement(FeatureBoardPanel, {
          projectId,
          featureId,
          online,
          loadBoard,
          loadPublication,
          retryPublication,
          onAuthenticationError,
          onViewPlan: vi.fn(),
        }),
      );
      await Promise.resolve();
    });
  };
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent.trim() === label,
    );
    if (button === undefined) throw new Error(`Button unavailable: ${label}`);
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
  };
  try {
    await render(true);
    expect(container.textContent).toContain("1 of 2 Work Items published");
    expect(container.textContent).toContain("does not recreate the issue");
    await click("Reconcile publication");
    await render(false);
    expect(
      container.querySelector('a[href="https://github.com/reports/app/issues/42"]'),
    ).not.toBeNull();
    loadPublication.mockRejectedValueOnce(new TypeError("Read unavailable"));
    await render(true);
    expect(
      container.querySelector('a[href="https://github.com/reports/app/issues/42"]'),
    ).not.toBeNull();
    await click("Retry request");
    expect(retryPublication).toHaveBeenCalledTimes(2);
    expect(retryPublication.mock.calls[1]).toEqual(retryPublication.mock.calls[0]);
    expect(container.textContent).toContain("Publishing GitHub issues");
  } finally {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows completed publication when a refresh takes longer than the polling interval", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const pending: FactoryIssuePublication = { ...blocked, state: "publishing", failure: null };
  const published: FactoryIssuePublication = {
    ...blocked,
    state: "published",
    failure: null,
    items: blocked.items.map((item) => ({ ...item, state: "published", failure: null })),
  };
  const loadPublication = vi
    .fn<NonNullable<Parameters<typeof FeatureBoardPanel>[0]["loadPublication"]>>()
    .mockResolvedValueOnce(pending)
    .mockImplementation(
      () => new Promise((resolve) => window.setTimeout(() => resolve(published), 2000)),
    );
  try {
    await act(async () => {
      root.render(
        createElement(FeatureBoardPanel, {
          projectId,
          featureId,
          online: true,
          loadBoard: () => Promise.resolve(board),
          loadPublication,
          onAuthenticationError: () => false,
          onViewPlan: vi.fn(),
        }),
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Publishing GitHub issues");
    for (let elapsed = 0; elapsed < 4; elapsed++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    expect(container.textContent).toContain("GitHub issues published");
  } finally {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
