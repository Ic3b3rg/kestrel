import { expect, it, vi } from "vitest";
import { saveLifecycleProfile } from "./lifecycle-profiles.js";

it("rejects a retained preview digest before selecting it as lifecycle guidance", async () => {
  const statements: string[] = [];
  const query = vi.fn((sql: string) => {
    statements.push(sql);
    return Promise.resolve({ rowCount: 0, rows: [] });
  });
  const pool = { query, connect: () => Promise.resolve({ query, release: vi.fn() }) } as never;
  await expect(
    saveLifecycleProfile(pool, "review", null, {
      expectedVersion: 0,
      settings: { skillDigests: ["a".repeat(64)] },
    }),
  ).rejects.toMatchObject({
    code: "conflict",
    detail: "Install the selected Skill version in the Skill Library before using it for new work",
  });
  expect(statements.some((sql) => sql.includes("factory_planning_skill_installs"))).toBe(true);
  expect(statements.some((sql) => sql.startsWith("INSERT INTO lifecycle_phase_profiles"))).toBe(
    false,
  );
  expect(statements.at(-1)).toBe("ROLLBACK");
});
