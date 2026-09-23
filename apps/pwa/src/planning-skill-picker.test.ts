import { expect, it } from "vitest";
import { findSlashSkillQuery, insertSlashSkill } from "./planning-skill-picker.js";

it("finds a slash query at the caret on any line without opening in words, URLs or paths", () => {
  expect(findSlashSkillQuery("Plan /g next", 7)).toEqual({ start: 5, query: "g" });
  expect(findSlashSkillQuery("Plan\n/re", 8)).toEqual({ start: 5, query: "re" });
  expect(findSlashSkillQuery("word/re", 7)).toBeNull();
  expect(findSlashSkillQuery("https://host/re", 15)).toBeNull();
  expect(findSlashSkillQuery("/docs/re", 8)).toBeNull();
});

it("inserts the exact token at the caret and preserves surrounding text", () => {
  expect(insertSlashSkill("Plan /re before", { start: 5, query: "re" }, "research")).toEqual({
    text: "Plan /research before",
    caret: 14,
  });
  expect(insertSlashSkill("/", { start: 0, query: "" }, "grilling")).toEqual({
    text: "/grilling ",
    caret: 10,
  });
});
