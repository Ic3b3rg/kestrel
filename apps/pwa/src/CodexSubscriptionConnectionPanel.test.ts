// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexSubscriptionConnection } from "@kestrel/contracts";

import {
  CodexSubscriptionConnectionPanel,
  type CodexSubscriptionConnectionPanelProps,
} from "./CodexSubscriptionConnectionPanel.js";

const ready: CodexSubscriptionConnection = {
  schemaVersion: 1,
  state: "ready",
  reason: null,
  cli: { version: "0.152.1", supported: true, protocol: "app_server_v2" },
  account: { authentication: "chatgpt", email: "operator@example.com", plan: "plus" },
  models: [
    { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isDefault: true },
    { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", isDefault: false },
  ],
  usage: {
    availability: "available",
    primary: {
      usedPercent: 25,
      windowDurationMinutes: 300,
      resetsAt: "2026-09-02T22:00:00.000Z",
    },
    secondary: null,
  },
  checkedAt: "2026-09-02T20:00:00.000Z",
};
const authenticationRequired: CodexSubscriptionConnection = {
  schemaVersion: 1,
  state: "action_required",
  reason: "authentication_required",
  cli: { version: "0.152.1", supported: true, protocol: "app_server_v2" },
  account: null,
  models: [],
  usage: null,
  checkedAt: "2026-09-02T20:01:00.000Z",
};
const cliMissing: CodexSubscriptionConnection = {
  schemaVersion: 1,
  state: "action_required",
  reason: "cli_not_installed",
  cli: null,
  account: null,
  models: [],
  usage: null,
  checkedAt: "2026-09-02T20:02:00.000Z",
};

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent.includes(text),
  );
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  return button;
}

describe("Codex subscription Connection Settings", () => {
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

  async function renderPanel(
    overrides: Partial<CodexSubscriptionConnectionPanelProps>,
  ): Promise<void> {
    await act(async () => {
      root.render(createElement(CodexSubscriptionConnectionPanel, { online: true, ...overrides }));
      await Promise.resolve();
    });
  }

  it("shows live ChatGPT plan, models and usage, then exact login remediation on retry", async () => {
    let release: (value: CodexSubscriptionConnection) => void = () => undefined;
    const pending = new Promise<CodexSubscriptionConnection>((resolve) => {
      release = resolve;
    });
    const loadConnection = vi
      .fn<NonNullable<CodexSubscriptionConnectionPanelProps["loadConnection"]>>()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(authenticationRequired);
    await renderPanel({ loadConnection });

    expect(container.textContent).toContain("Checking");
    expect(loadConnection).toHaveBeenCalledWith(expect.any(AbortSignal));

    await act(async () => {
      release(ready);
      await pending;
    });
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).toContain("ChatGPT");
    expect(container.textContent).toContain("operator@example.com");
    expect(container.textContent).toContain("Plus");
    expect(container.textContent).toContain("GPT-5.6 Sol");
    expect(container.textContent).toContain("2 available");
    expect(container.textContent).toContain("Usage availabilityAvailable");
    expect(container.textContent).toContain("25% used");

    await act(async () => {
      findButton(container, "Verify again").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Action required");
    expect(container.textContent).toContain("codex login");
    expect(container.textContent).not.toContain("operator@example.com");
    expect(loadConnection).toHaveBeenCalledTimes(2);
  });

  it("does not probe or imply cached readiness while offline", async () => {
    const loadConnection =
      vi.fn<NonNullable<CodexSubscriptionConnectionPanelProps["loadConnection"]>>();
    await renderPanel({ loadConnection, online: false });

    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Reconnect this workstation");
    expect(findButton(container, "Verify again").disabled).toBe(true);
    expect(loadConnection).not.toHaveBeenCalled();
  });

  it("shows the exact install command when the Codex CLI is missing", async () => {
    const loadConnection = vi.fn().mockResolvedValue(cliMissing);

    await renderPanel({ loadConnection });
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain("Action required");
    expect(container.textContent).toContain("npm install -g @openai/codex");
    expect(container.textContent).toContain("codex --version");
  });
});
