// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PlanningSkillComposer } from "./PlanningSkillComposer.js";

const api = vi.hoisted(() => ({ catalog: vi.fn() }));
vi.mock("./factory-skills-api.js", () => ({ fetchPlanningSkillCatalog: api.catalog }));

it("offers installed Skills for a slash query and inserts one at the caret with keyboard focus restored", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.catalog.mockResolvedValue({
    schemaVersion: 1,
    skills: [
      {
        name: "research",
        description: "Check sources",
        contentDigest: "a".repeat(64),
        source: { kind: "host", label: "workstation", candidateId: "b".repeat(64) },
      },
    ],
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let value = "Plan /re before";
  const change = vi.fn((next: string) => {
    value = next;
  });
  const render = async () =>
    act(async () => {
      root.render(
        createElement(PlanningSkillComposer, {
          id: "prompt",
          value,
          onValueChange: change,
          online: true,
          disabled: false,
          onAuthenticationError: () => false,
          rows: 3,
        }),
      );
      await Promise.resolve();
    });
  try {
    await render();
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    await act(async () => {
      textarea?.focus();
      textarea?.setSelectionRange(8, 8);
      textarea?.dispatchEvent(new Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("research");
    await act(async () => {
      textarea?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    await render();
    expect(value).toBe("Plan /research before");
    expect(document.activeElement).toBe(textarea);
    expect(textarea?.selectionStart).toBe(14);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("highlights known slash and dollar Skills inside the draft without changing editable text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.catalog.mockResolvedValue({
    schemaVersion: 1,
    skills: [
      {
        name: "research",
        description: "Check sources",
        contentDigest: "a".repeat(64),
        source: { kind: "host", label: "workstation", candidateId: "b".repeat(64) },
      },
    ],
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const value = "Use /research then $research. Keep /unknown plain.";
  try {
    await act(async () => {
      await Promise.resolve(
        root.render(
          createElement(PlanningSkillComposer, {
            id: "draft",
            value,
            onValueChange: vi.fn(),
            online: true,
            disabled: false,
            onAuthenticationError: () => false,
            rows: 3,
          }),
        ),
      );
    });
    expect([...container.querySelectorAll("mark")].map((item) => item.textContent)).toEqual([
      "/research",
      "$research",
    ]);
    expect(container.querySelector("textarea")?.value).toBe(value);
    expect(container.querySelector("[data-skill-highlight]")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
