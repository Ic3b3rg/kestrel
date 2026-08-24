# Observable Kestrel Installation design

Status: approved for implementation

Date: 2026-08-24

Issue:
[#34 — V1 01: Start an observable Kestrel Installation](https://github.com/Ic3b3rg/kestrel/issues/34)

Parent contract:
[#33 — Specify Kestrel Review First V1 implementation contract](https://github.com/Ic3b3rg/kestrel/issues/33)

## Purpose

Build Kestrel's first executable vertical slice. One development command starts PostgreSQL, a web
process, a worker process, and a PWA. The Operator can see the persisted Kestrel Installation,
request a diagnostic operation, and observe the durable result through replayable server-sent events
(SSE).

This slice also establishes the shared contracts and TypeScript black-box seam that later Review
First V1 tickets will extend.

## Scope

This ticket includes:

- a strict-TypeScript npm workspace;
- independent Fastify web and pg-boss worker entrypoints;
- a React/Vite PWA diagnostic screen;
- PostgreSQL persistence and versioned SQL migrations without an ORM;
- versioned Zod contracts with generated JSON Schema and OpenAPI;
- atomic diagnostic state mutation and pg-boss enqueue;
- ordered, durable, replayable SSE;
- a TypeScript black-box harness covering API, SSE, browser, and process restart;
- basic health endpoints and structured JSON logs.

This ticket does not implement authentication, Operator bootstrap or recovery, Caddy or
certified-host installation, GitHub connectivity, Projects, Change Proposals, model access, or
review behavior. Those capabilities remain in their dependency-ordered tickets. The boundaries
introduced here must allow those tickets to extend the system without replacing this slice's public
contracts.

## Architectural choice

Use a modular monolith organized as npm workspaces:

```text
apps/
  pwa/                 React/Vite browser application
  web/                 Fastify API, SSE, and static production assets
  worker/              pg-boss job consumer
packages/
  contracts/           Zod source contracts and generated schemas
  database/            node-postgres pool, transactions, and migrations
tests/
  black-box/           certified-release-style TypeScript harness
```

The web and worker are separate processes with separate entrypoints. They share Kestrel-owned
packages, not network calls or duplicated contract types. PostgreSQL is the only durable authority
in this slice. The PWA holds no durable application data.

The accepted stack is Node 24 LTS, strict TypeScript, Fastify, React/Vite, PostgreSQL 18, pg-boss,
Docker Compose, and npm workspaces. Dependencies are pinned exactly in the lockfile. Caddy is part
of the later certified installation topology and is not needed by this development tracer bullet.

## Development topology

`npm run dev` invokes the development Compose project and starts:

- PostgreSQL 18 with a named volume and a health check;
- a one-shot migration service after PostgreSQL is healthy;
- the web process after the migration service succeeds;
- the worker process after the migration service succeeds;
- the Vite PWA development server, which proxies `/api` to the web process.

The migration service applies Kestrel migrations and installs or upgrades the pinned pg-boss schema
before either application process can use it. The PWA is available at one documented local URL.
Compose process restarts preserve the PostgreSQL volume. Build output, dependency directories, local
environment files, and test artifacts are ignored by Git.

The production-shaped web build serves the compiled PWA assets, but the development topology retains
a separate PWA process to satisfy the ticket's explicit four-component seam and provide normal Vite
feedback.

## Durable data model

Versioned SQL migrations create Kestrel-owned tables plus the pg-boss schema.

### `installations`

Exactly one row exists in this first slice.

- `id uuid primary key`
- `state text` constrained to `ready`, `diagnostic_queued`, `diagnostic_running`, or
  `diagnostic_succeeded`
- `current_diagnostic_id uuid null`
- `revision bigint` incremented for each accepted domain transition
- `created_at timestamptz`
- `updated_at timestamptz`

### `installation_diagnostics`

- `id uuid primary key`
- `installation_id uuid` referencing `installations`
- `status text` constrained to `queued`, `running`, or `succeeded`
- `requested_at timestamptz`
- `started_at timestamptz null`
- `completed_at timestamptz null`

The worker transitions a diagnostic monotonically. Reprocessing a job after a crash does not move a
completed diagnostic backwards or emit duplicate transition events.

### `installation_events`

- `id bigint generated always as identity primary key`
- `installation_id uuid`
- `type text`
- `schema_version integer`
- `payload jsonb`
- `created_at timestamptz`

The event ID is the SSE cursor. Events are inserted in the same database transaction as the state
they describe. Payloads are validated against the versioned event contract before insertion and
again when read.

### `event_streams`

One row records the stream's first available event ID and latest committed event ID. It makes cursor
expiry unambiguous even when pruning removes every event that a client names.

The development release profile retains the latest 1,000 events. The black-box fixture profile uses
a limit of eight so expiry can be tested without private database access. Retention is an internal
immutable profile value, not an Operator setting.

### `schema_migrations`

An ordered migration ledger records each migration name and checksum. Startup refuses to continue
when an already-applied migration has a different checksum.

## Public HTTP contracts

All application routes live under `/api/v1`.

### `GET /api/v1/installation`

Returns the Installation snapshot, the current diagnostic when present, and `eventCursor`, the
latest event committed before the snapshot transaction completed. The PWA uses that cursor to bridge
the snapshot-to-stream race.

### `POST /api/v1/installation/diagnostics`

Returns `202 Accepted` with the queued diagnostic and its event cursor.

The route performs one PostgreSQL transaction:

1. lock the Installation row;
2. create a queued diagnostic;
3. update the Installation and increment its revision;
4. insert the corresponding durable event;
5. enqueue the pg-boss job through an adapter bound to the same `pg.Client` transaction;
6. notify event listeners;
7. commit.

Any failure rolls back all six mutations. A successful response therefore never exposes state
without a corresponding durable job, or a job without corresponding state.

### `GET /api/v1/events`

Produces `text/event-stream`. An initial `after` query parameter bridges the browser's snapshot
cursor; `Last-Event-ID` takes precedence on reconnect. Event records contain `id`, `event`, and one
JSON `data` field matching the shared Zod contract.

The endpoint:

1. validates the requested cursor before sending streaming headers;
2. returns `409 EVENT_CURSOR_EXPIRED` with `refetch: "/api/v1/installation"` when the cursor
   predates retention;
3. subscribes to PostgreSQL notification wake-ups;
4. reads all retained events after the cursor in ascending ID order;
5. queries again after each notification and on a bounded poll interval;
6. sends comment heartbeats that do not advance the event cursor.

Notifications carry no authoritative event data. Querying the event table by the last emitted ID
closes notification races and recovers from missed notifications.

The PWA consumes the SSE response with `fetch` rather than the native `EventSource` interface so it
can set `Last-Event-ID`, inspect the typed `409` response, and perform the required full refetch.
The wire format remains standard SSE.

### Health and generated contracts

- `GET /health/live` proves that the web process can respond.
- `GET /health/ready` proves that required database state and migrations are available.
- `GET /api/v1/openapi.json` serves the generated OpenAPI document.
- the build generates committed JSON Schema artifacts from the same Zod source contracts.

Fastify validates requests and serializes documented responses from those generated schemas. Unknown
fields are rejected at public command boundaries.

## Worker behavior

The worker registers one diagnostic queue and consumes jobs through pg-boss.

For a newly queued diagnostic it:

1. transactionally changes `queued` to `running`, updates the Installation, and appends an event;
2. performs the bounded deterministic diagnostic work;
3. transactionally changes `running` to `succeeded`, updates the Installation, and appends an event;
4. lets pg-boss complete the job.

If the process dies after a domain transaction but before pg-boss records completion, retry observes
the persisted status and resumes or no-ops without duplicating a transition. This slice has no
external side effect beyond PostgreSQL.

## PWA experience

The first screen uses semantic HTML and contains:

- the Kestrel Installation identity and current state;
- the latest diagnostic status and timestamps;
- a `Run diagnostic` button;
- a connection indicator with text as well as color;
- a polite live region announcing diagnostic transitions;
- explicit loading, request failure, stream-disconnected, cursor-expired, and offline states.

The page is usable by keyboard, has visible focus, meets text contrast requirements, respects
`prefers-reduced-motion`, and does not overflow horizontally at 320, 768, 1024, or 1440 CSS pixels.
The layout is content-led and introduces no navigation or Review First concepts that belong to later
tickets.

The PWA manifest identifies Kestrel and supports installation. Its service worker caches only
versioned static shell assets. API responses, events, Installation data, commands, and credentials
are never cached or written to browser storage. When offline, product data is hidden and the
diagnostic command is disabled until a full refetch succeeds.

## Error handling and observability

Every public error uses a versioned contract with a stable code, human-readable message, and
correlation ID. Expected errors include invalid input, expired event cursor, unavailable database,
and conflicting Installation transition.

Web and worker emit structured JSON logs with timestamp, level, service, event name, correlation ID,
and relevant Kestrel identifiers. Logs do not contain database credentials or raw request bodies.
Readiness fails when the required schema is unavailable; liveness remains process-local.

The PWA retains the last confirmed snapshot while reconnecting only when online. It never claims
that a command completed until the authoritative API snapshot or SSE transition confirms it.

## Contract generation

Zod modules are the authored source for public request, response, event, and error shapes. A
deterministic generation command produces:

- JSON Schema grouped under the API version;
- the OpenAPI document used by Fastify and served publicly;
- TypeScript types consumed directly by web, worker, PWA, and tests.

CI-style verification regenerates into a temporary location and fails if committed generated
artifacts differ. Generated artifacts include their schema version but no timestamps, keeping output
reproducible.

## Test strategy

The primary seam is the TypeScript black-box harness defined by the parent contract. It replaces
only configuration and the clock where a bounded fixture value is required; it does not mock
internal modules or inspect private call graphs.

### Focused tests

- public Zod contracts accept documented examples and reject malformed or unknown data;
- migration ordering and checksum mismatch behavior;
- monotonic diagnostic transitions;
- SSE encoding and cursor-expiry classification.

Each behavioral test is introduced red-first at the public seam it protects.

### Black-box scenarios

- start the complete development stack with one command and read the persisted Installation through
  the API;
- open SSE, submit a diagnostic, observe ordered `queued`, `running`, and `succeeded` events, and
  confirm the final API snapshot;
- reconnect with `Last-Event-ID` and receive only later events without duplication;
- exceed fixture retention, receive `EVENT_CURSOR_EXPIRED`, refetch, and reconnect from the new
  snapshot cursor;
- operate the diagnostic control in a real browser and observe the successful result in the PWA;
- restart web and worker, then confirm that Installation and completed diagnostic state remain
  unchanged;
- regenerate JSON Schema and OpenAPI and prove there is no drift;
- run browser checks at the certified breakpoints with keyboard, reduced motion, and automated
  accessibility assertions.

The implementation runs focused test files and TypeScript checks after each vertical slice.
Completion requires formatting, lint, all typechecks, focused tests, the full suite, a production
build, runtime Compose verification, and a clean generated-contract check.

## Implementation slices

1. Workspace, exact dependency pins, Compose PostgreSQL, migration runner, and persisted
   Installation read path.
2. Shared Zod contracts plus deterministic JSON Schema/OpenAPI generation.
3. Atomic diagnostic command, pg-boss worker, and durable transition events.
4. Ordered SSE replay, expiry, polling recovery, and typed errors.
5. PWA snapshot, command, live updates, offline behavior, and accessibility.
6. Full black-box restart and browser scenarios, documentation, and final conformance verification.

Each slice must leave the repository type-correct and tested before the next slice starts.

## Sources

- [Kestrel Review First V1 implementation contract](https://github.com/Ic3b3rg/kestrel/issues/33)
- [pg-boss job API and transaction adapter](https://github.com/timgit/pg-boss/blob/master/docs/api/jobs.md)
- [Fastify reply and stream handling](https://fastify.dev/docs/latest/Reference/Reply/)
- [React TypeScript guidance](https://react.dev/learn/typescript)
- [Vite build guidance](https://vite.dev/guide/build.html)
- [MDN server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
