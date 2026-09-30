# Project board: GitHub reads, retention, and rate limits

Verified 2026-09-24 against `origin/master` at `1c55791`. Research only; no issue created,
no product behavior changed. Recommendations below await the board design decisions.

## What the current board actually requests

The browser schedules its next board read two seconds after a successful response. Every read sets
`loading=true`; empty-column text is hidden while loading, then restored. This directly explains
the reported flashing message in the source; it does not imply a GitHub request every two seconds.
The snapshot is component state and starts empty after remounting.
Sources: [workspace](../../apps/pwa/src/ProjectFactoryWorkspace.tsx),
[board panel](../../apps/pwa/src/ProjectFactoryBoardPanel.tsx).

The server retains GitHub issue catalogs in a process-local `Map` for 30 seconds, bounded to 32
Project/repository keys. Ordinary board reads reuse a fresh entry; Refresh bypasses it. Entries
disappear on restart or eviction. Concurrent cache misses do not share an in-flight read. A failed
refresh retains a previous catalog when available, but its retry interval is still 30 seconds.
Local Work Items come from the database; absence of a durable GitHub catalog does not mean their
execution state is unsaved. Source: [board service](../../apps/web/src/project-board.ts).

One successful `readIssueCatalog` performs an initial identity check, one to five issue-list pages,
and a final identity check. Each identity check makes `/user`, `/repos/{owner}/{repo}`, then `/user`
GETs; `gh version` is local. Therefore the nominal provider cost is **7–11 REST requests per catalog
refresh**, including six identity reads. Pages contain 20 entries and may include PRs, which are
filtered out. The adapter explicitly supplies neither `--cache` nor conditional validators, and
its HTTP decoder cannot currently accept a bodyless 304.
Source: [GitHub adapter](../../apps/web/src/factory-github.ts).

At exactly one refresh every 30 seconds, that is an estimated **840–1,320 requests/hour per active
Project**. This is arithmetic from the source, not measured traffic: provider latency lowers the
steady cadence; manual refresh, concurrent cache misses, process instances, other Projects, and
other tools sharing the account can increase aggregate usage. A 30-second cache is not a per-account
rate budget. No request trace or sustained live board test was performed for this note.

The issue-list projection reads body but omits labels/comment count; the board catalog then retains
only identity, URL, title, and state. External issue cards open GitHub. Bound Work Item cards open
the Feature board and offer a separate issue link. Sources:
[adapter](../../apps/web/src/factory-github.ts),
[service](../../apps/web/src/project-board.ts),
[panel](../../apps/pwa/src/ProjectFactoryBoardPanel.tsx).

## Documented limits and one host observation

| API/authentication | Primary allowance |
| --- | --- |
| REST, unauthenticated | 60 requests/hour per originating IP |
| REST, ordinary authenticated user | 5,000 requests/hour shared across that user's applicable credentials/apps |
| GraphQL, ordinary authenticated user | 5,000 points/hour; separate from REST, minimum one point/query |
| REST `GITHUB_TOKEN` in Actions | 1,000 requests/hour/repository normally |

Enterprise and GitHub App installation allowances differ; search has separate limits. A CLI command
is not necessarily one HTTP request. Sources:
[REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
[GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api).

Secondary constraints also apply: 100 concurrent requests across REST/GraphQL, 900 REST or 2,000
GraphQL points/minute for endpoints, and CPU-time limits. Typical REST reads cost one secondary
point; writes cost five. Content creation is generally capped at 80 requests/minute and 500/hour.
These limits can change and undisclosed limits exist. Source:
[secondary limits](https://docs.github.com/en/enterprise-cloud%40latest/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits).

One read-only `gh api rate_limit` at approximately 07:49 UTC returned:

| Resource | Limit | Remaining | Used |
| --- | ---: | ---: | ---: |
| REST core | 5,000 | 5,000 | 0 |
| GraphQL | 5,000 | 5,000 | 0 |
| Search | 30 | 30 | 0 |

This proves the allowance reported for this shell's credentials at that instant, not the identity
of the running application's credentials, its earlier usage, or the absence of future throttling.
No token was printed or retained. The endpoint does not expose secondary-limit status; its calls
do not consume primary quota but can contribute to secondary limits. Source:
[rate-limit endpoint](https://docs.github.com/en/rest/rate-limit/rate-limit).

`gh api` makes authenticated API requests and offers an explicit `--cache <duration>` flag.
`gh` can use its stored login or environment credentials; `GH_TOKEN` and then `GITHUB_TOKEN` take
precedence over stored credentials. Keep credentials in host custody. Sources:
[gh api](https://cli.github.com/manual/gh_api),
[login](https://cli.github.com/manual/gh_auth_login),
[environment](https://cli.github.com/manual/gh_help_environment).

## Provider guidance that applies here

GitHub recommends webhooks over polling. Where polling is necessary, use a fixed cadence, obey
`x-poll-interval` when present, and make authenticated conditional GETs. Retain `ETag` or
`Last-Modified` and send `If-None-Match` or `If-Modified-Since`. A correctly authorized 304 does not
consume primary quota; it remains a network request and is not a guarantee against secondary
limits. Prefer serialized requests and at least one second between many mutations.
Source: [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

On REST throttling, honor `Retry-After`; if remaining quota is zero, wait until `x-ratelimit-reset`.
Otherwise wait at least one minute, then use bounded exponential backoff if throttling persists.
Source: [REST error guidance](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#rate-limit-errors).

The current adapter decodes throttling into a `FactoryGitHubError` with `retryAt`, but catalog reads
return only the failure category. The board therefore loses that deadline and resumes reads after
its ordinary 30-second cache interval. Sources:
[adapter](../../apps/web/src/factory-github.ts), [service](../../apps/web/src/project-board.ts).

Issue-list responses already contain labels, a comments count, and body. Showing labels and counts
does not require one detail request per card; reading actual comments needs the comments endpoint.
Sources: [issues REST contract](https://docs.github.com/en/rest/issues/issues#list-repository-issues),
[issue comments REST contract](https://docs.github.com/en/rest/issues/comments#list-issue-comments).

## Recommendations for the board change

These are engineering proposals inferred from the code and provider contracts, not accepted scope:

1. Retain a read model in Kestrel's database: repository/issue identity, title, body, labels, comment
   count, provider timestamps, and synchronization status. Render the last successful observation
   immediately, then refresh separately. Keep the local workflow and the observed provider record
   distinct; label stale/error state without blanking usable content.
2. Separate frequent local workflow reads from provider synchronization. Start with a conservative
   2–5 minute provider cadence while visible, plus explicit refresh; choose the exact freshness
   promise with the Operator. Suspend unnecessary hidden/offline reads and coalesce concurrent
   refreshes by canonical repository and credential scope. Persist backoff deadlines and apply
   an aggregate account budget so extra tabs do not multiply provider reads.
3. Support conditional REST responses, preserving the cached body on 304. Keep validator keys tied
   to endpoint/query, page, media/API version, and authorized identity. Retain mandatory identity
   checks for writes; investigate safer reuse of checks on repeated read-only observations instead
   of blindly removing the existing identity-drift boundary.
4. Include labels/counts in list projections and persisted card data. Open retained issue content
   inside Kestrel, with an explicit GitHub link. Fetch comment pages only when needed, with bounded
   pagination and the same retention/backoff policy. A CLI TTL cache alone cannot provide the
   product's durable issue view or distinguish stale observations from approved plan snapshots.
5. Record request counts, cache hits, freshness, and available/reset headers without secrets or
   full issue bodies. Verify exact call budgets, restart retention, multi-tab coalescing, 304,
   and 403/429 behavior with deterministic provider fixtures before one representative live read.

Webhooks require a reachable receiver and connection authority; they are a later architectural
choice for this workstation-first product, not a prerequisite for fixing this board.
GraphQL is not a free quota workaround and is unnecessary just to display list metadata.

Moving a card must not silently turn synchronization into execution authority. The current domain
requires approval of an exact Feature Plan to start eligible Agent Runs, one active Feature per
Project, and confirmed integration for completion. Decide explicitly how a To do → In progress
gesture reaches that approval; do not treat labels or provider events as a Run Trigger. Sources:
[domain](../../CONTEXT.md), [ADR 0004](../adr/0004-deliver-the-factory-v01-loop.md).
