import { describe, expect, it } from "vitest";
import {
  InstallGitHubPlanningSkillCommandSchema,
  PlanningSkillBundleSchema,
  PreviewGitHubPlanningSkillCommandSchema,
  SelectPlanningSkillsCommandSchema,
} from "./factory-skills.js";

const bundle = {
  name: "grilling",
  description: "Ask grounded requirements questions.",
  contentDigest: "a".repeat(64),
  source: { kind: "host", label: "grilling", candidateId: "b".repeat(64) },
  files: [{ path: "SKILL.md", content: "---\nname: grilling\n---\nRead the requirements." }],
};

describe("retained planning Skill contracts", () => {
  it("retains a GitHub source's exact resolved commit and requested ref", () => {
    const github = {
      ...bundle,
      source: {
        kind: "github",
        label: "mattpocock/skills:grilling/SKILL.md",
        candidateId: "b".repeat(64),
        owner: "mattpocock",
        repository: "skills",
        path: "grilling/SKILL.md",
        requestedRef: "main",
        commitId: "c".repeat(40),
      },
    };
    expect(PlanningSkillBundleSchema.safeParse(github).success).toBe(true);
    expect(PlanningSkillBundleSchema.parse(github)).toEqual(github);
    expect(
      PlanningSkillBundleSchema.safeParse({
        ...github,
        source: { ...github.source, commitId: "main" },
      }).success,
    ).toBe(false);
  });
  it("accepts only an explicit starter or GitHub entry and installs by reviewed digest", () => {
    const starter = { kind: "starter", starter: "grilling-starter" };
    const source = {
      kind: "github",
      owner: "mattpocock",
      repository: "skills",
      path: "grilling/SKILL.md",
      ref: "release/v1",
    };
    expect(PreviewGitHubPlanningSkillCommandSchema.parse(starter)).toEqual(starter);
    expect(PreviewGitHubPlanningSkillCommandSchema.parse(source)).toEqual(source);
    for (const invalid of [
      { ...starter, ref: "main" },
      { ...source, starter: "grilling-starter" },
      { ...source, path: "C:\\skills\\SKILL.md" },
      { ...source, path: "nested/../SKILL.md" },
      { ...source, ref: " main " },
      { ...source, ref: "main\nother" },
      { ...source, path: "file.md" },
      { ...source, repository: ".." },
    ])
      expect(PreviewGitHubPlanningSkillCommandSchema.safeParse(invalid).success).toBe(false);
    const command = { requestId: crypto.randomUUID(), digest: bundle.contentDigest };
    expect(InstallGitHubPlanningSkillCommandSchema.parse(command)).toEqual(command);
    expect(
      InstallGitHubPlanningSkillCommandSchema.safeParse({ ...command, ref: "main" }).success,
    ).toBe(false);
  });
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
