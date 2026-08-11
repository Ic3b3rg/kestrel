# PROTOTYPE — Conceptual change extraction UI

Throwaway UI prototype for
[Validate conceptual change extraction on real pull requests](https://github.com/Ic3b3rg/kestrel/issues/9).

## Question

Can an Operator understand the conceptual result extracted from a real pull
request — changed behavior, intent, Evidence, Findings, and limits — without
first understanding the extraction pipeline or opening the raw diff?

Three radically different presentations share the same captured data and are
switchable with `?variant=A`, `?variant=B`, and `?variant=C`:

1. **A — Racconto guidato:** one concise narrative from change to behavior,
   attention point, Evidence, and gaps.
2. **B — Mappa visuale:** the focused behavioral Graph is the dominant surface
   and drives a node inspector.
3. **C — Esiti → prove:** expected outcomes organize implementation Evidence,
   uncertainty, and the affected behavior.

This is an adjustment to the accepted Conceptual Review direction from
[Prototype the conceptual change view](https://github.com/Ic3b3rg/kestrel/issues/7),
not a reopening of its product semantics. Pipeline mechanics remain available
behind **Dettagli estrazione**, never in the primary reading path.

## Run

From the repository root:

```sh
python3 -m http.server 4174 --directory prototype/conceptual-change-extraction
```

Then open:

<http://127.0.0.1:4174/?variant=A&case=small-behavior>

The floating bottom switcher changes variants and updates the URL. The PR tabs
change the real captured case. Arrow keys cycle variants when focus is not in
an editable control. Everything is read-only and runs in the browser.

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
- The interpretive drafts were produced during one agent session, not as
  independent Model Provider samples. Provider variance, prompt behavior,
  cost, and latency remain outside this prototype.
- Provider checks are evidence that jobs reported a result, not proof of every
  behavior claimed by a check name.
- Usefulness remains an Operator judgment. This page is designed to make that
  judgment possible before exposing validation and identity mechanics.
