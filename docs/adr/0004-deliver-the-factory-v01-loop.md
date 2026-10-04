# Deliver Factory 0.1 as the first complete development loop

Status: Accepted — 2026-09-07, by explicit Operator confirmation and implementation request.

Kestrel's immediate delivery target is Factory 0.1: in-product planning, an approved feature plan,
automatic ordered issue execution, Human Gates, one feature PR, Conceptual Review, selected
corrections, and an explicitly approved merge.

This supersedes the release-scope restriction that reserves all writable development for after
Review First. It preserves ADR 0002's workstation-first deployment and exact locally retained review
source, ADR 0003's Codex App Server integration, and the distinction between writable Agent Run
workspaces and read-only review authority.

The Operator chose one active feature per Project, concurrent work across Projects, Kestrel-owned
workflow state with GitHub issue storage, and a requirements-first review graph. Published review
findings require an Operator correction request. Only a confirmed merge completes Work Items. The
browser is an observation/control surface and does not own background execution lifetime.

The trade-off is explicit: deliver a useful complete loop before the full Certified Review First
roadmap, while retaining honest evidence, exact-revision identity, explicit authority, and source
preservation. The old review tickets remain prior work and future capability candidates; they are
not all prerequisites for 0.1.

The canonical scope is [Factory 0.1](../factory-v01/spec.md).

## Amendment: interview and individual issue authority (2026-09-28)

The approved interview handoff supersedes automatic execution after publication for new Features.
Reviewing requirements and publishing issue drafts freezes their content and leaves them in To do.
Only an explicit board start authorizes the selected issue. Dependencies must be completed and
merged; waiting never authorizes them. Retried gestures share the same durable start receipt.

Each selected Work Item is projected into an internal one-item execution Feature with its own frozen
plan, approval profile, branch, verification, PR and Conceptual Review. This reuses the existing
verified lifecycle without waiting for unstarted siblings. The Project board keeps the original Work
Item identity and links to the execution Feature. Scope, checks and proposed documents are limited
to that issue; the parent conversation remains inspectable. This deliberately retains one active
execution per Project. Migration marks already approved Features as authorized, preserving their
cumulative behavior; unapproved and new Features use individual starts.

The explicit issue start freezes the then-current committed local source and its identity. It proves
every prerequisite's confirmed merge commit is an ancestor before granting execution. If the local
source is stale or ancestry exceeds the bounded read budget, the board returns an actionable block;
Kestrel never silently runs the old interview snapshot or fetches/changes the Operator checkout. The
original requirements retain their interview provenance separately.

## Amendment: autonomous ready-issue execution (2026-10-01)

The Operator confirmed that a started issue already has a small, sourced scope. Preparation reads
its complete discussion, cited issue contracts and prerequisite state, then consults committed
repository documents, code and tests. It derives implementation choices and verification commands
within that scope. Missing source access is a technical preparation failure, not a Human Gate asking
the Operator to reconstruct requirements. No incomplete or input-required plan authorizes execution.
Human Gates remain only for consequential product or authority decisions unresolved by these
sources. The issue workspace presents one chronological conversation with retained activity, child
agents, verification and result; requirements and review remain inspectable without workflow tabs.
Explicit merge authority remains unchanged. Cancellation preserves history and makes the open issue
available in To do for a fresh explicit start.
