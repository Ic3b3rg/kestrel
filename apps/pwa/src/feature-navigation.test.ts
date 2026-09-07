// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { readFeatureNavigation, saveFeatureNavigation } from "./feature-navigation.js";
const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const featureId = "018f0f89-9192-755f-aa96-f72094c734df";

afterEach(() => sessionStorage.clear());

describe("feature navigation preferences", () => {
  it("restores opaque identities and clears them independently of unrelated browser data", () => {
    sessionStorage.setItem("unrelated", "kept");
    saveFeatureNavigation({ [projectId]: featureId });
    expect(readFeatureNavigation()).toEqual({ [projectId]: featureId });
    saveFeatureNavigation({});
    expect(readFeatureNavigation()).toEqual({});
    expect(sessionStorage.getItem("unrelated")).toBe("kept");
  });
  it("ignores malformed saved navigation instead of inventing a route", () => {
    sessionStorage.setItem(
      "kestrel.feature-navigation",
      JSON.stringify({ [projectId]: "not-a-feature", transcript: "not navigation" }),
    );
    expect(readFeatureNavigation()).toEqual({});
  });
});
