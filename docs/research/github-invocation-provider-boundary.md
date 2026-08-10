# GitHub invocation and provider-boundary contract

**Status:** recommended V1 contract

**Date:** 2026-08-10

**Scope:** GitHub Cloud, public and private repositories, self-hosted Kestrel

**Kestrel stages:** Review First, then the thin remote-development loop

## Research question

Which official GitHub APIs, events, identities, permissions, comments, mentions,
labels, and pull-request facilities can safely support Provider Invocations, and
what provider-neutral contract must Kestrel preserve for later Repository
Providers?

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` below are Kestrel recommendations. Sections
labelled **GitHub fact** describe the official platform surface; sections labelled
**Kestrel decision** are product or architecture choices derived from those facts.

## Executive decision

Kestrel V1 should integrate through a customer-controlled **GitHub App**, installed
on explicitly selected repositories. It should receive webhooks directly at the
always-reachable control plane and use short-lived installation access tokens for
all API reads. GitHub recommends Apps over OAuth Apps and personal access tokens
for integrations because Apps can act independently, have granular repository
permissions, can be installed on selected repositories, use short-lived tokens,
and have centralized webhooks. GitHub describes PATs as appropriate mainly for
testing or short-lived scripts. ([GitHub App choice](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app))

The sole V1 invocation surface is a newly created, top-level issue or pull-request
conversation comment whose first non-empty Markdown paragraph contains the exact
configured command `@<kestrel-app-login> plan`. The webhook is
`issue_comment.created`. Kestrel parses the command itself, authenticates the
stable GitHub sender ID as the one trusted Operator, resolves the installation,
repository, subject, and current comment, then creates or resumes the linked Work
Item and opens a Planning Session.

No provider event can create a Run Trigger or an Agent Run. Pull-request opens,
synchronizations, reviews, review comments, labels, comment edits, check actions,
pushes, and all other GitHub events are non-invoking. Review First remains
provider-read-only: Kestrel does not post an acknowledgement, label an item,
submit a review, update a check, create a branch, or open a pull request.

This produces a narrow security boundary:

```text
signed GitHub delivery
  -> installed and enabled repository
  -> supported event/action and exact command
  -> stable sender ID == bound Operator ID
  -> durable, idempotent Provider Invocation
  -> Work Item + Planning Session only
  -> explicit in-Kestrel Operator approval
  -> Run Trigger -> Agent Run
```

## Official GitHub surface

### App identity, installation identity, and tokens

**GitHub fact.** A GitHub App can act as its bot identity using an installation
access token or on behalf of a user using a user access token. A user-token request
is limited by both the App's permissions and the user's own access, and is
attributed to that user; an installation-token request is attributed to the App.
([User access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user))

Installation tokens can be restricted to a subset of repositories and a subset of
the installation's granted permissions. They cannot exceed either grant, and they
expire after one hour. GitHub currently allows a request to select at most 500
repositories when minting one token. ([Installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app))

The installer chooses all or selected repositories and approves the requested App
permissions. Some REST reads are available without authentication for public
resources, but public readability does not establish a Kestrel Project or
authorize a Provider Invocation.
([Installing a GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party),
[issue comment endpoints](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10))

**Kestrel decision.** Each self-hosted Kestrel installation owns its App private
key and webhook secret. Registration SHOULD use a GitHub App Manifest so the
permissions, events, callback, setup URL, and webhook URL are reproducible; the
manifest exchange yields the App ID and generated secrets and must be completed
within one hour. ([App Manifests](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest))

The App SHOULD be public-installable when one Kestrel installation must connect
repositories owned by more than one GitHub account; an installation is accepted
only after a nonce-bound Kestrel setup flow. A private App is a valid deployment
restriction when every repository is owned by the App's account. This visibility
setting changes installation topology, not the normalized provider contract.

OAuth Apps, classic or fine-grained PATs, and unauthenticated public API calls are
not V1 ingestion credentials. A future multi-Operator connection flow MAY use a
GitHub App user access token to prove a person's GitHub identity, but event
ingestion and repository reads still use the installation identity.

### Events and invocation semantics

**GitHub fact.** `issue_comment` covers a top-level conversation comment on either
an issue or a pull request. Its payload includes the action, comment, issue,
repository, sender, and, for a GitHub App delivery, installation. GitHub requires
the App's Issues permission at read level to subscribe. Pull-request review bodies
and line-level review comments use the separate `pull_request_review` and
`pull_request_review_comment` events and require Pull requests permission.
([Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads))

GitHub documents `issue_comment` actions `created`, `edited`, and `deleted`, and an
`issue.pull_request` member distinguishes a pull-request conversation from an
issue conversation. ([Actions event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#issue_comment))

GitHub's webhook catalog has no `mention` event, no `mentioned` action, and no
structured list of mentions in `issue_comment`. GitHub's Markdown syntax says an
`@username` mention can notify a user, subject to access and notification rules,
and an edit can introduce a notification. Notifications therefore are not an
invocation transport. This conclusion is an inference from the documented event
catalog and mention behavior. ([Webhook catalog](https://docs.github.com/en/webhooks/webhook-events-and-payloads),
[mention syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#mentioning-people-and-teams))

**Kestrel decision.** The V1 parser accepts only `issue_comment.created`. It parses
the Markdown structure, not a substring: quoted text, code blocks, inline code,
and later paragraphs do not invoke. The first non-empty paragraph must begin with
exactly one configured App-login mention followed by `plan`; remaining text is the
Planning Session input. The adapter records the login snapshot and parser version,
while authorization uses IDs rather than names.

Before applying an effect, Kestrel refetches the comment with the installation
token. If it was deleted, cannot be read, or its current body no longer has the
same command hash as the signed `created` payload, the event becomes `stale` and
has no effect. A later edit or deletion does not revoke an already accepted
invocation; cancellation occurs inside Kestrel and is itself auditable.

The following surfaces are explicitly ignored as Provider Invocations in V1:

- issue or pull-request title/body creation or edits;
- `issue_comment.edited` and `issue_comment.deleted`;
- pull-request reviews and diff review comments;
- labels, assignments, milestones, reactions, and project changes;
- commit comments, Discussions, releases, deployments, and check actions;
- pushes, branch names, commit messages, `repository_dispatch`, and workflow
  dispatches;
- email or web notification delivery; and
- any event authored by the App bot, another bot, or an unbound human.

These may become explicit provider capabilities later, but none inherits invocation
semantics merely because GitHub exposes an event.

### Comments, reviews, and labels are different capabilities

**GitHub fact.** GitHub's issue-comment REST endpoints manage top-level comments on
both issues and pull requests because every pull request is also an issue. Reading
requires Issues read or Pull requests read. Creating, updating, or deleting such a
comment requires Issues write or Pull requests write; creating a comment triggers
notifications and is subject to secondary rate limiting. Comment objects expose
stable numeric and node IDs plus mutable body and timestamps.
([Issue comment endpoints](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10))

Pull-request review comments are diff-anchored objects with path, commit, line, and
side semantics, while a review groups comments and has a review state such as
`COMMENT`, `APPROVE`, or `REQUEST_CHANGES`. Both write surfaces require Pull
requests write, and diff positions can become outdated as the pull request changes.
([Review comment endpoints](https://docs.github.com/en/rest/pulls/comments?apiVersion=2026-03-10),
[review endpoints](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2026-03-10))

Applying or removing a label from an issue or pull request uses the issue-label
endpoints and requires Issues write or Pull requests write. Label creation,
renaming, and deletion are a different repository-level resource lifecycle.
([Issue label endpoints](https://docs.github.com/en/rest/issues/labels?apiVersion=2026-03-10),
[webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads))

**Kestrel decision.** The provider boundary MUST expose distinct capabilities for
conversation comments, review summaries, review threads, labels, checks, refs, and
pull-request creation. It MUST NOT model these as a generic `write` permission.
All provider writes require a later, explicit Operator action and their own
idempotency and self-loop suppression. `author_association`, a username, label
name, or mention notification is never an authorization signal.

### Pull-request, head, fork, and ref constraints

**GitHub fact.** A pull request is addressed in its base repository and exposes
separate base and head repository/ref/SHA data. Fetching a pull request is permitted
with Pull requests read or Contents read; public resources can also be fetched
without authentication. GitHub may create a test merge commit to calculate
mergeability, and `mergeable` may temporarily be `null` while that calculation is
running. ([Pull-request endpoint](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#get-a-pull-request))

GitHub documents pull-request refs under the base repository for local checkout,
but head branches can originate in forks and can change or disappear. Private-fork
visibility and permissions follow the private repository network's rules rather
than the base installation automatically becoming a grant on every fork.
([Checking out pull requests locally](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/checking-out-pull-requests-locally),
[fork permissions and visibility](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/about-permissions-and-visibility-of-forks))

**Kestrel decision.** Branch names, owner names, `mergeable`, and a synthetic test
merge commit are snapshots, not revision identity. On a PR invocation the adapter
captures:

```yaml
base:
  repository_provider_id: "..."
  ref_snapshot: "main"
  commit_sha: "..."
head:
  repository_provider_id: "..." # nullable only when GitHub no longer exposes it
  ref_snapshot: "feature"
  commit_sha: "..."
captured_at: "..."
```

The commit SHAs are immutable planning/review inputs even if the PR later
synchronizes. Provider-specific pull refs stay inside the GitHub adapter. If either
commit cannot be resolved or read, the invocation may still open planning with
`revision_state: unavailable`, but no Review First analysis or later Agent Run can
start until an explicit revision-acquisition gate succeeds. Invocation processing
never writes the head branch, including a fork branch.

## V1 permission and capability profile

GitHub App permissions determine both usable endpoints and subscribable webhook
events, and new Apps begin with no permissions. GitHub advises choosing the minimum
permissions needed; REST failures can report accepted permissions in
`X-Accepted-GitHub-Permissions`. ([Choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app))

| Provider capability | GitHub permission | V1 | Notes |
| --- | --- | --- | --- |
| Identify installed repository | Metadata read | Enabled | GitHub App baseline; still requires a Kestrel Project binding. |
| Receive top-level comment creation | Issues read + `issue_comment` | Enabled | Sole invocation event. |
| Read current top-level comment | Issues read or Pull requests read | Enabled | Authenticated refetch before effect. |
| Read PR metadata/base/head | Pull requests read | Enabled | Required for PR subject normalization and Review First sync. |
| Read repository content / Git over HTTP | Contents read | Enabled for Review First | Installation-token Git access requires Contents permission. ([permission guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)) |
| Receive PR lifecycle | Pull requests read + `pull_request` | Sync only | Updates external proposal metadata; never invokes. |
| Create conversation comment | Issues write or Pull requests write | Disabled | Later explicit writeback only. |
| Apply/remove label | Issues write or Pull requests write | Disabled | Later explicit writeback only. |
| Submit review/review comment | Pull requests write | Disabled | Separate semantics and stale anchors. |
| Create/update check | Checks write | Disabled | Checks REST write facilities are GitHub-App-specific. ([GitHub App choice](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app)) |
| Create/update ref or content | Contents write | Disabled | Belongs to a later, approved execution/writeback flow. |

The App subscribes to `issue_comment` and `pull_request`. GitHub sends
`installation` and `installation_repositories` to Apps by default; Kestrel consumes
them to disable removed, suspended, or no-longer-selected connections and to
reconcile the repository allowlist. ([Installation webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation),
[installation-repositories event](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation_repositories))

Granted permission is not the same as enabled product capability. The effective
capability is the intersection of Kestrel stage policy, active Provider Connection,
selected repository, current installation grant, credential health, and provider
support. Excess permission accidentally granted in GitHub MUST NOT enable a Kestrel
operation.

## Authentication and authorization decision

The signed webhook proves that the raw payload was delivered using the configured
App webhook secret. It does not prove that its `sender` is authorized to operate
Kestrel. The installation and repository identify scope; the sender identifies the
actor.

V1 binds the one local Operator to a stable GitHub user ID during the nonce-bound
App installation/setup flow. Every invocation requires all of the following:

1. the signature is valid for the selected App registration;
2. `(app_registration_id, installation.id, repository.id)` maps to one enabled
   Provider Connection and Project;
3. the installation is active and still grants that repository and required read
   permissions;
4. the event/action/surface and command grammar are the V1 allowlist;
5. `sender.id` equals the bound Operator provider-user ID and the sender is not the
   App bot; and
6. an authenticated refetch resolves the same comment and subject.

Logins, repository owner/name, URLs, `author_association`, and App slug are display
snapshots only. Stable provider IDs are keys. Public repositories follow the same
six checks: Kestrel never falls back to anonymous reads or accepts an invocation
outside an explicit installation/repository binding. Private-resource `404` and
permission failure are normalized without revealing repository existence to an
untrusted sender.

## Webhook security, reliability, and idempotency

**GitHub fact.** GitHub instructs receivers to compute an HMAC-SHA-256 over the
unmodified request body using the webhook secret, compare it in constant time with
`X-Hub-Signature-256`, and validate before processing. ([Validating deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries))

GitHub identifies a delivery with the globally unique `X-GitHub-Delivery` GUID and
reuses that GUID when it is redelivered. Receivers should respond successfully
within ten seconds and queue longer work. GitHub also recommends HTTPS, SSL
verification, an event/action allowlist, and replay protection.
([Webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks))

GitHub does not automatically redeliver a failed webhook. App webhook delivery APIs
can list delivery attempts and request redelivery using App authentication; manual
redelivery is available only for deliveries from the last three days.
([Failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries),
[redelivery](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks),
[App webhook delivery API](https://docs.github.com/en/rest/apps/webhooks?apiVersion=2026-03-10))

**Kestrel decision.** The synchronous ingress path verifies content type, body-size
limit, signature, App key, and required headers; durably inserts the raw-body hash
and normalized receipt; then returns `202` within ten seconds. Parsing, API reads,
authorization, and domain effects happen asynchronously. Private comment bodies
are encrypted or reduced under an explicit retention policy and never written to
ordinary logs.

Two unique keys are required:

- transport: `(provider_connection_id, provider_delivery_id)` where the latter is
  `X-GitHub-Delivery`; and
- semantic: `(provider_connection_id, repository_provider_id,
  interaction_kind, interaction_provider_id, action)`.

The semantic key prevents a replay from a reconciliation path with a different
transport receipt. Domain effects and an outbox record commit in one transaction.
A duplicate returns the original result and can never create a second Work Item or
Planning Session.

GitHub explicitly warns that webhook deliveries may arrive in a different order
than their underlying events. Kestrel therefore uses provider timestamps only as
observations, refetches current state, compares immutable IDs/revision SHAs, and
never lets an older delivery overwrite a newer resource snapshot.
([Webhook troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks#webhooks-deliveries-are-out-of-order))

A recovery job checks failed App deliveries well inside GitHub's three-day window
and requests redelivery by GUID. An outage beyond that window is not recoverable
from webhook history alone; the Project is marked `provider_sync_uncertain` and a
resource reconciliation is required before an invocation-dependent action.

## API version and rate-limit contract

Kestrel pins REST requests to `X-GitHub-Api-Version: 2026-03-10` and
`Accept: application/vnd.github+json`. GitHub's current documentation lists
`2026-03-10` and `2022-11-28` as supported versions, defaults requests without the
header to `2022-11-28`, and returns `410` for a no-longer-supported version.
([REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions?apiVersion=2026-03-10))

Installation-token primary limits start at 5,000 requests per hour and can scale by
repositories and organization users up to documented caps; Enterprise Cloud has
different limits. Secondary limits include concurrency, per-minute point, and
content-generation limits and may change. A response may use `403` or `429` and
provide `retry-after` or rate-reset headers. ([REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2026-03-10))

The adapter MUST expose rate state and retryability instead of hiding them. It uses
webhooks rather than polling, conditional authenticated GETs with ETags, bounded
per-installation queues, exponential backoff with jitter, and no blind retry of a
write. GitHub says an authenticated conditional request that returns `304` does
not count against the primary limit and advises serializing mutative requests.
([REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api))

REST is the V1 adapter API because its endpoint permissions are documented and its
version is explicit. GraphQL may be added behind the same ports, but it cannot
change normalized identities, authorization, idempotency, or capability behavior.

## Provider-neutral contract

The core never receives a GitHub webhook object. The GitHub adapter emits this
versioned envelope, retaining provider-specific extras behind opaque references:

```yaml
contract_version: 1
provider: github
provider_connection_id: kestrel-uuid
delivery:
  provider_id: github-delivery-guid
  event_type: issue_comment
  action: created
  received_at: timestamp
  signature_verified: true
  payload_sha256: hex
  api_version: "2026-03-10"
installation:
  provider_id: integer-as-string
  account_provider_id: integer-as-string
  repository_selection: all-or-selected
  permissions_snapshot: { issues: read, pull_requests: read, contents: read }
repository:
  provider_id: integer-as-string
  owner_provider_id: integer-as-string
  name_snapshot: string
  visibility: public-or-private
  web_url_snapshot: url
actor:
  provider_id: integer-as-string
  login_snapshot: string
  type_snapshot: user
subject:
  kind: work_request-or-change_proposal
  provider_id: integer-or-node-id-as-string
  number_snapshot: integer
  state_snapshot: string
  web_url_snapshot: url
  revision: null-or-base-and-head-shas
interaction:
  kind: conversation_comment
  provider_id: integer-as-string
  node_id: string
  body_sha256: hex
  body_or_secure_ref: string
  created_at: timestamp
  updated_at: timestamp
  web_url_snapshot: url
trigger:
  kind: plan
  parser_version: string
  request_text: string
```

`work_request` and `change_proposal` are provider-neutral subject kinds; `issue`
and `pull_request` remain GitHub adapter terms. Provider IDs are opaque strings in
core even when GitHub sends numbers.

The required ports are:

```text
ProviderWebhookIngress.verify_and_store(raw_bytes, headers) -> Receipt
RepositoryProvider.normalize(receipt) -> ProviderEvent
RepositoryProvider.capabilities(connection, repository) -> CapabilitySet
RepositoryProvider.resolve_interaction(ref) -> InteractionSnapshot
RepositoryProvider.resolve_subject(ref) -> SubjectSnapshot
ProviderIdentityAuthorizer.authorize(actor_ref, operator_binding) -> Decision
ProviderInvocationService.apply(event, decision) -> InvocationOutcome
```

`CapabilitySet` reports each narrow capability as `enabled`,
`permission_missing`, `repository_not_selected`, `installation_inactive`,
`product_disabled`, or `provider_unsupported`, with the observed provider grant
and API version. Adding GitLab or another Repository Provider must not require new
core event names for a top-level comment, change proposal, actor, repository, or
immutable revision.

The persistent `ProviderInvocation` records the envelope reference, authorization
decision and policy version, parser version, dedupe keys, linked Work Item,
Planning Session, outcome, and rejection reason. Its only accepted domain command
is equivalent to:

```text
EnsurePlanningSession(
  provider_subject_link,
  authorized_operator,
  request_text,
  optional_immutable_revision
)
```

The following invariants live in the core, not in the GitHub adapter:

1. A Provider Invocation can create or resume a Work Item and Planning Session.
2. A Provider Invocation MUST NOT create or approve a Run Trigger.
3. No provider webhook, including a future check button or label, can create an
   Agent Run.
4. An Agent Run requires a separate, explicit Operator approval recorded by
   Kestrel after planning.
5. Provider reads and writes are distinct capabilities; no implicit write follows
   an accepted invocation.
6. One provider interaction/action has at most one domain effect.
7. A repository's public visibility never bypasses installation, Project, or actor
   authorization.

## Limits, risks, and follow-up work

The boundary decision itself is complete enough to implement. The following are
known limits, not reasons to broaden V1:

- Webhook-only recovery has a hard three-day delivery-history horizon. The product
  assumption that the control plane remains reachable is therefore material.
- Renaming the App changes the human-visible trigger token. The connection must
  retain and refresh the login snapshot; stable IDs still govern authorization.
- A signed private-repository comment is sensitive customer content. Encryption,
  retention, export, and deletion policies must cover webhook payloads and
  invocation prompts.
- GitHub Enterprise Server is out of scope; its API version, events, and App
  installation model require a separately declared provider variant.
- GitHub can add event actions. The adapter rejects unknown actions by default,
  as GitHub's webhook guidance recommends.

One focused Wayfinder empirical-validation ticket is genuinely required before
claiming Review First supports every fork case:

> **Prove immutable GitHub PR revision acquisition across fork states.** Build an
> official-API test matrix for same-repository PRs, public forks, private forks,
> a removed installation grant, a deleted head branch/repository, and a force-push.
> Decide the adapter's acquisition order between base-repository pull refs and
> direct head-repository reads; verify that the captured base/head SHAs remain
> reviewable without expanding write permissions. The failure outcome must be
> `revision_state: unavailable`, never a fallback to a mutable branch or an Agent
> Run.

GitHub App registration, secret rotation, failed-delivery recovery, the command
parser, and future writeback do not need more boundary research. They should become
implementation acceptance criteria or later product tickets. In particular, the
first provider-write ticket must separately choose user-visible attribution,
comment versus review semantics, notification behavior, dedupe markers, self-loop
suppression, and reconciliation; this research intentionally does not enable that
surface.
