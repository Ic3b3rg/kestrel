# Kestrel

This repository contains an authenticated, observable Kestrel Installation path and the first
Provider Observation path: one local Operator can open a public github.com pull request without
GitHub credentials. PostgreSQL is the only durable authority.

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

This preserves the named `kestrel_postgres-data` volume. A later `npm run dev` presents the same
Installation and confirmed diagnostic operations. Use `docker compose down --volumes` only when
deliberately resetting all local Kestrel data.

## Observable path

After authentication, the PWA reads `GET /api/v1/installation`, opens `GET /api/v1/events`, and
submits `POST /api/v1/installation/diagnostics`. A successful command commits the Installation
transition, durable event, and pg-boss job in one PostgreSQL transaction. The worker advances the
diagnostic monotonically from queued to running to succeeded. The PWA reconnects from its last
confirmed event cursor and performs a full snapshot refetch when retained history has expired.

The same authenticated PWA reads `GET /api/v1/projects` and submits a canonical public GitHub pull
request URL to `POST /api/v1/projects`. Kestrel reads public pull request metadata from GitHub
without an account or token, then persists the Project, Change Proposal, exact base/head refs and
SHAs, and an audit record atomically. Opening the same pull request again is a manual, idempotent
refresh.

This path identifies the observed base and head commits but does not yet acquire their source. It is
limited by GitHub's shared unauthenticated allowance of 60 REST API requests per hour per
Installation IP and never falls back to credentials. Private repositories, local source acquisition,
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
their test volumes afterward. `npm run test:browser` drives the Project, diagnostic, and Operator
security controls through Chromium, checks keyboard and offline behavior, audits accessibility with
axe, and verifies 320, 768, 1024, and 1440 CSS-pixel viewports.

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

TLS/Caddy, authenticated repository-provider connections, source acquisition, model access, and
review workflows are delivered by later issues.

The development Compose file keeps database ownership out of the long-running services. The one-shot
migration and role-preparation containers use the database owner; web and worker connect as
`kestrel_runtime`, which cannot alter schema or update, delete, truncate, or disable protection on
Installation Audit records. The loopback-only development defaults can be overridden with
`KESTREL_MIGRATOR_DATABASE_PASSWORD` and `KESTREL_RUNTIME_DATABASE_PASSWORD`; a certified release
must supply generated values.
