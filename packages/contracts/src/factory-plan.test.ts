import { describe, expect, it } from "vitest";

import { FeaturePlanDocumentSchema, validateFeaturePlan } from "./factory-plan.js";

function item(candidate: ReturnType<typeof plan>, index = 0) {
  const value = candidate.workItems[index];
  if (value === undefined) throw new Error("Work Item fixture missing");
  return value;
}

function command(candidate: ReturnType<typeof plan>) {
  const value = item(candidate).verification[0];
  if (value === undefined) throw new Error("Verification fixture missing");
  return value;
}

function plan() {
  return {
    objective: "Save and restore a named search",
    scope: { includes: ["Saved searches"], excludes: ["Sharing searches"] },
    acceptance: [
      { key: "save", outcome: "A named search can be saved" },
      { key: "restore", outcome: "A saved search restores its filters" },
    ],
    workItems: [
      {
        key: "save-search",
        title: "Save a named search",
        description: "Save from the search view.",
        requirementKeys: ["save"],
        acceptance: ["Reload retains the saved name and filters"],
        dependsOn: [],
        verification: [
          {
            program: "node",
            args: ["--test", "tests/save.test.mjs"],
            cwd: ".",
            timeoutSeconds: 60,
          },
        ],
      },
      {
        key: "restore-search",
        title: "Restore a saved search",
        description: "Select a saved search to restore its filters.",
        requirementKeys: ["restore"],
        acceptance: ["Selecting a saved search restores its filters"],
        dependsOn: ["save-search"],
        verification: [
          {
            program: "node",
            args: ["--test", "tests/restore.test.mjs"],
            cwd: ".",
            timeoutSeconds: 60,
          },
        ],
      },
    ],
    limits: {
      maxConcurrentProjects: 2,
      maxActiveFeaturesPerProject: 1,
      attemptTimeoutSeconds: 1800,
    },
  };
}

describe("approvable Feature plans", () => {
  it("accepts an ordered plan with requirement links and concrete verification", () => {
    expect(validateFeaturePlan(FeaturePlanDocumentSchema.parse(plan()))).toEqual([]);
  });

  it("rejects duplicate requirement and Work Item keys", () => {
    const candidate = plan();
    candidate.acceptance.push({ key: "save", outcome: "Duplicated requirement" });
    item(candidate, 1).key = "save-search";
    const errors = validateFeaturePlan(FeaturePlanDocumentSchema.parse(candidate));
    expect(errors.join(" ")).toContain("Duplicate requirement key: save");
    expect(errors.join(" ")).toContain("Duplicate Work Item key: save-search");
  });

  it("rejects missing requirements and dependencies with actionable names", () => {
    const candidate = plan();
    item(candidate, 1).dependsOn = ["missing-item"];
    item(candidate, 1).requirementKeys = ["missing-outcome"];
    const errors = validateFeaturePlan(FeaturePlanDocumentSchema.parse(candidate)).join(" ");
    expect(errors).toContain("Unknown dependency missing-item");
    expect(errors).toContain("Unknown requirement missing-outcome");
    expect(errors).toContain("Requirement restore has no Work Item");
  });

  it("rejects self-dependencies, cycles and prerequisites displayed after their dependent", () => {
    const self = plan();
    item(self, 0).dependsOn = ["save-search"];
    expect(validateFeaturePlan(FeaturePlanDocumentSchema.parse(self)).join(" ")).toContain(
      "depends on itself",
    );
    const cyclic = plan();
    item(cyclic, 0).dependsOn = ["restore-search"];
    const errors = validateFeaturePlan(FeaturePlanDocumentSchema.parse(cyclic)).join(" ");
    expect(errors).toContain("Dependency cycle");
    expect(errors).toContain("must appear before");
  });

  it.each(["/tmp", "../outside", "src/../../outside", "C:\\outside", "src\\..\\outside"])(
    "rejects verification outside a relative Project directory: %s",
    (cwd) => {
      const candidate = plan();
      command(candidate).cwd = cwd;
      expect(validateFeaturePlan(FeaturePlanDocumentSchema.parse(candidate)).join(" ")).toContain(
        "relative Project directory",
      );
    },
  );

  it("rejects verification exceeding the approved attempt budget", () => {
    const candidate = plan();
    command(candidate).timeoutSeconds = 1801;
    expect(validateFeaturePlan(FeaturePlanDocumentSchema.parse(candidate)).join(" ")).toContain(
      "exceeds the attempt limit",
    );
  });

  it("rejects empty acceptance and unsupported verification options", () => {
    const empty = plan();
    item(empty, 0).acceptance = [];
    expect(FeaturePlanDocumentSchema.safeParse(empty).success).toBe(false);
    const unsupported = plan();
    const unsupportedCommand = command(unsupported);
    Object.assign(unsupportedCommand, { environment: { SECRET: "not-supported" } });
    expect(FeaturePlanDocumentSchema.safeParse(unsupported).success).toBe(false);
  });

  it("rejects a plan whose combined detail exceeds the inspectable artifact budget", () => {
    const candidate = plan();
    candidate.scope.includes = Array.from({ length: 20 }, () => "x".repeat(2000));
    candidate.scope.excludes = Array.from({ length: 20 }, () => "x".repeat(2000));
    candidate.acceptance = Array.from({ length: 40 }, (_, index) => ({
      key: `r${String(index)}`,
      outcome: "x".repeat(2000),
    }));
    expect(validateFeaturePlan(FeaturePlanDocumentSchema.parse(candidate)).join(" ")).toContain(
      "Plan exceeds the detail limit",
    );
  });
});
