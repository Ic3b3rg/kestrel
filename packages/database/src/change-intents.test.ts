import { describe, expect, it, vi } from "vitest";

import { createChangeIntentVersion } from "./change-intents.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const proposalId = "018f0f89-9192-755f-aa96-f72094c734dd";
const operatorId = "018f0f89-a21d-7e31-8d27-aa4383f22991";

describe("Change Intent persistence", () => {
  it("creates one source-backed version and advances the Proposal atomically", async () => {
    const query = vi.fn(async (statement: string, parameters?: readonly unknown[]) => {
      if (statement === "BEGIN" || statement === "COMMIT") return { rowCount: null, rows: [] };
      if (statement.includes("AS canonical_proposal_id") && statement.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [
            {
              canonical_project_id: projectId,
              canonical_proposal_id: proposalId,
              canonical_url_snapshot: "https://github.com/openai/openai-node/pull/1234",
              observed_at: new Date("2026-08-24T12:01:00.000Z"),
              optimistic_version: "3",
              proposal_body: "Keep provider metadata optional and read-only.",
              proposal_kind: "provider_observed",
              proposal_title: "Keep repository access explicit",
            },
          ],
        };
      }
      if (statement.includes("base_commit_subject_snapshot")) {
        return {
          rowCount: 1,
          rows: [
            {
              base_commit_author_snapshot: "Base Author",
              base_commit_subject_snapshot: "Establish the local source boundary",
              base_object_id: "a".repeat(40),
              base_ref_snapshot: "refs/heads/main",
              head_commit_author_snapshot: "Head Author",
              head_commit_subject_snapshot: "Keep repository access explicit",
              head_object_id: "b".repeat(40),
              head_ref_snapshot: "refs/heads/change-intent",
            },
          ],
        };
      }
      if (statement.includes("max(intent.version)")) {
        return { rowCount: 1, rows: [{ max_version: "1" }] };
      }
      if (statement.includes("INSERT INTO change_intents")) {
        const sources = JSON.parse(String(parameters?.[6])) as Array<{ id: string; text: string }>;
        expect(sources.map(({ id }) => id)).toEqual([
          "provider_title",
          "head_commit_message",
          "operator_input",
        ]);
        expect(sources[0]?.text).toBe("Keep repository access explicit");
        return {
          rowCount: 1,
          rows: [
            {
              created_at: new Date("2026-08-24T12:02:00.000Z"),
              id: "018f0f89-9a20-79f9-9990-dda80c9b917e",
              version: "2",
            },
          ],
        };
      }
      if (
        statement.includes("UPDATE change_proposals") &&
        statement.includes("optimistic_version")
      ) {
        expect(parameters).toEqual([proposalId, 3]);
        return { rowCount: 1, rows: [{ optimistic_version: "4" }] };
      }
      if (statement.includes("pg_advisory_xact_lock")) return { rowCount: 1, rows: [{}] };
      if (statement.includes("FROM installation_audit_records")) return { rowCount: 0, rows: [] };
      if (statement.includes("nextval")) {
        return {
          rowCount: 1,
          rows: [{ id: "1", occurred_at: new Date("2026-08-24T12:02:00.000Z") }],
        };
      }
      if (statement.includes("INSERT INTO installation_audit_records")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    const release = vi.fn();

    const result = await createChangeIntentVersion(
      { connect: vi.fn(async () => ({ query, release })) } as never,
      {
        actorId: operatorId,
        changeProposalId: proposalId,
        command: {
          expectedProposalVersion: 3,
          objective: "Keep repository access explicit and read-only.",
          scopeBoundaries: ["Do not add provider write authority."],
          acceptanceOutcomes: ["Provider metadata remains optional context."],
          selectedSourceIds: ["provider_title", "head_commit_message"],
          operatorInput: "Focus the review on the local authorization boundary.",
          unresolvedIssues: [],
        },
        correlationId: "018f0f89-a3fb-75ee-bccc-08c031ce5f10",
        projectId,
      },
    );

    expect(result).toMatchObject({
      schemaVersion: 1,
      projectId,
      changeProposalId: proposalId,
      proposalVersion: 4,
      changeIntent: {
        version: 2,
        objective: "Keep repository access explicit and read-only.",
        resolution: { state: "resolved", issues: [] },
      },
    });
    expect(result.changeIntent.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(query.mock.calls.map(([statement]) => statement)).toEqual(
      expect.arrayContaining(["BEGIN", "COMMIT"]),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
