import { describe, expect, it } from "vitest";
import { FeaturePlanDocumentSchema, type FactoryWorkItem } from "./factory-plan.js";
import { projectFeaturePlan } from "./factory-plan-graph.js";

function plan() {
  return FeaturePlanDocumentSchema.parse({
    objective: "Deliver stable exports",
    scope: { includes: ["Exports"], excludes: ["Imports"] },
    acceptance: [{ key: "export", outcome: "Exported rows retain their order" }],
    workItems: ["rows", "csv", "json"].map((key, index) => ({
      key,
      title: key,
      description: `Deliver ${key}`,
      requirementKeys: ["export"],
      acceptance: ["Stable rows"],
      dependsOn: index === 0 ? [] : ["rows"],
      verification: [{ program: "node", args: ["--test"], cwd: ".", timeoutSeconds: 60 }],
    })),
    limits: {
      maxConcurrentProjects: 2,
      maxActiveFeaturesPerProject: 1,
      attemptTimeoutSeconds: 120,
    },
  });
}
function facts(columns: FactoryWorkItem["column"][] = ["todo", "todo", "todo"]) {
  return columns.map((column, index) => ({
    key: ["rows", "csv", "json"][index] ?? "unknown",
    column,
    published: true,
  }));
}

describe("approved Feature Plan graph", () => {
  it("projects the ordered dependency frontier without mutating its inputs", () => {
    const approved = plan();
    const state = facts();
    const before = structuredClone({ approved, state });
    const graph = projectFeaturePlan(approved, { featureState: "queued", items: state });
    expect(graph.nextWorkItemKey).toBe("rows");
    expect(
      graph.workItems.map(({ definition, blocking }) => [definition.key, blocking?.kind ?? null]),
    ).toEqual([
      ["rows", null],
      ["csv", "dependency"],
      ["json", "dependency"],
    ]);
    expect({ approved, state }).toEqual(before);
  });

  it("uses verification to unlock dependents in approved order without calling them completed", () => {
    const graph = projectFeaturePlan(plan(), {
      featureState: "implementing",
      items: facts(["in_review", "todo", "todo"]),
    });
    expect(graph.nextWorkItemKey).toBe("csv");
    expect(graph.workItems.map(({ column }) => column)).toEqual(["in_review", "todo", "todo"]);
    expect(graph.workItems.every(({ blocking }) => blocking === null)).toBe(true);
    expect(graph.allVerified).toBe(false);
  });

  it("selects the next eligible item in approved order even when facts arrive out of order", () => {
    const graph = projectFeaturePlan(plan(), {
      featureState: "implementing",
      items: facts(["in_review", "todo", "todo"]).toReversed(),
    });
    expect(graph.nextWorkItemKey).toBe("csv");
  });

  it("keeps a running dependency blocked and prevents publication from granting dependency authority", () => {
    const graph = projectFeaturePlan(plan(), {
      featureState: "implementing",
      items: facts(["in_progress", "todo", "todo"]),
    });
    expect(graph.nextWorkItemKey).toBeNull();
    expect(graph.workItems[1]?.blocking).toMatchObject({ kind: "dependency" });
  });

  it("blocks unpublished work even with satisfied dependencies", () => {
    const items = facts(["in_review", "todo", "todo"]).map((item) => ({
      ...item,
      published: false,
    }));
    const graph = projectFeaturePlan(plan(), { featureState: "queued", items });
    expect(graph.nextWorkItemKey).toBeNull();
    expect(graph.workItems[1]?.blocking).toMatchObject({ kind: "publication" });
  });

  it.each(["retry_approved", "requires_plan_change", null])(
    "keeps Human Gate precedence over dependencies and publication (%s)",
    (decision) => {
      const graph = projectFeaturePlan(plan(), {
        featureState: "gated",
        items: facts(),
        gate: { question: "Which order is intended?", decision },
      });
      expect(graph.nextWorkItemKey).toBeNull();
      expect(graph.workItems.every(({ blocking }) => blocking?.kind === "human_gate")).toBe(true);
      expect(graph.workItems[0]?.blocking?.explanation).toContain("Which order is intended?");
    },
  );

  it("preserves cancelled work for inspection and never returns a successor", () => {
    const graph = projectFeaturePlan(plan(), {
      featureState: "cancelled",
      items: facts(["in_review", "todo", "todo"]),
    });
    expect(graph.nextWorkItemKey).toBeNull();
    expect(graph.workItems.every(({ blocking }) => blocking?.kind === "cancelled")).toBe(true);
  });

  it("reports complete verification without inventing merge completion", () => {
    const graph = projectFeaturePlan(plan(), {
      featureState: "in_review",
      items: facts(["in_review", "in_review", "in_review"]),
    });
    expect(graph.allVerified).toBe(true);
    expect(graph.nextWorkItemKey).toBeNull();
    expect(graph.workItems.map(({ column }) => column)).toEqual([
      "in_review",
      "in_review",
      "in_review",
    ]);
    const merged = projectFeaturePlan(plan(), {
      featureState: "completed",
      items: facts(["completed", "completed", "completed"]),
    });
    expect(merged.workItems.every(({ column }) => column === "completed")).toBe(true);
  });

  it("does not certify incomplete or reordered persisted work", () => {
    const items = facts(["in_review", "in_review", "in_review"]);
    expect(
      projectFeaturePlan(plan(), { featureState: "in_review", items: items.slice(0, 2) })
        .allVerified,
    ).toBe(false);
    expect(
      projectFeaturePlan(plan(), { featureState: "in_review", items: items.toReversed() })
        .allVerified,
    ).toBe(false);
  });

  it("rejects cyclic and unknown dependencies through the canonical plan validation", () => {
    const approved = plan();
    const first = approved.workItems[0];
    if (first === undefined) throw new Error("Missing fixture item");
    first.dependsOn = ["csv"];
    expect(() => projectFeaturePlan(approved, { featureState: "queued", items: facts() })).toThrow(
      "Dependency cycle",
    );
    first.dependsOn = ["unknown"];
    expect(() => projectFeaturePlan(approved, { featureState: "queued", items: facts() })).toThrow(
      "Unknown dependency",
    );
  });
});
