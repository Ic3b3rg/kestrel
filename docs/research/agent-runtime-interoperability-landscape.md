# Agent runtime interoperability landscape

**Status:** agent-agnostic direction recorded; ACP v1 selected as the sole initial local-agent adapter

**Date:** 2026-08-16

**Scope:** self-hosted Kestrel, coding-agent interoperability, subscription/OAuth reuse, sandboxed Agent Runs

## Research question

Is there an existing protocol, SDK, runtime, or self-hosted platform that gives Kestrel a better agent-agnostic foundation than building provider and agent integrations independently?

Sources were checked on 2026-08-16. Protocols, adapters, authentication methods, licenses, and preview status are mutable and require re-attestation before implementation.

## Executive finding

No current open, cross-vendor protocol is demonstrably better than stable **ACP v1** as Kestrel's **initial boundary for local coding agents**. That is narrower than making ACP the architecture: **ACP is not Kestrel's domain contract or durable Agent Run model**. Kestrel should own a small Agent Runtime Port implemented initially by one ACP adapter. Native vendor protocols remain comparison surfaces and a future escape hatch for a proven required gap, not parallel adapters to build pre-emptively.

Three narrower alternatives can already beat ACP for a particular choice:

- **Codex App Server** exposes more Codex-specific lifecycle, diff, approval, sandbox, account, and ChatGPT-subscription state than an ACP bridge.
- The **GitHub Copilot SDK protocol** is now GA, has richer per-session configuration than Copilot's public-preview ACP server, and officially supports a GitHub OAuth app acting on behalf of users against their Copilot subscriptions.
- The **OpenCode server API** is a strong self-hosted HTTP/OpenAPI runtime if Kestrel deliberately chooses OpenCode as its one built-in coding agent. It does not make Codex, Claude Code, Copilot CLI, and Gemini CLI interchangeable agents.

These are vendor/runtime-specific wins, not a universal boundary. CAP is the strongest new cross-agent counterproposal because it targets orchestrator-to-CLI-agent control and uses PTY as a universal fallback, but its v1 is a draft with a reference implementation still in progress and no independent implementations. LangChain Agent Protocol is a serious candidate for durable remote agent services, not for supervising subscription-backed local coding CLIs.

There is still no one library or platform that should replace the whole Kestrel architecture. ACP is a transport and session protocol, not a durable development lifecycle. `acpx` is a focused ACP client/runtime, not a Kestrel control plane. OpenHands, SAM, Sesame, Handler, OpenACP, OpenCode, and OpenClaw are useful prior art or possible product foundations, but adopting any of them wholesale would also adopt their workflow, state, permission, deployment, and product assumptions.

The recommended split is therefore:

```text
Kestrel durable control plane
  - Work Item, Planning Session, Agent Run, Human Gate
  - Sandbox ownership, credentials, policy, audit, artifacts
  - durable state and cancellation escalation

  -> Agent Runtime Port
       -> sole initial implementation: ACP v1 adapter
            -> initially evaluate acpx/runtime
            -> upstream ACP servers for Codex, Claude Code, Copilot, Gemini, ...
       -> no native vendor adapter initially
       -> reconsider the boundary only for a proven required ACP gap
            or a future remote-agent requirement
       -> watch CAP, LangChain Agent Protocol, A2A and MCP Agents;
            depend on none of them initially

  -> Model Inference Port
       -> strict stateless adapters for Review First
       -> OpenResponses-inspired request/result vocabulary where useful
```

This revises the earlier direction in two important ways: Kestrel should not write a complete ACP client, session manager, and adapter-normalization layer from scratch before testing `acpx/runtime`, and it should not let ACP types become the Agent Runtime Port merely because ACP is the first adapter.

## Why ACP is the leading boundary

[ACP v1](https://agentclientprotocol.com/protocol/v1/overview) is specifically designed for communication between a client and a coding agent. It uses JSON-RPC 2.0 and covers initialization and capability negotiation, agent-mediated authentication, new and loadable sessions, streamed messages and tool updates, file and terminal requests, permission requests, modes and configuration, plans, elicitation, and cancellation.

The fit is materially closer than a generic LLM SDK:

- Local agents normally run as subprocesses over stdio, which matches a Kestrel-managed Sandbox.
- Authentication is advertised by the agent and performed through an agent-defined flow. This can preserve a vendor's native login where both the adapter and vendor terms support it, instead of pretending subscription credentials are generic API keys. See [ACP authentication](https://agentclientprotocol.com/protocol/v1/authentication). It does not itself create a right to reuse every consumer subscription: Anthropic's [Agent SDK terms guidance](https://code.claude.com/docs/en/agent-sdk/overview) explicitly says third parties may not offer `claude.ai` login or rate limits without prior approval.
- The client owns resource access and answers permission requests, providing a policy mediation point.
- Capabilities are negotiated rather than assumed, so Kestrel can fail closed when an Agent Runtime Profile lacks a required operation.
- The [ACP registry](https://agentclientprotocol.com/get-started/registry) lists a broad coding-agent ecosystem rather than a single vendor SDK.

Two directly relevant implementations already expose subscription-backed agents:

- [`codex-acp`](https://github.com/agentclientprotocol/codex-acp) maps Codex App Server to ACP and supports ChatGPT login as well as API-key and custom-gateway authentication.
- [GitHub Copilot CLI's ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) runs with GitHub Copilot authentication or BYOK and supports stdio or TCP. It is still public preview, and some controls are process-launch options rather than portable per-session settings.

ACP does **not** make subscription access universal. Each agent and account must support its own login and terms. Its value is that Kestrel can delegate authentication to the native agent without coupling the control plane to each vendor's private token format.

This distinction also resolves the OAuth example in the original discussion. OpenAI's [plugin authentication guide](https://developers.openai.com/plugins/build/auth) describes ChatGPT or Codex acting as an OAuth client to authenticate a user **to the plugin author's MCP server**. It does not grant a third-party orchestrator generic access to the user's ChatGPT model quota. The official subscription-bearing Codex surface is instead [Codex App Server's account API](https://learn.chatgpt.com/docs/app-server#auth-endpoints), which owns the ChatGPT browser/device OAuth flow, token refresh, plan type, usage, and rate-limit state.

## Native-runtime fidelity through ACP v1

The user's hypothesis is substantially correct: an ACP adapter can reuse the real native runtime instead of rebuilding its agent loop. `codex-acp` starts Codex App Server and translates between the two protocols; `copilot --acp` runs the same Copilot CLI runtime and authentication used by the CLI. Model intelligence, subscription login and native tool execution therefore do not become a lowest-common-denominator implementation merely because ACP is the outer transport. The fidelity loss is at the **control and observability boundary**: a capability can exist and even be used inside the bridge without Kestrel being able to configure, observe or audit it through a portable typed operation.

The current [stable ACP v1 schema](https://agentclientprotocol.com/protocol/v1/schema) is richer than a simple prompt stream. It standardizes session new/load/resume/list/close/delete, prompt/cancel, modes and generic configuration options, permission requests, message/reasoning/tool updates, per-file diff content, plans, commands and usage updates. It does not define typed fork, rollback, rename, compaction, mid-turn steering, review, account-plan or rate-limit operations. ACP's [`_meta`, extension methods and extension notifications](https://agentclientprotocol.com/protocol/v1/extensibility) can carry those features, but only a client that understands the vendor extension can use them; a slash command can also make an operation reachable without making its inputs, result or failure semantics portable.

### Codex App Server through `codex-acp`

| Feature family | Native capability available | Used internally by `codex-acp` | Exposed through standard ACP v1 | Extension-only or not exposed; consequence for Kestrel |
| --- | --- | --- | --- | --- |
| Runtime and core session lifecycle | App Server provides thread start/resume/read/list/fork/archive/unarchive/compact/rollback/name and turn start/steer/interrupt, plus native ChatGPT login. | The bridge launches App Server and maps new/load/resume/list, prompts and interruption. ACP `session/delete` is implemented as native `thread/archive`; close unsubscribes. | Auth, new/load/resume/list/close/delete, prompt and cancel are portable. | “Delete” means removal from the active list, not verified data erasure. Fork, rollback, rename and unarchive have no standard bridge mapping. Mid-turn steering is the negotiated `_session/steering` extension. See the [App Server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), [`CodexAcpServer.ts`](https://github.com/agentclientprotocol/codex-acp/blob/main/src/CodexAcpServer.ts) and [`AcpExtensions.ts`](https://github.com/agentclientprotocol/codex-acp/blob/main/src/AcpExtensions.ts). |
| Runtime profile | Codex exposes model discovery, reasoning effort, approval and sandbox policy, collaboration mode and fast mode. | The bridge reads native models/configuration and applies changes back to App Server. | These are rendered as standard generic ACP configuration options, so a generic client can discover and set them by advertised ID. | The option vocabulary remains adapter-advertised rather than one universal Codex schema; Kestrel must persist the negotiated profile and reject missing required options. See [`CodexAcpClient.ts`](https://github.com/agentclientprotocol/codex-acp/blob/main/src/CodexAcpClient.ts). |
| Tools, file changes and permissions | App Server emits command, file-change, MCP, web, image and aggregated `turn/diff/updated` events, plus detailed command/filesystem/network approval requests. | The bridge translates native items and approvals. | Generic tool calls/updates, terminal content, per-file diff content and allow/deny permission choices are portable. | The bridge deliberately ignores the authoritative aggregated `turn/diff/updated`; Kestrel would have to derive a run diff from file events or Git. Exact filesystem/network scope, exec-policy amendments and grant lifetime are carried in Codex `_meta`, not in the portable permission shape. See [`CodexEventHandler.ts`](https://github.com/agentclientprotocol/codex-acp/blob/main/src/CodexEventHandler.ts), [`CodexToolCallMapper.ts`](https://github.com/agentclientprotocol/codex-acp/blob/main/src/CodexToolCallMapper.ts) and [`CodexApprovalHandler.ts`](https://github.com/agentclientprotocol/codex-acp/blob/main/src/CodexApprovalHandler.ts). |
| Review, compaction and goals | App Server has native review, compaction and thread-goal operations. | The bridge invokes those native operations. | ACP command discovery can advertise `/review`, `/review-branch`, `/review-commit`, `/compact` and `/goal`; invocation is still an ordinary prompt/command flow. | Their domain-specific request/result semantics are not standard typed RPCs. Goal control is `_session/goal`; compaction detail is `_meta.contextCompaction`. See the [`codex-acp` feature list](https://github.com/agentclientprotocol/codex-acp) and [`GoalExtension.ts`](https://github.com/agentclientprotocol/codex-acp/blob/main/src/GoalExtension.ts). |
| Account, quota and usage | App Server exposes account identity/login type, plan type and structured rate-limit windows/credits as well as token usage. | The bridge observes rate-limit updates and can render them in `/status`. | ACP carries generic context usage/cost updates and the bridge returns token usage where available. | There is no portable structured account, plan, remaining-credit, reset-window or rate-limit event. Scheduling on subscription capacity would need a Codex-native capability or an explicitly versioned extension, never parsing `/status` text. |
| Subagents and failures | Native events distinguish collaboration/subagent activity and richer session failures. | The bridge consumes and translates them. | A generic client receives ordinary messages/tool-call lifecycle and generic errors. | Child-agent identity/lifecycle is collapsed into generic tool updates, with extra structure in `_meta.codex`; richer failure classification and AIR file-change reports require negotiated vendor metadata. These are material only if Kestrel needs typed delegation graphs or exact failure attribution. |

Codex therefore has relatively high ACP fidelity. The bridge preserves the normal agent loop, configurable model/reasoning/sandbox modes, tool streaming and basic approvals. The genuinely material gaps are authoritative turn-wide diffs, structured subscription limits, precise permission-policy metadata, portable typed mid-turn steering and the richer fork/rollback/subagent lifecycle—not basic execution.

### Copilot CLI through its ACP server

| Feature family | Native capability available in the Copilot SDK/runtime | Used by the ACP server/runtime | Exposed through standard ACP v1 | Extension-only or not exposed; consequence for Kestrel |
| --- | --- | --- | --- | --- |
| Runtime, authentication and core sessions | The SDK controls the same Copilot CLI runtime and supports create/resume/list/delete/disconnect, auth and GitHub/Copilot-subscription or BYOK operation. | `copilot --acp` reuses that runtime, login and tools. | New session, prompt, streaming updates, permission responses and cancel use standard ACP. | ACP has no portable structured Copilot entitlement, premium-request budget or account-plan API; `/usage` is a command, not a typed quota contract. See the [official ACP server reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) and [Copilot SDK](https://github.com/github/copilot-sdk). |
| Per-session Runtime Profile | Native SDK sessions can select model, reasoning effort, included/excluded tools, mode, custom agents, system message, provider and other session configuration. | The ACP server can launch the runtime with tool filters and effort flags. | `session/new` documents only working directory and MCP servers for these controls; standard configuration is not documented for the native profile. `/model`, `/plan` and related advertised commands remain prompt/command interactions. | The ACP reference explicitly says `--available-tools`, `--excluded-tools` and `--effort` are **process-launch settings shared by every session**. Exact concurrent per-session profiles therefore require one ACP process per profile or the native SDK. |
| Turn control | Native SDK provides immediate steering, queued follow-ups, abort and history access. | The runtime naturally uses these facilities for its loop. | ACP exposes prompt and cancel. | No documented Copilot ACP method exposes steer-versus-enqueue semantics. Kestrel cannot promise mid-turn redirection or deterministic queued follow-ups through the portable adapter. See the [SDK compatibility matrix](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility). |
| Rich lifecycle and state | Native SDK includes experimental fork/history truncation, typed plan read/update/delete, workspace operations, model switching and foreground-session control. | Some operations are reachable inside the CLI. | Plans, available commands and generic session operations cover only part of that surface. `/compact`, `/context`, `/model`, `/plan`, `/review`, `/research`, `/session` and `/rename` may be advertised as commands. | Fork, history truncation, workspace and foreground APIs are not standard ACP. The ACP server explicitly cannot handle interactive `/diff`, `/resume`, `/tasks` or `/undo`; command reachability is not a stable typed lifecycle contract. |
| Hooks, custom tools and subagents | Native session config supports custom tools and pre/post-tool, prompt, session and error hooks. Native events distinguish subagent start/completion/failure/selection, skill invocation and detailed shutdown/model metrics. | Those mechanisms can still operate inside the native runtime. | ACP can show resulting messages, generic tool calls, plans and usage. | ACP v1 has no portable hook registration, custom-tool registration or child-agent control/event taxonomy. The native [40+ event surface](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events) is compressed; subagent durations/tokens/tool counts, premium requests and per-model shutdown metrics cannot be assumed observable. |
| Permission semantics | Native callbacks use discriminated request kinds such as shell, read, write, MCP, URL, memory and custom tool, with scoped decisions and detailed denial/completion events. | The ACP server mediates permission requests from the same runtime. | A generic ACP client can present the tool call and return one of the advertised allow/deny options. | The portable shape does not preserve the full native discriminated policy model and outcome taxonomy. Kestrel's Sandbox remains authoritative; exact policy/audit fidelity would require a native adapter or a documented vendor extension. |

The Copilot gap is therefore larger than the Codex gap. It is not a loss of Copilot's intelligence or tools; it is chiefly the inability to address rich controls **per session** and to consume the native typed event taxonomy. This matters if Kestrel multiplexes profiles on one long-lived process, performs live steering, registers hooks/custom tools, or treats subagent and quota telemetry as auditable domain facts.

### Consequence for the Agent Runtime Port

ACP remains sufficient for an MVP that runs one isolated agent process per Runtime Profile and requires prompt/cancel, common session recovery, message/tool/file streams, generic diffs and basic approval mediation. Kestrel should not flatten optional native features into fake universal guarantees. The port should negotiate explicit capabilities such as `perSessionRuntimeProfile`, `midTurnSteering`, `authoritativeTurnDiff`, `structuredRateLimits`, `fork`, `rollback`, `granularPermissionMetadata` and `typedSubagentLifecycle`.

A native adapter would be reconsidered only when a selected Kestrel requirement depends on one of those flags and no stable ACP mechanism or extension can satisfy it. The first likely trigger is Copilot per-session identity or model/effort/tool isolation; the strongest Codex triggers are structured quota scheduling or an authoritative native turn diff. None is an initial Kestrel requirement. ACP plus one sandboxed process per profile retains native execution without pre-emptive vendor-specific adapters.

## The strongest implementation candidate: acpx

[`acpx`](https://github.com/openclaw/acpx) is a headless, MIT-licensed ACP client intended for agents and orchestrators. Its public `acpx/runtime` export is unusually close to the adapter Kestrel needs:

- injectable agent registry and session store;
- persistent and one-shot sessions;
- typed event streaming instead of PTY scraping;
- `startTurn`, terminal result, cancel, close, status, modes, and configuration;
- usage and cost fields that remain optional when the agent does not report them;
- a permission callback plus non-interactive policies;
- filesystem scoping to the working directory;
- reconnect, queue ownership, and session-load behavior;
- an adapter-oriented conformance corpus.

Its [architecture](https://github.com/openclaw/acpx/blob/main/docs/2026-02-17-architecture.md), [permission model](https://github.com/openclaw/acpx/blob/main/docs/permissions.md), and [ACP coverage](https://github.com/openclaw/acpx/blob/main/docs/2026-02-19-acp-coverage-roadmap.md) are more relevant to Kestrel than OpenHands' higher-level conversation abstraction.

It is not ready to become an irreversible core dependency without a spike:

- current package version is `0.13.0` and the project explicitly calls its interfaces pre-1.0;
- it requires Node.js 22.13+;
- its conformance suite is explicitly Draft;
- path/argument-level permission rules are not yet fully supported;
- usage depends on what the upstream adapter reports;
- session recovery, queue ownership, fallback-to-new-session, and persistence are `acpx` policy decisions, while Kestrel must remain authoritative for Agent Run state;
- its public runtime contract can change before 1.0.

The safe use is an anti-corruption adapter: Kestrel defines its own small Agent Runtime Port and maps `acpx/runtime` into it. No Kestrel domain record should expose an `acpx` record shape or make `acpx` persistence authoritative.

## Protocol census

The protocols below were evaluated against the actual Kestrel boundary: coding-agent specificity; local subprocess/stdio support; start/load/resume/cancel; typed streaming, tool and diff events; permission mediation; official subscription reuse; self-hosting; maturity and governance; and suitability for local versus remote execution.

### Direct coding-runtime candidates

| Candidate | Boundary and transport | Lifecycle and events | Permission and subscription auth | Maturity, hosting, and Kestrel verdict |
| --- | --- | --- | --- | --- |
| [ACP v1](https://agentclientprotocol.com/protocol/v1/overview) | Coding client ↔ coding agent; local subprocess/stdio is the primary fit, while full remote support is not yet the stable centre | `session/new`, optional `session/load`, prompts and cancellation; typed messages, tool calls/updates, plans, modes, configuration, usage and client file/terminal requests | First-class permission requests and agent-advertised auth; subscription reuse is adapter- and vendor-dependent | Stable v1, open and cross-vendor. **Best current default adapter**, but not Kestrel's domain contract and not the security boundary. |
| [CAP v1 draft](https://cap-protocol.org/) | Orchestrator ↔ any CLI agent; PTY is mandatory fallback, with `stream-json`, gRPC, ACP and A2A fast paths; local, remote and fleet are in scope | Draft manifests, core events, multi-agent routing and hard/cooperative cancellation; reliable typed load/resume/diff semantics still depend on the selected fast path or terminal parser | Coding profile declares filesystem, terminal and interactive permission capabilities; underlying CLI still owns login, so CAP does not standardize consumer-subscription OAuth | Published 2026-05-18; reference Rust implementation is still in progress, governance is transitional, and no independent implementations are claimed. **Strongest conceptual challenger, not an implementable dependency yet.** |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server) | Kestrel/client ↔ Codex; JSON-RPC-like JSONL over local stdio by default; WebSocket is experimental/unsupported | Thread start/resume/fork/read/list and turn start/steer/interrupt; typed item/tool/command/file events, token usage and an aggregated `turn/diff/updated` unified diff | Server-initiated command, file and granular filesystem/network approval RPCs; officially owns ChatGPT browser/device OAuth, refresh, plan type, usage and rate limits | OpenAI-owned production interface behind the Codex VS Code experience; generated schema is exact to the installed Codex version rather than a cross-vendor standard. **Beats ACP for Codex fidelity; use only as a Codex-specific adapter after a measured ACP gap.** |
| [GitHub Copilot SDK protocol](https://github.com/github/copilot-sdk) | SDK ↔ Copilot CLI runtime via version-negotiated JSON-RPC; local stdio child, TCP server, URI connection, and experimental in-process transport | Create/resume/list/delete/disconnect sessions, send/steer/enqueue/history/abort/fork; 40+ lifecycle, message delta, reasoning and tool events; per-session model, effort, tools, workspace and hooks | Per-tool typed permission handler (`shell`, `write`, `read`, MCP, URL, custom tool, etc.) with scoped decisions. GitHub officially supports OAuth Apps/GitHub Apps acting for users and billing usage to each user's Copilot subscription | [GA with semantic versioning](https://github.com/github/copilot-sdk); wire versions v2-v3 are negotiated. **Beats Copilot ACP today for Copilot-specific control**, because the [ACP server is public preview and fixes tool/effort settings at process launch](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server). It remains vendor-specific and the standard service is not fully self-hosted. |
| [Claude Agent SDK / CLI transport](https://code.claude.com/docs/en/agent-sdk/overview) | Application ↔ Claude Code agent loop; official Python/TypeScript libraries launch a local CLI subprocess, while other languages may invoke CLI JSON output; there is no public language-neutral stable wire protocol | Persistent session continue/resume/fork, streamed message/tool blocks, interrupt, cost, file checkpoints, hooks and subagents; no portable coding-diff event contract | Deep allow/deny/ask rules, modes, hooks and `canUseTool` callbacks. **Subscription goal fails by default:** Anthropic says third parties may not offer `claude.ai` login or rate limits without prior approval and should use API keys | Official vendor SDK with rich Claude-specific control, but proprietary semantics and two supported SDK languages. **Can beat ACP for Claude depth only after written approval or an API-key product decision; it does not solve cross-agent subscription portability.** |
| [OpenCode server API](https://opencode.ai/docs/server) | Client ↔ one OpenCode coding-agent runtime over self-hosted HTTP; TUI itself is a client; OpenAPI 3.1 and SSE are exposed | Create/status/fork/abort/revert sessions, sync/async messages, child sessions, session diff, file/VCS APIs and a server event stream | Permission-response endpoint and provider OAuth endpoints; project docs claim ChatGPT Plus and Copilot subscription support, while also recording that Anthropic prohibits Claude Pro/Max plugins. Provider authorization still needs independent terms validation | Open-source, local/headless and able to use local models. **Beats ACP if the product decision is “OpenCode is Kestrel's built-in agent.”** It is not a protocol that preserves user choice among existing coding-agent runtimes. |

### Generic agent-service and presentation protocols

| Candidate | What it actually standardizes | Lifecycle, stream, permission and auth coverage | Kestrel disposition |
| --- | --- | --- | --- |
| [A2A v1.0](https://a2a-protocol.org/latest/specification/) | Remote opaque agent ↔ agent/client over JSON-RPC, gRPC or HTTP+JSON, with Agent Cards | Send/stream messages; get/list/cancel/subscribe tasks; polling, SSE and push; artifacts and multi-turn contexts; OAuth/OIDC/API-key/mTLS service security. No local subprocess, coding workspace, diff or tool-execution approval semantics; service OAuth is not a consumer model subscription | Linux Foundation-governed and the strongest released protocol for independent **remote peers**. Add when Kestrel delegates to external Agent Services, not as the local coding-agent adapter. |
| [LangChain Agent Protocol](https://github.com/langchain-ai/agent-protocol) | Self-hostable remote agent service API around agents, threads, runs and a long-term store | Create/copy/history threads; create/wait/get/stream/cancel runs; SSE/WebSocket replay and commands; typed nested-agent, content, tool lifecycle, run lifecycle, HITL, state and checkpoint events. It has no coding-workspace permission or subscription-login standard | **Serious candidate for the future durable remote Agent Service adapter.** It can beat ACP for reconnectable remote execution, but not for a local subscription-backed Codex/Claude/Copilot process. |
| [Agent Runtime Protocol (ARP)](https://agent-runtime-protocol.com/) | Versioned HTTP+JSON contracts for a capability-oriented execution fabric: Run Gateway, Coordinator, atomic/composite executors, registry, selection and optional policy decision point | Bounded node runs, start/get/cancel, policy checkpoints, durable events and artifacts are close to Kestrel's control-plane concerns. It does not standardize adapters for existing coding CLIs or their consumer subscriptions | Strong control-plane prior art, but v0.3.8 is in active early development and its JARVIS reference stack would import a node-centric workflow model that overlaps Kestrel's own domain. Evaluate its contracts as design evidence, not as the local agent wire boundary. |
| [AIEF-origin Agent Protocol](https://github.com/agi-inc/agent-protocol) | Minimal framework-agnostic REST/OpenAPI interface, now maintained by AGI Inc. | Tasks, explicit task steps and artifact upload/download. Its documented core has no standard stream, cancellation, resume, per-tool permission or user-auth flow; “authentication on behalf of users” remains roadmap | Useful historical benchmark/API wrapper, not competitive for Kestrel's runtime boundary. Do not confuse it with the newer LangChain protocol of the same generic name. |
| [IBM/BeeAI Agent Communication Protocol](https://github.com/i-am-bee/acp) | Remote multimodal agent communication, runs and sessions | Had sync/background/streamed runs and await/resume semantics, but was not a local coding-agent client protocol | Repository archived in August 2025 and explicitly folded into A2A. Evaluate A2A instead; also avoid confusing this retired “ACP” with Agent Client Protocol. |
| [AG-UI](https://docs.ag-ui.com/concepts/architecture) | Agent ↔ user-interface event surface; `run(input) -> Observable<BaseEvent>` and an HTTP SSE/binary client | Run/step, message, tool-call and JSON-patch state events support responsive UI and handoff. It does not define process launch, durable session load/resume, sandbox enforcement, coding diffs, credentials or subscription entitlement | Useful optional UI edge format. It can sit above the Agent Runtime Port, not replace it. |
| [MCP](https://modelcontextprotocol.io/specification/2026-07-28) | LLM application/agent ↔ tools, resources, prompts and context; stdio or HTTP. A coding agent can already be exposed as a tool: OpenAI ships [`codex mcp-server`](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md), although its control interface is currently labelled experimental | The final [Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview) adds a durable handle, `working`/`input_required`/terminal states, `tasks/get`, `tasks/update`, cooperative `tasks/cancel` and status notifications. The official [Agents WG](https://github.com/modelcontextprotocol/agents-wg) is actively evaluating agent-backed tools, remote agents, server-exposed agent definitions and supervisor/subagent task graphs in its [approaches draft](https://github.com/modelcontextprotocol/agents-wg/pull/5). MCP OAuth authenticates a host to an MCP server, not to a model subscription | **Serious future candidate, not a complete coding-runtime standard today.** No released Agents extension yet defines coding sessions, workspace/diff events, tool-execution approvals and native subscription login as one portable contract. Use MCP now for tools/data and monitor Tasks + Agents work rather than ruling it out. |
| [OpenResponses](https://www.openresponses.org/specification) | Portable model inference request/response items, function calls and extensions over HTTP/SSE or optional WebSocket | Streamed output-item and token lifecycle; no coding session start/load/resume, workspace/diff contract, agent process supervision, or user approval protocol. Credentials and persistence are implementation-specific | Useful vocabulary for Kestrel's raw Model Inference Port, not for an Agent Runtime. |

### Network and formal standards

| Candidate | Strength | Missing for Kestrel | Verdict |
| --- | --- | --- | --- |
| [ANP 1.1 / Agent Network Protocol](https://agent-network-protocol.com/) | Decentralized cross-domain agent identity, naming, discovery, JSON-RPC messaging, E2EE, federation and payment, built on DID and web infrastructure | No local process supervision, coding session lifecycle, tool/diff stream, workspace permission mediation or subscription entitlement. The optional meta-protocol remains draft | Stronger than ACP for an open decentralized agent network; complementary and too high-level for Kestrel's local coding boundary. |
| [NLIP, ECMA-430–434](https://ecma-international.org/news/ecma-international-approves-nlip-standards-suite-for-universal-ai-agent-communication/) | The strongest formal standards governance in this census: Ecma TC56 standards for multimodal envelopes over HTTP, WebSocket/CBOR or AMQP, plus mandatory production security profiles | Conversation/auth tokens are opaque; [WebSocket session management is optional and custom](https://ecma-international.org/publications-and-standards/standards/ecma-432/). No normative coding start/load/resume/cancel RPCs, tool/diff events or command permission flow | Better for secure cross-organization multimodal interoperability, not a coding-agent runtime. Revisit only if Kestrel exposes a general remote-agent messaging edge. |
| [FIPA ACL](https://www.fipa.org/repository/aclspecs.html) | Formal speech-act message semantics (`request`, `inform`, `propose`, `cancel`, etc.), participants, ontology/language and conversation identifiers, with interaction and HTTP transport specs | The standard dates to 2002 and has no modern coding workspace, typed tool/file/diff events, sandbox, OAuth/subscription or runtime supervision semantics | Important conceptual ancestry, not a viable implementation substrate for Kestrel. |

These protocols are complementary layers, not competing aliases for “agent agnostic.” The only current candidates that can **beat ACP for Kestrel** are conditional:

1. Codex App Server for a Codex-only adapter where ACP loses a required Codex feature.
2. GitHub Copilot SDK for a Copilot-only adapter requiring per-session controls or officially supported multi-user subscription OAuth.
3. OpenCode Server if Kestrel chooses one replaceable built-in runtime rather than existing-agent interoperability.
4. LangChain Agent Protocol for durable remote Agent Services.
5. CAP in the future, once independent implementations and conformance evidence exist.
6. A future MCP Agents extension, if it graduates the current Tasks and agent-runtime explorations into an implemented coding profile.

None currently beats ACP as an implementable, open, cross-vendor local coding-agent adapter.

### Platform counterexample: CLI Agent Orchestrator

| Candidate | What is reusable | Why it does not win the boundary |
| --- | --- | --- |
| [AWS Labs CLI Agent Orchestrator (CAO)](https://github.com/awslabs/cli-agent-orchestrator) | Apache-2.0, active, self-hosted and released as v2.4.1 when checked. It preserves each CLI's native authentication and capabilities while running Codex, Claude Code, Kiro, Copilot, OpenCode, Cursor, Hermes and others in separate tmux terminals. A local FastAPI control plane exposes sessions, terminal input/output, durable events and history, async workflows, cancellation, HTTP/SSE, [AG-UI and a PTY WebSocket](https://github.com/awslabs/cli-agent-orchestrator/blob/main/docs/api.md); two MCP servers expose supervisor/worker messaging and external fleet operations. Profiles map provider tools and restrictions. | CAO is a platform and provider-adapter collection, not a structured cross-agent wire protocol or a security sandbox. Its default tmux backend polls and pattern-matches terminal output; provider flags, prompt injection and parsing remain adapter-specific. [Tool restrictions](https://github.com/awslabs/cli-agent-orchestrator/blob/main/docs/tool-restrictions.md) are hard only where the provider supports them—CAO's Codex tool restrictions are soft—and the PTY WebSocket is terminal control, not typed permission mediation. Adopting CAO would import substantial session, profile, workflow, MCP and control-plane domain into Kestrel. **Serious fork/adopt/prior-art candidate, not a better Agent Runtime Port contract.** |

## Framework and SDK comparison

### OpenHands Software Agent SDK

[OpenHands `ACPAgent`](https://docs.openhands.dev/sdk/guides/agent-acp) can spawn any ACP-compatible server, collect events and metrics, and run it through local or remote OpenHands conversations. Its authentication logic can select a ChatGPT subscription login when supported.

It is the closest turnkey **agent platform SDK**, but it is a weaker default boundary for Kestrel because:

- the ACP server owns its tools, context window, and execution model;
- OpenHands currently auto-approves ACP permission requests;
- OpenHands' system/context additions are assembled into the user prompt for the external ACP server;
- adopting its remote conversation and agent server also adopts OpenHands lifecycle and persistence semantics.

It remains valuable as an executable reference and comparison target. Its auto-approval behavior makes it unsuitable as the authority for Kestrel Human Gates or sandbox policy.

### Vercel AI SDK and LiteLLM

[Vercel AI SDK](https://github.com/vercel/ai) and [LiteLLM](https://docs.litellm.ai/) normalize access to many model providers. They are useful when Kestrel builds its own agent loop on raw inference APIs. They do not expose Codex, Claude Code, Copilot CLI, or other coding agents as interchangeable stateful runtimes.

Vercel's direct OpenAI provider normally uses `OPENAI_API_KEY`; [AI Gateway authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok) can use Vercel OIDC automatically on Vercel deployments, but that is not a universal self-hosted subscription mechanism. These libraries solve **model portability**, not the user's subscription-backed **agent portability** requirement.

### LangGraph and Microsoft Agent Framework

[LangGraph](https://docs.langchain.com/oss/python/langgraph/overview) provides durable execution, checkpoints, streaming, persistence, and human-in-the-loop orchestration. [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/agents/providers/) provides provider abstractions, workflows, state, approvals, MCP, A2A, and AG-UI support.

Both can help implement an orchestrator, but neither replaces ACP for the existing coding-agent ecosystem. Making either framework authoritative for workflow state would also compete with Kestrel's domain model. They are implementation options only if Kestrel later proves it needs a general workflow engine instead of its own focused lifecycle.

## Existing products and platforms

Several current products prove that the agent-agnostic idea is viable:

- [Sesame](https://sesame.works/) is self-hostable, supports Claude Code, Codex, Copilot, Gemini, OpenCode, and Amp, accepts subscriptions for several agents, and offers Docker/cloud/local sandboxes.
- [SAM](https://www.simple-agent-manager.org/) is an AGPL self-hosted multi-agent platform with isolated cloud workspaces, ACP chat, OAuth or API credentials, task orchestration, activity feeds, and human-input notifications. Its cloud and control-plane assumptions are much broader than a library.
- [Handler](https://handler.dev/) is MIT-licensed and provides Docker/Firecracker sandboxes, persistent tmux sessions, agent detection, forking, and a visual control plane. Its primary integration is terminal/sandbox management rather than a uniform structured agent contract.
- [OpenACP](https://openacp.ai/) is an MIT self-hosted ACP bridge with session management, permission gates, queues, usage tracking, and messaging-platform adapters.
- [OpenClaw's ACP runtime](https://github.com/openclaw/openclaw/blob/main/docs/tools/acp-agents.md) demonstrates persistent ACP sessions, bindings, cancellation, permission modes, and agent-to-agent dispatch using `acpx`.

These are more than libraries and overlap Kestrel at product level. They could be fork/adopt candidates only if Kestrel is willing to inherit their domain and UX. Kestrel's distinctive scope—human-owned planning and consequential decisions, exact review revisions, conceptual review evidence, Graph, and lifecycle governance—is not supplied by any one of them.

## Failure modes Kestrel must keep above ACP

ACP support is necessary interoperability evidence, not certification that an agent is safe or semantically equivalent.

1. **Permission bypass:** an agent can execute with internal tools that never generate an ACP permission request. Kestrel needs OS/container isolation and egress controls, not only protocol approvals.
2. **Optional persistence:** `session/load` and related capabilities are optional and agent-owned. Kestrel must retain its own durable Agent Run state and treat upstream session continuity as a capability.
3. **Optional accounting:** usage and monetary cost may be absent or incomplete. Missing is `unknown`, never zero.
4. **Configuration variance:** model, tools, reasoning, and approval settings may exist only as process flags or vendor extensions. They require an exact Agent Runtime Profile.
5. **Cancellation ambiguity:** protocol cancellation can race with side effects or be ignored. Kestrel needs bounded graceful cancel followed by process/container termination and an `outcome_unknown` state when appropriate.
6. **Authentication placement:** ACP lets an agent drive auth, but Kestrel still decides where credentials are stored, mounted, refreshed, and isolated per Project or Operator.
7. **Remote immaturity:** ACP documentation says full remote-agent support is still work in progress. V1 should prefer a local ACP subprocess inside a Kestrel-managed Sandbox.
8. **Capability claims:** negotiation reports claimed support; it does not prove correct behavior. Every supported adapter/profile needs executable conformance evidence.

## Falsifiable selection rule

The recommendation is not “ACP forever.” It is a protocol-neutral rule with observable displacement tests:

- Keep **ACP as the default local cross-vendor adapter** only while no other open candidate has at least two independent coding-agent implementations from different vendors, deterministic local process transport, capability negotiation, new/load-or-resume/cancel, typed message/tool/file/diff/usage/permission events, a version policy and a runnable conformance suite. CAP, MCP Agents or another protocol replaces ACP when it meets those conditions and passes Kestrel's sandbox, crash, permission-denial and cancellation harness against at least Codex and one non-OpenAI agent.
- Prefer a **native adapter for one agent** when the same harness demonstrates a required capability or official subscription-auth flow that ACP cannot expose, and the native surface closes that exact gap without becoming authoritative for Kestrel run state, policy or artifacts. Today Codex App Server and Copilot SDK are the two credible tests of this rule.
- Prefer **LangChain Agent Protocol or A2A only for a remote profile** when durable reconnect/replay or peer discovery is required. Their success does not displace the local-process adapter.
- Prefer **OpenCode or CAO as the product substrate** only after an explicit decision to inherit that platform's agent loop/control-plane model. Their broader feature count is not evidence that their internal API should become Kestrel's domain contract.

This conclusion is falsified if the spike finds that ACP cannot preserve official subscription login for two target agents, cannot mediate required permissions, or loses events Kestrel needs while a cross-vendor alternative satisfies the test above. Until then, the least-coupled choice is a Kestrel-owned Agent Runtime Port with ACP first and native escape hatches.

## Recommended disposable spike

Before changing the Kestrel domain or selecting a dependency, run one bounded comparison inside an isolated Sandbox:

1. Use one Kestrel-owned test contract against Codex ACP and GitHub Copilot CLI ACP, both authenticated through their normal subscription flows.
2. Run ACP once through `acpx/runtime` and once through the official ACP SDK directly; use disposable direct probes—not production adapters—against Codex App Server and the Copilot SDK only to measure native-only value rather than assume it.
3. Verify initialize/auth, capability capture, session creation, streaming and diff normalization, permission allow/deny, tool visibility, cancellation, process-kill escalation, reconnect/load behavior, missing usage, crash recovery and cleanup.
4. Deliberately test an agent that bypasses client file/terminal methods to prove the Sandbox remains the actual security boundary.
5. Keep Kestrel's run ID, event log, gate state, artifacts and terminal outcome outside ACP, `acpx` and every native SDK store.

Adopt `acpx/runtime` only if it removes meaningful adapter work without forcing its session policy into Kestrel. Otherwise retain the Kestrel port and replace the implementation with the official ACP SDK.

## Recorded direction and remaining decisions

The Operator has answered the domain question: **Kestrel should be agent-agnostic and become a control plane for selectable Agent Runtimes**. Kestrel owns the durable Agent Run while each selected runtime owns its native agent loop. `CONTEXT.md` now records that distinction without turning ACP, the initial technical adapter, into a domain concept.

The adapter decision is now recorded: **Kestrel starts with one production implementation of its Agent Runtime Port, ACP v1**. Codex, Copilot and the other agents are selected by upstream ACP server/profile configuration, not by parallel Kestrel-native adapters.

The remaining implementation decisions are which ACP client library to use (`acpx/runtime` or the official SDK), the exact supported server/profile matrix, and the conformance evidence each profile must pass. The native comparison in the spike is a guardrail for discovering a real fidelity blocker; it is not permission to build native adapters pre-emptively. Replacing ACP or adding a vendor-native implementation requires a concrete Kestrel requirement that cannot be met through stable ACP or a deliberately supported extension. Replacing Kestrel with OpenCode, CAO, OpenHands or another full platform would remain a separate explicit product decision.
