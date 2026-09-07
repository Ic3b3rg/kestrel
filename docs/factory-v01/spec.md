# Factory 0.1

Status: Approved product direction, 2026-09-07. The Operator explicitly authorized ticket
publication, implementation, and replacement of the current UI after the product interview. This is
the active delivery target.

## Problem statement

The Operator currently moves between chat, Markdown specifications, GitHub issues, coding agents,
and pull requests to keep development moving. Kestrel's existing Review First backlog develops the
final stage in isolation. The Operator needs one working application that carries a feature from an
initial conversation to an explainable, verified change and an explicitly approved merge across
several projects.

## Solution

Kestrel runs on the Operator's workstation. Its dark workspace has persistent Project navigation,
feature Planning Sessions, and a Kanban board. The Operator clarifies a feature in chat, inspects
and approves its versioned plan, and delegates the plan's ordered Work Items. Kestrel implements and
verifies them automatically, stops for consequential Human Gates, and presents one pull request and
Conceptual Review per feature. The Operator selects corrections or approves the exact merge.

The initial runtime is the host's authenticated Codex App Server, already selected by ADR 0003.
GitHub stores new or imported issues and receives execution updates. Kestrel owns priorities,
authority, execution state, and gates. Browser closure does not cancel work; a sleeping or
powered-off workstation cannot execute work.

## User stories

1. As the Operator, I can open an authorized repository and select its Project from a stable
   sidebar.
2. I can switch between Projects without losing each Project's selected feature or chat history.
3. I can start and name a feature Planning Session inside Kestrel.
4. I can discuss requirements in natural language, with questions grounded in that Project's
   documents.
5. I can inspect the source documents used for planning, including CONTEXT, ADRs, repository
   instructions, and relevant specifications.
6. I can reload the browser and recover accepted messages and current work from durable storage.
7. I can see that a model is working, needs authentication, has exhausted usage, or has failed,
   without guessing from an empty chat.
8. I can ask for a concrete plan with objective, scope, acceptance outcomes, verification commands,
   and ordered, dependency-linked Work Items.
9. I can import selected existing GitHub issues into a feature without treating their text as
   execution authority.
10. I can inspect and edit the proposed plan before approving it.
11. I approve one exact plan version and its execution limits; approval authorizes the plan's
    eligible Work Items, not arbitrary later edits.
12. I can see new GitHub issues created once for the approved Work Items and linked back to the
    feature.
13. I can follow Work Items through To do, In progress, In review, and Completed.
14. I can inspect a card's requirements, dependencies, attempts, messages, verification results, and
    GitHub link.
15. I can leave the browser closed while approved work continues on the workstation.
16. I can run one active feature in each of two different Projects concurrently.
17. Later features in the same Project remain queued until the active feature completes or is
    cancelled.
18. Dependent Work Items can build on verified earlier Work Items within the same feature branch,
    before a human reviews the feature.
19. I can see technical fixes proceed within the approved scope without approving every command.
20. I receive a clear Human Gate if requirements, acceptance criteria, or authorized limits need to
    change.
21. A gated card returns to To do with an explicit blocked state and a question; answering the gate
    permits a controlled resume.
22. A gate blocks only its Project's feature queue; another Project continues.
23. I can stop a feature and see a truthful stopped state, with its work preserved for inspection.
24. I can recover after an application restart without two agents executing the same Work Item or
    duplicate issues and pull requests.
25. I receive one feature pull request after its Work Items and verification are ready.
26. I start the Conceptual Review from whether the approved requirements were met.
27. I can explore a graph linking acceptance outcomes, implemented behavioral steps, evidence, and
    problems.
28. I can inspect source locations and verification records supporting each graph statement.
29. Missing support appears as a gap or unresolved concern, never as invented evidence or a
    successful verdict.
30. The review is tied to the exact feature base/head commits; new commits make its prior approval
    ineligible for merge.
31. I see review findings immediately and choose which corrections to request; Kestrel never
    silently fixes published review findings.
32. Requested corrections update the same feature and PR, then produce a new exact-revision review.
33. I explicitly approve merge from Kestrel against the reviewed head; GitHub conflicts or required
    checks remain visible blockers.
34. Work Items become Completed and linked issues close only after a confirmed successful merge.
35. I can perform the primary workflow by keyboard and use a narrow viewport without losing
    navigation or controls.
36. I can use the existing Review First source and provider views while the Factory is delivered
    incrementally.

## Domain and state

- A **Feature** is the approved scope delivered through one ordered plan, feature branch, pull
  request, and current Conceptual Review.
- A **Planning Session** belongs to one Project and Feature. Its conversation is durable; runtime
  thread IDs are adapter details.
- A **Feature Plan** is an immutable approved version of intent, Work Items, dependencies,
  verification, and limits. Draft versions are editable.
- A **Work Item** is a feature-scoped unit with acceptance criteria and dependency keys, optionally
  bound to one GitHub issue.
- An **Agent Run** is one bounded attempt to carry out approved work in a Kestrel-owned writable
  workspace.
- A **Human Gate** records the question, reason, affected authority, and eventual Operator decision.
  It is not merely a failed model turn.
- A work card has a board column plus a distinct blocking reason. Completed is reserved for
  confirmed merge; implementation-ready items remain In review.
- A feature's progression is draft/planning, queued, implementing, gated, reviewing, in review,
  merging, completed, cancelled, or failed. A failed external operation retains its actionable cause
  and never implies success.

## Implementation decisions

- Extend the existing TypeScript/PostgreSQL modular application, authenticated Fastify boundary,
  React PWA, host launcher, and local source inventory.
- Store factory records durably in PostgreSQL with Project association, optimistic versions,
  timestamps, and append-only activity. Do not put product authority in browser storage or in model
  transcripts.
- Use one explicit factory service boundary for HTTP commands, reads, and background work. Use
  transactional claims and per-Project exclusion; at most two Projects execute concurrently by
  default.
- Accepted chat and work requests outlive their initiating HTTP connection. Persist requests before
  starting model work. Reconnect reads current durable state; bounded polling is acceptable for 0.1
  where existing events cannot carry factory state.
- Use bounded App Server protocol messages, explicit cancellation, time limits, and structured
  plan/review output. Keep provider types and credentials outside domain records and browser
  responses.
- Planning may inspect authorized source and instructions but must not mutate the Operator's
  checkout. Save proposed Markdown as feature artifacts; place approved documents in the feature
  workspace.
- Materialize an independent Kestrel-owned feature checkout from the selected exact base. Never use
  the Operator's dirty/staged/untracked bytes, and never mutate or reset their checkout. Branch
  publication is a controller operation bound to the approved Project.
- Execution uses the runtime's enforced writable-workspace policy. A missing enforceable policy
  blocks execution; a worktree alone is not a security boundary. Repository instructions inform work
  but cannot override Kestrel authority.
- The approved plan contains concrete verification commands and declared bounds. Initial defaults
  are two concurrent Projects, one active feature per Project, and a 30-minute limit per execution
  attempt, editable before approval. Timeout or unresolved runtime permission requests create a
  visible gate instead of an unbounded retry.
- Use the host GitHub session for issue and PR operations. Reconcile persisted operation identity
  before retrying uncertain writes. GitHub body text, comments, and labels cannot independently
  start or expand a run.
- Import retains source URL, title, body, and provider identity. Already bound issues cannot
  silently join another active feature. Existing dependency information is shown for planning; the
  approved plan is the execution authority.
- After every Work Item, verify the declared outcomes and save results before advancing dependents.
  Failures may be repaired during implementation within the plan's limits.
- Review runs separately against exact base/head source. A review graph is supported by typed
  file/line evidence and executed verification records. Validate output structure and evidence
  resolution before publication; limited analysis is disclosed.
- Reuse the existing Conceptual Review vocabulary and trust contract. Factory 0.1 does not promise
  the entire later Certified Review First roadmap, every model route, or every language-specific
  analysis capability.
- A request for selected corrections authorizes only those corrections within the feature.
  Requirement changes require a new approved plan. There is no automatic published-finding repair
  loop.
- Merge is an explicit controller operation using the reviewed exact head as a precondition.
  Reconcile GitHub's outcome before marking completion or closing issues. A changed head or target
  conflict blocks the merge.
- Preserve existing installation/authentication/source acquisition behaviors and database migration
  history. Add migrations; never rewrite applied migrations.

## UI decisions

- Use shadcn/ui as the component foundation, as explicitly requested by the Operator: its sidebar,
  controls, dialogs, tabs, and accessible primitives with the existing React/Vite app and Tailwind
  integration. Do not recreate these primitives from scratch.
- Replace the existing light visual system with a dark, calm operational workspace.
- Fixed desktop sidebar: Kestrel, add/open Project, Project list, selected Project's feature chats,
  and Settings/account at the bottom.
- Selected feature header: name, Project, lifecycle, and the next relevant action. Primary views:
  Planning, Board, Review.
- Planning uses a readable conversation and an inspectable plan; approval is contextual, not hidden
  in global settings.
- Board uses four clear columns with ordered cards, dependency indicators, and conspicuous human
  questions. Status is never conveyed by color alone.
- Review starts with acceptance outcomes and lets the Operator select graph nodes to inspect
  behavioral explanation, evidence, and findings. Corrections and merge remain visible next to the
  reviewed revision.
- Use real application states and content. Empty, loading, authentication failure, blocked,
  reconnecting, and partial results are designed states. Hide infrastructure jargon from the
  ordinary product flow.
- On narrow screens the sidebar becomes an accessible navigation drawer; the main view remains
  usable without page-wide horizontal overflow.
- No standalone prototype or visual concept approval phase: the user explicitly requested direct
  implementation and iteration on the running app.

## Testing decisions

Tests exercise externally observable service/HTTP and browser behavior. Start each behavior with a
failing regression and reuse the repository's Vitest, database test harness, isolated Compose
black-box tests, and Playwright conventions.

The primary verification seam is the authenticated Factory command/read boundary, followed by the
real browser path. Runtime and GitHub adapters receive process-level contract tests with controlled
external responses; tests must not fake a successful factory while production adapters remain stubs.

Prove: restart durability; idempotent writes; frozen approvals; dependency order; one active feature
per Project; two Projects progressing independently; gates and stop; source checkout preservation;
exact-head review and merge; user-selected corrections; false or missing evidence rejection; issue
closure only after merge. Verify dark desktop/narrow UI and keyboard navigation in the real browser.

Run focused checks during each ticket and the relevant full suite once at the end of each integrated
slice. The final acceptance exercises the real launcher and actual App Server on a disposable
repository with a tiny approved change. GitHub publication tests use a task-owned test repository
when available; never publish a speculative Veduta change merely to demonstrate integration. Veduta
supplies the pilot instructions and verification profile; the Operator has not yet selected a real
Veduta feature.

## Out of scope

Hosted/always-on service, multi-Operator collaboration, two active features in one Project,
bidirectional GitHub workflow control, automatic merge, automatic repair of published review
findings, deployment of generated software, integrated preview environments, GitLab, additional
runtime adapters, and full Certified Review First certification.

## Delivery and authority

The linked Factory tickets are the implementation frontier. The historical Review First backlog
stays available as source material; its existence does not make every old ticket a dependency. The
Factory umbrella is not ready-for-agent. Only self-contained child tickets carry that label, with
native blocking links.

The approved implementation request authorizes ticket publication, isolated implementation branches,
tests, draft PRs, and routine integration needed to deliver this version. It does not authorize
modifying Veduta, deploying applications, or replacing unrelated local work.
