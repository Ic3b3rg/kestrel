import { expect, it } from "vitest";
import {
  assertLifecycleProfileAvailable,
  resolveLifecycleProfile,
  defaultLifecycleSettings,
} from "./lifecycle-profile.js";

const catalog = [
  {
    id: "example",
    model: "wire-example",
    displayName: "Example",
    isDefault: true,
    defaultReasoningEffort: "balanced",
    supportedReasoningEfforts: [
      { reasoningEffort: "balanced", description: "Balanced" },
      { reasoningEffort: "deep", description: "Deeper" },
    ],
    serviceTiers: [{ id: "accelerated", name: "Fast", description: "Fast processing" }],
    defaultServiceTier: "accelerated",
  },
];
it("retains frozen defaults while blocking removed capabilities", () => {
  const selected = catalog[0];
  if (selected === undefined) throw new Error("Missing model fixture");
  const profile = resolveLifecycleProfile(defaultLifecycleSettings, {}, catalog);
  expect(() =>
    assertLifecycleProfileAvailable(profile, [
      { ...selected, defaultReasoningEffort: "deep", defaultServiceTier: null },
    ]),
  ).not.toThrow();
  expect(() =>
    assertLifecycleProfileAvailable(profile, [
      { ...selected, supportedReasoningEfforts: [], defaultReasoningEffort: "deep" },
    ]),
  ).toThrow("effort");
  expect(() =>
    assertLifecycleProfileAvailable(profile, [{ ...selected, serviceTiers: [] }]),
  ).toThrow("speed");
});
it("resolves each inherited field and keeps standard speed distinct from the runtime default", () => {
  const defaults = {
    ...defaultLifecycleSettings,
    effort: { kind: "explicit" as const, value: "deep" },
  };
  const inherited = resolveLifecycleProfile(defaults, {}, catalog);
  expect(inherited.model).toBe("wire-example");
  expect(inherited.effort).toBe("deep");
  expect(inherited.serviceTier).toBe("accelerated");
  const standard = resolveLifecycleProfile(defaults, { speed: { kind: "standard" } }, catalog);
  expect(standard.serviceTier).toBe("default");
  expect(standard.inherited).toEqual(["runtimeId", "model", "effort", "skillDigests"]);
});
it("blocks explicit stale choices instead of falling back", () => {
  expect(() =>
    resolveLifecycleProfile(
      defaultLifecycleSettings,
      { model: { kind: "explicit", value: "removed" } },
      catalog,
    ),
  ).toThrow("model");
  expect(() =>
    resolveLifecycleProfile(
      defaultLifecycleSettings,
      { effort: { kind: "explicit", value: "removed" } },
      catalog,
    ),
  ).toThrow("effort");
  expect(() =>
    resolveLifecycleProfile(
      defaultLifecycleSettings,
      { speed: { kind: "explicit", value: "removed" } },
      catalog,
    ),
  ).toThrow("speed");
});
