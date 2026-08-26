import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProjectInbox } from "@kestrel/contracts";

import { ProjectInboxPanel } from "./ProjectInboxPanel.js";

const populatedInbox: ProjectInbox = {
  schemaVersion: 1,
  projects: [
    {
      changeProposals: [
        {
          author: { login: "octocat", providerId: "U_kgDOA" },
          base: { objectId: "a".repeat(40), ref: "main" },
          canonicalUrl: "https://github.com/openai/openai-node/pull/1234",
          head: { objectId: "b".repeat(40), ref: "provider-observation" },
          id: "018f0f89-9192-755f-aa96-f72094c734dd",
          number: 1234,
          observedAt: "2026-08-24T12:01:00.000Z",
          proposalState: "open",
          providerId: "PR_kwDOGx",
          title: "Keep repository access explicit",
        },
      ],
      createdAt: "2026-08-24T12:00:00.000Z",
      id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
      modelAccess: "not_configured",
      providerObservation: {
        authentication: "none",
        kind: "public_github",
        refresh: "manual",
      },
      repository: {
        canonicalUrl: "https://github.com/openai/openai-node",
        name: "openai-node",
        owner: "openai",
        providerId: "R_kgDOGx",
      },
      sourceAvailability: "not_acquired",
      updatedAt: "2026-08-24T12:01:00.000Z",
    },
  ],
};

function render(inbox: ProjectInbox | null): string {
  return renderToStaticMarkup(
    createElement(ProjectInboxPanel, {
      error: null,
      inbox,
      loading: false,
      online: true,
      pending: false,
      onOpen: vi.fn(),
      onRetry: vi.fn(),
    }),
  );
}

describe("ProjectInboxPanel", () => {
  it("explains the credential-free public GitHub path when the inbox is empty", () => {
    const html = render({ schemaVersion: 1, projects: [] });

    expect(html).toContain("Public GitHub pull request URL");
    expect(html).toContain("No GitHub credentials are sent or stored");
    expect(html).toContain("No Projects yet");
    expect(html).toContain("60 unauthenticated GitHub API requests per hour");
  });

  it("renders Provider Observation, source, and model access as separate facts", () => {
    const html = render(populatedInbox);

    expect(html).toContain("openai/openai-node");
    expect(html).toContain("#1234 · Keep repository access explicit");
    expect(html).toContain("Source");
    expect(html).toContain("Not acquired");
    expect(html).toContain("Provider observation");
    expect(html).toContain("Public GitHub pull request");
    expect(html).toContain("Refresh");
    expect(html).toContain("Manual only");
    expect(html).not.toContain("Synchronization");
    expect(html).toContain("Model access");
    expect(html).toContain("Not configured");
    expect(html).toContain("Base commit");
    expect(html).toContain("Head commit");
    expect(html).not.toContain("Base revision");
    expect(html).toContain("Refresh PR #1234");
  });
});
