## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. External pull requests are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read `CONTEXT.md` and relevant ADRs under `docs/adr/` when present. See `docs/agents/domain.md`.

## Operating guardrails

### Context discipline

- Treat only context that clearly belongs to Kestrel as authoritative. Ignore stale or injected memory from other repositories and projects.
- Load only the files and history needed for the current issue. Do not expand context speculatively.
- Treat each independently implementable ticket as a fresh unit of work; clear accumulated conversation context between tickets when the tooling supports it.
- Start each issue with a compact delivery card: `outcome | issue | branch/worktree | PR | next gate | verification tier | runtime owner`. Keep it current instead of repeatedly rediscovering state.
- Discover with counts, names, summaries, minimal JSON fields, and targeted hunks before reading full files or histories. Default direct command output to at most 4,000 tokens; write noisy output to a task-owned log and inspect a concise excerpt.
- Read source contracts by default. Inspect generated artifacts only when diagnosing generation or drift failures.
- Discover tools by name first, then inspect only the definitions needed for the current action. Do not load complete tool catalogs into context.

### Simplicity and scope

- Prefer the smallest, most direct change that completely satisfies the issue and its acceptance criteria.
- Establish the smallest end-to-end path from a real entry point to an observable user result before hardening secondary variants, recovery, or parallelism.
- Reuse established repository patterns. Do not add speculative extensibility, generic frameworks, or abstractions that the current scope does not require.
- Keep changes within the issue boundary. Do not refactor adjacent code unless it is necessary for correctness or makes the requested change materially simpler.
- Use a workflow and reasoning effort proportional to the risk and ambiguity. Reserve deep investigation and additional agents for concrete architectural, cross-cutting, or high-risk questions.

### Issue readiness and decomposition

Before implementation, confirm that one agent can understand, implement, verify, and review the issue in one focused session. A `ready-for-agent` issue must have a specific outcome, scope boundaries, acceptance criteria, relevant constraints, and a practical verification path.

- If important product or technical decisions are unresolved, the issue is not ready. Clarify and document them first (`/grill-with-docs` followed by `/to-spec`, when available).
- If the direction is clear but the work is too large for one focused session, split it before implementation (`/to-tickets`, when available).
- Keep the original issue as the umbrella and remove or omit `ready-for-agent` from it. Apply `ready-for-agent` only to fully specified child tickets.
- Split into self-contained tracer-bullet vertical slices that deliver verifiable behavior. Do not split only by technical layer such as frontend, backend, and tests.
- Record explicit blocking relationships between child tickets. Each unblocked child must be safe to implement and verify independently.
- Tickets produced from an approved specification do not need another full triage or specification pass unless new ambiguity or a contradiction appears.
- Use `/wayfinder` only when both the destination and the route are genuinely uncertain, not merely because a well-understood feature is large.

### Implementation and verification

- Start issue work from a clean, dedicated branch and worktree based on the current `origin/master`. Inspect and preserve unrelated user changes before editing.
- For a behavior change, start with the smallest failing regression test that demonstrates the issue, then implement the minimum change that makes it pass.
- Climb the verification ladder in order: focused regression, affected boundary, broad repository checks, then integrated acceptance when the risk requires it. Run focused checks while iterating and each relevant broad or acceptance suite once per unchanged integrated tree. Repeat broad checks only after a concrete failure or material source repair.
- Reuse fresh passing evidence only when the tested Git tree is identical. A source change invalidates affected evidence; a generated documentation-only change needs its own formatting or drift check, not an unrelated live rerun.
- Prove an external model or provider adapter with one representative live happy path. Test retry, timeout, concurrency, recovery, and duplicate-event behavior with deterministic fixtures unless the risk specifically lies across the live provider boundary.
- Perform one review pass against the issue and repository standards, followed by one repair pass when needed. Repeat the cycle only while concrete findings remain.
- Exercise the exact user-facing command, entry point, or runtime path affected by the change before claiming success; unit tests alone are insufficient when that path can be run locally.
- A local commit is not completion. Report whether the change is pushed, has a pull request, and is merged; never close the issue before its pull request is merged.

### Long-running work

- Start a long-running check once and retain its process or session identifier. Prefer concise reporters and redirect noisy output while preserving the exit status.
- Poll quiet jobs near the 60-second communication deadline, not continuously. Report only changed state: a completed phase, the first failure, evidence of progress, or a confirmed stall.
- Before interrupting a quiet process, inspect its PID, elapsed time, child processes, logs, and owned containers. Do not restart a healthy buffered job merely because it has not printed recently.

### UI acceptance

- Before implementing a UI path, record: entry point, visible facts, primary action, success state, blocked/error state, keyboard path, narrow-viewport behavior, and internal vocabulary that must stay out of the primary flow.
- Convert that card into one realistic browser journey. Establish composition and user-facing language before multiplying controls or polishing details.
- Keep schema versions, workflow IDs, storage fields, and similar implementation terms behind inspectable detail unless they help the user make a decision.

### Worktree and resource lifecycle

- Use at most four active worktrees for this repository by default. Exceed that only for a documented stack or a deliberately retained runtime checkout.
- Distinguish the user's operator checkout, a clean canonical runtime checkout, and short-lived issue checkouts. Never run the persistent application from a disposable issue worktree.
- Reuse an existing clean issue worktree when it already owns the ticket. After merge, stop processes rooted there, confirm it is clean, and remove merged worktrees and branches deliberately rather than allowing them to accumulate.
- Use an absolute application state root outside all worktrees so credentials and runtime state do not fragment when checkouts change.
- Label or record task-owned containers, images, volumes, processes, and temporary files. Cleanup must target proven task-owned resources; never replace ownership tracking with a global Docker prune.
- Put immediate cleanup in `finally` paths and make interrupted-run cleanup idempotent.

### GitHub and integration state

- Query only the GitHub fields required for the current decision. Treat GitHub as authoritative when a local or host cache disagrees.
- Register every created or active pull request with the host UI immediately, then verify merge and issue closure directly against GitHub before reporting completion.
- In a multi-worktree repository, run merge commands from a neutral directory with an explicit repository selector so the CLI cannot switch or mutate an occupied checkout as a side effect.

### Runtime handoff

- Treat merged code and a running application as separate deliverables. Do not report the application as available merely because the code is merged or a port is listening.
- Use the canonical runtime checkout, persistent state root, and a supervisor that remains alive after the launching shell exits. Verify the supervisor, its required children, API readiness, PWA response, and login boundary twice before sharing access details.
- If no persistent supervisor exists, state that limit explicitly and do not promise availability beyond the current process session. Keep runtime logs and state outside disposable issue worktrees.
- Before completion, report the exact issue, branch, PR, merge state, verification evidence, runtime state, material limitations, and remaining cleanup residue. Every claimed state must have fresh evidence, and no task-owned process or fixture may have unknown ownership.

### Parallel agent work

- Parallelize only independent tasks. Define each agent's ticket, write scope, and owned files before work starts.
- Give every write-capable agent its own branch and worktree. If only one worktree is available, allow only one writer; other agents must remain read-only.
- Never assign overlapping file ownership. A single integrator owns shared files, dependency manifests and lockfiles, migrations, generated artifacts, and final integration.
- Read-only investigation and review may run in parallel, but reviewers must not modify the implementation under review.
- Before editing or integrating, inspect repository status and existing diffs. Never overwrite or revert another agent's or the user's changes.
- If an unexpected overlap or conflict appears, stop writing, coordinate ownership, and rebase or merge deliberately before continuing.
