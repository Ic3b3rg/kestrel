import { describe, expect, it, vi } from "vitest";

import type { ReviewAnalysisConfiguration, ReviewResourceEnvelope } from "@kestrel/contracts";

import type { ProjectDatabaseRow } from "./projects.js";
import { readReviewPreparation, startReviewWorkflow } from "./review-workflows.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const proposalId = "018f0f89-9192-755f-aa96-f72094c734dd";
const operatorId = "018f0f89-a21d-7e31-8d27-aa4383f22991";
const revisionId = "018f0f89-9a21-7271-b92d-f1cb0d48bb47";
const intentId = "018f0f89-9a20-79f9-9990-dda80c9b917e";

const analysisConfiguration: ReviewAnalysisConfiguration = {
  id: "018f0f89-a45f-79af-8544-650e9f15c211",
  version: 1,
  displayName: "Direct API review profile",
  modelRoute: "direct_api",
  digest: "d".repeat(64),
};
const resourceEnvelope: ReviewResourceEnvelope = {
  id: "review-first-v1-default",
  version: 1,
  displayName: "Review First V1 default envelope",
  digest: "e".repeat(64),
};
const executionProfile = { analysisConfiguration, resourceEnvelope };

function readyProjectRow(overrides: Partial<ProjectDatabaseRow> = {}): ProjectDatabaseRow {
  return {
    author_login_snapshot: null,
    author_provider_id: null,
    base_object_id: "a".repeat(40),
    base_ref_snapshot: "refs/heads/main",
    created_at: new Date("2026-08-24T12:00:00.000Z"),
    head_object_id: "b".repeat(40),
    head_ref_snapshot: "refs/heads/review-source",
    id: projectId,
    observed_at: null,
    proposal_canonical_url: null,
    proposal_id: proposalId,
    proposal_number: null,
    proposal_provider_id: null,
    proposal_state: null,
    proposal_title: "Review local authorization changes",
    proposal_body: null,
    proposal_optimistic_version: "4",
    provider: null,
    provider_repository_id: null,
    provider_observation_kind: null,
    repository_canonical_url_snapshot: null,
    repository_name_snapshot: null,
    repository_owner_snapshot: null,
    updated_at: new Date("2026-08-24T12:03:00.000Z"),
    source_availability: "available",
    local_source_id: "018f0f89-9a1d-7484-b224-866ef9d69990",
    local_repository_id: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
    local_display_name: "kestrel",
    local_source_state: "detached",
    local_object_format: "sha1",
    local_source_created_at: new Date("2026-08-24T12:00:00.000Z"),
    local_source_updated_at: new Date("2026-08-24T12:03:00.000Z"),
    proposal_kind: "local",
    proposal_created_at: new Date("2026-08-24T12:00:30.000Z"),
    proposal_updated_at: new Date("2026-08-24T12:03:00.000Z"),
    intent_id: intentId,
    intent_version: "2",
    intent_text: "Review the local authorization boundary.",
    intent_objective: "Review the local authorization boundary.",
    intent_scope_boundaries: ["Do not add provider write authority."],
    intent_acceptance_outcomes: ["Review uses only the retained exact revision."],
    intent_selected_sources: [
      {
        id: "operator_input",
        kind: "operator_input",
        label: "Operator input",
        text: "Review the local authorization boundary.",
        version: "2",
        provenance: { kind: "operator_input" },
      },
    ],
    intent_source_digest: "c".repeat(64),
    intent_resolution_state: "resolved",
    intent_resolution_issues: [],
    intent_created_at: new Date("2026-08-24T12:02:00.000Z"),
    revision_id: revisionId,
    revision_state: "available",
    revision_object_format: "sha1",
    revision_base_ref: "refs/heads/main",
    revision_base_object_id: "a".repeat(40),
    revision_head_ref: "refs/heads/review-source",
    revision_head_object_id: "b".repeat(40),
    revision_object_count: "7",
    revision_retained_bytes: "4096",
    revision_failure_reason: null,
    revision_created_at: new Date("2026-08-24T12:00:30.000Z"),
    revision_available_at: new Date("2026-08-24T12:01:00.000Z"),
    candidate_revision_id: revisionId,
    candidate_base_commit_author: null,
    candidate_base_commit_subject: null,
    candidate_base_object_id: "a".repeat(40),
    candidate_base_ref: "refs/heads/main",
    candidate_head_commit_author: null,
    candidate_head_commit_subject: null,
    candidate_head_object_id: "b".repeat(40),
    candidate_head_ref: "refs/heads/review-source",
    ...overrides,
  };
}

describe("Review Workflow persistence", () => {
  it("keeps Provider Observation freshness outside the canonical Review digest", async () => {
    const providerRow = readyProjectRow({
      observed_at: new Date("2026-08-24T12:01:00.000Z"),
      proposal_canonical_url: "https://github.com/openai/openai-node/pull/1234",
      proposal_kind: "provider_observed",
      proposal_number: "1234",
      proposal_provider_id: "PR_kwDOGx",
      proposal_state: "open",
      provider: "github",
      provider_account_snapshot: "operator",
      provider_host_snapshot: "github.com",
      provider_observation_kind: "host_gh",
      provider_repository_id: "R_kgDOGx",
      repository_canonical_url_snapshot: "https://github.com/openai/openai-node",
      repository_name_snapshot: "openai-node",
      repository_owner_snapshot: "openai",
    });
    const read = (row: ProjectDatabaseRow, profile = executionProfile) =>
      readReviewPreparation(
        { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [row] }) } as never,
        { actorId: operatorId, changeProposalId: proposalId, projectId },
        profile,
      );

    const first = await read(providerRow);
    const refreshed = await read(
      readyProjectRow({
        ...providerRow,
        observed_at: new Date("2026-08-24T12:09:00.000Z"),
        provider_account_snapshot: "another-operator",
      }),
      {
        analysisConfiguration: {
          digest: analysisConfiguration.digest,
          modelRoute: analysisConfiguration.modelRoute,
          displayName: analysisConfiguration.displayName,
          version: analysisConfiguration.version,
          id: analysisConfiguration.id,
        },
        resourceEnvelope: {
          digest: resourceEnvelope.digest,
          displayName: resourceEnvelope.displayName,
          version: resourceEnvelope.version,
          id: resourceEnvelope.id,
        },
      },
    );

    expect(first.readiness).toBe("ready");
    expect(first.source.providerObservation).toMatchObject({
      route: { account: "operator", host: "github.com" },
      proposal: { providerId: "PR_kwDOGx" },
    });
    expect(refreshed.source.providerObservation).toMatchObject({
      route: { account: "another-operator", host: "github.com" },
    });
    expect(refreshed.preparationDigest).toBe(first.preparationDigest);
  });

  it("rechecks and freezes one prepared Review atomically", async () => {
    const row = readyProjectRow();
    const preparation = await readReviewPreparation(
      { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [row] }) } as never,
      { actorId: operatorId, changeProposalId: proposalId, projectId },
      executionProfile,
    );
    expect(preparation).toMatchObject({
      readiness: "ready",
      blockers: [],
      reviewRevision: { id: revisionId },
      changeIntent: { id: intentId },
    });
    expect(preparation.preparationDigest).toMatch(/^[a-f0-9]{64}$/u);

    const query = vi.fn((statement: string) => {
      if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }
      if (statement.includes("FOR UPDATE OF project, proposal")) {
        return {
          rowCount: 1,
          rows: [{ canonical_project_id: projectId, canonical_proposal_id: proposalId }],
        };
      }
      if (statement.includes("FROM change_intents") && statement.includes("FOR SHARE")) {
        return { rowCount: 1, rows: [{ id: intentId }] };
      }
      if (statement.includes("FROM review_revisions") && statement.includes("FOR SHARE")) {
        return { rowCount: 1, rows: [{ id: revisionId }] };
      }
      if (statement.includes("LEFT JOIN LATERAL") && statement.includes("AS candidate_revision")) {
        return { rowCount: 1, rows: [row] };
      }
      if (statement.includes("INSERT INTO review_workflows")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "018f0f89-a45f-79af-8544-650e9f15c212",
              requested_at: new Date("2026-08-24T12:04:00.000Z"),
            },
          ],
        };
      }
      if (statement.includes("pg_advisory_xact_lock")) return { rowCount: 1, rows: [{}] };
      if (statement.includes("FROM installation_audit_records")) {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes("nextval")) {
        return {
          rowCount: 1,
          rows: [{ id: "1", occurred_at: new Date("2026-08-24T12:04:00.000Z") }],
        };
      }
      if (statement.includes("INSERT INTO installation_audit_records")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    const release = vi.fn();

    const accepted = await startReviewWorkflow(
      { connect: vi.fn(() => ({ query, release })) } as never,
      {
        actorId: operatorId,
        changeProposalId: proposalId,
        command: { preparationDigest: preparation.preparationDigest ?? "" },
        correlationId: "018f0f89-a3fb-75ee-bccc-08c031ce5f10",
        projectId,
      },
      executionProfile,
    );

    expect(accepted).toMatchObject({
      schemaVersion: 1,
      workflow: {
        projectId,
        changeProposalId: proposalId,
        reviewRevisionId: revisionId,
        changeIntentId: intentId,
        inputDigest: preparation.preparationDigest,
        state: "queued",
      },
    });
    expect(query.mock.calls.map(([statement]) => statement)).toEqual(
      expect.arrayContaining(["BEGIN", "COMMIT"]),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back when the prepared inputs no longer match the command digest", async () => {
    const row = readyProjectRow();
    const query = vi.fn((statement: string) => {
      if (statement === "BEGIN" || statement === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }
      if (statement.includes("FOR UPDATE OF project, proposal")) {
        return {
          rowCount: 1,
          rows: [{ canonical_project_id: projectId, canonical_proposal_id: proposalId }],
        };
      }
      if (statement.includes("FROM change_intents") && statement.includes("FOR SHARE")) {
        return { rowCount: 1, rows: [{ id: intentId }] };
      }
      if (statement.includes("FROM review_revisions") && statement.includes("FOR SHARE")) {
        return { rowCount: 1, rows: [{ id: revisionId }] };
      }
      if (statement.includes("LEFT JOIN LATERAL") && statement.includes("AS candidate_revision")) {
        return { rowCount: 1, rows: [row] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    const release = vi.fn();

    await expect(
      startReviewWorkflow(
        { connect: vi.fn(() => ({ query, release })) } as never,
        {
          actorId: operatorId,
          changeProposalId: proposalId,
          command: { preparationDigest: "f".repeat(64) },
          correlationId: "018f0f89-a3fb-75ee-bccc-08c031ce5f10",
          projectId,
        },
        executionProfile,
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "preparation_conflict" }));
    expect(query.mock.calls.map(([statement]) => statement)).toContain("ROLLBACK");
    expect(
      query.mock.calls.some(([statement]) => statement.includes("INSERT INTO review_workflows")),
    ).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns the already-frozen workflow for a repeated identical command", async () => {
    const row = readyProjectRow();
    const preparation = await readReviewPreparation(
      { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [row] }) } as never,
      { actorId: operatorId, changeProposalId: proposalId, projectId },
      executionProfile,
    );
    const existingId = "018f0f89-a45f-79af-8544-650e9f15c212";
    const requestedAt = new Date("2026-08-24T12:04:00.000Z");
    const query = vi.fn((statement: string) => {
      if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }
      if (statement.includes("FOR UPDATE OF project, proposal")) {
        return {
          rowCount: 1,
          rows: [{ canonical_project_id: projectId, canonical_proposal_id: proposalId }],
        };
      }
      if (statement.includes("LEFT JOIN LATERAL") && statement.includes("AS candidate_revision")) {
        return { rowCount: 1, rows: [row] };
      }
      if (statement.includes("INSERT INTO review_workflows")) return { rowCount: 0, rows: [] };
      if (statement.includes("SELECT id, requested_at") && statement.includes("review_workflows")) {
        return { rowCount: 1, rows: [{ id: existingId, requested_at: requestedAt }] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    const release = vi.fn();

    const repeated = await startReviewWorkflow(
      { connect: vi.fn(() => ({ query, release })) } as never,
      {
        actorId: operatorId,
        changeProposalId: proposalId,
        command: { preparationDigest: preparation.preparationDigest ?? "" },
        correlationId: "018f0f89-a3fb-75ee-bccc-08c031ce5f10",
        projectId,
      },
      executionProfile,
    );

    expect(repeated.workflow).toMatchObject({
      id: existingId,
      requestedAt: requestedAt.toISOString(),
    });
    expect(
      query.mock.calls.some(([statement]) =>
        statement.includes("INSERT INTO installation_audit_records"),
      ),
    ).toBe(false);
    expect(query.mock.calls.map(([statement]) => statement)).toContain("COMMIT");
  });
});
