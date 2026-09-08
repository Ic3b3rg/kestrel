// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactoryBoard, FactoryWorkItem, Feature } from "@kestrel/contracts";
import {
  ProjectFactoryBoardPanel,
  type ProjectFactoryBoardPanelProps,
} from "./ProjectFactoryBoardPanel.js";

const createdAt = "2026-09-08T10:00:00.000Z";
const planning: Feature = {
  schemaVersion: 1,
  id: "018f0f89-9192-755f-aa96-f72094c734df",
  projectId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
  title: "Search saved reports",
  state: "planning",
  createdAt,
  updatedAt: createdAt,
};
const approved: Feature = {
  ...planning,
  id: "018f0f89-9192-755f-aa96-f72094c734e0",
  title: "Export reports",
  state: "implementing",
};
const firstItem: FactoryWorkItem = {
  id: "018f0f89-9192-755f-aa96-f72094c734e1",
  featureId: approved.id,
  key: "export",
  order: 1,
  title: "Export the selected report",
  description: "Save the selected report as a CSV file.",
  importedIssueId: null,
  requirementKeys: ["csv"],
  acceptance: ["The selected report can be saved as CSV."],
  dependsOn: [],
  verification: [{ program: "node", args: ["--test"], cwd: ".", timeoutSeconds: 30 }],
  column: "in_review",
  blocking: null,
  providerUrl: "https://github.com/owner/reports/issues/42",
  activity: [],
};
const waitingItem: FactoryWorkItem = {
  ...firstItem,
  id: "018f0f89-9192-755f-aa96-f72094c734e2",
  key: "download",
  order: 2,
  title: "Download the export",
  dependsOn: ["export"],
  column: "todo",
  blocking: { kind: "human_gate", explanation: "Should the export include archived reports?" },
  providerUrl: null,
};

function board(feature = approved, items = [firstItem, waitingItem]): FactoryBoard {
  return {
    schemaVersion: 1,
    feature,
    approvedVersion: 1,
    executionReadiness: { state: "enabled", reason: "automatic_execution" },
    columns: (["todo", "in_progress", "in_review", "completed"] as const).map((id) => ({
      id,
      items: items.filter((item) => item.column === id),
    })),
    activity: [],
  };
}

describe("Project Factory board", () => {
  let root: Root;
  let container: HTMLDivElement;
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
    vi.unstubAllGlobals();
  });
  async function render(overrides: Partial<ProjectFactoryBoardPanelProps> = {}) {
    await act(async () => {
      root.render(
        createElement(ProjectFactoryBoardPanel, {
          projectName: "Reports",
          features: [planning, approved],
          boards: [board()],
          online: true,
          loading: false,
          error: null,
          onStartPlan: vi.fn(),
          onOpenFeature: vi.fn(),
          onRefresh: vi.fn(),
          onOpenPullRequests: vi.fn(),
          onOpenSettings: vi.fn(),
          ...overrides,
        }),
      );
      await Promise.resolve();
    });
  }
  function button(label: string) {
    const found = [...container.querySelectorAll("button")].find(
      (element) =>
        element.getAttribute("aria-label") === label || element.textContent.trim() === label,
    );
    if (found === undefined) throw new Error("Missing button: " + label);
    return found;
  }

  it("combines planning Features and approved Work Items without inventing completion or issue links", async () => {
    await render();
    const todo = container.querySelector('[aria-label="To do"]');
    expect(todo?.textContent).toContain(planning.title);
    expect(todo?.textContent).toContain("Planning");
    expect(todo?.textContent).toContain(waitingItem.title);
    expect(todo?.textContent).toContain(approved.title);
    expect(todo?.textContent).toContain("After export");
    expect(todo?.textContent).toContain(waitingItem.blocking?.explanation);
    expect(container.querySelector('[aria-label="In review"]')?.textContent).toContain(
      firstItem.title,
    );
    expect(container.querySelector('[aria-label="Completed"]')?.textContent).not.toContain(
      firstItem.title,
    );
    expect(container.querySelectorAll("h2")).toHaveLength(4);
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector("a")?.href).toBe(firstItem.providerUrl);
    expect(container.querySelectorAll('button[aria-label^="Open planning chat:"]')).toHaveLength(1);
  });

  it("uses the approved board when the Feature list still contains an older planning state", async () => {
    await render({ features: [{ ...approved, state: "planning" }], boards: [board()] });
    expect(container.querySelectorAll('button[aria-label^="Open planning chat:"]')).toHaveLength(0);
    expect(container.querySelector('[aria-label="In review"]')?.textContent).toContain(
      firstItem.title,
    );
  });

  it("keeps Work Items from different approved Features on the same Project board", async () => {
    const nextFeature: Feature = {
      ...approved,
      id: "018f0f89-9192-755f-aa96-f72094c734e3",
      title: "Share reports",
      state: "queued",
    };
    const nextItem: FactoryWorkItem = {
      ...firstItem,
      id: "018f0f89-9192-755f-aa96-f72094c734e4",
      featureId: nextFeature.id,
      title: "Share a saved report",
      column: "todo",
      providerUrl: null,
    };
    await render({
      features: [approved, nextFeature],
      boards: [board(), board(nextFeature, [nextItem])],
    });
    const todo = container.querySelector('[aria-label="To do"]');
    expect(todo?.textContent).toContain(waitingItem.title);
    expect(todo?.textContent).toContain(approved.title);
    expect(todo?.textContent).toContain(nextItem.title);
    expect(todo?.textContent).toContain(nextFeature.title);
    expect(container.querySelector('[aria-label="In review"]')?.textContent).toContain(
      firstItem.title,
    );
  });

  it("opens the matching chat or Feature board and keeps Project actions separate", async () => {
    const onStartPlan = vi.fn();
    const onOpenFeature = vi.fn();
    const onRefresh = vi.fn();
    const onOpenPullRequests = vi.fn();
    const onOpenSettings = vi.fn();
    await render({ onStartPlan, onOpenFeature, onRefresh, onOpenPullRequests, onOpenSettings });
    await act(async () => {
      button("New plan").click();
      button("Open planning chat: " + planning.title).click();
      button("Open Work Item: " + firstItem.title + " · " + approved.title).click();
      button("Refresh board").click();
      button("Pull requests").click();
      button("Settings").click();
      await Promise.resolve();
    });
    expect(onStartPlan).toHaveBeenCalledOnce();
    expect(onOpenFeature.mock.calls).toEqual([
      [planning.id, "chat"],
      [approved.id, "board"],
    ]);
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onOpenPullRequests).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(container.querySelector("button a, a button")).toBeNull();
  });

  it("retains known cards during loading, errors, and offline viewing", async () => {
    await render({ online: false, loading: true, error: "The board could not be refreshed." });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be refreshed",
    );
    expect(container.textContent).toContain(firstItem.title);
    expect(container.textContent).toContain("Reconnect to refresh");
    expect(button("Refresh board").disabled).toBe(true);
    expect(button("Open planning chat: " + planning.title).disabled).toBe(false);
  });

  it("shows an empty four-column board with New in To do", async () => {
    await render({ features: [], boards: [] });
    expect(container.querySelectorAll("h2")).toHaveLength(4);
    expect(container.querySelector('[aria-label="To do"]')?.contains(button("New plan"))).toBe(
      true,
    );
    expect(container.querySelectorAll("li")).toHaveLength(0);
    expect(container.textContent).toContain("Start a plan");
  });
});
