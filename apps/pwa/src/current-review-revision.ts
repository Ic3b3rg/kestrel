import type { ProjectInbox } from "@kestrel/contracts";

type ChangeProposal = ProjectInbox["projects"][number]["changeProposals"][number];

export function currentReviewRevision(proposal: ChangeProposal) {
  return proposal.reviewRevisions.find(
    (revision) =>
      revision.base.objectId === proposal.base.objectId &&
      revision.head.objectId === proposal.head.objectId,
  );
}
