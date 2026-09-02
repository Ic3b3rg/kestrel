# Kestrel

This repository contains an authenticated, observable Kestrel Installation and its first local-first
source path. One local Operator can select exact committed base/head references from an authorized
read-only Git repository, confirm Change Intent, and retain an immutable Review Revision. A public
github.com pull request may add optional Provider Observation metadata without GitHub credentials.
PostgreSQL is the durable application authority; verified source objects live in a separate
Kestrel-owned artifact root.

Review First V1 is [local-first](./docs/adr/0002-make-review-first-v1-local-first.md): every review
must be materialized from exact commits available through an authorized local Git repository. Public
GitHub and the Operator's existing host `gh` session may provide optional pull-request discovery,
but Kestrel stores no Repository Provider credential. A separately configured Direct API profile may
store one encrypted Model Provider key as described below. Supported VPS/cloud operation, GitHub
App, webhooks, GitLab, and remote availability are deferred. The supported development path runs
web, worker, and PWA under the current macOS Operator while Docker owns only PostgreSQL and one-shot
database preparation. Local repository discovery remains disabled until the Operator supplies an
explicit root; Kestrel never scans arbitrary host paths.

## Start the development Installation

Requirements:

- Node.js 24 and npm 11;
- Docker Engine or Docker Desktop with the Compose plugin.

Install the pinned workspace dependencies once:

```sh
npm ci
```

Then start PostgreSQL, prepare the database, and supervise the Fastify web process, pg-boss worker,
and Vite PWA with one command:

```sh
npm run dev
```

PostgreSQL, migrations, and runtime-role preparation run in Kestrel-owned containers. The three
long-running applications run as the current Operator and inherit the host `PATH`, so the launcher
can resolve the existing `git`, `gh`, and `codex` executables without copying credentials into a
container. `git` is required; unavailable optional tools are reported without preventing startup.
The launcher prints the loopback URLs only after the API and PWA are ready, then remains attached
and streams the host-process logs until `Ctrl-C` stops all three processes.

Development artifacts, model-provider secrets, and the stable session-signing key live under the
ignored, owner-only `.kestrel/development` directory by default. Set `KESTREL_STATE_ROOT` to another
absolute Operator-owned path when needed. PostgreSQL listens only on
`127.0.0.1:${KESTREL_DATABASE_PORT:-54320}` for the host processes.

On the first start after upgrading from the Compose-only lifecycle, the launcher stops and removes
the old application containers, then imports retained model-provider secrets and Review Revisions
from their named volumes without overwriting newer host files. PostgreSQL and its named volume stay
in place throughout the transition.

Create the first Operator from the trusted host. The password prompts are hidden, and rerunning the
command leaves the existing Operator unchanged:

```sh
npm run bootstrap
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) and sign in. The API and the production-shaped
compiled PWA are also available at [http://127.0.0.1:3000](http://127.0.0.1:3000).

After sign-in, use **Open Project** in the persistent Project rail to select one repository from the
trusted-host inventory. Kestrel creates or reuses its durable Project and selects it through a
`/projects/:id` URL, so the same Project remains selected after reload without browser storage.
Settings remains available from the rail for Installation, repository-access, and Operator controls.

If the password or every signed-in device is lost, recover the sole Operator from the trusted host:

```sh
npm run reset-password
```

The command accepts the new password only through hidden prompts (or stdin for automation), keeps
the username, and invalidates every existing session. Kestrel deliberately exposes no remote
password-recovery endpoint.

Every listener binds only to loopback. Operator sessions use signed, host-only, secure cookies with
an absolute seven-day lifetime. Every browser mutation requires an exact same-origin request;
authenticated mutations also require the session-bound CSRF header. TLS termination is still a later
delivery, so do not expose this development stack to an untrusted network.

The attached `npm run dev` terminal shows web, worker, and PWA logs. Inspect only the database
infrastructure logs from another terminal when needed:

```sh
npm run dev:logs
```

Press `Ctrl-C` to leave this infrastructure log view; the supervised host processes are controlled
by the original `npm run dev` terminal.

### Stop without deleting state

First press `Ctrl-C` in the `npm run dev` terminal, then stop and remove the database infrastructure
containers with:

```sh
npm run dev:down
```

This preserves the named `kestrel_postgres-data` volume and `.kestrel/development`. A later
`npm run dev` presents the same Installation, sessions, confirmed diagnostic operations, Direct API
credential handles, and retained Review Revisions. An intentional complete reset requires both
`npm run dev:down -- --volumes` and removal of the exact configured `KESTREL_STATE_ROOT`; inspect
both targets before deleting them.

## Configure direct OpenAI API access

The Project panel can configure one exact OpenAI Responses API profile. Adding or replacing the API
key requires the current Operator password and runs one bounded synthetic structured-output test
before activation. Kestrel fixes the HTTPS origin, API surface and version, pinned model identity,
disabled tool/file/URL/retrieval/callback policy, data-policy attestation, limits, and price
snapshot. A failed identity check has no fallback route.

The test sends the configured `OpenAI-Project` routing header and records that Project as
attributed, while independently checking the response organization, API version, pinned model, and
request ID. OpenAI's documented response metadata does not include a Project identity header. A
successful synthetic test is valid for 24 hours; after that the profile is stale until an explicit
re-test succeeds.

The database and PWA contain only safe profile metadata. The API key is encrypted behind a random,
Project-exclusive handle under `MODEL_PROVIDER_SECRET_ROOT`. The local launcher sets this to the
owner-only `model-provider-secrets` directory beneath `KESTREL_STATE_ROOT` for `web` only; it is not
passed to a container or the browser. Removing that directory or its wrapping key makes the profile
unavailable; it does not expose or silently replace the key.

## Authorize local repositories

Local discovery is disabled safely until the Operator authorizes an explicit parent directory from
the trusted host. The supported command validates the complete resulting configuration before it
changes the current development Installation:

```sh
npm run authorize-repository-root -- /absolute/path/to/authorized-parent
```

Each successful command adds one canonical root to the owner-only
`.kestrel/development/repository-roots.json` file (or beneath the explicit `KESTREL_STATE_ROOT`). It
stores local configuration only, never credentials. Missing, unreadable, relative, duplicate,
nested, symlinked, or Kestrel-storage-overlapping candidates fail without replacing the previous
valid file and without including the rejected path in the error message.

If Kestrel is already running, choose **Refresh repositories** in Settings or in **Open local
repository**. A restart reads the same persisted configuration. The path is read only by the
host-native web process; it is never mounted into an application container or returned to the
browser. `LOCAL_REPOSITORY_ROOTS` remains an explicit JSON-array override for specialized native
runs and takes precedence over the persisted development configuration.

The web process validates all five local-source settings before listening:

- `LOCAL_REPOSITORY_ROOTS` — JSON array of absolute, non-overlapping directory roots;
- `LOCAL_GIT_EXECUTABLE` — absolute executable path to Git 2.45 or newer;
- `ARTIFACT_ROOT` — Kestrel-owned mode-0700 directory outside every repository root;
- `REVIEW_REVISION_MAX_BYTES` — positive maximum retained bytes per exact revision;
- `REVIEW_REVISION_MAX_OBJECTS` — positive maximum unique retained objects per revision.

The launcher discovers an absolute Git executable and creates the artifact directory with mode 0700.
`LOCAL_GIT_EXECUTABLE`, `ARTIFACT_ROOT`, `REVIEW_REVISION_MAX_BYTES`, and
`REVIEW_REVISION_MAX_OBJECTS` remain explicit overrides for a specialized native run. Restart the
web process after changing authorized roots.

Every configured repository root must already exist and be readable by the web service user.
Duplicate, nested, symlinked, escaped, inaccessible, or source/Kestrel-storage-overlapping roots
fail closed before the listener starts or an inventory refresh activates them. Kestrel-owned storage
includes retained artifacts and model-provider secrets.

In the PWA, “Open local repository” lists only bounded display labels and opaque IDs beneath these
roots. The browser never submits a path. Select two enumerated committed refs and write or
explicitly copy a commit-subject suggestion into Change Intent. Kestrel re-resolves both refs to
exact object IDs before acquisition; later branch movement cannot retarget the Review Revision.

Until that inventory is ready, the dialog names the current state: checking configuration, no
configured roots, configured roots with no discoverable repository, or discovery failure. It shows
the trusted-host command above instead of an unexplained empty selector; host filesystem paths are
never returned to the browser.

The retained closure contains the selected base/head commit objects and all trees and blobs needed
to materialize those two exact source trees. It deliberately excludes ancestor history, unrelated
branches, gitlink targets, the index, and dirty, staged, ignored, or untracked working-tree bytes.
Symlink blobs are retained as bytes and never followed. The snapshot remains readable if its Local
Repository Source becomes detached.

Local acquisition uses only fixed read-only Git inspection commands with sanitized configuration and
environment. It never fetches, pulls, clones, checks out, invokes hooks or filters, consults
credential helpers, SSH agents, provider CLIs, runs a build/test, or executes repository-defined
commands. It never modifies or deletes the source repository.

When an attached observed GitHub pull request is missing a captured object locally, Kestrel may
fetch only the base branch and `refs/pull/<number>/head` from that pull request's canonical base
repository into disposable Project-scoped bare storage. The captured base/head object IDs remain
authoritative if either ref moves. Kestrel makes at most one bounded recovery fetch for those exact
IDs, rejects unexpected refs, Git configuration, replacements, alternates, malformed object graphs,
and incomplete closure, then removes the disposable repository. Temporary acquisition storage is
bounded by the configured revision bytes plus fixed, per-object Git storage overhead; the fetched
object count cannot exceed the configured revision object limit. Host Git credentials may answer the
canonical HTTPS challenge but are never returned to the browser or stored in the retained artifact.
Git LFS pointer blobs are retained as pointer bytes and never hydrated; gitlink entries are recorded
but their submodule target repositories and objects are not fetched or retained.

Once the exact Review Revision is Available, the Project panel exposes a deterministic Change
Overview tied to that retained base/head pair. It shows the current selected Change Intent, current
Provider Observation when present, exact commit identity, base/head committed-tree file counts,
added/modified/deleted file counts, bounded changed paths, path-derived source areas, and explicit
truncation, gitlink, or Git LFS warnings. A changed proposal head hides prior facts until that exact
source is retained. Repeating retention for an older Available revision whose fact manifest is
missing regenerates facts from its verified immutable artifact; it neither reads nor retargets the
original repository. This is orientation only: it contains no code-level analysis, Graph, Evidence,
Coverage judgment, Finding, Risk Level, behavioral claim, or review verdict.

When an exact Direct API profile is available, Kestrel may add one optional model-rendered
orientation above those facts. The request contains only a 48 KiB bounded fact manifest, a strict
fact-ID citation schema, and no repository content, tools, URLs, retrieval, Graph, claims, risk,
Evidence or Coverage judgments, Findings, or verdict fields. Output is all-or-nothing: every
sentence must cite one inspectable fact and match a deterministic fact-specific sentence form.
Unsupported output, a timeout, an unavailable profile or credential, and provider failure leave the
deterministic facts usable with an inline status; none creates Operator Attention or blocks explicit
Conceptual Review work.

Only a newly opened logical Proposal or a new exact source head can automatically enqueue or replace
this rendering. Profile edits, provider refreshes that retain the same head, and other metadata
changes do not regenerate it. The transactionally enqueued pg-boss job is coalesced and fenced by
Proposal, Review Revision, exact head, and generation token. It runs in the web process that alone
holds model credentials, at negative queue priority with one local slot and a 256-token output cap.
Late output for a superseded head is discarded. The API reports queue, model, and Kestrel processing
latency separately; the black-box performance target is Kestrel processing overhead p95 at or below
250 ms, excluding both queue and model time.

A failed acquisition publishes no partial artifact and records a bounded unavailable reason. If
filesystem publication succeeds but the database completion is uncertain, Kestrel locks and rereads
the revision: an already-available artifact is preserved; an acquiring artifact is quarantined
before the unavailable transition. An acquiring row older than 30 minutes becomes retryable only
when its per-revision session lease is no longer live; orphaned acquisitions are also reconciled at
startup.

Expected public failures use the versioned API envelope and the stable codes
`REPOSITORY_NOT_AVAILABLE`, `REFERENCE_NOT_AVAILABLE`, `BASE_REVISION_UNRESOLVABLE`,
`HEAD_REVISION_UNRESOLVABLE`, `PULL_REF_MISMATCH`, `PROVIDER_AUTHENTICATION_REQUIRED`,
`PROVIDER_RESOURCE_UNAVAILABLE`, `SOURCE_CONTAINMENT_VIOLATION`, `REVISION_LIMIT_EXCEEDED`,
`OBJECT_MISSING`, `OBJECT_VERIFICATION_FAILED`, `CHANGE_PROPOSAL_MISMATCH`, or `REVISION_ACQUIRING`.
Messages and logs returned to the browser do not include source paths, Git stderr, credentials, or
artifact locators.

## Observable path

After authentication, the PWA reads `GET /api/v1/installation`, opens `GET /api/v1/events`, and
submits `POST /api/v1/installation/diagnostics`. A successful command commits the Installation
transition, durable event, and pg-boss job in one PostgreSQL transaction. The worker advances the
diagnostic monotonically from queued to running to succeeded. The PWA reconnects from its last
confirmed event cursor and performs a full snapshot refetch when retained history has expired.

The authenticated PWA reads the opaque local inventory and committed refs through
`GET /api/v1/local-repository-sources` and
`GET /api/v1/local-repository-sources/:repositoryId/references`. It submits the confirmed selection
to `POST /api/v1/review-revisions`; success exposes the exact identity and Revision State but never
an artifact locator or local path. The same response and subsequent Project reads expose the Change
Overview generation state and, when ready, its bounded deterministic fact manifest. The PWA polls
only while that overview's optional rendering is queued or running, so the latest fenced result or
inline failure becomes visible without delaying review controls.

The same PWA reads `GET /api/v1/projects` and may submit a canonical public GitHub pull request URL
to `POST /api/v1/projects`. Kestrel reads public pull request metadata from GitHub without an
account or token, then persists the Project, Change Proposal, exact base/head refs and SHAs, and an
audit record atomically. Opening the same pull request again is a manual, idempotent refresh.

Provider Observation is limited by GitHub's shared unauthenticated allowance of 60 REST API requests
per hour per Installation IP and never falls back to credentials. It does not supply source. When a
sanitized local GitHub remote and exact commits match an observed proposal, local source attaches to
that same logical Project and Change Proposal. If independent local and provider-first records
already exist, Kestrel keeps their immutable source/revision history, creates durable internal
aliases, and returns only the canonical Project in the inbox. An explicit proposal selection
disambiguates multiple provider proposals for the same exact commit pair. Private Repository
Provider metadata, GitHub Enterprise, GitLab, and Provider Synchronization remain out of scope.
Direct OpenAI model access is configured independently and never supplies repository source or
Provider Observation.

Useful endpoints on port 3000:

- `/health/live` — process liveness;
- `/health/ready` — database-backed readiness;
- `/auth/login` — Operator login;
- `/auth/logout` — clear the current browser cookies;
- `/auth/step-up` — create a five-minute, one-command proof from the current password;
- `/api/v1/session` — current authenticated session;
- `/api/v1/operator/credentials` — step-up-protected username/password change;
- `/api/v1/installation` — authoritative snapshot;
- `/api/v1/projects` — Project inbox read and public GitHub pull request open/refresh;
- `/api/v1/projects/:projectId/model-profiles/direct-api` — read or step-up configure the exact
  Direct API profile;
- `/api/v1/projects/:projectId/model-profiles/direct-api/test` — re-test the stored profile;
- `/api/v1/local-repository-sources` — bounded opaque authorized repository inventory;
- `/api/v1/local-repository-sources/:repositoryId/references` — bounded committed ref inventory;
- `/api/v1/review-revisions` — retain an exact, Operator-intended Review Revision;
- `/api/v1/events` — replayable SSE stream;
- `/api/v1/openapi.json` — generated OpenAPI 3.1 contract.

Health checks, the login endpoint, and the PWA shell are public; all API reads and commands,
including the OpenAPI document, require the Operator session. Application and worker logs are
structured JSON. Installation, diagnostic, and successful-login Operator identifiers appear in logs;
passwords, session tokens, step-up proofs, database credentials, and request bodies do not. Security
events are appended to a hash-chained Installation Audit in PostgreSQL.

Changing credentials requires the current password and an opaque proof bound to the Operator,
action, target, and canonical request digest. A proof expires within five minutes and is consumed on
its first presentation, including a mismatched or expired presentation. A successful credential
change rotates the credential and signing generations, invalidating every existing session.

## Verification

Run the focused checks independently:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run contracts:check
npm test
npm run test:black-box
npm run test:browser
npm run build
```

`npm run test:black-box` creates isolated Compose projects on random loopback ports and deletes
their test volumes and generated repository roots afterward. It proves source immutability,
committed-object exactness, artifact durability after source disappearance, and lifecycle
idempotency. `npm run test:browser` drives local and provider Project flows, diagnostic, and
Operator security controls through Chromium, checks keyboard and offline behavior, audits
accessibility with axe, and verifies mobile and desktop viewports.

The authored Zod schemas live in `packages/contracts/src`. Regenerate committed JSON Schema and
OpenAPI artifacts after an intentional contract change:

```sh
npm run contracts:generate
npm run contracts:check
```

`contracts:check` is read-only and fails when generated files have drifted from their Zod source.

## Architecture boundaries

- `apps/web` owns the Fastify HTTP/SSE boundary, serves the compiled PWA, and consumes the
  low-priority Change Overview rendering queue because only that process holds model credentials.
- `apps/worker` consumes durable acquisition and diagnostic pg-boss jobs.
- `apps/pwa` owns the browser experience and retains no product data in browser storage.
- `packages/contracts` owns versioned Zod, JSON Schema, and OpenAPI contracts.
- `packages/database` owns SQL migrations and node-postgres queries; there is no ORM.
- `packages/local-source` owns bounded discovery, fixed Git inspection, verified artifact retention,
  reconciliation, and detached artifact reads.
- `packages/model-provider` owns encrypted model credentials, the fixed OpenAI transport, synthetic
  certification, and the stateless structured-text inference boundary.

Review preparation now exposes the exact retained revision, resolved intent, source provenance,
analysis profile and route availability, authority, Resource Envelope, and blockers before
confirmation. A configured Resource Envelope includes explicit memory, process, writable-disk, CPU,
and concurrency limits plus its terminal exhaustion boundary; the built-in profile remains blocked
until benchmark-derived limits are supplied rather than inventing a default. Starting a ready Review
Workflow freezes those bindings transactionally. Direct API profile configuration supplies optional
Change Overview wording; binding it into Conceptual Review execution, resource admission, and
workflow execution is delivered by later issues. TLS/Caddy and Repository Provider Connections are
outside the local-first V1 contract.

The development Compose files keep database ownership out of the host-native long-running services.
The one-shot migration and role-preparation containers use the database owner; host web and worker
connect over loopback as `kestrel_runtime`, which cannot alter schema or update, delete, truncate,
or disable protection on Installation Audit records. Review-domain grants are similarly narrow:
Change Intent is select/insert-only and the Project, proposal, source, and revision lifecycle tables
expose no DELETE authority; Review Workflow records are select/insert-only, and database constraints
preserve frozen inputs, immutable revisions, and canonical-family associations. The loopback-only
development defaults can be overridden with `KESTREL_MIGRATOR_DATABASE_PASSWORD` and
`KESTREL_RUNTIME_DATABASE_PASSWORD`; a certified release must supply generated values.
