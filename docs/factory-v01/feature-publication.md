# Certified Feature publication

Part of [Factory 0.1](spec.md), [#235](https://github.com/Ic3b3rg/kestrel/issues/235).

After all approved Work Items finish, [final verification](final-verification.md) runs the complete
command manifest on the cumulative Feature revision. Publication consumes that immutable
certificate. Earlier Work Item results alone cannot authorize a push or PR.

The host dispatcher continues without an open browser. It checks the original approved plan, source
attachment, released execution reservations, published or imported issue identities, final head/tree
and each certified check result before admitting publication. It rechecks those inputs before each
external write.

## One frozen operation

Before pushing, Kestrel records the original GitHub repository/account, named `origin`, target
branch, Feature branch, exact base/head/tree, ordered issues and PR payload. The provider's default
branch must still point to the frozen Feature base. A different account, remote, repository, missing
target or changed base becomes an explicit blocker. Retrying never chooses another target or rebases
the approved work.

Only `refs/heads/kestrel/feature/<feature-id>` can be published. Controller Git uses an explicit
argument array and a create-only lease for the certified commit. Existing host credentials remain in
the native Git/GitHub CLI flow. Publication does not modify the Operator's checkout, index, original
refs or target branch.

The PR describes the approved purpose and scope, links the ordered issues and records final
verification identity and limitations. Issue references do not close issues. Work Items remain In
review until the later explicit merge flow.

## Recovery and cancellation

The database records an attempted push or PR creation before starting the write. If the result is
uncertain, recovery reads the exact remote ref or searches matching open and closed PRs. A matching
result confirms the original operation. A foreign ref, ambiguous match, incomplete search or
unreadable provider remains blocked or uncertain; absence alone does not authorize another write
after an uncertain attempt.

The Feature panel explains pending, publishing, blocked, uncertain, published and cancelled states.
An explicit retry has a durable request ID, so replaying the same request does not authorize another
publication. Cancellation stops new writes while permitting reconciliation of a write already
attempted. The host bounds subprocesses and drains publication work during shutdown.

## Exact revision for review

Once a matching PR is known, the existing Review First acquisition boundary independently verifies
and retains its captured base/head objects. Missing head objects are read from the verified Kestrel
workspace, preserving the original source identity. The immutable Feature binding records the
canonical Project, Change Proposal, retained revision and manifest digest. Later provider branch
movement cannot replace this binding.

The intent origin is the actual approved Feature plan and approving Operator. External API callers
cannot claim this provenance. Reusing an older retained revision preserves its original acquisition
history and adds the explicit Feature binding. Publication prepares source and facts; the separate
Conceptual Review flow starts analysis explicitly.

Authenticated reads use `GET /api/v1/projects/{projectId}/features/{featureId}/pull-request`. A
retry uses the corresponding `POST .../pull-request/retry` with `{requestId}` and the normal
session/CSRF protection. The public view contains the PR, certificate, ordered issue links and
retained revision, without configured remote strings or credential material.
