import { expect, it, vi } from "vitest";

import {
  completeFactoryFeatureMerge,
  markFactoryFeatureMergeWrite,
} from "./factory-feature-merge.js";

const featureId = "01991c36-7f90-7000-8000-000000000001";
const projectId = "01991c36-7f90-7000-8000-000000000002";
const attemptId = "01991c36-7f90-7000-8000-000000000003";
const mergeCommitId = "c".repeat(40);

function poolFor(featureState: string, mergeState: string, mergeAttempted = false) {
  const query = vi.fn((sql: string) => {
    if (sql.includes("FROM factory_features") && sql.includes("FOR UPDATE"))
      return {
        rows: [
          {
            id: featureId,
            project_id: projectId,
            state: featureState,
            approved_plan_version: 1,
          },
        ],
      };
    if (sql.includes("FROM factory_feature_merges") && sql.includes("FOR UPDATE"))
      return {
        rows: [
          {
            id: attemptId,
            feature_id: featureId,
            project_id: projectId,
            plan_version: 1,
            state: mergeState,
            attempt_id: attemptId,
            merge_attempted: mergeAttempted,
            merge_commit_id: null,
            provider_merged_at: null,
          },
        ],
      };
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  return { pool: { query, connect: () => Promise.resolve(client) }, query };
}

it("persists merge intent only while the exact claimed Feature remains authorized", async () => {
  const current = poolFor("merging", "checking");
  await markFactoryFeatureMergeWrite(current.pool as never, {
    featureId,
    projectId,
    attemptId,
  });
  expect(current.query).toHaveBeenCalledWith(expect.stringContaining("merge_attempted = true"), [
    featureId,
    attemptId,
  ]);

  const stale = poolFor("completed", "checking");
  await expect(
    markFactoryFeatureMergeWrite(stale.pool as never, { featureId, projectId, attemptId }),
  ).rejects.toThrow();
  expect(stale.query.mock.calls.some(([sql]) => sql.includes("merge_attempted = true"))).toBe(
    false,
  );
});

it("advances work items and releases the project queue only after provider-confirmed merge", async () => {
  const current = poolFor("merging", "merging", true);
  await completeFactoryFeatureMerge(
    current.pool as never,
    { featureId, projectId, attemptId },
    { mergeCommitId, mergedAt: "2026-09-19T10:10:00.000Z" },
  );
  expect(current.query).toHaveBeenCalledWith(
    expect.stringContaining("UPDATE factory_work_items SET board_column = 'completed'"),
    [featureId, 1],
  );
  expect(current.query).toHaveBeenCalledWith(
    expect.stringContaining("UPDATE factory_features SET state = 'completed'"),
    [featureId],
  );

  const unattempted = poolFor("merging", "checking", false);
  await expect(
    completeFactoryFeatureMerge(
      unattempted.pool as never,
      { featureId, projectId, attemptId },
      { mergeCommitId, mergedAt: "2026-09-19T10:10:00.000Z" },
    ),
  ).rejects.toThrow();
  expect(
    unattempted.query.mock.calls.some(([sql]) =>
      sql.includes("UPDATE factory_features SET state = 'completed'"),
    ),
  ).toBe(false);
});
