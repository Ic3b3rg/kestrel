// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostGitHubConnection, ProjectInbox } from "@kestrel/contracts";

import {
  HostGitHubConnectionPanel,
  type HostGitHubConnectionPanelProps,
} from "./HostGitHubConnectionPanel.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const project: ProjectInbox["projects"][number] = {
  changeProposals: [],
  createdAt: "2026-09-02T12:00:00.000Z",
  id: projectId,
  localRepositorySource: {
    createdAt: "2026-09-02T12:00:00.000Z",
    displayName: "kestrel",
    id: "018f0f89-949a-75a8-8f61-6df78a843b10",
    objectFormat: "sha1",
    repositoryId: "018f0f89-949a-75a8-8f61-6df78a843b11",
    state: "attached",
    updatedAt: "2026-09-02T12:00:00.000Z",
  },
  modelAccess: "not_configured",
  providerObservation: null,
  repository: null,
  sourceAvailability: "not_acquired",
  updatedAt: "2026-09-02T12:00:00.000Z",
};
const ready: HostGitHubConnection = {
  schemaVersion: 1,
  state: "ready",
  reason: null,
  cli: { version: "2.87.0", supported: true },
  identity: { host: "github.com", account: "operator" },
  projectAccess: {
    state: "verified",
    projectId,
    repository: { owner: "Ic3b3rg", name: "kestrel" },
  },
  checkedAt: "2026-09-02T12:00:00.000Z",
};
const authenticationRequired: HostGitHubConnection = {
  schemaVersion: 1,
  state: "action_required",
  reason: "authentication_required",
  cli: { version: "2.87.0", supported: true },
  identity: null,
  projectAccess: { state: "not_verified", projectId, repository: null },
  checkedAt: "2026-09-02T12:01:00.000Z",
};

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent.includes(text),
  );
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  return button;
}

describe("host GitHub Connection Settings", () => {
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

  async function renderPanel(overrides: Partial<HostGitHubConnectionPanelProps>): Promise<void> {
    await act(async () => {
      root.render(
        createElement(HostGitHubConnectionPanel, {
          online: true,
          projects: [project],
          ...overrides,
        }),
      );
      await Promise.resolve();
    });
  }

  it("shows Checking, validated identity and exact unauthenticated remediation on retry", async () => {
    let release: (value: HostGitHubConnection) => void = () => undefined;
    const pending = new Promise<HostGitHubConnection>((resolve) => {
      release = resolve;
    });
    const loadConnection = vi
      .fn<NonNullable<HostGitHubConnectionPanelProps["loadConnection"]>>()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(authenticationRequired);
    await renderPanel({ loadConnection });

    expect(container.textContent).toContain("Checking");
    expect(loadConnection).toHaveBeenCalledWith(projectId, expect.any(AbortSignal));

    await act(async () => {
      release(ready);
      await pending;
    });
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).toContain("github.com");
    expect(container.textContent).toContain("operator");
    expect(container.textContent).toContain("Ic3b3rg/kestrel");

    await act(async () => {
      findButton(container, "Verify again").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Action required");
    expect(container.textContent).toContain("gh auth login --hostname github.com");
    expect(container.textContent).not.toContain("operator");
    expect(loadConnection).toHaveBeenCalledTimes(2);
  });

  it("shows an honest Unavailable state while offline without probing", async () => {
    const loadConnection = vi.fn<NonNullable<HostGitHubConnectionPanelProps["loadConnection"]>>();
    await renderPanel({ loadConnection, online: false });

    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Reconnect this workstation");
    expect(findButton(container, "Verify again").disabled).toBe(true);
    expect(loadConnection).not.toHaveBeenCalled();
  });
});
