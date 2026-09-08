// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureChat, FeaturePlanVersion } from "@kestrel/contracts";
import { FeatureChatPanel, type FeatureChatPanelProps } from "./FeatureChatPanel.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const featureId = "018f0f89-9192-755f-aa96-f72094c734df";
const messageId = "018f0f89-949a-75a8-8f61-6df78a843b1f";
const turnId = "018f0f89-9a1e-7d64-a5dd-18cc3e317401";
const createdAt = "2026-09-07T12:00:00.000Z";
const initial: FeatureChat = {
  schemaVersion: 1,
  feature: {
    schemaVersion: 1,
    id: featureId,
    projectId,
    title: "Search saved reports",
    state: "planning",
    createdAt,
    updatedAt: createdAt,
  },
  messages: [{ id: messageId, role: "user", content: "Help define report search", createdAt }],
  turns: [
    {
      id: turnId,
      messageId,
      state: "queued",
      failure: null,
      question: null,
      createdAt,
      startedAt: null,
      completedAt: null,
    },
  ],
  context: null,
};
const generatedVersion: FeaturePlanVersion = {
  schemaVersion: 1,
  id: "018f0f89-949a-75a8-8f61-6df78a843b20",
  projectId,
  featureId,
  version: 1,
  author: "assistant",
  createdAt,
  planMarkdown: "# Plan",
  specMarkdown: "# Spec",
  sourceContext: {
    commitId: "a".repeat(40),
    documents: [],
    notice: "Retained generation context.",
  },
  document: {
    objective: "Search",
    scope: { includes: ["Titles"], excludes: [] },
    acceptance: [{ key: "R1", outcome: "Find reports by title" }],
    workItems: [
      {
        key: "W1",
        title: "Search",
        description: "Add title search",
        importedIssueId: null,
        requirementKeys: ["R1"],
        acceptance: ["Reports can be found"],
        dependsOn: [],
        verification: [
          { program: "node", args: ["--test", "search.test.mjs"], cwd: ".", timeoutSeconds: 60 },
        ],
      },
    ],
    limits: {
      maxConcurrentProjects: 2,
      maxActiveFeaturesPerProject: 1,
      attemptTimeoutSeconds: 1800,
    },
    proposedDocuments: [
      {
        key: "language",
        kind: "glossary",
        path: "CONTEXT.md",
        pathIsProvisional: false,
        markdown: "# Language\nThe original glossary proposal.\n",
        workItemKey: "W1",
      },
    ],
  },
};

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (element) => element.textContent.trim() === label,
  );
  if (found === undefined) throw new Error(`Button ${label} is unavailable`);
  return found;
}

describe("persistent planning conversation", () => {
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
  async function render(overrides: Partial<FeatureChatPanelProps> = {}) {
    await act(async () => {
      root.render(
        createElement(FeatureChatPanel, {
          projectId,
          featureId,
          projectName: "Reports",
          online: true,
          onNavigate: vi.fn(),
          onAuthenticationError: vi.fn(() => false),
          onFeatureRead: vi.fn(),
          onFeatureUnavailable: vi.fn(),
          loadChat: vi.fn(() => Promise.resolve(initial)),
          ...overrides,
        }),
      );
      await Promise.resolve();
    });
  }

  it("keeps an implementing feature distinct from cancellation while planning remains frozen", async () => {
    await render({
      loadChat: () =>
        Promise.resolve({
          ...initial,
          feature: { ...initial.feature, state: "implementing" },
          turns: [],
        }),
    });
    expect(container.textContent).toContain("In progress");
    expect(container.textContent).not.toContain("Cancelled ·");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
  });

  it("renames during a pending reply and retries the identical command after an uncertain response", async () => {
    let current = initial;
    const renamed = { ...initial.feature, title: "Operator report search" };
    const renameFeature = vi
      .fn<NonNullable<FeatureChatPanelProps["renameFeature"]>>()
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockImplementationOnce(() => {
        current = { ...initial, feature: renamed };
        return Promise.resolve(renamed);
      });
    const onFeatureRead = vi.fn();
    await render({ loadChat: () => Promise.resolve(current), renameFeature, onFeatureRead });
    const trigger = button("Rename feature");
    await act(async () => {
      trigger.focus();
      trigger.click();
      await Promise.resolve();
    });
    const input = document.querySelector<HTMLInputElement>('input[id="feature-name"]');
    if (input === null) throw new Error("Feature name input unavailable");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        renamed.title,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      button("Save name").click();
      await Promise.resolve();
    });
    expect(input.disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be confirmed",
    );
    await act(async () => {
      button("Retry rename").click();
      await Promise.resolve();
    });
    expect(renameFeature).toHaveBeenCalledTimes(2);
    expect(renameFeature.mock.calls[0]).toEqual(renameFeature.mock.calls[1]);
    expect(renameFeature.mock.calls[0]?.slice(0, 2)).toEqual([projectId, featureId]);
    expect(renameFeature.mock.calls[0]?.[2].title).toBe(renamed.title);
    expect(renameFeature.mock.calls[0]?.[2].requestId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(container.querySelector("h1")?.textContent).toBe(renamed.title);
    expect(onFeatureRead).toHaveBeenCalledWith(renamed);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  it.each([1, 3])(
    "opens a reply's exact saved plan and refuses a different returned version: returned=%s",
    async (returnedVersion) => {
      const loadPlanVersion = vi
        .fn()
        .mockResolvedValue({ ...generatedVersion, version: returnedVersion });
      await render({
        loadChat: () =>
          Promise.resolve({
            ...initial,
            turns: [],
            messages: [
              {
                id: messageId,
                createdAt,
                role: "assistant",
                content: "A plan was generated.",
                generatedPlanVersion: 1,
              },
            ],
            context: { commitId: "b".repeat(40), documents: [], notice: "Newer chat context." },
          }),
        loadPlanVersion,
      });
      await act(async () => {
        button("Inspect plan 1 documents").click();
        await Promise.resolve();
      });
      expect(loadPlanVersion.mock.calls[0]?.slice(0, 3)).toEqual([projectId, featureId, 1]);
      if (returnedVersion === 1) {
        expect(document.body.textContent).toContain("The original glossary proposal.");
        await act(async () => {
          button("Sources supplied for this plan").click();
          await Promise.resolve();
        });
        expect(document.body.textContent).toContain("Retained generation context.");
        expect(document.body.textContent).toContain("a".repeat(40));
      } else {
        expect(document.body.textContent).not.toContain("The original glossary proposal.");
        expect(document.body.textContent).toContain("This plan version could not be loaded.");
      }
    },
  );

  it("updates execution status without an active planning turn or a manual refresh", async () => {
    vi.useFakeTimers();
    const loadChat = vi
      .fn()
      .mockResolvedValueOnce({
        ...initial,
        feature: { ...initial.feature, state: "implementing" },
        turns: [],
      })
      .mockResolvedValue({
        ...initial,
        feature: { ...initial.feature, state: "in_review" },
        turns: [],
      });
    try {
      await render({ loadChat });
      expect(container.textContent).toContain("In progress");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(container.textContent).toContain("In review");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops only the explicitly selected pending turn and preserves the accepted message", async () => {
    let chat = initial;
    const cancelTurn = vi.fn(() => {
      chat = {
        ...initial,
        turns: initial.turns.map((turn) => ({
          ...turn,
          state: "cancelled",
          failure: "cancelled",
          completedAt: createdAt,
        })),
      };
      return Promise.resolve(chat);
    });
    await render({ loadChat: () => Promise.resolve(chat), cancelTurn });
    expect(container.textContent).toContain("Waiting to start");
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(cancelTurn).not.toHaveBeenCalled();
    await act(async () => {
      button("Stop planning").click();
      await Promise.resolve();
    });
    expect(cancelTurn).toHaveBeenCalledExactlyOnceWith(projectId, featureId, turnId);
    expect(container.textContent).toContain("Planning stopped");
    expect(container.textContent).toContain("Help define report search");
    expect(container.querySelector("textarea")?.disabled).toBe(false);
    expect(container.querySelectorAll('[aria-label="Kestrel reply"]')).toHaveLength(0);
  });

  it("closing the view aborts its read without cancelling accepted workstation work", async () => {
    const cancelTurn = vi.fn();
    let readSignal: AbortSignal | undefined;
    await render({
      loadChat: (_projectId, _featureId, signal) => {
        readSignal = signal;
        return Promise.resolve(initial);
      },
      cancelTurn,
    });
    await act(async () => {
      root.render(null);
      await Promise.resolve();
    });
    expect(readSignal?.aborted).toBe(true);
    expect(cancelTurn).not.toHaveBeenCalled();
  });

  it("retains the open feature while offline and disables workstation commands", async () => {
    await render();
    await render({ online: false });
    expect(container.textContent).toContain("Help define report search");
    expect(button("Stop planning").disabled).toBe(true);
    expect(container.querySelector('[aria-label="Feature plan"]')).not.toBeNull();
    await render();
    expect(container.textContent).toContain("Help define report search");
    expect(button("Stop planning").disabled).toBe(false);
  });

  it("presents the saved question and allows an answer without inventing an assistant reply", async () => {
    await render({
      loadChat: () =>
        Promise.resolve({
          ...initial,
          turns: initial.turns.map((turn) => ({
            ...turn,
            state: "failed",
            failure: "input_required",
            question: "Should report search include archived reports?",
            completedAt: createdAt,
          })),
          context: { commitId: null, documents: [], notice: "No authorized source is attached." },
        }),
    });
    expect(container.textContent).toContain("Kestrel needs your answer");
    expect(container.textContent).toContain("Should report search include archived reports?");
    expect(container.textContent).toContain("No authorized source is attached.");
    expect(container.querySelector("textarea")?.disabled).toBe(false);
    expect(container.querySelectorAll('[aria-label="Kestrel reply"]')).toHaveLength(0);
  });

  it("opens repository settings for unavailable source while preserving the selected Project", async () => {
    await render({
      loadChat: () =>
        Promise.resolve({
          ...initial,
          turns: initial.turns.map((turn) => ({
            ...turn,
            state: "failed",
            failure: "source_unavailable",
            completedAt: createdAt,
          })),
        }),
    });
    const sourceLink = [...container.querySelectorAll("a")].find(
      (link) => link.textContent === "Check Project source",
    );
    expect(sourceLink?.getAttribute("href")).toBe(
      `/settings?projectId=${projectId}#repository-settings-title`,
    );
  });

  it("accepts the same feature from its server-resolved canonical Project", async () => {
    const onFeatureRead = vi.fn();
    await render({
      projectId: "018f0f89-949a-75a8-8f61-6df78a843b20",
      onFeatureRead,
    });
    expect(container.textContent).toContain("Help define report search");
    expect(onFeatureRead).toHaveBeenCalledExactlyOnceWith(initial.feature);
  });

  it("rejects a response containing a different feature identity", async () => {
    const onFeatureRead = vi.fn();
    await render({
      featureId: "018f0f89-949a-75a8-8f61-6df78a843b20",
      onFeatureRead,
    });
    expect(container.textContent).toContain("Conversation unavailable");
    expect(container.textContent).not.toContain("Help define report search");
    expect(onFeatureRead).not.toHaveBeenCalled();
  });
});
