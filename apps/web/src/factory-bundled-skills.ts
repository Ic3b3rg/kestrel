import { readFile } from "node:fs/promises";
import { GitHubPlanningSkillBundleSchema } from "@kestrel/contracts";

export async function readBundledPlanningSkills() {
  return Promise.all(
    ["matt-pocock", "superpowers"].map(async (name) =>
      GitHubPlanningSkillBundleSchema.parse(
        JSON.parse(
          await readFile(new URL(`../bundled-skills/${name}.json`, import.meta.url), "utf8"),
        ),
      ),
    ),
  );
}
