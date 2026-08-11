# PROTOTYPE — Conceptual change extraction

Throwaway logic prototype for
[Validate conceptual change extraction on real pull requests](https://github.com/Ic3b3rg/kestrel/issues/9).

## Question

Can a disposable pipeline turn real pull-request descriptions, exact-revision
diffs, comments, shallow repository context, and provider test evidence into a
stable conceptual model and a useful behavioral Graph? Where must it abstain or
declare partial coverage?

This prototype deliberately separates four things:

1. immutable, offline GitHub fixtures;
2. a deterministic Evidence registry;
3. two recorded interpretive extraction passes, treated as untrusted data; and
4. deterministic validation, Graph identity reconciliation, and failure reporting.

The two recorded passes are interpretive drafts produced during this agent
session, not independent or reproducible model samples. The second pass
deliberately introduces plausible phrasing changes, node splits/merges, and one
unsupported Graph so those failure modes are concrete enough to inspect. This
tests the stabilizing envelope, not model quality or model variance. The
prototype does **not** choose a Model Provider, production schema, graph
database, or implementation language. It never executes repository code or
contacts GitHub while the TUI is running.

## Run

From the repository root:

```sh
python3 prototype/conceptual-change-extraction/app.py
```

The app keeps all interaction state in memory. Use `a` to advance through the
pipeline, `r` to compare the two extraction passes, `n`/`p` to switch case, and
`q` to quit. Run the compact all-case report with:

```sh
python3 prototype/conceptual-change-extraction/app.py --report
```

## Real cases

- [cli/cli: Add `gh uptime`](https://github.com/cli/cli/pull/14094) — a small,
  behavior-rich change with clear intent and in-diff tests but no completed
  provider checks at capture time.
- [cli/cli: Honour `api_host` across the CLI](https://github.com/cli/cli/pull/14104)
  — a large cross-cutting draft with 66 changed files, review discussion, and
  substantial test evidence.
- [github/docs: Remove reference to `rebase-strategy`](https://github.com/github/docs/pull/40756)
  — a one-line documentation-only change surrounded by a large amount of CI
  evidence; useful for testing honest Graph abstention.

Fixtures are bound to the exact base/head pair recorded in each JSON file. To
refresh them intentionally, with GitHub CLI authentication available:

```sh
python3 prototype/conceptual-change-extraction/capture_fixtures.py
```

Refreshing changes the experiment and should therefore create a new captured
prototype revision rather than silently replacing the evidence behind an old
verdict.

## Deliberate limits

- Repository context is shallow: metadata, languages, the root tree, README,
  root manifests, changed-file patches, comments, reviews, and check summaries.
- No model is called live, so provider variance, prompt behavior, cost, and
  latency remain outside this prototype.
- Provider checks are evidence that jobs reported a result, not proof of every
  behavior claimed by a check name.
- Usefulness remains an Operator judgment. The program can expose unresolved
  references, unstable identities, graph-shape problems, and hidden exclusions;
  it cannot decide whether the resulting explanation is genuinely useful.
