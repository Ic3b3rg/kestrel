import { expect, it } from "vitest";
import { planningSkillInvocationNames } from "./factory-skills.js";

it("finds distinct slash and legacy dollar invocations at token boundaries on any line", () => {
  expect(
    planningSkillInvocationNames("/grilling Plan\nUse /research, then $grilling and /research!"),
  ).toEqual(["grilling", "research"]);
});

it("does not treat URL segments, path fragments or inline word fragments as Skills", () => {
  expect(
    planningSkillInvocationNames(
      "https://example.com/unknown a/unknown /docs/unknown word$unknown",
    ),
  ).toEqual([]);
});
