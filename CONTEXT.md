# Kestrel

Kestrel is the domain of understanding and governing software change across projects while keeping consequential decisions with the human. Review First V1 is the active release domain; the planned agentic-development lifecycle is reserved future language.

## Implemented local-source boundary

Review First V1 now retains an exact Review Revision only from a Local Repository Source beneath an
Installation-configured read-only root. The Operator selects an opaque repository identity and two
enumerated committed refs, then supplies or explicitly confirms Change Intent. Kestrel records the
resolved base/head object IDs before retaining a verified, project-scoped commit/tree/blob closure;
working-tree and index state are never source.

Local Repository Source attachment, optional Provider Observation metadata, Revision State, and
Model Access Availability remain independent Project facts. A matching public GitHub observation
enriches the same Change Proposal but never supplies source. Detaching or losing the repository
changes only source attachment state: an Available Review Revision remains immutable and usable.
When independently created local and provider-first records later identify the same repository,
Kestrel converges them behind one canonical Project and canonical Change Proposal while retaining
the old IDs as internal aliases. Source and Review Revision rows are not rewritten; reads aggregate
their immutable history into the canonical inbox, and restart reconciliation selects at most one
attached source for the logical Project family.

## Language

### Review First V1

**Kestrel**:
The local-first system in which an Operator understands and governs software change across Projects through selectable Agent Runtimes. Review First V1 runs on the Operator's workstation and implements its read-only review domain; later releases may add remote operation or extend it into agentic development.
_Avoid_: PR reviewer, code-review tool, wrapper around an external coding agent

**Review First V1**:
The first Kestrel release domain: local-first, natural-language-first, read-only review of existing Change Proposals through Kestrel's visual interface. Every review uses source materialized and verified locally; remote deployment, provider writeback, and agentic development are reserved for later releases.
_Avoid_: Full Development Lifecycle, provider review bot, Agent Run

**Change Intent**:
A current, versioned, source-backed statement associated with a Change Proposal, defining the intended outcome, scope boundaries, and acceptance criteria against which a change is evaluated. A Review Workflow freezes one exact version; missing, ambiguous, or contradictory intent is resolved by the Operator before that workflow begins.
_Avoid_: Pull request description, Change Overview, full specification

**Provider Review Input**:
A provenance-bearing but untrusted provider conversation comment, submitted review, or inline review discussion associated with a Change Proposal. A Review Workflow records its input cutoff; the input may seed analysis but cannot change Change Intent, grant authority, or substantiate a Finding without explicit Operator action or independent Evidence.
_Avoid_: Provider Invocation, Review Thread, Finding, Evidence

**Change Overview**:
The fast preliminary artifact Kestrel generates for each newly observed open change proposal and regenerates only when that proposal receives a new source head, combining provider-declared intent and deterministic change facts with a bounded model-generated natural-language rendering; target-only movement or configuration changes may refresh deterministic facts but never silently replace the model text. The inputs remain directly inspectable and source-linked from the generated text; the model may only organize or restate them, adds no code-level analysis or unsupported behavioral claim, and produces no Graph, Evidence, Coverage judgment, Findings, Risk Level, or review verdict.
_Avoid_: Review, Change Intent, Conceptual Review, review verdict

**Review Workflow**:
The single active lifecycle authorized by one explicit Operator request to analyze an exact Review Revision and publish or fail to publish a Conceptual Review. It freezes Change Intent, applicable Provider Review Input cutoff, Analysis Configuration, authority, and Resource Envelope; later Provider Review Input neither invalidates it nor starts more analysis automatically.
_Avoid_: Conceptual Review, Agent Run, one aggregate review status

**Review Attempt**:
A bounded internal execution attempt within one Review Workflow, using that workflow's frozen inputs and publication authority. It owns no independently publishable result; recovery creates another attempt, while an Operator-visible Retry creates another Review Workflow.
_Avoid_: Review Workflow, model turn, published review

**Operator Attention**:
The in-product collection of review conditions that require explicit Operator action: Outdated, Context changed, Analysis configuration changed, New provider review input, Partial, Failed, Needs authentication, or Usage limit reached. Waiting for a trustworthy usage reset and an inline Change Overview rendering failure do not require attention unless automatic recovery cannot proceed or the same condition blocks an explicit review.
_Avoid_: Notification, workflow queue, every non-terminal state

**Conceptual Review**:
The exact-revision review artifact that explains intent, behavioral flows, risk, Evidence, Coverage, and any applicable Provider Review Input cutoff through a natural-language entry view, a focused Graph for interactive exploration, and optional code drill-down. Every supported repository- and model-access route must meet the same minimum artifact and trust contract; unavailable provider context or optional analysis is disclosed rather than silently degrading the result.
_Avoid_: Diff review, raw code review, merge approval, comprehensive code review

**Review Revision**:
The immutable exact base/head commit pair selected for a Conceptual Review together with Kestrel's verified retained snapshot. Mutable branch names, provider observations, and synthetic merge commits never form its identity or retarget an analysis.
_Avoid_: Branch, pull-request head state, test merge commit

**Change Proposal**:
A proposed integration of one evolving source line into a target line, either discovered through a Provider Observation or declared by the Operator from a Local Repository Source. Its mutable source state and optional provider metadata remain distinct from any Review Workflow or immutable Review Revision Kestrel associates with it.
_Avoid_: Review Workflow, Review Revision, GitHub-only pull request

**Proposal State**:
The Repository Provider's reported lifecycle state for a provider-backed Change Proposal: Open, Merged, Closed, or Unknown. It is not applicable to a local Change Proposal and remains independent of Review Workflow progress and of whether Kestrel holds or has reviewed an exact revision.
_Avoid_: Review Currency, Revision State, Review Workflow state

**Revision State**:
Whether Kestrel holds a complete verified local snapshot for a Review Revision: Pending, Acquiring, Available, or Unavailable. Provider access and Review Currency are separate facts.
_Avoid_: Pull-request state, branch status, provider access

**Review Currency**:
Whether a Change Proposal still has the exact source head analyzed by a Conceptual Review: Up to date, Outdated, or Unknown. Target movement belongs to Integration State, while intent, configuration, and Provider Review Input changes remain separate facts; none starts analysis automatically.
_Avoid_: Revision State, provider access, Current, Superseded, stale intent

**Integration State**:
Whether Kestrel has deterministically established how a Conceptual Review's unchanged source head relates to the Change Proposal's current target: Checked, Changed, Blocked, Checking, or Unknown. It never changes the original review or starts model analysis automatically.
_Avoid_: Review Currency, Proposal State, merge verdict, automatic reanalysis

**Risk Level**:
Kestrel's shared Critical, High, Medium, or Low assessment of a Finding's credible consequence, blast radius, reversibility, and realistic reachability. It expresses impact rather than certainty, evidence strength, or a merge verdict.
_Avoid_: Model confidence, evidence strength, review verdict

**Review Claim**:
A concrete, falsifiable assertion that Kestrel publishes about the exact analyzed revision. It declares its kind, Claim Basis, supporting Evidence, reasoning, limitations, and analysis coverage; a possibility below the minimum evidence threshold is an Unverified Concern rather than a Review Claim.
_Avoid_: Model output, unsupported conclusion, review verdict

**Finding**:
A risk-bearing Review Claim that a condition in the exact analyzed head can plausibly cause an adverse outcome. Every Finding has a Risk Level while its Evidence, uncertainty, and Coverage remain separate; merely removing a harmful base condition is not a Finding.
_Avoid_: Observation, stylistic suggestion, unsupported certainty

**Claim Basis**:
The method by which Kestrel establishes a Review Claim: Deterministic when every material link follows a reproducible versioned non-model rule, otherwise Model Judgment. It describes the proving method rather than certainty or origin of the hypothesis.
_Avoid_: Risk Level, evidence strength, model confidence, hybrid classification

**Evidence**:
A typed, resolvable, provenance-bearing artifact tied to the exact analyzed revision that supports or refutes a material link in a Review Claim. Its locator, supported link, scope, and limitations bound what it can prove.
_Avoid_: Model assertion, unresolved reference, confidence score

**Analysis Capability**:
A declared, versioned unit of review analysis that defines the inputs it can inspect and the typed Evidence it can produce. A specialist applies only capabilities relevant to the change and reports each one's applicability and execution coverage explicitly instead of assuming that every technology or artifact exists.
_Avoid_: Technology checklist, agent persona, hidden analyzer behavior

**Analysis Configuration**:
The immutable, versioned combination of runtime, model-access route, Analysis Capabilities, Verification Profile, artifact classifications, resource controls, and review controls frozen for one generated artifact or Review Workflow. Active work never retargets to later settings or silently changes access route.
_Avoid_: Review Revision, Change Intent, mutable runtime settings, hidden defaults

**Coverage**:
The plain-language account of what Kestrel inspected and which expected Change Intent outcomes it could trace to the exact analyzed implementation. It distinguishes mapped, not applicable, Gap, and Unclear scope without converting incomplete analysis or unlike denominators into assurance.
_Avoid_: Generic completion percentage, completeness guarantee, technology checklist

**Evidence Sufficiency**:
The disclosed support status of a Review Claim: Sufficient when every material link has resolvable uncontradicted support, or Limited when the publication threshold is met but a material gap remains. Anything below that threshold is an Unverified Concern rather than a Review Claim.
_Avoid_: Risk Level, model confidence score, hidden evidence gap

**Provisional Finding**:
A Finding that clears the publication threshold with Limited Evidence. It retains the Risk Level warranted by credible impact while disclosing the missing support and targeted verification needed.
_Avoid_: Unverified Concern, confirmed fact, reduced Risk Level

**Unverified Concern**:
A potentially important possibility that lacks either resolvable exact-revision Evidence or the explicit condition-to-consequence reasoning required for a Finding. It is disclosed among unresolved concerns or limitations, carries no Risk Level, and is excluded from Finding counts.
_Avoid_: Finding, Low risk, hidden model output

**Observation**:
A useful review note that does not assert a plausible adverse outcome, such as context or a non-risk improvement suggestion. It carries no Risk Level and is never disguised as a Low-risk Finding.
_Avoid_: Finding, Low risk, coverage gap

**Graph**:
The review-scoped network of meaningful Behavioral Steps that explains causal and logical flows in one exact base-to-head change. Code remains authoritative, identity lasts only for that Conceptual Review, and uncertainty appears as Coverage rather than invented structure.
_Avoid_: Orchestration graph, workflow editor, raw call graph, incrementally reused Project graph, historical Graph comparison

**Behavioral Step**:
The smallest human-readable causal unit within a Graph flow, stating what the implemented behavior does at that point rather than naming a code structure. It identifies whether that behavior is Added, Modified, Removed, or minimum necessary Context, anchors its Evidence, and may be annotated as a decision, system boundary, or data passage without becoming a separate rigid node family.
_Avoid_: Function, class, AST node, agent execution step

**Review Thread**:
A source-backed conversation between the Operator and Kestrel anchored to an exact Review Revision and, when relevant, one Graph node. It has no authority to change review artifacts without an explicit Operator action and is not carried into a replacement review.
_Avoid_: General chat, pull-request comment, silent Graph edit

**Review Tombstone**:
The content-free replacement for a deleted review artifact reference, identifying that the artifact was replaced or deleted, when and why, and where the current proposal or review can be found. It never restores or remaps an old Graph node, Finding, or Review Thread and permits no further interaction with it.
_Avoid_: Review history, archived review, redirected Graph node

**Kestrel Installation**:
A locally operated Kestrel environment that presents and governs multiple Projects through one interface. Review First V1 has one trusted Operator and runs on that Operator's workstation; a remotely hosted Installation is future scope.
_Avoid_: Project, repository

**Kestrel Release**:
An immutable, versioned distribution of Kestrel whose internal components and compatibility have been certified as one unit. The Operator updates a Kestrel Installation from one Kestrel Release to another through an explicit action and never composes a release by selecting internal component versions independently.
_Avoid_: Floating dependency set, automatic update, individually selected component versions

**Installation Audit**:
The content-minimized, append-only record of security- and lifecycle-significant Kestrel events, retaining only compact identity, timing, outcome, profile, resource, and deletion facts. It never retains source, Graphs, prompts, model responses, Evidence, Review Threads, or a browsable historical review.
_Avoid_: Review history, observability warehouse, clickstream, retained analysis

**Project**:
The Kestrel representation of one software repository. A Kestrel Installation contains many Projects and therefore manages many repositories.
_Avoid_: Workspace, multi-repository project

**Agent Runtime**:
A selectable agent that performs bounded analysis while Kestrel retains lifecycle governance, effective-authority containment, and durable state. It may own its native loop and model authentication, but never Kestrel policy or retained artifacts.
_Avoid_: Model Provider, Repository Provider, built-in reviewer, Review Workflow

**Agent Runtime Profile**:
The versioned Kestrel certification of an exact Agent Runtime and adapter configuration, including its capabilities, containment, model-authentication boundary, and conformance evidence for a particular lifecycle use. Runtime claims and permission requests can never expand the profile's effective-authority ceiling.
_Avoid_: Model configuration, ACP capability advertisement, per-tool approval prompt

**Repository Provider**:
An external service that hosts a Project's repository and change proposals and is authoritative for their current provider state. GitHub is the first supported provider, while Kestrel's retained Review Revision remains authoritative for the exact historical state it analyzed.
_Avoid_: GitHub integration, Git host

**Repository Provider Connection**:
An Operator-configured authorization binding between a Kestrel Installation and a Repository Provider scope, including the repositories and provider capabilities available through that binding. It identifies a concrete provider account, tenant, or installation without making provider-specific identities part of Kestrel's domain model; Review First V1 does not create one.
_Avoid_: Repository Provider type, Project, raw access token

**Provider Observation**:
An Operator-initiated, bounded read of Change Proposal metadata from a Repository Provider through public access or an authenticated provider session already controlled by the local host. It neither supplies a Review Revision nor establishes persistent synchronization authority.
_Avoid_: Provider Synchronization, Repository Provider Connection, source acquisition

**Local Repository Source**:
An Operator-authorized Git repository on the Kestrel workstation that supplies exact commits for every Review First V1 Review Revision. It carries no provider identity itself, never includes uncommitted working-tree state, and remains untouched even when its Change Proposal has optional provider metadata.
_Avoid_: Workspace, Repository Provider Connection, working tree

**Repository Access**:
The declared, capability-bearing way Kestrel can acquire a Project's source. Review First V1 has one such route, a Local Repository Source; optional Provider Observation, source availability, and model access remain separate visible facts.
_Avoid_: Repository Provider Connection, credentials, one connection status

**Provider Synchronization**:
The future read-only reconciliation of a Repository Provider Connection's current Change Proposals and Provider Review Inputs with Kestrel's retained observations. It is not part of Review First V1 and never starts a Conceptual Review or future development work.
_Avoid_: Review Workflow, provider write, automatic code execution

**Operator**:
The human who directs Kestrel and owns consequential review decisions. Review First V1 has one trusted Operator per Kestrel Installation; collaboration and agentic-development authority are reserved for later releases.
_Avoid_: Agent, reviewer, administrator

**Model Provider**:
A configurable source of language-model inference. Kestrel may invoke a Model Provider directly for bounded analysis, while an Agent Runtime may manage its own model relationship.
_Avoid_: Agent Runtime, Repository Provider

**Model Access Availability**:
Whether the exact model-access route selected by an Analysis Configuration can accept work: Available, Waiting for usage reset, Usage limit reached — action required, or Needs authentication. It is independent of review outcome and never authorizes a silent route change, paid fallback, or new workflow.
_Avoid_: Review failure, Resource Envelope, automatic provider fallback

**Resource Envelope**:
The declared resource commitment and terminal boundary for one Conceptual Review analysis. It governs admission and containment without guaranteeing completion; exhaustion may produce a Partial result only when every uncovered area is disclosed.
_Avoid_: Concurrency slot, resource prediction, completion guarantee

**Review Environment**:
The disposable, Kestrel-contained environment in which an Agent Runtime analyzes one exact Review Revision. It separates the model-authenticated runtime supervisor from a lower-authority runner for inspection tools and Review Verification, while Kestrel durable state and the retained Review Revision remain outside its authority.
_Avoid_: Agent Run Sandbox, Operator workstation, shared runtime host

**Review Verification**:
A bounded execution inside the Review Environment's lower-authority runner that runs checks from the Project's exact Verification Profile against a disposable copy of the Review Revision and records their environment and results as Evidence. Source mutation invalidates the check, and speculative fixes are outside Review First V1.
_Avoid_: speculative patching, end-to-end testing, arbitrary runtime permission escalation

**Verification Profile**:
The Kestrel-held, Project-scoped, versioned catalog of checks and validated parameters that an Agent Runtime may select and execute during Review Verification without per-run confirmation, within the applicable Resource Envelope. Only the Operator may authorize new entries; repository content may suggest a check but never grants authority to execute it.
_Avoid_: Repository test configuration, runtime permission prompt, arbitrary shell access

### Reserved future development lifecycle

These terms name planned Kestrel territory beyond Review First V1. They preserve the intended direction without granting V1 scope or implementation authority.

**Development Lifecycle**:
The future progression of intended software work through planning, agentic implementation, review, deployment, and maintenance inside Kestrel.
_Avoid_: Review First V1, pull-request workflow, coding phase

**Work Item**:
The future provider-neutral record that connects intended software work to its Planning Sessions, Agent Runs, Human Gates, and reviews.
_Avoid_: Change Proposal, GitHub Issue, pull request

**Planning Session**:
A future human-led interaction that resolves goals, scope, trade-offs, and critical approvals before delegated development proceeds.
_Avoid_: Review Thread, prompt, task description

**Provider Invocation**:
A future provider-side interaction by an authorized human, such as a command or review conversation, that creates or resumes Kestrel work. It never grants development-execution authority by itself.
_Avoid_: Provider Review Input, Provider Synchronization, Run Trigger, webhook delivery

**Run Trigger**:
The future Operator approval that authorizes one Agent Run from planned work; receiving or synchronizing provider activity is never sufficient.
_Avoid_: Provider Invocation, issue event, automatic issue execution

**Agent Run**:
A future persistent execution in which Kestrel directs an Agent Runtime to modify and validate a Project inside a Kestrel-managed Sandbox.
_Avoid_: Review Workflow, local session, external agent job

**Human Gate**:
A future deliberate pause in an Agent Run where the Operator must resolve a consequential objective, scope, trade-off, or approval.
_Avoid_: Operator Attention, notification, routine confirmation

**Sandbox**:
The future isolated Kestrel environment in which an Agent Run may modify, test, and commit a Project while remaining governed and observable.
_Avoid_: Review Environment, Operator workstation, external coding service
