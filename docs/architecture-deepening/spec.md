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
