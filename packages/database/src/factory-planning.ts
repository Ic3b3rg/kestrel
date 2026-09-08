import {
  FeatureSchema,
  PlanningSkillDigestsSchema,
  FeaturePlanDocumentSchema,
  PlanningContextSchema,
  PlanningMessageSchema,
  PlanningTurnSchema,
  type CreateFeatureCommand,
  type Feature,
  type FeatureChat,
  type PlanningTurnAccepted,
  type PlanningContext,
  type PlanningFailure,
  type SendPlanningMessageCommand,
  type FeaturePlanDocument,
  type ImportedFactoryIssue,
  type PlanningSkillBundle,
} from "@kestrel/contracts";
import type { PoolClient } from "pg";
import {
  planningSkillSelection,
  readPlanningSkills,
  resolvePlanningSkillInvocation,
  retainedSkillSummaries,
} from "./factory-skills.js";

import type { DatabasePool } from "./pool.js";
import { factoryImportsFor } from "./factory-issue-imports.js";
import type { DiagnosticJobSender } from "./diagnostics.js";
import { FACTORY_PLANNING_QUEUE, pgBossDatabase } from "./pg-boss.js";

export class FactoryError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "conflict"
      | "unavailable"
      | "conversation_limit"
      | "feature_limit"
      | "invalid_plan"
      | "plan_limit",
    public readonly detail?: string,
  ) {
    super(`Factory operation failed: ${code}`);
    this.name = "FactoryError";
  }
}

export interface FeatureRow {
  id: string;
  project_id: string;
  title: string;
  title_source: "operator" | "pending" | "assistant";
  initial_title: string | null;
  state: string;
  planning_context: unknown;
  skill_selection_version: number;
  runtime_thread_id: string | null;
  latest_plan_version: number | null;
  approved_plan_version: number | null;
  cancel_request_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ClaimedPlanningTurn {
  id: string;
  featureId: string;
  projectId: string;
  threadId: string | null;
  purpose: "conversation" | "plan";
  expectedPlanVersion: number | null;
  previousPlan: FeaturePlanDocument | null;
  imports?: ImportedFactoryIssue[];
  skills?: PlanningSkillBundle[];
  needsTitle?: boolean;
  messages: FeatureChat["messages"];
  source: { repositoryId: string; identity: string } | null;
}

export async function reconcilePlanningTurns(pool: DatabasePool): Promise<void> {
  // Runtime turns are bounded to three minutes. Uncertain work is never silently replayed.
  await inTransaction(pool, async (client) => {
    // Use the same Feature-before-turn lock order as sends, completion, and cancellation.
    const expired = await client.query<{ id: string }>(`
      SELECT id FROM factory_features WHERE EXISTS (
        SELECT 1 FROM factory_planning_turns WHERE feature_id = factory_features.id
          AND state = 'running' AND started_at < clock_timestamp() - interval '4 minutes'
      ) ORDER BY id FOR UPDATE`);
    if (expired.rows.length === 0) return;
    const interrupted = await client.query<{ feature_id: string }>(
      `UPDATE factory_planning_turns SET state = 'failed', failure = 'interrupted', completed_at = clock_timestamp()
       WHERE feature_id = ANY($1::uuid[]) AND state = 'running'
         AND started_at < clock_timestamp() - interval '4 minutes' RETURNING feature_id`,
      [expired.rows.map(({ id }) => id)],
    );
    await client.query(
      "UPDATE factory_features SET runtime_thread_id = NULL, updated_at = clock_timestamp() WHERE id = ANY($1::uuid[])",
      [interrupted.rows.map(({ feature_id }) => feature_id)],
    );
  });
}

export async function claimPlanningTurn(
  pool: DatabasePool,
  turnId: string,
): Promise<ClaimedPlanningTurn | null> {
  const result = await pool.query<{
    feature_id: string;
    purpose: "conversation" | "plan";
    expected_plan_version: number | null;
    skill_digests: unknown;
  }>(
    `UPDATE factory_planning_turns SET state = 'running', started_at = clock_timestamp()
     WHERE id = $1 AND state = 'queued' RETURNING feature_id, purpose, expected_plan_version, skill_digests`,
    [turnId],
  );
  const claimed = result.rows[0];
  if (claimed === undefined) return null;
  const featureId = claimed.feature_id;
  const features = await pool.query<FeatureRow>("SELECT * FROM factory_features WHERE id = $1", [
    featureId,
  ]);
  const row = features.rows[0];
  if (row === undefined) throw new FactoryError("not_found");
  const chat = await readFactoryChat(pool, row.project_id, featureId);
  const source = await pool.query<{ repository_id: string; source_identity: string }>(
    `SELECT source.repository_id, source.source_identity FROM local_repository_sources AS source
     JOIN projects AS owner ON owner.id = source.project_id
     WHERE COALESCE(owner.canonical_project_id, owner.id) = (${PROJECT_FAMILY})
       AND source.attachment_state = 'attached' LIMIT 1`,
    [row.project_id],
  );
  const attached = source.rows[0];
  const skills = await readPlanningSkills(pool, claimed.skill_digests);
  const previousSkills = await pool.query<{ skill_digests: unknown }>(
    "SELECT skill_digests FROM factory_planning_turns WHERE feature_id = $1 AND id <> $2 ORDER BY created_at DESC, id DESC LIMIT 1",
    [featureId, turnId],
  );
  const sameSkills =
    JSON.stringify(previousSkills.rows[0]?.skill_digests ?? []) ===
    JSON.stringify(claimed.skill_digests);
  const previous =
    claimed.purpose === "plan" && claimed.expected_plan_version !== null
      ? await pool.query<{ document: unknown }>(
          "SELECT document FROM factory_plan_versions WHERE feature_id = $1 AND version = $2",
          [featureId, claimed.expected_plan_version],
        )
      : null;
  return {
    id: turnId,
    featureId,
    projectId: chat.feature.projectId,
    threadId:
      claimed.purpose === "plan" || row.title_source === "pending" || !sameSkills
        ? null
        : row.runtime_thread_id,
    needsTitle: claimed.purpose === "conversation" && row.title_source === "pending",
    skills,
    purpose: claimed.purpose,
    expectedPlanVersion: claimed.expected_plan_version,
    previousPlan:
      previous?.rows[0] === undefined
        ? null
        : FeaturePlanDocumentSchema.parse(previous.rows[0].document),
    messages: chat.messages,
    imports: await factoryImportsFor(pool, featureId),
    source:
      attached === undefined
        ? null
        : { repositoryId: attached.repository_id, identity: attached.source_identity },
  };
}

export async function savePlanningContext(
  pool: DatabasePool,
  turn: ClaimedPlanningTurn,
  context: PlanningContext,
): Promise<void> {
  await pool.query(
    `UPDATE factory_features SET planning_context = $3::jsonb
    WHERE id = $1 AND EXISTS (SELECT 1 FROM factory_planning_turns WHERE id = $2 AND state = 'running')`,
    [turn.featureId, turn.id, JSON.stringify(PlanningContextSchema.parse(context))],
  );
}

export async function savePlanningThread(
  pool: DatabasePool,
  turn: ClaimedPlanningTurn,
  threadId: string,
): Promise<void> {
  const result = await pool.query(
    `UPDATE factory_features SET runtime_thread_id = $3
    WHERE id = $1 AND EXISTS (SELECT 1 FROM factory_planning_turns WHERE id = $2 AND state = 'running')`,
    [turn.featureId, turn.id, threadId],
  );
  if (result.rowCount !== 1) throw new FactoryError("conflict");
}

export async function isPlanningTurnRunning(pool: DatabasePool, turnId: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT id FROM factory_planning_turns WHERE id = $1 AND state = 'running'",
    [turnId],
  );
  return result.rowCount === 1;
}

export async function completePlanningTurn(
  pool: DatabasePool,
  turn: ClaimedPlanningTurn,
  outcome: { text: string; title?: string } | { failure: PlanningFailure; question?: string },
): Promise<void> {
  await withFactoryFeature(pool, turn.projectId, turn.featureId, async (client) => {
    const completed = await client.query(
      `UPDATE factory_planning_turns
      SET state = $2, failure = $3, question = $4, completed_at = clock_timestamp()
      WHERE id = $1 AND state = 'running' RETURNING id`,
      [
        turn.id,
        "text" in outcome ? "completed" : outcome.failure === "cancelled" ? "cancelled" : "failed",
        "text" in outcome ? null : outcome.failure,
        "text" in outcome ? null : (outcome.question?.slice(0, 4_000) ?? null),
      ],
    );
    if (completed.rowCount !== 1) return;
    if ("text" in outcome) {
      await client.query(
        `INSERT INTO factory_planning_messages (feature_id, role, content, reply_to_turn_id)
        VALUES ($1, 'assistant', $2, $3)`,
        [turn.featureId, outcome.text, turn.id],
      );
      if (
        turn.purpose === "conversation" &&
        turn.needsTitle === true &&
        outcome.title !== undefined
      )
        await client.query(
          "UPDATE factory_features SET title = $2, title_source = 'assistant' WHERE id = $1 AND title_source = 'pending'",
          [turn.featureId, outcome.title],
        );
    } else {
      if (outcome.question !== undefined && outcome.question.trim().length > 0) {
        await client.query(
          `INSERT INTO factory_planning_messages (feature_id, role, content, reply_to_turn_id)
          VALUES ($1, 'assistant', $2, $3)`,
          [turn.featureId, outcome.question.slice(0, 4_000), turn.id],
        );
      }
      // A failed/uncertain thread is replaced with the durable conversation on an explicit next turn.
      await client.query("UPDATE factory_features SET runtime_thread_id = NULL WHERE id = $1", [
        turn.featureId,
      ]);
    }
    await client.query("UPDATE factory_features SET updated_at = clock_timestamp() WHERE id = $1", [
      turn.featureId,
    ]);
  });
}

export function mapFactoryFeature(row: FeatureRow): Feature {
  return FeatureSchema.parse({
    schemaVersion: 1,
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    state: row.state,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

const PROJECT_FAMILY = `SELECT COALESCE(canonical_project_id, id) FROM projects WHERE id = $1`;
const FEATURE_FAMILY = `SELECT COALESCE(canonical_project_id, id) FROM projects WHERE id = factory_features.project_id`;

interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: Date;
}
interface TurnRow {
  id: string;
  message_id: string;
  state: string;
  failure: string | null;
  question: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  purpose: "conversation" | "plan";
  expected_plan_version: number | null;
  skill_digests: unknown;
  requested_skill_selection_version: number | null;
}

async function inTransaction<T>(
  pool: DatabasePool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function withFactoryFeature<T>(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  operation: (client: PoolClient, row: FeatureRow) => Promise<T>,
): Promise<T> {
  return inTransaction(pool, async (client) => {
    const selected = await client.query<FeatureRow>(
      `SELECT *, (${FEATURE_FAMILY}) AS project_id FROM factory_features WHERE (${FEATURE_FAMILY}) = (${PROJECT_FAMILY}) AND id = $2 FOR UPDATE`,
      [projectId, featureId],
    );
    const row = selected.rows[0];
    if (row === undefined) throw new FactoryError("not_found");
    return operation(client, row);
  });
}

export async function createFactoryFeature(
  pool: DatabasePool,
  projectId: string,
  actorId: string,
  command: CreateFeatureCommand,
): Promise<Feature> {
  return inTransaction(pool, async (client) => {
    const project = await client.query<{ id: string }>(
      `SELECT id FROM projects WHERE id = (${PROJECT_FAMILY}) FOR UPDATE`,
      [projectId],
    );
    const canonicalProjectId = project.rows[0]?.id;
    if (canonicalProjectId === undefined) throw new FactoryError("not_found");
    const existing = await client.query<FeatureRow>(
      `SELECT *, (${FEATURE_FAMILY}) AS project_id FROM factory_features WHERE created_by = $1 AND request_id = $2`,
      [actorId, command.requestId],
    );
    const duplicate = existing.rows[0];
    if (duplicate !== undefined) {
      if (
        duplicate.project_id !== canonicalProjectId ||
        (duplicate.initial_title ?? duplicate.title) !== command.title
      )
        throw new FactoryError("conflict");
      return mapFactoryFeature(duplicate);
    }
    const count = await client.query<{ count: string }>(
      `SELECT count(*) FROM factory_features WHERE (${FEATURE_FAMILY}) = $1`,
      [canonicalProjectId],
    );
    if (Number(count.rows[0]?.count) >= 200) throw new FactoryError("feature_limit");
    const result = await client.query<FeatureRow>(
      `INSERT INTO factory_features (project_id, created_by, request_id, title, initial_title) VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (created_by, request_id) DO NOTHING RETURNING *`,
      [canonicalProjectId, actorId, command.requestId, command.title],
    );
    const row = result.rows[0];
    if (row === undefined) throw new FactoryError("conflict");
    return mapFactoryFeature(row);
  });
}

export async function listFactoryFeatures(
  pool: DatabasePool,
  projectId: string,
): Promise<Feature[]> {
  const project = await pool.query("SELECT id FROM projects WHERE id = $1", [projectId]);
  if (project.rowCount === 0) throw new FactoryError("not_found");
  const result = await pool.query<FeatureRow>(
    `SELECT *, (${FEATURE_FAMILY}) AS project_id FROM factory_features WHERE (${FEATURE_FAMILY}) = (${PROJECT_FAMILY}) ORDER BY created_at, id LIMIT 200`,
    [projectId],
  );
  return result.rows.map(mapFactoryFeature);
}

export async function readFactoryChat(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
): Promise<FeatureChat> {
  await reconcilePlanningTurns(pool);
  const result = await pool.query<FeatureRow>(
    `SELECT *, (${FEATURE_FAMILY}) AS project_id FROM factory_features WHERE (${FEATURE_FAMILY}) = (${PROJECT_FAMILY}) AND id = $2`,
    [projectId, featureId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new FactoryError("not_found");
  const [messages, turns] = await Promise.all([
    pool.query<MessageRow>(
      "SELECT id, role, content, created_at FROM factory_planning_messages WHERE feature_id = $1 ORDER BY created_at, id LIMIT 200",
      [featureId],
    ),
    pool.query<TurnRow>(
      "SELECT * FROM factory_planning_turns WHERE feature_id = $1 ORDER BY created_at, id LIMIT 400",
      [featureId],
    ),
  ]);
  const summaries = await retainedSkillSummaries(
    pool,
    turns.rows.map(({ skill_digests }) => skill_digests),
  );
  return {
    schemaVersion: 1,
    feature: mapFactoryFeature(row),
    messages: messages.rows.map((message) =>
      PlanningMessageSchema.parse({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.created_at.toISOString(),
      }),
    ),
    turns: turns.rows.map((turn) =>
      PlanningTurnSchema.parse({
        id: turn.id,
        messageId: turn.message_id,
        state: turn.state,
        failure: turn.failure,
        question: turn.question,
        createdAt: turn.created_at.toISOString(),
        startedAt: turn.started_at?.toISOString() ?? null,
        completedAt: turn.completed_at?.toISOString() ?? null,
        skills: PlanningSkillDigestsSchema.parse(turn.skill_digests).map((digest) =>
          summaries.get(digest),
        ),
      }),
    ),
    context:
      row.planning_context === null ? null : PlanningContextSchema.parse(row.planning_context),
    skills: await planningSkillSelection(pool, featureId, row.skill_selection_version),
  };
}

export async function acceptPlanningMessage(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  projectId: string,
  featureId: string,
  command: SendPlanningMessageCommand,
  planIntent?: { expectedVersion: number | null },
): Promise<PlanningTurnAccepted> {
  return withFactoryFeature(pool, projectId, featureId, (client, row) =>
    acceptPlanningMessageForFeature(client, boss, row, command, planIntent),
  );
}

/** Accept within the caller's transaction and already locked/new Feature. */
export async function acceptPlanningMessageForFeature(
  client: PoolClient,
  boss: DiagnosticJobSender,
  row: FeatureRow,
  command: SendPlanningMessageCommand,
  planIntent?: { expectedVersion: number | null },
  initialSkillDigests?: string[],
): Promise<PlanningTurnAccepted> {
  const featureId = row.id;
  const purpose = planIntent === undefined ? "conversation" : "plan";
  const expectedVersion = planIntent?.expectedVersion ?? null;
  const duplicate = await client.query<{
    id: string;
    message_id: string;
    content: string;
    purpose: string;
    expected_plan_version: number | null;
    requested_skill_selection_version: number | null;
  }>(
    `SELECT turn.id, turn.message_id, message.content, turn.purpose, turn.expected_plan_version, turn.requested_skill_selection_version FROM factory_planning_turns AS turn
       JOIN factory_planning_messages AS message ON message.id = turn.message_id
       WHERE turn.feature_id = $1 AND turn.request_id = $2`,
    [featureId, command.requestId],
  );
  const existing = duplicate.rows[0];
  if (existing !== undefined) {
    if (
      existing.content !== command.text ||
      existing.purpose !== purpose ||
      existing.expected_plan_version !== expectedVersion ||
      existing.requested_skill_selection_version !== (command.skillSelectionVersion ?? null)
    )
      throw new FactoryError("conflict");
    return { schemaVersion: 1, turnId: existing.id, messageId: existing.message_id };
  }
  if (row.state !== "planning") throw new FactoryError("conflict");
  if (
    command.skillSelectionVersion !== undefined &&
    command.skillSelectionVersion !== row.skill_selection_version
  )
    throw new FactoryError(
      "conflict",
      "The selected Skills changed. Refresh before sending this message.",
    );
  if (planIntent !== undefined) {
    if (row.latest_plan_version !== expectedVersion) throw new FactoryError("conflict");
    if ((row.latest_plan_version ?? 0) >= 200) throw new FactoryError("plan_limit");
  }
  const active = await client.query(
    "SELECT id FROM factory_planning_turns WHERE feature_id = $1 AND state IN ('queued', 'running')",
    [featureId],
  );
  const count = await client.query<{ count: string }>(
    "SELECT count(*) FROM factory_planning_messages WHERE feature_id = $1",
    [featureId],
  );
  if (active.rowCount !== 0) throw new FactoryError("conflict");
  if (Number(count.rows[0]?.count) >= 199) throw new FactoryError("conversation_limit");
  if (
    initialSkillDigests !== undefined &&
    (row.skill_selection_version !== 0 || Number(count.rows[0]?.count) !== 0)
  )
    throw new FactoryError("conflict", "Initial Skills belong only to the first planning message");
  const turnCount = await client.query<{ count: string }>(
    "SELECT count(*) FROM factory_planning_turns WHERE feature_id = $1",
    [featureId],
  );
  if (Number(turnCount.rows[0]?.count) >= 400) throw new FactoryError("conversation_limit");
  const selection = await planningSkillSelection(client, featureId, row.skill_selection_version);
  const selected = selection.skills.map(({ contentDigest }) => contentDigest);
  const skillDigests = await resolvePlanningSkillInvocation(
    client,
    command.text,
    initialSkillDigests ?? selected,
  );
  if (JSON.stringify(selected) !== JSON.stringify(skillDigests)) {
    if (row.skill_selection_version >= 1000)
      throw new FactoryError("conflict", "The Skill selection limit was reached");
    await client.query(
      "INSERT INTO factory_feature_skill_selections (feature_id,version,request_id,digests) VALUES ($1,$2,$3,$4::jsonb)",
      [featureId, row.skill_selection_version + 1, command.requestId, JSON.stringify(skillDigests)],
    );
    await client.query(
      "UPDATE factory_features SET skill_selection_version = skill_selection_version + 1, runtime_thread_id = NULL WHERE id = $1",
      [featureId],
    );
  }
  const inserted = await client.query<{ id: string }>(
    "INSERT INTO factory_planning_messages (feature_id, role, content) VALUES ($1, 'user', $2) RETURNING id",
    [featureId, command.text],
  );
  const messageId = inserted.rows[0]?.id;
  if (messageId === undefined) throw new Error("Planning message was not persisted");
  const turn = await client.query<{ id: string }>(
    "INSERT INTO factory_planning_turns (feature_id, message_id, request_id, purpose, expected_plan_version, skill_digests, requested_skill_selection_version) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id",
    [
      featureId,
      messageId,
      command.requestId,
      purpose,
      expectedVersion,
      JSON.stringify(skillDigests),
      command.skillSelectionVersion ?? null,
    ],
  );
  const turnId = turn.rows[0]?.id;
  if (turnId === undefined) throw new Error("Planning turn was not persisted");
  const jobId = await boss.send(
    FACTORY_PLANNING_QUEUE,
    { turnId },
    { db: pgBossDatabase(client), id: turnId },
  );
  if (jobId !== turnId) throw new Error("Planning turn was not durably queued");
  await client.query("UPDATE factory_features SET updated_at = clock_timestamp() WHERE id = $1", [
    featureId,
  ]);
  return { schemaVersion: 1, turnId, messageId };
}

export async function cancelPlanningTurn(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  turnId: string,
): Promise<FeatureChat> {
  await withFactoryFeature(pool, projectId, featureId, async (client) => {
    const selected = await client.query(
      "SELECT id FROM factory_planning_turns WHERE id = $1 AND feature_id = $2",
      [turnId, featureId],
    );
    if (selected.rowCount !== 1) throw new FactoryError("not_found");
    const stopped = await client.query(
      `UPDATE factory_planning_turns SET state = 'cancelled', failure = 'cancelled', completed_at = clock_timestamp()
      WHERE id = $1 AND state IN ('queued', 'running')`,
      [turnId],
    );
    if (stopped.rowCount === 1)
      await client.query(
        "UPDATE factory_features SET runtime_thread_id = NULL, updated_at = clock_timestamp() WHERE id = $1",
        [featureId],
      );
  });
  return readFactoryChat(pool, projectId, featureId);
}

export async function retryPlanningTurn(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  projectId: string,
  featureId: string,
  turnId: string,
  requestId: string,
): Promise<PlanningTurnAccepted> {
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    const selected = await client.query<TurnRow>(
      "SELECT * FROM factory_planning_turns WHERE id = $1 AND feature_id = $2",
      [turnId, featureId],
    );
    const original = selected.rows[0];
    if (original === undefined) throw new FactoryError("not_found");
    const duplicate = await client.query<TurnRow>(
      "SELECT * FROM factory_planning_turns WHERE feature_id = $1 AND request_id = $2",
      [featureId, requestId],
    );
    const existing = duplicate.rows[0];
    if (existing !== undefined) {
      if (existing.message_id !== original.message_id || existing.id === original.id)
        throw new FactoryError("conflict");
      return { schemaVersion: 1, turnId: existing.id, messageId: existing.message_id };
    }
    const latest = await client.query<{ id: string }>(
      "SELECT id FROM factory_planning_turns WHERE feature_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
      [featureId],
    );
    const count = await client.query<{ count: string }>(
      "SELECT count(*) FROM factory_planning_turns WHERE feature_id = $1",
      [featureId],
    );
    const messages = await client.query<{ count: string }>(
      "SELECT count(*) FROM factory_planning_messages WHERE feature_id = $1",
      [featureId],
    );
    if (Number(count.rows[0]?.count) >= 400 || Number(messages.rows[0]?.count) >= 200)
      throw new FactoryError("conversation_limit");
    if (
      feature.state !== "planning" ||
      (original.purpose === "plan" &&
        feature.latest_plan_version !== original.expected_plan_version) ||
      !["failed", "cancelled"].includes(original.state) ||
      latest.rows[0]?.id !== turnId
    )
      throw new FactoryError("conflict");
    const inserted = await client.query<{ id: string }>(
      "INSERT INTO factory_planning_turns (feature_id, message_id, request_id, purpose, expected_plan_version, skill_digests, requested_skill_selection_version) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id",
      [
        featureId,
        original.message_id,
        requestId,
        original.purpose,
        original.expected_plan_version,
        JSON.stringify(original.skill_digests),
        original.requested_skill_selection_version,
      ],
    );
    const newTurnId = inserted.rows[0]?.id;
    if (newTurnId === undefined) throw new Error("Retry was not persisted");
    const jobId = await boss.send(
      FACTORY_PLANNING_QUEUE,
      { turnId: newTurnId },
      { db: pgBossDatabase(client), id: newTurnId },
    );
    if (jobId !== newTurnId) throw new Error("Retry was not durably queued");
    await client.query(
      "UPDATE factory_features SET runtime_thread_id = NULL, updated_at = clock_timestamp() WHERE id = $1",
      [featureId],
    );
    return { schemaVersion: 1, turnId: newTurnId, messageId: original.message_id };
  });
}
