// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectIssueStart } from "@kestrel/contracts";
import { ProjectIssueConversation } from "./ProjectIssueConversation.js";

const projectId = "01991c36-7f90-7000-8000-000000000001";
const startId = "01991c36-7f90-7000-8000-000000000010";
const featureId = "01991c36-7f90-7000-8000-000000000011";
const start: ProjectIssueStart = {
  id: startId,
  issueNumber: 42,
  issueUrl: "https://github.com/example/reports/issues/42",
  title: "Export reports",
  state: "preparing",
  featureId: null,
  message: null,
};
const api = vi.hoisted(() => ({ read: vi.fn(), change: vi.fn() }));
vi.mock("./project-issue-api.js", async (original) => ({
  ...(await original<object>()),
  fetchProjectIssueStart: api.read,
  changeProjectIssueStart: api.change,
}));
vi.mock("./FeatureChatPanel.js", () => ({
  FeatureChatPanel: ({ featureId }: { featureId: string }) =>
    createElement("div", { "data-testid": "feature-conversation" }, featureId),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  api.read.mockReset().mockResolvedValue(start);
  api.change.mockReset().mockResolvedValue({ id: startId });
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

it("keeps the same issue conversation while preparation creates a Feature", async () => {
  await act(async () => {
    root.render(
      createElement(ProjectIssueConversation, {
        projectId,
        projectName: "Reports",
        startId,
        online: true,
        onNavigate: vi.fn(),
        onAuthenticationError: () => false,
        onFeatureRead: vi.fn(),
        onFeatureUnavailable: vi.fn(),
      }),
    );
    await Promise.resolve();
  });
  expect(container.textContent).toContain("Preparing development");
  expect(container.querySelector('[data-testid="feature-conversation"]')).toBeNull();
  api.read.mockResolvedValue({ ...start, state: "running", featureId });
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(container.querySelector('[data-testid="feature-conversation"]')?.textContent).toBe(
    featureId,
  );
});

it("shows a blocked reason and retries from the same conversation", async () => {
  api.read.mockResolvedValue({ ...start, state: "blocked", message: "Answer the scope question." });
  await act(async () => {
    root.render(
      createElement(ProjectIssueConversation, {
        projectId,
        projectName: "Reports",
        startId,
        online: true,
        onNavigate: vi.fn(),
        onAuthenticationError: () => false,
        onFeatureRead: vi.fn(),
        onFeatureUnavailable: vi.fn(),
      }),
    );
    await Promise.resolve();
  });
  expect(container.textContent).toContain("Answer the scope question.");
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent.trim() === "Retry preparation")
      ?.click();
    await Promise.resolve();
  });
  expect(api.change).toHaveBeenCalledWith(projectId, startId, "retry");
});
