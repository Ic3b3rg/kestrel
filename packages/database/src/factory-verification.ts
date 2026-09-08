import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  FactoryFeatureVerificationSchema,
  FactoryVerificationManifestSchema,
  FactoryExecutionRevisionSchema,
  FactoryAcceptedVerificationCommandsSchema,
  type FactoryExecutionRevision,
  type FeaturePlanDocument,
} from "@kestrel/contracts";
import { FactoryError } from "./factory-planning.js";

/** A nullable historical source is not rebound: its retained checkpoint must prove the same workspace lineage. */
export async function factoryWorkItemsVerified(
  client: PoolClient,
  featureId: string,
  version: number,
  plan: FeaturePlanDocument,
  source: { repositoryId: string; identity: string },
  revision: FactoryExecutionRevision,
): Promise<boolean> {
  const items = await client.query<{
    key: string;
    board_column: string;
    state: string | null;
    reservation_released_at: Date | null;
    has_pending_container: boolean;
    source: unknown;
    revision: unknown;
    accepted_commands: unknown;
  }>(
    `SELECT item.key, item.board_column, run.state, run.reservation_released_at, run.source, run.revision, run.accepted_commands,
       EXISTS (SELECT 1 FROM factory_execution_containers container WHERE container.run_id = run.id AND container.stopped_at IS NULL) AS has_pending_container
     FROM factory_work_items item LEFT JOIN LATERAL (
       SELECT * FROM factory_execution_runs WHERE work_item_id = item.id AND feature_id = item.feature_id
         AND plan_version = $2 AND purpose = 'work_item' ORDER BY attempt DESC LIMIT 1
     ) run ON true WHERE item.feature_id = $1 AND item.plan_version = $2 ORDER BY item.position`,
    [featureId, version],
  );
  return (
    items.rows.length === plan.workItems.length &&
    items.rows.every((item, index) => {
      const checkpoint = FactoryExecutionRevisionSchema.safeParse(item.revision);
      const commands = FactoryAcceptedVerificationCommandsSchema.safeParse(item.accepted_commands);
      const origin = FactoryFeatureVerificationSchema.shape.source
        .nullable()
        .safeParse(item.source);
      return (
        item.key === plan.workItems[index]?.key &&
        item.state === "verified" &&
        item.reservation_released_at != null &&
        !item.has_pending_container &&
        ["in_review", "completed"].includes(item.board_column) &&
        checkpoint.success &&
        checkpoint.data.baseCommitId === revision.baseCommitId &&
        checkpoint.data.branch === revision.branch &&
        commands.success &&
        JSON.stringify(commands.data) === JSON.stringify(plan.workItems[index].verification) &&
        origin.success &&
        (origin.data === null ||
          (origin.data.repositoryId === source.repositoryId &&
            origin.data.identity === source.identity))
      );
    })
  );
}

export async function readCurrentFactoryFeatureVerification(
  client: PoolClient,
  featureId: string,
  version: number | null,
  revision: FactoryExecutionRevision | null,
) {
  if (version === null || revision === null) return null;
  const result = await client.query<{
    id: string;
    feature_id: string;
    plan_version: number;
    run_id: string;
    source: unknown;
    revision: unknown;
    manifest: unknown;
    manifest_digest: string;
    evidence_ids: string[];
    created_at: Date;
  }>(
    "SELECT * FROM factory_feature_verifications WHERE feature_id = $1 AND plan_version = $2 AND revision = $3::jsonb ORDER BY created_at DESC, id DESC LIMIT 1",
    [featureId, version, JSON.stringify(revision)],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : FactoryFeatureVerificationSchema.parse({
        id: row.id,
        featureId: row.feature_id,
        approvedVersion: row.plan_version,
        runId: row.run_id,
        source: row.source,
        revision: row.revision,
        manifest: row.manifest,
        manifestDigest: row.manifest_digest,
        evidenceIds: row.evidence_ids,
        createdAt: row.created_at.toISOString(),
      });
}

/** The caller holds Feature/run locks and has checked the complete current pass and stop proofs. */
export async function persistFactoryFeatureVerification(
  client: PoolClient,
  run: {
    id: string;
    feature_id: string;
    plan_version: number;
    source: unknown;
    revision: unknown;
    verification_manifest: unknown;
  },
  evidenceIds: string[],
) {
  const manifest = FactoryVerificationManifestSchema.parse(run.verification_manifest);
  const source = FactoryFeatureVerificationSchema.shape.source.parse(run.source);
  const revision = FactoryExecutionRevisionSchema.parse(run.revision);
  if (evidenceIds.length !== manifest.length || new Set(evidenceIds).size !== manifest.length)
    throw new FactoryError("conflict");
  await client.query(
    `INSERT INTO factory_feature_verifications (feature_id,plan_version,run_id,source,revision,manifest,manifest_digest,evidence_ids)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8::uuid[])`,
    [
      run.feature_id,
      run.plan_version,
      run.id,
      JSON.stringify(source),
      JSON.stringify(revision),
      JSON.stringify(manifest),
      createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
      evidenceIds,
    ],
  );
}
