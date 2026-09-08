import { createHash } from "node:crypto";
import {
  GitHubPlanningSkillBundleSchema,
  GitHubPlanningSkillSourceSchema,
  InstallGitHubPlanningSkillCommandSchema,
  PlanningSkillBundleSchema,
  PlanningSkillDigestsSchema,
  PlanningSkillSummarySchema,
  type FeaturePlanningSkills,
  type GitHubPlanningSkillBundle,
  type InstallPlanningSkillCommand,
  type InstallGitHubPlanningSkillCommand,
  type PlanningSkillBundle,
  type PlanningSkillSummary,
  type SelectPlanningSkillsCommand,
} from "@kestrel/contracts";
import type { PoolClient } from "pg";
import type { DatabasePool } from "./pool.js";
import { FactoryError, withFactoryFeature } from "./factory-planning.js";

type Reader = DatabasePool | PoolClient;
export const skillSummary = (bundle: PlanningSkillBundle): PlanningSkillSummary =>
  PlanningSkillSummarySchema.parse({
    name: bundle.name,
    description: bundle.description,
    contentDigest: bundle.contentDigest,
    source: bundle.source,
  });

export async function readPlanningSkill(
  reader: Reader,
  digest: string,
): Promise<PlanningSkillBundle> {
  const result = await reader.query<{ bundle: unknown }>(
    "SELECT bundle FROM factory_planning_skill_versions WHERE digest = $1",
    [digest],
  );
  if (result.rows[0] === undefined)
    throw new FactoryError("not_found", "This retained Skill version is unavailable");
  return PlanningSkillBundleSchema.parse(result.rows[0].bundle);
}
export async function readPlanningSkills(
  reader: Reader,
  values: unknown,
): Promise<PlanningSkillBundle[]> {
  const digests = PlanningSkillDigestsSchema.parse(values);
  const skills = await Promise.all(digests.map((digest) => readPlanningSkill(reader, digest)));
  if (new Set(skills.map((skill) => skill.name)).size !== skills.length)
    throw new FactoryError("conflict", "Choose only one version of each Skill for a planning turn");
  if (
    skills.reduce((bytes, skill) => bytes + Buffer.byteLength(JSON.stringify(skill)), 0) >
    256 * 1024
  )
    throw new FactoryError(
      "conflict",
      "The selected Skills exceed the 256 KiB planning limit. Select fewer Skills.",
    );
  return skills;
}
export async function retainedSkillSummaries(
  reader: Reader,
  values: unknown[],
): Promise<Map<string, PlanningSkillSummary>> {
  const digests = [...new Set(values.flatMap((value) => PlanningSkillDigestsSchema.parse(value)))];
  if (digests.length === 0) return new Map();
  const result = await reader.query<{ digest: string; bundle: unknown }>(
    "SELECT digest, bundle FROM factory_planning_skill_versions WHERE digest = ANY($1::text[])",
    [digests],
  );
  if (result.rows.length !== digests.length)
    throw new FactoryError("not_found", "A retained Skill version is unavailable");
  return new Map(
    result.rows.map(({ digest, bundle }) => [
      digest,
      skillSummary(PlanningSkillBundleSchema.parse(bundle)),
    ]),
  );
}
export async function listPlanningSkills(pool: DatabasePool): Promise<PlanningSkillSummary[]> {
  const result = await pool.query<{
    bundle: unknown;
  }>(`SELECT version.bundle FROM factory_planning_skill_catalog AS catalog
    JOIN factory_planning_skill_versions AS version ON version.digest = catalog.digest ORDER BY catalog.name LIMIT 200`);
  return result.rows.map(({ bundle }) => skillSummary(PlanningSkillBundleSchema.parse(bundle)));
}
export async function readPlanningSkillInstall(
  reader: Reader,
  actorId: string,
  command: InstallPlanningSkillCommand | InstallGitHubPlanningSkillCommand,
): Promise<PlanningSkillBundle | null> {
  const result = await reader.query<{ candidate_id: string; digest: string }>(
    "SELECT candidate_id, digest FROM factory_planning_skill_installs WHERE actor_id = $1 AND request_id = $2",
    [actorId, command.requestId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  if (
    "digest" in command ? row.digest !== command.digest : row.candidate_id !== command.candidateId
  )
    throw new FactoryError(
      "conflict",
      "This import request was already used for a different Skill",
    );
  const retained = await readPlanningSkill(reader, row.digest);
  if (retained.source.kind !== ("digest" in command ? "github" : "host"))
    throw new FactoryError("conflict", "This request was already used for another import source");
  return retained;
}

/** A preview retains provenance and bytes only; it grants no catalog or planning authority. */
export async function retainGitHubPlanningSkill(
  pool: DatabasePool,
  input: GitHubPlanningSkillBundle,
): Promise<GitHubPlanningSkillBundle> {
  const bundle = GitHubPlanningSkillBundleSchema.parse(input);
  const file = bundle.files.find(({ path }) => path === ".kestrel/source.json");
  let source: unknown;
  try {
    const manifest: unknown = JSON.parse(file?.content ?? "null");
    if (typeof manifest === "object" && manifest !== null && "source" in manifest)
      source = manifest.source;
  } catch {
    // The public error must not expose the provider body or private process details.
  }
  const attributed = GitHubPlanningSkillSourceSchema.safeParse(source);
  if (
    !attributed.success ||
    Object.entries(bundle.source).some(
      ([key, value]) => attributed.data[key as keyof typeof attributed.data] !== value,
    ) ||
    createHash("sha256").update(JSON.stringify(bundle.files)).digest("hex") !== bundle.contentDigest
  )
    throw new FactoryError(
      "conflict",
      "The GitHub preview does not match its retained source and content",
    );
  await pool.query(
    "INSERT INTO factory_planning_skill_versions (digest, bundle) VALUES ($1,$2::jsonb) ON CONFLICT (digest) DO NOTHING",
    [bundle.contentDigest, JSON.stringify(bundle)],
  );
  return GitHubPlanningSkillBundleSchema.parse(await readPlanningSkill(pool, bundle.contentDigest));
}

export async function installGitHubPlanningSkill(
  pool: DatabasePool,
  actorId: string,
  input: InstallGitHubPlanningSkillCommand,
): Promise<GitHubPlanningSkillBundle> {
  const command = InstallGitHubPlanningSkillCommandSchema.parse(input);
  const preview = await readPlanningSkill(pool, command.digest);
  if (preview.source.kind !== "github")
    throw new FactoryError("conflict", "Preview a GitHub Skill before installing it");
  return GitHubPlanningSkillBundleSchema.parse(
    await installPlanningSkill(pool, actorId, command, preview),
  );
}
export async function installPlanningSkill(
  pool: DatabasePool,
  actorId: string,
  command: InstallPlanningSkillCommand | InstallGitHubPlanningSkillCommand,
  input: PlanningSkillBundle,
): Promise<PlanningSkillBundle> {
  const bundle = PlanningSkillBundleSchema.parse(input);
  const candidateId = bundle.source.candidateId;
  if (
    "digest" in command
      ? bundle.source.kind !== "github" || bundle.contentDigest !== command.digest
      : bundle.source.kind !== "host" || candidateId !== command.candidateId
  )
    throw new FactoryError("conflict", "The retained Skill does not match this import request");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One short catalog transaction also serializes aliases and concurrent imports.
    await client.query("SELECT pg_advisory_xact_lock(77369229)");
    const existing = await readPlanningSkillInstall(client, actorId, command);
    if (existing !== null) {
      await client.query("COMMIT");
      return existing;
    }
    const sameName = await client.query<{ source_candidate_id: string }>(
      "SELECT source_candidate_id FROM factory_planning_skill_catalog WHERE name = $1",
      [bundle.name],
    );
    if (sameName.rows[0] !== undefined && sameName.rows[0].source_candidate_id !== candidateId)
      throw new FactoryError(
        "conflict",
        `A Skill named ${bundle.name} is already installed from another source. Use its retained version or choose a different Skill.`,
      );
    const count = await client.query<{ count: string }>(
      "SELECT count(*) FROM factory_planning_skill_catalog",
    );
    if (sameName.rows[0] === undefined && Number(count.rows[0]?.count) >= 200)
      throw new FactoryError(
        "conflict",
        "The installation catalog has reached its 200 Skill limit",
      );
    await client.query(
      "INSERT INTO factory_planning_skill_versions (digest, bundle) VALUES ($1,$2::jsonb) ON CONFLICT (digest) DO NOTHING",
      [bundle.contentDigest, JSON.stringify(bundle)],
    );
    await client.query(
      `INSERT INTO factory_planning_skill_catalog (name,digest,source_candidate_id) VALUES ($1,$2,$3)
      ON CONFLICT (name) DO UPDATE SET digest = EXCLUDED.digest, updated_at = clock_timestamp()`,
      [bundle.name, bundle.contentDigest, candidateId],
    );
    await client.query(
      "INSERT INTO factory_planning_skill_installs (actor_id,request_id,candidate_id,digest) VALUES ($1,$2,$3,$4)",
      [actorId, command.requestId, candidateId, bundle.contentDigest],
    );
    const retained = await readPlanningSkill(client, bundle.contentDigest);
    await client.query("COMMIT");
    return retained;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function planningSkillSelection(
  reader: Reader,
  featureId: string,
  version: number,
): Promise<FeaturePlanningSkills> {
  if (version === 0) return { schemaVersion: 1, version: 0, skills: [] };
  const result = await reader.query<{ digests: unknown }>(
    "SELECT digests FROM factory_feature_skill_selections WHERE feature_id = $1 AND version = $2",
    [featureId, version],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new FactoryError("not_found", "The retained Skill selection is unavailable");
  return {
    schemaVersion: 1,
    version,
    skills: (await readPlanningSkills(reader, row.digests)).map(skillSummary),
  };
}
export async function readFeaturePlanningSkills(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
): Promise<FeaturePlanningSkills> {
  return withFactoryFeature(pool, projectId, featureId, (client, row) =>
    planningSkillSelection(client, featureId, row.skill_selection_version),
  );
}
export async function saveFeaturePlanningSkills(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  command: SelectPlanningSkillsCommand,
): Promise<FeaturePlanningSkills> {
  return withFactoryFeature(pool, projectId, featureId, async (client, row) => {
    const existing = await client.query<{ version: number; digests: unknown }>(
      "SELECT version,digests FROM factory_feature_skill_selections WHERE feature_id = $1 AND request_id = $2",
      [featureId, command.requestId],
    );
    const previous = existing.rows[0];
    if (previous !== undefined) {
      if (
        previous.version !== command.expectedVersion + 1 ||
        JSON.stringify(previous.digests) !== JSON.stringify(command.digests)
      )
        throw new FactoryError("conflict");
      return planningSkillSelection(client, featureId, previous.version);
    }
    if (
      row.state !== "planning" ||
      row.skill_selection_version !== command.expectedVersion ||
      command.expectedVersion >= 1000
    )
      throw new FactoryError(
        "conflict",
        "Planning or the Skill selection changed. Refresh the chat before selecting Skills.",
      );
    const active = await client.query(
      "SELECT id FROM factory_planning_turns WHERE feature_id = $1 AND state IN ('queued','running')",
      [featureId],
    );
    if (active.rowCount !== 0)
      throw new FactoryError(
        "conflict",
        "Wait for the current planning reply before changing Skills",
      );
    const digests = PlanningSkillDigestsSchema.parse(command.digests);
    await requireInstalledPlanningSkills(client, digests);
    const skills = await readPlanningSkills(client, digests);
    const version = command.expectedVersion + 1;
    await client.query(
      "INSERT INTO factory_feature_skill_selections (feature_id,version,request_id,digests) VALUES ($1,$2,$3,$4::jsonb)",
      [featureId, version, command.requestId, JSON.stringify(command.digests)],
    );
    await client.query(
      "UPDATE factory_features SET skill_selection_version = $2, runtime_thread_id = NULL, updated_at = clock_timestamp() WHERE id = $1",
      [featureId, version],
    );
    return { schemaVersion: 1, version, skills: skills.map(skillSummary) };
  });
}

async function requireInstalledPlanningSkills(
  client: PoolClient,
  digests: string[],
): Promise<void> {
  if (digests.length === 0) return;
  const installed = await client.query<{ digest: string }>(
    "SELECT DISTINCT digest FROM factory_planning_skill_installs WHERE digest = ANY($1::text[])",
    [digests],
  );
  if (installed.rows.length !== digests.length)
    throw new FactoryError(
      "conflict",
      "Install the previewed Skill before selecting it for planning",
    );
}

export async function resolvePlanningSkillInvocation(
  client: PoolClient,
  text: string,
  selected: string[],
): Promise<string[]> {
  const names = [...text.matchAll(/(?:^|\s)[/$]([a-z0-9][a-z0-9-]{0,63})(?=\s|$|[.,!?])/gu)]
    .map((match) => match[1])
    .filter((name) => name !== undefined);
  const digests = [...selected];
  const explicitSkills = await readPlanningSkills(client, selected);
  for (const name of new Set(names)) {
    if (explicitSkills.some((skill) => skill.name === name)) continue;
    const result = await client.query<{ digest: string }>(
      "SELECT digest FROM factory_planning_skill_catalog WHERE name = $1",
      [name],
    );
    const installed = result.rows[0];
    if (installed === undefined)
      throw new FactoryError(
        "conflict",
        `The Skill ${name} is not installed. Open Skills to import or select an installed procedure.`,
      );
    if (!digests.includes(installed.digest)) digests.push(installed.digest);
  }
  if (digests.length > 8)
    throw new FactoryError("conflict", "Select at most eight Skills for one planning turn");
  await requireInstalledPlanningSkills(client, digests);
  await readPlanningSkills(client, digests);
  return digests;
}
