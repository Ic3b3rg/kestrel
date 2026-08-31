import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import {
  ReviewPreparationSchema,
  ReviewWorkflowAcceptedSchema,
  StartReviewWorkflowCommandSchema,
  type ChangeProposal,
  type Project,
  type ReviewAnalysisConfiguration,
  type ReviewPreparation,
  type ReviewPreparationBlocker,
  type ReviewProviderObservation,
  type ReviewResourceEnvelope,
  type ReviewWorkflowAccepted,
  type StartReviewWorkflowCommand,
} from "@kestrel/contracts";

import { appendAuditRecordInTransaction } from "./audit.js";
import type { DatabasePool } from "./pool.js";
import { readProject, readProjectInTransaction } from "./projects.js";

export interface ReviewExecutionProfile {
  analysisConfiguration: ReviewAnalysisConfiguration | null;
  resourceEnvelope: ReviewResourceEnvelope | null;
}

export interface ReadReviewPreparationInput {
  actorId: string;
  changeProposalId: string;
  projectId: string;
}

export interface StartReviewWorkflowInput extends ReadReviewPreparationInput {
  command: StartReviewWorkflowCommand;
  correlationId: string;
}

export type ReviewWorkflowPersistenceErrorCode = "not_found" | "not_ready" | "preparation_conflict";

export class ReviewWorkflowPersistenceError extends Error {
  constructor(public readonly code: ReviewWorkflowPersistenceErrorCode) {
    super(`Review Workflow persistence failed: ${code}`);
    this.name = "ReviewWorkflowPersistenceError";
  }
}

interface InsertedWorkflowRow {
  id: string;
  requested_at: Date;
}

function exactAvailableRevision(proposal: ChangeProposal) {
  return proposal.reviewRevisions.find(
    (revision) =>
      revision.state === "available" &&
      revision.base.objectId === proposal.base.objectId &&
      revision.head.objectId === proposal.head.objectId,
  );
}

function observedSource(
  project: Project,
  proposal: ChangeProposal,
): ReviewProviderObservation | null {
  if (
    proposal.kind !== "provider_observed" ||
    project.providerObservation === null ||
    project.repository === null
  ) {
    return null;
  }
  return {
    route: project.providerObservation,
    repository: project.repository,
    proposal: {
      canonicalUrl: proposal.canonicalUrl,
      number: proposal.number,
      observedAt: proposal.observedAt,
      providerId: proposal.providerId,
    },
  };
}

type ReviewDigestInputs = Pick<
  ReviewPreparation,
  | "projectId"
  | "changeProposalId"
  | "reviewRevision"
  | "changeIntent"
  | "analysisConfiguration"
  | "authority"
  | "resourceEnvelope"
>;

function digestReviewInputs(preparation: ReviewDigestInputs): string {
  const revision = preparation.reviewRevision;
  const intent = preparation.changeIntent;
  if (
    revision === null ||
    intent === null ||
    preparation.analysisConfiguration === null ||
    preparation.authority.state !== "available" ||
    preparation.resourceEnvelope === null
  ) {
    throw new ReviewWorkflowPersistenceError("not_ready");
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectId: preparation.projectId,
        changeProposalId: preparation.changeProposalId,
        reviewRevision: {
          id: revision.id,
          objectFormat: revision.objectFormat,
          base: revision.base,
          head: revision.head,
        },
        changeIntent: {
          id: intent.id,
          version: intent.version,
          sourceDigest: intent.sourceDigest,
        },
        analysisConfiguration: {
          id: preparation.analysisConfiguration.id,
          version: preparation.analysisConfiguration.version,
          displayName: preparation.analysisConfiguration.displayName,
          modelRoute: preparation.analysisConfiguration.modelRoute,
          digest: preparation.analysisConfiguration.digest,
        },
        authority: {
          action: preparation.authority.action,
          operatorId: preparation.authority.operatorId,
          state: preparation.authority.state,
        },
        resourceEnvelope: {
          id: preparation.resourceEnvelope.id,
          version: preparation.resourceEnvelope.version,
          displayName: preparation.resourceEnvelope.displayName,
          digest: preparation.resourceEnvelope.digest,
        },
      }),
      "utf8",
    )
    .digest("hex");
}

function buildReviewPreparation(
  project: Project,
  proposal: ChangeProposal,
  actorId: string,
  profile: ReviewExecutionProfile,
): ReviewPreparation {
  const exactRevision = exactAvailableRevision(proposal);
  const availableRevision = proposal.reviewRevisions.find(({ state }) => state === "available");
  const reviewRevision = exactRevision ?? availableRevision ?? proposal.reviewRevisions[0] ?? null;
  const changeIntent = proposal.changeIntent;
  const blockers: ReviewPreparationBlocker[] = [];
  if (availableRevision === undefined) blockers.push("revision_not_available");
  else if (exactRevision === undefined) blockers.push("revision_identity_incoherent");
  if (changeIntent === null || changeIntent.resolution.state !== "resolved") {
    blockers.push("change_intent_not_resolved");
  }
  if (profile.analysisConfiguration === null) blockers.push("model_route_not_available");
  if (profile.resourceEnvelope === null) blockers.push("resource_envelope_not_available");

  const base = {
    schemaVersion: 1 as const,
    projectId: project.id,
    changeProposalId: proposal.id,
    proposal: { version: proposal.version, base: proposal.base, head: proposal.head },
    reviewRevision,
    changeIntent,
    source: {
      localRepositorySource: project.localRepositorySource,
      providerObservation: observedSource(project, proposal),
    },
    analysisConfiguration: profile.analysisConfiguration,
    authority: {
      action: "start_review" as const,
      operatorId: actorId,
      state: "available" as const,
    },
    resourceEnvelope: profile.resourceEnvelope,
    readiness: blockers.length === 0 ? ("ready" as const) : ("blocked" as const),
    blockers,
    preparationDigest: null,
  };
  if (blockers.length !== 0) return ReviewPreparationSchema.parse(base);

  return ReviewPreparationSchema.parse({
    ...base,
    preparationDigest: digestReviewInputs(base),
  });
}

function findProposal(project: Project, changeProposalId: string): ChangeProposal {
  const proposal = project.changeProposals.find(({ id }) => id === changeProposalId);
  if (proposal === undefined) throw new ReviewWorkflowPersistenceError("not_found");
  return proposal;
}

export async function readReviewPreparation(
  pool: DatabasePool,
  input: ReadReviewPreparationInput,
  profile: ReviewExecutionProfile,
): Promise<ReviewPreparation> {
  const project = await readProject(pool, input.projectId);
  return buildReviewPreparation(
    project,
    findProposal(project, input.changeProposalId),
    input.actorId,
    profile,
  );
}

async function lockReviewInputs(
  client: PoolClient,
  input: ReadReviewPreparationInput,
): Promise<{ projectId: string; proposalId: string }> {
  // Change Intent creation and Review Revision acquisition both lock the canonical proposal.
  // Available revisions and persisted intents are immutable, so this one lock closes the input race.
  const target = await client.query<{
    canonical_project_id: string;
    canonical_proposal_id: string;
  }>(
    `
      SELECT project.id AS canonical_project_id,
             proposal.id AS canonical_proposal_id
      FROM projects AS requested_project
      INNER JOIN projects AS project
        ON project.id = COALESCE(requested_project.canonical_project_id, requested_project.id)
      INNER JOIN change_proposals AS requested_proposal
        ON requested_proposal.id = $2
      INNER JOIN change_proposals AS proposal
        ON proposal.id = COALESCE(
          requested_proposal.canonical_change_proposal_id,
          requested_proposal.id
        )
       AND proposal.project_id = project.id
      INNER JOIN operators AS operator ON operator.id = $3
      WHERE requested_project.id = $1
      FOR UPDATE OF project, proposal
    `,
    [input.projectId, input.changeProposalId, input.actorId],
  );
  const row = target.rows[0];
  if (target.rowCount !== 1 || row === undefined) {
    throw new ReviewWorkflowPersistenceError("not_found");
  }

  return { projectId: row.canonical_project_id, proposalId: row.canonical_proposal_id };
}

export async function startReviewWorkflow(
  pool: DatabasePool,
  input: StartReviewWorkflowInput,
  profile: ReviewExecutionProfile,
): Promise<ReviewWorkflowAccepted> {
  const command = StartReviewWorkflowCommandSchema.parse(input.command);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await lockReviewInputs(client, input);
    const project = await readProjectInTransaction(client, target.projectId);
    const preparation = buildReviewPreparation(
      project,
      findProposal(project, target.proposalId),
      input.actorId,
      profile,
    );
    if (preparation.readiness !== "ready" || preparation.preparationDigest === null) {
      throw new ReviewWorkflowPersistenceError("not_ready");
    }
    if (preparation.preparationDigest !== command.preparationDigest) {
      throw new ReviewWorkflowPersistenceError("preparation_conflict");
    }
    const revision = preparation.reviewRevision;
    const intent = preparation.changeIntent;
    const analysisConfiguration = preparation.analysisConfiguration;
    const resource = preparation.resourceEnvelope;
    if (
      revision === null ||
      intent === null ||
      analysisConfiguration === null ||
      resource === null
    ) {
      throw new ReviewWorkflowPersistenceError("not_ready");
    }

    const inserted = await client.query<InsertedWorkflowRow>(
      `
        INSERT INTO review_workflows (
          project_id,
          change_proposal_id,
          review_revision_id,
          change_intent_id,
          requested_by_operator_id,
          input_digest,
          analysis_configuration,
          authority,
          resource_envelope,
          workflow_state
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, 'queued')
        ON CONFLICT (change_proposal_id, input_digest) DO NOTHING
        RETURNING id, requested_at
      `,
      [
        preparation.projectId,
        preparation.changeProposalId,
        revision.id,
        intent.id,
        input.actorId,
        preparation.preparationDigest,
        JSON.stringify(analysisConfiguration),
        JSON.stringify(preparation.authority),
        JSON.stringify(resource),
      ],
    );
    const created = inserted.rowCount === 1;
    let row = inserted.rows[0];
    if (!created) {
      const existing = await client.query<InsertedWorkflowRow>(
        `
          SELECT id, requested_at
          FROM review_workflows
          WHERE change_proposal_id = $1 AND input_digest = $2
        `,
        [preparation.changeProposalId, preparation.preparationDigest],
      );
      row = existing.rows[0];
    }
    if (row === undefined) throw new Error("Review Workflow could not be frozen or re-read");
    if (created) {
      await appendAuditRecordInTransaction(client, {
        actorId: input.actorId,
        actorType: "operator",
        causationId: null,
        correlationId: input.correlationId,
        denialReason: null,
        eventType: "review_workflow.started",
        facts: {
          analysisConfigurationVersion: analysisConfiguration.version,
          resourceEnvelopeVersion: resource.version,
        },
        outcome: "succeeded",
        targetId: row.id,
        targetType: "review_workflow",
      });
    }
    const accepted = ReviewWorkflowAcceptedSchema.parse({
      schemaVersion: 1,
      workflow: {
        id: row.id,
        projectId: preparation.projectId,
        changeProposalId: preparation.changeProposalId,
        reviewRevisionId: revision.id,
        changeIntentId: intent.id,
        inputDigest: preparation.preparationDigest,
        analysisConfiguration,
        authority: preparation.authority,
        resourceEnvelope: resource,
        state: "queued",
        requestedAt: row.requested_at.toISOString(),
      },
    });
    await client.query("COMMIT");
    return accepted;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
