import {
  FactoryBoardSchema,
  FeaturePlanDocumentSchema,
  FeaturePlanVersionSchema,
  FeaturePlansSchema,
  PlanningContextSchema,
  PlanningTurnSchema,
  validateFeaturePlan,
  type FeaturePlanDocument,
  type FeaturePlanVersion,
  type FeaturePlans,
  type PlanningContext,
  type SaveFeaturePlanCommand,
  type FactoryBoard,
  type FactoryWorkItem,
  type ImportedFactoryIssue,
} from "@kestrel/contracts";
import type { PoolClient } from "pg";

import type { DatabasePool } from "./pool.js";
import { assertFactoryPlanImports } from "./factory-issue-imports.js";
import { initializeFactoryPublication } from "./factory-publication.js";
import {
  FactoryError,
  mapFactoryFeature,
  reconcilePlanningTurns,
  withFactoryFeature,
  type FeatureRow,
  type ClaimedPlanningTurn,
} from "./factory-planning.js";

export type FactoryPlanArtifactRenderer = (input: {
  title: string;
  version: number;
  plan: FeaturePlanDocument;
  context: PlanningContext | null;
  imports?: ImportedFactoryIssue[];
}) => { planMarkdown: string; specMarkdown: string };

interface PlanRow {
  id: string;
  feature_id: string;
  version: number;
  based_on_version: number | null;
  request_id: string;
  document: unknown;
  source_context: unknown;
  plan_markdown: string;
  spec_markdown: string;
  author: "operator" | "assistant";
  created_by: string | null;
  created_at: Date;
}

async function boardFor(client: PoolClient, feature: FeatureRow): Promise<FactoryBoard> {
  const approved =
    feature.approved_plan_version === null
      ? null
      : FeaturePlanDocumentSchema.parse(
          (await findVersion(client, feature.id, feature.approved_plan_version)).document,
        );
  const rows = await client.query<{
    id: string;
    key: string;
    position: number;
    board_column: FactoryWorkItem["column"];
    provider_issue: { url: string } | null;
    published_at: Date | null;
  }>(
    `SELECT item.*, publication.issue AS provider_issue, publication.published_at
     FROM factory_work_items item LEFT JOIN factory_issue_publications publication ON publication.work_item_id = item.id
     WHERE item.feature_id = $1 AND item.plan_version = $2 ORDER BY item.position`,
    [feature.id, feature.approved_plan_version],
  );
  const activity = await client.query<{
    id: string;
    work_item_id: string | null;
    kind: string;
    summary: string;
    created_at: Date;
  }>(
    "SELECT * FROM factory_activity WHERE feature_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1000",
    [feature.id],
  );
  const events = activity.rows.toReversed().map((row) => ({
    id: row.id,
    workItemId: row.work_item_id,
    kind: row.kind,
    summary: row.summary,
    createdAt: row.created_at.toISOString(),
  }));
  const publicEvent = ({ id, kind, summary, createdAt }: (typeof events)[number]) => ({
    id,
    kind,
    summary,
    createdAt,
  });
  const items = rows.rows.map((row) => {
    const definition = approved?.workItems.find(({ key }) => key === row.key);
    if (definition === undefined) throw new Error("An approved Work Item definition is missing");
    const dependencies = definition.dependsOn.filter(
      (key) =>
        !rows.rows.some(
          (item) => item.key === key && ["in_review", "completed"].includes(item.board_column),
        ),
    );
    return {
      ...definition,
      id: row.id,
      featureId: feature.id,
      order: row.position,
      column: row.board_column,
      blocking:
        feature.state === "cancelled"
          ? {
              kind: "cancelled",
              explanation: "This feature was cancelled. Its work is preserved for inspection.",
            }
          : row.board_column !== "todo"
            ? null
            : feature.state === "gated"
              ? {
                  kind: "human_gate",
                  explanation:
                    "This feature needs your decision. Inspect its execution attempt for the question and retained evidence.",
                }
              : dependencies.length > 0
                ? {
                    kind: "dependency",
                    explanation:
                      `Waiting for verified Work Items: ${dependencies.join(", ")}`.slice(0, 2000),
                  }
                : row.published_at === null
                  ? {
                      kind: "publication",
                      explanation:
                        "GitHub issue publication must be confirmed before this Work Item can run.",
                    }
                  : null,
      providerUrl: row.provider_issue?.url ?? null,
      activity: events
        .filter(({ workItemId }) => workItemId === row.id)
        .slice(-100)
        .map(publicEvent),
    };
  });
  return FactoryBoardSchema.parse({
    schemaVersion: 1,
    feature: mapFactoryFeature(feature),
    approvedVersion: feature.approved_plan_version,
    executionReadiness:
      feature.approved_plan_version === null
        ? { state: "unavailable", reason: "execution_not_available" }
        : { state: "enabled", reason: "automatic_execution" },
    columns: ["todo", "in_progress", "in_review", "completed"].map((id) => ({
      id,
      items: items.filter(({ column }) => column === id),
    })),
    activity: events.slice(-100).map(publicEvent),
  });
}

export function readFactoryBoard(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
): Promise<FactoryBoard> {
  return withFactoryFeature(pool, projectId, featureId, boardFor);
}

export function cancelFactoryFeature(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  command: { requestId: string; expectedVersion: number | null },
): Promise<FactoryBoard> {
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    if (feature.latest_plan_version !== command.expectedVersion) throw new FactoryError("conflict");
    if (feature.state === "cancelled") {
      if (feature.cancel_request_id !== command.requestId) throw new FactoryError("conflict");
      return boardFor(client, feature);
    }
    if (!["planning", "queued", "implementing", "gated", "in_review"].includes(feature.state))
      throw new FactoryError("conflict");
    // Cancellation withdraws authority immediately, but only confirmed teardown releases a writer.
    await client.query(
      `UPDATE factory_execution_runs SET stop_requested_at = clock_timestamp(), state =
         CASE WHEN owner_instance_id IS NULL THEN 'cancelled' ELSE 'stopping' END,
       reservation_released_at = CASE WHEN owner_instance_id IS NULL THEN clock_timestamp() ELSE reservation_released_at END,
       completed_at = CASE WHEN owner_instance_id IS NULL THEN clock_timestamp() ELSE completed_at END,
       failure = 'cancelled' WHERE feature_id = $1 AND reservation_released_at IS NULL`,
      [featureId],
    );
    await client.query(
      `UPDATE factory_planning_turns SET state = 'cancelled', failure = 'cancelled', completed_at = clock_timestamp()
       WHERE feature_id = $1 AND state IN ('queued', 'running')`,
      [featureId],
    );
    const updated = await client.query<FeatureRow>(
      "UPDATE factory_features SET state = 'cancelled', cancel_request_id = $2, runtime_thread_id = NULL, updated_at = clock_timestamp() WHERE id = $1 RETURNING *",
      [featureId, command.requestId],
    );
    const row = updated.rows[0];
    if (row === undefined) throw new Error("The feature was not cancelled");
    await client.query(
      "INSERT INTO factory_activity (feature_id, kind, summary) VALUES ($1, 'feature_cancelled', 'Feature cancelled by the Operator; its saved work is preserved')",
      [featureId],
    );
    return boardFor(client, { ...row, project_id: feature.project_id });
  });
}

export async function approveFactoryPlan(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  actorId: string,
  version: number,
  requestId: string,
  featureUrl?: string,
  validatePublication?: (input: {
    title: string;
    version: number;
    plan: FeaturePlanDocument;
    featureUrl?: string;
  }) => void,
): Promise<FactoryBoard> {
  await reconcilePlanningTurns(pool);
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    const duplicate = await client.query<{ plan_version: number; operator_id: string }>(
      "SELECT plan_version, operator_id FROM factory_plan_approvals WHERE feature_id = $1 AND request_id = $2",
      [featureId, requestId],
    );
    const existing = duplicate.rows[0];
    if (existing !== undefined) {
      if (existing.plan_version !== version || existing.operator_id !== actorId)
        throw new FactoryError("conflict");
      return boardFor(client, feature);
    }
    if (feature.state !== "planning" || feature.latest_plan_version !== version)
      throw new FactoryError("conflict");
    const pending = await client.query(
      "SELECT id FROM factory_planning_turns WHERE feature_id = $1 AND state IN ('queued', 'running')",
      [featureId],
    );
    if (pending.rowCount !== 0) throw new FactoryError("conflict");
    const document = FeaturePlanDocumentSchema.parse(
      (await findVersion(client, featureId, version)).document,
    );
    const errors = validateFeaturePlan(document);
    if (errors.length > 0) throw new FactoryError("invalid_plan", errors.slice(0, 8).join("; "));
    await assertFactoryPlanImports(client, featureId, document, true);
    validatePublication?.({
      title: feature.title,
      version,
      plan: document,
      ...(featureUrl === undefined ? {} : { featureUrl }),
    });
    await client.query(
      "INSERT INTO factory_plan_approvals (feature_id, plan_version, request_id, operator_id) VALUES ($1,$2,$3,$4)",
      [featureId, version, requestId, actorId],
    );
    await client.query(
      "INSERT INTO factory_activity (feature_id, kind, summary) VALUES ($1, 'plan_approved', $2)",
      [featureId, `Plan version ${String(version)} approved; feature queued`],
    );
    for (const [index, item] of document.workItems.entries()) {
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO factory_work_items (feature_id, plan_version, key, position) VALUES ($1,$2,$3,$4) RETURNING id",
        [featureId, version, item.key, index + 1],
      );
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error("The Work Item was not created");
      await client.query(
        "INSERT INTO factory_activity (feature_id, work_item_id, kind, summary) VALUES ($1,$2,'item_queued',$3)",
        [featureId, id, `${item.key} queued from approved plan version ${String(version)}`],
      );
    }
    await initializeFactoryPublication(client, featureId, document, featureUrl);
    const updated = await client.query<FeatureRow>(
      "UPDATE factory_features SET state = 'queued', approved_plan_version = $2, runtime_thread_id = NULL, updated_at = clock_timestamp() WHERE id = $1 RETURNING *",
      [featureId, version],
    );
    const row = updated.rows[0];
    if (row === undefined) throw new Error("The feature was not queued");
    return boardFor(client, { ...row, project_id: feature.project_id });
  });
}

function planVersion(row: PlanRow, projectId: string): FeaturePlanVersion {
  return FeaturePlanVersionSchema.parse({
    schemaVersion: 1,
    id: row.id,
    featureId: row.feature_id,
    projectId,
    version: row.version,
    document: row.document,
    sourceContext: row.source_context,
    planMarkdown: row.plan_markdown,
    specMarkdown: row.spec_markdown,
    author: row.author,
    createdAt: row.created_at.toISOString(),
  });
}

async function findVersion(
  client: PoolClient,
  featureId: string,
  version: number,
): Promise<PlanRow> {
  const result = await client.query<PlanRow>(
    "SELECT * FROM factory_plan_versions WHERE feature_id = $1 AND version = $2",
    [featureId, version],
  );
  const row = result.rows[0];
  if (row === undefined) throw new FactoryError("not_found");
  return row;
}

export function readFactoryPlanVersion(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  version: number,
): Promise<FeaturePlanVersion> {
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) =>
    planVersion(await findVersion(client, featureId, version), feature.project_id),
  );
}

export async function readFactoryPlans(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
): Promise<FeaturePlans> {
  await reconcilePlanningTurns(pool);
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    const current =
      feature.latest_plan_version === null
        ? null
        : planVersion(
            await findVersion(client, featureId, feature.latest_plan_version),
            feature.project_id,
          );
    const versions = await client.query<{ version: number; author: string; created_at: Date }>(
      "SELECT version, author, created_at FROM factory_plan_versions WHERE feature_id = $1 ORDER BY version",
      [featureId],
    );
    const approval = await client.query<{
      plan_version: number;
      operator_id: string;
      approved_at: Date;
    }>(
      "SELECT plan_version, operator_id, approved_at FROM factory_plan_approvals WHERE feature_id = $1 AND plan_version = $2",
      [featureId, feature.approved_plan_version],
    );
    const turns = await client.query<{
      id: string;
      message_id: string;
      state: string;
      failure: string | null;
      question: string | null;
      created_at: Date;
      started_at: Date | null;
      completed_at: Date | null;
    }>(
      "SELECT * FROM factory_planning_turns WHERE feature_id = $1 AND purpose = 'plan' ORDER BY created_at DESC, id DESC LIMIT 1",
      [featureId],
    );
    const turn = turns.rows[0];
    const approved = approval.rows[0];
    return FeaturePlansSchema.parse({
      schemaVersion: 1,
      feature: mapFactoryFeature(feature),
      current,
      versions: versions.rows.map((row) => ({
        version: row.version,
        author: row.author,
        createdAt: row.created_at.toISOString(),
      })),
      approval:
        approved === undefined
          ? null
          : {
              version: approved.plan_version,
              operatorId: approved.operator_id,
              approvedAt: approved.approved_at.toISOString(),
            },
      generation:
        turn === undefined
          ? null
          : PlanningTurnSchema.parse({
              id: turn.id,
              messageId: turn.message_id,
              state: turn.state,
              failure: turn.failure,
              question: turn.question,
              createdAt: turn.created_at.toISOString(),
              startedAt: turn.started_at?.toISOString() ?? null,
              completedAt: turn.completed_at?.toISOString() ?? null,
            }),
    });
  });
}

export function saveFactoryPlan(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  actorId: string,
  command: SaveFeaturePlanCommand,
  render: FactoryPlanArtifactRenderer,
): Promise<FeaturePlanVersion> {
  const document = FeaturePlanDocumentSchema.parse(command.plan);
  const errors = validateFeaturePlan(document);
  if (errors.length > 0) throw new FactoryError("invalid_plan", errors.slice(0, 8).join("; "));
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    const duplicate = await client.query<PlanRow>(
      "SELECT * FROM factory_plan_versions WHERE feature_id = $1 AND request_id = $2",
      [featureId, command.requestId],
    );
    const existing = duplicate.rows[0];
    if (existing !== undefined) {
      if (
        existing.author !== "operator" ||
        existing.created_by !== actorId ||
        existing.based_on_version !== command.expectedVersion ||
        JSON.stringify(FeaturePlanDocumentSchema.parse(existing.document)) !==
          JSON.stringify(document)
      )
        throw new FactoryError("conflict");
      return planVersion(existing, feature.project_id);
    }
    if (feature.state !== "planning" || feature.latest_plan_version !== command.expectedVersion)
      throw new FactoryError("conflict");
    const pending = await client.query(
      "SELECT id FROM factory_planning_turns WHERE feature_id = $1 AND state IN ('queued', 'running')",
      [featureId],
    );
    if (pending.rowCount !== 0) throw new FactoryError("conflict");
    if ((feature.latest_plan_version ?? 0) >= 200) throw new FactoryError("plan_limit");
    const imports = await assertFactoryPlanImports(client, featureId, document, false);
    const previous =
      feature.latest_plan_version === null
        ? null
        : await findVersion(client, featureId, feature.latest_plan_version);
    const context = PlanningContextSchema.nullable().parse(
      previous === null ? feature.planning_context : previous.source_context,
    );
    const version = (feature.latest_plan_version ?? 0) + 1;
    const artifacts = render({ title: feature.title, version, plan: document, context, imports });
    const result = await client.query<PlanRow>(
      `INSERT INTO factory_plan_versions (feature_id, version, based_on_version, request_id, document, source_context, plan_markdown, spec_markdown, author, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,'operator',$9) RETURNING *`,
      [
        featureId,
        version,
        feature.latest_plan_version,
        command.requestId,
        JSON.stringify(document),
        context === null ? null : JSON.stringify(context),
        artifacts.planMarkdown,
        artifacts.specMarkdown,
        actorId,
      ],
    );
    const saved = result.rows[0];
    if (saved === undefined) throw new Error("The draft was not saved");
    await client.query(
      "UPDATE factory_features SET latest_plan_version = $2, updated_at = clock_timestamp() WHERE id = $1",
      [featureId, version],
    );
    await client.query(
      "INSERT INTO factory_activity (feature_id, kind, summary) VALUES ($1, 'draft_saved', $2)",
      [featureId, `Draft version ${String(version)} saved`],
    );
    return planVersion(saved, feature.project_id);
  });
}

/** Publish one model result and its chat acknowledgement atomically, unless the turn was stopped. */
export async function completeGeneratedFactoryPlan(
  pool: DatabasePool,
  turn: ClaimedPlanningTurn,
  plan: FeaturePlanDocument,
  sourceContext: PlanningContext,
  render: FactoryPlanArtifactRenderer,
): Promise<void> {
  const document = FeaturePlanDocumentSchema.parse(plan);
  const context = PlanningContextSchema.parse(sourceContext);
  const errors = validateFeaturePlan(document);
  if (errors.length > 0) throw new FactoryError("invalid_plan", errors.slice(0, 8).join("; "));
  await withFactoryFeature(pool, turn.projectId, turn.featureId, async (client, feature) => {
    const selected = await client.query<{
      state: string;
      purpose: string;
      expected_plan_version: number | null;
      request_id: string;
    }>(
      "SELECT state, purpose, expected_plan_version, request_id FROM factory_planning_turns WHERE id = $1 AND feature_id = $2 FOR UPDATE",
      [turn.id, turn.featureId],
    );
    const current = selected.rows[0];
    if (current === undefined) throw new FactoryError("not_found");
    if (current.state !== "running") return;
    if (
      current.purpose !== "plan" ||
      turn.purpose !== "plan" ||
      feature.state !== "planning" ||
      current.expected_plan_version !== turn.expectedPlanVersion ||
      feature.latest_plan_version !== current.expected_plan_version
    )
      throw new FactoryError("conflict");
    if ((feature.latest_plan_version ?? 0) >= 200) throw new FactoryError("plan_limit");
    const imports = await assertFactoryPlanImports(client, turn.featureId, document, false);
    const version = (feature.latest_plan_version ?? 0) + 1;
    const artifacts = render({ title: feature.title, version, plan: document, context, imports });
    await client.query(
      `INSERT INTO factory_plan_versions (feature_id, version, based_on_version, request_id, document, source_context, plan_markdown, spec_markdown, author, source_turn_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,'assistant',$9)`,
      [
        turn.featureId,
        version,
        feature.latest_plan_version,
        current.request_id,
        JSON.stringify(document),
        JSON.stringify(context),
        artifacts.planMarkdown,
        artifacts.specMarkdown,
        turn.id,
      ],
    );
    await client.query(
      `UPDATE factory_features SET latest_plan_version = $2, planning_context = $3::jsonb,
       runtime_thread_id = NULL, updated_at = clock_timestamp() WHERE id = $1`,
      [turn.featureId, version, JSON.stringify(context)],
    );
    await client.query(
      "INSERT INTO factory_planning_messages (feature_id, role, content, reply_to_turn_id) VALUES ($1,'assistant',$2,$3)",
      [
        turn.featureId,
        `Plan version ${String(version)} is ready. Open Plan to inspect its scope, Work Items and verification before approval.`,
        turn.id,
      ],
    );
    await client.query(
      "UPDATE factory_planning_turns SET state = 'completed', failure = NULL, question = NULL, completed_at = clock_timestamp() WHERE id = $1",
      [turn.id],
    );
    await client.query(
      "INSERT INTO factory_activity (feature_id, kind, summary) VALUES ($1, 'plan_generated', $2)",
      [turn.featureId, `Plan version ${String(version)} generated for inspection`],
    );
  });
}
