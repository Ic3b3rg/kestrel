import { expect, it } from "vitest";
import { z } from "zod";

import { FactoryExecutionSchema } from "./factory-execution.js";
import { ResolveFactoryGateCommandSchema } from "./factory-gates.js";
import { FactoryActivitySchema } from "./factory-plan.js";

const id = "01991c36-7f90-7000-8000-000000000001";

it("retains a concrete, versioned Human Gate in the execution read model", () => {
  const gate = {
    schemaVersion: 1,
    id,
    featureId: id,
    workItemId: id,
    runId: id,
    approvedVersion: 2,
    reason: "input_required",
    question: "Should equal results retain their original order?",
    requiredDecision: "clarify_within_plan",
    createdAt: "2026-09-08T12:00:00.000Z",
    resolution: null,
    successorRunId: null,
    canResume: true,
    resumeBlockedReason: null,
  };
  expect(
    FactoryExecutionSchema.parse({
      schemaVersion: 1,
      featureId: id,
      state: "blocked",
      failure: "input_required",
      question: gate.question,
      revision: null,
      workItems: [],
      gate,
    }),
  ).toHaveProperty("gate", gate);
});

const answer = {
  requestId: id,
  expectedPlanVersion: 2,
  decision: "resume_within_plan",
  answer: "Preserve the original order when values are equal.",
};

it("requires an explicit decision, request identity and exact approved version", () => {
  expect(z.toJSONSchema(ResolveFactoryGateCommandSchema, { target: "draft-7" })).toMatchObject({
    properties: { answer: { pattern: "\\S" } },
  });
  expect(
    ResolveFactoryGateCommandSchema.parse({ ...answer, answer: "  Keep the order.  " }).answer,
  ).toBe("Keep the order.");
  for (const invalid of [
    { ...answer, requestId: "new-request" },
    { ...answer, expectedPlanVersion: 0 },
    { ...answer, expectedPlanVersion: 2.1 },
    { ...answer, decision: undefined },
    { ...answer, decision: "approve_everything" },
    { ...answer, answer: " \n " },
    { ...answer, answer: "x".repeat(4001) },
  ])
    expect(ResolveFactoryGateCommandSchema.safeParse(invalid).success).toBe(false);
});

it.each(["requirements", "acceptance", "limits", "verification", "source", "runtime", "command"])(
  "rejects a gate answer that tries to supply new %s authority",
  (key) =>
    expect(ResolveFactoryGateCommandSchema.safeParse({ ...answer, [key]: {} }).success).toBe(false),
);

it("records the need for a plan change as a distinct decision", () => {
  expect(
    ResolveFactoryGateCommandSchema.parse({ ...answer, decision: "requires_plan_change" }).decision,
  ).toBe("requires_plan_change");
});

it("keeps gate-answer activity readable on the Factory board", () => {
  expect(
    FactoryActivitySchema.safeParse({
      id,
      kind: "gate_answered",
      summary: "The Operator resolved the original question within the approved plan.",
      createdAt: "2026-09-08T12:00:00.000Z",
    }).success,
  ).toBe(true);
});
