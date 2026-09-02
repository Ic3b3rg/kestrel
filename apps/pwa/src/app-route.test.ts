import { describe, expect, it } from "vitest";

import { appPath, readAppRoute } from "./app-route.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";

describe("authenticated app routing", () => {
  it("keeps the selected Project in the authoritative URL", () => {
    expect(appPath({ kind: "project", projectId })).toBe(`/projects/${projectId}`);
    expect(readAppRoute(`/projects/${projectId}`)).toEqual({ kind: "project", projectId });
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
