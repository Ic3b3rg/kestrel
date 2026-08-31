import { describe, expect, it, vi } from "vitest";

import {
  claimChangeOverviewRendering,
  completeChangeOverviewRendering,
  enqueueChangeOverviewRendering,
  parseChangeOverviewRenderingJob,
} from "./change-overview-renderings.js";
import {
  CHANGE_OVERVIEW_RENDER_QUEUE,
  CHANGE_OVERVIEW_RENDER_QUEUE_OPTIONS,
  CHANGE_OVERVIEW_RENDER_QUEUE_UPDATE_OPTIONS,
} from "./pg-boss.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const proposalId = "018f0f89-9192-755f-aa96-f72094c734dd";
const revisionId = "018f0f89-9a21-7271-b92d-f1cb0d48bb47";
const generationToken = "018f0f89-9a23-7d64-a5dd-18cc3e317401";
const correlationId = "018f0f89-949a-75a8-8f61-6df78a843b1f";
const requestedAt = new Date("2026-08-24T12:00:00.000Z");
const startedAt = new Date("2026-08-24T12:00:00.025Z");
const overviewFacts = {
  ruleVersion: 1 as const,
  commitStatistics: { baseTreeFileCount: 2, headTreeFileCount: 3 },
  fileStatistics: { added: 0, modified: 1, deleted: 0, total: 1 },
  changedFiles: [
    {
      path: "src/review.ts",
      status: "modified" as const,
      base: { mode: "100644" as const, objectId: "c".repeat(40), type: "blob" as const },
      head: { mode: "100644" as const, objectId: "d".repeat(40), type: "blob" as const },
    },
  ],
  pathAreas: [{ pathPrefix: "src", changedFileCount: 1, samplePaths: ["src/review.ts"] }],
  warnings: [],
};

describe("Change Overview rendering queue", () => {
  it("coalesces the latest Proposal head into one low-priority fenced job", async () => {
    const query = vi.fn((statement: string) => ({
      command: statement,
      rowCount: 1,
      rows: [
        {
          change_proposal_id: proposalId,
          exact_head_object_id: "b".repeat(40),
          generation_token: generationToken,
          project_id: projectId,
          review_revision_id: revisionId,
        },
      ],
    }));
    const upsert = vi.fn(() =>
      Promise.resolve({ inserted: 1, jobs: [generationToken], updated: 0 }),
    );

    await enqueueChangeOverviewRendering(
      { query } as never,
      { upsert },
      {
        correlationId,
        projectId,
        revisionId,
      },
    );

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (change_proposal_id) DO UPDATE");
    expect(query.mock.calls[0]?.[0]).toContain(
      "WHERE rendering.exact_head_object_id IS DISTINCT FROM EXCLUDED.exact_head_object_id",
    );
    expect(query.mock.calls[0]?.[0]).not.toContain(
      "WHERE rendering.review_revision_id IS DISTINCT FROM",
    );
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith(
      CHANGE_OVERVIEW_RENDER_QUEUE,
      {
        changeProposalId: proposalId,
        correlationId,
        exactHeadObjectId: "b".repeat(40),
        generationToken,
        projectId,
        reviewRevisionId: revisionId,
      },
      expect.objectContaining({
        priority: -10,
        singletonKey: proposalId,
      }),
    );
    expect(CHANGE_OVERVIEW_RENDER_QUEUE_OPTIONS).toMatchObject({
      policy: "stately",
      retryLimit: 0,
    });
    expect(CHANGE_OVERVIEW_RENDER_QUEUE_UPDATE_OPTIONS).not.toHaveProperty("policy");
  });

  it("does not enqueue the same Proposal/head generation twice", async () => {
    const query = vi.fn((statement: string) => ({ command: statement, rowCount: 0, rows: [] }));
    const upsert = vi.fn();

    await enqueueChangeOverviewRendering(
      { query } as never,
      { upsert },
      {
        correlationId,
        projectId,
        revisionId,
      },
    );

    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects unfenced or expanded job payloads", () => {
    const job = {
      changeProposalId: proposalId,
      correlationId,
      exactHeadObjectId: "b".repeat(40),
      generationToken,
      projectId,
      reviewRevisionId: revisionId,
    };

    expect(parseChangeOverviewRenderingJob(job)).toEqual(job);
    expect(() =>
      parseChangeOverviewRenderingJob({ ...job, exactHeadObjectId: "branch-name" }),
    ).toThrow();
    expect(() => parseChangeOverviewRenderingJob({ ...job, arbitraryOption: true })).toThrow();
  });

  it("claims only the current queued Proposal/head without holding a model-time transaction", async () => {
    const query = vi.fn((statement: string) => ({
      command: statement,
      rowCount: 1,
      rows: [
        {
          requested_at: requestedAt,
          started_at: startedAt,
          project_id: projectId,
          object_format: "sha1",
          base_ref_snapshot: "refs/heads/main",
          base_object_id: "a".repeat(40),
          base_commit_author_snapshot: "Base Author",
          base_commit_subject_snapshot: "Base subject",
          head_ref_snapshot: "refs/heads/change",
          head_object_id: "b".repeat(40),
          head_commit_author_snapshot: "Head Author",
          head_commit_subject_snapshot: "Head subject",
          source_facts: overviewFacts,
        },
      ],
    }));
    const job = parseChangeOverviewRenderingJob({
      changeProposalId: proposalId,
      correlationId,
      exactHeadObjectId: "b".repeat(40),
      generationToken,
      projectId,
      reviewRevisionId: revisionId,
    });

    await expect(claimChangeOverviewRendering({ query } as never, job)).resolves.toEqual({
      exactRevision: {
        objectFormat: "sha1",
        base: {
          author: "Base Author",
          objectId: "a".repeat(40),
          ref: "refs/heads/main",
          subject: "Base subject",
        },
        head: {
          author: "Head Author",
          objectId: "b".repeat(40),
          ref: "refs/heads/change",
          subject: "Head subject",
        },
      },
      projectId,
      queueMilliseconds: 25,
      requestedAt,
      sourceFacts: overviewFacts,
      startedAt,
    });
    expect(query.mock.calls[0]?.[0]).toContain("rendering.generation_token = $4");
    expect(query.mock.calls[0]?.[0]).toContain("canonical.head_object_id = $3");
  });

  it("rejects late completion after the Proposal/head fence moves", async () => {
    const query = vi
      .fn((statement: string): { command: string; rowCount: number | null; rows: never[] } => ({
        command: statement,
        rowCount: 0,
        rows: [],
      }))
      .mockReturnValueOnce({ command: "BEGIN", rowCount: null, rows: [] })
      .mockReturnValueOnce({ command: "UPDATE", rowCount: 0, rows: [] })
      .mockReturnValueOnce({ command: "COMMIT", rowCount: null, rows: [] });
    const release = vi.fn();
    const job = parseChangeOverviewRenderingJob({
      changeProposalId: proposalId,
      correlationId,
      exactHeadObjectId: "b".repeat(40),
      generationToken,
      projectId,
      reviewRevisionId: revisionId,
    });

    await expect(
      completeChangeOverviewRendering(
        { connect: vi.fn(() => ({ query, release })) } as never,
        job,
        {
          kind: "ready",
          kestrelMilliseconds: 125,
          modelMilliseconds: 1_000,
          providerRequestId: "req_overview_1",
          queueMilliseconds: 180_000,
          sentences: [
            {
              text: "The retained change modifies 1 file under `src`.",
              sourceFactIds: ["file_statistics", "path_area_001"],
            },
          ],
        },
      ),
    ).resolves.toBe(false);
    expect(query.mock.calls[1]?.[0]).toContain("rendering.generation_token = $4");
    expect(query.mock.calls[1]?.[0]).toContain("canonical.head_object_id = $3");
    expect(release).toHaveBeenCalledOnce();
  });

  it("completes background rendering without advancing the Proposal version", async () => {
    const query = vi
      .fn((statement: string): { command: string; rowCount: number | null; rows: unknown[] } => ({
        command: statement,
        rowCount: null,
        rows: [],
      }))
      .mockReturnValueOnce({ command: "BEGIN", rowCount: null, rows: [] })
      .mockReturnValueOnce({
        command: "UPDATE",
        rowCount: 1,
        rows: [{ change_proposal_id: proposalId }],
      })
      .mockReturnValueOnce({ command: "COMMIT", rowCount: null, rows: [] });
    const release = vi.fn();
    const job = parseChangeOverviewRenderingJob({
      changeProposalId: proposalId,
      correlationId,
      exactHeadObjectId: "b".repeat(40),
      generationToken,
      projectId,
      reviewRevisionId: revisionId,
    });

    await expect(
      completeChangeOverviewRendering(
        { connect: vi.fn(() => ({ query, release })) } as never,
        job,
        {
          kind: "unavailable",
          kestrelMilliseconds: 40,
          modelMilliseconds: 0,
          queueMilliseconds: 25,
          reason: "profile_not_configured",
        },
      ),
    ).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.some(([statement]) => statement.includes("optimistic_version"))).toBe(
      false,
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
