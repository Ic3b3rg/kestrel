// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexReviewModelPreference, CodexSubscriptionConnection } from "@kestrel/contracts";

import { CodexReviewModelPanel, type CodexReviewModelPanelProps } from "./CodexReviewModelPanel.js";

const connection: CodexSubscriptionConnection = {
  schemaVersion: 1,
  state: "ready",
  reason: null,
  cli: { version: "0.152.1", supported: true, protocol: "app_server_v2" },
  account: { authentication: "chatgpt", email: null, plan: "plus" },
  models: [
    { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isDefault: true },
    { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", isDefault: false },
  ],
  usage: { availability: "available", primary: null, secondary: null },
  checkedAt: "2026-09-07T12:00:00.000Z",
};
const emptyPreference: CodexReviewModelPreference = {
  schemaVersion: 1,
  route: "codex_subscription",
  selectedModelId: null,
  updatedAt: null,
};

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent.includes(text),
  );
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  return button;
}

describe("Codex Review model Settings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
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
  });

  async function renderPanel(overrides: Partial<CodexReviewModelPanelProps> = {}): Promise<void> {
    await act(async () => {
      root.render(
        createElement(CodexReviewModelPanel, {
          connection,
          connectionLoading: false,
          loadPreference: vi.fn().mockResolvedValue(emptyPreference),
          online: true,
          onVerify: vi.fn(),
          selectPreference: vi.fn().mockResolvedValue({
            ...emptyPreference,
            selectedModelId: "gpt-5.6-terra",
            updatedAt: "2026-09-07T12:01:00.000Z",
          }),
          ...overrides,
        }),
      );
      await Promise.resolve();
    });
  }

  it("lists only current models and persists the explicit Operator choice", async () => {
    const selectPreference = vi.fn().mockResolvedValue({
      ...emptyPreference,
      selectedModelId: "gpt-5.6-terra",
      updatedAt: "2026-09-07T12:01:00.000Z",
    });
    await renderPanel({ selectPreference });
    await act(async () => Promise.resolve());

    const selector = container.querySelector<HTMLSelectElement>("#codex-review-model");
    expect(selector).not.toBeNull();
    expect([...selector!.options].map(({ value }) => value)).toEqual([
      "",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(container.textContent).toContain("Choose a model");

    await act(async () => {
      selector!.value = "gpt-5.6-terra";
      selector!.dispatchEvent(new Event("change", { bubbles: true }));
      findButton(container, "Save default").click();
      await Promise.resolve();
    });

    expect(selectPreference).toHaveBeenCalledWith(
      { modelId: "gpt-5.6-terra" },
      expect.any(AbortSignal),
    );
    expect(container.textContent).toContain("Default saved");
    expect(container.textContent).toContain("future review preparation");
  });

  it("marks a removed saved model Action required without selecting a fallback", async () => {
    await renderPanel({
      loadPreference: vi.fn().mockResolvedValue({
        ...emptyPreference,
        selectedModelId: "gpt-removed",
        updatedAt: "2026-09-07T11:00:00.000Z",
      }),
    });
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain("Action required");
    expect(container.textContent).toContain("gpt-removed");
    expect(container.textContent).toContain("no longer appears");
    expect(container.querySelector<HTMLSelectElement>("#codex-review-model")?.value).toBe("");
  });

  it("shows connection recovery states and refreshes through the shared live probe", async () => {
    const onVerify = vi.fn();
    await renderPanel({
      connection: { ...connection, state: "action_required", reason: "usage_limit_reached" },
      onVerify,
    });
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain("Usage limit reached");
    await act(async () => {
      findButton(container, "Refresh catalog").click();
      await Promise.resolve();
    });
    expect(onVerify).toHaveBeenCalledOnce();
  });
});
