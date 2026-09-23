import { describe, expect, it } from "vitest";

import { appPath, readAppRoute } from "./app-route.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";

describe("authenticated app routing", () => {
  it("restores a blank planning request without inventing a Feature", () => {
    const requestId = "fe68a0da-b3bf-4a88-8e53-28a6af91897d";
    const route = { kind: "planning" as const, projectId, requestId };
    expect(readAppRoute(`/projects/${projectId}/planning/${requestId}`)).toEqual(route);
    expect(appPath(route)).toBe(`/projects/${projectId}/planning/${requestId}`);
    expect(readAppRoute(`/projects/${projectId}/planning/not-a-request`)).toEqual({
      kind: "not_found",
    });
  });
  it("keeps pull requests as an explicit secondary Project view", () => {
    const route = { kind: "project" as const, projectId, view: "pull_requests" as const };
    expect(readAppRoute(`/projects/${projectId}`, "?view=pull_requests")).toEqual(route);
    expect(appPath(route)).toBe(`/projects/${projectId}?view=pull_requests`);
  });
  it.each(["plan", "board", "review"] as const)("restores the %s view of a feature", (view) => {
    const featureId = "018f0f89-9192-755f-aa96-f72094c734df";
    const path = `/projects/${projectId}/features/${featureId}`;
    const route = { kind: "feature" as const, projectId, featureId, view };
    expect(readAppRoute(path, `?view=${view}`)).toEqual(route);
    expect(appPath(route)).toBe(`${path}?view=${view}`);
  });
  it("keeps the selected immutable review artifact in the feature URL", () => {
    const featureId = "018f0f89-9192-755f-aa96-f72094c734df";
    const artifactId = "018f0f89-9a21-7271-b92d-f1cb0d48bb47";
    const path = `/projects/${projectId}/features/${featureId}`;
    const route = {
      kind: "feature" as const,
      projectId,
      featureId,
      view: "review" as const,
      artifactId,
    };
    expect(readAppRoute(path, `?view=review&artifactId=${artifactId}`)).toEqual(route);
    expect(appPath(route)).toBe(`${path}?view=review&artifactId=${artifactId}`);
    expect(readAppRoute(path, "?view=review&artifactId=not-an-artifact")).toEqual({
      kind: "not_found",
    });
  });
  it("restores a feature chat within its Project and rejects malformed chat identities", () => {
    const featureId = "018f0f89-9192-755f-aa96-f72094c734df";
    const route = { kind: "feature" as const, projectId, featureId };
    expect(readAppRoute(`/projects/${projectId}/features/${featureId}`)).toEqual(route);
    expect(appPath(route)).toBe(`/projects/${projectId}/features/${featureId}`);
    expect(readAppRoute(`/projects/${projectId}/features/not-a-feature`)).toEqual({
      kind: "not_found",
    });
  });
  it("keeps the selected Project in the authoritative URL", () => {
    expect(appPath({ kind: "project", projectId })).toBe(`/projects/${projectId}`);
    expect(readAppRoute(`/projects/${projectId}`)).toEqual({ kind: "project", projectId });
  });

  it("restores an explicitly selected change after Project reload", () => {
    const proposalId = "018f0f89-9192-755f-aa96-f72094c734df";
    const route = { kind: "project" as const, projectId, proposalId };
    expect(appPath(route)).toBe(`/projects/${projectId}?proposalId=${proposalId}`);
    expect(readAppRoute(`/projects/${projectId}`, `?proposalId=${proposalId}`)).toEqual(route);
  });

  it("keeps an explicitly retained Review Revision in the authoritative URL", () => {
    const proposalId = "018f0f89-9192-755f-aa96-f72094c734df";
    const revisionId = "018f0f89-9a21-7271-b92d-f1cb0d48bb47";
    const route = { kind: "project" as const, projectId, proposalId, revisionId };
    expect(appPath(route)).toBe(
      `/projects/${projectId}?proposalId=${proposalId}&revisionId=${revisionId}`,
    );
    expect(
      readAppRoute(`/projects/${projectId}`, `?proposalId=${proposalId}&revisionId=${revisionId}`),
    ).toEqual(route);
    expect(
      readAppRoute(`/projects/${projectId}`, `?proposalId=${proposalId}&revisionId=not-a-revision`),
    ).toEqual({ kind: "not_found" });
    expect(readAppRoute(`/projects/${projectId}`, `?revisionId=${revisionId}`)).toEqual({
      kind: "not_found",
    });
  });

  it("keeps Project-owned Settings in a route-owned canonical URL", () => {
    const route = { kind: "project_settings" as const, projectId };
    expect(appPath(route)).toBe(`/projects/${projectId}/settings`);
    expect(readAppRoute(`/projects/${projectId}/settings`)).toEqual(route);
    expect(readAppRoute("/settings", `?projectId=${projectId}`)).toEqual(route);
  });

  it("keeps every global Settings section in a canonical path", () => {
    expect(readAppRoute("/settings")).toEqual({ kind: "settings", section: "profile" });
    expect(readAppRoute("/settings", "", "#review-model-title")).toEqual({
      kind: "settings",
      section: "providers",
    });
    expect(readAppRoute("/settings", "", "#github-connection-title")).toEqual({
      kind: "settings",
      section: "source-control",
    });
    for (const section of [
      "profile",
      "projects",
      "providers",
      "source-control",
      "skills",
    ] as const) {
      const route = { kind: "settings" as const, section };
      expect(readAppRoute(`/settings/${section}`)).toEqual(route);
      expect(appPath(route)).toBe(`/settings/${section}`);
    }
    expect(readAppRoute("/settings/other")).toEqual({ kind: "not_found" });
  });

  it("keeps the Project landing as a stable route", () => {
    expect(readAppRoute("/")).toEqual({ kind: "projects" });
  });

  it("reports malformed or unknown deep links without inventing a selection", () => {
    expect(readAppRoute("/projects/not-a-project")).toEqual({ kind: "not_found" });
    expect(readAppRoute("/unknown")).toEqual({ kind: "not_found" });
  });
});
