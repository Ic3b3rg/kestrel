import { describe, expect, it } from "vitest";
import { FeaturePlanDocumentSchema } from "@kestrel/contracts";
import { FactoryError } from "@kestrel/database";
import { renderFactoryIssueContent, validateFactoryPublication } from "./factory-issue-content.js";

const plan = FeaturePlanDocumentSchema.parse({
  objective: "Export saved notes",
  scope: { includes: ["Markdown export"], excludes: ["Sharing"] },
  acceptance: [{ key: "download", outcome: "Unicode survives the downloaded file" }],
  workItems: [
    {
      key: "export",
      title: "Export notes",
      description: "Download all saved notes as Markdown.",
      requirementKeys: ["download"],
      acceptance: ["Unicode is preserved"],
      dependsOn: [],
      verification: [
        {
          program: "node",
          args: ["--test", "a b.test.mjs", "literal $(nothing)"],
          cwd: ".",
          timeoutSeconds: 60,
        },
      ],
    },
  ],
  limits: { maxConcurrentProjects: 2, maxActiveFeaturesPerProject: 1, attemptTimeoutSeconds: 1800 },
});
describe("approved GitHub issue content", () => {
  it("renders approved detail, exact argv, authority limits and a stable operation marker", () => {
    const body = renderFactoryIssueContent({
      title: "Export",
      version: 3,
      plan,
      itemKey: "export",
      featureUrl: "http://127.0.0.1:3000/projects/project/features/feature?view=board",
      marker: "<!-- kestrel-publication:v1:fixture -->",
      dependencies: [],
    });
    expect(body).toContain(plan.objective);
    expect(body).toContain("Unicode survives");
    expect(body).toContain("literal $(nothing)");
    expect(body).toContain("a b.test.mjs");
    expect(body).toContain("1800 seconds");
    expect(body).toContain("Plan version 3");
    expect(body).toContain("To do");
    expect(body).toContain("<!-- kestrel-publication:v1:fixture -->");
    expect(body).not.toMatch(/(?:Closes|Fixes|Resolves) #/u);
  });
  it("rejects an oversized publication before approval instead of truncating approved detail", () => {
    const huge = structuredClone(plan);
    const command = huge.workItems[0]?.verification[0];
    if (command === undefined) throw new Error("Verification fixture missing");
    command.args = Array.from({ length: 32 }, () => "x".repeat(2048));
    expect.assertions(2);
    try {
      validateFactoryPublication({ title: "Export", version: 1, plan: huge });
    } catch (error) {
      expect(error).toBeInstanceOf(FactoryError);
      expect(error instanceof FactoryError ? error.detail : undefined).toContain(
        "GitHub issue detail limit",
      );
    }
  });
});
