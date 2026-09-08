import {
  FactoryExecutionFailureSchema,
  FactoryGateSchema,
  ResolveFactoryGateCommandSchema,
  type FactoryExecutionFailure,
  type FactoryGate,
  type ResolveFactoryGateCommand,
} from "@kestrel/contracts";
import type { PoolClient } from "pg";

import { FactoryError, withFactoryFeature, type FeatureRow } from "./factory-planning.js";
import type { DatabasePool } from "./pool.js";

interface GateRow {
  id: string;
  feature_id: string;
  work_item_id: string;
  run_id: string;
  plan_version: number;
  reason: FactoryExecutionFailure;
  question: string;
  required_decision: FactoryGate["requiredDecision"];
  created_at: Date;
  request_id: string | null;
  resolved_by: string | null;
  decision: ResolveFactoryGateCommand["decision"] | null;
  answer: string | null;
  resolved_at: Date | null;
  run_state: string;
  run_failure: string | null;
  attempt: number;
  reservation_released_at: Date | null;
  has_pending_container: boolean;
  latest_run_id: string;
  successor_run_id: string | null;
  board_column: string;
}

const gateSelection = `SELECT gate.*, run.state AS run_state, run.failure AS run_failure,
  run.attempt, run.reservation_released_at, item.board_column,
  EXISTS (SELECT 1 FROM factory_execution_containers container
    WHERE container.run_id = run.id AND container.stopped_at IS NULL) AS has_pending_container,
  (SELECT latest.id FROM factory_execution_runs latest WHERE latest.feature_id = gate.feature_id
    ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1) AS latest_run_id,
  (SELECT successor.id FROM factory_execution_runs successor WHERE successor.resume_gate_id = gate.id) AS successor_run_id
  FROM factory_human_gates gate JOIN factory_execution_runs run ON run.id = gate.run_id
  JOIN factory_work_items item ON item.id = gate.work_item_id`;

/** Call under the Feature lock, after the run's authoritative outcome is persisted. */
export async function ensureFactoryGate(
  client: PoolClient,
  runId: string,
  failure: FactoryExecutionFailure,
  question: string | null,
): Promise<void> {
  const reason = FactoryExecutionFailureSchema.parse(failure);
  const requiredDecision: FactoryGate["requiredDecision"] =
    reason === "input_required" || reason === "permission_required"
      ? "clarify_within_plan"
      : reason === "source_changed" || reason === "revision_changed"
        ? "inspect_workspace"
        : reason === "interrupted" || reason === "stop_unconfirmed"
          ? "inspect_environment"
          : "retry_within_plan";
  const fallback =
    requiredDecision === "inspect_workspace"
      ? "The workspace differs from its recorded checkpoint. Inspect its retained changes before continuing."
      : requiredDecision === "inspect_environment"
        ? "Execution was interrupted. Confirm that its environment has stopped and inspect the retained attempt before continuing."
        : requiredDecision === "clarify_within_plan"
          ? "Which technical choice resolves this attempt within the approved requirements and limits?"
          : `Execution stopped with ${reason}. Inspect its recorded results and resolve the cause before retrying within the approved plan.`;
  await client.query(
    `INSERT INTO factory_human_gates (feature_id, work_item_id, run_id, plan_version, reason, question, required_decision)
     SELECT feature_id, work_item_id, id, plan_version, $2, $3, $4 FROM factory_execution_runs WHERE id = $1
     ON CONFLICT (run_id) DO NOTHING`,
    [runId, reason, question?.trim().slice(0, 4000) || fallback, requiredDecision],
  );
}

function blockedReason(
  feature: FeatureRow,
  row: GateRow,
  ignoreResolution = false,
): FactoryGate["resumeBlockedReason"] {
  if (feature.state === "cancelled") return "cancelled";
  if (row.decision === "requires_plan_change") return "plan_change_required";
  if (
    feature.approved_plan_version !== row.plan_version ||
    !["gated", "queued"].includes(feature.state) ||
    row.latest_run_id !== row.run_id ||
    row.successor_run_id !== null ||
    row.board_column !== "todo"
  )
    return "stale_gate";
  if (
    row.reservation_released_at === null ||
    row.has_pending_container ||
    !["blocked", "interrupted"].includes(row.run_state)
  )
    return "unconfirmed_stop";
  if (
    [row.reason, row.run_failure].some(
      (reason) => reason === "source_changed" || reason === "revision_changed",
    )
  )
    return "workspace_uncertain";
  if (row.attempt >= 20) return "attempt_limit";
  if (!ignoreResolution && row.resolved_at !== null) return "already_resolved";
  return null;
}

function mapGate(feature: FeatureRow, row: GateRow): FactoryGate {
  const resumeBlockedReason = blockedReason(feature, row);
  return FactoryGateSchema.parse({
    schemaVersion: 1,
    id: row.id,
    featureId: row.feature_id,
    workItemId: row.work_item_id,
    runId: row.run_id,
    approvedVersion: row.plan_version,
    reason: row.reason,
    question: row.question,
    requiredDecision: row.required_decision,
    createdAt: row.created_at.toISOString(),
    resolution:
      row.resolved_at === null
        ? null
        : {
            requestId: row.request_id,
            operatorId: row.resolved_by,
            decision: row.decision,
            answer: row.answer,
            resolvedAt: row.resolved_at.toISOString(),
          },
    successorRunId: row.successor_run_id,
    canResume: resumeBlockedReason === null,
    resumeBlockedReason,
  });
}

/** These internal reads share the caller's Feature lock and transaction. */
export async function factoryGateForRun(
  client: PoolClient,
  feature: FeatureRow,
  runId: string,
): Promise<FactoryGate | null> {
  const result = await client.query<GateRow>(
    `${gateSelection} WHERE gate.feature_id = $1 AND gate.run_id = $2`,
    [feature.id, runId],
  );
  return result.rows[0] === undefined ? null : mapGate(feature, result.rows[0]);
}

export async function factoryGateForRetry(
  client: PoolClient,
  feature: FeatureRow,
  runId: string,
): Promise<FactoryGate | null> {
  const result = await client.query<GateRow>(
    `${gateSelection} WHERE gate.feature_id = $1 AND gate.run_id = $2`,
    [feature.id, runId],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    feature.state !== "queued" ||
    row.decision !== "resume_within_plan" ||
    row.resolved_at === null ||
    blockedReason(feature, row, true) !== null
  )
    return null;
  return mapGate(feature, row);
}

export function readFactoryGate(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  gateId: string,
): Promise<FactoryGate> {
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    const result = await client.query<GateRow>(
      `${gateSelection} WHERE gate.feature_id = $1 AND gate.id = $2`,
      [featureId, gateId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new FactoryError("not_found");
    return mapGate(feature, row);
  });
}

export function resolveFactoryGate(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  gateId: string,
  actorId: string,
  input: ResolveFactoryGateCommand,
): Promise<FactoryGate> {
  const command = ResolveFactoryGateCommandSchema.parse(input);
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    // Exact replay remains valid after scheduling, cancellation, or a subsequent gate.
    const replay = await client.query<GateRow>(
      `${gateSelection} WHERE gate.feature_id = $1 AND gate.request_id = $2`,
      [featureId, command.requestId],
    );
    const duplicate = replay.rows[0];
    if (duplicate !== undefined) {
      if (
        duplicate.id !== gateId ||
        duplicate.resolved_by !== actorId ||
        duplicate.plan_version !== command.expectedPlanVersion ||
        duplicate.decision !== command.decision ||
        duplicate.answer !== command.answer
      )
        throw new FactoryError(
          "conflict",
          "The gate answer request was already used for a different decision",
        );
      return mapGate(feature, duplicate);
    }
    const selected = await client.query<GateRow>(
      `${gateSelection} WHERE gate.feature_id = $1 AND gate.id = $2`,
      [featureId, gateId],
    );
    const row = selected.rows[0];
    if (row === undefined) throw new FactoryError("not_found");
    if (
      feature.state !== "gated" ||
      row.resolved_at !== null ||
      row.latest_run_id !== row.run_id ||
      row.plan_version !== command.expectedPlanVersion ||
      feature.approved_plan_version !== command.expectedPlanVersion
    )
      throw new FactoryError("conflict", "The current gate and approved plan version must match");
    const reason = blockedReason(feature, row);
    if (command.decision === "resume_within_plan" && reason !== null)
      throw new FactoryError("conflict", `This attempt cannot resume: ${reason}`);
    const updated = await client.query(
      `UPDATE factory_human_gates SET request_id = $2, resolved_by = $3, decision = $4, answer = $5,
       resolved_at = clock_timestamp() WHERE id = $1 AND resolved_at IS NULL RETURNING id`,
      [gateId, command.requestId, actorId, command.decision, command.answer],
    );
    if (updated.rowCount !== 1) throw new FactoryError("conflict");
    if (command.decision === "resume_within_plan")
      await client.query(
        "UPDATE factory_features SET state = 'queued', updated_at = clock_timestamp() WHERE id = $1",
        [featureId],
      );
    await client.query(
      "INSERT INTO factory_activity (feature_id, work_item_id, kind, summary) VALUES ($1,$2,'gate_answered',$3)",
      [
        featureId,
        row.work_item_id,
        command.decision === "resume_within_plan"
          ? "The Operator answered the gate within the approved plan; one controlled retry is queued."
          : "The Operator identified a required plan change. Execution remains gated until an updated plan is approved.",
      ],
    );
    const result = await client.query<GateRow>(
      `${gateSelection} WHERE gate.feature_id = $1 AND gate.id = $2`,
      [featureId, gateId],
    );
    const resolved = result.rows[0];
    if (resolved === undefined) throw new FactoryError("conflict");
    return mapGate(
      command.decision === "resume_within_plan" ? { ...feature, state: "queued" } : feature,
      resolved,
    );
  });
}
