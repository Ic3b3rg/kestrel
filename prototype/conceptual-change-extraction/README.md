# PROTOTYPE — Lightweight Conceptual Review

Throwaway UI prototype for
[Validate conceptual change extraction on real pull requests](https://github.com/Ic3b3rg/kestrel/issues/9).

## Question

Can Kestrel orient an Operator before the real review with one lightweight,
full-screen map that answers only three questions?

1. What does the pull request say it changes?
2. Which flows and code areas are probably involved?
3. What should the Operator verify when starting the code review?

The prototype deliberately does **not** show Findings, Evidence sufficiency,
risk levels, verified relationships, or a verdict. Those belong to the later
code-review phase.

## Tested sequence

1. The Operator sees a list of real pull requests.
2. Selecting one explicitly requests its Conceptual Review; no AI work is
   implied merely by opening the inbox.
3. Kestrel presents a preliminary map, a summary of the PR description, and a
   review checklist.
4. **Avvia review del codice** marks the boundary with the deeper review. That
   phase is intentionally outside this prototype.

This converges on the full-screen map selected during the first HITL round. It
replaces the earlier three-variant experiment because that version mixed
orientation with conclusions that should only exist after code review.

## Run

From the repository root:

```sh
python3 -m http.server 4174 --directory prototype/conceptual-change-extraction
```

Then open the inbox:

<http://127.0.0.1:4174/?view=inbox>

A Conceptual Review has a stable URL, for example:

<http://127.0.0.1:4174/?view=concept&case=small-behavior>

Everything is read-only and runs in the browser.

## Real cases

- [cli/cli: Add `gh uptime`](https://github.com/cli/cli/pull/14094) — a small,
  behavior-rich change.
- [cli/cli: Honour `api_host` across the CLI](https://github.com/cli/cli/pull/14104)
  — a large cross-cutting draft with 66 changed files.
- [github/docs: Remove reference to `rebase-strategy`](https://github.com/github/docs/pull/40756)
  — a documentation-only change used to test honest Graph abstention.

Fixtures are bound to the exact base/head pair recorded in each JSON file. To
refresh them intentionally, with GitHub CLI authentication available:

```sh
python3 prototype/conceptual-change-extraction/capture_fixtures.py
```

Refreshing changes the experiment and should create a new captured prototype
revision rather than silently replacing the evidence behind an old verdict.

## Deliberate limits

- The page represents the state after the Operator requests a Conceptual
  Review; generation latency and provider choice are not prototyped.
- The map is orientative. Every flow and code area remains explicitly marked
  for verification in the real review.
- Repository context is shallow and the interpretive copy was produced during
  one agent session, not from independent Model Provider samples.
- Provider checks are not presented because this phase must not imply that the
  implementation has already been reviewed.
