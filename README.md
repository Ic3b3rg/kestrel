# Kestrel

This repository currently contains the first observable Kestrel Installation path: one persisted
Installation, a durable diagnostic command, ordered server-sent events, and a React PWA that shows
the result. PostgreSQL is the only durable authority.

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

Open [http://localhost:5173](http://localhost:5173). The API and the production-shaped compiled PWA
are also available at [http://localhost:3000](http://localhost:3000).

The Compose ports bind only to loopback. This slice intentionally has no authentication or TLS, so
do not expose it to an untrusted network.

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

The PWA reads `GET /api/v1/installation`, opens `GET /api/v1/events`, and submits
`POST /api/v1/installation/diagnostics`. A successful command commits the Installation transition,
durable event, and pg-boss job in one PostgreSQL transaction. The worker advances the diagnostic
monotonically from queued to running to succeeded. The PWA reconnects from its last confirmed event
cursor and performs a full snapshot refetch when retained history has expired.

Useful endpoints on port 3000:

- `/health/live` — process liveness;
- `/health/ready` — database-backed readiness;
- `/api/v1/installation` — authoritative snapshot;
- `/api/v1/events` — replayable SSE stream;
- `/api/v1/openapi.json` — generated OpenAPI 3.1 contract.

Application and worker logs are structured JSON. Installation and diagnostic identifiers appear in
transition logs; database credentials and request bodies do not.

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
their test volumes afterward. `npm run test:browser` drives the diagnostic through Chromium, checks
keyboard and offline behavior, audits accessibility with axe, and verifies 320, 768, 1024, and 1440
CSS-pixel viewports.

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

Authentication, TLS/Caddy, repository-provider connections, Projects, Change Proposals, and review
workflows are delivered by later issues rather than this tracer bullet.
