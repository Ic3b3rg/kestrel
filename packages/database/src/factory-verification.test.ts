import { expect, it, vi } from "vitest";
import { factoryWorkItemsVerified } from "./factory-verification.js";

const source = { repositoryId: "retained-repository", identity: "retained-identity" };
const revision = {
  baseCommitId: "a".repeat(40),
  headCommitId: "b".repeat(40),
  treeId: "c".repeat(40),
  branch: "refs/heads/kestrel/feature/example",
};
const command = { program: "node", args: ["--test"], cwd: ".", timeoutSeconds: 10 };
const plan = { workItems: [{ key: "W1", verification: [command] }] };
const verified = {
  key: "W1",
  board_column: "in_review",
  state: "verified",
  reservation_released_at: new Date(),
  has_pending_container: false,
  source: null,
  revision,
  accepted_commands: [command],
};

it("accepts stopped null-source history only through retained workspace revision proof", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [verified] });
  expect(
    await factoryWorkItemsVerified(
      { query } as never,
      "feature",
      1,
      plan as never,
      source,
      revision,
    ),
  ).toBe(true);
});

it.each([
  { source: { ...source, identity: "replaced-source" } },
  { revision: { ...revision, baseCommitId: "d".repeat(40) } },
  { revision: null },
  { has_pending_container: true },
  { reservation_released_at: null },
  { accepted_commands: [{ ...command, args: ["--version"] }] },
])(
  "rejects historical proof that cannot certify the approved retained workspace: %j",
  async (change) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...verified, ...change }] });
    expect(
      await factoryWorkItemsVerified(
        { query } as never,
        "feature",
        1,
        plan as never,
        source,
        revision,
      ),
    ).toBe(false);
  },
);

import {
  queueFactoryExecutions,
  claimFactoryExecution,
  finishFactoryExecution,
  type ClaimedFactoryExecution,
} from "./factory-execution.js";
const featureId = "01991c36-7f90-7000-8000-000000000001";
const projectId = "01991c36-7f90-7000-8000-000000000002";
const runId = "01991c36-7f90-7000-8000-000000000003";
const itemId = "01991c36-7f90-7000-8000-000000000004";
const ownerId = "01991c36-7f90-7000-8000-000000000005";
const gateId = "01991c36-7f90-7000-8000-000000000006";
const now = new Date("2026-09-08T12:00:00.000Z");
const manifest = [{ position: 1, command, origins: [{ workItemKey: "W1", position: 1 }] }];
const document = {
  objective: "Retain approved behavior",
  scope: { includes: ["Behavior"], excludes: ["Provider writes"] },
  acceptance: [{ key: "behavior", outcome: "The approved behavior passes" }],
  workItems: [
    {
      key: "W1",
      title: "Approved behavior",
      description: "Implement approved behavior",
      requirementKeys: ["behavior"],
      acceptance: ["The check passes"],
      dependsOn: [],
      verification: [command],
    },
  ],
  limits: { maxConcurrentProjects: 2, maxActiveFeaturesPerProject: 1, attemptTimeoutSeconds: 60 },
};
const workspace = {
  feature_id: featureId,
  project_id: projectId,
  repository_id: source.repositoryId,
  source_identity: source.identity,
  base_commit_id: revision.baseCommitId,
  head_commit_id: revision.headCommitId,
  tree_id: revision.treeId,
  branch: revision.branch,
  object_format: "sha1",
};

it.each([false, true])(
  "queues only final verification after retained Work Items, with an explicit gate for a successor (retry=%s)",
  async (retry) => {
    const previousId = itemId;
    const query = vi.fn((sql: string) => {
      if (sql.includes("FROM factory_features feature JOIN projects"))
        return {
          rows: [
            {
              id: featureId,
              project_id: projectId,
              state: retry ? "queued" : "in_review",
              approved_plan_version: 1,
            },
          ],
        };
      if (sql.includes("SELECT plan.version, plan.document"))
        return { rows: [{ version: 1, document }] };
      if (sql.includes("SELECT id, key, board_column FROM factory_work_items"))
        return { rows: [{ id: itemId, key: "W1", board_column: "in_review" }] };
      if (sql.includes("FROM factory_feature_workspaces")) return { rows: [workspace] };
      if (sql.includes("SELECT item.key, item.board_column, run.state"))
        return { rows: [verified] };
      if (sql.includes("purpose = 'feature_verification' ORDER BY attempt"))
        return {
          rows: retry
            ? [{ id: previousId, attempt: 1, source, verification_manifest: manifest }]
            : [],
        };
      if (sql.includes("FROM factory_human_gates gate"))
        return {
          rows: [
            {
              id: gateId,
              feature_id: featureId,
              work_item_id: null,
              purpose: "feature_verification",
              run_id: previousId,
              plan_version: 1,
              reason: "verification_failed",
              question: "Repair the failed approved check?",
              required_decision: "retry_within_plan",
              created_at: now,
              request_id: ownerId,
              resolved_by: ownerId,
              decision: "resume_within_plan",
              answer: "Retry within the same plan.",
              resolved_at: now,
              run_state: "blocked",
              run_failure: "verification_failed",
              attempt: 1,
              reservation_released_at: now,
              has_pending_container: false,
              latest_run_id: previousId,
              successor_run_id: null,
              board_column: null,
              has_unverified_item: false,
            },
          ],
        };
      if (sql.includes("INSERT INTO factory_execution_runs")) return { rows: [{ id: runId }] };
      return { rows: [] };
    });
    const send = vi.fn().mockResolvedValue(runId);
    expect(
      await queueFactoryExecutions({ connect: () => ({ query, release: vi.fn() }) } as never, {
        send,
      }),
    ).toEqual([runId]);
    const admission = query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO factory_execution_runs"),
    );
    expect(admission?.[0]).toContain("NULL,$3,'feature_verification'");
    expect(send).toHaveBeenCalledOnce();
    expect(query.mock.calls.some(([sql]) => sql.includes("UPDATE factory_work_items"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("local_repository_sources"))).toBe(false);
  },
);

function completionFixture(
  options: {
    stopped?: boolean;
    cancelled?: boolean;
    wrongHead?: boolean;
    incomplete?: boolean;
  } = {},
) {
  const row = {
    id: runId,
    feature_id: featureId,
    project_id: projectId,
    work_item_id: null,
    purpose: "feature_verification",
    plan_version: 1,
    owner_instance_id: ownerId,
    state: "verifying",
    stop_requested_at: null,
    reservation_released_at: null,
    source,
    revision,
    accepted_commands: [command],
    verification_manifest: manifest,
  };
  const result = {
    round: 2,
    position: 1,
    command,
    headCommitId: options.wrongHead ? "d".repeat(40) : revision.headCommitId,
    treeId: revision.treeId,
    outcome: "passed",
    exitCode: 0,
    stdout: "actual command passed",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 30,
  };
  const query = vi.fn((sql: string) => {
    if (sql.includes("FROM factory_features") && sql.includes("FOR UPDATE"))
      return {
        rows: [
          {
            id: featureId,
            project_id: projectId,
            approved_plan_version: 1,
            state: options.cancelled ? "cancelled" : "implementing",
          },
        ],
        rowCount: 1,
      };
    if (sql.includes("SELECT * FROM factory_execution_runs")) return { rows: [row], rowCount: 1 };
    if (sql.includes("SELECT name FROM factory_execution_containers"))
      return {
        rows: options.stopped === false ? [{ name: "uncertain" }] : [],
        rowCount: options.stopped === false ? 1 : 0,
      };
    if (sql.includes("SELECT id, result FROM factory_verification_results"))
      return {
        rows: options.incomplete ? [] : [{ id: itemId, result }],
        rowCount: options.incomplete ? 0 : 1,
      };
    if (sql.includes("FROM factory_feature_workspaces")) return { rows: [workspace], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const run = {
    id: runId,
    featureId,
    projectId,
    ownerInstanceId: ownerId,
    key: "Feature verification",
  } as ClaimedFactoryExecution;
  return { query, run, pool: { connect: () => ({ query, release: vi.fn() }) } as never };
}

it("atomically records only complete same-head evidence identities after every environment stopped", async () => {
  const state = completionFixture();
  await finishFactoryExecution(state.pool, state.run, {
    verified: true,
    writerStopped: true,
    failure: null,
    question: null,
  });
  expect(
    state.query.mock.calls.some(([sql]) =>
      sql.includes("INSERT INTO factory_feature_verifications"),
    ),
  ).toBe(true);
  expect(state.query.mock.calls.some(([sql]) => sql.includes("UPDATE factory_work_items"))).toBe(
    false,
  );
  expect(state.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
});

it.each([{ wrongHead: true }, { incomplete: true }])(
  "rejects final success without a complete pass on the current head: %j",
  async (options) => {
    const state = completionFixture(options);
    await expect(
      finishFactoryExecution(state.pool, state.run, {
        verified: true,
        writerStopped: true,
        failure: null,
        question: null,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      state.query.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO factory_feature_verifications"),
      ),
    ).toBe(false);
    expect(state.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  },
);

it.each([{ stopped: false }, { cancelled: true }])(
  "retains the final attempt without certification on stop or cancellation failure: %j",
  async (options) => {
    const state = completionFixture(options);
    await finishFactoryExecution(state.pool, state.run, {
      verified: true,
      writerStopped: true,
      failure: null,
      question: null,
    });
    expect(
      state.query.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO factory_feature_verifications"),
      ),
    ).toBe(false);
    expect(state.query.mock.calls.some(([sql]) => sql.includes("UPDATE factory_work_items"))).toBe(
      false,
    );
  },
);

it("claims the gate successor as final verification with its original manifest, never a Work Item", async () => {
  const row = {
    id: runId,
    feature_id: featureId,
    project_id: projectId,
    work_item_id: null,
    purpose: "feature_verification",
    plan_version: 1,
    attempt: 2,
    source,
    accepted_commands: [command],
    verification_manifest: manifest,
    initial_revision: revision,
    revision,
    resume_gate_id: gateId,
  };
  const query = vi.fn((sql: string, parameters?: unknown[]) => {
    if (sql.includes("FROM factory_features") && sql.includes("FOR UPDATE"))
      return {
        rows: [
          {
            id: featureId,
            project_id: projectId,
            title: "Approved behavior",
            approved_plan_version: 1,
            state: "implementing",
          },
        ],
      };
    if (sql.includes("UPDATE factory_execution_runs")) return { rows: [row] };
    if (sql.includes("SELECT * FROM factory_plan_versions"))
      return {
        rows: [
          { document, source_context: null, plan_markdown: "# Plan", spec_markdown: "# Spec" },
        ],
      };
    if (sql.includes("SELECT id, key, board_column FROM factory_work_items"))
      return { rows: [{ id: itemId, key: "W1", board_column: "in_review" }] };
    if (sql.includes("FROM factory_feature_workspaces")) return { rows: [workspace] };
    if (sql.includes("SELECT item.key, item.board_column, run.state")) return { rows: [verified] };
    if (sql.includes("SELECT gate.id, gate.run_id")) {
      expect(sql).toContain("gate.work_item_id IS NOT DISTINCT FROM $3::uuid");
      expect(sql).toContain("previous.source IS NOT DISTINCT FROM $6::jsonb");
      expect(parameters?.[2]).toBeNull();
      expect(parameters?.[7]).toBe("feature_verification");
      expect(parameters?.[8]).toBe(JSON.stringify(manifest));
      return {
        rows: [
          {
            id: gateId,
            run_id: itemId,
            plan_version: 1,
            reason: "verification_failed",
            question: "Repair the approved check?",
            answer: "Retry the approved checks.",
          },
        ],
      };
    }
    return { rows: [] };
  });
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [{ feature_id: featureId, project_id: projectId }] }),
    connect: () => ({ query, release: vi.fn() }),
  } as never;
  const claimed = await claimFactoryExecution(pool, runId, ownerId);
  expect(claimed).toMatchObject({
    purpose: "feature_verification",
    workItemId: null,
    verificationManifest: manifest,
    initialRevision: revision,
    source,
    gateResolution: { id: gateId, approvedVersion: 1 },
  });
  expect(query.mock.calls.some(([sql]) => sql.includes("UPDATE factory_work_items"))).toBe(false);
});
