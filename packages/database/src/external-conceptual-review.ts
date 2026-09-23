import { createHash } from "node:crypto";

import {
  ExternalConceptualReviewPreparationSchema,
  type ChangeIntentSource,
  type ConceptualReviewIntentKind,
  type FactoryConceptualReviewBlocker,
  type ExternalConceptualReviewPreparation,
  type Project,
  type ProviderObservedChangeProposal,
} from "@kestrel/contracts";

import {
  CONCEPTUAL_REVIEW_RESOURCES,
  CONCEPTUAL_REVIEW_RUNTIME_POLICY,
  type FactoryConceptualReviewRuntimeReadiness,
} from "./factory-conceptual-review.js";
import type { DatabasePool } from "./pool.js";
import { readProject } from "./projects.js";
import { FactoryConceptualReviewPersistenceError } from "./factory-conceptual-review.js";

export interface VerifiedExternalConceptualReviewSource {
  revisionId: string;
  manifestDigest: string;
  headTreeId: string;
}

export interface ExternalConceptualReviewSourceReference {
  projectId: string;
  changeProposalId: string;
  revisionId: string;
  artifactLocator: string;
  manifestDigest: string;
  baseCommitId: string;
  headCommitId: string;
}

interface ExternalConceptualReviewMetadataRow {
  project_id: string;
  change_proposal_id: string;
  revision_id: string | null;
  artifact_locator: string | null;
  manifest_digest: string | null;
  base_object_id: string;
  head_object_id: string;
  selected_model_id: string | null;
}

const externalConceptualReviewMetadataQuery = `
  SELECT project.id AS project_id, proposal.id AS change_proposal_id,
    revision.id AS revision_id, revision.artifact_locator, revision.manifest_digest,
    proposal.base_object_id, proposal.head_object_id, model.selected_model_id
  FROM projects AS requested_project
  JOIN projects AS project
    ON project.id = COALESCE(requested_project.canonical_project_id, requested_project.id)
  JOIN change_proposals AS requested_proposal ON requested_proposal.id = $2
  JOIN change_proposals AS proposal
    ON proposal.id = COALESCE(
      requested_proposal.canonical_change_proposal_id,
      requested_proposal.id
    )
   AND proposal.project_id = project.id
   AND proposal.proposal_kind = 'provider_observed'
  LEFT JOIN LATERAL (
    SELECT retained.id, retained.artifact_locator, retained.manifest_digest
    FROM review_revisions AS retained
    JOIN change_proposals AS retained_proposal ON retained_proposal.id = retained.change_proposal_id
    WHERE retained.revision_state = 'available'
      AND retained.base_object_id = proposal.base_object_id
      AND retained.head_object_id = proposal.head_object_id
      AND COALESCE(retained_proposal.canonical_change_proposal_id, retained_proposal.id) = proposal.id
    ORDER BY retained.available_at DESC, retained.id DESC
    LIMIT 1
  ) AS revision ON true
  LEFT JOIN LATERAL (
    SELECT preference.selected_model_id
    FROM installations AS installation
    LEFT JOIN codex_review_model_preferences AS preference
      ON preference.installation_id = installation.id
    ORDER BY installation.created_at, installation.id
    LIMIT 1
  ) AS model ON true
  WHERE requested_project.id = $1
`;

async function readMetadata(
  pool: DatabasePool,
  projectId: string,
  changeProposalId: string,
): Promise<ExternalConceptualReviewMetadataRow> {
  const row = (
    await pool.query<ExternalConceptualReviewMetadataRow>(externalConceptualReviewMetadataQuery, [
      projectId,
      changeProposalId,
    ])
  ).rows[0];
  if (row === undefined) throw new FactoryConceptualReviewPersistenceError("not_found");
  return row;
}

function sourceReference(
  row: ExternalConceptualReviewMetadataRow,
): ExternalConceptualReviewSourceReference | null {
  if (
    row.revision_id === null ||
    row.artifact_locator === null ||
    row.manifest_digest === null ||
    !row.artifact_locator.endsWith(`/revisions/${row.revision_id}`) ||
    !/^[a-f0-9]{64}$/u.test(row.manifest_digest)
  ) {
    return null;
  }
  return {
    projectId: row.project_id,
    changeProposalId: row.change_proposal_id,
    revisionId: row.revision_id,
    artifactLocator: row.artifact_locator,
    manifestDigest: row.manifest_digest,
    baseCommitId: row.base_object_id,
    headCommitId: row.head_object_id,
  };
}

export async function readExternalConceptualReviewSourceReference(
  pool: DatabasePool,
  projectId: string,
  changeProposalId: string,
): Promise<ExternalConceptualReviewSourceReference | null> {
  return sourceReference(await readMetadata(pool, projectId, changeProposalId));
}

export async function readExternalConceptualReviewPreparation(
  pool: DatabasePool,
  projectId: string,
  changeProposalId: string,
  readiness: FactoryConceptualReviewRuntimeReadiness,
  verifiedSource: VerifiedExternalConceptualReviewSource | null,
): Promise<ExternalConceptualReviewPreparation> {
  const metadata = await readMetadata(pool, projectId, changeProposalId);
  const reference = sourceReference(metadata);
  const verified =
    reference !== null &&
    verifiedSource !== null &&
    verifiedSource.revisionId === reference.revisionId &&
    verifiedSource.manifestDigest === reference.manifestDigest
      ? verifiedSource
      : null;
  let project: Project;
  try {
    project = await readProject(pool, metadata.project_id, reference?.revisionId);
  } catch (error) {
    const exists = await pool.query<{ id: string }>("SELECT id FROM projects WHERE id = $1", [
      metadata.project_id,
    ]);
    if (exists.rowCount === 0) throw new FactoryConceptualReviewPersistenceError("not_found");
    throw error;
  }
  return buildExternalConceptualReviewPreparation({
    project,
    changeProposalId: metadata.change_proposal_id,
    selectedModelId: metadata.selected_model_id,
    verifiedSource: verified,
    runtimeProfile: readiness.profile,
    ...(readiness.lifecycleProfile === undefined
      ? {}
      : {
          lifecycleProfile: readiness.lifecycleProfile,
          profileBlocker: readiness.profileBlocker ?? null,
        }),
  });
}

export interface BuildExternalConceptualReviewPreparationInput {
  project: Project;
  changeProposalId: string;
  selectedModelId: string | null;
  verifiedSource: VerifiedExternalConceptualReviewSource | null;
  runtimeProfile: FactoryConceptualReviewRuntimeReadiness["profile"];
  lifecycleProfile?: FactoryConceptualReviewRuntimeReadiness["lifecycleProfile"];
  profileBlocker?: string | null;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function sourceIntent(source: ChangeIntentSource): ConceptualReviewIntentKind {
  if (source.kind === "operator_input" || source.kind === "approved_feature_plan") {
    return "operator_confirmed";
  }
  if (source.kind === "provider_field") return "pull_request_stated";
  return "inferred";
}

function strongestIntent(proposal: ProviderObservedChangeProposal): {
  kind: ConceptualReviewIntentKind;
  label: string;
} {
  const sources = proposal.changeIntent?.sources ?? [];
  for (const kind of ["operator_confirmed", "pull_request_stated", "inferred"] as const) {
    const source = sources.find((candidate) => sourceIntent(candidate) === kind);
    if (source !== undefined) return { kind, label: source.label };
  }
  return { kind: "pull_request_stated", label: "GitHub title" };
}

function intentLimitations(proposal: ProviderObservedChangeProposal): string[] {
  const intent = proposal.changeIntent;
  if (intent === null) return ["No Change Intent record is available for this pull request."];
  const limitations: string[] = [];
  if (intent.scopeBoundaries.length === 0) {
    limitations.push("No scope boundaries were confirmed by the Operator.");
  }
  if (intent.acceptanceOutcomes.length === 0) {
    limitations.push("No acceptance outcomes were confirmed by the Operator.");
  }
  if (!intent.sources.some(({ kind }) => kind === "operator_input")) {
    limitations.push(
      "The Operator has not confirmed this intent; it comes from the pull request or retained source.",
    );
  }
  for (const issue of intent.resolution.issues) {
    if (issue.kind === "ambiguous") limitations.push(`Ambiguous intent: ${issue.description}`);
    if (issue.kind === "contradictory") {
      limitations.push(`Contradictory intent: ${issue.description}`);
    }
  }
  return limitations;
}

function reviewBasis(proposal: ProviderObservedChangeProposal) {
  const intent = proposal.changeIntent;
  if (intent === null) return null;
  const authority = strongestIntent(proposal);
  const objective = intent.objective ?? proposal.title;
  const outcomes =
    intent.acceptanceOutcomes.length === 0
      ? [{ key: "stated_intent", outcome: objective, intent: authority }]
      : intent.acceptanceOutcomes.map((outcome, index) => ({
          key: `intent-${String(index + 1)}`,
          outcome,
          intent: authority,
        }));
  const sources = intent.sources.map((source) => ({
    kind: sourceIntent(source),
    label: source.label,
  }));
  if (sources.length === 0) {
    sources.push({ kind: "pull_request_stated" as const, label: "GitHub title" });
  }
  return {
    objective,
    scope: {
      includes:
        intent.scopeBoundaries.length === 0
          ? ["The exact pull request change"]
          : intent.scopeBoundaries,
      excludes: [],
    },
    outcomes,
    provenance: {
      kind: "change_intent" as const,
      changeIntentId: intent.id,
      version: intent.version,
      sourceDigest: intent.sourceDigest,
      resolution: intent.resolution.state,
      sources,
    },
    limitations: intentLimitations(proposal),
  };
}

function exactRevision(
  proposal: ProviderObservedChangeProposal,
  verified: VerifiedExternalConceptualReviewSource | null,
) {
  if (verified === null) return null;
  return (
    proposal.reviewRevisions.find(
      (revision) =>
        revision.id === verified.revisionId &&
        revision.state === "available" &&
        revision.base.objectId === proposal.base.objectId &&
        revision.head.objectId === proposal.head.objectId,
    ) ?? null
  );
}

export function buildExternalConceptualReviewPreparation(
  input: BuildExternalConceptualReviewPreparationInput,
): ExternalConceptualReviewPreparation {
  const proposal = input.project.changeProposals.find(
    (candidate): candidate is ProviderObservedChangeProposal =>
      candidate.id === input.changeProposalId && candidate.kind === "provider_observed",
  );
  if (proposal === undefined) throw new Error("External pull request is unavailable");
  const basis = reviewBasis(proposal);
  const revision = exactRevision(proposal, input.verifiedSource);
  const repository = input.project.repository;
  const publication =
    revision === null || input.verifiedSource === null || repository === null
      ? null
      : {
          kind: "external_pull_request" as const,
          pullRequest: {
            repository: {
              id: repository.providerId,
              owner: repository.owner,
              name: repository.name,
            },
            author: proposal.author?.login ?? null,
            number: proposal.number,
            url: proposal.canonicalUrl,
            state: proposal.proposalState,
            title: proposal.title,
            body: proposal.body ?? null,
            baseRef: proposal.base.ref,
            headRef: proposal.head.ref,
            baseCommitId: proposal.base.objectId,
            headCommitId: proposal.head.objectId,
          },
          revision,
          retainedManifestDigest: input.verifiedSource.manifestDigest,
          certificate: null,
        };
  const evidence =
    publication === null || input.verifiedSource === null
      ? null
      : {
          source: {
            baseCommitId: revision?.base.objectId,
            headCommitId: revision?.head.objectId,
            headTreeId: input.verifiedSource.headTreeId,
            retainedManifestDigest: input.verifiedSource.manifestDigest,
            limits: {
              catalogPageEntries: 200 as const,
              fileBytes: 524_288 as const,
              lineRange: 200 as const,
              responseBytes: 32_768 as const,
            },
          },
          checks: null,
        };
  const modelId =
    input.lifecycleProfile === undefined
      ? input.selectedModelId
      : (input.lifecycleProfile?.model ?? null);
  const configuration = {
    model: { route: "codex_subscription" as const, modelId },
    ...(input.lifecycleProfile === undefined
      ? {}
      : { lifecycleProfile: input.lifecycleProfile, profileBlocker: input.profileBlocker ?? null }),
    runtimePolicy: {
      ...CONCEPTUAL_REVIEW_RUNTIME_POLICY,
      containerImage: input.runtimeProfile?.containerImage ?? null,
      containerUser: input.runtimeProfile?.containerUser ?? null,
      codexExecutable: input.runtimeProfile?.codexExecutable ?? null,
      codexExecutableDigest: input.runtimeProfile?.codexExecutableDigest ?? null,
      codexVersion: input.runtimeProfile?.codexVersion ?? null,
      status: input.runtimeProfile === null ? ("unavailable" as const) : ("available" as const),
    },
    resources: CONCEPTUAL_REVIEW_RESOURCES,
  };
  const blockers: FactoryConceptualReviewBlocker[] = [];
  if (publication === null || evidence === null) blockers.push("publication_not_ready");
  if (basis === null) blockers.push("change_intent_not_available");
  if (modelId === null)
    blockers.push(
      input.lifecycleProfile === undefined ? "model_not_selected" : "lifecycle_profile_unavailable",
    );
  if (input.runtimeProfile === null) blockers.push("review_runtime_unavailable");
  const completeInputs = basis !== null && publication !== null && evidence !== null;
  const preparationDigest =
    completeInputs && modelId !== null
      ? sha256({
          schemaVersion: 1,
          projectId: input.project.id,
          featureId: null,
          changeProposalId: proposal.id,
          basis,
          publication,
          evidence,
          configuration,
        })
      : null;
  return ExternalConceptualReviewPreparationSchema.parse({
    schemaVersion: 1,
    projectId: input.project.id,
    featureId: null,
    changeProposalId: proposal.id,
    preparationDigest,
    basis,
    publication,
    evidence,
    configuration,
    readiness: {
      state: blockers.length === 0 ? "ready" : "blocked",
      startAllowed: blockers.length === 0,
      blockers,
    },
  });
}
