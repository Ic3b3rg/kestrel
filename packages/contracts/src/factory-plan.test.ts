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
  const proposal = {
    key: "search-language",
    kind: "glossary" as const,
    path: "CONTEXT.md",
    pathIsProvisional: false,
    markdown: "# Language\n\n**Saved search**: A named set of filters.\n",
    workItemKey: "save-search",
  };

  it("retains exact proposed Markdown with an owning Work Item without changing old plans", () => {
    const legacy = FeaturePlanDocumentSchema.parse(plan());
    expect(legacy).not.toHaveProperty("proposedDocuments");
    const document = FeaturePlanDocumentSchema.parse({ ...plan(), proposedDocuments: [proposal] });
    expect(document.proposedDocuments).toEqual([proposal]);
    expect(validateFeaturePlan(document)).toEqual([]);
  });

  it.each([
    "/tmp/CONTEXT.md",
    "../CONTEXT.md",
    "docs/../CONTEXT.md",
    "docs//a.md",
    "./CONTEXT.md",
    "C:/CONTEXT.md",
    "docs\\a.md",
    "docs/a\0.md",
    "docs/a\n.md",
    ".git/notes.md",
    ".kestrel/plan.md",
    "docs/.git/notes.md",
    "docs/a.txt",
    "https://example.com/a.md",
  ])("rejects proposed Markdown outside safe Project paths: %s", (path) => {
    const result = FeaturePlanDocumentSchema.safeParse({
      ...plan(),
      proposedDocuments: [{ ...proposal, path }],
    });
    expect(result.success && validateFeaturePlan(result.data).length === 0).toBe(false);
  });

  it("rejects repeated document identities and unknown owning Work Items", () => {
    const document = FeaturePlanDocumentSchema.parse({
      ...plan(),
      proposedDocuments: [proposal, { ...proposal, workItemKey: "missing-item" }],
    });
    const errors = validateFeaturePlan(document).join(" ");
    expect(errors).toContain("Duplicate proposed document key");
    expect(errors).toContain("Duplicate proposed document path");
    expect(errors).toContain("Unknown Work Item missing-item");
  });

  it("bounds the combined UTF-8 Markdown, including content split across documents", () => {
    const candidate = (markdown: string) =>
      FeaturePlanDocumentSchema.parse({
        ...plan(),
        proposedDocuments: [
          { ...proposal, markdown: "é".repeat(8_000) },
          { ...proposal, key: "adr", kind: "adr", path: "docs/adr/search.md", markdown },
        ],
      });
    expect(validateFeaturePlan(candidate("é".repeat(8_000)))).toEqual([]);
    expect(validateFeaturePlan(candidate("é".repeat(8_000) + "x")).join(" ")).toContain(
      "Proposed Markdown exceeds 32,000 UTF-8 bytes",
    );
    expect(
      FeaturePlanDocumentSchema.safeParse({
        ...plan(),
        proposedDocuments: Array.from({ length: 5 }, () => proposal),
      }).success,
    ).toBe(false);
  });

  it("counts proposed documents inside the unchanged whole-plan detail limit", () => {
    const document = FeaturePlanDocumentSchema.parse({
      ...plan(),
      proposedDocuments: [{ ...proposal, markdown: "x".repeat(32_000) }],
    });
    document.scope.includes = Array.from({ length: 20 }, () => "x".repeat(2_000));
    document.scope.excludes = Array.from({ length: 12 }, () => "x".repeat(2_000));
    expect(validateFeaturePlan(document).join(" ")).toContain("Plan exceeds the detail limit");
  });

  it("keeps a legacy plan at the exact old byte limit readable and approvable", () => {
    const legacy = FeaturePlanDocumentSchema.parse(plan());
    legacy.scope.includes = Array.from({ length: 20 }, () => "x".repeat(2_000));
    legacy.scope.excludes = Array.from({ length: 20 }, () => "x".repeat(2_000));
    const first = legacy.workItems[0];
    const second = legacy.workItems[1];
    if (first === undefined || second === undefined) throw new Error("Work Item fixture missing");
    first.description = "x".repeat(8_000);
    second.description += "x".repeat(96_000 - Buffer.byteLength(JSON.stringify(legacy)));
    const parsed = FeaturePlanDocumentSchema.parse(legacy);
    expect(Buffer.byteLength(JSON.stringify(parsed))).toBe(96_000);
    expect(parsed).not.toHaveProperty("proposedDocuments");
    expect(validateFeaturePlan(parsed)).toEqual([]);
    second.description += "x";
    expect(validateFeaturePlan(FeaturePlanDocumentSchema.parse(legacy)).join(" ")).toContain(
      "Plan exceeds the detail limit",
    );
  });

  it("keeps older plans readable and rejects one imported issue assigned twice", () => {
    const candidate = FeaturePlanDocumentSchema.parse(plan());
    expect(candidate.workItems[0]?.importedIssueId).toBeNull();
    const importedIssueId = "c528b5d5-56ef-4acb-b2ee-691e09d0443a";
    const duplicate = FeaturePlanDocumentSchema.parse({
      ...candidate,
      workItems: candidate.workItems.map((workItem) => ({ ...workItem, importedIssueId })),
    });
    expect(validateFeaturePlan(duplicate).join(" ")).toContain("Imported issue is assigned twice");
  });

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

  it("rejects NUL bytes in verification while preserving ordinary zeroes and exact arguments", () => {
    const candidate = plan();
    command(candidate).args = ["--test", "tests/export-0.mjs", "0", "literal\\x00"];
    expect(FeaturePlanDocumentSchema.parse(candidate).workItems[0]?.verification[0]?.args).toEqual(
      command(candidate).args,
    );
    command(candidate).args.push("hidden\0argument");
    expect(FeaturePlanDocumentSchema.safeParse(candidate).success).toBe(false);
    command(candidate).args.pop();
    command(candidate).cwd = "src\0hidden";
    expect(FeaturePlanDocumentSchema.safeParse(candidate).success).toBe(false);
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
