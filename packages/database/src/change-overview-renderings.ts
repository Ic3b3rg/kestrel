import {
  ChangeOverviewModelRenderingSentenceSchema,
  ChangeOverviewSourceFactsSchema,
  CorrelationIdSchema,
  GitObjectIdSchema,
  KestrelIdSchema,
  type ChangeOverviewModelRenderingSentence,
  type ChangeOverviewSourceFacts,
} from "@kestrel/contracts";
import type { PgBoss } from "pg-boss";
import type { PoolClient } from "pg";
import { z } from "zod";

import { CHANGE_OVERVIEW_RENDER_QUEUE, pgBossDatabase } from "./pg-boss.js";
import type { DatabasePool } from "./pool.js";

const ChangeOverviewRenderingJobSchema = z.strictObject({
  changeProposalId: KestrelIdSchema,
  correlationId: CorrelationIdSchema,
  exactHeadObjectId: GitObjectIdSchema,
  generationToken: KestrelIdSchema,
  projectId: KestrelIdSchema,
  reviewRevisionId: KestrelIdSchema,
});

export type ChangeOverviewRenderingJob = z.infer<typeof ChangeOverviewRenderingJobSchema>;
export type ChangeOverviewRenderingJobCoordinator = Pick<PgBoss, "upsert">;

export interface EnqueueChangeOverviewRenderingInput {
  correlationId: string;
  projectId: string;
  revisionId: string;
}

interface QueuedRenderingRow {
  change_proposal_id: string;
  exact_head_object_id: string;
  generation_token: string;
  project_id: string;
  review_revision_id: string;
}

interface ClaimedRenderingRow {
  base_commit_author_snapshot: string | null;
  base_commit_subject_snapshot: string | null;
  base_object_id: string;
  base_ref_snapshot: string;
  head_commit_author_snapshot: string | null;
  head_commit_subject_snapshot: string | null;
  head_object_id: string;
  head_ref_snapshot: string;
  object_format: "sha1" | "sha256";
  project_id: string;
  requested_at: Date;
  source_facts: unknown;
  started_at: Date;
}

export interface ClaimedChangeOverviewRendering {
  exactRevision: {
    objectFormat: "sha1" | "sha256";
    base: { author: string | null; objectId: string; ref: string; subject: string | null };
    head: { author: string | null; objectId: string; ref: string; subject: string | null };
  };
  projectId: string;
  queueMilliseconds: number;
  requestedAt: Date;
  sourceFacts: ChangeOverviewSourceFacts;
  startedAt: Date;
}

type ChangeOverviewRenderingFailureReason =
  | "credential_unavailable"
  | "invalid_rendering"
  | "model_unavailable"
  | "profile_not_configured"
  | "profile_unavailable"
  | "timed_out";

interface ChangeOverviewRenderingCompletionTiming {
  kestrelMilliseconds: number;
  modelMilliseconds: number;
  queueMilliseconds: number;
}

export type CompleteChangeOverviewRenderingOutcome =
  | (ChangeOverviewRenderingCompletionTiming & {
      kind: "ready";
      providerRequestId: string;
      sentences: readonly ChangeOverviewModelRenderingSentence[];
    })
  | (ChangeOverviewRenderingCompletionTiming & {
      kind: "unavailable";
      reason: ChangeOverviewRenderingFailureReason;
    });

export function parseChangeOverviewRenderingJob(data: unknown): ChangeOverviewRenderingJob {
  return ChangeOverviewRenderingJobSchema.parse(data);
}

export async function enqueueChangeOverviewRendering(
  client: PoolClient,
  coordinator: ChangeOverviewRenderingJobCoordinator,
  input: EnqueueChangeOverviewRenderingInput,
): Promise<boolean> {
  const result = await client.query<QueuedRenderingRow>(
    `
      WITH target AS (
        SELECT revision.id AS review_revision_id,
               revision.project_id,
               canonical.id AS change_proposal_id,
               revision.head_object_id AS exact_head_object_id
        FROM review_revisions AS revision
        INNER JOIN change_proposals AS storage
          ON storage.id = revision.change_proposal_id
        INNER JOIN change_proposals AS canonical
          ON canonical.id = COALESCE(storage.canonical_change_proposal_id, storage.id)
        WHERE revision.id = $1
          AND revision.project_id = $2
          AND revision.revision_state = 'available'
          AND revision.head_object_id = canonical.head_object_id
        FOR UPDATE OF canonical
      )
      INSERT INTO change_overview_renderings AS rendering (
        change_proposal_id,
        review_revision_id,
        exact_head_object_id,
        generation_token,
        rendering_state
      )
      SELECT target.change_proposal_id,
             target.review_revision_id,
             target.exact_head_object_id,
             uuidv7(),
             'queued'
      FROM target
      ON CONFLICT (change_proposal_id) DO UPDATE
      SET review_revision_id = EXCLUDED.review_revision_id,
          exact_head_object_id = EXCLUDED.exact_head_object_id,
          generation_token = EXCLUDED.generation_token,
          rendering_state = 'queued',
          requested_at = clock_timestamp(),
          started_at = NULL,
          completed_at = NULL,
          provider_request_id = NULL,
          sentences = NULL,
          failure_reason = NULL,
          queue_milliseconds = NULL,
          model_milliseconds = NULL,
          kestrel_milliseconds = NULL,
          total_milliseconds = NULL,
          updated_at = clock_timestamp()
      WHERE rendering.exact_head_object_id IS DISTINCT FROM EXCLUDED.exact_head_object_id
      RETURNING change_proposal_id,
                review_revision_id,
                exact_head_object_id,
                generation_token,
                (SELECT project_id FROM target) AS project_id
    `,
    [KestrelIdSchema.parse(input.revisionId), KestrelIdSchema.parse(input.projectId)],
  );
  if (result.rowCount === 0) return false;
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) {
    throw new Error("Change Overview rendering generation was not coalesced");
  }
  const job = ChangeOverviewRenderingJobSchema.parse({
    changeProposalId: row.change_proposal_id,
    correlationId: input.correlationId,
    exactHeadObjectId: row.exact_head_object_id,
    generationToken: row.generation_token,
    projectId: row.project_id,
    reviewRevisionId: row.review_revision_id,
  });
  const upserted = await coordinator.upsert(CHANGE_OVERVIEW_RENDER_QUEUE, job, {
    db: pgBossDatabase(client),
    priority: -10,
    singletonKey: job.changeProposalId,
  });
  if (upserted.jobs.length !== 1 || upserted.inserted + upserted.updated !== 1) {
    throw new Error("Change Overview rendering job was not durably coalesced");
  }
  return true;
}

export async function claimChangeOverviewRendering(
  pool: DatabasePool,
  job: ChangeOverviewRenderingJob,
): Promise<ClaimedChangeOverviewRendering | null> {
  const result = await pool.query<ClaimedRenderingRow>(
    `
      WITH claimed AS (
        UPDATE change_overview_renderings AS rendering
        SET rendering_state = 'rendering',
            started_at = clock_timestamp(),
            updated_at = clock_timestamp()
        FROM change_proposals AS canonical
        WHERE rendering.change_proposal_id = $1
          AND rendering.review_revision_id = $2
          AND rendering.exact_head_object_id = $3
          AND rendering.generation_token = $4
          AND rendering.rendering_state = 'queued'
          AND canonical.id = rendering.change_proposal_id
          AND canonical.head_object_id = $3
        RETURNING rendering.requested_at, rendering.started_at
      )
      SELECT revision.project_id,
             revision.object_format,
             revision.base_ref_snapshot,
             revision.base_object_id,
             revision.base_commit_author_snapshot,
             revision.base_commit_subject_snapshot,
             revision.head_ref_snapshot,
             revision.head_object_id,
             revision.head_commit_author_snapshot,
             revision.head_commit_subject_snapshot,
             overview.source_facts,
             claimed.requested_at,
             claimed.started_at
      FROM claimed
      INNER JOIN review_revisions AS revision
        ON revision.id = $2
       AND revision.project_id = $5
       AND revision.revision_state = 'available'
       AND revision.head_object_id = $3
      INNER JOIN change_proposals AS storage
        ON storage.id = revision.change_proposal_id
       AND COALESCE(storage.canonical_change_proposal_id, storage.id) = $1
      INNER JOIN change_overview_fact_manifests AS overview
        ON overview.review_revision_id = revision.id
    `,
    [
      job.changeProposalId,
      job.reviewRevisionId,
      job.exactHeadObjectId,
      job.generationToken,
      job.projectId,
    ],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) {
    throw new Error("Change Overview rendering claim is ambiguous");
  }
  const requestedAt = row.requested_at;
  const startedAt = row.started_at;
  const queueMilliseconds = startedAt.getTime() - requestedAt.getTime();
  if (
    KestrelIdSchema.parse(row.project_id) !== job.projectId ||
    !Number.isSafeInteger(queueMilliseconds) ||
    queueMilliseconds < 0
  ) {
    throw new Error("Change Overview rendering claim is inconsistent");
  }
  return {
    exactRevision: {
      objectFormat: row.object_format,
      base: {
        author: row.base_commit_author_snapshot,
        objectId: row.base_object_id,
        ref: row.base_ref_snapshot,
        subject: row.base_commit_subject_snapshot,
      },
      head: {
        author: row.head_commit_author_snapshot,
        objectId: row.head_object_id,
        ref: row.head_ref_snapshot,
        subject: row.head_commit_subject_snapshot,
      },
    },
    projectId: row.project_id,
    queueMilliseconds,
    requestedAt,
    sourceFacts: ChangeOverviewSourceFactsSchema.parse(row.source_facts),
    startedAt,
  };
}

function validateMilliseconds(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error("Change Overview rendering timing is invalid");
  }
  return value;
}

export async function completeChangeOverviewRendering(
  pool: DatabasePool,
  job: ChangeOverviewRenderingJob,
  outcome: CompleteChangeOverviewRenderingOutcome,
): Promise<boolean> {
  const queueMilliseconds = validateMilliseconds(outcome.queueMilliseconds, 86_400_000);
  const modelMilliseconds = validateMilliseconds(outcome.modelMilliseconds, 120_000);
  const kestrelMilliseconds = validateMilliseconds(outcome.kestrelMilliseconds, 120_000);
  const totalMilliseconds = queueMilliseconds + modelMilliseconds + kestrelMilliseconds;
  const sentences =
    outcome.kind === "ready"
      ? ChangeOverviewModelRenderingSentenceSchema.array().min(1).max(4).parse(outcome.sentences)
      : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const completed = await client.query<{ change_proposal_id: string }>(
      `
        UPDATE change_overview_renderings AS rendering
        SET rendering_state = $5,
            completed_at = clock_timestamp(),
            provider_request_id = $6,
            sentences = $7::jsonb,
            failure_reason = $8,
            queue_milliseconds = $9,
            model_milliseconds = $10,
            kestrel_milliseconds = $11,
            total_milliseconds = $12,
            updated_at = clock_timestamp()
        FROM change_proposals AS canonical
        WHERE rendering.change_proposal_id = $1
          AND rendering.review_revision_id = $2
          AND rendering.exact_head_object_id = $3
          AND rendering.generation_token = $4
          AND rendering.rendering_state = 'rendering'
          AND canonical.id = rendering.change_proposal_id
          AND canonical.head_object_id = $3
          AND EXISTS (
            SELECT 1
            FROM review_revisions AS revision
            INNER JOIN change_proposals AS storage
              ON storage.id = revision.change_proposal_id
            WHERE revision.id = $2
              AND revision.project_id = $13
              AND revision.revision_state = 'available'
              AND revision.head_object_id = $3
              AND COALESCE(storage.canonical_change_proposal_id, storage.id) = $1
          )
        RETURNING rendering.change_proposal_id
      `,
      [
        job.changeProposalId,
        job.reviewRevisionId,
        job.exactHeadObjectId,
        job.generationToken,
        outcome.kind === "ready" ? "ready" : "unavailable",
        outcome.kind === "ready" ? outcome.providerRequestId : null,
        sentences === null ? null : JSON.stringify(sentences),
        outcome.kind === "unavailable" ? outcome.reason : null,
        queueMilliseconds,
        modelMilliseconds,
        kestrelMilliseconds,
        totalMilliseconds,
        job.projectId,
      ],
    );
    if (completed.rowCount === 0) {
      await client.query("COMMIT");
      return false;
    }
    if (
      completed.rowCount !== 1 ||
      completed.rows[0]?.change_proposal_id !== job.changeProposalId
    ) {
      throw new Error("Change Overview rendering completion is ambiguous");
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
