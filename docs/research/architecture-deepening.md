# Architecture deepening: ownership and protocol boundaries

Checked 2026-09-23 against Kestrel `9e6c846`, the supplied architecture handoff,
and the primary sources below. This is implementation research for the seven accepted
candidates, not a replacement product specification. [ADR 0003](../adr/0003-use-codex-app-server-for-the-subscription-route.md),
[ADR 0004](../adr/0004-deliver-the-factory-v01-loop.md), and the
[Factory specification](../factory-v01/spec.md) remain authoritative. Earlier
[ACP-first research](agent-runtime-interoperability-landscape.md) predates ADR 0003;
its proposed Codex routing is superseded.

## What the external sources actually establish

| Source facts | Application to Kestrel (recommendation) |
| --- | --- |
| OpenHands makes configuration/components immutable and validates them at construction; conversation state is its one mutable authority. It separates agent core, tools, workspace, and server. Its default isolation is optional. [Design principles](https://docs.openhands.dev/sdk/arch/design) | Borrow explicit ownership and validated configuration. Keep PostgreSQL authoritative for Kestrel and preserve mandatory external containment for untrusted execution. Do not import OpenHands' conversation state or isolation default. |
| Fabro CLI and server use one engine. It validates graph structure before execution, dispatches nodes to handlers, checkpoints stages, emits structured events, and bounds retries. [Execution model](https://docs.fabro.sh/core-concepts/how-fabro-works) | Compose one Factory background runtime from the existing web process. Centralize graph semantics and recovery; do not add another workflow engine or change process placement merely to shorten files. |
| ATP stores a task graph in a shared JSON file, distinguishes artifacts from reports, and describes claim-based execution and bounded future replanning. The repository supplies schema/prompts/skills, not a hosted runtime. [Repository](https://github.com/manuelcecchetto/atp) Its schema types dependencies as string arrays; it does not enforce reference existence, acyclicity, or atomic claims. [Schema](https://github.com/manuelcecchetto/atp/blob/main/atp_schema.json) | Borrow explicit graph validation, claims, and report/artifact separation. Implement semantic graph checks separately. Keep approved plans immutable and claims transactional in PostgreSQL. ATP is direct prior art, not evidence of an established interoperable runtime standard. |
| ACP defines client/agent methods, notifications, capabilities, sessions, permissions, filesystem/terminal operations, and cancellation. Loading sessions is optional. [Protocol overview](https://agentclientprotocol.com/protocol/v1/overview) | ACP is a possible future runtime adapter. It supplies neither Kestrel's workflow authority nor proof that a writer stopped. Keep wire sessions and requests out of domain authority. |
| Codex App Server uses bidirectional JSON-RPC messages without the `jsonrpc` header; stdio carries newline-delimited JSON. It requires `initialize` then `initialized`; turns finish through a terminal notification. `externalSandbox` delegates enforcement to the surrounding sandbox. [App Server](https://developers.openai.com/codex/app-server) | Keep direct App Server under ADR 0003. Share transport mechanics while retaining separate inspection, planning, execution, and review policies. A terminal turn or child-process exit does not release Sandbox ownership. |

Local inspection ran `codex --version`, `codex app-server --help`, and
`codex app-server generate-json-schema --help` before consulting Codex web documentation.
The installed host CLI reports **0.156.1**; the existing
[execution contract](factory-execution-runtime-contract.md) records **0.155.1**.
No thread, authentication flow, model call, or schema generation was run for this research.
Current online fields must not silently change a certified runtime profile: validate the
selected binary/executor pair and preserve existing version-policy tests. This research does
not certify a new version.

## Sandbox lifecycle: settle the ten handoff questions

The existing implementation already contains the critical safety behavior in
[the container runtime](../../apps/web/src/codex-execution-runtime.ts),
[durable execution operations](../../packages/database/src/factory-execution.ts),
[recovery](../../packages/database/src/factory-execution-recovery.ts), and
[Feature workspace custody](../../packages/local-source/src/feature-workspace.ts).
Deepening should move their orchestration behind one boundary without replacing these
mechanisms. The following are recommendations derived from those contracts.

1. **Sole owner.** An Agent Run Sandbox lifecycle module owns workspace custody and the
   ordering of container reservation, identity, stop proof, and checkpoint operations.
   Its PostgreSQL persistence boundary is the sole durable writer of those facts; the
   runtime reports observations through private callbacks. Scheduling, prompts, Human Gate
   meaning, provider publication, and merge remain outside.
2. **Before effects.** Persist the owned run/frozen source and runtime profile first, then
   the unique container name, phase, and selected daemon identity before Docker create.
   Persist the exact container ID before starting its tool server. Commit a stop fence
   before recovery probes. Record discovered identity before removal so a later recovery
   can recognize the same absent container. Never reconstruct authority from a model
   response, heartbeat, path, or container name alone.
3. **Workspace handoff.** Preserve one independent cumulative Feature checkout and branch.
   The lifecycle privately opens/reopens it using frozen source identity and expected
   checkpoint, passes paths only to trusted adapters, stops all implementation writers,
   then invokes the existing Git snapshot/checkpoint API. Persist the resulting exact
   commit/tree through the current compare-and-set transition. Reuse its deterministic
   checkpoint identifier/preparation record after a crash between Git and PostgreSQL;
   there is no cross-system atomic transaction.
4. **Stop result.** Make evidence explicit, for example `confirmed_removed`, `never_created`,
   and `unconfirmed`. Removed means the owned container identity was proved absent on the
   selected daemon; never-created requires proof that creation was not issued, or an empty
   durably fenced lifecycle. `unconfirmed` retains the Project reservation. A name lookup
   returning nothing is insufficient after an ambiguous create. Preserve the existing
   inert-name barrier/reconciliation path and its delayed-create regression tests.
5. **Cancellation.** Cancellation withdraws new-work authority immediately. Identity
   callbacks may still retain a container discovered during cancellation for teardown,
   but cannot authorize its start, a new container, a checkpoint success, or another
   command. Cleanup receives its own bounded deadline rather than the already-aborted
   work signal. Retain final evidence from an already-started verification when available;
   cancellation cannot become a successful execution outcome.
6. **Safe repeats.** Repeat identity probes, exact-ID teardown, stop-witness persistence,
   and the same prepared Git checkpoint. Reconcile an unknown model/verification outcome;
   do not replay `runTurn` or an arbitrary verification command automatically. Retry
   remains the existing domain decision after confirmed stop and the applicable gate.
7. **Identity mismatch.** Bind container identity to its daemon, name, exact ID, image, and
   ownership label. Reject a different daemon, conflicting ID/name, or unverified owner.
   Do not stop another owner's container or interpret an empty second daemon as successful
   cleanup. Preserve the existing checks around destructive operations.
8. **Failure ownership.** Return bounded failure facts to the existing Agent Run transition
   owner. Keep authentication, source mismatch, permission, verification, and timeout gate
   behavior unchanged. Stop uncertainty always dominates release. No generic retry engine
   should reinterpret an uncertain side effect as a transient failure.
9. **Paths.** Public lifecycle results carry source/checkpoint identities, bounded activity,
   verification evidence, and teardown facts. Host workspace/Git paths stay in the private
   adapter seam. Preserve evidence redaction and operator-checkout integrity tests. Avoid a
   generic resource handle framework when a closed workspace object suffices.
10. **Planning/review reuse.** Share transport and low-level containment mechanics only.
    Planning cannot acquire execution authority by receiving a reusable writable handle;
    review remains attached to its exact read-only revision. Distinct policies and authority
    ceilings survive any common infrastructure.

The successful ordering is: claim → open exact cumulative workspace → durably reserve →
identify → contained turn → confirmed teardown → checkpoint → each approved command in a
fresh container → confirmed teardown → compare source to that checkpoint → atomic outcome.
The existing [processor](../../apps/web/src/factory-execution-processor.ts) is the behavioral
reference; verification output from a changed tree cannot certify the earlier checkpoint.

Docker creates a container without starting it, enabling durable identity to be recorded
before execution; this does not by itself establish Kestrel ownership or crash recovery.
[Docker create](https://docs.docker.com/reference/cli/docker/container/create/)
`--network none` provides only a loopback interface. It complements the existing read-only
root, non-root user, dropped capabilities, resource bounds, controlled mounts, and absent
Docker socket; it does not replace them.
[Docker none network](https://docs.docker.com/engine/network/drivers/none/)

## One Codex transport, distinct runtime policies

The duplication is concrete: [AppServerSession](../../apps/web/src/codex-app-server.ts)
and [CodexFactoryTransport](../../apps/web/src/codex-factory-transport.ts) both spawn a
child, restrict its environment, bound output, correlate one pending request, and close
the process. They differ in parsing, error translation, streaming, and shutdown handling.
These are Kestrel source facts, not protocol requirements.

Recommended common adapter responsibilities:

- Incremental UTF-8 JSONL framing, total/line/stderr byte bounds, validated message envelopes,
  pending-request settlement, and controlled process cleanup.
- Distinguish responses from server requests: `id` plus `method` is a request requiring
  policy handling, not a mismatched response. Unknown notifications may be ignored after
  envelope validation; unexpected authority requests must not be silently approved.
- Own handshake and version validation once at the vendor adapter boundary. Keep
  inspection-specific response validation and error mapping separate from Factory policy.
- Preserve the current serialized client-request constraint unless a real consumer needs
  concurrency. Do not build a general RPC framework or promise cancellation by deleting
  a pending request. All outstanding operations must settle on error, timeout, abort,
  or child exit.
- Keep bounded interrupt/close as protocol/process cleanup. Its result cannot certify
  tool-descendant termination; only the Sandbox lifecycle may release writer ownership.
  Preserve the existing distinction between pre-operation unavailability and interrupted
  work, along with late-event and pipe-retention tests.
- Route permission and user-input requests through each runtime's existing policy. Retain
  host-owned subscription authentication and the contained execution tool channel. Never
  persist arbitrary vendor payloads or credential-bearing configuration in domain state.

Conformance fixtures should cover split UTF-8/frame delivery, malformed/oversized frames,
wrong/duplicate IDs, response error/result ambiguity, unsolicited requests, notifications,
abort before spawn/start/completion, timeout, unexpected exit, and shutdown with open pipes.
Then migrate inspection, planning, execution, and review without changing policy expectations.
One representative live happy path proves the selected profile; deterministic fixtures
prove failure/race paths. ACP's cancellation handshake also requires the agent to finish
the original prompt response; cancellation is not synchronous destruction of external
resources. [ACP prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)

## Boundaries for the remaining candidates

These are recommendations from the accepted handoff, constrained by the repository contracts
above; none requires importing the compared platforms.

| Candidate | Owner and observable deletion test |
| --- | --- |
| Factory background runtime | One module builds processors, reconciles before acceptance, registers consumers, prevents overlapping timers, and performs ordered shutdown. Web remains the composition root initially. Removing the module would redistribute orchestration across entry points. |
| Feature Plan graph | One provider-neutral module validates dependencies/acyclicity and derives eligibility/blockers consistently for scheduler and board. PostgreSQL still controls reservation concurrency. Provider bindings cannot mutate an approved graph; presentation columns are not execution authority. |
| Durable Agent Run transitions | Use named domain transitions under existing Feature/run locks for outcome, Work Item, gate/correction, and append-only activity. Both live and recovery paths call these transitions. External Docker/Git/provider calls remain outside database transactions. Avoid generic repositories and per-table public setters. |
| Project Board read | One backend read returns Kestrel cards and a bounded provider catalog with explicit freshness, provenance, deduplication, truncation, and partial failure. Provider failure leaves Kestrel cards usable. The PWA owns navigation/cancellation and retained display, not provider paging or plan semantics. Reconcile existing #259 work before replacing consumers. |
| Settings routes | The authenticated shell owns session actions, the project URL owns Project settings, and global Settings owns installation/model/Skills concerns. Move data/command ownership together with views. Preserve existing ticket scope (#253, #256, #254, #255); do not invent a generic settings framework. |

## Decisions and evidence still required

There is **no newly unresolved consequential product choice blocking these behavior-preserving
extractions**. Existing authority settles cumulative checkout, one logical Work Item at a time,
fresh containers, PostgreSQL, direct App Server, immutable approval, and route scope. Interface
names, file placement, and typed result shape can be selected by implementation and tested.

Changing concurrency within a Feature, introducing automatic approved-plan mutation, replacing
the workflow authority, changing credential custody, relaxing containment, or relocating the
runtime with new availability promises would be separate product decisions. They are outside
this program. A discovered inability to preserve an accepted invariant warrants a focused
question; prior-art preference alone does not.

This note establishes design evidence only. It does not prove the new lifecycle or transport.
Retain existing regression assertions, add fault points after durable effects, test PostgreSQL
rollback/concurrent ownership against final facts, and exercise the exact Factory entry point
on the integrated tree. No implementation or live-runtime verification occurred in this
research task.
