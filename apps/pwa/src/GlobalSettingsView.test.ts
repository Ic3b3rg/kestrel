import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProjectInbox } from "@kestrel/contracts";

import { GlobalSettingsView, SettingsProjectLinks } from "./GlobalSettingsView.js";

const project: ProjectInbox["projects"][number] = {
  changeProposals: [],
  createdAt: "2026-09-02T12:00:00.000Z",
  id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
  localRepositorySource: null,
  modelAccess: "not_configured",
  providerObservation: null,
  repository: {
    canonicalUrl: "https://github.com/example/reports",
    name: "reports",
    owner: "example",
    providerId: "R_reports",
  },
  sourceAvailability: "not_acquired",
  updatedAt: "2026-09-02T12:00:00.000Z",
};

describe("GlobalSettingsView", () => {
  it("renders one URL-owned section with native links and a clear active state", () => {
    const html = renderToStaticMarkup(
      createElement(
        GlobalSettingsView,
        { section: "providers", onNavigate: vi.fn() },
        createElement("p", null, "Provider controls"),
      ),
    );

    expect(html).toContain("<h1");
    expect(html).toContain("Providers");
    expect(html).toContain("Provider controls");
    expect(html).toContain('href="/settings/profile"');
    expect(html).toContain('href="/settings/projects"');
    expect(html).toContain('href="/settings/providers" aria-current="page"');
    expect(html).toContain('href="/settings/source-control"');
    expect(html).toContain('href="/settings/skills"');
    expect(html).not.toContain("Durable identity");
    expect(html).not.toContain("Run diagnostic");
  });
});

describe("SettingsProjectLinks", () => {
  it("links every Project to its own Settings route without a chooser", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsProjectLinks, {
        error: null,
        loading: false,
        online: true,
        projects: [project],
        onNavigate: vi.fn(),
        onRetry: vi.fn(),
      }),
    );

    expect(html).toContain("Project settings");
    expect(html).toContain("example/reports");
    expect(html).toContain(`href="/projects/${project.id}/settings"`);
    expect(html).not.toContain("<select");
  });

  it("shows a refresh failure while retaining previously loaded Project links", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsProjectLinks, {
        error: "The Project inventory could not be refreshed.",
        loading: false,
        online: true,
        projects: [project],
        onNavigate: vi.fn(),
        onRetry: vi.fn(),
      }),
    );

    expect(html).toContain("The Project inventory could not be refreshed.");
    expect(html).toContain("Retry Projects");
    expect(html).toContain(`href="/projects/${project.id}/settings"`);
  });
});
