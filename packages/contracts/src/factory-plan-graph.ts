import type { Feature } from "./factory.js";
import {
  validateFeaturePlan,
  type FactoryWorkItem,
  type FeaturePlanDocument,
} from "./factory-plan.js";

interface WorkItemFact {
  key: string;
  column: FactoryWorkItem["column"];
  published: boolean;
}
interface ExecutionFacts {
  featureState: Feature["state"];
  items: readonly WorkItemFact[];
  gate?: { question: string; decision: string | null };
}

/** Pure approved-plan facts. Reservations and exact verification certificates remain database authority. */
export function projectFeaturePlan(plan: FeaturePlanDocument, facts: ExecutionFacts) {
  const errors = validateFeaturePlan(plan);
  if (errors.length > 0) throw new Error(`Invalid approved Feature Plan: ${errors.join("; ")}`);
  const definitions = new Map(plan.workItems.map((item) => [item.key, item]));
  const verifiedKeys = new Set(
    facts.items
      .filter(({ column }) => column === "in_review" || column === "completed")
      .map(({ key }) => key),
  );
  const workItems = facts.items.map((item) => {
    const definition = definitions.get(item.key);
    if (definition === undefined) throw new Error("An approved Work Item definition is missing");
    const dependencies = definition.dependsOn.filter((key) => !verifiedKeys.has(key));
    let blocking: FactoryWorkItem["blocking"] = null;
    if (facts.featureState === "cancelled") {
      blocking = {
        kind: "cancelled",
        explanation: "This feature was cancelled. Its work is preserved for inspection.",
      };
    } else if (item.column === "todo") {
      if (facts.featureState === "gated") {
        blocking = {
          kind: "human_gate",
          explanation: (facts.gate?.decision === "requires_plan_change"
            ? "The approved plan must change. Execution remains paused. "
            : "Your decision is needed: "
          )
            .concat(facts.gate?.question ?? "Open execution to inspect the retained attempt.")
            .slice(0, 2000),
        };
      } else if (dependencies.length > 0) {
        blocking = {
          kind: "dependency",
          explanation: `Waiting for verified Work Items: ${dependencies.join(", ")}`.slice(0, 2000),
        };
      } else if (!item.published) {
        blocking = {
          kind: "publication",
          explanation: "GitHub issue publication must be confirmed before this Work Item can run.",
        };
      }
    }
    return { definition, column: item.column, blocking };
  });
  const readyKeys = new Set(
    workItems
      .filter((item) => item.column === "todo" && item.blocking === null)
      .map(({ definition }) => definition.key),
  );
  return {
    workItems,
    nextWorkItemKey: ["queued", "implementing", "in_review"].includes(facts.featureState)
      ? (plan.workItems.find(({ key }) => readyKeys.has(key))?.key ?? null)
      : null,
    // Verification makes a Work Item eligible for review. Only confirmed merge persists Completed.
    allVerified:
      facts.items.length === plan.workItems.length &&
      facts.items.every(
        (item, index) => item.key === plan.workItems[index]?.key && verifiedKeys.has(item.key),
      ),
  };
}
