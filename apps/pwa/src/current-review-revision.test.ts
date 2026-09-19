import { describe, expect, it } from "vitest";
import type { ProjectInbox } from "@kestrel/contracts";

import { currentReviewRevision } from "./current-review-revision.js";

type Proposal = ProjectInbox["projects"][number]["changeProposals"][number];

const oldRevisionId = "018f0f89-9a21-7271-b92d-f1cb0d48bb47";
const currentRevisionId = "018f0f89-9a21-7271-b92d-f1cb0d48bb48";

function revision(id: string, head: string, ref: string) {
  return {
    id,
    state: "available" as const,
    objectFormat: "sha1" as const,
    base: { objectId: "a".repeat(40), ref: "master" },
    head: { objectId: head, ref },
    objectCount: 4,
    retainedBytes: 100,
    failureReason: null,
    createdAt: "2026-09-08T12:00:00.000Z",
    availableAt: "2026-09-08T12:00:00.000Z",
  };
}

const movedProposal = {
  kind: "local",
  id: "018f0f89-9192-755f-aa96-f72094c734dd",
  version: 2,
  title: "A moved proposal",
  base: { objectId: "a".repeat(40), ref: "master" },
  head: { objectId: "c".repeat(40), ref: "feature/current" },
  changeIntent: {
    acceptanceOutcomes: [],
    id: "018f0f89-9a20-79f9-9990-dda80c9b917d",
    objective: "Open the certified revision.",
    resolution: { state: "resolved", issues: [] },
    scopeBoundaries: [],
    sourceDigest: "d".repeat(64),
    sources: [],
    version: 1,
    text: "Open the certified revision.",
    createdAt: "2026-09-08T12:00:00.000Z",
  },
  changeIntentCandidates: [],
  reviewRevisions: [
    revision(currentRevisionId, "c".repeat(40), "feature/current"),
    revision(oldRevisionId, "b".repeat(40), "feature/certified"),
  ],
  createdAt: "2026-09-08T12:00:00.000Z",
  updatedAt: "2026-09-08T12:01:00.000Z",
} satisfies Proposal;

describe("currentReviewRevision", () => {
  it("opens the explicitly retained revision after the proposal head moved", () => {
    expect(currentReviewRevision(movedProposal, oldRevisionId)?.id).toBe(oldRevisionId);
  });

  it("does not substitute the mutable current head when an explicit revision is absent", () => {
    expect(currentReviewRevision(movedProposal, "018f0f89-9a21-7271-b92d-f1cb0d48bb49")).toBe(
      undefined,
    );
  });

  it("uses the proposal head only when no retained revision was explicitly requested", () => {
    expect(currentReviewRevision(movedProposal)?.id).toBe(currentRevisionId);
  });
});
