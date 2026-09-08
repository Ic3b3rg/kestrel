import { describe, expect, it } from "vitest";
import { PlanningSkillBundleSchema, SelectPlanningSkillsCommandSchema } from "./factory-skills.js";

const bundle = {
  name: "grilling",
  description: "Ask grounded requirements questions.",
  contentDigest: "a".repeat(64),
  source: { kind: "host", label: "grilling", candidateId: "b".repeat(64) },
  files: [{ path: "SKILL.md", content: "---\nname: grilling\n---\nRead the requirements." }],
};

describe("retained planning Skill contracts", () => {
  it("retains actual source and instructions while rejecting paths outside the bundle", () => {
    expect(PlanningSkillBundleSchema.parse(bundle)).toEqual(bundle);
    for (const path of [
      "../secret.md",
      "/private/secret.md",
      "reference/../../secret.md",
      "reference\\secret.md",
    ]) {
      expect(
        PlanningSkillBundleSchema.safeParse({ ...bundle, files: [{ path, content: "secret" }] })
          .success,
      ).toBe(false);
    }
  });
  it("bounds UTF-8 bytes and requires an entry point and unique retained paths", () => {
    expect(
      PlanningSkillBundleSchema.safeParse({
        ...bundle,
        files: [{ path: "SKILL.md", content: "🙂".repeat(40_000) }],
      }).success,
    ).toBe(false);
    expect(
      PlanningSkillBundleSchema.safeParse({
        ...bundle,
        files: [{ path: "reference.md", content: "No entry" }],
      }).success,
    ).toBe(false);
    expect(
      PlanningSkillBundleSchema.safeParse({ ...bundle, files: [...bundle.files, ...bundle.files] })
        .success,
    ).toBe(false);
  });
  it("requires an exact selection version and rejects duplicate Skill identities", () => {
    const command = {
      requestId: crypto.randomUUID(),
      expectedVersion: 0,
      digests: [bundle.contentDigest],
    };
    expect(SelectPlanningSkillsCommandSchema.parse(command)).toEqual(command);
    expect(
      SelectPlanningSkillsCommandSchema.safeParse({
        ...command,
        digests: [bundle.contentDigest, bundle.contentDigest],
      }).success,
    ).toBe(false);
  });
});
