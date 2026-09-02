import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProjectInbox } from "@kestrel/contracts";

import { AuthenticatedShell, projectLabel } from "./AuthenticatedShell.js";

const localProject: ProjectInbox["projects"][number] = {
  changeProposals: [],
  createdAt: "2026-08-24T12:00:00.000Z",
  id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
  localRepositorySource: {
    createdAt: "2026-08-24T12:00:00.000Z",
    displayName: "kestrel",
    id: "018f0f89-9a1d-7484-b224-866ef9d69990",
    objectFormat: "sha1",
    repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
    state: "attached",
    updatedAt: "2026-08-24T12:00:00.000Z",
  },
  modelAccess: "not_configured",
  providerObservation: null,
  repository: null,
  sourceAvailability: "not_acquired",
  updatedAt: "2026-08-24T12:00:00.000Z",
};

const providerProject: ProjectInbox["projects"][number] = {
  ...localProject,
  id: "018f0f89-949a-75a8-8f61-6df78a843b1f",
  localRepositorySource: null,
  providerObservation: { authentication: "none", kind: "public_github", refresh: "manual" },
  repository: {
    canonicalUrl: "https://github.com/openai/openai-node",
    name: "openai-node",
    owner: "openai",
    providerId: "R_kgDOGx",
  },
};

function render(overrides: Partial<Parameters<typeof AuthenticatedShell>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(
      AuthenticatedShell,
      {
        announcement: "Projects synchronized.",
        connection: "connected",
        error: null,
        inbox: { schemaVersion: 1, projects: [localProject, providerProject] },
        loading: false,
        online: true,
        openProjectControl: createElement("button", null, "Open Project"),
        operatorUsername: "operator",
        route: { kind: "project", projectId: localProject.id },
        onNavigate: vi.fn(),
        onRetry: vi.fn(),
        ...overrides,
      },
      createElement("h1", null, "Workspace"),
    ),
  );
}

describe("AuthenticatedShell", () => {
  it("renders durable Projects as native navigation and keeps Settings reachable", () => {
    const html = render();

    expect(projectLabel(localProject)).toBe("kestrel");
    expect(projectLabel(providerProject)).toBe("openai/openai-node");
    expect(html).toContain(`href="/projects/${localProject.id}"`);
    expect(html).toContain(`href="/projects/${providerProject.id}"`);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="/settings"');
    expect(html).toContain("Settings");
    expect(html).toContain('href="#workspace"');
  });

  it("shows honest loading, empty, and error rail states", () => {
    expect(render({ inbox: null, loading: true })).toContain("Reading Projects");
    expect(render({ inbox: { schemaVersion: 1, projects: [] } })).toContain("No Projects yet");
    const failed = render({ error: "Project storage unavailable", inbox: null });
    expect(failed).toContain("Project storage unavailable");
    expect(failed).toContain("Retry Projects");
  });

  it("marks Settings as the current native link", () => {
    const html = render({ route: { kind: "settings" } });
    expect(html).toContain('href="/settings" aria-current="page"');
  });
});
