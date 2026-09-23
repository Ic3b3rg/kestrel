import type { PoolClient } from "pg";
import {
  FactoryExecutionFailureSchema,
  FactoryExecutionRevisionSchema,
  FactoryAcceptedVerificationCommandsSchema,
  FactoryVerificationResultSchema,
  FactoryVerificationManifestSchema,
  type FactoryExecutionFailure,
} from "@kestrel/contracts";
import { FactoryError, type FeatureRow } from "./factory-planning.js";
import type { ExecutionRunRow } from "./factory-execution-read.js";
import { ensureFactoryGate } from "./factory-gates.js";
import { persistFactoryFeatureVerification } from "./factory-verification.js";

export interface OwnedExecutionRunRow extends ExecutionRunRow {
  owner_instance_id: string | null;
  stop_requested_at: Date | null;
  source: { repositoryId: string; identity: string } | null;
  correction_id: string | null;
}

function correctionFailure(failure: FactoryExecutionFailure | null) {
  switch (failure) {
    case "authentication":
      return "authentication_required" as const;
    case "usage_limit":
      return "usage_limit" as const;
    case "input_required":
      return "input_required" as const;
    case "verification_failed":
      return "verification_failed" as const;
    case "source_changed":
      return "source_changed" as const;
    case "revision_changed":
      return "head_changed" as const;
    case "timeout":
      return "timeout" as const;
    case "cancelled":
      return "cancelled" as const;
    default:
      return "runtime_unavailable" as const;
  }
}
export interface FactoryFeatureWorkspace {
  projectId: string;
  featureId: string;
  repositoryId: string;
  sourceIdentity: string;
  baseCommitId: string;
  objectFormat: "sha1" | "sha256";
  branch: string;
  headCommitId: string;
  treeId: string;
}

export async function workspaceFor(
  client: PoolClient,
  featureId: string,
): Promise<FactoryFeatureWorkspace | null> {
  const result = await client.query<{
    project_id: string;
    feature_id: string;
    repository_id: string;
    source_identity: string;
    base_commit_id: string;
    object_format: "sha1" | "sha256";
    branch: string;
    head_commit_id: string;
    tree_id: string;
  }>("SELECT * FROM factory_feature_workspaces WHERE feature_id = $1", [featureId]);
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        projectId: row.project_id,
        featureId: row.feature_id,
        repositoryId: row.repository_id,
        sourceIdentity: row.source_identity,
        baseCommitId: row.base_commit_id,
        objectFormat: row.object_format,
        branch: row.branch,
        headCommitId: row.head_commit_id,
        treeId: row.tree_id,
      };
}

type ExecutionIdentity = Pick<
  ExecutionRunRow,
  "id" | "feature_id" | "work_item_id" | "purpose" | "correction_id"
>;

/** The caller holds Feature then Run locks in one transaction. Never commit here. */
async function applyExecutionOutcome(
  client: PoolClient,
  feature: FeatureRow,
  run: ExecutionIdentity,
  outcome: {
    verified: boolean;
    failure: FactoryExecutionFailure | null;
    question: string | null;
    certificate: { kind: "replace"; id: string | null } | { kind: "preserve" };
  },
): Promise<void> {
  const cancelled = feature.state === "cancelled";
  if ((run.purpose ?? "work_item") === "work_item")
    await client.query("UPDATE factory_work_items SET board_column = $2 WHERE id = $1", [
      run.work_item_id,
      outcome.verified ? "in_review" : "todo",
    ]);
  if (!cancelled) {
    await client.query(
      `UPDATE factory_features SET state = CASE WHEN $2 THEN
        CASE WHEN NOT EXISTS (SELECT 1 FROM factory_work_items WHERE feature_id = $1 AND board_column NOT IN ('in_review', 'completed'))
          THEN 'in_review' ELSE 'implementing' END ELSE 'gated' END, updated_at = clock_timestamp() WHERE id = $1`,
      [run.feature_id, outcome.verified],
    );
    if (!outcome.verified)
      await ensureFactoryGate(client, run.id, outcome.failure ?? "interrupted", outcome.question);
  }
  if (run.purpose === "correction") {
    const state = outcome.verified ? "publishing" : cancelled ? "cancelled" : "gated";
    const failure = outcome.verified
      ? null
      : cancelled
        ? "cancelled"
        : correctionFailure(outcome.failure);
    if (outcome.certificate.kind === "replace")
      await client.query(
        `UPDATE factory_review_corrections SET state = $2, failure = $3,
         certificate_id = $4, updated_at = clock_timestamp()
         WHERE id = $1 AND current_run_id = $5`,
        [run.correction_id, state, failure, outcome.certificate.id, run.id],
      );
    else
      await client.query(
        `UPDATE factory_review_corrections SET state = $2, failure = $3,
           updated_at = clock_timestamp() WHERE id = $1 AND current_run_id = $4`,
        [run.correction_id, state, failure, run.id],
      );
  }
}

export interface ExecutionCompletion {
  verified: boolean;
  writerStopped: boolean;
  failure: FactoryExecutionFailure | null;
  question: string | null;
}

/** Live completion validates the exact proof before any terminal domain fact can commit. */
export async function finishExecutionRun(
  client: PoolClient,
  feature: FeatureRow,
  row: OwnedExecutionRunRow,
  outcome: ExecutionCompletion,
  key: string,
): Promise<void> {
  if (row.reservation_released_at !== null) return;
  const pendingContainers = await client.query(
    "SELECT name FROM factory_execution_containers WHERE run_id = $1 AND stopped_at IS NULL",
    [row.id],
  );
  const writerStopped = outcome.writerStopped && pendingContainers.rowCount === 0;
  let verified =
    outcome.verified &&
    writerStopped &&
    feature.state === "implementing" &&
    row.stop_requested_at === null &&
    ["running", "verifying"].includes(row.state);
  if (verified) {
    const checks = await client.query<{ id: string; result: unknown }>(
      `SELECT id, result FROM factory_verification_results WHERE run_id = $1 AND round =
          (SELECT max(round) FROM factory_verification_results WHERE run_id = $1) ORDER BY position`,
      [row.id],
    );
    const revision = FactoryExecutionRevisionSchema.parse(row.revision);
    const commands = FactoryAcceptedVerificationCommandsSchema.parse(row.accepted_commands);
    const workspace = await workspaceFor(client, row.feature_id);
    verified =
      workspace !== null &&
      workspace.headCommitId === revision.headCommitId &&
      workspace.treeId === revision.treeId &&
      workspace.baseCommitId === revision.baseCommitId &&
      workspace.branch === revision.branch &&
      checks.rows.length === commands.length &&
      checks.rows.every(({ result }, index) => {
        const check = FactoryVerificationResultSchema.omit({ id: true, createdAt: true }).parse(
          result,
        );
        return (
          check.position === index + 1 &&
          check.outcome === "passed" &&
          check.exitCode === 0 &&
          check.headCommitId === revision.headCommitId &&
          check.treeId === revision.treeId &&
          JSON.stringify(check.command) === JSON.stringify(commands[index])
        );
      });
    if (!verified)
      throw new FactoryError("conflict", "All approved checks must pass on the exact revision");
    if (row.purpose === "feature_verification" || row.purpose === "correction") {
      if (
        workspace === null ||
        row.source?.repositoryId !== workspace.repositoryId ||
        row.source.identity !== workspace.sourceIdentity ||
        JSON.stringify(
          FactoryVerificationManifestSchema.parse(row.verification_manifest).map(
            (entry) => entry.command,
          ),
        ) !== JSON.stringify(commands)
      )
        throw new FactoryError("conflict");
      await persistFactoryFeatureVerification(
        client,
        { ...row, verification_manifest: row.verification_manifest },
        checks.rows.map((check) => check.id),
      );
    }
  }
  const cancelled = feature.state === "cancelled";
  const state = !writerStopped
    ? "interrupted"
    : cancelled
      ? "cancelled"
      : verified
        ? "verified"
        : "blocked";
  const failure = !writerStopped
    ? "stop_unconfirmed"
    : cancelled
      ? "cancelled"
      : verified
        ? null
        : (outcome.failure ?? "interrupted");
  await client.query(
    `UPDATE factory_execution_runs SET state = $2, failure = $3, question = $4, completed_at = clock_timestamp(),
        reservation_released_at = CASE WHEN $5 THEN clock_timestamp() ELSE NULL END WHERE id = $1`,
    [row.id, state, failure, outcome.question?.slice(0, 4000) ?? null, writerStopped],
  );
  const certificate =
    verified && row.purpose === "correction"
      ? ((
          await client.query<{ id: string }>(
            "SELECT id FROM factory_feature_verifications WHERE run_id = $1",
            [row.id],
          )
        ).rows[0]?.id ?? null)
      : null;
  await applyExecutionOutcome(client, feature, row, {
    verified,
    failure,
    question: outcome.question,
    certificate: { kind: "replace", id: certificate },
  });
  if (row.purpose === "correction") {
    await client.query(
      "INSERT INTO factory_activity (feature_id, kind, summary) VALUES ($1,$2,$3)",
      [
        row.feature_id,
        verified ? "correction_verified" : "execution_blocked",
        verified
          ? "The selected correction passed every approved Feature check"
          : `The selected correction stopped: ${failure ?? "interrupted"}`,
      ],
    );
    return;
  }
  // The Feature certificate is the success record; never invent a verified Work Item.
  if (verified && row.purpose === "feature_verification") return;
  await client.query(
    "INSERT INTO factory_activity (feature_id, work_item_id, kind, summary) VALUES ($1,$2,$3,$4)",
    [
      row.feature_id,
      row.work_item_id,
      verified ? "item_verified" : "execution_blocked",
      verified
        ? `${key} passed its approved checks and is ready for review`
        : `${key} stopped: ${failure ?? "interrupted"}`,
    ],
  );
}

/** A stopped orphan retains its original outcome/question and completion timestamp. */
export async function recoverExecutionRun(
  client: PoolClient,
  feature: FeatureRow,
  run: ExecutionIdentity & { failure: string | null; question: string | null },
): Promise<void> {
  const cancelled = feature.state === "cancelled";
  const failure = cancelled
    ? "cancelled"
    : FactoryExecutionFailureSchema.parse(run.failure ?? "interrupted");
  await client.query(
    `UPDATE factory_execution_runs SET state = $2, failure = $3,
         completed_at = COALESCE(completed_at, clock_timestamp()), reservation_released_at = clock_timestamp()
         WHERE id = $1`,
    [run.id, cancelled ? "cancelled" : "blocked", failure],
  );
  await applyExecutionOutcome(client, feature, run, {
    verified: false,
    failure,
    question: run.question,
    certificate: { kind: "preserve" },
  });
  await client.query(
    "INSERT INTO factory_activity (feature_id, work_item_id, kind, summary) VALUES ($1,$2,'execution_blocked',$3)",
    [
      run.feature_id,
      run.work_item_id,
      cancelled
        ? "The cancelled execution environment has been stopped."
        : "The execution environment has been stopped. Inspect the retained attempt and answer its Human Gate before continuing.",
    ],
  );
}

/** Persist the stop fence before recovery can contact an external container engine. */
export async function interruptExecutionRun(
  client: PoolClient,
  feature: FeatureRow,
  row: OwnedExecutionRunRow,
): Promise<void> {
  const pendingContainers = await client.query(
    "SELECT name FROM factory_execution_containers WHERE run_id = $1 AND stopped_at IS NULL",
    [row.id],
  );
  const writerStopped = row.owner_instance_id === null && pendingContainers.rowCount === 0;
  const question = writerStopped
    ? "Execution delivery stopped before work could start. Retry this attempt after checking the local service."
    : "Execution was interrupted. Kestrel retains this Project while it verifies and stops the recorded environment. If its identity cannot be confirmed, inspect Docker using the recorded container name; answering this gate cannot release an unconfirmed environment.";
  await client.query(
    `UPDATE factory_execution_runs SET state = $2, failure = 'interrupted', question = $3,
           stop_requested_at = clock_timestamp(), completed_at = clock_timestamp(),
           reservation_released_at = CASE WHEN $4 THEN clock_timestamp() ELSE NULL END WHERE id = $1`,
    [row.id, writerStopped ? "blocked" : "interrupted", question, writerStopped],
  );
  await applyExecutionOutcome(client, feature, row, {
    verified: false,
    failure: "interrupted",
    question,
    certificate: { kind: "preserve" },
  });
  await client.query(
    "INSERT INTO factory_activity (feature_id, work_item_id, kind, summary) VALUES ($1,$2,'execution_blocked',$3)",
    [row.feature_id, row.work_item_id, question],
  );
}
