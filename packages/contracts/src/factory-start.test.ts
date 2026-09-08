import { expect, it } from "vitest";
import {
  StartPlanningFeatureCommandSchema,
  PlanningFeatureStartedSchema,
  RenameFactoryFeatureCommandSchema,
} from "./factory-start.js";

it("accepts one first prompt with a stable request and bounded Skill selection", () => {
  const command = {
    requestId: "01900000-0000-7000-8000-000000000001",
    text: "  Search saved reports  ",
    skillDigests: ["a".repeat(64)],
  };
  expect(StartPlanningFeatureCommandSchema.parse(command).text).toBe("Search saved reports");
  expect(StartPlanningFeatureCommandSchema.safeParse({ ...command, text: "  " }).success).toBe(
    false,
  );
  expect(
    StartPlanningFeatureCommandSchema.safeParse({
      ...command,
      skillDigests: [...command.skillDigests, ...command.skillDigests],
    }).success,
  ).toBe(false);
  expect(
    StartPlanningFeatureCommandSchema.safeParse({ ...command, title: "A mandatory title" }).success,
  ).toBe(false);
});

it("requires a complete durable first-message result and an explicit rename", () => {
  expect(PlanningFeatureStartedSchema.safeParse({ schemaVersion: 1, feature: null }).success).toBe(
    false,
  );
  expect(
    RenameFactoryFeatureCommandSchema.safeParse({
      requestId: "01900000-0000-7000-8000-000000000001",
      title: "",
    }).success,
  ).toBe(false);
  expect(
    RenameFactoryFeatureCommandSchema.parse({
      requestId: "01900000-0000-7000-8000-000000000001",
      title: "Saved report search",
    }).title,
  ).toBe("Saved report search");
});
