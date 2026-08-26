# Make Review First V1 local-first

Status: Accepted — 2026-08-26.

Review First V1 runs on the Operator's workstation and materializes every Conceptual Review from
exact commits supplied through a Local Repository Source. Public GitHub reads and the host's
existing authenticated provider session may discover or enrich a Change Proposal, but they are never
an alternative source path: Kestrel stores no provider credential, modifies neither the provider nor
the Operator's repository, and permits review only after the exact base/head pair has been verified
and retained locally.

This decision supersedes ADR 0001 for Review First V1 because one local revision seam serves public
open-source and policy-constrained private work with substantially less credential, callback,
tenancy, deployment, and synchronization machinery. A supported VPS or cloud deployment, GitHub App,
webhook synchronization, GitLab adapter, multi-Operator operation, and remote availability are
deferred; future provider adapters must still feed the same local Review Revision contract rather
than introduce another review path.
