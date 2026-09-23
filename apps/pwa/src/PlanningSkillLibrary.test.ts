// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PlanningSkillBundle, PlanningSkillSummary } from "@kestrel/contracts";

import { PlanningSkillLibrary } from "./PlanningSkillLibrary.js";

const fixtures = vi.hoisted(() => ({ catalog: vi.fn(), bundle: vi.fn() }));
vi.mock("./factory-skills-api.js", () => ({
  fetchPlanningSkillCatalog: fixtures.catalog,
  fetchPlanningSkill: fixtures.bundle,
}));

const grilling: PlanningSkillSummary = {
  name: "grilling",
  description: "Ask grounded questions before planning.",
  contentDigest: "a".repeat(64),
  source: { kind: "host", label: "grilling on this workstation", candidateId: "b".repeat(64) },
};
const research: PlanningSkillSummary = {
  name: "research",
  description: "Check primary sources.",
  contentDigest: "c".repeat(64),
  source: {
    kind: "github",
    label: "example/skills",
    candidateId: "d".repeat(64),
    owner: "example",
    repository: "skills",
    path: "research/SKILL.md",
    requestedRef: "main",
    commitId: "e".repeat(40),
  },
};
const bundle: PlanningSkillBundle = {
  ...grilling,
  files: [
    { path: "SKILL.md", content: "Ask about the intended outcome." },
    { path: "references/questions.md", content: "Ask about failure and recovery." },
  ],
};

afterEach(() => vi.clearAllMocks());

it("lists installed Skills with provenance and inspects their retained instructions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixtures.catalog.mockResolvedValue({ schemaVersion: 1, skills: [grilling, research] });
  fixtures.bundle.mockResolvedValue(bundle);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(PlanningSkillLibrary, { online: true, onAuthenticationError: () => false }),
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("grilling");
    expect(container.textContent).toContain("Ask grounded questions before planning.");
    expect(container.textContent).toContain("grilling on this workstation");
    expect(container.textContent).toContain("Workstation");
    expect(container.textContent).toContain("research");
    expect(container.textContent).toContain("example/skills");
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("aaaaaaaaaaaa");

    const inspect = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Inspect grilling"),
    );
    expect(inspect).toBeDefined();
    await act(async () => {
      inspect?.click();
      await Promise.resolve();
    });
    expect(fixtures.bundle).toHaveBeenCalledWith(grilling.contentDigest, expect.any(AbortSignal));
    expect(document.body.textContent).toContain("Ask about the intended outcome.");

    const reference = document.querySelector<HTMLSelectElement>("#skill-reference");
    expect(reference).not.toBeNull();
    act(() => {
      if (reference !== null) {
        reference.value = "references/questions.md";
        reference.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(document.body.textContent).toContain("Ask about failure and recovery.");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps offline content hidden and retries a failed catalog read", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixtures.catalog
    .mockRejectedValueOnce(new Error("Catalog read failed"))
    .mockResolvedValue({ schemaVersion: 1, skills: [grilling] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (online: boolean) => {
    await act(async () => {
      root.render(
        createElement(PlanningSkillLibrary, { online, onAuthenticationError: () => false }),
      );
      await Promise.resolve();
    });
  };
  try {
    await render(false);
    expect(container.textContent).toContain("Skill Library is offline");
    expect(fixtures.catalog).not.toHaveBeenCalled();

    await render(true);
    expect(container.textContent).toContain("Skill Library unavailable");
    expect(container.textContent).not.toContain("Ask grounded questions before planning.");
    const retry = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Retry Skill Library"),
    );
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    expect(fixtures.catalog).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Ask grounded questions before planning.");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("retries an unavailable retained bundle without reloading the catalog", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixtures.catalog.mockResolvedValue({ schemaVersion: 1, skills: [grilling] });
  fixtures.bundle.mockRejectedValueOnce(new Error("Bundle read failed")).mockResolvedValue(bundle);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(PlanningSkillLibrary, { online: true, onAuthenticationError: () => false }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent.includes("Inspect grilling"))
        ?.click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("The retained Skill could not be loaded.");
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent.includes("Retry instructions"))
        ?.click();
      await Promise.resolve();
    });
    expect(fixtures.catalog).toHaveBeenCalledTimes(1);
    expect(fixtures.bundle).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Ask about the intended outcome.");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
