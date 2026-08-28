# Make Review First V1 local-first

Status: Accepted — 2026-08-26; amended 2026-08-28.

Review First V1 runs on the Operator's workstation and materializes every Conceptual Review from
exact commits supplied through a Local Repository Source. Public GitHub reads and the host's
existing authenticated provider session may discover or enrich a Change Proposal, but they establish
no alternative source authority. The attached Local Repository Source remains the access gate for a
bounded missing-object fetch described below. Kestrel stores no provider credential, modifies
neither the provider nor the Operator's repository, and permits review only after the exact
base/head pair has been verified and retained locally.

This decision supersedes ADR 0001 for Review First V1 because one local revision seam serves public
open-source and policy-constrained private work with substantially less credential, callback,
tenancy, deployment, and synchronization machinery. A supported VPS or cloud deployment, GitHub App,
webhook synchronization, GitLab adapter, multi-Operator operation, and remote availability are
deferred; future provider adapters must still feed the same local Review Revision contract rather
than introduce another review path.

The Local Repository Source remains the Operator-authorized access gate and the first object source.
When that attached source matches an observed GitHub pull request but lacks one of its captured
exact objects, Kestrel may supplement it with a fixed fetch from the server-derived canonical GitHub
remote into a disposable, Project-scoped Kestrel bare repository. The initial fetch requests only
the captured base branch and pull request refs. If either ref is absent or has moved, Kestrel may
make one bounded recovery fetch for the captured exact object IDs through that same canonical base
repository; it never contacts a head repository or substitutes a newly observed object. The
Operator's repository is not read from or written to by either fetch. Git may consult the host's
existing credential helpers, but credentials remain inside Git's credential flow and are neither
imported nor retained by Kestrel. Provider metadata alone still grants no source authority, and the
retained, locally verified Review Revision remains the sole review input.
