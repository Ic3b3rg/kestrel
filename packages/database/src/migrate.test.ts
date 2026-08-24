import { describe, expect, it } from "vitest";

import { assertAppliedMigrations } from "./migrate.js";

const expected = [
  { checksum: "checksum-1", name: "001_installation.sql" },
  { checksum: "checksum-2", name: "002_diagnostics_and_events.sql" },
];

describe("migration readiness", () => {
  it("rejects a missing required migration", () => {
    expect(() =>
      assertAppliedMigrations(expected, [expected[0] as (typeof expected)[number]]),
    ).toThrow("Required migration is not applied: 002_diagnostics_and_events.sql");
  });

  it("rejects a changed applied migration checksum", () => {
    expect(() =>
      assertAppliedMigrations(expected, [
        expected[0] as (typeof expected)[number],
        { checksum: "changed", name: "002_diagnostics_and_events.sql" },
      ]),
    ).toThrow("Applied migration checksum changed: 002_diagnostics_and_events.sql");
  });
});
