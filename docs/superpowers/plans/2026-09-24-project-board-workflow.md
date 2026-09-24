# Project board workflow implementation plan

> Execute inline using `superpowers:executing-plans`; the user approved the specification and implementation.

**Goal:** Retain readable issues and start their sequential development directly from the Project board.
**Architecture:** Persist provider observations independently from workflow authority. A durable issue-start
request bridges the drop to the existing planning, publication, execution and review lifecycle.
**Tech stack:** TypeScript, React, Fastify, Zod, PostgreSQL, pg-boss, gh CLI.
**Spec:** `docs/factory-v01/project-board-workflow.md`.

## Constraints and ownership

Only this worktree/branch is writable. No new issue. No shared-runtime restart. Preserve provider
identity validation, session/CSRF checks, sandbox isolation and the exact-revision merge boundary.
Use existing API/service/DB/component test boundaries; tests precede behavior changes.

## Delivery slices

- [ ] Durable reading: adapter labels/comments, database observations/settings, stale-while-refresh
  board and detail routes; tests prove restart retention, refresh coalescing and throttle backoff.
- [ ] Direct start: idempotent authorization and issue queue, current context at dispatch, reuse
  generated plans and execution; tests prove eligibility, duplicate suppression and retained context.
- [ ] Review releases queue: scheduler excludes reviews from implementation serialization while
  retaining active reservation and gate protection; regression proves next issue can proceed.
- [ ] Board interaction: stable refresh, labels/count, internal reader, drag/drop and equivalent
  Start button; project label settings; component and browser acceptance.
- [ ] Integration: typecheck, contracts drift, relevant boundary suites, full unit suite once,
  isolated browser acceptance, two-axis code review, repair concrete findings, local commit.

## Review focus

Account/repository changes must not expose observations from another identity. Concurrent refresh
must not duplicate provider calls. Repeated drops must not duplicate Features. A failed or ambiguous
plan must not execute. An implementation waiting for review must not starve the next queued issue.

## Progress

- Baseline: current runtime tree `1c55791`; prior focused board suite 23 passing.
- Reused research worktree, branch `feat/project-board-workflow`; other sessions own composer and
  repository-guidance worktrees. Dependency install hit ENOSPC; only own partial install removed.
