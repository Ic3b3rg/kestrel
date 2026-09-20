# Paperclip foundation assessment

**Status:** decision-ready foundation assessment

**Date:** 2026-08-16

**Question:** Should Kestrel adopt, fork, integrate, or reference Paperclip?

**Recommendation:** **Reference only for now.** Do not adopt or fork Paperclip, do not run it as a service behind Kestrel, do not implement Kestrel as a Paperclip plugin, and do not initially depend on Paperclip packages.

This recommendation is about architectural fit, not project quality. Paperclip is substantial, active, MIT-licensed software with several patterns Kestrel should test and reuse conceptually. Its core product authority, run lifecycle, trust boundaries, workspace assumptions, and review scope are nevertheless different from Kestrel's.

No new Kestrel ticket is warranted. Route the named patterns and tests in this note into the existing Work Item/Human Gate, Agent Runtime, Sandbox, responsive prototype, and benchmark tickets.

## Evidence boundary

This assessment uses the Paperclip repository at commit [`cd501499a2fa8fd02b64efca3934f0d72a3087bb`](https://github.com/paperclipai/paperclip/tree/cd501499a2fa8fd02b64efca3934f0d72a3087bb), plus first-party GitHub repository metadata and release data already verified for this ticket.

Statements labelled **Fact** describe checked source material or Kestrel's recorded direction. Statements labelled **Inference** are architectural conclusions drawn from those facts.

The assessment does not claim that a repository search proves what every private deployment or future Paperclip version can do. In particular, the checked repository had no matches establishing cgroup enforcement, idle-memory behavior, or a memory-limit implementation. That means there is no published proof in the checked material that Paperclip fits Kestrel's reference resource envelope; it does not prove that Paperclip cannot fit it.

## Decision

| Option | Verdict now | Reason |
| --- | --- | --- |
| Adopt Paperclip as Kestrel's foundation | **Reject** | Kestrel would inherit Paperclip's Company/Agent/Issue/heartbeat authority and then have to replace the core domain, execution trigger, governance, workspace, review, and actor model. |
| Fork Paperclip | **Reject** | MIT permits it, but the required changes cut through core invariants while upstream is moving rapidly. A fork would buy an implementation while assuming a continuing semantic and migration burden. |
| Build Kestrel as a Paperclip plugin | **Reject** | The current plugin boundary is trusted same-origin application code, not security isolation, and plugins cannot replace the core auth, approval, issue, or budget invariants. |
| Run Paperclip as an external execution service | **Reject** | Paperclip and Kestrel would both claim durable authority for work and runs. Synchronizing two state machines would create ambiguous approval, cancellation, retry, identity, and recovery semantics. |
| Import `@paperclipai/adapter-utils` or its ACP engine | **Defer/reject initially** | The package includes a patched pre-1.0 `acpx` and substantial Paperclip-specific policy. Kestrel can evaluate upstream `acpx/runtime` and ACP directly without importing those choices. |
| Reference patterns and executable tests | **Adopt** | Paperclip contains valuable prior art for atomic claims, audit/event structure, approvals, budgets, scoped run credentials, ACP lifecycle handling, workspace round trips, sandbox contracts, and operator UX. |

**Inference:** Reference-only has the best option value. It captures verified design knowledge without making Paperclip's database, domain records, plugin trust model, or patched adapter layer a Kestrel compatibility boundary.

## What Paperclip is

### Project maturity and movement

**Fact:** Paperclip describes itself as a control plane for autonomous AI companies. Its repository is MIT-licensed and was created on 2026-03-02. The checked package version is `0.3.1`; the latest verified release is `v2026.722.0`, published 2026-07-22. See the [repository metadata](https://api.github.com/repos/paperclipai/paperclip), [latest release metadata](https://api.github.com/repos/paperclipai/paperclip/releases/latest), pinned [`package.json`](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/package.json), and pinned [`LICENSE`](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/LICENSE).

**Fact:** The pinned tree contains 4,582 blobs, including 3,312 TypeScript/TSX files, 1,276 files whose paths identify them as tests/specs, 216 SQL migration files, and 41 `package.json` files. These are mechanical path counts, not measures of test quality or architectural complexity. See the [pinned recursive tree](https://api.github.com/repos/paperclipai/paperclip/git/trees/cd501499a2fa8fd02b64efca3934f0d72a3087bb?recursive=1).

**Fact:** More than 400 commits separate the latest verified release tag from the pinned commit. See the [first-party compare result](https://api.github.com/repos/paperclipai/paperclip/compare/v2026.722.0...cd501499a2fa8fd02b64efca3934f0d72a3087bb).

**Inference:** Paperclip is neither a toy nor a quiet dependency. The file, migration, package, and post-release commit counts indicate a broad, fast-moving application. They increase the cost of maintaining a deep fork or coupling Kestrel to internal packages, but do not by themselves imply low quality.

### Product and execution model

**Fact:** Paperclip's primary hierarchy is Company → Agents and org chart/budgets/goals → Issues/Tasks → short heartbeat runs. Agents wake automatically on schedules, assignments, comments, and approval events. It supports multiple companies and multiple human board users. See the pinned [README](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/README.md), [core concepts](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/docs/start/core-concepts.md), and [agent runtime documentation](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/docs/agents-runtime.md).

**Fact:** Its application architecture is Node/Express/React with Postgres, Drizzle, Better Auth, and runtime adapters. Paperclip explicitly claims control-plane responsibility for its agents and companies. See the pinned [architecture documentation](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/docs/start/architecture.md).

**Inference:** Paperclip's heartbeat is not merely a transport session that Kestrel can relabel as an Agent Run. It is nested inside Paperclip's own scheduling, issue, agent, budget, and approval semantics. Replacing those semantics means replacing the application's center of gravity.

### Runtime and sandbox posture

**Fact:** Paperclip documents local agents as running unsandboxed on the host. Separately, it ships remote/cloud/Kubernetes sandbox-provider plugins, signed non-root runtime images, and a sandbox-provider requirements contract. See [agent runtimes](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/docs/agents-runtime.md), the [agent runtime image](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/docker/agent-runtime/README.md), and [sandbox requirements](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/packages/plugins/sandbox-providers/SANDBOX-REQUIREMENTS.md).

**Fact:** Execution workspaces may be durable, reused, or shared until a human closes them. In the documented managed-clone path, repository credentials and Git operations are GitHub-specific, and an agent may need a push token. See [execution workspaces and runtime services](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/docs/guides/board-operator/execution-workspaces-and-runtime-services.md).

**Inference:** Paperclip's sandbox-provider work is valuable prior art, but the default local posture and workspace lifecycle do not establish Kestrel's mandatory disposable, isolated Sandbox invariant. Kestrel must independently own isolation, egress, credentials, cleanup, and evidence retention.

### ACP and adapter implementation

**Fact:** Paperclip publishes `@paperclipai/adapter-utils` version `0.3.1`. It bundles `acpx` `0.12.0`, carries a repository patch for it, and implements a large Paperclip-specific ACP execution engine. Its Codex-local adapter retains adapter-specific authentication, home-directory, and configuration seams. See [`adapter-utils/package.json`](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/packages/adapter-utils/package.json), the [`acpx` patch](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/patches/acpx@0.12.0.patch), the [ACP engine entry point](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/packages/adapter-utils/src/acpx-engine/execute.ts), and the [Codex ACP adapter](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/packages/adapters/codex-local/src/server/acp.ts).

**Inference:** `adapter-utils` is not a neutral ACP SDK boundary merely because it is separately packaged. Depending on it would import a patched pre-1.0 dependency plus Paperclip lifecycle and policy decisions. Kestrel should first test upstream `acpx/runtime` against its own Agent Runtime Port, as already recommended in [Choose the Agent Runtime interoperability boundary](https://github.com/Ic3b3rg/kestrel/issues/25#issuecomment-5307919342).

### Plugin, authentication, and deployment boundaries

**Fact:** Paperclip's current plugin UI is trusted, same-origin code. Plugin capability gates do not prevent that UI code from calling ordinary HTTP APIs. The current deployment model assumes a persistent writable filesystem, and plugins cannot override core authentication, approval, issue, or budget invariants. See the pinned [plugin specification](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/doc/plugins/PLUGIN_SPEC.md).

**Fact:** Paperclip supports a `local_trusted` mode without login and Better Auth authenticated modes that may be private or public and may include multiple board users. See [deployment modes](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/docs/deploy/deployment-modes.md) and [API authentication](https://github.com/paperclipai/paperclip/blob/cd501499a2fa8fd02b64efca3934f0d72a3087bb/docs/api/authentication.md).

**Inference:** A Paperclip plugin is an extension boundary, not a security boundary or domain-authority boundary. Kestrel-as-plugin would still live under Paperclip's core records and invariants while loading privileged UI code into the same origin.

## Kestrel's required center of gravity

**Fact:** Kestrel is organized around Installation → Project (one repository) → Work Item → Planning Session → explicit Run Trigger → durable Agent Run → Human Gate → Conceptual Review. The first release has one trusted Operator. Kestrel owns durable Agent Run state and governance; the selected Agent Runtime owns its native loop through the sole initial ACP v1 adapter. See [Map Kestrel from Review First to the complete AI-native SDLC](https://github.com/Ic3b3rg/kestrel/issues/1) and [Choose the Agent Runtime interoperability boundary](https://github.com/Ic3b3rg/kestrel/issues/25#issuecomment-5307919342).

**Fact:** Review First is strict about exact immutable Review Revisions. Conceptual Review is an evidence-bearing Kestrel artifact, not a generic diff review or merge verdict. A Run Trigger is an explicit Operator approval; receiving or synchronizing an external issue never starts an Agent Run.

**Fact:** An Agent Run executes in a disposable Kestrel-managed Sandbox. The ticket baseline uses a reference host envelope of 4 vCPU, 8 GB RAM, and 75 GB storage.

**Fact:** Searches of the pinned Paperclip repository found no Kestrel-specific Conceptual Review, Review Revision, or Change Intent terms. Paperclip also states that it is not a code review tool. This is a scope observation, not a criticism: the two products are solving different central problems.

## Exact mismatch matrix

| Dimension | Kestrel invariant or initial scope | Paperclip at the pinned revision | Consequence |
| --- | --- | --- | --- |
| Top-level domain | One Installation governs Projects, each representing one repository. | Companies organize agents, goals, budgets, and issues. | Adoption makes Paperclip's company ontology primary or requires invasive replacement. |
| Human model | One trusted Operator initially; later collaboration is an explicit evolution. | Multiple humans and board-user modes are first-class. | Auth, authorization, attribution, and UI assumptions differ at the root. |
| Work authority | A provider-neutral Work Item links planning, runs, gates, and review. | Issues/tasks are the primary units assigned through company/agent structures. | A mapping would be lossy or duplicate authority unless one model is subordinated. |
| Start authority | Only an explicit Operator Run Trigger begins an Agent Run. | Schedules, assignments, comments, and approvals can automatically wake agents. | Paperclip's normal automation can violate Kestrel's explicit-start invariant. |
| Run identity | Agent Run is durable Kestrel state independent of clients and runtimes. | Work proceeds through short heartbeat runs controlled by Paperclip. | Treating heartbeats as Agent Runs leaks scheduling and retry policy into Kestrel. |
| Agent loop | The selected Agent Runtime owns its native loop behind Kestrel's port. | Paperclip adapters and ACP engine participate in its own heartbeat/runtime policy. | Reuse above the wire layer risks two orchestrators controlling one loop. |
| Human intervention | A Human Gate is a deliberate pause for consequential scope, objective, trade-off, or approval decisions. | Approvals are Paperclip core events and can themselves trigger wakeups. | Approval records and resume authority cannot be treated as equivalent without a proof-level mapping. |
| Review | Exact-revision Conceptual Review evaluates Change Intent, flows, evidence, risk, and coverage. | Paperclip disclaims being a code review tool; checked terms do not establish Kestrel's review objects. | Review First would be a new core subsystem, not a plugin-sized feature. |
| Sandbox default | Every Agent Run is isolated in a Kestrel-managed disposable Sandbox. | Local agents are documented unsandboxed; separate sandbox providers exist for remote/cloud/Kubernetes execution. | Kestrel cannot inherit local execution defaults and must certify containment independently. |
| Workspace lifetime | Sandbox/worktree lifetime is bounded by the Agent Run and Kestrel retention policy. | Workspaces may persist, be reused/shared, and remain until human closure. | Reuse expands credential, contamination, concurrency, and cleanup semantics. |
| Repository boundary | Project is provider-neutral in domain; GitHub is only the first Repository Provider. | The documented managed-clone and credential path is GitHub-specific and may grant push tokens. | Direct reuse would couple domain behavior to one provider and broaden agent credentials. |
| Plugin trust | Extensions must not bypass Kestrel governance or become an implicit security boundary. | Plugin UI is trusted same-origin code; capability gates do not block normal API calls. | Kestrel governance cannot be safely implemented as an untrusted or confined plugin. |
| Core invariants | Kestrel must own Run Trigger, Human Gate, durable run state, and exact-revision review. | Plugins cannot override Paperclip's core auth, approval, issue, or budget invariants. | The necessary substitution is explicitly outside the plugin contract. |
| Authentication | Initial scope is one trusted Operator with Kestrel-owned governance. | Modes range from no-login `local_trusted` to Better Auth private/public multi-user boards. | Adopting either mode imports assumptions that Kestrel has not selected. |
| Filesystem/deployment | Disposable Sandboxes and controlled retained artifacts; control-plane persistence is a separate concern. | Current plugins assume a persistent writable filesystem. | Stateless/immutable deployment and cleanup boundaries would need redesign. |
| Resource envelope | Reference host is 4 vCPU, 8 GB RAM, 75 GB; admission and containment must be measurable. | No checked evidence establishes cgroup, idle-memory, or memory-limit behavior or measured fit. | Resource fit is unknown and must be benchmarked; it cannot be assumed from feature completeness. |
| Adapter dependency | ACP v1 is the sole initial adapter behind a Kestrel-owned port. | `adapter-utils` embeds patched `acpx` 0.12.0 and Paperclip-specific execution policy. | Importing it creates an avoidable transitive policy and upgrade boundary. |

## Why the counterproposals do not change the verdict

### “Implement Kestrel as a Paperclip plugin”

**Fact:** Plugins cannot override the core auth, approval, issue, or budget invariants, and their same-origin UI is trusted application code rather than isolated capability code.

**Inference:** The plugin would be able to add surfaces and integrations, but it could not make Kestrel authoritative for Work Items, Run Triggers, Agent Runs, Human Gates, or exact Review Revisions. It would either simulate those records beside Paperclip's records or patch core Paperclip behavior. The first creates split truth; the second is effectively a fork.

Security isolation is a second blocker. A capability declaration that does not constrain ordinary same-origin API access cannot enforce a least-privilege Kestrel extension boundary.

### “Use Paperclip as an external run service”

**Fact:** Both products claim control-plane responsibility for durable work execution.

**Inference:** A service integration would require a distributed state-machine protocol covering at least:

- authoritative run identity and idempotent creation;
- start authorization and replay protection;
- Paperclip heartbeat-to-Agent Run event mapping;
- Human Gate and approval ownership;
- cancellation acknowledgement versus actual process termination;
- retry ownership and duplicate side-effect handling;
- workspace, commit, and artifact provenance;
- identity, token scope, and credential revocation;
- crash recovery, reconciliation, and terminal-state conflicts.

That protocol would be more consequential than an ACP adapter and would preserve two authorities instead of simplifying Kestrel. Paperclip becomes a viable service only after a stable extracted execution boundary makes one side unambiguously subordinate.

### “Depend only on Paperclip's adapter package”

**Fact:** The package boundary carries a Paperclip-specific ACP engine, a repository patch to `acpx` 0.12.0, and vendor-specific auth/home/config seams.

**Inference:** Selective import looks smaller than platform adoption but creates a source-level compatibility promise to internal lifecycle policy. Because both the package and bundled `acpx` are pre-1.0, Kestrel would need to pin exact versions and patch state, audit every upgrade, and maintain an exit adapter. Direct evaluation of upstream `acpx/runtime` or the official ACP SDK tests the relevant layer with less coupling.

## Reusable prior art and where it belongs

Reference-only should produce executable Kestrel requirements, not copied abstractions.

| Existing Kestrel ticket | Paperclip prior art to carry forward | Concrete Kestrel test or artifact |
| --- | --- | --- |
| [Define the Work Item lifecycle and Human Gate policy](https://github.com/Ic3b3rg/kestrel/issues/11) | Atomic checkout/claim behavior and explicit blocker records | Race two workers against one eligible Work Item; exactly one acquires it. Record losing claims, blockers, gate creation, Operator decision, and idempotent resume in the audit history. |
| [Define the Work Item lifecycle and Human Gate policy](https://github.com/Ic3b3rg/kestrel/issues/11) | Approval execution policy | Prove that approval is bound to exact action, actor, scope, and current Run state; stale, replayed, broadened, or revoked approval cannot resume execution. |
| [Define the Work Item lifecycle and Human Gate policy](https://github.com/Ic3b3rg/kestrel/issues/11) | Cost and budget hard stops | Cross a configured limit during a run; stop new chargeable work, preserve an honest terminal/gated state, and never represent unknown usage as zero. |
| [Define the Agent Runtime execution boundary](https://github.com/Ic3b3rg/kestrel/issues/12) | Run/event/audit patterns | Characterize ordered, duplicate, late, and missing events; retain Kestrel run identity and terminal outcome across runtime crash, reconnect, cancellation, and process-kill escalation. |
| [Define the Agent Runtime execution boundary](https://github.com/Ic3b3rg/kestrel/issues/12) | Short-lived run JWTs and scoped secret access | Verify audience, Run/Project scope, expiry, rotation, revocation, and denial after terminal state; a runtime cannot use one Run's token for another Project or workspace. |
| [Define the Agent Runtime execution boundary](https://github.com/Ic3b3rg/kestrel/issues/12) | Paperclip's `acpx` lifecycle handling | Add comparison cases to the existing direct-ACP versus `acpx/runtime` spike: initialization, auth, session load, streaming, permission mediation, cancel race, crash, and cleanup. Use behavior as evidence, not Paperclip types as the port. |
| [Choose the disposable Sandbox isolation and repository execution model](https://github.com/Ic3b3rg/kestrel/issues/13) | Sandbox-provider requirements, signed non-root images, and network-policy examples | Convert each useful requirement into a Kestrel-owned conformance case: non-root process, bounded filesystem, explicit egress, secret mount scope, kill/cleanup, image provenance, and denial evidence. |
| [Choose the disposable Sandbox isolation and repository execution model](https://github.com/Ic3b3rg/kestrel/issues/13) | No-remote-git workspace round trip | Clone/fetch outside the runtime credential boundary, run with no remote Git credentials, export commit/artifacts, and prove cleanup leaves no token, remote helper, or writable shared workspace behind. |
| [Choose the disposable Sandbox isolation and repository execution model](https://github.com/Ic3b3rg/kestrel/issues/13) | Contrast between unsandboxed local agents and isolated providers | Run a negative test with a runtime that bypasses ACP file/terminal requests; OS containment must still deny host and cross-Project access. |
| [Prototype the thin end-to-end mobile development loop](https://github.com/Ic3b3rg/kestrel/issues/14) | Responsive operator views and real-time run state | Exercise claim, progress, Human Gate, approval, reconnect, cancellation, and terminal evidence on narrow and wide viewports; no consequential decision may depend on a continuously connected initiating device. |
| [Benchmark the runtime boundaries and implementation languages](https://github.com/Ic3b3rg/kestrel/issues/17) | Repository scale and execution behavior as a comparison fixture | Use a pinned Paperclip revision as one public large TypeScript/Postgres fixture, while measuring checkout, indexing, run startup, event throughput, cleanup, disk peak, idle/active memory, and CPU under Kestrel's 4-vCPU/8-GB/75-GB envelope. |

These are inputs to existing tickets, not a request to reproduce Paperclip. The owning Kestrel ticket should cite the exact Paperclip behavior it adopts, restate the Kestrel invariant, and keep the acceptance test independent of Paperclip's database or packages.

## License, churn, upgrade, and migration consequences

### License

**Fact:** Paperclip is MIT-licensed.

**Inference:** MIT permits use, modification, distribution, and forking, subject to preserving the required copyright and license notice. It lowers legal friction but says nothing about architectural fit, trademark/product identity, third-party dependency licenses, or operational security. Any copied code still needs provenance and dependency-license review.

Reference-only has minimal license burden when Kestrel re-expresses patterns as independently written requirements and tests. Copying implementation code or container assets should trigger a file-level provenance and notice check.

### Churn and upgrades

**Fact:** The project has 41 package manifests, 216 SQL migrations, and more than 400 commits after the latest verified release; its checked package and bundled `acpx` versions are pre-1.0.

**Inference:** A fork would need either frequent rebases across broad application changes or deliberate divergence with internal ownership of security fixes. An embedded service would require coordinated application, schema, auth, plugin, runtime-image, and adapter upgrades. A package dependency would be narrower, but Paperclip's patch and policy engine make even that upgrade more than a semver bump.

The two Paperclip version schemes visible here—package `0.3.1` and calendar-like release `v2026.722.0`—also require explicit compatibility mapping. Kestrel must not infer package/API compatibility from the application release name.

### Migration and exit cost

Adoption or service integration would create migration obligations for:

- Company/Agent/Issue identifiers versus Installation/Project/Work Item identifiers;
- heartbeat histories versus durable Agent Run events and outcomes;
- Paperclip approvals versus Kestrel Human Gates;
- persistent/shared workspaces versus disposable Sandbox artifacts;
- Better Auth users and board roles versus the initial Operator model;
- GitHub clone credentials versus Repository Provider-neutral records;
- Paperclip plugin and SQL schema evolution;
- patched ACP session state versus Kestrel's runtime-port contract.

**Inference:** These are bidirectional semantic migrations, not only database transforms. Several mappings are many-to-one or authority-sensitive, so rollback could not be guaranteed by preserving columns alone. Reference-only creates no production-data migration and leaves Kestrel free to change implementation while its domain remains stable.

## Confidence and limitations

| Conclusion | Confidence | Basis and limit |
| --- | --- | --- |
| Reference-only is the correct decision now | **High** | Core start, run, gate, review, plugin, and workspace mismatches are explicit in first-party sources and Kestrel's domain context. |
| Adopting or forking would require core changes | **High** | The mismatches concern authoritative records and invariant ownership, not isolated UI or adapter seams. Exact engineering effort was not estimated. |
| Plugin integration cannot provide Kestrel's governance boundary | **High** | The plugin specification explicitly preserves core invariants and treats same-origin UI as trusted. Future plugin designs may differ. |
| External-service integration would create dual authority | **High** | Both systems claim control-plane state. A future extracted subordinate execution API could falsify this. |
| Direct upstream ACP evaluation is safer than an initial `adapter-utils` dependency | **Medium-high** | The patch and Paperclip engine are visible; only a Kestrel spike can measure how much useful adapter work they remove. |
| Paperclip fits Kestrel's resource envelope | **Unknown** | No checked published evidence establishes cgroup/idle-memory/memory-limit behavior or measured operation within the reference host. |
| Paperclip patterns will improve Kestrel | **Medium** | They are strong executable prior art, but value must be demonstrated by Kestrel-owned conformance tests rather than assumed from implementation maturity. |

This note did not run Paperclip, benchmark it, audit every dependency, assess vulnerability history, or prove behavioral correctness. Tree counts measure repository shape only. Repository searches are scoped to the pinned snapshot. Auth, plugin, adapter, and deployment behavior can change and must be re-attested if Paperclip is reconsidered.

## Falsifiers and reconsideration triggers

Reopen the adopt/integrate decision only if one or more of these become true and are demonstrated against Kestrel's invariants:

1. **Security-isolated extension boundary:** Paperclip publishes a stable plugin/SDK boundary whose server and UI permissions are technically enforced, whose code cannot bypass capability checks through same-origin APIs, and which permits Kestrel to own its core records and policies.
2. **Measured resource fit:** A reproducible benchmark on the 4-vCPU/8-GB/75-GB reference host establishes startup, active and idle memory, CPU, disk peak, cleanup, and concurrency behavior with enforceable limits.
3. **Domain-authority extraction:** Paperclip extracts a subordinate execution kernel with idempotent start, ordered/replayable events, explicit gate handoff, cancellation escalation, artifact provenance, and no independent Issue/approval/run authority.
4. **Stable generic ACP module:** The useful ACP engine becomes a documented, stable, generic module without Paperclip policy, private schema assumptions, or a repository-local patch; it passes Kestrel's direct-ACP conformance suite and has a credible compatibility policy.
5. **Review-domain convergence:** Paperclip introduces exact immutable revision identity, source-backed Change Intent, Conceptual Review evidence/coverage semantics, and authority rules compatible with Kestrel rather than merely adding a diff-review screen.
6. **Workspace and credential convergence:** A certified local path makes disposable isolation the default, keeps repository credentials outside the agent, supports provider-neutral acquisition/export, and proves cleanup and cross-Project separation.
7. **Churn stabilizes behind contracts:** Application and package releases publish compatibility guarantees, migration/rollback guidance, and supported upgrade windows sufficient for a downstream foundation or service dependency.

Failure of any single falsifier does not condemn Paperclip as a product. It only means the evidence is still insufficient to move it from reference implementation to Kestrel substrate.

## Final disposition

Record Paperclip as **reference prior art**, not a dependency or runtime service.

Carry forward these named pattern families: atomic checkout and blockers; durable run/event/audit records; approval execution policy; cost/budget hard stops; short-lived run JWTs and scoped secrets; ACP lifecycle characterization; no-remote-git workspace round trip; sandbox requirements, images, and network policies; and responsive operator UX.

Feed their Kestrel-owned tests into the existing Work Item/Human Gate, Agent Runtime, Sandbox, responsive prototype, and benchmark tickets. **Create no new ticket for Paperclip.**
