# Model Provider portability and control

**Status:** recommended Review First V1 contract

**Date:** 2026-08-10

**Scope:** self-hosted Kestrel, Project-scoped Model Provider connections, Review First only

## Research question

What provider-neutral capabilities, credential boundaries, model-selection controls, privacy guarantees, usage accounting, and fallbacks let Review First start narrowly without coupling Kestrel to one cloud model provider?

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` below are Kestrel decisions. **Source fact** marks behavior documented by a provider. Sources were checked on 2026-08-10; provider catalogs, terms, controls, prices, and API surfaces are mutable and require operational re-attestation.

## Executive decision

Kestrel will expose one versioned, provider-neutral **Model Inference Boundary**, but it will certify capabilities and data guarantees for an exact **Provider Profile**, never for a provider brand. A profile binds one Kestrel Project to one credential handle, API surface, HTTPS origin, account/project/workspace, deployment or model target, version policy, processing route, data policy, feature set, limits, and price snapshot.

The boundary is not a lowest-common-denominator chat API. Callers state hard requirements; an adapter may use richer native features only when the profile advertises them. Every result preserves typed provider distinctions instead of flattening them into prose. Prompt emulation can improve quality but cannot satisfy a security, privacy, residency, identity, structured-output, accounting, or authority requirement.

Review First V1 needs only stateless text inference through a dedicated system/developer instruction channel and provider-native structured output for Kestrel's small JSON Schema subset. Kestrel always validates the completed result locally. It sends no tools, hosted retrieval, files, URLs, stateful thread references, or provider-side write requests. Streaming and prompt caching are optional transport/cost optimizations, not semantic dependencies.

The Model Provider egress broker owns credentials, endpoint enforcement, retries, request correlation, and usage capture. Analysis workers receive opaque connection/profile identifiers only. They cannot choose an endpoint, see a secret, change the model, enable a feature, follow a URL, or trigger fallback.

Selection is explicit and fail-closed. A Project uses one approved profile for a review attempt. Capability or policy drift suspends that profile. Kestrel never silently changes provider, model/deployment, version, region, retention mode, feature, service tier, or fallback route. An Operator may explicitly begin a new attempt under another separately approved profile; the old and new attempts remain distinct and attributable.

One empirical AFK ticket is required before the final Review First specification: prove this boundary against two unlike live surfaces. A separate HITL ticket for choosing the initial profile is not justified; release-scope selection belongs in the existing final-spec ticket after this research, the live boundary evidence, and conceptual-extraction evidence are available.

## Decision boundary

This note owns the neutral inference contract and capability vocabulary; Project-scoped connections and secret/egress separation; profile approval, selection, drift, suspension, and deprecation; typed response, error, usage, retry, cancellation, and accounting behavior; Review First's minimum capabilities and exclusions; and cross-provider conformance.

It does not repeat the full Review First threat model. It adopts the controls in [Review First trust and security model](./review-first-trust-security-model.md), especially `RF-SEC-08`, `RF-SEC-10`, `RF-SEC-13`, and `RF-SEC-14`. It also does not decide model quality thresholds, conceptual extraction design, local review retention, Operator authentication, Agent Run tools, or production adapter implementation language.

## Threat model first

### Assets and security objectives

The protected assets are private repository context and derived prompts/outputs; Model Provider credentials; Project-to-provider authorization; profile policy and approval evidence; model identity and provenance; request IDs; usage and cost records; and availability budgets.

The boundary has four objectives:

1. **Constrained disclosure:** only the approved Project data classes may leave through the exact approved profile.
2. **Constrained authority:** untrusted source or model output cannot choose credentials, endpoints, models, features, retries, fallbacks, or tools.
3. **Attribution and integrity:** every accepted result identifies its exact input, profile, adapter, model/deployment evidence, policy snapshot, request attempts, and usage.
4. **Bounded availability and cost:** hostile or pathological inputs cannot create unbounded requests, tokens, retries, concurrency, storage, or spend.

### Trust boundaries

```text
untrusted repository/model context
  -> context assembler (Project + revision + byte/token budgets)
  -> analysis worker (opaque profile ID; no secret or network choice)
  -> typed ModelRequest
  -> Model Provider egress broker
       -> Project/profile authorization and live policy attestation
       -> secret injection and exact-origin network policy
       -> one endpoint-specific adapter
       -> provider/cloud surface
  <- typed events/result/error/usage
  -> local schema, evidence, provenance, and safety validation
  -> immutable Project-scoped review revision
```

The egress broker, secret store, profile registry, policy evaluator, adapter binary, and audit integrity root are trusted. The provider service, SDK, network, response metadata, model output, repository context, and model catalog are not trusted merely because authentication succeeded.

### Threats and required outcomes

| Threat | Required outcome |
| --- | --- |
| Compromised worker asks for another Project's connection or arbitrary host | Broker authorization rejects the Project/profile mismatch; network policy has no caller-supplied destination. |
| Repository prompt asks the model to fetch a URL, reveal a secret, or call a tool | No such request field or credential exists; returned links remain inert untrusted text. |
| Provider alias, deployment, endpoint, or policy changes | Attestation mismatch suspends the profile before egress; no best-effort downgrade. |
| SDK retries invisibly | SDK retries are disabled or adapter-reported and charged against Kestrel's one global retry budget. |
| Connection drops after the request might have reached the provider | Attempt becomes `outcome_unknown`; Kestrel does not auto-retry or claim no charge occurred. |
| Provider refuses, filters, truncates, or ends a stream with an error | Typed terminal outcome is retained; partial content is never accepted as a review result. |
| Provider omits or changes usage fields | Raw response is bounded and preserved in governed evidence; accounting is `pending_reconciliation`, never invented. |
| A cheaper/faster model is available | It is irrelevant unless a separately approved profile is explicitly selected for a new attempt. |
| Provider returns syntactically valid but fabricated review JSON | Local schema, identifier, evidence, and provenance checks reject or mark unsupported claims. |
| Pricing, quota, residency, retention, training, or human-review terms drift | Profile becomes stale or incompatible; Operator sees the exact changed dimension before reapproval. |

Threat containment, secret-store implementation, SSRF defenses, log redaction, rendering, and Project storage isolation remain governed by the security contract rather than duplicated here.

## Primary-source findings: why a profile is smaller than a provider

### Messages and instruction precedence differ

**Source fact.** OpenAI Responses accepts a string or typed input items, including `user`, `assistant`, `system`, and `developer` roles; `developer` and `system` instructions take precedence over user messages. Its output is an ordered array of typed items, not a guaranteed single text field. ([Responses API](https://platform.openai.com/docs/api-reference/responses))

**Source fact.** Anthropic Messages uses `user` and `assistant` messages with content blocks and a separate top-level `system` parameter; callers send conversation history for each stateless Messages request. ([Messages API](https://platform.claude.com/docs/en/api/messages))

**Source fact.** Vertex AI represents turns as `Content` objects with roles and `parts`, with `systemInstruction` separate from `contents`. Its response can contain multiple candidates plus prompt feedback, candidate finish reasons, safety ratings, `modelVersion`, `responseId`, and usage metadata. ([GenerateContent reference](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference), [response schema](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/GenerateContentResponse))

**Source fact.** Bedrock Converse offers a common `messages`/`system` interface, but exposes model-specific request fields and accepts very different `modelId` resources: base models, marketplace endpoints, inference profiles, prompt versions, provisioned throughput, and custom deployments. ([Converse API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html))

**Kestrel decision.** The neutral request has a Kestrel-owned `policy_instruction` and typed `input_blocks`, not an arbitrary role list. V1 profiles must map policy instructions to a provider-native privileged instruction channel. Prefixing instructions into user text is `prompt_emulation` and cannot satisfy that requirement.

### Structured output is a surface-and-model capability

**Source fact.** OpenAI Responses can request a JSON Schema through `text.format`; strict structured output still has non-success paths such as refusal or incomplete generation that callers must handle separately. ([Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Responses API](https://platform.openai.com/docs/api-reference/responses))

**Source fact.** Anthropic exposes schema-constrained output through `output_config.format`; support is tied to the documented API surface and model. ([Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs))

**Source fact.** Vertex AI distinguishes schema-controlled output from JSON MIME prompting. Its schema support is a subset, contributes to input size, can reject overly complex schemas, and can ignore unsupported schema fields. ([Vertex controlled generation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output))

**Source fact.** Two Bedrock endpoints from one provider are materially unlike: `bedrock-runtime` and `bedrock-mantle` expose different APIs and capabilities. Anthropic Messages exists on both, but `output_config.format` is rejected on `bedrock-mantle`; AWS directs structured-output users to Converse or InvokeModel on `bedrock-runtime`. ([Bedrock endpoint comparison](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html))

**Kestrel decision.** `structured_output.native` is certified for an exact surface, target, schema dialect, and Kestrel schema-bundle hash. Merely asking for JSON in a prompt is never equivalent. Provider-native shape control is necessary for Review First V1, but local strict validation remains mandatory because native constraint does not validate Kestrel evidence or semantics.

### Identity, aliases, deployments, and routing are not interchangeable

**Source fact.** OpenAI catalogs aliases and dated snapshots; snapshots are the mechanism for locking a model version, while aliases may resolve differently later. ([model catalog](https://developers.openai.com/api/docs/models), [snapshot example](https://developers.openai.com/api/docs/models/gpt-4o))

**Source fact.** Anthropic documents model IDs and aliases separately. Even a pinned model's weights can remain fixed while inference infrastructure, routing, safety, and sampling behavior change. Direct and partner-operated deployments also have separate deprecation schedules. ([model IDs and versions](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions), [deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations))

**Source fact.** Azure requests target a named deployment on a resource; deployment upgrade policy can automatically move the underlying model version, move it at retirement, or stop service at retirement. ([Azure model lifecycle](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/working-with-models))

**Source fact.** Vertex returns a `modelVersion`, while publisher model aliases and retirement windows remain lifecycle-controlled service facts. ([Vertex model versions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions))

**Source fact.** Bedrock inference profiles can route across regions, and the destinations of global profiles may change. Geographic profiles have a different stability statement. ([Bedrock cross-region profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html))

**Kestrel decision.** A requested model string is not identity evidence. Each invocation stores both `requested_target` and all available `resolved_target` fields: provider model/version, deployment, endpoint, region/route, service tier, and inference profile. If an approved invariant cannot be observed before or after the call, the attestation records that limitation and uses a shorter expiry; a hard invariant that cannot be established makes the profile ineligible.

### State, streaming, stops, and cancellation differ

**Source fact.** OpenAI Responses can be stored and continued, can run in background, and has explicit lifecycle states; with streaming it emits typed semantic SSE events and can terminate as completed, failed, cancelled, or incomplete. ([Responses API](https://platform.openai.com/docs/api-reference/responses), [streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses))

**Source fact.** Anthropic Messages is stateless, but an SSE stream can fail after the HTTP response has already returned `200`. Errors and complete responses expose provider request IDs. ([Messages API](https://platform.claude.com/docs/en/api/messages), [errors](https://platform.claude.com/docs/en/api/errors))

**Source fact.** Vertex candidate finish reasons distinguish normal stop, token exhaustion, safety, recitation, blocklist, sensitive data, malformed tool calls, and other causes. ([GenerateContentResponse](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/GenerateContentResponse))

**Source fact.** Bedrock Converse exposes stop reasons including `end_turn`, `tool_use`, `max_tokens`, guardrail/content filters, malformed model/tool calls, and context-window exhaustion; ConverseStream has typed content/message/metadata events and mid-stream errors. ([Converse response](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html), [ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html))

**Kestrel decision.** V1 sends complete stateless requests and persists no provider conversation/response handle. Streaming MAY reduce latency internally, but Kestrel publishes only a fully assembled, terminal, locally validated response. Aborting a synchronous/streaming transport records `cancel_requested`; it does not claim provider cancellation, stopped billing, or non-retention unless the exact surface supplies and confirms that guarantee.

### Token counting, caching, rate limits, and retries differ

**Source fact.** Vertex exposes a separate `countTokens` operation whose request includes contents, tools, system instructions, and generation config. ([Vertex CountTokens](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1/projects.locations.publishers.models/countTokens)) Anthropic likewise exposes a Token Counting API. ([Claude API overview](https://platform.claude.com/docs/en/api/overview))

**Source fact.** OpenAI prompt caching depends on exact prefixes and reports cached and, for applicable models, cache-write tokens separately; retention and pricing vary by model and configuration. ([OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)) Anthropic caching uses ordered tool/system/message prefixes, supports documented TTL choices, and separates cache creation/read usage. ([Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching))

**Source fact.** OpenAI rate limits vary by organization/project and model or shared pool and return limit/reset headers. ([OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits)) Anthropic uses organization/workspace, model-class, request, input-token, and output-token limits and documents default SDK retries for transient failures. ([Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits), [Anthropic errors](https://platform.claude.com/docs/en/api/errors))

**Source fact.** Vertex pay-as-you-go uses Dynamic Shared Quota rather than a fixed capacity promise, while provisioned throughput changes the capacity contract. ([Vertex throughput and quota](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/resources/throughput-quota)) Azure quota is allocated by subscription, region, model/deployment type, and named deployment, with TPM/RPM relationships that are not billed-token measurements. ([Azure quota](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota))

**Source fact.** Bedrock documents throttling and model-not-ready errors; its SDK may retry `ModelNotReadyException` automatically. ([Converse errors](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html))

**Kestrel decision.** Preflight counts are estimates unless the exact surface documents an exact counter for the exact serialized request. Cache use, count source, rate-limit dimensions, and every SDK retry are observable profile capabilities. Kestrel owns the total retry budget; adapters MUST disable SDK automatic retries or report and debit each SDK attempt before certification.

### Privacy guarantees are feature-, account-, model-, and route-specific

**Source fact.** OpenAI API data is not used for training unless the customer opts in, but default abuse-monitoring retention, approved Modified Abuse Monitoring/Zero Data Retention, endpoint application state, prompt caches, and storage/processing residency have distinct rules and exceptions. ([OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data))

**Source fact.** Anthropic's standard API retention, approved ZDR scope, flagged-content retention, Covered Model exceptions, and storage/routing locations are separate facts. ([retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [ZDR scope](https://privacy.claude.com/en/articles/8956058-i-have-a-zero-data-retention-agreement-with-anthropic-what-products-does-it-apply-to), [Covered Models](https://privacy.claude.com/en/articles/15425996-data-retention-practices-for-covered-models), [locations](https://privacy.claude.com/en/articles/7996890-where-are-your-servers-located-do-you-host-your-models-on-eu-servers))

**Source fact.** Vertex documents no training without prior permission, but default in-memory caches, stored interactions, session resumption, grounding, logging, and global versus regional processing need feature-specific evaluation. ([Vertex zero-data-retention controls](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention), [data residency](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/data-residency))

**Source fact.** Microsoft says Azure-hosted direct models do not share prompts with the upstream model provider or use them to train base models, but stateful features store data, Global/DataZone deployments affect processing location, and abuse monitoring can include human review unless modified monitoring is approved. ([Microsoft data/privacy](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/data-privacy), [abuse monitoring](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/abuse-monitoring))

**Source fact.** Bedrock's current Messages, Chat Completions, and Responses surfaces expose account/project retention modes and per-model `allowed_modes`; `store=false` is not ZDR, a model can be unavailable under the effective mode, and retained cross-region data may live in the destination region. ([Bedrock data retention](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html))

**Kestrel decision.** `no_training`, `zero_retention`, `regional`, and `no_human_review` are not provider Booleans. They are separately attested guarantees with scope, evidence URL/document, account entitlement, effective configuration, exceptions, observed-at time, expiry, and verifier. An unknown value never passes a hard Project policy.

## Versioned Model Inference Boundary

### Public entities

The control plane exposes seven stable domain objects:

1. `ProviderConnection`: Project-bound secret handle and upstream account scope.
2. `ProviderProfile`: exact callable API surface, target, route, feature configuration, and limits.
3. `CapabilityAttestation`: versioned claims plus evidence and conformance status for that profile.
4. `ProfileApproval`: Operator acceptance of the profile and data policy for named Project data classes and Kestrel stages.
5. `ModelInvocation`: immutable logical request plus one or more bounded transport attempts.
6. `ModelResult`: typed terminal output, model identity, stop outcome, request correlation, and validation state.
7. `UsageLedgerEntry`: append-only estimated/reported/reconciled quantities and money.

Provider-specific SDK objects, error classes, role lists, headers, and raw option maps are private to adapters. Callers cannot pass an escape-hatch `extra_body`, base URL, provider name, tool definition, or arbitrary header through the neutral boundary.

### Version policy

- Boundary identifier: `kestrel.model-inference/v1`.
- Every request and result carries `contract_version` and `adapter_version`.
- Unknown fields are ignored only where the schema explicitly permits additive evolution; unknown enum variants map to `unknown`, while the raw value is retained safely.
- Required-field or semantic changes require a new major boundary version.
- New optional capabilities, error details, usage dimensions, and stop reasons are additive.
- A profile declares the exact contract versions it implements; the scheduler never coerces across major versions.
- Stored invocations are decoded with their historical schema and are never reinterpreted under a new adapter.

### Provider Connection contract

A V1 connection MUST contain:

```yaml
connection_id: opaque Kestrel ID
project_id: exactly one Kestrel Project
provider_kind: openai_direct | anthropic_direct | vertex_ai | azure_foundry | bedrock | ...
credential_handle: opaque secret-store reference
upstream_scope: {account_or_tenant_id, project_workspace_subscription_id}
auth_kind: api_key | workload_identity | entra_id | aws_sigv4 | other_typed_kind
allowed_profile_ids: explicit set
status: pending_test | enabled | suspended | revoked
timestamps: {created_at, rotated_at}
```

The same `credential_handle` MUST NOT be bound to multiple Kestrel Projects in V1. Prefer a dedicated upstream project/workspace/principal and provider-side model/rate/spend restrictions. OpenAI projects support Project-scoped service accounts, model controls, usage, and limits; Anthropic API keys and caches are workspace-scoped with workspace limits and cost reporting. ([OpenAI Projects](https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects), [Anthropic Workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces)) Cloud adapters SHOULD use short-lived workload identity: Google Application Default Credentials/IAM, Microsoft Entra ID/RBAC, or an AWS role scoped to the required Bedrock inference action. ([Google authentication](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/gcp-auth), [Microsoft Entra ID](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/configure-entra-id), [Bedrock InvokeModel permission](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html))

Only the egress broker resolves the credential handle. Secret bytes MUST NOT enter queues, worker memory, prompts, artifacts, URLs, command arguments, ordinary logs, browser storage, or database domain records. Rotation changes the secret version without changing the connection's domain identity; revocation suspends every profile using it.

### Provider Profile and attestation contract

A profile is endpoint/deployment-specific:

```yaml
profile_id: opaque Kestrel ID
connection_id: one Project-bound connection
surface: {api_family, https origin, allowlisted path, exact API version or tightly expired stable channel}
target: {requested ID, target kind, version policy, expected resolved ID}
route: {request region, finite processing-region set, service tier/throughput}
features: {instruction channel, structured-output dialect/subset, stateless state}
optimizations: {streaming, prompt cache, token-count mode}
forbidden_features: [tools]
data_policy: {training, no application state, abuse retention and exceptions}
privacy_scope: {human review, storage regions, processing regions, entitlement}
limits: context, output, request bytes, concurrency, timeout, attempts, cost
attestation: evidence refs, adapter tests, observed_at, expires_at, digest
```

Adapter defaults never fill a missing profile value at invocation time. Redirects are disabled unless the destination is pre-attested as part of the same exact surface. DNS, TLS, proxy, and egress enforcement follow `RF-SEC-10`.

### Capability levels

Each request classifies every relevant behavior:

| Level | Meaning | May an adapter emulate it? |
| --- | --- | --- |
| `hard_requirement` | Invocation is invalid unless the profile has current native/attested support. | No. |
| `optional_optimization` | Kestrel remains correct without it; use is profile-approved and observable. | Yes, but it must not alter guarantees. |
| `provider_native_guarantee` | Exact surface promises a behavior and conformance verifies the mapping. | No; local validation may add defense. |
| `prompt_emulation` | Prompt wording seeks a behavior with no provider enforcement. | Only for quality hints, never to satisfy a hard requirement. |
| `forbidden` | The capability must be absent even if the provider offers it. | No. |

Examples: native JSON Schema shape control is a V1 hard requirement and provider-native guarantee; local schema validation is a Kestrel guarantee; caching and streaming are optional optimizations; asking for JSON in prose is prompt emulation; tools and provider storage are forbidden.

### Review First V1 minimum profile

An eligible profile MUST demonstrate all of the following for the exact approved surface and target:

- text input and output with UTF-8 byte limits;
- a provider-native system or developer instruction channel distinct from untrusted task input;
- stateless request mode with provider application storage disabled;
- provider-native structured output for `kestrel.review-json-schema/1`;
- a bounded context window and bounded requested output;
- typed terminal success, refusal/filter, length/context limit, provider error, and transport error;
- provider request/correlation ID capture when the surface emits one;
- reported input/output usage when the surface emits it, with unknown fields preserved;
- a current data-policy attestation satisfying Project policy;
- fixed exact-origin egress and no caller-defined URL; and
- conformance evidence for the adapter version, profile digest, and Kestrel schema bundle.

`kestrel.review-json-schema/1` deliberately uses a small shape subset: root and nested objects, arrays, strings, numbers, integers, Booleans, fixed string enums, `required`, and `additionalProperties: false`. Every declared property is required; optional collections are represented by empty arrays. It excludes unions, conditionals, recursion, remote references, custom formats, regex-dependent semantics, and schema-supplied default values. Bounds and evidence semantics are always enforced locally. The live conformance ticket may narrow this subset if a supposedly supported surface rejects or ignores it; expanding it is additive only after two-surface evidence.

V1 MUST NOT send or enable:

- client- or server-executed tools/function calls;
- hosted web search, repository search, file search, retrieval, grounding, connectors, MCP, code execution, or computer use;
- provider files, vector stores, prompt resources, managed agents, or arbitrary URLs;
- stateful conversations, threads, sessions, previous-response continuation, background mode, or stored responses;
- image, audio, video, or binary content;
- provider callbacks/webhooks;
- Repository Provider credentials or other secrets; or
- any repository mutation, comment, check, review, branch, commit, or merge operation.

These exclusions are schema-level and broker-enforced, not prompt instructions.

### Typed request

```yaml
contract_version: kestrel.model-inference/v1
invocation_id: Kestrel-generated UUID
logical_idempotency_key: hash(Project, review revision, stage, prompt, schema, profile)
project_id: exact Project
review_revision_id: exact immutable review revision
profile_id: exact approved profile
profile_attestation_digest: expected current digest
purpose: review_first.change_overview | review_first.conceptual_review | other_allowlisted
policy_instruction: Kestrel-versioned text reference plus digest
input_blocks: bounded text plus Project/revision/source provenance
output_schema: Kestrel schema ID, version, digest, and bounded inline schema
generation: {max_output_tokens, optional approved temperature}
deadline_at: absolute deadline
budget: {input bytes, estimated input tokens, output tokens, decimal money}
requirements: explicit capability levels
```

The request contains no credential, host, free-form provider options, model alias, tool list, storage flag, or retry count. Those values come only from the approved profile and Kestrel policy. The adapter rejects fields it cannot map faithfully; it does not drop them.

### Typed result and stop outcome

```yaml
invocation_id: original Kestrel ID
attempts: immutable ordered transport-attempt summaries
profile_snapshot: exact profile and attestation digest
requested_target: target from profile
resolved_target: provider-returned model/deployment/version/route/service tier fields
terminal_state: succeeded | refused | filtered | incomplete | failed | cancelled | outcome_unknown
stop: {normalized category, bounded raw provider code}
output_blocks: bounded typed text/structured blocks
structured_value: parsed JSON only after native assembly and syntax validation
provider_request_ids: typed name/value set
usage: typed normalized usage plus bounded provider-raw dimensions
validation: schema, bounds, provenance, evidence, and semantic results
timestamps: queued, sent, first_event, terminal
```

Only `terminal_state: succeeded` plus all local validations can feed a Review First artifact. A refusal, filter, incomplete stream, forbidden tool call, malformed JSON, unknown schema field, unresolved evidence ID, or missing terminal event is a non-success result even if useful prose was received.

### Typed errors

The stable error envelope is:

```yaml
category: invalid_request | policy_denied | auth | permission | target_unavailable | rate_limited |
          quota_exhausted | overloaded | provider_internal | timeout | transport |
          stream_interrupted | cancelled | malformed_response | unsupported_capability |
          attestation_stale | budget_exceeded | unknown
phase: preflight | connect | request_delivery | response_headers | stream | validation
delivery: not_sent | rejected_before_inference | possibly_accepted | accepted
retryability: safe_automatic | explicit_new_invocation | operator_only | never | unknown
provider: {HTTP/RPC status, bounded raw code, typed request IDs}
retry_after: bounded duration or null
message_safe: redacted Operator-facing summary
detail_ref: protected evidence reference, never raw secret-bearing text
```

Adapters classify by documented status/code and phase, never message-string matching alone. New provider codes map to `unknown` and remain observable. Authentication, permission, policy, invalid request, unsupported capability, exhausted budget/quota, and stale attestation are never transient retries.

### Usage and accounting

Normalized usage is loss-aware, not falsely uniform:

- `input_tokens`, `output_tokens`, `total_tokens` when reported;
- `cached_input_read_tokens` and `cache_write_tokens` when reported;
- provider-specific reasoning/thought, tool, media, character, request, or throughput dimensions in a typed extension map;
- `count_source`: provider reported, provider preflight, local estimate, or unavailable;
- `cost_estimate_before`, `cost_estimate_after`, and `cost_reconciled` as decimal money;
- price catalog source, currency, unit rules, effective time, retrieved time, and digest; and
- reconciliation status: `estimated`, `provider_reported`, `billing_reconciled`, `disputed`, or `unknown`.

Provider pricing separates dimensions such as input/output, cache reads/writes, long context, service/batch modes, media, and provisioned throughput; the official price pages are mutable. ([OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Vertex pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing), [Azure pricing](https://azure.microsoft.com/en-us/pricing/details/azure-openai/), [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)) Kestrel MUST NOT calculate money from total tokens alone or treat response usage as a provider invoice.

The egress broker reserves the worst-case configured cost before sending, releases the difference after terminal usage, and keeps a conservative reservation while outcome or usage is unknown. Project budgets are hard local gates even when provider spend settings are soft alerts. Every physical provider attempt creates a ledger entry; retries are never free or hidden.

## Selection, approval, and drift

### Profile lifecycle

Profiles move through these states:

```text
draft -> connection_tested -> conformance_passed -> approved -> active
                 \-> rejected          active -> stale/suspended -> re-attested
                                                   \-> retired
```

Only `active` can receive a request. Activation requires current connection health, conformance evidence, policy attestation, and an Operator approval whose Project, stage, data classes, and profile digest match exactly.

### Operator approval UX contract

Before approval, Kestrel shows:

- provider and operator, API family, exact origin, account/project/workspace scope, and auth kind;
- exact target kind and identifier, pinning/alias/upgrade behavior, known resolved version, and service tier;
- request and possible processing/storage regions, including routing sets;
- training use, application state, abuse retention, ZDR/MAM equivalent, human-review possibility, exceptions, and evidence expiry;
- enabled native features and explicitly forbidden features;
- context/output/request limits, throughput/quota class, concurrency, timeout, and retry policy;
- price snapshot and Project hard budgets; and
- conformance result, adapter version, limitations, and attestation digest.

Approval is not a blanket “trust provider” checkbox. It is a signed Kestrel audit event over the displayed digest. Editing any approved field creates a new draft profile; it never mutates historical approvals.

### Runtime selection

The scheduler receives a `profile_id`, not a provider preference. It checks the intersection of:

1. Project connection authorization;
2. current profile and attestation state;
3. Operator approval for Review First and the input data classes;
4. request hard requirements and forbidden capabilities;
5. remaining byte/token/time/concurrency/cost budgets; and
6. target/provider rate and availability state.

If more than one profile is eligible, V1 does not auto-rank or route between them. The Project has one Operator-selected default Review First profile, and each attempt snapshots it. Changing the default affects only new attempts and is itself audited.

### Drift and reapproval triggers

Profiles become `stale` immediately on detected or elapsed attestation for changes to:

- origin, path/API version, provider operator, account/project/workspace, or auth scope;
- requested target, resolved version, alias/deployment upgrade policy, inference profile, or routing destinations;
- processing/storage region, retention, training, human review, abuse monitoring, or application state;
- capability support, schema dialect/subset, default storage/cache/tool behavior, limits, or service tier;
- price rules beyond an Operator-configured tolerance; or
- adapter binary, boundary major version, failed conformance, provider retirement notice, or unknown catalog response.

Price-only drift MAY keep an existing profile technically eligible when it remains inside an explicit approval tolerance and hard budget; every other security/privacy/capability drift requires re-attestation, and policy-worsening drift requires fresh Operator approval. Failure to refresh is a visible `attestation_stale`, not availability fallback.

## Retry, idempotency, fallback, and cancellation

### Idempotency boundary

`logical_idempotency_key` deduplicates Kestrel scheduling and durable result publication. It does not prove provider-side exactly-once inference or billing. The reviewed synchronous inference surfaces do not supply one portable, documented idempotency guarantee, so V1 assumes none.

Each outbound delivery is a numbered physical attempt. If a future exact surface has a documented idempotency key, it may be added as a profile capability only after live conformance; Kestrel still records every delivery and does not generalize that guarantee to another endpoint.

### Kestrel-owned bounded retry

Default V1 budget is at most **two physical attempts** for one logical invocation and only while the original deadline and reserved cost permit. SDK retries MUST be disabled; if impossible, their maximum and telemetry must be proven and each SDK delivery consumes this same budget.

An automatic retry is allowed only when Kestrel can classify the first attempt as `not_sent` or `rejected_before_inference`, for example a local connection failure before any body bytes or a documented rate/capacity rejection with bounded `Retry-After`. Delay uses capped exponential backoff plus jitter and never exceeds the absolute deadline.

There is no automatic retry when delivery is `possibly_accepted` or `accepted`: timeout after body delivery, connection loss after headers, interrupted SSE, malformed terminal response, local validation failure, or missing usage all become terminal `outcome_unknown`, `stream_interrupted`, or `malformed_response` as appropriate. This avoids duplicate analysis and spend without pretending the provider did no work.

V1 performs no automatic semantic “repair” inference after a refusal, safety stop, truncation, or schema/evidence validation failure. A deliberate new attempt receives a new invocation ID, new budget reservation, explicit relation to the prior attempt, and the same exact profile unless the Operator separately chooses another.

### Fallback

There is no automatic fallback across profiles, providers, endpoints, deployments, models, aliases, versions, regions, service tiers, retention modes, or feature modes. Provider-managed routing is allowed only when its complete route set and guarantees are part of the approved profile; unbounded/global route drift makes a strict-region profile ineligible.

On failure Kestrel presents the typed cause and eligible separately approved alternatives. The Operator may explicitly start a new review attempt. That is reselection, not fallback: provenance, cost, result, and approval remain separate. Review artifacts from unlike profiles are never silently combined or substituted.

### Cancellation

Before outbound delivery, cancellation is definitive and releases the reservation. After delivery, Kestrel aborts its transport and stops local assembly, then records `cancel_requested` and the best known remote state. Without an exact provider-confirmed cancellation operation, the terminal state is `outcome_unknown`; usage and cost reservation remain pending reconciliation. No accepted partial stream becomes a review artifact.

## Observability and audit

For every logical invocation and physical attempt, Kestrel records content-minimized structured telemetry:

- Project, review revision, purpose, invocation/attempt IDs, logical idempotency digest, and queue lease;
- connection/profile IDs, approval and attestation digests, adapter/contract versions;
- requested and resolved model/deployment/version/route/service tier;
- timestamps for queue, connection, send, first event, terminal, validation, and cancellation;
- request bytes, estimated/reported token dimensions, reserved/reported/reconciled cost, and pricing digest;
- terminal/stop/error categories, delivery certainty, retry decision/reason/delay, and SDK-attempt count;
- provider request IDs and rate-limit headers as bounded typed metadata;
- schema/prompt/context manifest digests and local validation outcomes; and
- policy denial, drift, suspension, approval, rotation, and retirement events.

OpenAI exposes a request ID header, Anthropic exposes `request-id`, Vertex responses expose `responseId`, Azure Responses documents `apim-request-id`, and AWS responses expose AWS request identifiers; adapters preserve the namespace rather than collapsing them. ([OpenAI request IDs](https://platform.openai.com/docs/api-reference/backward-compatibility), [Anthropic request IDs](https://platform.claude.com/docs/en/api/errors), [Vertex response](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/GenerateContentResponse), [Azure Responses](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/responses), [AWS request IDs](https://docs.aws.amazon.com/bedrock/latest/APIReference/CommonParameters.html))

Ordinary logs contain no prompt, output, source, credential, authorization header, raw provider body, or unrestricted error string. Governed evidence may retain a bounded encrypted raw response according to the separate Kestrel retention decision; audit refers to it by protected handle.

## Adapter mappings without leaked abstractions

| Exact surface example | Private adapter mapping | Profile facts that must stay distinct |
| --- | --- | --- |
| OpenAI Responses | policy instruction -> `developer`/`system`; inputs -> typed items; schema -> `text.format`; assemble typed output/events | alias versus snapshot, `store`, response state/background, service tier, cache usage, endpoint-specific ZDR/residency |
| Anthropic Messages | policy instruction -> top-level `system`; text -> message content blocks; schema -> `output_config.format` | direct API versus partner platform, workspace, model ID/alias, cache TTL/usage, stop reason, ZDR/Covered Model status |
| Vertex `generateContent` | policy instruction -> `systemInstruction`; blocks -> `contents.parts`; schema -> response schema/config | Google project/location/publisher model, returned `modelVersion`, endpoint route, safety finish reason, DSQ versus provisioned throughput, cache/logging state |
| Azure Foundry Responses | neutral shape -> documented OpenAI-compatible request; authenticate through resource | tenant/subscription/resource, deployment name versus underlying model/version, API version, regional/DataZone/Global deployment, abuse-monitoring entitlement |
| Bedrock Runtime Converse | policy instruction -> `system`; blocks -> `messages`; schema -> `outputConfig`; map typed stop/usage/errors | runtime versus mantle, target/inference profile, route regions, surface-specific retention guarantee (never inherit mantle modes), guardrail/cache settings |

An OpenAI-compatible wire shape does not make two surfaces the same profile. Authentication, endpoint semantics, deployment identity, request IDs, feature availability, lifecycle, privacy, quota, retry behavior, and billing remain operator-specific.

## Conformance and deprecation

### Deterministic adapter suite

Every adapter MUST pass recorded boundary fixtures without live credentials:

- exact request mapping and rejection of unknown/free-form fields;
- privileged instruction separation and hostile role/content cases;
- Review First schema serialization and local validation;
- success, refusal, filter, truncation, context limit, forbidden tool request, and unknown stop reason;
- sync and, if advertised, fragmented/malformed/interrupted streaming assembly;
- error/status/header mapping, request IDs, `Retry-After`, and delivery certainty;
- disabled/accounted SDK retries and the two-attempt global budget;
- usage dimensions, unknown fields, decimal cost rules, cache metrics, and missing usage;
- deadline/cancellation before and after delivery; and
- secret, endpoint, Project, log, and cross-profile isolation canaries.

Contract fixtures are provider-shaped records obtained legally from official schemas or sanitized live evidence. They contain no private repository data or reusable credential.

### Live profile certification

Mock tests cannot prove current account entitlements, DNS/endpoint behavior, model schema support, returned identity, rate-limit headers, streaming failures, usage, billing, region routing, or retention configuration. Each production profile therefore needs a bounded live certification using synthetic public fixtures and a disposable Project-scoped credential.

Certification records provider timestamps/request IDs, exact request/response shape, profile and schema digests, observed capabilities, redacted evidence, and pass/fail. Privacy promises that cannot be technically observed are verified from current account configuration and primary contractual/service documentation, with source and expiry; they are not inferred from a successful call.

### Deprecation policy

Adapters watch official lifecycle/deprecation sources and profile health. A notice creates an auditable warning with provider deadline and proposed replacement, but never switches traffic. New approvals are blocked sufficiently before retirement for conformance and quality validation. At retirement the profile becomes `retired`; queued requests fail visibly.

A replacement target is a new profile with new conformance, privacy/cost attestation, and Operator approval. Historical results retain the retired profile snapshot. Anthropic, Vertex, Azure, and Bedrock explicitly document distinct model retirement or upgrade behavior, reinforcing that a generic provider lifecycle is unsafe. ([Anthropic deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations), [Vertex lifecycle](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions), [Azure upgrades](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/working-with-models), [Bedrock lifecycle](https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html))

## What is fixed now

This research fixes one versioned neutral boundary with endpoint/deployment-specific adapters, Project-exclusive credential handles, broker-only secret resolution, exact profile approvals, and no silent privacy/capability/route fallback. Capability levels preserve richer native behavior without leaking a lowest-common-denominator API.

Review First V1 is stateless and text-only, requires native structured output plus local validation, and excludes tools, hosted retrieval, arbitrary URLs, stateful threads, and repository writes. Results preserve typed identity, stop, error, delivery certainty, usage, and cost.

Kestrel owns bounded retries and SDK-attempt accounting, never retries an outcome-unknown delivery, and permits explicit Operator reselection only. Immutable approvals, drift suspension, conformance, deprecation, cost reservation, and billing reconciliation are also fixed.

## What still needs evidence or a downstream decision

### Empirical validation: one new AFK ticket

Create exactly one `wayfinder:task`:

**Title:** `Prove the Review First Model Provider boundary across unlike live surfaces`

**Task:** Implement a disposable contract harness for two unlike current surfaces—direct OpenAI Responses and direct Anthropic Messages are the recommended pair—and run only synthetic/public Review First fixtures. Demonstrate exact request mapping, the Kestrel schema subset, local validation, refusal/filter/truncation, streaming assembly, request IDs, usage/cache dimensions, token preflight, rate/error classification, disabled SDK retries, outcome-unknown interruption, cost reconciliation, profile drift, and account data-policy attestation. Record adapter/profile/schema digests and redacted evidence; use disposable Project/workspace-scoped credentials, no tools, no private source, and no production adapter commitment. If credentials or entitlement make that pair unavailable, use Vertex `generateContent` as the documented substitute and record why.

**Dependencies:** the new task depends on this ticket (#6). It may run in parallel with #9 because #9 tests conceptual extraction usefulness, not the transport/security boundary. Both the new task and #9 block #10. The new task does not block unrelated downstream Agent Run research.

This is genuinely separate from #9: a good conceptual review can hide adapter retries, identity drift, weak schema enforcement, or incorrect accounting. It is also separate from #10: the final spec should consume evidence, not perform live provider experiments during a HITL integration decision.

### Initial profile selection: no new HITL ticket

Do **not** create a separate “choose the initial provider/profile” grilling ticket. There are two different choices:

1. At runtime, each Operator explicitly approves and selects a Project profile; that product behavior is fixed here.
2. At release planning, Kestrel decides which adapter/profile combinations are certified for Review First. That decision needs the live boundary task plus #9 quality evidence and belongs in existing HITL #10, `Lock the Review First product and technical specification`.

A new human ticket now would either guess before evidence or duplicate #10. #10 must name the initially certified surface(s), schema bundle, minimum quality/evaluation evidence, default Project-profile onboarding, and any deployment prerequisites. Supporting additional production adapters remains expansion, not a hidden V1 promise.

### Existing fog

Keep the map's existing fog item, “Expansion to additional Repository Providers and Model Providers after the first adapters establish the required boundaries.” This ticket establishes the boundary, not the sequence or support policy for the wider catalog. Do not graduate it and do not add duplicate provider-by-provider fog items.

No separate tickets are justified now for caching, streaming, tools, stateful sessions, provider-managed retrieval, automatic routing, or Agent Run model use. They are optional/forbidden in Review First and belong to later stage-specific research only when the route reaches them.

## Limitations

- This is documentary research; no live account, regional route, ZDR/MAM entitlement, quota, SDK retry setting, schema subset, or billing export was tested. Documentation cannot prove effective account configuration, so attestation must combine primary sources with account evidence.
- A pinned model ID does not guarantee bit-for-bit deterministic output or unchanged safety/routing infrastructure.
- Preflight token counts and prices may differ from billed usage; ambiguous network outcomes can remain permanently unreconciled. Transport abort is not proven provider cancellation, and V1 has no portable exactly-once inference guarantee.
- Native structured output controls shape, not truth, source grounding, completeness, or evidence validity.
- The small schema subset is a research decision pending the two-surface live test; narrowing is allowed before #10, while later expansion requires new conformance.
- This contract does not select the best model for conceptual review quality or define evaluation thresholds; #9 and #10 own those decisions.
- Self-hosted local/open-weight inference can implement this boundary later, but model artifact trust, hardware scheduling, sandboxing, and local data policy require separate evidence.
- Pricing examples were intentionally omitted because exact prices are volatile; only dimensions and snapshot requirements are fixed.

## Downstream handoff

The final Review First spec should import this boundary by reference and lock only five remaining release facts after evidence: initially certified profile(s), exact `kestrel.review-json-schema/1` bundle, profile onboarding/approval UI, quality threshold from #9, and deployment prerequisites. Implementers can then build one adapter without coupling callers to it, while the live conformance harness proves that a second unlike adapter fits the same typed boundary.

The enduring rule is concise: **Kestrel selects and approves an exact profile, sends a typed stateless request through a credentialed broker, accepts only a terminal locally validated result, records every attempt and cost, and fails closed on uncertainty or drift.**
