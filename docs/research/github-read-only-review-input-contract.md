# GitHub read-only review-input contract

**Status:** recommended Review First V1 contract; implementation requires the conformance gates in this note

**Date:** 2026-08-24

**Scope:** GitHub.com GitHub App; linked GitHub Change Intent candidates; pull-request Provider Review Inputs; read-only acquisition and reconciliation; no provider-side invocation or provider writes

## Research question

With provider-side invocation and writes deferred from Review First V1, what is the minimum GitHub App contract that lets Kestrel acquire linked Change Intent sources and every in-scope Provider Review Input without making a provider participant authoritative, and without letting provider comment churn start, restart, extend, or invalidate a Review Workflow?

This answers [Rebaseline the GitHub App contract for read-only review inputs](https://github.com/Ic3b3rg/kestrel/issues/31) within the authority and workflow constraints fixed by [Rebaseline the Review First V1 domain after deferring agentic development](https://github.com/Ic3b3rg/kestrel/issues/30) and recorded in the repository's local `CONTEXT.md`. Sources were checked on 2026-08-24. All platform claims below use first-party GitHub documentation or the first-party [`github/docs`](https://github.com/github/docs) source repository. The GitHub REST API, GraphQL schema, webhook actions, and permissions are mutable platform contracts and must be re-attested before release.

## Executive recommendation

Register one GitHub App with only these repository permissions:

| Permission | Level | Contract role |
| --- | --- | --- |
| **Metadata** | **Read-only** | Installation/repository discovery and stable repository provenance. GitHub maps this permission to repository-metadata endpoints such as `GET /repos/{owner}/{repo}`. [GitHub App permission map](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps?apiVersion=2026-03-10#repository-permissions-for-metadata) |
| **Issues** | **Read-only** | Read an explicitly selected linked issue as a candidate Change Intent source; receive `issues` and `issue_comment`. The latter permission is required by GitHub even though the REST endpoint for PR conversation comments also accepts Pull requests read. [Issue endpoint](https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10#get-an-issue), [issue-comment endpoint](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10#list-issue-comments), [webhook permissions](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment) |
| **Pull requests** | **Read-only** | Read PR metadata, top-level PR conversation comments, submitted reviews, inline review comments, and GraphQL review-thread state; receive all PR review-input webhook families. [Pull endpoint](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#get-a-pull-request), [review endpoint](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2026-03-10#list-reviews-for-a-pull-request), [review-comment endpoint](https://docs.github.com/en/rest/pulls/comments?apiVersion=2026-03-10#list-review-comments-on-a-pull-request), [webhook permissions](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review) |
| **Contents** | **Read-only** | **Not an ingestion permission.** Retain it solely for the already-decided exact Revision acquisition path over authenticated Git/commit objects. GitHub requires Contents for installation-token HTTP Git access. [Choosing Git access permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#choosing-permissions-for-git-access) |

Do not request any organization, enterprise, account, or write permission. In particular, Provider Review Input does not require Members, Checks, Actions, Commit statuses, Discussions, Administration, Webhooks, or a user access token. GitHub recommends selecting the minimum App permissions; installation-token requests can be narrowed further to named repositories and a subset of the App's permissions. Installation tokens expire after one hour. [Choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [installation-token endpoint](https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10#create-an-installation-access-token-for-an-app)

Use separate down-scoped token profiles even though the registration is their superset: an ingestion token for only the base repository plus any Operator-selected linked-source repositories and only the ingestion reads above; a Revision-acquisition token including Contents read and only the base-repository access required by that separate path. Do not expose Contents authority to the comment/review parser merely because the App registration contains it. Token down-scoping is a documented GitHub capability; the profile separation is Kestrel policy. [Installation-token repository and permission narrowing](https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10#create-an-installation-access-token-for-an-app)

Subscribe to `pull_request`, `issue_comment`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, and `issues`. Treat `installation` and `installation_repositories`, which every GitHub App receives and cannot manually subscribe to, as access-lifecycle wakeups. Every accepted delivery is only a hint to reconcile current API state. No event or comment invokes Kestrel, selects Change Intent, authorizes an actor, starts **Review**, or performs **Review again**. GitHub documents that deliveries can be delayed, arrive out of order, fail without automatic redelivery, and be omitted entirely when a payload exceeds 25 MB; webhooks therefore cannot be the system of record. [Webhook event contract](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [delivery troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks), [failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)

At Review start, freeze an immutable manifest of one **completed local sync generation**. It is not a GitHub timestamp and does not claim an atomic provider snapshot: GitHub exposes the required data through separately paginated REST resources and GraphQL connections, not one cross-resource snapshot operation. The generation succeeds only after all pages and nested connections are complete, the installation grant is still valid, the selected linked sources are readable, the PR identity and base/head SHAs remain coherent across the pass, and bounded convergence checks succeed. This absence of a cross-resource transaction is an inference from the documented independent resources and pagination contracts. [REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api), [GraphQL pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)

After that cutoff, append new observation versions and tombstones without modifying the frozen manifest. A new comment, edit, deletion, review dismissal, thread resolution change, or newly observed outdated state produces **New provider review input** for the Proposal. It does not change frozen artifacts, restart analysis, extend the workflow, or change Review Currency.

Provider synchronization may commit later completed generations without workflow effect. An explicit initial **Review** or **Review again** selects one eligible completed generation and atomically binds its manifest ID as the workflow's immutable Provider Review Input cutoff. **Retry** and **Continue analysis** retain the previously frozen cutoff. No webhook or later synchronization advances, replaces, or invalidates a bound cutoff.

## Evidence boundary

### Recorded Kestrel constraints

This note does not reopen the domain decisions in the local `CONTEXT.md` and [Rebaseline the Review First V1 domain after deferring agentic development](https://github.com/Ic3b3rg/kestrel/issues/30):

- Change Intent is Kestrel-owned, current, versioned, source-backed, and frozen per Review Workflow.
- Provider Review Input consists of the PR's top-level conversation comments, submitted reviews and their state, and inline diff discussion threads from every author, including bots and external contributors.
- Provider Review Input is untrusted context. It cannot amend Change Intent, grant authority, or substantiate a Finding by itself.
- A workflow freezes one Provider Review Input cutoff. Later provider activity raises attention but neither invalidates nor restarts that workflow.
- Review Currency changes only when the source head changes; provider discussion churn is not Review Currency.
- Exact base/head Revision acquisition is a separate capability and is why Contents read remains in the App contract.

It narrowly refines [Define the Review First product and technical blueprint](https://github.com/Ic3b3rg/kestrel/issues/10): the earlier “no mandatory periodic poll” baseline is superseded only by release-defined, bounded current-state reconciliation for configured connections, locally tracked Proposals, and selected linked sources. GitHub's missed-delivery horizon and lack of a complete manual-link event make that reconciliation necessary for this input contract. It does not authorize broad provider discovery/history crawls, provider-triggered Review, or automatic analysis.

The rest of this note separates **documented GitHub facts** from **recommended Kestrel policy or inference**. A recommendation is intentionally stricter than GitHub where that is needed to preserve Kestrel's authority boundary.

## Documented GitHub surface

### Permissions and authentication

GitHub Apps have no permissions by default, permissions determine both API access and which webhooks can be selected, and GitHub advises requesting the minimum necessary set. A REST response can expose required permissions through `X-Accepted-GitHub-Permissions`; GraphQL permission requirements are not enumerated per field in the same way, and GitHub tells App developers to test their GraphQL operations. An insufficient REST permission normally yields `403`; an insufficient GraphQL permission can yield `401`. [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)

An installation token's success depends on the App installation's grant, not a provider participant's user role. By default a newly minted token covers every repository and permission granted to the installation, but `repository_ids`/`repositories` and `permissions` can narrow it; the token cannot expand beyond the installation and App grants. GitHub currently permits up to 500 explicitly listed repositories on such a narrowed token and makes it expire one hour after creation. [Create an installation access token](https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10#create-an-installation-access-token-for-an-app)

`GET /installation/repositories` lists repositories accessible to the current App installation, accepts an installation token, needs no additional fine-grained permission, and is paginated. [List repositories accessible to the App installation](https://docs.github.com/en/rest/apps/installations?apiVersion=2026-03-10#list-repositories-accessible-to-the-app-installation)

The ingestion/read split is exact:

- `GET /repos/{owner}/{repo}/pulls` and `GET /repos/{owner}/{repo}/pulls/{pull_number}` require Pull requests read for private resources. [Pull-request REST endpoints](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#list-pull-requests)
- A PR is also an issue in REST. Its top-level Conversation-tab comments are issue comments at `GET /repos/{owner}/{repo}/issues/{pull_number}/comments`; this endpoint accepts either Issues read **or** Pull requests read. Inline diff comments are a different resource. [Issue-comment REST endpoints](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10#about-issue-and-pull-request-comments)
- `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews`, `GET .../reviews/{review_id}`, and `GET .../reviews/{review_id}/comments` require Pull requests read. GitHub defines a review as a group of review comments plus a state and optional body, and returns the list chronologically. [Pull-request review REST endpoints](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2026-03-10#about-pull-request-reviews)
- `GET /repos/{owner}/{repo}/pulls/{pull_number}/comments` and `GET /repos/{owner}/{repo}/pulls/comments/{comment_id}` require Pull requests read. The per-PR list defaults to ascending ID. [Pull-request review-comment REST endpoints](https://docs.github.com/en/rest/pulls/comments?apiVersion=2026-03-10#list-review-comments-on-a-pull-request)
- `GET /repos/{owner}/{repo}/issues/{issue_number}` requires Issues read for a private linked issue. A transferred issue can return `301`; a deleted issue returns `410` when the caller still has read access, while a deleted or transferred issue hidden by authorization can return `404`. [Get an issue](https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10#get-an-issue)
- Installation-token HTTP Git access requires Contents. That permission is independent of the comment/review endpoints above. [Git access for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#choosing-permissions-for-git-access)

### Webhook subscriptions and actions

GitHub App subscriptions are event-level; handlers must inspect `X-GitHub-Event` and the payload's top-level `action`. GitHub adds event types and actions over time and recommends explicitly checking both. [Webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks#check-the-event-type-and-action-before-processing-the-event)

The minimal subscription and handler allowlist is:

| Event | GitHub permission / documented current actions | Kestrel-relevant actions and read-only effect |
| --- | --- | --- |
| `pull_request` | Pull requests read. Current actions include `opened`, `reopened`, `closed`, `edited`, `synchronize`, `converted_to_draft`, and `ready_for_review`, among other workflow/metadata actions. [Rendered event reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request), [first-party action data](https://github.com/github/docs/blob/main/src/webhooks/data/fpt/pull_request.json) | Those seven actions schedule a targeted PR/source sync. `synchronize` also wakes the separate Revision/Review Currency path. They never start analysis. Other actions are acknowledged and recorded but have no review-input meaning. |
| `issue_comment` | Issues read. It covers comments on both issues and PRs; current actions are `created`, `edited`, `deleted`, `pinned`, and `unpinned`. [Rendered event reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment), [first-party action data](https://github.com/github/docs/blob/main/src/webhooks/data/fpt/issue_comment.json) | For `created`, `edited`, and `deleted`, first require `issue.pull_request` and the expected installation/repository/PR identity, then schedule top-level PR comment sync. `pinned`/`unpinned` do not change the input body and have no workflow effect. Issue comments on ordinary linked issues are not PR Provider Review Input. |
| `pull_request_review` | Pull requests read. Current actions are `submitted`, `edited`, and `dismissed`. [Rendered event reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review), [first-party action data](https://github.com/github/docs/blob/main/src/webhooks/data/fpt/pull_request_review.json) | Schedule review plus associated-comment reconciliation. Persist a state transition rather than replacing an earlier frozen observation. |
| `pull_request_review_comment` | Pull requests read. Current actions are `created`, `edited`, and `deleted`. [Rendered event reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review_comment), [first-party action data](https://github.com/github/docs/blob/main/src/webhooks/data/fpt/pull_request_review_comment.json) | Schedule inline-comment and owning-thread reconciliation. A deletion creates a tombstone only after identity/provenance validation. |
| `pull_request_review_thread` | Pull requests read. Current actions are `resolved` and `unresolved`. [Rendered event reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review_thread), [first-party action data](https://github.com/github/docs/blob/main/src/webhooks/data/fpt/pull_request_review_thread.json) | Wake a GraphQL `reviewThreads` refresh. The payload is not authoritative over the persisted current thread state. |
| `issues` | Issues read. Current actions include `edited`, `closed`, `reopened`, `transferred`, and `deleted`. [Rendered event reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issues), [first-party action data](https://github.com/github/docs/blob/main/src/webhooks/data/fpt/issues.json) | Only for an issue already selected or discovered as a candidate Change Intent source: schedule identity/body/state and link-candidate reconciliation. No issue action authorizes that source. |
| `installation` | All GitHub Apps receive it by default and cannot manually subscribe. Current actions are `created`, `deleted`, `new_permissions_accepted`, `suspend`, and `unsuspend`. [Rendered event reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation), [first-party action data](https://github.com/github/docs/blob/main/src/webhooks/data/fpt/installation.json) | Reconcile connection state and stop new sync generations on loss/suspension. |
| `installation_repositories` | All GitHub Apps receive it by default and cannot manually subscribe. Current actions are `added` and `removed`. [Rendered event reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation_repositories), [first-party action data](https://github.com/github/docs/blob/main/src/webhooks/data/fpt/installation_repositories.json) | Reconcile the authoritative accessible-repository inventory; removal blocks new acquisition for that repository. |

`repository` is an optional lifecycle accelerator for rename, transfer, archival, and deletion, available with Metadata read; it is not required for completeness when repository identity is refreshed during every scheduled grant reconciliation. [Repository webhook event](https://docs.github.com/en/webhooks/webhook-events-and-payloads#repository)

Do not subscribe for this contract to `commit_comment`, `discussion`, `discussion_comment`, Checks, Actions, labels, reactions, review requests, or provider dispatch/invocation events. GitHub distinguishes a PR review comment on a diff from an ordinary commit comment, and distinguishes PR review threads from GitHub Discussions. [Webhook event reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [commenting on a pull request](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/commenting-on-a-pull-request)

### Delivery security and reliability

Webhook requests include `X-GitHub-Event`, a globally unique `X-GitHub-Delivery` GUID, and—when a secret is configured—`X-Hub-Signature-256`. Payloads are capped at 25 MB; GitHub does not send an event whose payload exceeds that cap. Some deliveries can identify `sender` as the `ghost` placeholder rather than a current real user. [Webhook headers, sender, and payload cap](https://docs.github.com/en/webhooks/webhook-events-and-payloads#about-webhook-events-and-payloads)

GitHub recommends validating the HMAC-SHA-256 signature over the unmodified payload and comparing in constant time. It also recommends HTTPS, returning `2xx` within ten seconds, queueing work asynchronously, deduplicating with `X-GitHub-Delivery`, and retaining the same delivery GUID across a requested redelivery. [Validating deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)

GitHub can deliver webhooks out of event order or minutes after the event, and can throttle a surge. Failed deliveries are not automatically retried. App owners can list/get/redeliver App webhook deliveries with an App JWT, but the interactive/recent delivery window is only the past three days. [Troubleshooting webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks), [handling failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries), [App webhook delivery API](https://docs.github.com/en/rest/apps/webhooks?apiVersion=2026-03-10), [redelivery window](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)

### Exact REST and GraphQL resources

Use REST as the complete current-object inventory for PR metadata, PR conversation comments, reviews, and inline comments, with GraphQL only for relationships/state not exposed as first-class REST resources:

| Surface | Authoritative read and fields Kestrel must retain |
| --- | --- |
| Installation grant | `GET /installation/repositories`: repository numeric `id`, REST `node_id`, current owner/name/URL snapshot, visibility, and the complete paginated accessible set. [Installation endpoint](https://docs.github.com/en/rest/apps/installations?apiVersion=2026-03-10#list-repositories-accessible-to-the-app-installation) |
| Repository and PR | `GET /repos/{owner}/{repo}` plus `GET /repos/{owner}/{repo}/pulls/{pull_number}`: repository and PR IDs/node IDs, PR number, title/body and update times, author provenance, state/draft, base repository/ref/SHA, head repository/ref/SHA, and URLs. The PR response links separately to issue comments and review comments. [Repository endpoint](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10#get-a-repository), [pull endpoint](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#get-a-pull-request) |
| Top-level PR conversation | Exhaust `GET /repos/{owner}/{repo}/issues/{pull_number}/comments`: comment `id` and `node_id`, raw Markdown `body`, actor ID/node ID/login/type snapshot, `author_association`, `created_at`, `updated_at`, and URL. [Issue-comment endpoint and representation](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10#list-issue-comments) |
| Submitted reviews | Exhaust `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews`; optionally cross-check each `GET .../reviews/{review_id}` and `GET .../reviews/{review_id}/comments`: review `id`/`node_id`, actor, body, state, submitted time, commit ID, author association, and URLs. [Review endpoints and representation](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2026-03-10#list-reviews-for-a-pull-request) |
| Inline comments | Exhaust `GET /repos/{owner}/{repo}/pulls/{pull_number}/comments`: comment `id`/`node_id`, `pull_request_review_id`, reply parent, body/actor/times/provenance, `diff_hunk`, path, current and original commit IDs, current/original line ranges and diff sides. GitHub is closing down diff-relative `position`; use line/side plus original anchors instead. [Review-comment endpoint and representation](https://docs.github.com/en/rest/pulls/comments?apiVersion=2026-03-10#list-review-comments-on-a-pull-request) |
| Review discussion threads | Exhaust GraphQL `PullRequest.reviewThreads(first:, after:)`, including every nested `comments` connection. Persist thread global `id`, `isResolved`, `isOutdated`, `isCollapsed`, `resolvedBy`, path, subject type, line/original-line ranges and sides, plus the complete member-comment ID set. GraphQL documents `reviewThreads` as the list of **all** review threads for a PR and exposes these fields on `PullRequestReviewThread`; REST has no equivalent first-class thread collection or resolution fields. [GraphQL `PullRequest`](https://docs.github.com/en/graphql/reference/pulls#pullrequest), [GraphQL `PullRequestReviewThread`](https://docs.github.com/en/graphql/reference/pulls#pullrequestreviewthread) |
| Linked issue candidates | Exhaust GraphQL `PullRequest.closingIssuesReferences`. Its `userLinkedOnly` argument can select only manually linked issues; `excludeUserLinked` can exclude them. For an Operator-selected source, resolve its repository/issue IDs and read the current title/body/state with `GET /repos/{owner}/{repo}/issues/{issue_number}` under the same installation boundary. [GraphQL `PullRequest`](https://docs.github.com/en/graphql/reference/pulls#pullrequest), [issue endpoint](https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10#get-an-issue) |

Most REST objects expose a GraphQL global node ID as `node_id`; GraphQL exposes the same identity as `id` on `Node`. GitHub recommends persisting global node IDs when an integration crosses REST and GraphQL. [Using global node IDs](https://docs.github.com/en/graphql/guides/using-global-node-ids)

GitHub usernames, organization names, and repository owner/name paths can change. Repository renames and transfers redirect many prior URLs, and an old username can later be claimed by another account. Consequently, names and URLs are display/provenance snapshots rather than Kestrel identity keys. [Username changes](https://docs.github.com/en/account-and-profile/concepts/username-changes), [renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository), [transferring a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository)

### Reviews, edits, deletion, and thread state

A pending review is not Provider Review Input. GitHub says pending line comments are visible only to their author until the review is submitted. GraphQL represents review-comment state as `PENDING` or `SUBMITTED`, and a review has a nullable `submittedAt` plus current review state. [Reviewing proposed changes](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request#starting-a-review), [GraphQL pull-request types](https://docs.github.com/en/graphql/reference/pulls#pullrequestreviewcommentstate)

Reviews and comments are mutable current resources. GraphQL exposes `updatedAt`, `lastEditedAt`, edit history, current review state, and update/delete mutations for review bodies and review comments; webhook actions separately expose review `edited`/`dismissed` and review-comment `edited`/`deleted`. [GraphQL `PullRequestReview`](https://docs.github.com/en/graphql/reference/pulls#pullrequestreview), [GraphQL `PullRequestReviewComment`](https://docs.github.com/en/graphql/reference/pulls#pullrequestreviewcomment), [webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review)

There is a material documentation caveat around deleting reviews:

- REST explicitly calls its operation **Delete a pending review**, says it deletes only an unsubmitted review, and says submitted reviews cannot be deleted. [REST delete-review endpoint](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2026-03-10#delete-a-pending-review-for-a-pull-request)
- The GraphQL schema marks `PullRequestReview` as `Deletable` and documents `deletePullRequestReview` only as “Deletes a pull request review,” without the REST pending-only qualifier. [GraphQL review type and mutation](https://docs.github.com/en/graphql/reference/pulls#deletepullrequestreview)
- The documented `pull_request_review` webhook action set is `submitted`, `edited`, and `dismissed`; it has no `deleted` action. [Review webhook actions](https://github.com/github/docs/blob/main/src/webhooks/data/fpt/pull_request_review.json)

The official sources do not establish that a submitted review is deletable through GraphQL. Kestrel must not assume that it is. Pending reviews are excluded in every case; submitted review dismissal is a retained state transition. A submitted review that disappears from a fully successful current inventory should be retained locally and marked with a conservative tombstone/unknown-removal observation, not silently erased. This behavior is Kestrel policy and requires a live private-repository conformance test.

For comments, deletion is explicit: issue-comment and review-comment webhook families include `deleted`, and REST exposes delete operations. A current API list cannot reconstruct the body of a comment that was deleted before Kestrel observed it; that limitation is an inference from the current-object list/get contract. Kestrel can preserve only content it previously retained or received in a verified delivery. [Issue-comment endpoints](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10), [review-comment endpoints](https://docs.github.com/en/rest/pulls/comments?apiVersion=2026-03-10), [webhook actions](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review_comment)

`PullRequest.reviewDecision` is an aggregate current merge-review status, whereas `PullRequest.reviews` is the review collection and `reviewThreads` is the complete thread collection. The aggregate must not replace raw review identities, bodies, states, or threads. [GraphQL `PullRequest`](https://docs.github.com/en/graphql/reference/pulls#pullrequest)

GitHub documents that a review conversation can be unresolved, resolved, or outdated in the UI, and GraphQL exposes `isResolved` and `isOutdated` directly on each review thread. Therefore GraphQL `reviewThreads` is the authoritative provider read for thread state; `pull_request_review_thread` is only a wakeup. [Resolving and navigating review conversations](https://docs.github.com/en/pull-requests/reference/pull-request-reviews#resolving-conversations), [GraphQL review-thread type](https://docs.github.com/en/graphql/reference/pulls#pullrequestreviewthread)

### Linked issues are candidates, not authority

GitHub can link an issue to a PR manually or from supported closing keywords. A keyword creates a link only when the PR targets the default branch; manual linking is limited to ten issues per PR, and GitHub provides same-repository and cross-repository manual-link flows with different UI constraints. The GraphQL `closingIssuesReferences` connection includes manually linked issues and can filter them with `userLinkedOnly`. [Linking a pull request to an issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue), [GraphQL `closingIssuesReferences`](https://docs.github.com/en/graphql/reference/pulls#pullrequest)

Those are provider-maintained relationships: GitHub permits repository participants with write access to create manual links, and closing links can derive from text in the PR description. Kestrel therefore treats every returned issue only as a **candidate Change Intent source**. A GitHub link never selects the source, changes Change Intent, grants Kestrel authority, or starts Review. An authorized Kestrel actor must select/attest the source, after which Kestrel freezes the selected issue version in the workflow. The first sentence is documented GitHub behavior; the authority consequence is Kestrel policy. [Manual-link permission and keyword behavior](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)

The current documented webhook action lists expose no dedicated action for adding or removing a manual PR–issue link. `pull_request.edited` can wake reconciliation after PR body/closing-keyword changes, but periodic GraphQL reconciliation is still required for manual-link drift. This is an inference from the current first-party action sets, not a GitHub guarantee that no internal delivery ever changes. [Pull-request action data](https://github.com/github/docs/blob/main/src/webhooks/data/fpt/pull_request.json), [issues action data](https://github.com/github/docs/blob/main/src/webhooks/data/fpt/issues.json)

## Recommended Kestrel acquisition policy

### Webhooks are authenticated wakeups, never commands

On receipt:

1. Enforce HTTPS at the edge, preserve the raw bytes, impose Kestrel's request-size limit before parsing, validate `X-Hub-Signature-256` in constant time, and require the expected App hook target.
2. Durably deduplicate by `(github_connection_id, X-GitHub-Delivery)`; a redelivery with the same GUID is the same receipt.
3. Validate event/action against the allowlist and validate installation ID, repository global/numeric ID, and PR node ID/number against the connected Project before scheduling work.
4. Commit only a small receipt and targeted-reconciliation job, then return `2xx` within GitHub's ten-second window.
5. Fetch current provider state with a narrowed installation token. Do not treat mutable webhook object bodies as the authoritative normalized state, except that a verified deletion payload may supply the stable ID needed to append a tombstone before the follow-up scan.

Signature verification authenticates GitHub delivery and payload integrity; it does not make `sender`, the comment author, a reviewer, a linked-issue author, or the installation owner a Kestrel actor. Unknown event/action pairs have no semantic effect: retain a diagnostic, schedule a bounded safe reconciliation for a known installation/repository when possible, and never invoke a workflow.

### Initial, event-driven, and periodic reconciliation

Use five acquisition modes:

| Mode | Recommended operation |
| --- | --- |
| Connection bootstrap | Mint a narrowed installation token; exhaust `GET /installation/repositories`; persist installation/repository identities and grants. Do **not** crawl every historical PR or linked record merely because the App can read it. Provider-side discovery/invocation is out of V1 scope. |
| Proposal attachment / first sync | Resolve the Operator-selected repository and PR by stable IDs; read exact PR metadata; exhaust all top-level PR comments, reviews, inline comments, GraphQL review threads and nested comments; discover linked issue candidates; fetch only Kestrel-selected linked Change Intent sources that are inside the connection boundary. |
| Webhook-driven sync | Coalesce receipts per `(installation, repository, PR)` and refresh only affected surfaces, then perform an identity/state cross-check against PR and GraphQL thread inventory. A webhook is a latency optimization, not a completeness claim. |
| Periodic reconciliation | On a release-defined, bounded schedule, re-list installation repositories and fully reconcile every locally tracked active Proposal, its selected linked sources, and any closed Proposal still within its retention/lifecycle window. Use full identity-set comparison often enough to discover deletes, missing link events, and missed deliveries. |
| Pre-Review barrier | Attempt a bounded targeted refresh, then select the newest eligible completed manifest available when cutoff binding commits. Comment-only churn may prevent a newer generation, but cannot disqualify an earlier complete eligible one. Conditional `304` responses may prove an unchanged page only when the request identity, authorization, parameters, and retained ETag match; any ambiguity forces a full fetch. |

GitHub recommends webhooks instead of wasteful polling, authenticated conditional requests with ETags, serial API calls to avoid secondary limits, and a stable sort for pagination. It cautions that `sort=updated` can move entries between pages and that additions/removals can shift even a stable-order list. [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)

For REST, request `per_page=100` where supported and follow the response `Link` relations until no next page. For GraphQL, every used connection—including `reviewThreads`, nested thread `comments`, and `closingIssuesReferences`—must request `pageInfo` and continue until `hasNextPage=false`; `first`/`last` must be 1–100. Split nested GraphQL work into bounded queries rather than risking resource-limit partial results. [REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api), [GraphQL pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api), [GraphQL resource limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)

Pin REST requests to `X-GitHub-Api-Version: 2026-03-10` and `Accept: application/vnd.github+json` for the initial implementation. GitHub says requests without the version header still default to `2022-11-28`, so omission would silently select a different contract. GraphQL is not selected by that REST header and needs its own schema/fixture conformance tests. [GitHub REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)

Use the App webhook-delivery API on a schedule to detect and request redelivery of recent failures, but never rely on its three-day history for durable recovery. A current-state full reconciliation is the long-window recovery mechanism. It can recover current surviving objects and current thread state; it cannot reconstruct previously unseen deleted content or every intermediate edit. The recovery limit follows from the documented delivery window and current-object APIs. [App webhook delivery API](https://docs.github.com/en/rest/apps/webhooks?apiVersion=2026-03-10), [redelivery window](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)

### Completed sync generation and immutable cutoff

There is no defensible single “GitHub cutoff timestamp” for this contract. Provider timestamps come from different mutable objects, deliveries can be late/out of order, and list/connection pages are read in separate requests. Kestrel must define the cutoff as an immutable manifest of what one successful **local sync generation** observed and committed.

A generation manifest should contain at least:

- Kestrel `sync_generation_id`, connection ID, App ID/slug snapshot, installation ID, local start/commit times, REST API version, and query/profile version;
- repository numeric/global ID and name/owner/URL snapshots; PR numeric/global ID and number;
- PR base repository/global ID, base ref and SHA; head repository/global ID, head ref and SHA, captured at the beginning and verified again at the end;
- the complete sorted set of current top-level comment, submitted-review, submitted inline-comment, and GraphQL thread IDs;
- for each member, the exact append-only local observation-version ID containing provider timestamps, body hash/content reference, actor provenance, state, review/commit association, anchors, and deletion marker;
- for each thread, its GraphQL ID, complete member-comment ID set, `isResolved`, `isOutdated`, `resolvedBy`, and anchors;
- every discovered linked-issue candidate plus the exact Kestrel-selected Change Intent source version; candidate status and selected status must be separate;
- page/connection completion receipts, counts, ETags where applicable, GraphQL cost/error status, applied bounds, retry count, and a deterministic manifest digest;
- the durable inbound-receipt/observation watermark reached locally before the manifest transaction committed.

Generation completion policy:

1. Revalidate installation, required permission levels, and selected repository grant; mint a narrowed installation token.
2. Read PR identity/base/head, then exhaust every required REST list and GraphQL connection under deterministic local sorting.
3. Reject any REST error, redirect that cannot be resolved back to the expected stable ID, GraphQL top-level or field error, partial/resource-limited result, missing page, duplicate/conflicting ID, inconsistent review/comment/thread ownership, or unreadable selected Change Intent source.
4. Read PR identity/base/head again. Compute an inventory/version digest and repeat the affected pass until two consecutive complete passes agree. This is a bounded convergence check, not proof of a transactional GitHub snapshot.
5. Within one Kestrel database transaction, append observations/tombstones and commit the immutable manifest plus monotonically increasing local provider-input sequence. A separate workflow-admission transaction may later bind that manifest ID as its cutoff.

If provider churn prevents convergence within the release-defined attempt/time/rate budget, that refresh fails without disqualifying an earlier complete eligible generation. A **Review** command may wait for the bounded refresh, then atomically selects the newest eligible completed manifest available when cutoff binding commits. Eligibility requires a complete, untruncated manifest for the same connection, repository, Proposal, selected Change Intent version, and exact Review Revision. Kestrel discloses the selected generation's commit time, watermark, synchronization lag, and any later provider-input attention.

If no eligible complete generation exists—or the installation grant, selected Change Intent version, or exact Review Revision cannot be verified—preparation fails closed. Comment-only churn, age, or a failed attempt to produce a newer generation is visible but does not veto Review through an older eligible manifest. Source-head movement, accepted Change Intent change, or access loss can make an older generation ineligible because those affect authoritative frozen inputs rather than untrusted discussion.

A provider event received or mutation discovered after manifest commit is post-cutoff for that workflow **regardless of its GitHub `created_at`, `updated_at`, `submittedAt`, or delivery timestamp**. Append it at a later local provider-input sequence and raise **New provider review input**. This makes late delivery and clock/order ambiguity explicit without retroactively rewriting the cutoff.

### Mutation and tombstone policy

Key every mutable provider object by `(github_host, installation lineage, repository global ID, object kind, object global ID)` and append observation versions; never overwrite an observation referenced by a frozen manifest.

- **Edit:** append the new body/state/hash plus provider `updated_at`/`lastEditedAt` and local observed sequence. Preserve the frozen earlier version.
- **Review dismissal:** append state `DISMISSED` and retain the prior submitted state/body. Do not equate dismissal with deletion.
- **Thread resolve/unresolve/outdated change:** refresh GraphQL `reviewThreads`, append a new thread-state version, and retain the comment membership/anchors.
- **Verified deletion event:** validate stable resource and parent IDs from the signed payload, append a provisional tombstone, then reconcile. Never accept a URL/name match alone.
- **Inventory disappearance:** append a tombstone only after a fully successful complete inventory proves a previously known ID is absent and access/parent identity remains valid. A partial page, field error, or isolated `404` is not proof of deletion; GitHub can use `404` for private resources hidden by authorization. [REST API `404` guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#do-not-ignore-errors)
- **Submitted review disappearance:** use an `unknown_removed` tombstone unless a future official contract or conformance fixture establishes a precise delete transition; keep prior retained content.

A deletion after cutoff does not remove the frozen input from an existing workflow. The later tombstone is shown as current provider state and as attention; retention/deletion policy determines how long Kestrel may keep the frozen content, but provider mutation alone never rewrites an audit artifact.

### Stable identity and provenance

Persist opaque provider IDs as keys and human-readable fields as snapshots:

| Entity | Identity key | Provenance snapshots |
| --- | --- | --- |
| Connection | Kestrel connection ID + GitHub host + App ID | App slug/name, creation/config profile version |
| Grant | Installation numeric ID | installation account ID/node ID/login/type, repository-selection mode, effective permissions, suspended state, token repository/permission narrowing (never the token itself) |
| Repository | REST numeric `id` plus GraphQL/global `node_id` | owner ID/login and repo owner/name/full-name/URLs/visibility snapshots |
| Proposal | Repository global ID + PR global ID; retain PR number as provider locator | PR URL, title/body source snapshot, base/head repositories/refs/SHAs, author and association |
| Actor | GraphQL actor/global ID and concrete type when present; nullable/ghost-safe | login/display name/type, `author_association`, App/bot marker as returned |
| Input object | Kind + global node ID; retain 64-bit-capable database ID where returned | parent PR/review/thread IDs, URLs, provider times, author, body/content hash, states and anchors |
| Thread | GraphQL `PullRequestReviewThread.id` | comment global IDs, path/subject/line sides, resolved/outdated/resolver state |
| Delivery | Connection ID + `X-GitHub-Delivery` GUID | event/action, received time, installation/repository IDs, signature-validation result, redelivery flag |
| Revision | Base repository global ID + exact base SHA + exact head SHA | refs and head-repository identity snapshots |

GraphQL's legacy `databaseId: Int` is deprecated on several PR types because it does not support 64-bit signed identifiers; prefer global `id` and `fullDatabaseId` where present. [GraphQL pull-request reference](https://docs.github.com/en/graphql/reference/pulls)

Actor IDs, logins, `author_association`, review decisions, thread resolver identity, webhook `sender`, linked-issue creator, and repository permission level are provenance only. They do not map to Kestrel roles and cannot authorize a command. Supporting GraphQL `Actor` rather than only `User`, plus nullable/ghost actors, is required to retain bot/external/system provenance without inventing an identity. GitHub models review authors as `Actor` and warns specifically not to assume webhook `sender` always identifies the person who caused an event. [GraphQL review type](https://docs.github.com/en/graphql/reference/pulls#pullrequestreview), [webhook sender contract](https://docs.github.com/en/webhooks/webhook-events-and-payloads#the-sender-property)

### Bounded ingestion

GitHub itself bounds webhook payloads at 25 MB, REST lists paginate, GraphQL connections cap `first`/`last` at 100, GraphQL calls have a 500,000-node validation ceiling, and both REST and GraphQL impose primary/secondary rate limits. These are platform ceilings, not safe Kestrel product budgets. [Webhook payload cap](https://docs.github.com/en/webhooks/webhook-events-and-payloads#payload-cap), [GraphQL query limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api), [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

The release profile must define and audit smaller limits for:

- repositories per installation sync and tracked Proposals per batch;
- REST pages/items per surface per PR and total objects per sync generation;
- GraphQL pages, nodes, cost, query depth, and nested comments per thread;
- raw and normalized bytes per body, object, PR, selected source, and generation;
- reconciliation wall time, retries, convergence passes, concurrent requests, and reserved rate-limit headroom;
- inbound receipt size, durable queue depth, coalescing window, and per-installation backpressure.

These limits are Kestrel policy. They must be fixed and versioned by the Kestrel Release profile, recorded in the manifest, and visible in diagnostics. Acquisition of “all Provider Review Inputs” forbids silent truncation, first-N sampling, dropping bots/external authors, using only the latest review per author, omitting resolved/outdated threads, or model-side summarization as a substitute for provider capture. If a required surface exceeds a bound, return a typed `provider_input_over_budget` attention/blocker and do not create a new completed generation. V1 does not permit Operator-side limit escalation; recalibration requires a future certified Release profile.

### Fail-closed matrix

Reject an invalid or missing-HMAC, malformed, oversize, or mismatched webhook at ingress and record a safe diagnostic. Such a delivery has no semantic effect and cannot block otherwise complete API reconciliation. The following conditions block a new completed generation; they block Review start only when no earlier eligible completed manifest can be bound or the authoritative input is no longer verifiable:

- mismatched installation, repository, PR, or parent-resource identity in authoritative API state;
- App deleted/suspended, repository removed from the installation, effective permission below Metadata/Issues/Pull requests read, or Contents below read when exact Revision acquisition is part of the same Review barrier;
- token mint/expiry failure, `401`, `403`, ambiguous `404`, unresolved transfer redirect, unsupported API version, or REST schema mismatch;
- any missing REST page/`Link`, GraphQL error/partial result, missing cursor page, node/cost/timeout failure, duplicate/conflicting global ID, or unjoinable REST `node_id`/GraphQL `id`;
- missing review-thread membership, unresolved mapping from submitted inline comment to review/thread, or inability to obtain `isResolved`/`isOutdated` from the complete GraphQL connection;
- selected linked Change Intent source outside the installation boundary, unreadable, deleted without a retained selected version, or changed while the generation is freezing;
- rate limit beyond bounded retry/headroom, nonconvergent provider churn, queue/backpressure overflow, or any configured ingestion budget exceeded;
- inability to acquire/verify both exact base and head revisions through the separate Contents-read path.

Unknown webhook events/actions do not by themselves corrupt an existing connection or workflow; they have no semantic effect, produce diagnostics, and request a bounded reconciliation when their installation/repository identity is known. Periodic sync failure marks current provider state **uncertain** and raises Operator Attention but does not erase retained data or mutate a frozen workflow. A fresh Review may still bind an earlier eligible completed manifest when the installation grant, selected Change Intent version, and exact Review Revision remain verifiable; otherwise preparation blocks.

Never fall back to anonymous public-repository reads when an installation-scoped read fails. Never substitute a provider participant's user token. Never send a REST write method or a GraphQL `mutation`; enforce a query/endpoint allowlist in addition to relying on read-only App permissions. Never dereference links embedded in untrusted Markdown during acquisition. These are Kestrel hardening policies, not GitHub platform requirements.

## Implementation conformance gates

Before shipping the GitHub adapter, run the following fixtures with the exact production App registration and an installation token against private repositories as well as a public fork PR:

1. **Permission matrix:** prove every listed REST endpoint and the exact GraphQL query succeed with only Metadata/Issues/Pull requests read; prove authenticated Git revision acquisition additionally needs Contents read; prove all write endpoints/mutations fail. Record `X-Accepted-GitHub-Permissions` where REST returns it. GitHub expressly requires App developers to test GraphQL permission needs. [Permission-selection guidance](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
2. **Complete input taxonomy:** create top-level comments, COMMENTED/APPROVED/CHANGES_REQUESTED reviews, multiple inline comments/replies, file- and line-level threads, bot/external-author comments, resolved/unresolved and outdated threads; verify every global ID and state survives REST/GraphQL joining.
3. **Pending privacy:** begin but do not submit a review; verify the installation query does not turn its pending review/comments into Provider Review Input. Independently reject any object whose comment state is `PENDING` or whose review has no submitted state/time. GitHub documents pending comments as author-only until submission. [Pending comment visibility](https://docs.github.com/en/pull-requests/get-started/reviewing-pull-requests-quickstart#comment-on-the-changes)
4. **Mutation lifecycle:** edit/delete both comment families, edit/dismiss reviews, resolve/unresolve threads, and push a commit that makes a thread outdated. Verify append-only versions, tombstones, frozen-manifest stability, and one attention transition per later local observation sequence.
5. **Review deletion ambiguity:** attempt only test-authorized pending deletion through REST/GraphQL and observe list/webhook behavior. Do not claim submitted-review deletion behavior without an official clarification or isolated fixture. Preserve `unknown_removed` for an unexplained submitted-review disappearance.
6. **Linked issue candidates:** add/remove manual same-repo and cross-repo links and edit closing keywords on default/non-default-base PRs. Verify `closingIssuesReferences` pagination and `userLinkedOnly`; verify no provider link auto-selects Change Intent and an inaccessible cross-repo candidate cannot become a selected source.
7. **Grant/identity drift:** rename/transfer repositories and actors, remove/re-add repository selection, suspend/unsuspend/delete the App installation, and rotate/narrow tokens. Stable provider IDs must retain lineage while names remain snapshots.
8. **Completeness failures:** exercise more than 100 objects/connections, deletion and edit during pagination, GraphQL partial/resource errors, REST redirects/ambiguous 404s, rate exhaustion, replayed/out-of-order delivery GUIDs, failed delivery recovery, and a nonconverging refresh both with and without an earlier eligible completed manifest. The first case must bind the earlier manifest with disclosed lag; the second must block. Neither may truncate.
9. **Cutoff race:** mutate each surface immediately before, during, and after the convergence pass. Verify the workflow binds only to the committed generation manifest; a late event with an older GitHub timestamp is still post-cutoff locally and only raises attention.

## Decision

The smallest defensible GitHub App boundary for Review First V1 is **Metadata read + Issues read + Pull requests read for ingestion**, with **Contents read retained only for exact Revision acquisition**. The App subscribes only to the six review/source event families above, while the two installation lifecycle families arrive by default. Webhooks provide authenticated, deduplicated wakeups; complete current-state REST inventories plus GraphQL `reviewThreads` and `closingIssuesReferences` provide startup, event-driven, release-defined periodic, and bounded pre-Review reconciliation.

The authority boundary remains entirely inside Kestrel. Pending/private review content is excluded until submission. Provider-created links expose candidate Change Intent sources only. GraphQL `reviewThreads` is authoritative for resolved/outdated discussion state. A cutoff is an immutable manifest of one completed, bounded local sync generation—not a fictitious atomic GitHub time. Every later mutation is append-only attention for the next explicit Review, never a command and never retroactive workflow churn.
