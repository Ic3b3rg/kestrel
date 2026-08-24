import { describe, expect, it } from "vitest";

import { classifyDiagnosticTransition } from "./diagnostics.js";

describe("diagnostic transition guard", () => {
  it.each([
    ["queued", "running", "apply"],
    ["running", "succeeded", "apply"],
    ["running", "running", "already_applied"],
    ["succeeded", "running", "already_applied"],
    ["succeeded", "succeeded", "already_applied"],
    ["queued", "succeeded", "invalid"],
  ] as const)("classifies %s -> %s as %s", (current, next, expected) => {
    expect(classifyDiagnosticTransition(current, next)).toBe(expected);
  });
});
