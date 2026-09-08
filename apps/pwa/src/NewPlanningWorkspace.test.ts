// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlanningFeatureStarted, PlanningSkillSummary } from "@kestrel/contracts";
import { NewPlanningWorkspace, type NewPlanningWorkspaceProps } from "./NewPlanningWorkspace.js";

const api = vi.hoisted(() => ({ lookup: vi.fn(), start: vi.fn() }));
vi.mock("./factory-start-api.js", () => ({
  fetchPlanningFeatureRequest: api.lookup,
  startPlanningFeature: api.start,
}));
const skill: PlanningSkillSummary = {
  name: "grilling",
  description: "Ask grounded questions",
  contentDigest: "a".repeat(64),
  source: { kind: "host", label: "grilling", candidateId: "b".repeat(64) },
};
vi.mock("./PlanningSkillsPanel.js", () => ({
  PlanningSkillsPanel: (props: {
    editable: boolean;
    onDraftSelection: (skills: PlanningSkillSummary[]) => void;
  }) =>
    createElement(
      "button",
      { type: "button", disabled: !props.editable, onClick: () => props.onDraftSelection([skill]) },
      "Choose Skills",
    ),
}));

const projectId = "01991c36-7f90-7000-8000-000000000001";
const started: PlanningFeatureStarted = {
  schemaVersion: 1,
  turnId: "01991c36-7f90-7000-8000-000000000002",
  messageId: "01991c36-7f90-7000-8000-000000000003",
  feature: {
    schemaVersion: 1,
    id: "01991c36-7f90-7000-8000-000000000004",
    projectId,
    state: "planning",
    title: "New plan",
    createdAt: "2026-09-08T12:00:00.000Z",
    updatedAt: "2026-09-08T12:00:00.000Z",
  },
};
let root: Root;
let container: HTMLDivElement;
let props: NewPlanningWorkspaceProps;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.lookup.mockReset().mockResolvedValue({ schemaVersion: 1, feature: null });
  api.start.mockReset();
  props = {
    projectId,
    projectName: "Reports",
    requestId: "8ae8cc26-3e92-46b6-8b13-4b966b28133d",
    online: true,
    onStarted: vi.fn(),
    onNavigate: vi.fn(),
    onAuthenticationError: vi.fn(() => false),
    onDraftDirtyChange: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    await Promise.resolve(root.unmount());
  });
  container.remove();
  vi.unstubAllGlobals();
});
const render = async () =>
  act(async () => {
    await Promise.resolve(root.render(createElement(NewPlanningWorkspace, props)));
  });
async function type(text: string) {
  await act(async () => {
    const field = container.querySelector("textarea");
    if (field === null) throw new Error("Missing first prompt");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));

    await Promise.resolve();
  });
}
const submit = async () =>
  act(async () => {
    await Promise.resolve(
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
  });

it("looks up an accepted draft URL on reload without creating another Feature", async () => {
  api.lookup.mockResolvedValue({ schemaVersion: 1, feature: started.feature });
  await render();
  expect(props.onStarted).toHaveBeenCalledExactlyOnceWith(started.feature);
  expect(api.start).not.toHaveBeenCalled();
});

it("retains the first prompt and selected Skills across double-submit and uncertain retry", async () => {
  api.start.mockRejectedValueOnce(new TypeError("Response lost")).mockResolvedValue(started);
  await render();
  await act(async () => {
    await Promise.resolve(
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Choose Skills")
        ?.click(),
    );
  });
  await type("Search saved reports.");
  await act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await Promise.resolve();
  });
  expect(api.start).toHaveBeenCalledOnce();
  expect(container.querySelector("textarea")?.value).toBe("Search saved reports.");
  expect(container.querySelector("textarea")?.disabled).toBe(true);
  await submit();
  expect(api.start).toHaveBeenCalledTimes(2);
  expect(api.start.mock.calls[0]).toEqual(api.start.mock.calls[1]);
  expect(api.start.mock.calls[0]).toEqual([
    projectId,
    {
      requestId: props.requestId,
      text: "Search saved reports.",
      skillDigests: [skill.contentDigest],
    },
  ]);
  expect(props.onStarted).toHaveBeenCalledExactlyOnceWith(started.feature);
});

it("keeps accepted work alive without navigating from a departed workspace", async () => {
  const completion = Promise.withResolvers<PlanningFeatureStarted>();
  api.start.mockReturnValue(completion.promise);
  await render();
  await type("Search saved reports.");
  await submit();
  await act(async () => {
    await Promise.resolve(root.render(null));
  });
  await act(async () => {
    await Promise.resolve(completion.resolve(started));
  });
  expect(props.onStarted).not.toHaveBeenCalled();
  expect(api.start.mock.calls[0]).toHaveLength(2);
});

it("preserves the private draft during session suspension and resolves accepted work after rechecking", async () => {
  const completion = Promise.withResolvers<PlanningFeatureStarted>();
  api.start.mockReturnValue(completion.promise);
  await render();
  await type("Private report search.");
  await submit();
  props = { ...props, online: false };
  await render();
  await act(async () => {
    await Promise.resolve(completion.resolve(started));
  });
  expect(props.onStarted).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")?.value).toBe("Private report search.");
  api.lookup.mockResolvedValue({ schemaVersion: 1, feature: started.feature });
  props = { ...props, online: true };
  await render();
  expect(props.onStarted).toHaveBeenCalledExactlyOnceWith(started.feature);
  expect(api.start).toHaveBeenCalledOnce();
});
