// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { PlanningSkillBundle } from "@kestrel/contracts";
import { PlanningSkillsPanel } from "./PlanningSkillsPanel.js";

const fixtures = vi.hoisted(() => {
  const bundle: PlanningSkillBundle = {
    name: "grilling",
    description: "Ask grounded questions",
    contentDigest: "a".repeat(64),
    source: { kind: "host", label: "grilling", candidateId: "b".repeat(64) },
    files: [
      {
        path: "SKILL.md",
        content: "Ask about the recovery behavior before proposing implementation.",
      },
    ],
  };
  return { bundle, imports: vi.fn(), selection: vi.fn(), catalog: vi.fn() };
});
vi.mock("./factory-skills-api.js", () => ({
  fetchPlanningSkillCatalog: fixtures.catalog,
  fetchPlanningSkillCandidates: vi.fn(() =>
    Promise.resolve({
      schemaVersion: 1,
      configured: true,
      candidates: [{ candidateId: fixtures.bundle.source.candidateId, label: "grilling" }],
    }),
  ),
  fetchPlanningSkill: vi.fn(() => Promise.resolve(fixtures.bundle)),
  importPlanningSkill: fixtures.imports,
  selectPlanningSkills: fixtures.selection,
}));

it("selects retained Skills for the first prompt without creating or mutating a Feature", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixtures.catalog.mockReset().mockResolvedValue({ schemaVersion: 1, skills: [fixtures.bundle] });
  fixtures.selection.mockClear();
  const onDraftSelection = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      await Promise.resolve(
        root.render(
          createElement(PlanningSkillsPanel, {
            projectId: "01900000-0000-7000-8000-000000000001",
            online: true,
            editable: true,
            selection: { schemaVersion: 1, version: 0, skills: [] },
            onDraftSelection,
            onAuthenticationError: () => false,
          }),
        ),
      );
    });
    await act(async () => {
      await Promise.resolve(
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent.trim() === "Skills")
          ?.click(),
      );
    });
    await act(async () => {
      await Promise.resolve(
        document.querySelector<HTMLInputElement>('[aria-label="Use $grilling"]')?.click(),
      );
    });
    await act(async () => {
      await Promise.resolve(
        [...document.querySelectorAll("button")]
          .find((button) => button.textContent.trim() === "Use selected Skills")
          ?.click(),
      );
    });
    expect(onDraftSelection).toHaveBeenCalledWith([fixtures.bundle]);
    expect(fixtures.selection).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

it("previews retained instructions and retries the same uncertain import before selecting the Skill", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixtures.catalog
    .mockResolvedValueOnce({ schemaVersion: 1, skills: [] })
    .mockResolvedValue({ schemaVersion: 1, skills: [fixtures.bundle] });
  fixtures.imports
    .mockRejectedValueOnce(new TypeError("Response lost"))
    .mockResolvedValue(fixtures.bundle);
  fixtures.selection.mockResolvedValue({ schemaVersion: 1, version: 1, skills: [fixtures.bundle] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const changed = vi.fn();
  const click = async (name: string) => {
    const button = [...document.querySelectorAll("button")].find(
      (element) => element.textContent.trim() === name,
    );
    expect(button, `Button ${name}`).toBeDefined();
    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  try {
    await act(async () => {
      root.render(
        createElement(PlanningSkillsPanel, {
          projectId: "01900000-0000-7000-8000-000000000001",
          featureId: "01900000-0000-7000-8000-000000000002",
          online: true,
          editable: true,
          selection: { schemaVersion: 1, version: 0, skills: [] },
          onChanged: changed,
          onAuthenticationError: () => false,
        }),
      );
      await Promise.resolve();
    });
    await click("Skills");
    const candidate = document.querySelector<HTMLSelectElement>(
      '[aria-label="Host Skill to import"]',
    );
    expect(candidate).not.toBeNull();
    await act(async () => {
      if (candidate !== null) {
        candidate.value = fixtures.bundle.source.candidateId;
        candidate.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
    });
    await click("Import Skill");
    await click("Retry import");
    expect(fixtures.imports).toHaveBeenCalledTimes(2);
    expect(fixtures.imports.mock.calls[0]).toEqual(fixtures.imports.mock.calls[1]);
    expect(document.body.textContent).toContain(fixtures.bundle.files[0]?.content);
    await click("Back to Skills");
    const checkbox = document.querySelector<HTMLInputElement>('[aria-label="Use $grilling"]');
    expect(checkbox).not.toBeNull();
    await act(async () => {
      checkbox?.click();
      await Promise.resolve();
    });
    await click("Use selected Skills");
    expect(fixtures.selection).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ expectedVersion: 0, digests: [fixtures.bundle.contentDigest] }),
    );
    expect(changed).toHaveBeenCalled();
    const updated = { ...fixtures.bundle, contentDigest: "c".repeat(64) };
    fixtures.catalog.mockResolvedValue({ schemaVersion: 1, skills: [updated] });
    await act(async () => {
      root.render(
        createElement(PlanningSkillsPanel, {
          projectId: "01900000-0000-7000-8000-000000000001",
          featureId: "01900000-0000-7000-8000-000000000002",
          online: true,
          editable: true,
          selection: { schemaVersion: 1, version: 1, skills: [fixtures.bundle] },
          onChanged: changed,
          onAuthenticationError: () => false,
        }),
      );
      await Promise.resolve();
    });
    await click("Skills (1)");
    const latest = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (input) => !input.checked,
    );
    expect(latest).toBeDefined();
    await act(async () => {
      latest?.click();
      await Promise.resolve();
    });
    await click("Use selected Skills");
    expect(fixtures.selection).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ expectedVersion: 1, digests: [updated.contentDigest] }),
    );
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
