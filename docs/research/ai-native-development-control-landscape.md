# AI-native development control landscape

**Status:** decision-oriented research note

**Research date:** 2026-08-04

**Scope:** BloopAI/Vibe Kanban, OpenHands, Overdeck, Draft, DevAgents OS,
Codara, Graphite, CodeViz, DiffGraph, Striff, and Softagram

**Kestrel stages addressed:** Review First and the first thin end-to-end vertical

## Executive conclusion

Kestrel should not enter this market as another diff viewer, AI reviewer, coding
agent wrapper, or autonomous software factory. The defensible product is a
self-hosted control plane in which a human can understand and decide on a change
through a traceable chain:

> approved intent -> affected concepts -> changed flows -> risk -> evidence ->
> relevant code

The raw diff remains available, but as supporting evidence rather than the main
information architecture. No product examined here demonstrates that complete
combination in its public first-party material. Different competitors cover
parts of it: DraftHQ is strongest on intent-first review, CodeViz and Striff on
interactive structural understanding, Softagram on hierarchical change impact,
OpenHands on durable remote execution primitives, and Vibe Kanban and Overdeck
on operating multiple isolated agent workspaces.

For **Review First**, build a versioned conceptual review packet for an exact
base/head pair. It should present intent and acceptance criteria, affected
domain concepts, a small set of risk-ranked end-to-end flows, before/after
behavior, findings, and evidence. Comments should attach to those semantic
objects. Every generated claim should disclose its source, confidence, and
coverage limits and link to the relevant code or evidence.

For the **thin vertical**, connect that same review model to one durable loop:
Work Item -> human-led Planning Session -> explicit operator Run Trigger ->
persistent Agent Run in a Kestrel-managed Sandbox -> meaningful Human Gate ->
Conceptual Review -> provider pull request. Kestrel should own the agent loop and
its event history; repository, model, sandbox, and work-item systems should be
adapters around it.

## How to read the evidence

Only primary sources were used: official product documentation, sites, package
registries, and source repositories. This is a product and architecture scan,
not an independent benchmark.

- **Source-observed** means a behavior or structure is visible in public source
  or described in official documentation. It does not prove product quality.
- **Vendor claim** means the only evidence found is first-party product or
  roadmap copy.
- **Kestrel implication** is the recommendation inferred from those sources,
  not a claim made by the cited product.

Several names are ambiguous. Two unrelated products currently use **Draft**,
and two unrelated products use **Codara**. Both plausible identities are covered
below; no relationship between either pair was found. DiffGraph and DevAgents OS
have sparse public technical evidence, so conclusions about their internals
would be speculation and are deliberately omitted.

## Landscape at a glance

| Product | Source-observed or first-party pattern | Kestrel implication |
| --- | --- | --- |
| Vibe Kanban | Issues drive isolated worktree workspaces with agent terminals, previews, live state, diff review, inline comments, and Git operations. It orchestrates several external coding agents. [Repository](https://github.com/BloopAI/vibe-kanban), [workspace changes](https://vibekanban.com/docs/workspaces/changes), [supported agents](https://www.vibekanban.com/docs/supported-coding-agents) | Adopt isolation, live steering, preview, and operational visibility. Do not make a raw file diff the primary review model or Kestrel a shell around somebody else's agent. |
| OpenHands / Agent Canvas | A conversation coordinates agent, workspace, tools, security, and an append-only event log; local and remote implementations share an interface. Its runtime executes actions in a sandbox through an explicit client/server boundary. Its QA skill records commands, outputs, screenshots, and flow verdicts. [Canonical repository](https://github.com/OpenHands/OpenHands), [Conversation architecture](https://docs.openhands.dev/sdk/arch/conversation), [runtime architecture](https://docs.openhands.dev/openhands/usage/architecture/runtime), [QA skill](https://github.com/OpenHands/extensions/blob/main/skills/qa-changes/SKILL.md) | Adopt typed durable events, projections, remote sandbox boundaries, and structured observations. Keep Kestrel's own agent policy and Human Gates. |
| Overdeck | An open-source issue-to-merge orchestrator provides isolated worktrees, live agent state and cost, specialist review lenses, automated verification, checkpoints, and selectable autonomy. [Repository](https://github.com/eltmon/overdeck), [requirements reviewer](https://github.com/eltmon/overdeck/blob/main/roles/review-requirements.md), [correctness reviewer](https://github.com/eltmon/overdeck/blob/main/roles/review-correctness.md), [review architecture](https://github.com/eltmon/overdeck/blob/main/docs/REVIEW-AGENT-ARCHITECTURE.md) | Adopt operational observability, recovery, evidence tiers, and acceptance-criteria traceability. Avoid making merge the only consequential human decision. |
| DraftHQ / Draft | A local, spec-first plugin starts review from intent, decisions, rejected alternatives, structural change, drift, risk, and blast radius; its graph service supplies call paths, boundaries, cycles, and hotspots. [Draft site](https://www.getdraft.dev/), [assist-review skill](https://github.com/drafthq/draft/blob/main/skills/assist-review/SKILL.md), [graph service](https://github.com/DeusData/codebase-memory-mcp) | Closest interaction reference. Adopt intent-first ordering, structural/trivial separation, decision trace, and disclosed degraded modes. Differentiate with a persistent collaborative review surface rather than a generated CLI guide. |
| Draft PR / Draft | A separate goal-to-ticket agent runner uses dependency-aware planning, isolated worktrees, verification commands, live job events, and a human review state, but its review surface centers on a consolidated diff. [Repository](https://github.com/draftPR/draft), [SDK](https://trydraft.dev/sdk.html), [SDK overview](https://docs.trydraft.dev/sdk/overview) | Adopt explicit verification artifacts and `needs_human` state. Avoid auto-approval and treating passing commands plus one clean diff as conceptual understanding. |
| DevAgents OS | First-party material describes specialized agents across the lifecycle, shared context and traceability, on-premises/hybrid operation, model flexibility, and an incremental rollout beginning with one workflow. Its governance essay frames a semantic record from intent through context, decision, tool, result, and impact, with explicit approval for critical actions. [Official site](https://devagents-os.com/en), [governed operations](https://devagents-os.com/en/blog/agentic-ai-frontier-governed-operations) | Adopt the staged rollout principle, lifecycle traceability, and semantic audit vocabulary. Do not begin with an agent catalog or full-SDLC breadth before the thin vertical is trustworthy; the public evidence does not establish the mechanics. |
| Codara (codara.net) | A private-beta concept links initiative, product specification, design, technical design, story, and coding context; it describes explicit approval for AI proposals. Its coding agent and Pull Request Intelligence are roadmap items. [Official site](https://www.codara.net/) | Adopt upstream intent lineage and proposal/approval semantics. Do not mistake a context bundle or roadmap for verified review behavior; Kestrel can differentiate through self-hosting and a working review-first slice. |
| Codara (codara.io) | A separate Python CLI reviews unstaged or branch diffs and writes a formatted report. [Package registry](https://pypi.org/project/codara/), [official site](https://codara.io/) | Treat as a conventional AI diff reviewer, not as evidence for a conceptual-review architecture. |
| Graphite | Code Tours generate a sequenced change narrative beside the diff from the PR description, conversations, stack, and code. The regular PR page combines stack context, checks, versions, discussion, AI comments, and a conventional file-tree diff; its inbox makes review state actionable. [Code Tours](https://graphite.com/blog/code-tours), [PR page](https://graphite.com/docs/pr-page-overview), [PR inbox](https://graphite.com/docs/use-pr-inbox), [GitHub sync](https://graphite.com/docs/create-a-pull-request) | Treat Code Tours as the closest guided-review UX benchmark. Adopt actionable review state, exact versions, atomic change context, and two-way provider sync; differentiate with explicit concepts/flows and retained evidence rather than an AI narrative beside a diff. |
| CodeViz | Versioned and editable architecture/workflow diagrams support high-level-to-code navigation, before/after views, dependency impact, data flows, and diagram comments. [Official site](https://www.codeviz.ai/), [code-review use case](https://www.codeviz.ai/use-cases/code-review), [extension](https://marketplace.visualstudio.com/items?itemName=CodeViz.codeviz) | Adopt progressive drill-down, focused flow views, click-to-code, and a shared visual model. Do not make an inferred whole-repository canvas canonical without provenance. |
| DiffGraph | A GitHub App posts Mermaid architecture and dependency views for a pull request. Its own terms say results can be inaccurate or incomplete and are not a substitute for professional review. [Official site](https://diffgraph-landing.vercel.app/), [GitHub App](https://github.com/apps/diffgraph), [terms](https://diffgraph-landing.vercel.app/terms) | A cheap architecture delta in the existing review surface is a useful prototype pattern. A static dependency diagram is not intent, behavior, or correctness. |
| Striff | Architecture-aware PR analysis compares structural graphs, ranks boundary/coupling/cycle findings, can ground findings in architecture documents, and supports graph-anchored discussion. Its public library exposes top-down base/head change sets and parser warnings. [Official site](https://striff.io/), [public library](https://github.com/hadi-technology/striff-lib) | Adopt deterministic structural deltas, sparse ranked findings, rule/document provenance, explicit parser limits, and comments on graph objects. Add product concepts, behavioral flows, and runtime evidence. |
| Softagram | Pull-request analysis models dependencies hierarchically, shows direct and transitive impact, distinguishes change from context, enforces dependency rules, and links model elements to source. Open-source graph and MCP components expose the model for structured queries. [Analyzer](https://softagram.com/en/softagram-analyzer), [PR reports](https://softagram.com/blog/oppaat-4/pull-request-reports-explained-9), [graph library](https://github.com/softagram/sgraph), [MCP server](https://github.com/softagram/sgraph-mcp-server) | Adopt a precomputed hierarchical graph as an evidence service and key every report to an exact commit. Do not expose the raw dependency model as the product or collapse risk into an opaque scalar. |

## Review First: recommended product shape

### The unit of review is a decision packet

The screen should answer these questions in order:

1. **What is this change trying to accomplish?** Show the stated goal,
   acceptance criteria, non-goals, and important design decisions. Identify each
   item as imported, human-authored, agent-proposed, or inferred.
2. **What product or domain concepts change?** Use stable names meaningful to a
   reviewer, not merely file paths.
3. **Which end-to-end flows change?** Rank a small number of user or system flows
   by review risk and show before/after behavior.
4. **What could go wrong?** Overlay behavioral, architectural, data, security,
   and operability findings on the affected concepts and flow steps.
5. **Why should the reviewer believe this?** Attach tests, checks, runtime
   observations, screenshots or previews, source locations, analyzer rules, and
   immutable revision identifiers.
6. **Where is the implementation?** Reveal relevant code and then the raw diff
   on demand, keeping both tied to the selected concept, flow, or finding.

This ordering combines patterns that currently live in separate products.
DraftHQ explicitly leads with intent and traces structure back to design
decisions; CodeViz supports high-level-to-code navigation and flow views; Striff
and Softagram supply base/head structural impact; Overdeck's review roles map
requirements to changed code, tests, and observable behavior. The Kestrel value
is the joined, decision-ready artifact rather than any one analysis.

### Information architecture

The first useful interface can stay compact:

| Region | Contents | Default behavior |
| --- | --- | --- |
| Decision bar | base/head identity, review version, provider state, unresolved gates, overall evidence freshness | Always visible; never reduce the decision to one AI score |
| Intent | goal, scope, acceptance criteria, non-goals, decisions, source lineage | Human-authored or imported facts first; inferred text visibly marked |
| Changed flows | risk-ranked flow cards with before/after steps and affected concepts | Open the highest-risk flow; collapse unchanged steps |
| Focused graph | concepts and relationships needed for the selected flow or finding | Small subgraph first; expand progressively |
| Findings | severity, confidence, target, reason, rule or source, disposition | Group by concept/flow, not by reviewer bot |
| Evidence | checks, tests, runtime observations, previews, artifacts, code links | Show status and exact revision; disclose missing or stale evidence |
| Discussion | threads anchored to intent, flow, node, edge, finding, or evidence | Preserve anchors across revisions and show stale/reattached state |
| Code drawer | flow-relevant source and raw base/head diff | Secondary, synchronized with the selected semantic object |

Graphite's inbox and PR status model show why reviewers need an actionable state
surface rather than a passive report. Its stacked changes also reinforce that
review units should be small and versioned, but its main review still resolves
to files and lines. Code Tours is the strongest direct interaction benchmark
because it guides the reviewer through a generated sequence beside the diff;
the cited launch material described richer visual artifacts and test validation
as future work. Kestrel should use the same narrative clarity while making
concepts, flows, and retained evidence explicit objects rather than sections of
generated prose.

### A graph that serves review, not graph exploration

The graph should be a projection for the selected flow or risk, not an automatic
hairball of the whole repository. It needs typed nodes such as actor, UI,
endpoint, domain concept, service, data store, external system, test, and
evidence, plus typed relationships such as calls, reads, writes, publishes,
depends on, and verifies.

Use distinct visual states for **added**, **modified**, **removed**, **impacted**,
and **context**. Softagram's PR report uses a similar separation and automatic
abstraction on larger graphs; Striff's library exposes explicit change sets and
render limits. Kestrel should also provide collapse, zoom, node limits, and
clear warnings when a parser, language, or dynamic edge is unsupported.

The graph is evidence, not truth. Deterministic parsing should establish the
structural floor; documentation, tests, runtime traces, and agent observations
can enrich it. Model-generated flow names or inferred relationships must retain
citations and confidence. This avoids the failure mode DiffGraph itself warns
about: a plausible diagram can still omit impact or be wrong.

### Minimal versioned review model

The prototype should make these entities explicit even if the first storage
model is simple:

```text
ReviewSnapshot(base_sha, head_sha, provider_ref, generated_at)
IntentArtifact(id, kind, text, source, confidence)
ConceptNode(id, kind, label, source_locations, provenance, base_state, head_state)
RelationshipEdge(id, kind, from_id, to_id, provenance, base_state, head_state)
Flow(id, title, steps, node_refs, edge_refs, before, after, confidence)
Finding(id, category, severity, confidence, target_ref, evidence_refs, rule_ref)
Evidence(id, kind, producer, status, revision, uri_or_hash)
ReviewThread(id, target_type, target_id, provider_mirror_refs, resolution)
```

Every generated review is immutable for a base/head pair. A new head creates a
new snapshot and reconciliation pass; it does not silently rewrite what the
human previously reviewed. Graphite's version-aware PR workflow and
Softagram's commit-bound report are useful precedents for this constraint.

### Analysis pipeline for the prototype

1. A provider adapter captures pull-request metadata, exact base/head commits,
   comments, and checks. Review First must also work when the pull request has no
   Kestrel Work Item; absent intent is displayed as absent or inferred, never
   fabricated as approved intent.
2. A deterministic indexer parses changed and reachable code, caching by blob
   hash. Unsupported languages, parse errors, truncation, and skipped checks
   become first-class coverage metadata.
3. A graph-delta step computes added, removed, modified, and transitively
   impacted nodes and edges.
4. A flow projection combines structural relationships with available intent,
   documentation, tests, and run evidence. A model may name and summarize a flow
   only with source references.
5. An evidence collector attaches provider checks, test results, commands,
   logs, preview artifacts, and source locations to the exact revision.
6. A review projection produces the semantic packet and reconciles stable
   discussion anchors when the head changes.
7. The responsive PWA renders progressively: summary first, focused graph next,
   raw source only when requested.

This pipeline deliberately separates extracted facts, inferred interpretation,
and human decisions. DraftHQ's graph tooling exposes confidence/provenance and
degraded modes; OpenHands' architecture demonstrates the value of keeping an
append-only source of events separate from consumers such as persistence,
monitoring, and visualization.

## Thin vertical: recommended control architecture

Review First should become the review step of one thin, durable lifecycle—not a
separate report generator.

```text
Provider invocation
        |
        v
Work Item + Planning Session -- human intent/scope/decisions
        |
        | explicit operator Run Trigger
        v
Persistent Agent Run <----> Kestrel Sandbox
        |
        +---- typed events, tools, costs, observations, evidence
        |
        v
Human Gate ----> Conceptual Review ----> provider pull request/status
```

### Runtime decisions to make early

- **Kestrel owns the agent loop.** Model providers sit behind an adapter; an
  external coding-agent CLI is not the product runtime. Vibe Kanban and Overdeck
  demonstrate the utility of multi-harness orchestration, but adopting that as
  Kestrel's core would surrender policy, event semantics, and Human Gates.
- **Runs are server-owned and persistent.** The operator's phone or browser is a
  control surface, not the execution host. OpenHands' common local/remote
  conversation interface, sandbox client/server boundary, and conversation
  persistence are strong implementation references. [Workspace architecture](https://docs.openhands.dev/sdk/arch/workspace), [conversation persistence](https://docs.openhands.dev/sdk/guides/convo-persistence)
- **The event log is typed and append-only.** Store prompts, model decisions,
  tool actions/results, state transitions, costs, evidence production, and human
  decisions as durable events; derive UI projections from them. Terminal output
  can be an artifact, not the audit model. OpenHands' QA skill is also a useful
  evidence contract: retain the exact command or entry point, observed output,
  screenshots where relevant, and a scoped verdict instead of only a prose
  claim.
- **Sandbox identity is explicit.** Bind repository, base revision, branch,
  lifecycle state, retention, and credentials to a Sandbox record. Worktree
  isolation is a useful local technique used by Vibe Kanban, Draft PR, and
  Overdeck; the production contract should remain a remote sandbox abstraction.
- **Human Gates are semantic decisions.** Persist the decision requested, the
  alternatives, scope/risk implications, evidence, decision maker, and outcome.
  Keep these separate from low-level tool authorization. OpenHands' security
  policies classify actions by risk and can confirm risky actions, but its SDK
  also allows the model to supply a risk field; that signal alone is not a
  sufficient Kestrel gate. [Security architecture](https://docs.openhands.dev/sdk/arch/security), [security guide](https://docs.openhands.dev/sdk/guides/security)
- **External activity cannot silently become execution.** OpenHands can start
  work from a GitHub label or mention; that is convenient but conflicts with
  Kestrel's control boundary. A provider invocation may create or resume the
  Work Item and Planning Session, but only an explicit operator Run Trigger may
  execute. [OpenHands GitHub integration](https://docs.openhands.dev/openhands/usage/cloud/github-installation)
- **Recovery is designed, not improvised.** Make jobs idempotent, checkpoint
  durable state, identify stuck runs, and allow safe resume. Overdeck's live
  health, cost, checkpoints, pause gates, and stuck-agent handling show the
  operational questions users will expect the control plane to answer.
- **GitHub is the first adapter, not the domain model.** Provider identifiers,
  comments, checks, and statuses map to Kestrel entities. Graphite's two-way
  GitHub synchronization is the right interoperability expectation without
  making a GitHub pull request the internal source of truth.

### What not to include in the first vertical

Do not start with multiple specialist personas, autonomous backlog processing,
automatic approval or merge, team roles, multi-repository Projects, a universal
architecture canvas, or full planning-to-production analytics. Overdeck and
DevAgents OS make those later-stage possibilities visible; they also show how
quickly the surface area expands. The first proof should be one operator, one
repository per Project, one owned agent loop, one meaningful Human Gate, and one
excellent conceptual review.

## Adopt, avoid, differentiate

### Adopt now

- Intent and acceptance-criteria traceability from DraftHQ, Codara's proposed
  context chain, and Overdeck's requirements lens.
- Deterministic base/head structure plus progressive, flow-scoped visualization
  from Striff, Softagram, and CodeViz.
- Changed/impacted/context distinctions, source links, explicit coverage gaps,
  and evidence fidelity.
- Versioned review state, actionable queues, and two-way provider synchronization
  from Graphite.
- Isolated workspaces, durable events, remote sandbox boundaries, live run
  status, cost, recovery, and structured observations from Vibe Kanban,
  OpenHands, Draft PR, and Overdeck.
- Incremental expansion from one proven workflow, as DevAgents OS recommends in
  its own rollout guidance.

### Avoid

- A raw diff, generated prose summary, or whole-repository graph as the primary
  review experience.
- Graph edges, risk scores, or model explanations presented without source,
  confidence, revision, and coverage limitations.
- Comment spam. Prefer one evolving provider status/report and focused threads;
  Striff's single-check positioning and Softagram's updated-per-PR report are
  better patterns than one bot comment per observation.
- Automatic execution from an issue label, mention, webhook, or imported Work
  Item; automatic approval or merge; and a Human Gate reduced to a final Merge
  click.
- Trusting the same model's self-reported risk as the sole policy control.
- Defining Kestrel as a multiplexer for external coding-agent products.
- Premature full-lifecycle and multi-agent breadth before the Review First model
  and one persistent run loop are proven.

### Differentiate explicitly

1. **Conceptual Review, not AI code review:** a navigable relationship among
   approved intent, product concepts, system flows, risk, evidence, and selected
   implementation.
2. **Human decisions as durable domain objects:** gates occur where objectives,
   scope, trade-offs, or critical approval change, not only at merge time.
3. **An owned persistent agent:** Kestrel controls the loop, policy, events,
   evidence, and recovery while letting operators select model providers.
4. **Remote control without client dependence:** the responsive PWA can observe,
   decide, pause, and resume while execution continues in a server-managed
   Sandbox.
5. **Provider-neutral control:** GitHub is first, but a provider mention begins
   planning rather than execution and provider artifacts never replace the
   Kestrel source of truth.
6. **Self-hosted and truth-aware:** extracted fact, agent inference, and human
   approval remain visibly distinct throughout the lifecycle.

## Concrete hand-off to the conceptual-change prototype

The next prototype should test one question: **Can a reviewer understand and
decide on a non-trivial pull request without beginning in the raw diff?**

Use one real pull request with a known goal and implement only:

1. an intent and acceptance-criteria panel;
2. two or three changed flow cards;
3. a focused before/after concept graph for the selected flow;
4. risk findings attached to graph nodes or flow steps;
5. an evidence drawer containing exact source locations, tests/checks, and
   coverage warnings;
6. semantic comments anchored to a flow, node, edge, or finding; and
7. a synchronized raw-diff drawer as the final drill-down.

Success is not diagram beauty. A reviewer should be able to state the intended
behavior, identify the highest-risk affected flow, inspect the evidence for a
claim, leave a durable conceptual comment, and know exactly what remains unknown.

## Unresolved identities and evidence gaps

- **OpenHands:** current documentation presents Agent Canvas as the product
  surface, while `OpenHands/OpenHands` remains the canonical repository. The
  separate `OpenHands/agent-canvas` repository is archived; it should not be
  evaluated as an independent active product. [Agent Canvas overview](https://docs.openhands.dev/openhands/usage/agent-canvas/overview), [archived repository](https://github.com/OpenHands/agent-canvas)
- **Draft:** `drafthq/draft` and `draftPR/draft` are distinct products with
  different purposes. Both are relevant; references to “Draft” without an owner
  or domain are unsafe.
- **Codara:** `codara.net` is a private-beta AI product-development concept;
  `codara.io`/the `codara` Python package is a separate diff-review CLI. No
  relationship was found.
- **Codara roadmap:** the coding agent and Pull Request Intelligence described
  by codara.net were not presented as current shipped capabilities at research
  time.
- **DiffGraph:** an official landing page, GitHub App listing, and terms were
  found, but no public implementation repository or detailed technical
  documentation. Its terms also contain unfinished URL placeholders, so no
  architectural claim should be inferred beyond the documented PR-comment
  behavior.
- **DevAgents OS:** public material is conceptual and first-party; no public
  implementation or detailed API/runtime documentation was identified.
- **CodeViz:** public source is a product feedback/issue repository rather than
  the implementation. Architecture-generation quality was not independently
  verified. [Public repository](https://github.com/EdisonLabs-Inc/CodeViz-Public)
- **Vibe Kanban status:** Bloop announced that the company would shut down on
  2026-04-10 while stating that local workspaces and the open-source project
  would continue and hosted remote services would be removed. Treat it as an
  open-source pattern source, not a stable hosted dependency. [Shutdown announcement](https://vibekanban.com/blog/shutdown), [self-hosting documentation](https://www.vibekanban.com/docs/self-hosting/deploy-docker)
