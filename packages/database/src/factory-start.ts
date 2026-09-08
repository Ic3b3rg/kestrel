import {
  PlanningFeatureRequestSchema,
  PlanningFeatureStartedSchema,
  RenameFactoryFeatureCommandSchema,
  StartPlanningFeatureCommandSchema,
  type Feature,
  type PlanningFeatureStarted,
  type RenameFactoryFeatureCommand,
  type StartPlanningFeatureCommand,
} from "@kestrel/contracts";
import type { PoolClient } from "pg";
import type { DatabasePool } from "./pool.js";
import type { DiagnosticJobSender } from "./diagnostics.js";
import {
  acceptPlanningMessageForFeature,
  FactoryError,
  mapFactoryFeature,
  withFactoryFeature,
  type FeatureRow,
} from "./factory-planning.js";

const projectFamily = "SELECT COALESCE(canonical_project_id, id) FROM projects WHERE id = $1";
const featureFamily =
  "SELECT COALESCE(canonical_project_id, id) FROM projects WHERE id = feature.project_id";

interface StartRow extends FeatureRow {
  first_prompt: string;
  skill_digests: string[];
  message_id: string;
  turn_id: string;
}

async function transaction<T>(
  pool: DatabasePool,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function startPlanningFeature(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  projectId: string,
  actorId: string,
  input: StartPlanningFeatureCommand,
): Promise<PlanningFeatureStarted> {
  const command = StartPlanningFeatureCommandSchema.parse(input);
  return transaction(pool, async (client) => {
    const projects = await client.query<{ id: string }>(
      `SELECT id FROM projects WHERE id = (${projectFamily}) FOR UPDATE`,
      [projectId],
    );
    const canonicalProjectId = projects.rows[0]?.id;
    if (canonicalProjectId === undefined) throw new FactoryError("not_found");
    const starts = await client.query<StartRow>(
      `SELECT feature.*, (${featureFamily}) AS project_id, start.first_prompt, start.skill_digests, start.message_id, start.turn_id
       FROM factory_planning_starts start JOIN factory_features feature ON feature.id = start.feature_id
       WHERE start.actor_id = $1 AND start.request_id = $2`,
      [actorId, command.requestId],
    );
    const existing = starts.rows[0];
    if (existing !== undefined) {
      if (
        existing.project_id !== canonicalProjectId ||
        existing.first_prompt !== command.text ||
        JSON.stringify(existing.skill_digests) !== JSON.stringify(command.skillDigests)
      )
        throw new FactoryError(
          "conflict",
          "This first-message request already belongs to a different prompt or Skill selection",
        );
      return PlanningFeatureStartedSchema.parse({
        schemaVersion: 1,
        feature: mapFactoryFeature(existing),
        turnId: existing.turn_id,
        messageId: existing.message_id,
      });
    }
    const count = await client.query<{ count: string }>(
      `SELECT count(*) FROM factory_features feature WHERE (${featureFamily}) = $1`,
      [canonicalProjectId],
    );
    if (Number(count.rows[0]?.count) >= 200) throw new FactoryError("feature_limit");
    const features = await client.query<FeatureRow>(
      `INSERT INTO factory_features (project_id, created_by, request_id, title, initial_title, title_source)
       VALUES ($1,$2,$3,'New plan','New plan','pending') ON CONFLICT (created_by, request_id) DO NOTHING RETURNING *`,
      [canonicalProjectId, actorId, command.requestId],
    );
    const feature = features.rows[0];
    if (feature === undefined) throw new FactoryError("conflict");
    const accepted = await acceptPlanningMessageForFeature(
      client,
      boss,
      feature,
      { requestId: command.requestId, text: command.text },
      undefined,
      command.skillDigests,
    );
    await client.query(
      `INSERT INTO factory_planning_starts (feature_id,actor_id,request_id,first_prompt,skill_digests,message_id,turn_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [
        feature.id,
        actorId,
        command.requestId,
        command.text,
        JSON.stringify(command.skillDigests),
        accepted.messageId,
        accepted.turnId,
      ],
    );
    return PlanningFeatureStartedSchema.parse({ ...accepted, feature: mapFactoryFeature(feature) });
  });
}

export async function readPlanningFeatureRequest(
  pool: DatabasePool,
  projectId: string,
  actorId: string,
  requestId: string,
) {
  const project = await pool.query(`SELECT id FROM projects WHERE id = (${projectFamily})`, [
    projectId,
  ]);
  if (project.rowCount !== 1) throw new FactoryError("not_found");
  const result = await pool.query<FeatureRow>(
    `SELECT feature.*, (${featureFamily}) AS project_id FROM factory_planning_starts start
     JOIN factory_features feature ON feature.id = start.feature_id
     WHERE (${featureFamily}) = (${projectFamily}) AND start.actor_id = $2 AND start.request_id = $3`,
    [projectId, actorId, requestId],
  );
  return PlanningFeatureRequestSchema.parse({
    schemaVersion: 1,
    feature: result.rows[0] === undefined ? null : mapFactoryFeature(result.rows[0]),
  });
}

export function renameFactoryFeature(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  actorId: string,
  input: RenameFactoryFeatureCommand,
): Promise<Feature> {
  const command = RenameFactoryFeatureCommandSchema.parse(input);
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    const requests = await client.query<{ feature_id: string; title: string }>(
      "SELECT feature_id, title FROM factory_feature_renames WHERE actor_id = $1 AND request_id = $2",
      [actorId, command.requestId],
    );
    const existing = requests.rows[0];
    if (existing !== undefined) {
      if (existing.feature_id !== featureId || existing.title !== command.title)
        throw new FactoryError("conflict");
      return mapFactoryFeature(feature);
    }
    const inserted = await client.query(
      "INSERT INTO factory_feature_renames (actor_id,request_id,feature_id,title) VALUES ($1,$2,$3,$4) ON CONFLICT (actor_id,request_id) DO NOTHING RETURNING feature_id",
      [actorId, command.requestId, featureId, command.title],
    );
    if (inserted.rowCount !== 1) throw new FactoryError("conflict");
    const result = await client.query<FeatureRow>(
      "UPDATE factory_features SET initial_title = COALESCE(initial_title, title), title = $2, title_source = 'operator', updated_at = clock_timestamp() WHERE id = $1 RETURNING *",
      [featureId, command.title],
    );
    const renamed = result.rows[0];
    if (renamed === undefined) throw new FactoryError("conflict");
    return mapFactoryFeature({ ...renamed, project_id: feature.project_id });
  });
}
