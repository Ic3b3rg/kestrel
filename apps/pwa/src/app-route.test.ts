import { describe, expect, it } from "vitest";

import { appPath, readAppRoute } from "./app-route.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";

describe("authenticated app routing", () => {
  it.each(["plan", "board"] as const)("restores the %s view of a feature", (view) => {
    const featureId = "018f0f89-9192-755f-aa96-f72094c734df";
    const path = `/projects/${projectId}/features/${featureId}`;
    const route = { kind: "feature" as const, projectId, featureId, view };
    expect(readAppRoute(path, `?view=${view}`)).toEqual(route);
    expect(appPath(route)).toBe(`${path}?view=${view}`);
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

  it("keeps Project-owned Settings aligned with the URL", () => {
    const route = { kind: "settings" as const, projectId };
    expect(appPath(route)).toBe(`/settings?projectId=${projectId}`);
    expect(readAppRoute("/settings", `?projectId=${projectId}`)).toEqual(route);
  });

  it("keeps Settings and the Project landing as stable routes", () => {
    expect(readAppRoute("/")).toEqual({ kind: "projects" });
    expect(readAppRoute("/settings")).toEqual({ kind: "settings" });
  });

  it("reports malformed or unknown deep links without inventing a selection", () => {
    expect(readAppRoute("/projects/not-a-project")).toEqual({ kind: "not_found" });
    expect(readAppRoute("/unknown")).toEqual({ kind: "not_found" });
  });
});
