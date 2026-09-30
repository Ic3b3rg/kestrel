import { expect, it, vi } from "vitest";
import { reconcileFactoryReviewCorrections } from "./factory-review-corrections.js";

it("leaves a resumed correction queued while another Feature owns the Project writer", async () => {
  const query = vi.fn((sql: string) => {
    if (sql.includes("gate.decision = 'resume_within_plan'"))
      return { rows: [{ attempt: 1, project_id: "project", feature_id: "reviewed-feature" }] };
    if (sql.includes("JOIN projects running_project")) return { rows: [{ id: "active-writer" }] };
    if (sql.includes("INSERT INTO factory_execution_runs"))
      throw new Error("A second writer was attempted");
    return { rows: [] };
  });
  const release = vi.fn();
  const send = vi.fn();
  await expect(
    reconcileFactoryReviewCorrections({ connect: () => ({ query, release }) } as never, { send }),
  ).resolves.toBeUndefined();
  expect(send).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
  expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
});
