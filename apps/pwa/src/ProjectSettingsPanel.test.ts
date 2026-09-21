import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProjectInbox } from "@kestrel/contracts";

import { ProjectSettingsPanel } from "./ProjectSettingsPanel.js";

const project: ProjectInbox["projects"][number] = {
  changeProposals: [],
  createdAt: "2026-09-02T12:00:00.000Z",
  id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
  localRepositorySource: {
    createdAt: "2026-09-02T12:00:00.000Z",
    displayName: "kestrel-worktree",
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
    providerId: "R_kestrel_internal",
  },
  sourceAvailability: "not_acquired",
  updatedAt: "2026-09-02T12:00:00.000Z",
};

describe("ProjectSettingsPanel", () => {
  it("shows route-owned Project facts and controls without a selector or host identity", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectSettingsPanel, {
        project,
        online: true,
        onAuthenticationError: () => false,
        onChanged: vi.fn(),
      }),
    );

    expect(html).toContain("Project settings");
    expect(html).toContain("Ic3b3rg/kestrel");
    expect(html).toContain("kestrel-worktree");
    expect(html).toContain("Attached");
    expect(html).toContain("Not acquired");
    expect(html).toContain(`href="/projects/${project.id}"`);
    expect(html).toContain("GitHub repository access");
    expect(html).toContain("Direct API profile");
    expect(html).not.toContain("Project to configure");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("GitHub CLI");
    expect(html).not.toContain(`>${project.id}<`);
    expect(html).not.toContain("R_kestrel_internal");
  });
});
