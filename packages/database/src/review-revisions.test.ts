import { describe, expect, it, vi } from "vitest";

import {
  completeReviewRevision,
  failReviewRevision,
  reconcileAcquiringRevisions,
  reconcileLocalSourceAttachments,
  withArtifactAcquisitionLock,
  withArtifactLifecycleLock,
  withReviewRevisionAcquisitionLease,
  type DatabasePool,
} from "./index.js";

async function beginReviewRevision(
  pool: DatabasePool,
  input: Parameters<typeof withReviewRevisionAcquisitionLease>[1],
) {
  return withReviewRevisionAcquisitionLease(pool, input, (begun) => begun);
}

const installationId = "018f0f89-8f75-7cc4-9860-3fda5f75d697";
const operatorId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const projectId = "018f0f89-9a22-7864-aac2-8df71bf60420";
const sourceId = "018f0f89-9a1d-7484-b224-866ef9d69990";
const proposalId = "018f0f89-9192-755f-aa96-f72094c734dd";
const intentId = "018f0f89-9a20-79f9-9990-dda80c9b917d";
const revisionId = "018f0f89-9a21-7271-b92d-f1cb0d48bb47";
const timestamp = new Date("2026-08-24T12:00:30.000Z");

function acquisitionPool(
  options: {
    existingSource?: boolean;
    projectCount?: number;
    proposalCount?: number;
    staleAcquiringRevision?: boolean;
  } = {},
) {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  const query = vi.fn((statement: string, values?: unknown[]) => {
    const normalized = statement.replace(/\s+/gu, " ").trim();
    statements.push(normalized);
    parameters.push(values ?? []);
    if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
      return { rowCount: null, rows: [] };
    }
    if (normalized.startsWith("SELECT id FROM installations")) {
      return { rowCount: 1, rows: [{ id: installationId }] };
    }
    if (normalized.startsWith("SELECT count(*) AS project_count")) {
      return { rowCount: 1, rows: [{ project_count: String(options.projectCount ?? 0) }] };
    }
    if (normalized.startsWith("SELECT count(*) AS proposal_count")) {
      return { rowCount: 1, rows: [{ proposal_count: String(options.proposalCount ?? 0) }] };
    }
    if (
      normalized.includes("FROM local_repository_sources") &&
      normalized.includes("source_identity")
    ) {
      if (options.existingSource === true) {
        return {
          rowCount: 1,
          rows: [
            {
              id: sourceId,
              project_id: projectId,
              object_format: "sha1",
              attachment_state: "attached",
            },
          ],
        };
      }
      return { rowCount: 0, rows: [] };
    }
    if (normalized.includes("FROM projects") && normalized.includes("WHERE id = $1")) {
      return {
        rowCount: 1,
        rows: [
          {
            canonical_project_id: null,
            id: projectId,
            provider_observation_kind: null,
            provider: null,
            provider_repository_id: null,
            repository_owner_snapshot: null,
            repository_name_snapshot: null,
            repository_canonical_url_snapshot: null,
          },
        ],
      };
    }
    if (normalized.includes("FROM projects AS p")) {
      return { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith("UPDATE local_repository_sources")) {
      return { rowCount: 1, rows: [] };
    }
    if (normalized.includes("FROM review_revisions") && normalized.includes("base_object_id")) {
      if (options.staleAcquiringRevision === true) {
        return {
          rowCount: 1,
          rows: [
            {
              id: revisionId,
              change_proposal_id: proposalId,
              acquisition_change_intent_id: intentId,
              revision_state: "acquiring",
              base_ref_snapshot: "refs/heads/main",
              base_object_id: "a".repeat(40),
              head_ref_snapshot: "refs/heads/review-source",
              head_object_id: "b".repeat(40),
              object_format: "sha1",
              max_bytes: "1048576",
              max_objects: "1000",
              object_count: null,
              retained_bytes: null,
              failure_reason: null,
              created_at: timestamp,
              updated_at: timestamp,
              available_at: null,
            },
          ],
        };
      }
      return { rowCount: 0, rows: [] };
    }
    if (
      normalized.includes("UPDATE review_revisions") &&
      normalized.includes("acquisition_interrupted") &&
      normalized.includes("interval '30 minutes'")
    ) {
      return {
        rowCount: options.staleAcquiringRevision === true ? 1 : 0,
        rows:
          options.staleAcquiringRevision === true
            ? [
                {
                  id: revisionId,
                  change_proposal_id: proposalId,
                  acquisition_change_intent_id: intentId,
                  revision_state: "unavailable",
                  base_ref_snapshot: "refs/heads/main",
                  base_object_id: "a".repeat(40),
                  head_ref_snapshot: "refs/heads/review-source",
                  head_object_id: "b".repeat(40),
                  object_format: "sha1",
                  max_bytes: "1048576",
                  max_objects: "1000",
                  object_count: null,
                  retained_bytes: null,
                  failure_reason: "acquisition_interrupted",
                  created_at: timestamp,
                  updated_at: timestamp,
                  available_at: null,
                },
              ]
            : [],
      };
    }
    if (
      normalized.startsWith("UPDATE review_revisions") &&
      normalized.includes("SET revision_state = 'acquiring'")
    ) {
      return {
        rowCount: 1,
        rows: [{ id: revisionId, revision_state: "acquiring", created_at: timestamp }],
      };
    }
    if (normalized.includes("FROM change_proposals") && normalized.includes("base_object_id")) {
      return { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith("INSERT INTO projects")) {
      return { rowCount: 1, rows: [{ id: projectId }] };
    }
    if (normalized.startsWith("INSERT INTO local_repository_sources")) {
      return { rowCount: 1, rows: [{ id: sourceId }] };
    }
    if (normalized.startsWith("INSERT INTO change_proposals")) {
      return { rowCount: 1, rows: [{ id: proposalId }] };
    }
    if (
      normalized.includes("FROM change_intents") &&
      normalized.includes("max(intent.version) OVER ()")
    ) {
      return { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith("INSERT INTO change_intents")) {
      return {
        rowCount: 1,
        rows: [
          {
            id: intentId,
            version: "1",
            intent_text: "Review authorization boundaries",
            created_at: timestamp,
          },
        ],
      };
    }
    if (normalized.startsWith("INSERT INTO review_revisions")) {
      return {
        rowCount: 1,
        rows: [{ id: revisionId, revision_state: "acquiring", created_at: timestamp }],
      };
    }
    if (normalized.includes("pg_advisory_unlock")) {
      return { rowCount: 1, rows: [{ unlocked: true }] };
    }
    if (normalized.includes("pg_advisory_xact_lock") || normalized.includes("pg_advisory_lock")) {
      return { rowCount: 1, rows: [{}] };
    }
    if (normalized.startsWith("SELECT record_hash")) {
      return { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith("SELECT nextval")) {
      return { rowCount: 1, rows: [{ id: "1", occurred_at: timestamp }] };
    }
    if (normalized.startsWith("INSERT INTO installation_audit_records")) {
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  });
  const release = vi.fn();
  const pool = {
    connect: vi.fn(() => ({ query, release })),
  } as unknown as DatabasePool;
  return { pool, query, release, statements, parameters };
}

describe("Review Revision persistence", () => {
  it("rejects an artifact locator for a different Project or revision", async () => {
    const pool = { connect: vi.fn() } as unknown as DatabasePool;

    await expect(
      completeReviewRevision(pool, {
        actorId: operatorId,
        artifact: {
          artifactLocator:
            "projects/018f0f89-9a22-7864-aac2-8df71bf60420/revisions/018f0f89-9a21-7271-b92d-f1cb0d48bb48",
          manifestDigest: "d".repeat(64),
          objectCount: 8,
          retainedBytes: 4096,
        },
        base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
        correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
        head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
        objectFormat: "sha1",
        projectId,
        revisionId,
      }),
    ).rejects.toThrow("Retained artifact observation is invalid");
    expect(
      (pool as unknown as { connect: ReturnType<typeof vi.fn> }).connect,
    ).not.toHaveBeenCalled();
  });

  it("records exact commit IDs and Change Intent before returning acquisition authority", async () => {
    const database = acquisitionPool();

    await expect(
      beginReviewRevision(database.pool, {
        actorId: operatorId,
        correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
        changeIntent: "Review authorization boundaries",
        maxBytes: 1_048_576,
        maxObjects: 1_000,
        base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
        head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
        source: {
          displayName: "kestrel",
          githubRepository: null,
          objectFormat: "sha1",
          relativePath: "kestrel",
          repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
          rootId: "018f0f89-9a1f-72ae-82c4-ef8ee27d6932",
          sourceIdentity: "c".repeat(64),
        },
      }),
    ).resolves.toMatchObject({
      outcome: "acquire",
      projectId,
      localRepositorySourceId: sourceId,
      changeProposalId: proposalId,
      changeIntent: { id: intentId, version: 1, text: "Review authorization boundaries" },
      revision: {
        id: revisionId,
        state: "acquiring",
        base: { objectId: "a".repeat(40) },
        head: { objectId: "b".repeat(40) },
      },
    });
    expect(database.statements[0]).toBe("BEGIN");
    expect(database.statements).toContain("COMMIT");
    expect(database.statements.at(-1)).toContain("pg_advisory_unlock");
    expect(database.statements).not.toContain("ROLLBACK");
    expect(
      database.statements.find(
        (statement) =>
          statement.includes("FROM change_intents") &&
          statement.includes("max(intent.version) OVER ()"),
      ),
    ).toContain("ORDER BY intent.version DESC");
    expect(
      database.statements.find(
        (statement) =>
          statement.startsWith("UPDATE local_repository_sources") &&
          statement.includes("source_identity <> $4"),
      ),
    ).toContain("SELECT id FROM projects WHERE id = $2 OR canonical_project_id = $2");
    expect(database.release).toHaveBeenCalledOnce();
  });

  it("rejects acquisition when the attached source resolves to another expected Project", async () => {
    const database = acquisitionPool({ existingSource: true });

    await expect(
      beginReviewRevision(database.pool, {
        actorId: operatorId,
        correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
        changeIntent: "Review authorization boundaries",
        expectedProjectId: "018f0f89-a22a-7d63-b6f7-108b7b4bf52f",
        maxBytes: 1_048_576,
        maxObjects: 1_000,
        base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
        head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
        source: {
          displayName: "kestrel",
          githubRepository: null,
          objectFormat: "sha1",
          relativePath: "kestrel",
          repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
          rootId: "018f0f89-9a1f-72ae-82c4-ef8ee27d6932",
          sourceIdentity: "c".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ code: "change_proposal_mismatch" });
    expect(database.statements).not.toContain(
      expect.stringMatching(/^UPDATE local_repository_sources/u),
    );
    expect(database.statements.at(-1)).toBe("ROLLBACK");
  });

  it("atomically reclaims and retries a stale acquiring exact revision", async () => {
    const database = acquisitionPool({ existingSource: true, staleAcquiringRevision: true });

    await expect(
      beginReviewRevision(database.pool, {
        actorId: operatorId,
        correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
        changeIntent: "Review authorization boundaries",
        maxBytes: 1_048_576,
        maxObjects: 1_000,
        base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
        head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
        source: {
          displayName: "kestrel",
          githubRepository: null,
          objectFormat: "sha1",
          relativePath: "kestrel",
          repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
          rootId: "018f0f89-9a1f-72ae-82c4-ef8ee27d6932",
          sourceIdentity: "c".repeat(64),
        },
      }),
    ).resolves.toMatchObject({ outcome: "acquire", revision: { id: revisionId } });
    expect(
      database.statements.find(
        (statement) =>
          statement.includes("UPDATE review_revisions") &&
          statement.includes("acquisition_interrupted"),
      ),
    ).toContain("interval '30 minutes'");
    expect(
      database.statements.find(
        (statement) =>
          statement.includes("UPDATE review_revisions") &&
          statement.includes("acquisition_interrupted"),
      ),
    ).toContain("pg_try_advisory_xact_lock");
    expect(
      database.statements.filter((statement) =>
        statement.startsWith("INSERT INTO installation_audit_records"),
      ),
    ).toHaveLength(2);
  });

  it("rejects a new canonical Project at the Installation capacity boundary", async () => {
    const database = acquisitionPool({ projectCount: 100 });

    await expect(
      beginReviewRevision(database.pool, {
        actorId: operatorId,
        correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
        changeIntent: "Review authorization boundaries",
        maxBytes: 1_048_576,
        maxObjects: 1_000,
        base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
        head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
        source: {
          displayName: "kestrel",
          githubRepository: null,
          objectFormat: "sha1",
          relativePath: "kestrel",
          repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
          rootId: "018f0f89-9a1f-72ae-82c4-ef8ee27d6932",
          sourceIdentity: "c".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ code: "revision_limit_exceeded" });
    expect(database.statements).not.toContain(expect.stringMatching(/^INSERT INTO projects/u));
    expect(database.statements.at(-1)).toBe("ROLLBACK");
  });

  it("rejects a new canonical Change Proposal at the Project capacity boundary", async () => {
    const database = acquisitionPool({ existingSource: true, proposalCount: 100 });

    await expect(
      beginReviewRevision(database.pool, {
        actorId: operatorId,
        correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
        changeIntent: "Review authorization boundaries",
        maxBytes: 1_048_576,
        maxObjects: 1_000,
        base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
        head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
        source: {
          displayName: "kestrel",
          githubRepository: null,
          objectFormat: "sha1",
          relativePath: "kestrel",
          repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
          rootId: "018f0f89-9a1f-72ae-82c4-ef8ee27d6932",
          sourceIdentity: "c".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ code: "revision_limit_exceeded" });
    expect(database.statements).not.toContain(
      expect.stringMatching(/^INSERT INTO change_proposals/u),
    );
    expect(database.statements.at(-1)).toBe("ROLLBACK");
  });

  it.each([
    {
      label: "adds a GitHub identity",
      githubRepository: { owner: "Ic3b3rg", name: "kestrel" },
    },
    { label: "removes a GitHub identity", githubRepository: null },
    {
      label: "changes a GitHub identity",
      githubRepository: { owner: "openai", name: "kestrel-next" },
    },
  ])("atomically $label when reattaching a local source", async ({ githubRepository }) => {
    const database = acquisitionPool({ existingSource: true });

    await beginReviewRevision(database.pool, {
      actorId: operatorId,
      correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
      changeIntent: "Review updated source metadata",
      maxBytes: 1_048_576,
      maxObjects: 1_000,
      base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
      head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
      source: {
        displayName: "kestrel",
        githubRepository,
        objectFormat: "sha1",
        relativePath: "kestrel",
        repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
        rootId: "018f0f89-9a1f-72ae-82c4-ef8ee27d6932",
        sourceIdentity: "c".repeat(64),
      },
    });

    const updateIndex = database.statements.findIndex(
      (statement) =>
        statement.startsWith("UPDATE local_repository_sources") &&
        statement.includes("github_owner_snapshot"),
    );
    expect(database.statements[updateIndex]).toContain("github_owner_snapshot = $6");
    expect(database.statements[updateIndex]).toContain("github_name_snapshot = $7");
    expect(database.parameters[updateIndex]).toEqual([
      sourceId,
      "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
      "018f0f89-9a1f-72ae-82c4-ef8ee27d6932",
      "kestrel",
      "kestrel",
      githubRepository?.owner ?? null,
      githubRepository?.name ?? null,
    ]);
  });

  it("publishes a verified artifact and Project availability in one transaction", async () => {
    const statements: string[] = [];
    const query = vi.fn((statement: string) => {
      const normalized = statement.replace(/\s+/gu, " ").trim();
      statements.push(normalized);
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }
      if (
        normalized.startsWith("UPDATE review_revisions") &&
        normalized.includes("artifact_locator")
      ) {
        return {
          rowCount: 1,
          rows: [
            {
              id: revisionId,
              revision_state: "available",
              object_count: "8",
              retained_bytes: "4096",
              created_at: timestamp,
              available_at: timestamp,
            },
          ],
        };
      }
      if (normalized.startsWith("UPDATE projects")) {
        return { rowCount: 1, rows: [] };
      }
      if (normalized.includes("pg_advisory_xact_lock")) {
        return { rowCount: 1, rows: [{}] };
      }
      if (normalized.startsWith("SELECT record_hash")) {
        return { rowCount: 0, rows: [] };
      }
      if (normalized.startsWith("SELECT nextval")) {
        return { rowCount: 1, rows: [{ id: "1", occurred_at: timestamp }] };
      }
      if (normalized.startsWith("INSERT INTO installation_audit_records")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(() => ({ query, release })),
    } as unknown as DatabasePool;

    await expect(
      completeReviewRevision(pool, {
        actorId: operatorId,
        artifact: {
          artifactLocator: `projects/${projectId}/revisions/${revisionId}`,
          manifestDigest: "d".repeat(64),
          objectCount: 8,
          retainedBytes: 4096,
        },
        base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
        correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
        head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
        objectFormat: "sha1",
        projectId,
        revisionId,
      }),
    ).resolves.toMatchObject({ id: revisionId, state: "available", objectCount: 8 });
    expect(statements[0]).toBe("BEGIN");
    expect(
      statements.findIndex((value) => value.startsWith("UPDATE review_revisions")),
    ).toBeLessThan(statements.findIndex((value) => value.startsWith("UPDATE projects")));
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("records an unavailable outcome without an artifact locator", async () => {
    const statements: string[] = [];
    const parameters: unknown[][] = [];
    const query = vi.fn((statement: string, values?: unknown[]) => {
      const normalized = statement.replace(/\s+/gu, " ").trim();
      statements.push(normalized);
      parameters.push(values ?? []);
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }
      if (normalized.startsWith("SELECT project_id, revision_state FROM review_revisions")) {
        return {
          rowCount: 1,
          rows: [{ project_id: projectId, revision_state: "acquiring" }],
        };
      }
      if (normalized.startsWith("UPDATE review_revisions")) {
        return { rowCount: 1, rows: [{ project_id: projectId }] };
      }
      if (normalized.startsWith("UPDATE projects")) {
        return { rowCount: 1, rows: [] };
      }
      if (normalized.includes("pg_advisory_xact_lock")) {
        return { rowCount: 1, rows: [{}] };
      }
      if (normalized.startsWith("SELECT record_hash")) {
        return { rowCount: 0, rows: [] };
      }
      if (normalized.startsWith("SELECT nextval")) {
        return { rowCount: 1, rows: [{ id: "1", occurred_at: timestamp }] };
      }
      if (normalized.startsWith("INSERT INTO installation_audit_records")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    });
    const pool = {
      connect: vi.fn(() => ({ query, release: vi.fn() })),
    } as unknown as DatabasePool;

    await expect(
      failReviewRevision(
        pool,
        {
          actorId: operatorId,
          correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
          failureReason: "object_missing",
          revisionId,
        },
        () => {
          statements.push("quarantine exact artifact");
          parameters.push([]);
          return Promise.resolve();
        },
      ),
    ).resolves.toBeUndefined();
    const revisionLock = statements.findIndex((value) =>
      value.startsWith("SELECT project_id, revision_state FROM review_revisions"),
    );
    const quarantine = statements.indexOf("quarantine exact artifact");
    const revisionUpdate = statements.findIndex((value) =>
      value.startsWith("UPDATE review_revisions"),
    );
    expect(revisionLock).toBeLessThan(quarantine);
    expect(quarantine).toBeLessThan(revisionUpdate);
    expect(parameters[revisionUpdate]).toEqual([revisionId, "object_missing"]);
    expect(statements[revisionUpdate]).not.toContain("artifact_locator = $");
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("does not quarantine when a completion may already be available", async () => {
    const statements: string[] = [];
    const query = vi.fn((statement: string) => {
      const normalized = statement.replace(/\s+/gu, " ").trim();
      statements.push(normalized);
      if (normalized === "BEGIN" || normalized === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }
      if (normalized.startsWith("SELECT project_id, revision_state FROM review_revisions")) {
        return {
          rowCount: 1,
          rows: [{ project_id: projectId, revision_state: "available" }],
        };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    });
    const pool = {
      connect: vi.fn(() => ({ query, release: vi.fn() })),
    } as unknown as DatabasePool;
    const quarantine = vi.fn(() => Promise.resolve());

    await expect(
      failReviewRevision(
        pool,
        {
          actorId: operatorId,
          correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
          failureReason: "artifact_finalization_failed",
          revisionId,
        },
        quarantine,
      ),
    ).rejects.toMatchObject({ code: "revision_state_conflict" });
    expect(quarantine).not.toHaveBeenCalled();
    expect(statements.at(-1)).toBe("ROLLBACK");
  });

  it("reconciles only acquiring revisions older than the recovery cutoff", async () => {
    const statements: string[] = [];
    const query = vi.fn((statement: string) => {
      const normalized = statement.replace(/\s+/gu, " ").trim();
      statements.push(normalized);
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }
      if (normalized.startsWith("SELECT id, project_id, max_bytes, max_objects")) {
        return { rowCount: 0, rows: [] };
      }
      if (normalized.startsWith("UPDATE projects AS p")) {
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    });
    const pool = {
      connect: vi.fn(() => ({ query, release: vi.fn() })),
    } as unknown as DatabasePool;

    await expect(reconcileAcquiringRevisions(pool)).resolves.toBe(0);
    expect(
      statements.find((statement) =>
        statement.startsWith("SELECT id, project_id, max_bytes, max_objects"),
      ),
    ).toContain("updated_at <= clock_timestamp() - interval '30 minutes'");
    expect(
      statements.find((statement) =>
        statement.startsWith("SELECT id, project_id, max_bytes, max_objects"),
      ),
    ).toContain("FOR UPDATE");
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("holds a per-revision lease from before reservation commit through acquisition", async () => {
    const database = acquisitionPool();

    await expect(
      withReviewRevisionAcquisitionLease(
        database.pool,
        {
          actorId: operatorId,
          correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
          changeIntent: "Review authorization boundaries",
          maxBytes: 1_048_576,
          maxObjects: 1_000,
          base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
          head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
          source: {
            displayName: "kestrel",
            githubRepository: null,
            objectFormat: "sha1",
            relativePath: "kestrel",
            repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
            rootId: "018f0f89-9a1f-72ae-82c4-ef8ee27d6932",
            sourceIdentity: "c".repeat(64),
          },
        },
        (begun) => {
          database.statements.push("artifact-acquisition");
          return begun.revision.id;
        },
      ),
    ).resolves.toBe(revisionId);

    const lease = database.statements.findIndex(
      (statement) =>
        statement.includes("pg_advisory_lock") && statement.includes("kestrel-review-revision:"),
    );
    const commit = database.statements.indexOf("COMMIT");
    const acquisition = database.statements.indexOf("artifact-acquisition");
    const unlock = database.statements.findIndex(
      (statement) =>
        statement.includes("pg_advisory_unlock") && statement.includes("kestrel-review-revision:"),
    );
    expect(lease).toBeGreaterThan(-1);
    expect(lease).toBeLessThan(commit);
    expect(commit).toBeLessThan(acquisition);
    expect(acquisition).toBeLessThan(unlock);
    expect(database.release).toHaveBeenCalledOnce();
  });

  it("selects one attached source per canonical Project family during startup", async () => {
    const statements: string[] = [];
    const query = vi.fn((statement: string) => {
      const normalized = statement.replace(/\s+/gu, " ").trim();
      statements.push(normalized);
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }
      if (normalized.startsWith("SELECT DISTINCT ON")) {
        return { rowCount: 1, rows: [{ id: sourceId }] };
      }
      if (normalized.startsWith("UPDATE local_repository_sources")) {
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    });
    const pool = {
      connect: vi.fn(() => ({ query, release: vi.fn() })),
    } as unknown as DatabasePool;

    await expect(
      reconcileLocalSourceAttachments(pool, [
        {
          repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
          sourceIdentity: "c".repeat(64),
        },
      ]),
    ).resolves.toBe(0);
    const selection = statements.find((statement) => statement.startsWith("SELECT DISTINCT ON"));
    expect(selection).toContain(
      "DISTINCT ON ( COALESCE(source_project.canonical_project_id, source_project.id) )",
    );
    expect(selection).toContain("INNER JOIN projects AS source_project");
    expect(selection).toContain(
      "ORDER BY COALESCE(source_project.canonical_project_id, source_project.id)",
    );
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("holds and releases the artifact lifecycle session lock around the operation", async () => {
    const calls: string[] = [];
    const query = vi.fn((statement: string) => {
      calls.push(statement.replace(/\s+/gu, " ").trim());
      return {
        rowCount: 1,
        rows: [statement.includes("advisory_unlock") ? { unlocked: true } : {}],
      };
    });
    const release = vi.fn(() => calls.push("release"));
    const pool = {
      connect: vi.fn(() => ({ query, release })),
    } as unknown as DatabasePool;

    await expect(
      withArtifactLifecycleLock(pool, () => {
        calls.push("operation");
        return "done";
      }),
    ).resolves.toBe("done");
    expect(calls).toEqual([
      expect.stringContaining("pg_advisory_lock"),
      "operation",
      expect.stringContaining("pg_advisory_unlock"),
      "release",
    ]);
  });

  it("holds an exclusive lifecycle lock around artifact acquisition", async () => {
    const calls: string[] = [];
    const query = vi.fn((statement: string) => {
      calls.push(statement.replace(/\s+/gu, " ").trim());
      return {
        rowCount: 1,
        rows: [statement.includes("advisory_unlock") ? { unlocked: true } : {}],
      };
    });
    const release = vi.fn(() => calls.push("release"));
    const pool = {
      connect: vi.fn(() => ({ query, release })),
    } as unknown as DatabasePool;

    await expect(
      withArtifactAcquisitionLock(pool, () => {
        calls.push("reservation-and-acquisition");
        return "done";
      }),
    ).resolves.toBe("done");
    expect(calls).toEqual([
      expect.stringContaining("pg_advisory_lock("),
      "reservation-and-acquisition",
      expect.stringContaining("pg_advisory_unlock("),
      "release",
    ]);
  });

  it("makes parallel acquisitions progress with a one-client pool", async () => {
    type ResolveClient = (client: { query: typeof query; release: typeof release }) => void;
    const waiters: ResolveClient[] = [];
    let busy = false;
    const query = vi.fn((statement: string) => ({
      rowCount: 1,
      rows: [statement.includes("advisory_unlock") ? { unlocked: true } : {}],
    }));
    const release = vi.fn(() => {
      const next = waiters.shift();
      if (next === undefined) {
        busy = false;
        return;
      }
      queueMicrotask(() => next(client));
    });
    const client = { query, release };
    const connect = vi.fn(
      () =>
        new Promise<typeof client>((resolve) => {
          if (busy) {
            waiters.push(resolve);
          } else {
            busy = true;
            resolve(client);
          }
        }),
    );
    const pool = { connect } as unknown as DatabasePool;

    const results = await Promise.all(
      [1, 2].map((value) =>
        withArtifactAcquisitionLock(pool, async (lockedPool) => {
          const transactionClient = await lockedPool.connect();
          await transactionClient.query("SELECT $1::int AS value", [value]);
          transactionClient.release();
          return value;
        }),
      ),
    );

    expect(results).toEqual([1, 2]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["exclusive", withArtifactLifecycleLock],
    ["acquisition", withArtifactAcquisitionLock],
  ])("destroys a client after a failed %s lifecycle unlock", async (_label, withLock) => {
    const query = vi.fn((statement: string) => {
      if (statement.includes("advisory_unlock")) {
        throw new Error("connection lost during unlock");
      }
      return { rowCount: 1, rows: [{}] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(() => ({ query, release })),
    } as unknown as DatabasePool;

    await expect(withLock(pool, () => "done")).resolves.toBe("done");
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
  });
});
