// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeaturePlans, FeaturePlanVersion } from "@kestrel/contracts";
import { ApiClientError } from "./api.js";
import { FeaturePlanPanel, type FeaturePlanPanelProps } from "./FeaturePlanPanel.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const featureId = "018f0f89-9192-755f-aa96-f72094c734df";
const createdAt = "2026-09-07T12:00:00.000Z";
const version: FeaturePlanVersion = {
  schemaVersion: 1,
  id: "018f0f89-949a-75a8-8f61-6df78a843b1f",
  featureId,
  projectId,
  version: 1,
  author: "operator",
  createdAt,
  sourceContext: null,
  planMarkdown: "# Find reports",
  specMarkdown: "# Report search",
  document: {
    objective: "Find saved reports",
    scope: { includes: ["Title search"], excludes: ["Body search"] },
    acceptance: [{ key: "R1", outcome: "Find a report by its title" }],
    workItems: [
      {
        key: "W1",
        title: "Search reports",
        description: "Implement title search",
        requirementKeys: ["R1"],
        acceptance: ["A title query returns matching reports"],
        dependsOn: [],
        verification: [{ program: "npm", args: ["test"], cwd: ".", timeoutSeconds: 120 }],
      },
    ],
    limits: {
      maxConcurrentProjects: 2,
      maxActiveFeaturesPerProject: 1,
      attemptTimeoutSeconds: 1800,
    },
  },
};
const initial: FeaturePlans = {
  schemaVersion: 1,
  feature: {
    schemaVersion: 1,
    id: featureId,
    projectId,
    title: "Report search",
    state: "planning",
    createdAt,
    updatedAt: createdAt,
  },
  current: version,
  approval: null,
  generation: null,
  versions: [{ version: 1, author: "operator", createdAt }],
};

function button(label: string): HTMLButtonElement {
  const element = [...document.body.querySelectorAll("button")].find(
    (item) => item.textContent.trim() === label,
  );
  if (element === undefined) throw new Error(`Button unavailable: ${label}`);
  return element;
}
async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
  });
}
async function changeObjective(value: string): Promise<void> {
  const input = document.querySelector<HTMLTextAreaElement>("#plan-objective");
  if (input === null) throw new Error("Objective field unavailable");
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its concrete textarea.
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("Native setter unavailable");
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("displayed plan authority", () => {
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
  async function render(overrides: Partial<FeaturePlanPanelProps> = {}): Promise<void> {
    await act(async () => {
      root.render(
        createElement(FeaturePlanPanel, {
          projectId,
          featureId,
          online: true,
          visible: true,
          conversationPending: false,
          onAuthenticationError: vi.fn(() => false),
          onChanged: vi.fn(),
          onApproved: vi.fn(),
          onDirtyChange: vi.fn(),
          loadPlans: () => Promise.resolve(initial),
          ...overrides,
        }),
      );
      await Promise.resolve();
    });
  }

  it("explains why a running conversation prevents plan approval", async () => {
    await render({ conversationPending: true });
    expect(button("Approve version 1").disabled).toBe(true);
    expect(container.textContent).toContain("The conversation is still running");
    expect(container.textContent).toContain("stop planning in Chat");
  });

  it("submits only the displayed version and keeps it visible after a stale approval is rejected", async () => {
    let current = initial;
    const onApproved = vi.fn();
    const approvePlan = vi.fn(() => {
      current = {
        ...initial,
        current: { ...version, version: 2 },
        versions: [...initial.versions, { version: 2, author: "operator", createdAt }],
      };
      return Promise.reject(
        new ApiClientError(409, {
          schemaVersion: 1,
          code: "REQUEST_REJECTED",
          message: "The plan has changed; load the latest version",
          correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
        }),
      );
    });
    await render({ loadPlans: () => Promise.resolve(current), approvePlan, onApproved });
    await click("Approve version 1");
    expect(approvePlan).toHaveBeenCalledTimes(1);
    expect(approvePlan.mock.calls[0]?.slice(0, 3)).toEqual([projectId, featureId, 1]);
    expect(container.textContent).toContain("Plan · version 1");
    expect(container.textContent).toContain("The plan has changed; load the latest version");
    expect(button("Approve version 1").disabled).toBe(true);
    expect(onApproved).not.toHaveBeenCalled();
    await click("Load latest version");
    expect(container.textContent).toContain("Plan · version 2");
  });

  it("retains edits and request identity after an uncertain save instead of appending another version", async () => {
    const next = {
      ...version,
      version: 2,
      document: { ...version.document, objective: "Search archived reports too" },
    };
    let current = initial;
    const savePlan = vi
      .fn()
      .mockImplementationOnce(() => {
        current = {
          ...initial,
          current: next,
          versions: [...initial.versions, { version: 2, author: "operator", createdAt }],
        };
        return Promise.reject(new TypeError("Response was lost"));
      })
      .mockResolvedValue(next);
    const onDirtyChange = vi.fn();
    await render({ loadPlans: () => Promise.resolve(current), savePlan, onDirtyChange });
    await click("Edit draft");
    await changeObjective(next.document.objective);
    await click("Save new version");
    expect(container.querySelector<HTMLTextAreaElement>("#plan-objective")?.value).toBe(
      next.document.objective,
    );
    expect(container.textContent).toContain("Your unsaved edits are retained.");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await click("Retry request");
    expect(savePlan).toHaveBeenCalledTimes(2);
    expect(savePlan.mock.calls[1]).toEqual(savePlan.mock.calls[0]);
    expect(savePlan.mock.calls[0]?.[2]).toMatchObject({ expectedVersion: 1, plan: next.document });
    expect(container.textContent).toContain("Plan · version 2");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("reports incomplete acceptance before sending a plan to the server", async () => {
    const savePlan = vi.fn();
    await render({ savePlan });
    await click("Edit draft");
    const remove = document.querySelector<HTMLButtonElement>(
      '[aria-label="Remove work item 1 acceptance 1"]',
    );
    if (remove === null) throw new Error("Acceptance removal is unavailable");
    await act(async () => {
      remove.click();
      await Promise.resolve();
    });
    await click("Save new version");
    expect(container.textContent).toContain("Resolve these plan problems before saving:");
    expect(container.textContent).toContain("Work Item · 1 · Acceptance");
    expect(savePlan).not.toHaveBeenCalled();
  });
});
