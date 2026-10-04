import { expect, it } from "vitest";
import { readBundledPlanningSkills } from "./factory-bundled-skills.js";
import { GitHubPlanningSkillBundleSchema } from "@kestrel/contracts";
import { createHash } from "node:crypto";

it("ships both usable planning collections with immutable upstream sources and declared limits", async () => {
  const bundles = await readBundledPlanningSkills();
  expect(bundles.map((bundle) => bundle.name)).toEqual(["grill-with-docs", "brainstorming"]);
  for (const bundle of bundles) {
    expect(GitHubPlanningSkillBundleSchema.safeParse(bundle).success).toBe(true);
    expect(createHash("sha256").update(JSON.stringify(bundle.files)).digest("hex")).toBe(
      bundle.contentDigest,
    );
    expect(bundle.files.some((file) => file.path === "sources/LICENSE")).toBe(true);
    expect(bundle.files.find((file) => file.path === "SKILL.md")?.content).toContain("read-only");
  }
  expect(bundles[0]?.files.some((file) => file.path.endsWith("grilling/SKILL.md"))).toBe(true);
  expect(bundles[1]?.files.some((file) => file.path.endsWith("writing-plans/SKILL.md"))).toBe(true);
});
