# Architecture deepening delivery

The September 21 architecture review and detailed handoff authorize seven module improvements. The
September 23 implementation request authorizes research to settle technical choices, asking the
Operator only for consequential unresolved decisions. Preserve the behavior and authority defined by
`CONTEXT.md` and ADRs 0003/0004.

## Delivery order and boundaries

1. **Sandbox lifecycle:** one per-Agent Run session owns checkout custody, durable container
   witnesses, checkpoint ordering, exact verification, redaction and restart reconciliation.
   Processor code sees revision facts and results. Preserve one independent cumulative Feature
   checkout and fresh disposable containers.
2. **Durable Agent Run transitions:** concentrate shared terminal transitions used by live
   processing and recovery; retain transactions, lock order, late-owner rejection, Human Gate
   semantics and append-only activity. Do not create generic repositories or erase distinct domain
   entities. Depends on 1.
3. **Factory background runtime:** one composition module constructs processors, registers
   consumers, reconciles before intake, schedules non-overlapping repairs and drains work in order.
   Keep the current web placement. Depends on 2.
4. **Feature Plan graph:** use one domain projection for validation, dependency readiness,
   terminal/blocking facts and board state. PostgreSQL scheduling still enforces reservations
   atomically; external issues never confer plan authority.
5. **Codex adapter:** one bounded stdio protocol/process implementation for connection, planning and
   execution. Preserve separate route policies, stable error translation, cancellation, correlation,
   byte bounds and version validation. Depends on 1.
6. **Project Board read:** one authenticated snapshot owns joins, deduplication, provider bounds,
   provenance and partial failures. PWA uses one read, retains useful state offline and rejects
   stale responses after navigation. Depends on 4.
7. **Settings ownership:** preserve the now-merged #253–256 and #274–277 behavior; finish any
   remaining data/command ownership in route modules. Global settings require no Project selection;
   Project settings restore their scope from the URL.

### Settings route boundary

The global Settings route composes its sections and owns the Profile credential command, error state
and cancellation on offline or route disposal. The shell retains session invalidation and
coordinates mutual exclusion with sign-out. Global sections work without a selected Project. The
Project Settings route selects the exact URL-scoped Project and owns its loading, unavailable and
missing states. Existing provider, repository, Skills and Direct API panels retain their reads and
commands. The shared Project inbox stays in the shell for sidebar and other routes; Settings
consumes that observation and requests refresh after changes without another fetch layer.

Each item is a separate issue and reviewable PR. Complete blockers first; no unrelated roadmap
behavior is included. A child is ready only with acceptance criteria and a practical test path.
Update the delivery record with exact evidence and GitHub state.

## Sandbox contract

The existing processor, contained runtime, local-source workspace and database recovery test
boundaries are the accepted regression seams from the handoff. Extend them instead of creating a
competing harness. The new public Sandbox boundary must demonstrate rejection of overlapping writers
and unsafe checkpoint ordering.

- Opening checks the exact approved source, retained checkpoint and documents.
- Starting any container requires one durable reservation and an immutable identity. Mark in-memory
  intent before awaiting persistence, so concurrent callbacks and an uncertain acknowledgement
  cannot create a second writer or grant stop proof.
- A completed implementation returns text for the processor's existing policy parser. Only accepted
  completion can proceed to a controller-created checkpoint.
- Verification executes exact approved argv against that checkpoint, stores bounded evidence even on
  failure, checks source integrity and proves container teardown.
- Aborted execution never succeeds. Unknown teardown retains reservation, including when a callback
  or database operation fails after its side effect.
- Recovery proves the same daemon/container identity, uses the existing inert barrier for absent
  reserved names, and performs no runtime replay. Repeating it is safe.
- The public interface does not expose checkout paths or container callbacks. Model selection,
  prompts, Work Item eligibility, merge and Human Gates remain outside.

## Agent Run transition contract

The persistence ledger owns three named terminal operations: live completion, orphan interruption
and confirmed recovery. Callers acquire the Feature lock before the Run lock and reject stale owners
before entering the ledger. Exact verification proof and certificate creation share that transaction
with Run, Work Item, Feature, correction, Human Gate and activity updates. Container probes stay
outside database transactions; recovery enters only after the persisted stop fence and proof.

These operations share dependent-state rules without erasing their different facts. Live completion
records its completion time and replaces a correction certificate; recovery preserves the original
completion time and certificate. An interruption records the stop request before probing. Gate
answers, correction publication and provider-confirmed merge retain their distinct authority and
existing entry points.

## Factory background lifecycle

The web host configures services and owns HTTP and shared database pools. Its Factory background
runtime owns processor construction, pg-boss consumers, startup repair, periodic reconciliation and
shutdown. Startup completes all durable repairs before registering consumers. Each repair has at
most one in-flight invocation; each queue retains its existing options and one registration.

Shutdown stops timers and cancels interruptible processing immediately, prevents startup from
opening new intake, and drains registered consumers, processors and all repairs (including issue
publication) before closing pg-boss. Non-interruptible rendering drains under its existing provider
deadline. HTTP drains concurrently, and the host closes shared pools only afterward. Repeated
start/stop calls cannot duplicate consumers or disposal. No module import starts a process or timer.

## Feature Plan graph

One pure projection validates the approved document through the existing canonical validator and
combines it with persisted Work Item facts. It owns dependency satisfaction, ordered eligibility,
blocking precedence and the complete-verification projection. Verification unlocks dependents;
Completed remains a persisted result of confirmed merge, never an inference from closed tracker
issues or passed tests. Human Gates and cancellation retain their existing precedence and wording.

Scheduler and board use the same projection. Scheduling still holds its advisory and Feature locks,
checks aggregate publication, reservations, prior attempts and Human Gate resolution, and creates
runs transactionally. Aggregate publication proves every Work Item publication in one transaction;
the board can also expose partial publication. Exact source, command and certificate proof stays in
the execution ledger and verification boundary. The graph grants no writer or merge authority.

## Codex App Server adapter

Connection inspection, planning and execution share one bounded JSONL transport and process
lifecycle. It correlates client responses independently from server requests, decodes split UTF-8,
filters the inherited environment and owns cancellation, timeout and process-group cleanup. The
connection and turn profiles preserve their existing byte limits, stop deadlines and error
translation. Response schemas and supported-version checks belong to the calling runtime; malformed
initialization must still produce the connection's protocol remediation state.

The adapter grants no tool authority. Inspection rejects server requests, planning retains its
read-only policy, execution retains its external containment checks and review remains non-writable.
Closing the App Server proves only its process outcome; Sandbox teardown remains the separate proof
required before checkpointing or releasing a writer reservation.

## Project Board snapshot

One authenticated Project read owns the local planning/Work Item join and the bounded GitHub
catalog. Local facts are read in one read-only repeatable-read transaction, without activity bodies
that the Project cards do not show. They retain the canonical Project scope and shared graph rules.
The backend removes provider duplicates and linked issues; a closed provider issue cannot complete a
Work Item. Cards carry their origin and exact Feature navigation scope.

Provider catalog reads identify before the bounded scan, verify identity once afterward, fetch at
most five pages, and have one ten-second deadline. A bounded 32-Project in-memory catalog refreshes
after 30 seconds or an explicit refresh; it is a disposable observation cache, never workflow
authority. Failed refreshes retain known issues, with separate attempt/success timestamps, failure
and truncation facts. Cancellation cannot install a late result. No database transaction is held
across provider work.

The browser performs one snapshot read, polls only after it settles, retains same-Project cards
offline or on read failure, and aborts reads/timers when its route changes. Existing card language,
actions, keyboard behavior and narrow layout remain intact; retained provider data is disclosed.

## Verification and integration

Use a smallest failing behavior test before each behavior change. Run focused tests while iterating,
affected-boundary checks next, and formatting, lint, typecheck, full tests and build once per
integrated source tree. Exercise the exact Factory runtime entry point; use real PostgreSQL for
atomicity and deterministic runtime fixtures for failure races. The transport change requires one
representative live Codex happy path. Board/Settings require realistic browser journeys at desktop
and narrow widths.

Review Standards and Spec separately, repair concrete findings, commit, push, register each PR with
the host and confirm merge/closure directly on GitHub. Runtime deployment is separate from merged
code; do not replace the running installation incidentally.

## Worktree ownership

The operator checkout was clean at `f70dfa0`; current `origin/master` is `9e6c846`. #259 and the
Settings/Skills tickets are already merged. Seven preexisting checkouts remain on disk, including a
supervised runtime and deliberately retained prototypes and research. Their ownership is unrelated
to this task, so they are preserved. The temporary architecture implementation/research stack is an
explicit exception to the four-worktree default. The integrator alone owns source and
shared/generated files; the researcher owns only `docs/research/architecture-deepening.md` in its
own checkout. Remove these task-owned worktrees after their changes are integrated and clean. Logs
live under `/tmp/kestrel-architecture-20260923`; fixtures must clean up in `finally`.
