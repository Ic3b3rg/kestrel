# Factory GitHub publication boundary

Verified 2026-09-07 for [#213](https://github.com/Ic3b3rg/kestrel/issues/213).

## Sources and implemented decisions

The [GitHub issues REST API](https://docs.github.com/en/rest/issues/issues) includes pull requests
in issue listings and documents no idempotency key for creation. Kestrel filters PRs, captures
numeric repository and issue IDs alongside locators, and persists each creation operation and exact
payload before its subprocess runs. A confirmed response binds that issue. A timeout, process crash,
5xx, invalid response, or uncertain transport outcome requires reconciliation of the exact operation
marker; neither search absence nor an empty REST scan authorizes another POST.

The adapter uses the existing host account through
[`gh api`](https://cli.github.com/manual/gh_api), fixed `github.com`, explicit API version
`2022-11-28`, fixed argv, and JSON stdin. It checks repository/account identity around calls and
keeps tokens in host custody. Calls have a 10-second deadline, 2 MiB stdout and 32 KiB stderr caps,
and process-group cancellation. Discovery and issue/comment reconciliation read at most five pages
of 20 results. Reconciliation accepts a unique observed marker from the captured account, rejects
observed duplicate/foreign-author markers, and leaves an absent match uncertain even after a complete
scan. A positive match can be confirmed within that bound without scanning all repository history.

[Native dependencies](https://docs.github.com/en/rest/issues/issue-dependencies) use the blocking
issue's numeric ID. Kestrel reads existing edges before adding one and confirms uncertain writes by
reading the same relationship. Authentication/permission/validation failures never masquerade as
unsupported capability; only an explicit unsupported response selects textual dependency references.
This policy is deliberately conservative because
[GitHub may mask private-resource access failures with 404](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api).

One [owned issue comment](https://docs.github.com/en/rest/issues/comments) per Work Item records
Kestrel progress and the Feature link. Imported issue bodies are preserved. Future execution and PR
publication can update the stored comment ID; initial comment creation uses the same durable marker
policy as issue creation. No operation in this slice closes an issue. Mutating calls are serialized
and spaced by at least one second; provider reset/retry metadata is retained, following
[GitHub's REST guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

## Authority and recovery

Import is explicit, bounded to 20 open issues, and allowed before the first saved plan while no
planning turn is active. Snapshots remain immutable. Planning receives their source IDs and bounded
untrusted excerpts, with truncation disclosed; approval must assign every imported source exactly
once. Provider bodies, labels, comments, and priorities cannot alter the approved plan or start work.

Approval atomically persists publication rows, captured repository coordinates, Work Item bindings,
and dependency edges with the frozen plan. A durable outbox delivers one Work Item at a time through
pg-boss. Confirmed issue/comment/edge results survive a later failure and restart. Lease recovery
retains attempted operations; a failed delivery before claim becomes visibly blocked and can be
retried with a new delivery ID while retaining the original provider operation identities.

Publication attempts are bounded to 175 seconds, jobs to 180 seconds, and stale running claims are
reconciled after 190 seconds. There is no automatic provider-write retry loop. Explicit retry is
idempotent by request ID and bounded to 200 requests per Feature. A crash between recording an
attempt and sending it may leave an operation uncertain even if no remote write happened. Such an
operation remains blocked if reconciliation cannot establish a result; avoiding duplicate provider
issues takes precedence over guessing that a write did not occur.

## Evidence

Subprocess adapter fixtures cover pagination, identity drift, exact argv/stdin, cancellation,
definite versus uncertain writes, rate metadata, native dependencies, owned comments, and bounded
marker recovery. Authenticated HTTP tests exercise import reservations, plan approval, partial
publication, restart, uncertain issue/comment recovery, and failed queue delivery. The browser test
exercises the same flow from the shadcn issue dialog through the Board, including reload and retry.

The host `gh` version was 2.86.0. Read-only probes verified bounded issue listing and #213's native
blocker #212. Provider writes use task-owned subprocess fixtures and never target a live Project.
