import { describe, expect, it, vi } from "vitest";

import {
  mapProjectRows,
  readProject,
  readProjectGitHubCoordinates,
  type ProjectDatabaseRow,
} from "./projects.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const proposalId = "018f0f89-9192-755f-aa96-f72094c734dd";
const overviewFacts = {
  ruleVersion: 1,
  commitStatistics: { baseTreeFileCount: 1, headTreeFileCount: 1 },
  fileStatistics: { added: 0, modified: 1, deleted: 0, total: 1 },
  changedFiles: [
    {
      path: "src/review.ts",
      status: "modified",
      base: { mode: "100644", objectId: "c".repeat(40), type: "blob" },
      head: { mode: "100644", objectId: "d".repeat(40), type: "blob" },
    },
  ],
  pathAreas: [{ pathPrefix: "src", changedFileCount: 1, samplePaths: ["src/review.ts"] }],
  warnings: [],
} as const;

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
    revision_base_commit_author: "Base Author",
    revision_base_commit_subject: "Establish the source boundary",
    revision_head_commit_author: "Head Author",
    revision_head_commit_subject: "Keep repository access explicit",
    overview_rule_version: "1",
    overview_source_facts: overviewFacts,
    overview_created_at: new Date("2026-08-24T12:01:00.000Z"),
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

function providerProjectRowWithOverview(): ProjectDatabaseRow {
  return {
    ...localProjectRow(),
    author_login_snapshot: "octocat",
    author_provider_id: "U_kgDOA",
    observed_at: new Date("2026-08-24T12:01:00.000Z"),
    proposal_body: "Keep provider metadata optional.",
    proposal_canonical_url: "https://github.com/openai/openai-node/pull/1234",
    proposal_kind: "provider_observed",
    proposal_number: "1234",
    proposal_provider_id: "PR_kwDOGx",
    proposal_state: "open",
    provider: "github",
    provider_observation_kind: "public_github",
    provider_repository_id: "R_kgDOGx",
    repository_canonical_url_snapshot: "https://github.com/openai/openai-node",
    repository_name_snapshot: "openai-node",
    repository_owner_snapshot: "openai",
  };
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
            expect.objectContaining({
              changeOverview: {
                state: "awaiting_source",
                exactHeadObjectId: "b".repeat(40),
              },
              id: proposalId,
              number: 1234,
            }),
            expect.objectContaining({
              changeOverview: {
                state: "awaiting_source",
                exactHeadObjectId: "b".repeat(40),
              },
              number: 1235,
            }),
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
          direct_profile_last_test_passed_at: new Date(Date.now()),
        }),
      ]).projects[0]?.modelAccess,
    ).toBe("direct_api_available");
    expect(
      mapProjectRows([
        projectRow({
          direct_profile_attestation_expires_at: new Date("2020-01-01T00:00:00.000Z"),
          direct_profile_availability: "available",
          direct_profile_last_test_passed_at: new Date(Date.now()),
        }),
      ]).projects[0]?.modelAccess,
    ).toBe("direct_api_stale");
    expect(
      mapProjectRows([
        projectRow({
          direct_profile_attestation_expires_at: new Date("2099-01-01T00:00:00.000Z"),
          direct_profile_availability: "unavailable",
          direct_profile_last_test_passed_at: new Date(Date.now()),
        }),
      ]).projects[0]?.modelAccess,
    ).toBe("direct_api_unavailable");
    expect(
      mapProjectRows([
        projectRow({
          direct_profile_attestation_expires_at: new Date("2099-01-01T00:00:00.000Z"),
          direct_profile_availability: "available",
          direct_profile_last_test_passed_at: new Date(0),
        }),
      ]).projects[0]?.modelAccess,
    ).toBe("direct_api_stale");
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
    expect(proposal?.changeOverview).toEqual({
      state: "ready",
      createdAt: "2026-08-24T12:01:00.000Z",
      exactRevision: {
        id: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
        objectFormat: "sha1",
        base: {
          ref: "refs/heads/main",
          objectId: "a".repeat(40),
          author: "Base Author",
          subject: "Establish the source boundary",
        },
        head: {
          ref: "refs/heads/review-source",
          objectId: "b".repeat(40),
          author: "Head Author",
          subject: "Keep repository access explicit",
        },
      },
      changeIntent: proposal?.changeIntent,
      modelRendering: { state: "not_generated" },
      providerObservation: null,
      sourceFacts: overviewFacts,
    });
  });

  it("maps a durable local Project before it has any Change Proposals", () => {
    const row = localProjectRow();
    Object.assign(row, {
      proposal_id: null,
      proposal_kind: null,
      proposal_optimistic_version: null,
    });

    expect(mapProjectRows([row])).toMatchObject({
      projects: [
        {
          id: projectId,
          changeProposals: [],
          localRepositorySource: {
            displayName: "kestrel",
            state: "attached",
          },
        },
      ],
    });
  });

  it("maps only the rendering fenced to the selected Proposal head", () => {
    const row = localProjectRow();
    Object.assign(row, {
      rendering_state: "ready",
      rendering_review_revision_id: row.revision_id,
      rendering_head_object_id: row.revision_head_object_id,
      rendering_requested_at: new Date("2026-08-24T12:01:01.000Z"),
      rendering_started_at: new Date("2026-08-24T12:01:01.025Z"),
      rendering_completed_at: new Date("2026-08-24T12:01:02.150Z"),
      rendering_provider_request_id: "req_overview_1",
      rendering_sentences: [
        {
          text: "The retained change modifies 1 file under `src`.",
          sourceFactIds: ["file_statistics", "path_area_001"],
        },
      ],
      rendering_queue_milliseconds: "25",
      rendering_model_milliseconds: "1000",
      rendering_kestrel_milliseconds: "125",
      rendering_total_milliseconds: "1150",
    });

    const overview = mapProjectRows([row]).projects[0]?.changeProposals[0]?.changeOverview;

    expect(overview).toMatchObject({
      state: "ready",
      modelRendering: {
        state: "ready",
        providerRequestId: "req_overview_1",
        sentences: [
          {
            text: "The retained change modifies 1 file under `src`.",
            sourceFactIds: ["file_statistics", "path_area_001"],
          },
        ],
        performance: {
          queueMilliseconds: 25,
          modelMilliseconds: 1000,
          kestrelMilliseconds: 125,
          totalMilliseconds: 1150,
        },
      },
    });

    row.rendering_head_object_id = "e".repeat(40);
    const stale = mapProjectRows([row]).projects[0]?.changeProposals[0]?.changeOverview;
    expect(stale).toMatchObject({ state: "ready", modelRendering: { state: "not_generated" } });
    expect(JSON.stringify(stale)).not.toContain("req_overview_1");
  });

  it("keeps facts ready while exposing a bounded inline rendering failure", () => {
    const row = localProjectRow();
    Object.assign(row, {
      rendering_state: "unavailable",
      rendering_review_revision_id: row.revision_id,
      rendering_head_object_id: row.revision_head_object_id,
      rendering_requested_at: new Date("2026-08-24T12:01:01.000Z"),
      rendering_completed_at: new Date("2026-08-24T12:01:01.125Z"),
      rendering_failure_reason: "profile_not_configured",
      rendering_queue_milliseconds: "25",
      rendering_model_milliseconds: "0",
      rendering_kestrel_milliseconds: "100",
      rendering_total_milliseconds: "125",
    });

    expect(mapProjectRows([row]).projects[0]?.changeProposals[0]?.changeOverview).toMatchObject({
      state: "ready",
      sourceFacts: overviewFacts,
      modelRendering: {
        state: "unavailable",
        reason: "profile_not_configured",
      },
    });
  });

  it("hides prior overview facts as soon as the selected source changes", () => {
    const row = localProjectRow();
    row.head_object_id = "e".repeat(40);
    row.head_ref_snapshot = "refs/heads/new-review-source";

    const overview = mapProjectRows([row]).projects[0]?.changeProposals[0]?.changeOverview;

    expect(overview).toEqual({
      state: "awaiting_source",
      exactHeadObjectId: "e".repeat(40),
    });
    expect(JSON.stringify(overview)).not.toContain("src/review.ts");
  });

  it("refreshes only current provider facts while retaining exact source facts", () => {
    const before = mapProjectRows([providerProjectRowWithOverview()]).projects[0]
      ?.changeProposals[0]?.changeOverview;
    const refreshed = providerProjectRowWithOverview();
    refreshed.proposal_title = "Current provider title";
    refreshed.proposal_body = "Current provider description.";
    refreshed.observed_at = new Date("2026-08-24T12:02:00.000Z");

    const after = mapProjectRows([refreshed]).projects[0]?.changeProposals[0]?.changeOverview;

    expect(before?.state).toBe("ready");
    expect(after).toMatchObject({
      state: "ready",
      providerObservation: {
        title: "Current provider title",
        description: "Current provider description.",
        observedAt: "2026-08-24T12:02:00.000Z",
      },
      sourceFacts: overviewFacts,
    });
    if (before?.state !== "ready" || after?.state !== "ready") {
      throw new Error("Ready provider Change Overview fixture is unavailable");
    }
    expect(after.exactRevision).toEqual(before.exactRevision);
    expect(after.sourceFacts).toEqual(before.sourceFacts);
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

  it("reads attached GitHub coordinates against the Installation schema", async () => {
    const query = vi.fn((statement: string) => {
      expect(statement).not.toContain("installation.singleton");
      return {
        rowCount: 1,
        rows: [
          {
            github_name_snapshot: "kestrel",
            github_owner_snapshot: "Ic3b3rg",
            installation_id: "018f0f89-9a22-7864-aac2-8df71bf60421",
            repository_id: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
          },
        ],
      };
    });

    await expect(readProjectGitHubCoordinates({ query } as never, projectId)).resolves.toEqual({
      installationId: "018f0f89-9a22-7864-aac2-8df71bf60421",
      owner: "Ic3b3rg",
      repository: "kestrel",
      repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
    });
    expect(query).toHaveBeenCalledWith(expect.any(String), [projectId]);
  });
});
