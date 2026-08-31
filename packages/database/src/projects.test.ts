import { describe, expect, it, vi } from "vitest";

import { mapProjectRows, readProject, type ProjectDatabaseRow } from "./projects.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const proposalId = "018f0f89-9192-755f-aa96-f72094c734dd";

function projectRow(overrides: Partial<ProjectDatabaseRow> = {}): ProjectDatabaseRow {
  return {
    author_login_snapshot: "octocat",
    author_provider_id: "U_kgDOA",
    base_object_id: "a".repeat(40),
    base_ref_snapshot: "main",
    created_at: new Date("2026-08-24T12:00:00.000Z"),
    head_object_id: "b".repeat(40),
    head_ref_snapshot: "provider-observation",
    id: projectId,
    observed_at: new Date("2026-08-24T12:01:00.000Z"),
    proposal_canonical_url: "https://github.com/openai/openai-node/pull/1234",
    proposal_id: proposalId,
    proposal_number: "1234",
    proposal_provider_id: "PR_kwDOGx",
    proposal_state: "open",
    proposal_title: "Keep repository access explicit",
    proposal_body: "Keep provider metadata optional.",
    proposal_optimistic_version: "1",
    provider: "github",
    provider_repository_id: "R_kgDOGx",
    provider_observation_kind: "public_github",
    repository_canonical_url_snapshot: "https://github.com/openai/openai-node",
    repository_name_snapshot: "openai-node",
    repository_owner_snapshot: "openai",
    updated_at: new Date("2026-08-24T12:01:00.000Z"),
    ...overrides,
  };
}

function localProjectRow(): ProjectDatabaseRow {
  return {
    ...projectRow(),
    provider_observation_kind: null,
    provider: null,
    provider_repository_id: null,
    repository_canonical_url_snapshot: null,
    repository_name_snapshot: null,
    repository_owner_snapshot: null,
    source_availability: "available",
    local_source_id: "018f0f89-9a1d-7484-b224-866ef9d69990",
    local_repository_id: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
    local_display_name: "kestrel",
    local_source_state: "attached",
    local_object_format: "sha1",
    local_source_created_at: new Date("2026-08-24T12:00:00.000Z"),
    local_source_updated_at: new Date("2026-08-24T12:01:00.000Z"),
    proposal_kind: "local",
    proposal_provider_id: null,
    proposal_number: null,
    proposal_canonical_url: null,
    proposal_body: null,
    proposal_state: null,
    author_login_snapshot: null,
    author_provider_id: null,
    observed_at: null,
    intent_id: "018f0f89-9a20-79f9-9990-dda80c9b917d",
    intent_version: "1",
    intent_text: "Review the authorization boundary.",
    intent_objective: "Review the authorization boundary.",
    intent_scope_boundaries: [],
    intent_acceptance_outcomes: [],
    intent_selected_sources: [
      {
        id: "operator_input",
        kind: "operator_input",
        label: "Operator input",
        text: "Review the authorization boundary.",
        version: "1",
        provenance: { kind: "operator_input" },
      },
    ],
    intent_source_digest: "b".repeat(64),
    intent_resolution_state: "unresolved",
    intent_resolution_issues: [
      { kind: "missing", field: "scope_boundaries" },
      { kind: "missing", field: "acceptance_outcomes" },
    ],
    intent_created_at: new Date("2026-08-24T12:00:30.000Z"),
    revision_id: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
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
    candidate_revision_id: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
    candidate_base_commit_author: "Base Author",
    candidate_base_commit_subject: "Establish the source boundary",
    candidate_base_object_id: "a".repeat(40),
    candidate_base_ref: "refs/heads/main",
    candidate_head_commit_author: "Head Author",
    candidate_head_commit_subject: "Keep repository access explicit",
    candidate_head_object_id: "b".repeat(40),
    candidate_head_ref: "refs/heads/review-source",
  } as unknown as ProjectDatabaseRow;
}

describe("Project persistence mapping", () => {
  it("groups provider observations into a bounded Project inbox", () => {
    expect(
      mapProjectRows([
        projectRow(),
        projectRow({
          observed_at: new Date("2026-08-24T12:02:00.000Z"),
          proposal_canonical_url: "https://github.com/openai/openai-node/pull/1235",
          proposal_id: "018f0f89-9192-755f-aa96-f72094c734de",
          proposal_number: "1235",
          proposal_provider_id: "PR_kwDOGy",
          proposal_title: "Add the local route next",
        }),
      ]),
    ).toEqual({
      schemaVersion: 1,
      projects: [
        {
          changeProposals: [
            expect.objectContaining({ id: proposalId, number: 1234 }),
            expect.objectContaining({ number: 1235 }),
          ],
          createdAt: "2026-08-24T12:00:00.000Z",
          id: projectId,
          localRepositorySource: null,
          modelAccess: "not_configured",
          providerObservation: {
            authentication: "none",
            kind: "public_github",
            refresh: "manual",
          },
          repository: {
            canonicalUrl: "https://github.com/openai/openai-node",
            name: "openai-node",
            owner: "openai",
            providerId: "R_kgDOGx",
          },
          sourceAvailability: "not_acquired",
          updatedAt: "2026-08-24T12:01:00.000Z",
        },
      ],
    });
  });

  it("fails closed for an incomplete provider identity", () => {
    expect(() => mapProjectRows([projectRow({ author_provider_id: null })])).toThrow();
  });

  it("maps the effective Direct API availability independently from source access", () => {
    expect(
      mapProjectRows([
        projectRow({
          direct_profile_attestation_expires_at: new Date("2099-01-01T00:00:00.000Z"),
          direct_profile_availability: "available",
        }),
      ]).projects[0]?.modelAccess,
    ).toBe("direct_api_available");
    expect(
      mapProjectRows([
        projectRow({
          direct_profile_attestation_expires_at: new Date("2020-01-01T00:00:00.000Z"),
          direct_profile_availability: "available",
        }),
      ]).projects[0]?.modelAccess,
    ).toBe("direct_api_stale");
    expect(
      mapProjectRows([
        projectRow({
          direct_profile_attestation_expires_at: new Date("2099-01-01T00:00:00.000Z"),
          direct_profile_availability: "unavailable",
        }),
      ]).projects[0]?.modelAccess,
    ).toBe("direct_api_unavailable");
  });

  it("fails closed for an unsupported Provider Observation kind", () => {
    expect(() =>
      mapProjectRows([projectRow({ provider_observation_kind: "local_repository" })]),
    ).toThrow("Unsupported Provider Observation kind");
  });

  it("maps a local Project without fabricating provider metadata", () => {
    const inbox = mapProjectRows([localProjectRow()]);
    const project = inbox.projects[0];
    expect(project?.id).toBe(projectId);
    expect(project?.providerObservation).toBeNull();
    expect(project?.repository).toBeNull();
    expect(project?.sourceAvailability).toBe("available");
    expect(project?.modelAccess).toBe("not_configured");
    expect(project?.localRepositorySource?.displayName).toBe("kestrel");
    expect(project?.localRepositorySource?.state).toBe("attached");
    const proposal = project?.changeProposals[0];
    expect(proposal?.kind).toBe("local");
    expect(proposal?.id).toBe(proposalId);
    expect(proposal?.changeIntent?.version).toBe(1);
    expect(proposal?.changeIntent?.text).toBe("Review the authorization boundary.");
    expect(proposal?.changeIntentCandidates.map(({ id }) => id)).toEqual([
      "base_commit_author",
      "base_commit_message",
      "head_commit_author",
      "head_commit_message",
    ]);
    expect(proposal?.reviewRevisions[0]?.state).toBe("available");
    expect(proposal?.reviewRevisions[0]?.objectCount).toBe(7);
  });

  it("fails closed when retained Review Revision identity columns are incomplete", () => {
    const row = localProjectRow();
    row.revision_base_object_id = null;
    expect(() => mapProjectRows([row])).toThrow("Review Revision is incomplete");
  });

  it("resolves a requested Project alias at response-read time", async () => {
    const query = vi.fn((statement: string) => {
      void statement;
      return { rowCount: 1, rows: [localProjectRow()] };
    });

    await expect(
      readProject({ query } as never, "018f0f89-9a22-7864-aac2-8df71bf60420"),
    ).resolves.toMatchObject({ id: projectId });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain(
      "SELECT COALESCE(requested.canonical_project_id, requested.id)",
    );
    expect(query.mock.calls[0]?.[0]).toContain("ORDER BY intent.version DESC");
  });
});
