// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostGitHubProjectInbox, ProjectUpserted } from "@kestrel/contracts";

import {
  HostGitHubProjectPanel,
  type HostGitHubProjectPanelProps,
} from "./HostGitHubProjectPanel.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const project: ProjectUpserted["project"] = {
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
  providerObservation: {
    account: "operator",
    authentication: "host_session",
    host: "github.com",
    kind: "host_gh",
    refresh: "manual",
  },
  repository: {
    canonicalUrl: "https://github.com/Ic3b3rg/kestrel",
    name: "kestrel",
    owner: "Ic3b3rg",
    providerId: "R_test",
  },
  sourceAvailability: "not_acquired",
  updatedAt: "2026-09-02T12:00:00.000Z",
};

const readyInbox: HostGitHubProjectInbox = {
  schemaVersion: 1,
  projectId,
  route: "host_gh",
  limitations: ["Manual refresh only"],
  status: {
    executableVersion: "2.87.0",
    availability: "available",
    host: "github.com",
    authentication: "authenticated",
    account: "operator",
  },
  groupStates: [
    { group: "review_requested", state: "available", failureReason: null },
    { group: "authored", state: "available", failureReason: null },
    { group: "other", state: "available", failureReason: null },
  ],
  pullRequests: [
    {
      author: "reviewer",
      body: "Please review the bounded provider read.",
      group: "review_requested",
      number: 2,
      title: "Keep host credentials outside Kestrel",
      updatedAt: "2026-09-02T12:00:00.000Z",
      url: "https://github.com/Ic3b3rg/kestrel/pull/2",
    },
  ],
  observedAt: "2026-09-02T12:01:00.000Z",
};

const partialInbox: HostGitHubProjectInbox = {
  ...readyInbox,
  groupStates: [
    { group: "review_requested", state: "available", failureReason: null },
    { group: "authored", state: "unavailable", failureReason: "rate_limited" },
    { group: "other", state: "unavailable", failureReason: "rate_limited" },
  ],
};

const authenticationRequiredInbox: HostGitHubProjectInbox = {
  ...readyInbox,
  status: {
    ...readyInbox.status,
    authentication: "needs_authentication",
    account: null,
  },
  groupStates: [
    {
      group: "review_requested",
      state: "unavailable",
      failureReason: "authentication_required",
    },
    { group: "authored", state: "unavailable", failureReason: "authentication_required" },
    { group: "other", state: "unavailable", failureReason: "authentication_required" },
  ],
  pullRequests: [],
};

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent.includes(text),
  );
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  return button;
}

function findGroup(container: HTMLElement, heading: string): HTMLElement {
  const title = [...container.querySelectorAll("h5")].find(
    (candidate) => candidate.textContent === heading,
  );
  const group = title?.closest("section");
  if (!(group instanceof HTMLElement)) throw new Error(`Group not found: ${heading}`);
  return group;
}

describe("host GitHub Project pull-request inbox", () => {
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

  async function renderPanel(overrides: Partial<HostGitHubProjectPanelProps>): Promise<void> {
    await act(async () => {
      root.render(
        createElement(HostGitHubProjectPanel, {
          disabled: false,
          online: true,
          onObserved: vi.fn(),
          projectId,
          ...overrides,
        }),
      );
      await Promise.resolve();
    });
  }

  it("shows ordered loading states and preserves successful groups on a partial rate limit", async () => {
    let release: (value: HostGitHubProjectInbox) => void = () => undefined;
    const pending = new Promise<HostGitHubProjectInbox>((resolve) => {
      release = resolve;
    });
    const loadInbox = vi
      .fn<NonNullable<HostGitHubProjectPanelProps["loadInbox"]>>()
      .mockReturnValue(pending);
    await renderPanel({ loadInbox });

    expect([...container.querySelectorAll("h5")].map((heading) => heading.textContent)).toEqual([
      "Review requested",
      "Authored",
      "Others",
    ]);
    expect(container.textContent).toContain("Loading Review requested");
    expect(container.textContent).toContain("Loading Authored");
    expect(container.textContent).toContain("Loading Others");
    expect(loadInbox).toHaveBeenCalledWith(projectId, false, expect.any(AbortSignal));

    await act(async () => {
      release(partialInbox);
      await pending;
    });

    expect(findGroup(container, "Review requested").textContent).toContain(
      "#2Keep host credentials outside Kestrel",
    );
    expect(findGroup(container, "Authored").textContent).toContain("GitHub rate limit reached");
    expect(findGroup(container, "Others").textContent).toContain("GitHub rate limit reached");
    expect(container.textContent).toContain("operator@github.com");
  });

  it("shows empty groups and revalidates authentication on manual refresh", async () => {
    const loadInbox = vi
      .fn<NonNullable<HostGitHubProjectPanelProps["loadInbox"]>>()
      .mockResolvedValueOnce({ ...readyInbox, pullRequests: [] })
      .mockResolvedValueOnce(authenticationRequiredInbox);
    await renderPanel({ loadInbox });

    expect([...container.querySelectorAll(".host-github-group-empty")]).toHaveLength(3);
    await act(async () => {
      findButton(container, "Refresh pull requests").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadInbox).toHaveBeenNthCalledWith(2, projectId, true, expect.any(AbortSignal));
    expect(container.textContent).toContain("Authentication required");
    expect(container.textContent).toContain("gh auth login --hostname github.com");
    expect(container.textContent).not.toContain("operator@github.com");
  });

  it("selects one pull request using only its number and applies the returned Project", async () => {
    const loadInbox = vi
      .fn<NonNullable<HostGitHubProjectPanelProps["loadInbox"]>>()
      .mockResolvedValue(readyInbox);
    const observePullRequest = vi
      .fn<NonNullable<HostGitHubProjectPanelProps["observePullRequest"]>>()
      .mockResolvedValue({ schemaVersion: 1, project });
    const onObserved = vi.fn<HostGitHubProjectPanelProps["onObserved"]>();
    await renderPanel({ loadInbox, observePullRequest, onObserved });

    await act(async () => {
      findButton(container, "Select PR #2").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(observePullRequest).toHaveBeenCalledWith(
      projectId,
      { number: 2 },
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(observePullRequest.mock.calls[0])).not.toContain("Ic3b3rg/kestrel");
    expect(onObserved).toHaveBeenCalledWith(project);
  });

  it("does not query or expose stale Project results while offline", async () => {
    const loadInbox = vi.fn<NonNullable<HostGitHubProjectPanelProps["loadInbox"]>>();
    await renderPanel({ loadInbox, online: false });

    expect(loadInbox).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Reconnect this workstation");
    expect(container.textContent).not.toContain("#2");
    expect(findButton(container, "Refresh pull requests").disabled).toBe(true);
  });

  it("does not turn an unrelated parent render into a provider refresh", async () => {
    const loadInbox = vi
      .fn<NonNullable<HostGitHubProjectPanelProps["loadInbox"]>>()
      .mockResolvedValue(readyInbox);
    await renderPanel({ loadInbox, onAuthenticationError: vi.fn() });

    await renderPanel({ loadInbox, onAuthenticationError: vi.fn() });

    expect(loadInbox).toHaveBeenCalledTimes(1);
  });
});
