import {
  FactoryExecutionFailureSchema,
  FactoryGateSchema,
  ResolveFactoryGateCommandSchema,
  type FactoryExecutionFailure,
  type FactoryGate,
  type ResolveFactoryGateCommand,
} from "@kestrel/contracts";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";

import { FactoryError, withFactoryFeature, type FeatureRow } from "./factory-planning.js";
import type { DatabasePool } from "./pool.js";
import { workspaceFor, type FactoryFeatureWorkspace } from "./factory-execution-ledger.js";
import type { ClaimedFactoryExecution } from "./factory-execution.js";

interface GateRow {
  id: string;
  feature_id: string;
  work_item_id: string | null;
  purpose?: "work_item" | "feature_verification" | "correction";
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
  run_source: ClaimedFactoryExecution["source"];
  workspace_restoration: FactoryFeatureWorkspace | null;
  attempt: number;
  reservation_released_at: Date | null;
  has_pending_container: boolean;
  latest_run_id: string;
  successor_run_id: string | null;
  board_column: string | null;
  has_unverified_item?: boolean;
}

const gateSelection = `SELECT gate.*, run.state AS run_state, run.failure AS run_failure,
  run.source AS run_source, run.attempt, run.reservation_released_at, item.board_column,
  EXISTS (SELECT 1 FROM factory_work_items pending WHERE pending.feature_id = gate.feature_id AND pending.plan_version = gate.plan_version AND pending.board_column NOT IN ('in_review', 'completed')) AS has_unverified_item,
  EXISTS (SELECT 1 FROM factory_execution_containers container
    WHERE container.run_id = run.id AND container.stopped_at IS NULL) AS has_pending_container,
  (SELECT latest.id FROM factory_execution_runs latest WHERE latest.feature_id = gate.feature_id
    ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1) AS latest_run_id,
  (SELECT successor.id FROM factory_execution_runs successor WHERE successor.resume_gate_id = gate.id) AS successor_run_id
  FROM factory_human_gates gate JOIN factory_execution_runs run ON run.id = gate.run_id
  LEFT JOIN factory_work_items item ON item.id = gate.work_item_id`;

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
    `INSERT INTO factory_human_gates (feature_id, work_item_id, run_id, plan_version, reason, question, required_decision, purpose)
     SELECT feature_id, work_item_id, id, plan_version, $2, $3, $4, purpose FROM factory_execution_runs WHERE id = $1
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
    (row.purpose === "feature_verification" || row.purpose === "correction"
      ? row.work_item_id !== null || row.has_unverified_item === true
      : row.board_column !== "todo")
  )
    return "stale_gate";
  if (
    row.reservation_released_at === null ||
    row.has_pending_container ||
    !["blocked", "interrupted"].includes(row.run_state)
  )
    return "unconfirmed_stop";
  if (
    row.workspace_restoration == null &&
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
    purpose: row.purpose ?? "work_item",
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
  verifyRetainedWorkspace?: (workspace: Readonly<FactoryFeatureWorkspace>) => Promise<void>,
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
    let reason = blockedReason(feature, row);
    let restoration: FactoryFeatureWorkspace | null = null;
    if (
      command.decision === "resume_within_plan" &&
      reason === "workspace_uncertain" &&
      verifyRetainedWorkspace !== undefined
    ) {
      const workspace = await workspaceFor(client, featureId);
      const owner =
        workspace === null
          ? null
          : await client.query<{ id: string }>(
              "SELECT COALESCE(canonical_project_id, id) AS id FROM projects WHERE id = $1",
              [workspace.projectId],
            );
      if (
        workspace !== null &&
        owner?.rows[0]?.id === feature.project_id &&
        workspace.repositoryId === row.run_source?.repositoryId &&
        workspace.sourceIdentity === row.run_source.identity
      ) {
        await verifyRetainedWorkspace(Object.freeze({ ...workspace }));
        restoration = workspace;
        reason = blockedReason(feature, { ...row, workspace_restoration: restoration });
      }
    }
    if (command.decision === "resume_within_plan" && reason !== null)
      throw new FactoryError("conflict", `This attempt cannot resume: ${reason}`);
    const updated = await client.query(
      `UPDATE factory_human_gates SET request_id = $2, resolved_by = $3, decision = $4, answer = $5,
       resolved_at = clock_timestamp(), workspace_restoration = $6
       WHERE id = $1 AND resolved_at IS NULL RETURNING id`,
      [
        gateId,
        command.requestId,
        actorId,
        command.decision,
        command.answer,
        restoration === null ? null : JSON.stringify(restoration),
      ],
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
          ? restoration !== null
            ? "The saved workspace matches its retained checkpoint; one controlled retry is queued."
            : row.reason === "input_required"
              ? "The Operator answered the gate within the approved plan; one controlled retry is queued."
              : "One controlled technical retry is queued within the approved plan."
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

interface TransientGateCandidate {
  id: string;
  feature_id: string;
  project_id: string;
  created_at: Date;
  attempt: number;
}

function retryDue(candidate: Pick<TransientGateCandidate, "created_at" | "attempt">, now: Date) {
  const delay = Math.min(16, 2 ** Math.max(0, candidate.attempt - 1)) * 60_000;
  return now.getTime() - candidate.created_at.getTime() >= delay;
}

/** Repairs only transient runtime interruptions; an unsuccessful approved check needs diagnosis. */
export async function reconcileTransientFactoryGates(
  pool: DatabasePool,
  runtimeReady: () => Promise<boolean>,
  now = new Date(),
): Promise<number> {
  const candidates = await pool.query<TransientGateCandidate>(
    `SELECT gate.id, gate.feature_id, feature.project_id, gate.created_at, run.attempt
     FROM factory_human_gates gate
     JOIN factory_features feature ON feature.id = gate.feature_id
     JOIN factory_execution_runs run ON run.id = gate.run_id
     WHERE gate.resolved_at IS NULL AND gate.reason IN ('usage_limit', 'unavailable')
       AND run.failure = gate.reason AND feature.state = 'gated' AND run.attempt < 20
       AND gate.created_at <= $1::timestamptz -
         LEAST(16, power(2, GREATEST(0, run.attempt - 1))) * interval '1 minute'
       AND NOT EXISTS (SELECT 1 FROM factory_verification_results result
         WHERE result.run_id = run.id AND result.result->>'outcome' IS DISTINCT FROM 'passed')
     ORDER BY gate.created_at, gate.id LIMIT 20`,
    [now],
  );
  if (candidates.rows.length === 0 || !(await runtimeReady())) return 0;
  let resumed = 0;
  for (const candidate of candidates.rows) {
    const didResume = await withFactoryFeature(
      pool,
      candidate.project_id,
      candidate.feature_id,
      async (client, feature) => {
        const selected = await client.query<GateRow>(
          `${gateSelection} WHERE gate.feature_id = $1 AND gate.id = $2`,
          [candidate.feature_id, candidate.id],
        );
        const gate = selected.rows[0];
        if (
          gate === undefined ||
          !["usage_limit", "unavailable"].includes(gate.reason) ||
          gate.reason !== gate.run_failure ||
          blockedReason(feature, gate) !== null ||
          !retryDue({ created_at: gate.created_at, attempt: gate.attempt }, now)
        )
          return false;
        const checks = await client.query<{ failed: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM factory_verification_results result
            WHERE result.run_id = $1 AND result.result->>'outcome' IS DISTINCT FROM 'passed') AS failed`,
          [gate.run_id],
        );
        if (checks.rows[0]?.failed !== false) return false;
        const answer = "The runtime recovered; retrying the same approved plan automatically.";
        const updated = await client.query(
          `UPDATE factory_human_gates SET request_id = $2, resolved_by = NULL,
             decision = 'resume_within_plan', answer = $3, resolved_at = clock_timestamp()
           WHERE id = $1 AND resolved_at IS NULL RETURNING id`,
          [gate.id, randomUUID(), answer],
        );
        if (updated.rowCount !== 1) return false;
        await client.query(
          "UPDATE factory_features SET state = 'queued', updated_at = clock_timestamp() WHERE id = $1",
          [feature.id],
        );
        await client.query(
          "INSERT INTO factory_activity (feature_id, work_item_id, kind, summary) VALUES ($1,$2,'gate_answered',$3)",
          [
            feature.id,
            gate.work_item_id,
            "The runtime recovered; another attempt is queued within the approved plan.",
          ],
        );
        return true;
      },
    );
    if (didResume) resumed += 1;
  }
  return resumed;
}
