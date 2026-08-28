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
but Kestrel stores no provider credential. Supported VPS/cloud operation, GitHub App, webhooks,
GitLab, and remote availability are deferred. The development Compose configuration disables host
repository discovery by default. Enabling it requires one explicit read-only bind mount as
documented below; Kestrel never scans arbitrary host paths.

## Start the development Installation

Requirements:

- Node.js 24 and npm 11;
- Docker Engine or Docker Desktop with the Compose plugin.

Install the pinned workspace dependencies once:

```sh
npm ci
```

Then start PostgreSQL, the Fastify web process, the pg-boss worker, and the Vite PWA with one
command. It returns after the required services are ready and leaves them running in the background:

```sh
npm run dev
```

Create the first Operator from the trusted host. The password prompts are hidden, and rerunning the
command leaves the existing Operator unchanged:

```sh
npm run bootstrap
```

Open [http://localhost:5173](http://localhost:5173) and sign in. The API and the production-shaped
compiled PWA are also available at [http://localhost:3000](http://localhost:3000).

If the password or every signed-in device is lost, recover the sole Operator from the trusted host:

```sh
npm run reset-password
```

The command accepts the new password only through hidden prompts (or stdin for automation), keeps
the username, and invalidates every existing session. Kestrel deliberately exposes no remote
password-recovery endpoint.

The Compose ports bind only to loopback. Operator sessions use signed, host-only, secure cookies
with an absolute seven-day lifetime. Every browser mutation requires an exact same-origin request;
authenticated mutations also require the session-bound CSRF header. TLS termination is still a later
delivery, so do not expose this development stack to an untrusted network.

Follow their logs when needed:

```sh
npm run dev:logs
```

Press `Ctrl-C` to leave the log view; the services keep running.

### Stop without deleting state

Stop and remove the development containers with:

```sh
npm run dev:down
```

This preserves the named `kestrel_postgres-data` and `kestrel_review-artifacts` volumes. A later
`npm run dev` presents the same Installation, confirmed diagnostic operations, and retained Review
Revisions. Use `docker compose down --volumes` only when deliberately resetting all local Kestrel
data and retained source.

## Authorize local repositories

Local discovery is disabled safely by the default `LOCAL_REPOSITORY_ROOTS=[]`. To enable it in
Compose, add a local override with an explicit host directory mounted read-only and refer to the
container path, never the host path, in configuration:

```yaml
services:
  web:
    environment:
      LOCAL_REPOSITORY_ROOTS: '["/repositories"]'
    volumes:
      - type: bind
        source: /absolute/path/to/authorized-parent
        target: /repositories
        read_only: true
```

The web process validates all five local-source settings before listening:

- `LOCAL_REPOSITORY_ROOTS` — JSON array of absolute, non-overlapping directory roots;
- `LOCAL_GIT_EXECUTABLE` — absolute executable path to Git 2.45 or newer;
- `ARTIFACT_ROOT` — Kestrel-owned mode-0700 directory outside every repository root;
- `REVIEW_REVISION_MAX_BYTES` — positive maximum retained bytes per exact revision;
- `REVIEW_REVISION_MAX_OBJECTS` — positive maximum unique retained objects per revision.

The image uses `/usr/bin/git` and the separate `review-artifacts` volume. For a native web process,
create the artifact directory as the web service user with owner-only access. After exporting the
normal database and session settings, a complete local-source configuration and native start looks
like this:

```sh
install -d -m 0700 /var/lib/kestrel/review-revisions
npm run build
LOCAL_REPOSITORY_ROOTS='["/srv/kestrel-repositories"]' \
LOCAL_GIT_EXECUTABLE=/usr/bin/git \
ARTIFACT_ROOT=/var/lib/kestrel/review-revisions \
REVIEW_REVISION_MAX_BYTES=10485760 \
REVIEW_REVISION_MAX_OBJECTS=10000 \
npm run start -w @kestrel/web
```

The configured repository root must already exist and be readable by the web service user. Restart
the web process after changing authorized roots. Duplicate, nested, symlinked, escaped,
inaccessible, or source/artifact-overlapping roots fail closed before the listener starts.

In the PWA, “Open local repository” lists only bounded display labels and opaque IDs beneath these
roots. The browser never submits a path. Select two enumerated committed refs and write or
explicitly copy a commit-subject suggestion into Change Intent. Kestrel re-resolves both refs to
exact object IDs before acquisition; later branch movement cannot retarget the Review Revision.

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
an artifact locator or local path.

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
disambiguates multiple provider proposals for the same exact commit pair. Private provider metadata,
model access, GitHub Enterprise, GitLab, and Provider Synchronization remain out of scope.

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

- `apps/web` owns the Fastify HTTP/SSE boundary and serves the compiled PWA.
- `apps/worker` consumes durable pg-boss jobs.
- `apps/pwa` owns the browser experience and retains no product data in browser storage.
- `packages/contracts` owns versioned Zod, JSON Schema, and OpenAPI contracts.
- `packages/database` owns SQL migrations and node-postgres queries; there is no ORM.
- `packages/local-source` owns bounded discovery, fixed Git inspection, verified artifact retention,
  reconciliation, and detached artifact reads.

Model access and Review Workflows are delivered by later issues. TLS/Caddy and Repository Provider
Connections are outside the local-first V1 contract.

The development Compose file keeps database ownership out of the long-running services. The one-shot
migration and role-preparation containers use the database owner; web and worker connect as
`kestrel_runtime`, which cannot alter schema or update, delete, truncate, or disable protection on
Installation Audit records. Review-domain grants are similarly narrow: Change Intent is
select/insert-only and the Project, proposal, source, and revision lifecycle tables expose no DELETE
authority; database constraints preserve immutable revisions and canonical-family associations. The
loopback-only development defaults can be overridden with `KESTREL_MIGRATOR_DATABASE_PASSWORD` and
`KESTREL_RUNTIME_DATABASE_PASSWORD`; a certified release must supply generated values.
