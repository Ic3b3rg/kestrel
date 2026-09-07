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
