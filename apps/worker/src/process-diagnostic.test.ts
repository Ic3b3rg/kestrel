import { describe, expect, it } from "vitest";

import { parseDiagnosticJobData } from "./process-diagnostic.js";

describe("diagnostic job compatibility", () => {
  it("accepts the original V1 durable payload", () => {
    expect(
      parseDiagnosticJobData({ diagnosticId: "018f0f89-9192-755f-aa96-f72094c734dd" }),
    ).toEqual({ diagnosticId: "018f0f89-9192-755f-aa96-f72094c734dd" });
  });
});
