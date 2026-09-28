# Project board workflow implementation plan

> Execute inline using `superpowers:executing-plans`; the user approved the specification and
> implementation.

**Goal:** Retain readable issues and start their sequential development directly from the Project
board. **Architecture:** Persist provider observations independently from workflow authority. A
durable issue-start request bridges the drop to the existing planning, publication, execution and
review lifecycle. **Tech stack:** TypeScript, React, Fastify, Zod, PostgreSQL, pg-boss, gh CLI.
**Spec:** `docs/factory-v01/project-board-workflow.md`.

## Constraints and ownership

Only this worktree/branch is writable. No new issue. No shared-runtime restart. Preserve provider
identity validation, session/CSRF checks, sandbox isolation and the exact-revision merge boundary.
Use existing API/service/DB/component test boundaries; tests precede behavior changes.

## Delivery slices

- [x] Durable reading: adapter labels/comments, database observations/settings, stale-while-refresh
      board and detail routes; tests prove restart retention, refresh coalescing and throttle
      backoff.
- [x] Direct start: idempotent authorization and issue queue, current context at dispatch, reuse
      generated plans and execution; tests prove eligibility, duplicate suppression and retained
      context.
- [x] Review releases queue: scheduler excludes reviews from implementation serialization while
      retaining active reservation and gate protection; regression proves next issue can proceed.
- [x] Board interaction: stable refresh, labels/count, internal reader, drag/drop and equivalent
      Start button; project label settings; component and browser acceptance.
- [x] Integration: typecheck, contracts drift, relevant boundary suites, full unit suite once,
      isolated browser acceptance, two-axis code review, repair concrete findings, local commit.

## Review focus

Account/repository changes must not expose observations from another identity. Concurrent refresh
must not duplicate provider calls. Repeated drops must not duplicate Features. A failed or ambiguous
plan must not execute. An implementation waiting for review must not starve the next queued issue.

## Progress

- Baseline: current runtime tree `1c55791`; prior focused board suite 23 passing.
- Reused research worktree, branch `feat/project-board-workflow`; other sessions own composer and
  repository-guidance worktrees. Dependency install hit ENOSPC; only own partial install removed.

## Verification and handoff — 2026-09-28

- Integrated the New plan composer and repository guidance from `c63b2ed`. Board migration is
  `039_project_issue_board.sql`, following the composer's migration 038.
- Full unit suite: 158 files passed, six skipped; 1,439 tests passed, seven skipped. The initial
  unrestricted parallel run hit five existing Git-test timeouts; those passed with one worker, and
  the final full run passed with two workers without increasing test timeouts.
- Typecheck, ESLint, contracts drift and changed-file formatting passed.
- Real Chromium journey: issue description/comments, escaped provider text, drag/drop, saved queued
  card after reload, cancel/restart with a new authorization ID, narrow keyboard use and axe checks.
- Dedicated PostgreSQL 18 container: all migrations, retained observations/settings across
  connection reopening, concurrent request deduplication, eligibility, cancel/restart, retained
  execution context, Project queue fairness beyond 200 entries, and release at review. Container
  removed in `finally`.
- Real GitHub read: closed issue #302 description retrieved through the new discussion adapter.
  Paginated nonempty discussions are covered with the deterministic gh CLI fixture.
- Spec review: repaired cancelled-command UUID reuse. Standards review: repaired correction writer
  collisions and the global queue cutoff. Targeted re-review found no remaining material issue.
- Runtime and other worktrees were not changed. Tests used the reachable default Docker socket
  explicitly, leaving the user's selected Docker context untouched. No new tracker issue was
  created.
