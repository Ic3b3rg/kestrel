import {
  defaultLifecycleSettings,
  FrozenLifecycleProfileSchema,
  LifecycleOverridesSchema,
  LifecycleProfileViewSchema,
  LifecycleSettingsSchema,
  resolveLifecycleProfile,
  SaveLifecycleProfileCommandSchema,
  type CodexSubscriptionConnection,
  type FrozenLifecycleProfile,
  type LifecyclePhase,
  type PlanningComposerSettings,
  type LifecycleProfileView,
} from "@kestrel/contracts";
import type { DatabasePool } from "./pool.js";
import type { PoolClient } from "pg";
import { FactoryError } from "./factory-planning.js";
import { readPlanningSkills, requireInstalledPlanningSkills } from "./factory-skills.js";

type Reader = Pick<DatabasePool, "query">;
async function canonicalProject(reader: Reader, projectId: string | null): Promise<string | null> {
  if (projectId === null) return null;
  const result = await reader.query<{ id: string }>(
    "SELECT COALESCE(canonical_project_id, id) AS id FROM projects WHERE id = $1",
    [projectId],
  );
  if (result.rows[0] === undefined) throw new FactoryError("not_found");
  return result.rows[0].id;
}

export async function readLifecycleProfile(
  reader: Reader,
  phase: LifecyclePhase,
  projectId: string | null,
  connection: CodexSubscriptionConnection,
  conversationSettings: PlanningComposerSettings = {},
): Promise<LifecycleProfileView> {
  const canonical = await canonicalProject(reader, projectId);
  const result = await reader.query<{
    project_id: string | null;
    version: number;
    settings: unknown;
  }>(
    "SELECT project_id, version, settings FROM lifecycle_phase_profiles WHERE phase = $1 AND (project_id IS NULL OR project_id = $2)",
    [phase, canonical],
  );
  const installation = result.rows.find((row) => row.project_id === null);
  const project =
    canonical === null ? undefined : result.rows.find((row) => row.project_id === canonical);
  const defaults = LifecycleSettingsSchema.parse({
    ...defaultLifecycleSettings,
    ...LifecycleOverridesSchema.parse(installation?.settings ?? {}),
  });
  const overrides = LifecycleOverridesSchema.parse(project?.settings ?? {});
  const versions = { installation: installation?.version ?? 0, project: project?.version ?? 0 };
  let resolved: FrozenLifecycleProfile | null = null;
  let blocked: string | null = null;
  try {
    if (connection.state !== "ready")
      throw new Error(
        "Connect the Codex runtime and resolve its authentication or usage limit before starting new work.",
      );
    const profile = resolveLifecycleProfile(
      defaults,
      { ...overrides, ...conversationSettings },
      connection.models,
    );
    await requireInstalledPlanningSkills(reader, profile.requested.skillDigests);
    const skills = await readPlanningSkills(reader, profile.requested.skillDigests);
    resolved = FrozenLifecycleProfileSchema.parse({ ...profile, phase, versions, skills });
  } catch (error) {
    blocked =
      error instanceof FactoryError
        ? (error.detail ??
          "A selected Skill version is unavailable. Choose installed Skills in Lifecycle settings.")
        : error instanceof Error
          ? error.message
          : "The lifecycle profile is unavailable.";
  }
  return LifecycleProfileViewSchema.parse({
    phase,
    versions,
    defaults,
    overrides,
    models: connection.models,
    resolved,
    blocked,
  });
}

export async function freezeLifecycleProfile(
  client: PoolClient,
  phase: LifecyclePhase,
  projectId: string,
  connection: CodexSubscriptionConnection,
  conversationSettings: PlanningComposerSettings = {},
): Promise<FrozenLifecycleProfile> {
  // Settings writes take the same lock. The profile and accepted action share one transaction.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('kestrel.lifecycle-profiles', 0))",
  );
  const view = await readLifecycleProfile(
    client,
    phase,
    projectId,
    connection,
    conversationSettings,
  );
  if (view.resolved === null)
    throw new FactoryError(
      "conflict",
      view.blocked ?? "Choose an available lifecycle profile before starting work.",
    );
  return view.resolved;
}

export async function saveLifecycleProfile(
  pool: DatabasePool,
  phase: LifecyclePhase,
  projectId: string | null,
  input: unknown,
): Promise<void> {
  const command = SaveLifecycleProfileCommandSchema.parse(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('kestrel.lifecycle-profiles', 0))",
    );
    const canonical = await canonicalProject(client, projectId);
    const previous = await client.query<{ version: number }>(
      "SELECT version FROM lifecycle_phase_profiles WHERE project_id IS NOT DISTINCT FROM $1 AND phase = $2",
      [canonical, phase],
    );
    if ((previous.rows[0]?.version ?? 0) !== command.expectedVersion)
      throw new FactoryError(
        "conflict",
        "These settings changed. Reload the profile before saving again.",
      );
    if (command.settings.skillDigests !== undefined) {
      await requireInstalledPlanningSkills(client, command.settings.skillDigests);
      await readPlanningSkills(client, command.settings.skillDigests);
    }
    await client.query(
      "INSERT INTO lifecycle_phase_profiles (project_id, phase, version, settings) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (project_id, phase) DO UPDATE SET version = EXCLUDED.version, settings = EXCLUDED.settings, updated_at = clock_timestamp()",
      [canonical, phase, command.expectedVersion + 1, JSON.stringify(command.settings)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
