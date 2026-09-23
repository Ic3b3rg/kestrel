// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { FeaturePlanningSkills } from "@kestrel/contracts";
import { ApiClientError } from "./api.js";
import { PlanningSkillChips } from "./PlanningSkillChips.js";

const api = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("./factory-skills-api.js", () => ({ selectPlanningSkills: api.select }));
const selection: FeaturePlanningSkills = {
  schemaVersion: 1,
  version: 3,
  skills: [
    {
      name: "grilling",
      description: "Ask questions",
      contentDigest: "a".repeat(64),
      source: { kind: "host", label: "workstation", candidateId: "b".repeat(64) },
    },
    {
      name: "research",
      description: "Check sources",
      contentDigest: "c".repeat(64),
      source: { kind: "host", label: "workstation", candidateId: "d".repeat(64) },
    },
  ],
};
afterEach(() => vi.clearAllMocks());

it("renders active chips and removes one with the authoritative selection version", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.select.mockResolvedValue({ ...selection, version: 4, skills: [selection.skills[1]] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChanged = vi.fn();
  try {
    act(() => {
      root.render(
        createElement(PlanningSkillChips, {
          projectId: "project",
          featureId: "feature",
          selection,
          online: true,
          editable: true,
          onChanged,
          onAuthenticationError: () => false,
        }),
      );
    });
    expect(container.textContent).toContain("$grilling");
    expect(container.textContent).toContain("$research");
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label") === "Remove grilling")
        ?.click();
      await Promise.resolve();
    });
    expect(api.select).toHaveBeenCalledWith(
      "project",
      "feature",
      expect.objectContaining({
        expectedVersion: 3,
        digests: [selection.skills[1]?.contentDigest],
      }),
    );
    expect(onChanged).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("blocks removal during a reply and gives refresh guidance on a stale selection", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.select.mockRejectedValue(
    new ApiClientError(409, {
      schemaVersion: 1,
      code: "REQUEST_REJECTED",
      message: "The selected Skills changed",
      correlationId: "01991c36-7f90-7000-8000-000000000003",
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChanged = vi.fn();
  const render = (editable: boolean) =>
    act(() => {
      root.render(
        createElement(PlanningSkillChips, {
          projectId: "project",
          featureId: "feature",
          selection,
          online: true,
          editable,
          onChanged,
          onAuthenticationError: () => false,
        }),
      );
    });
  try {
    render(false);
    const remove = [...container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Remove grilling",
    );
    expect(remove?.disabled).toBe(true);
    render(true);
    await act(async () => {
      remove?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Refresh Skills");
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Refresh Skills")
        ?.click();
      await Promise.resolve();
    });
    expect(onChanged).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("retries an uncertain removal with the same request identity", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.select.mockRejectedValueOnce(new TypeError("Response lost")).mockResolvedValue(selection);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    const render = (editable: boolean) =>
      act(() => {
        root.render(
          createElement(PlanningSkillChips, {
            projectId: "project",
            featureId: "feature",
            selection,
            online: true,
            editable,
            onChanged: vi.fn(),
            onAuthenticationError: () => false,
          }),
        );
      });
    render(true);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label") === "Remove research")
        ?.click();
      await Promise.resolve();
    });
    render(false);
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Retry removal",
      )?.disabled,
    ).toBe(true);
    render(true);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry removal")
        ?.click();
      await Promise.resolve();
    });
    expect(api.select).toHaveBeenCalledTimes(2);
    expect(api.select.mock.calls[0]).toEqual(api.select.mock.calls[1]);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
