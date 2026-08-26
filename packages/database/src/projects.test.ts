import { describe, expect, it } from "vitest";

import { mapProjectRows, type ProjectDatabaseRow } from "./projects.js";

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

  it("fails closed for an unsupported Provider Observation kind", () => {
    expect(() =>
      mapProjectRows([projectRow({ provider_observation_kind: "local_repository" })]),
    ).toThrow("Unsupported Provider Observation kind");
  });
});
