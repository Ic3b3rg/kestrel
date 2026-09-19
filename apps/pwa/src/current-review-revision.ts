import type { ProjectInbox } from "@kestrel/contracts";

type ChangeProposal = ProjectInbox["projects"][number]["changeProposals"][number];

export function currentReviewRevision(proposal: ChangeProposal, requiredRevisionId?: string) {
  if (requiredRevisionId !== undefined) {
    return proposal.reviewRevisions.find((revision) => revision.id === requiredRevisionId);
  }
  return proposal.reviewRevisions.find(
    (revision) => revision.head.objectId === proposal.head.objectId,
  );
}
