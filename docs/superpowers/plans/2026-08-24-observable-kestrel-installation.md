# Observable Kestrel Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver issue #34's first durable Kestrel path from PostgreSQL through Fastify, pg-boss,
replayable SSE, and the React PWA.

**Architecture:** Build an npm-workspace modular monolith with separate web, worker, and PWA
entrypoints sharing versioned Zod contracts and a node-postgres persistence package. PostgreSQL owns
Installation, diagnostic, event, and job state; Docker Compose supplies the development and
black-box release seam.

**Tech Stack:** Node 24, TypeScript, npm workspaces, Fastify, React/Vite, Zod, PostgreSQL,
node-postgres, pg-boss, Vitest, Playwright, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-24-observable-kestrel-installation-design.md`

## Global Constraints

- Use Node `24.18.1` in container images and PostgreSQL `18.6`; use no floating image tags.
- Pin npm dependencies exactly: Fastify `5.12.1`, `@fastify/static` `10.1.3`, React/React DOM
  `19.2.8`, Vite `8.2.2`, `@vitejs/plugin-react` `6.1.0`, `vite-plugin-pwa` `1.3.0`, Zod `4.4.3`, pg
  `8.23.0`, pg-boss `12.28.0`, and eventsource-parser `4.1.0`.
- Pin tooling exactly: TypeScript `6.0.3`, tsx `4.23.12`, Vitest `4.1.11`, Playwright `1.62.1`, axe
  Playwright `4.13.0`, ESLint `10.9.0`, `@eslint/js` `10.0.1`, typescript-eslint `8.67.0`, and
  Prettier `3.9.6`.
- Keep TypeScript strict, reject unknown public input fields, and introduce no ORM.
- Keep PostgreSQL as the only durable authority and enqueue the diagnostic job in the command
  transaction.
- Use decimal strings for every `bigint` crossing JSON or SSE.
- Cache only hashed static PWA shell assets; never cache API, SSE, commands, Installation data, or
  credentials.
- Keep Python research artifacts outside the V1 application and test toolchain.
- Do not implement authentication, Caddy, GitHub, Projects, Change Proposals, or review behavior.
- Treat `2996fe4` as the fixed implementation baseline; preserve unrelated untracked user files.

---

## File map

### Root and runtime

- `package.json`, `package-lock.json`: exact workspace dependency graph and commands.
- `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`: shared strict quality configuration.
- `.gitignore`, `.dockerignore`: exclude dependencies, secrets, build, coverage, and browser
  artifacts.
- `Dockerfile`: pinned Node build/development targets.
- `compose.yaml`, `compose.test.yaml`: persistent development stack and isolated black-box override.
- `scripts/docker-compose.mjs`: resolve Docker CLI, forward signals, and run Compose portably.

### Shared packages

- `packages/contracts/src/v1.ts`: authored Zod API/event/error schemas and inferred types.
- `packages/contracts/src/openapi.ts`: deterministic OpenAPI assembly.
- `packages/contracts/scripts/generate.ts`: committed JSON Schema/OpenAPI generation.
- `packages/contracts/generated/*.json`: stable generated artifacts.
- `packages/database/migrations/*.sql`: checksummed Kestrel schema evolution.
- `packages/database/src/config.ts`: validated database/release-profile configuration.
- `packages/database/src/migrate.ts`: advisory-locked SQL migration runner and pg-boss installation.
- `packages/database/src/installation.ts`: snapshot read and singleton bootstrap access.
- `packages/database/src/diagnostics.ts`: atomic command and monotonic worker transitions.
- `packages/database/src/events.ts`: append, prune, replay, cursor validation, and notification.
- `packages/database/src/pg-boss.ts`: Kestrel-owned pg-boss adapter and queue constants.

### Applications

- `apps/web/src/app.ts`: configured Fastify application.
- `apps/web/src/server.ts`: process lifecycle and graceful shutdown.
- `apps/web/src/routes/*.ts`: health, installation, diagnostic command, OpenAPI, and SSE routes.
- `apps/web/src/sse.ts`: SSE encoder and serial drain loop.
- `apps/worker/src/main.ts`: pg-boss worker lifecycle and diagnostic handler.
- `apps/pwa/src/api.ts`: snapshot/command client and fetch-based SSE stream.
- `apps/pwa/src/App.tsx`: accessible observable Installation screen.
- `apps/pwa/src/styles.css`: semantic responsive presentation.
- `apps/pwa/vite.config.ts`, `apps/pwa/index.html`, `apps/pwa/public/*`: build, manifest assets, and
  shell-only service worker configuration.

### Verification

- `tests/black-box/support/compose.ts`: isolated stack setup, discovery, restart, and cleanup.
- `tests/black-box/support/sse.ts`: standards-shaped SSE collection at the public wire seam.
- `tests/black-box/*.test.ts`: API, diagnostics, replay/retention, restart, and browser scenarios.
- `playwright.config.ts`, `vitest.config.ts`: deterministic test entrypoints.
- `README.md`: one-command development and verification instructions.

---

### Task 1: Persist and expose the Installation

**Files:**

- Create all root configuration/runtime files listed above.
- Create
  `packages/database/{package.json,tsconfig.json,migrations/001_installation.sql,src/config.ts,src/migrate.ts,src/pool.ts,src/installation.ts,src/index.ts}`.
- Create
  `apps/web/{package.json,tsconfig.json,src/app.ts,src/server.ts,src/routes/health.ts,src/routes/installation.ts}`.
- Create minimal bootable process entrypoints `apps/worker/src/main.ts` and `apps/pwa/src/main.tsx`
  so all four Compose services start.
- Test `tests/black-box/installation.test.ts` and support files.

**Interfaces:**

- Produces `createPool(databaseUrl: string): Pool`.
- Produces `migrate(pool: Pool, migrationsDirectory: URL): Promise<void>`.
- Produces `readInstallationSnapshot(pool: Pool): Promise<InstallationRow>`.
- Produces `buildApp(options: { pool: Pool; logger?: boolean }): Promise<FastifyInstance>`.

- [ ] **Step 1: Create workspace and exact dependency manifests**

Create npm workspaces for `apps/*`, `packages/*`, and `tests/*`; use exact versions from Global
Constraints and scripts `dev`, `build`, `typecheck`, `lint`, `format:check`, `test`,
`test:black-box`, `contracts:generate`, and `contracts:check`. Generate `package-lock.json` with
`npm install --save-exact` semantics.

- [ ] **Step 2: Write the first failing black-box test**

```ts
it("exposes the same persisted Installation across a web restart", async () => {
  const before = await getJson(`${stack.apiUrl}/api/v1/installation`);
  await stack.restart("web");
  const after = await getJson(`${stack.apiUrl}/api/v1/installation`);
  expect(after).toEqual(before);
});
```

- [ ] **Step 3: Run the test and verify red**

Run: `npm run test:black-box -- tests/black-box/installation.test.ts`

Expected: FAIL because Compose/application files or `/api/v1/installation` do not exist.

- [ ] **Step 4: Implement migration and Installation read path**

Migration `001_installation.sql` creates `schema_migrations`, `installations`, and one singleton
row. The migration runner uses `pg_advisory_xact_lock(hashtext('kestrel_schema_migrations'))`,
SHA-256 checksums, and rejects a changed applied migration. Fastify exposes `/health/live`,
`/health/ready`, and `/api/v1/installation`; JSON bigint values are strings.

```ts
export interface InstallationRow {
  id: string;
  state: "ready" | "diagnostic_queued" | "diagnostic_running" | "diagnostic_succeeded";
  currentDiagnosticId: string | null;
  revision: string;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 5: Run focused verification**

Run: `npm run typecheck && npm run test:black-box -- tests/black-box/installation.test.ts`

Expected: PASS; Docker restart preserves the row.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json eslint.config.js .prettierrc.json .gitignore .dockerignore Dockerfile compose.yaml compose.test.yaml scripts packages/database apps/web apps/worker apps/pwa tests/black-box/installation.test.ts tests/black-box/support vitest.config.ts
git commit -m "feat: expose a persisted Kestrel Installation"
```

---

### Task 2: Generate shared versioned contracts

**Files:**

- Create `packages/contracts/package.json`, `tsconfig.json`, `src/v1.ts`, `src/openapi.ts`,
  `src/index.ts`, `scripts/generate.ts`, and generated JSON.
- Create `packages/contracts/src/v1.test.ts`.
- Modify web Installation and health routes to use generated route schemas.

**Interfaces:**

- Produces `InstallationSnapshotSchema`, `DiagnosticAcceptedSchema`, `InstallationEventSchema`,
  `ApiErrorSchema`, `EventCursorSchema`.
- Produces `installationSnapshotJsonSchema`, `diagnosticAcceptedJsonSchema`, `apiErrorJsonSchema`,
  and `openApiDocument`.

- [ ] **Step 1: Write contract tests red-first**

```ts
it("rejects unsafe integer and unknown snapshot fields", () => {
  expect(() => EventCursorSchema.parse(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  expect(() => InstallationSnapshotSchema.parse({ ...exampleSnapshot, extra: true })).toThrow();
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- packages/contracts/src/v1.test.ts`

Expected: FAIL because the schemas are absent.

- [ ] **Step 3: Implement strict Zod schemas and deterministic generation**

```ts
export const EventCursorSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const InstallationStateSchema = z.enum([
  "ready",
  "diagnostic_queued",
  "diagnostic_running",
  "diagnostic_succeeded",
]);
export const InstallationSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  installation: InstallationSchema,
  diagnostic: DiagnosticSchema.nullable(),
  eventCursor: EventCursorSchema,
});
```

Use `z.toJSONSchema(schema, { target: "draft-2020-12" })`; construct OpenAPI `3.1.1` from those
schemas, sort object keys recursively, and write two-space JSON with a final newline and no
timestamps.

- [ ] **Step 4: Verify contracts and generation**

Run:
`npm run contracts:generate && npm test -- packages/contracts/src/v1.test.ts && npm run contracts:check && npm run typecheck`

Expected: PASS and a second generation produces no diff.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/web package.json package-lock.json
git commit -m "feat: generate versioned Installation contracts"
```

---

### Task 3: Execute a diagnostic through an atomic pg-boss command

**Files:**

- Create `packages/database/migrations/002_diagnostics_and_events.sql`.
- Create `packages/database/src/diagnostics.ts`, `events.ts`, `pg-boss.ts` and tests.
- Create `apps/web/src/routes/diagnostics.ts`.
- Replace the minimal worker entrypoint with `apps/worker/src/main.ts` and
  `src/process-diagnostic.ts`.
- Create `tests/black-box/diagnostic.test.ts`.

**Interfaces:**

- Produces `enqueueDiagnostic(pool, boss, retentionLimit): Promise<DiagnosticAccepted>`.
- Produces
  `transitionDiagnostic(pool, diagnosticId, nextStatus, retentionLimit): Promise<InstallationEvent | null>`.
- Produces `createPgBoss(options): PgBoss` and `DIAGNOSTIC_QUEUE = "installation-diagnostic-v1"`.

- [ ] **Step 1: Write the public failing diagnostic test**

```ts
it("commits the command, runs the worker, and exposes success", async () => {
  const accepted = await postJson<DiagnosticAccepted>(
    `${stack.apiUrl}/api/v1/installation/diagnostics`,
    {},
  );
  expect(accepted.diagnostic.status).toBe("queued");
  await expect
    .poll(() => readSnapshot(stack.apiUrl))
    .toMatchObject({
      diagnostic: { id: accepted.diagnostic.id, status: "succeeded" },
    });
});
```

- [ ] **Step 2: Verify red**

Run: `npm run test:black-box -- tests/black-box/diagnostic.test.ts`

Expected: FAIL with 404 for the command route.

- [ ] **Step 3: Implement the atomic command**

Within one `pg.Client` transaction, lock the singleton row, insert diagnostic, update Installation,
append/prune event, call
`boss.send(DIAGNOSTIC_QUEUE, { diagnosticId }, { id: diagnosticId, db: clientAdapter })`, notify,
and commit. Configure the web pg-boss instance with `supervise: false`, `schedule: false`, and
`migrate: false` after the migration service installs schema and queue.

```ts
export interface TransactionDatabase {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}
```

- [ ] **Step 4: Implement idempotent worker transitions**

Update only allowed source states and append an event only when `UPDATE ... RETURNING` changed a
row. A retry of `succeeded` returns `null` and completes without another event.

- [ ] **Step 5: Verify diagnostic slice**

Run:
`npm run typecheck && npm test -- packages/database/src/diagnostics.test.ts && npm run test:black-box -- tests/black-box/diagnostic.test.ts`

Expected: PASS, including a worker restart during a queued diagnostic.

- [ ] **Step 6: Commit**

```bash
git add packages/database apps/web apps/worker tests/black-box/diagnostic.test.ts
git commit -m "feat: run durable Installation diagnostics"
```

---

### Task 4: Replay ordered Installation events over SSE

**Files:**

- Create `apps/web/src/sse.ts`, `apps/web/src/routes/events.ts`, and focused tests.
- Extend `packages/database/src/events.ts` with `validateCursor`, `readEventsAfter`, and stream
  metadata reads.
- Create `tests/black-box/events.test.ts` and `tests/black-box/support/sse.ts`.

**Interfaces:**

- Produces `encodeSseEvent(event: InstallationEvent): string`.
- Produces
  `validateCursor(pool, cursor): Promise<{ valid: true } | { valid: false; firstAvailable: string }>`.
- Produces `readEventsAfter(pool, cursor, limit): Promise<InstallationEvent[]>`.

- [ ] **Step 1: Write replay and expiry tests**

```ts
it("replays only events after Last-Event-ID in ascending order", async () => {
  const all = await runDiagnosticsAndCollectEvents(3);
  const replay = await collectSse({ lastEventId: all[1].id, count: all.length - 2 });
  expect(replay.map(({ id }) => id)).toEqual(all.slice(2).map(({ id }) => id));
});

it("requires refetch when the cursor predates retention", async () => {
  const response = await fetch(`${stack.apiUrl}/api/v1/events`, {
    headers: { Accept: "text/event-stream", "Last-Event-ID": "1" },
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: "EVENT_CURSOR_EXPIRED",
    refetch: "/api/v1/installation",
  });
});
```

- [ ] **Step 2: Verify red**

Run: `npm run test:black-box -- tests/black-box/events.test.ts`

Expected: FAIL with 404 for `/api/v1/events`.

- [ ] **Step 3: Implement standards-shaped SSE**

Validate before headers, acquire a dedicated listener connection, `LISTEN kestrel_events`, validate
again, hijack the reply, drain rows in ascending order, and serialize drains through one promise
chain. Notifications and a 1-second fallback poll call the same drain; 15-second comments keep the
stream alive. On close, clear timers, remove listeners, `UNLISTEN`, and release the connection.

```ts
export function encodeSseEvent(event: InstallationEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
```

- [ ] **Step 4: Verify focused and black-box behavior**

Run:
`npm test -- apps/web/src/sse.test.ts && npm run test:black-box -- tests/black-box/events.test.ts && npm run typecheck`

Expected: PASS with no duplicates, gaps, or leaked listener connections.

- [ ] **Step 5: Commit**

```bash
git add apps/web packages/database tests/black-box/events.test.ts tests/black-box/support/sse.ts
git commit -m "feat: replay Installation events over SSE"
```

---

### Task 5: Observe diagnostics in the accessible PWA

**Files:**

- Create full `apps/pwa` package files, `src/api.ts`, `src/App.tsx`, `src/main.tsx`,
  `src/styles.css`, `src/api.test.ts`, `vite.config.ts`, `index.html`, and SVG icons.
- Create `playwright.config.ts` and `tests/black-box/pwa.spec.ts`.
- Modify web to serve `apps/pwa/dist` in production mode.

**Interfaces:**

- Produces `fetchInstallation(signal?): Promise<InstallationSnapshot>`.
- Produces `runDiagnostic(signal?): Promise<DiagnosticAccepted>`.
- Produces `streamInstallationEvents({ after, signal, onEvent, onCursorExpired }): Promise<void>`.

- [ ] **Step 1: Write the failing real-browser test**

```ts
test("the Operator runs and observes a diagnostic", async ({ page }) => {
  await page.goto(stack.pwaUrl);
  await expect(page.getByRole("heading", { name: "Kestrel Installation" })).toBeVisible();
  await page.getByRole("button", { name: "Run diagnostic" }).click();
  await expect(page.getByText("Succeeded", { exact: true })).toBeVisible();
  expect(await new AxeBuilder({ page }).analyze()).toMatchObject({ violations: [] });
});
```

- [ ] **Step 2: Verify red**

Run: `npm run test:browser -- tests/black-box/pwa.spec.ts`

Expected: FAIL because the PWA screen does not exist.

- [ ] **Step 3: Implement API and fetch-based SSE client**

Parse every HTTP body and SSE `data` record through shared Zod schemas. Reconnect from the last
confirmed cursor with bounded backoff; a typed 409 invokes full snapshot refetch. Abort old streams
during refetch and component unmount.

- [ ] **Step 4: Implement the single responsive screen**

Use one `main`, one `h1`, definition lists for Installation/diagnostic facts, a native button,
text-plus-dot connection status, and `role="status" aria-live="polite"` for transitions. Hide
product data and disable commands while offline. Use CSS custom properties, a 0.25rem spacing scale,
visible `:focus-visible`, 44px minimum controls, responsive wrapping, and reduced-motion media
rules.

- [ ] **Step 5: Configure shell-only PWA caching**

Use
`VitePWA({ registerType: "autoUpdate", workbox: { navigateFallbackDenylist: [/^\/api\//], runtimeCaching: [] } })`;
precache only generated hashed assets and the static navigation shell. Add a same-origin manifest
and SVG icons without external requests.

- [ ] **Step 6: Verify UI and build**

Run:
`npm test -- apps/pwa/src/api.test.ts && npm run test:browser -- tests/black-box/pwa.spec.ts && npm run build && npm run typecheck`

Expected: PASS at 320, 768, 1024, and 1440 widths; no axe violations or console errors.

- [ ] **Step 7: Commit**

```bash
git add apps/pwa apps/web playwright.config.ts tests/black-box/pwa.spec.ts package.json package-lock.json
git commit -m "feat: observe Installation diagnostics in the PWA"
```

---

### Task 6: Certify restart, generation, and developer workflow

**Files:**

- Create `tests/black-box/restart.test.ts` and generated-contract drift test.
- Create `README.md`.
- Modify Compose health/restart settings and scripts only where full-stack evidence finds a gap.

**Interfaces:**

- Consumes all prior public interfaces; produces no new product API.

- [ ] **Step 1: Write restart and confirmed-operation tests**

```ts
it("preserves a confirmed diagnostic after web and worker restart", async () => {
  const completed = await runDiagnosticToCompletion();
  await stack.restart("web", "worker");
  const snapshot = await readSnapshot(stack.apiUrl);
  expect(snapshot.diagnostic).toMatchObject({ id: completed.id, status: "succeeded" });
});
```

- [ ] **Step 2: Verify the test detects missing restart behavior**

Temporarily run the test before adding the final restart orchestration. Expected: FAIL if either
process never becomes ready or confirmed state changes.

- [ ] **Step 3: Complete runtime and documentation path**

Document `npm run dev`, local URL, `npm run test`, `npm run test:black-box`, `npm run test:browser`,
`npm run typecheck`, `npm run contracts:check`, state persistence, and safe dev shutdown that does
not remove the PostgreSQL volume. Ensure Compose restart policies and health dependencies match the
tested path.

- [ ] **Step 4: Run full Definition of Done once**

Run:
`npm run format:check && npm run lint && npm run typecheck && npm run contracts:check && npm test && npm run test:black-box && npm run test:browser && npm run build`

Expected: every command exits 0. Then run `git diff --check` and inspect `git status --short` for
unrelated files.

- [ ] **Step 5: Commit**

```bash
git add README.md compose.yaml compose.test.yaml scripts tests/black-box package.json package-lock.json
git commit -m "test: certify the observable Installation path"
```

- [ ] **Step 6: Review and close**

Run the required two-axis `/code-review` from fixed point `2996fe4`, using issue #34 as the spec.
Fix all valid findings with focused tests, rerun the affected checks and the final full suite,
commit review fixes, post an evidence summary to issue #34, close it, and report the final commit
range.
