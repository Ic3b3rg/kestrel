// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostGitHubConnection, ProjectInbox } from "@kestrel/contracts";

import {
  HostGitHubConnectionPanel,
  ProjectGitHubAccessPanel,
  type HostGitHubConnectionPanelProps,
  type ProjectGitHubAccessPanelProps,
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
  repository: {
    canonicalUrl: "https://github.com/Ic3b3rg/kestrel",
    name: "kestrel",
    owner: "Ic3b3rg",
    providerId: "R_kestrel",
  },
  sourceAvailability: "not_acquired",
  updatedAt: "2026-09-02T12:00:00.000Z",
};
const globalReady: HostGitHubConnection = {
  schemaVersion: 1,
  state: "ready",
  reason: null,
  cli: { version: "2.87.0", supported: true },
  identity: { host: "github.com", account: "operator" },
  projectAccess: null,
  checkedAt: "2026-09-02T12:00:00.000Z",
};
const projectReady: HostGitHubConnection = {
  ...globalReady,
  projectAccess: {
    state: "verified",
    projectId,
    repository: { owner: "Ic3b3rg", name: "kestrel" },
  },
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

describe("GitHub connection Settings", () => {
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

  async function renderGlobal(overrides: Partial<HostGitHubConnectionPanelProps>): Promise<void> {
    await act(async () => {
      root.render(createElement(HostGitHubConnectionPanel, { online: true, ...overrides }));
      await Promise.resolve();
    });
  }

  async function renderProject(overrides: Partial<ProjectGitHubAccessPanelProps>): Promise<void> {
    await act(async () => {
      root.render(createElement(ProjectGitHubAccessPanel, { online: true, project, ...overrides }));
      await Promise.resolve();
    });
  }

  it("keeps CLI and account facts in global Source control without a Project selector", async () => {
    const loadConnection = vi.fn().mockResolvedValue(globalReady);
    await renderGlobal({ loadConnection });

    expect(loadConnection).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
    expect(container.textContent).toContain("GitHub on this workstation");
    expect(container.textContent).toContain("2.87.0");
    expect(container.textContent).toContain("github.com");
    expect(container.textContent).toContain("operator");
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).not.toContain("Ic3b3rg/kestrel");
  });

  it("shows an honest global Unavailable state while offline without probing", async () => {
    const loadConnection = vi.fn<NonNullable<HostGitHubConnectionPanelProps["loadConnection"]>>();
    await renderGlobal({ loadConnection, online: false });

    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Reconnect this workstation");
    expect(container.textContent).toContain("Not checked while offline");
    expect(findButton(container, "Verify again").disabled).toBe(true);
    expect(loadConnection).not.toHaveBeenCalled();
  });

  it("shows only repository-specific access facts in Project settings", async () => {
    const loadConnection = vi.fn().mockResolvedValue(projectReady);
    await renderProject({ loadConnection });

    expect(loadConnection).toHaveBeenCalledWith(projectId, expect.any(AbortSignal));
    expect(container.textContent).toContain("GitHub repository access");
    expect(container.textContent).toContain("Verified");
    expect(container.textContent).toContain("Ic3b3rg/kestrel");
    expect(container.textContent).not.toContain("2.87.0");
    expect(container.textContent).not.toContain("operator");
    expect(container.querySelector("select")).toBeNull();
  });

  it("keeps Project access failures local and actionable", async () => {
    const loadConnection = vi
      .fn<NonNullable<ProjectGitHubAccessPanelProps["loadConnection"]>>()
      .mockResolvedValueOnce(projectReady)
      .mockResolvedValueOnce(authenticationRequired);
    await renderProject({ loadConnection });
    await act(async () => {
      findButton(container, "Verify again").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Action required");
    expect(container.textContent).toContain("gh auth login --hostname github.com");
    expect(container.textContent).toContain("Open global Source control settings");
    expect(container.textContent).not.toContain("operator");
  });
});
