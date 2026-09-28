import { expect, it } from "vitest";
import { isolateWorkItemPlan } from "./factory-work-item-start.js";
import { validateFeaturePlan, type FeaturePlanDocument } from "@kestrel/contracts";

const plan: FeaturePlanDocument = {
  objective: "Independent changes",
  scope: { includes: ["Two outcomes"], excludes: ["Other behavior"] },
  acceptance: [
    { key: "a", outcome: "First outcome" },
    { key: "b", outcome: "Second outcome" },
  ],
  workItems: ["a", "b"].map((key) => ({
    key,
    title: key,
    description: `Deliver ${key}`,
    requirementKeys: [key],
    acceptance: [`${key} works`],
    dependsOn: [],
    importedIssueId: null,
    verification: [{ program: "node", args: ["--test"], cwd: ".", timeoutSeconds: 60 }],
  })),
  limits: { maxConcurrentProjects: 2, maxActiveFeaturesPerProject: 1, attemptTimeoutSeconds: 120 },
};
it("freezes only the selected issue's requirements and checks for its independent lifecycle", () => {
  const selected = isolateWorkItemPlan(plan, "b");
  expect(selected.workItems.map((item) => item.key)).toEqual(["b"]);
  expect(selected.acceptance).toEqual([{ key: "b", outcome: "Second outcome" }]);
  expect(selected.workItems[0]?.verification).toEqual(plan.workItems[1]?.verification);
  expect(selected.limits).toEqual(plan.limits);
  expect(selected.scope).toEqual({ includes: ["Deliver b"], excludes: plan.scope.excludes });
  expect(plan.workItems).toHaveLength(2);
});
it("rejects an unknown item rather than authorizing the interview", () => {
  expect(() => isolateWorkItemPlan(plan, "missing")).toThrow();
});

it("does not carry a sibling's proposed document into the selected issue", () => {
  const withDocuments = {
    ...plan,
    proposedDocuments: [
      {
        key: "first-doc",
        kind: "glossary" as const,
        path: "CONTEXT.md",
        pathIsProvisional: false,
        markdown: "# First outcome",
        workItemKey: "a",
      },
    ],
  };
  expect(validateFeaturePlan(isolateWorkItemPlan(withDocuments, "b"))).toEqual([]);
});
