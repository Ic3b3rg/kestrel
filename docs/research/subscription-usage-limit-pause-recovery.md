# Subscription usage-limit pause and recovery

**Research date:** 2026-08-20

**Decision status:** current profile supports only fail-closed handling of a coarse limit signal; automatic reset recovery is not conformant

**Scope:** Review First; exhaustion of usable quota in an otherwise valid AI subscription, not subscription expiry

## Decision

Review First should treat subscription usage exhaustion as a **workflow suspension**, not as a retry of the failed model call.

For the one initially selected subscription-backed route:

```text
ACP v1 -> codex-acp 1.6.2 -> Codex App Server 0.148.0
       -> ChatGPT OAuth/subscription
```

the upstream components expose relevant error and account-limit information in different layers. They do **not** expose, through the standard ACP surface, an exact subscription-exhaustion kind or one causally linked, typed contract containing the exhausted bucket and a trustworthy reset time. Consequently:

- the exact-version implementation field `usageLimitExceeded`, when present, can only select `Usage limit reached — action required`; the generic AIR category `limit` alone does not identify subscription exhaustion and is an unsupported/profile-nonconformant signal;
- `Waiting for usage reset` and timer-driven recovery remain disabled until a versioned extension supplies and live conformance proves the missing fields;
- Kestrel preserves only completed Kestrel-owned capability checkpoints, releases the Review Environment and runtime, and later reruns the interrupted capability in a **new model turn**;
- no failed/interrupted runtime turn is assumed resumable;
- no paid API route, alternate model, account, or profile is selected implicitly.

This is a proven ACP portability gap, so the smallest justified addition is a negotiated, versioned model-access extension to the ACP adapter. A complete vendor-native agent adapter is not justified by this evidence.

## Evidence labels

- **Established — standard:** guaranteed by the pinned public protocol.
- **Established — exact version:** implemented by the pinned upstream source, but not portable or forward-compatible without recertification.
- **Observed:** seen by the retained local live probe, but not exercised through the relevant failure/recovery path.
- **Proposed:** Kestrel contract derived from the evidence; not an upstream guarantee.
- **Not established:** absent, ambiguous, or not causally linkable on the examined surface.
- **Impossible to establish from signal:** the signal is only a forecast/indicator and cannot guarantee the claimed future state.

## Profile inventory and version boundary

There is one initial subscription-backed runtime profile. Direct OpenAI API access is an optional, separately authorized paid profile and is therefore not part of this matrix except as a prohibited fallback.

| Layer | Examined version | Relevant contract |
|---|---:|---|
| ACP | v1 schema at commit `44fbe948c46e58adc14a1472eb7856d0d9825b72` | Standard client/agent boundary |
| `codex-acp` | `v1.6.2`, commit `9780d314d34616b476b1ae451ad31089b3dce49a` | ACP-to-App-Server translation |
| Codex / App Server | `rust-v0.148.0`, commit `3ba0f711642a888aec92a611a3f3b2211157ff89` | Native quota, thread, and turn types |
| Auth/access | ChatGPT OAuth account and plan | Subscription access route |

`codex-acp` 1.6.2 declares `@openai/codex: ^0.148.0`, not an immutable runtime resolution [D4]. Kestrel therefore cannot identify the wire contract from the `codex-acp` version alone. Codex also labels the App Server CLI experimental [C8]. A conformant profile must attest the exact adapter version, resolved Codex version, generated App Server schema digest, ACP schema/SDK version, and extension version at launch. Codex documents that its generated JSON/TypeScript schemas are specific to the generating Codex version and match that version [C1]. Native quota fields in this report are consequently exact-version evidence, not stable ACP guarantees.

## Evidence matrix

| Required outcome | Standard ACP v1 | Pinned `codex-acp` / App Server | Conclusion for initial profile |
|---|---|---|---|
| Exact typed subscription-exhaustion signal | **Not established.** ACP stop reasons and JSON-RPC errors define no account-quota kind [A1]. | **Established — exact version, coarse.** Failed turns can carry `codexErrorInfo: "usageLimitExceeded"` [C4], but that value collapses ordinary usage-limit, quota-exceeded, and usage-not-included causes [C3]. | Usable only to select action-required when the implementation field is retained; it does not classify resettable subscription exhaustion. |
| Affected bucket/window | **Not established.** `usage_update` is context-window usage, not account quota [A1]. | **Established — exact version** in App Server snapshots (`limitId`, primary/secondary windows) [C2]. The failed turn does not carry the bucket, and account updates are not turn-scoped. | No proven causal turn-to-bucket association through ACP. |
| Reset timestamp | **Not established.** | **Established — exact version** as optional Unix-seconds `resetsAt` in a window and internally on `UsageLimitReachedError` [C2][C5]. It is lost from the public failed-turn category. | Not available as a typed ACP recovery contract. |
| Cause distinguishes resettable subscription window from credits/spend cap | **Not established.** | Native `RateLimitReachedType` distinguishes generic rate limit, workspace credit depletion, and owner/member usage caps [C2]. Public turn error collapses causes [C3]. | Must fail closed unless the extension preserves the native cause. |
| Full/sparse update semantics | **Not established.** | `account/rateLimits/read` returns a full view; `account/rateLimits/updated` is a sparse rolling update that must be merged or followed by a read [C1]. | Extension must expose snapshot generation/full-read semantics; a lone notification is insufficient. |
| Account/model-to-bucket mapping | **Not established.** | Multiple `rateLimitsByLimitId` entries exist, but the examined schema exposes no model-to-limit mapping. | Treat route conservatively as one constrained domain unless the failed response identifies the active bucket. |
| Capacity is available at `resetsAt` | **Impossible to establish from signal.** | Timestamp represents a stated reset, not a reservation or future success guarantee. | It is `resetNotBefore`, when to recheck once; never proof that all queued work may start. |
| Quota data reaches ACP as typed data | **Not established.** `_meta` supports negotiated extensions, but values are otherwise opaque [A2]. | `codex-acp` keeps rate limits internally and renders them in `/status`; standard ACP gets context usage only [D2][D5][D6]. | Human text parsing is prohibited. Add a versioned extension. |
| Typed adapter failure is sufficient | N/A | JetBrains AIR `_meta` v1 can report category `limit`, but has no quota kind, bucket, or reset [D2][D3][D5]. Without it, the adapter returns implementation-specific error data. | Current AIR extension is insufficient and must not be reinterpreted as the Kestrel contract. |
| Thread survives process restart | ACP `session/load` and optional `session/resume` are established, with different replay behavior [A3]. | **Established — exact version** for a non-ephemeral persisted Codex thread reopened with `thread/resume` [C1][D1]. | Conversation can continue in a new turn if native storage remains; this is not same-turn recovery. |
| Thread survives Review Environment disposal | **Not established.** | Codex stores rollouts under `CODEX_HOME`; ephemeral threads are memory-only [C1][C7]. Disposal removes environment-local state unless explicitly retained. | Kestrel must not depend on native thread storage for correctness. |
| Same interrupted turn resumes | **Not established.** ACP prompt completion is terminal; load/resume restores a session, not an in-flight request [A1][A3]. | `thread/resume` opens a thread so a later `turn/start` can append; no same-turn resume contract [C1][D1]. | Always start a new turn for the interrupted capability. |
| Exhaustion, reset, restart, and recovery work live | N/A | **Observed only:** the retained Codex 0.146.0 probe saw ChatGPT account data, named limit buckets, resets, and update notifications, but did not exhaust a limit or test recovery/restart [K1][K2]. | Release gate remains open; current evidence cannot certify automatic recovery. |
| Silent paid fallback is absent | ACP does not govern route policy. | No upstream invariant proves Kestrel route selection. | Must be enforced and network-observed by Kestrel conformance. |

## Exact signal chain

### Standard ACP v1

ACP's terminal `PromptResponse.stopReason` values are `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, and `cancelled`. Its `usage_update` reports tokens in the current context and context size, with optional cost; it is not an account entitlement or quota feed. Generic JSON-RPC errors have no standardized subscription-quota code. ACP therefore provides no portable answer to “which account limit stopped this turn, and when should it be tried again?” [A1]

ACP deliberately reserves `_meta` for extensions and says implementations must not assume the meaning of unknown keys [A2]. That is the correct transport for a deliberately negotiated Kestrel requirement, but the extension itself must be versioned and capability-negotiated.

### Codex App Server 0.148.0

At the native layer, a backend HTTP 429 body with type `usage_limit_reached` becomes `UsageLimitReachedError` with optional `plan_type`, `resets_at`, `rate_limits`, and `rate_limit_reached_type` [C5]. Core marks that error non-retryable and ends the turn rather than retrying it [C3][C6].

The public App Server failure then loses material detail: `UsageLimitReached`, `QuotaExceeded`, and `UsageNotIncluded` all map to `CodexErrorInfo::UsageLimitExceeded` [C3]. The failed `turn/completed` payload exposes the category, message, and optional additional details, but no typed reset or bucket [C1][C4]. Messages are presentation strings and are not a compatibility contract.

Separately, `account/rateLimits/read` and `account/rateLimits/updated` expose typed snapshots [C1][C2]:

- `rateLimits` is a legacy single snapshot;
- `rateLimitsByLimitId` is the set keyed by metered limit ID;
- each `RateLimitSnapshot` can have `limitId`, `limitName`, primary and secondary `RateLimitWindow`, credits, individual limit, spend-control state, plan type, and `rateLimitReachedType`;
- a window has `usedPercent`, optional duration minutes, and optional Unix-seconds `resetsAt`;
- causes are `rate_limit_reached`, workspace owner/member credits depleted, and workspace owner/member usage limit reached.

Updates are account-global, not identified by thread or turn. A nearby update cannot by itself prove which bucket caused a particular failure. Nullable/missing fields in the sparse update do not mean that a previously known value was cleared; the consumer must merge against the last complete snapshot or refetch [C1].

### `codex-acp` 1.6.2

`codex-acp`'s ACP load and resume paths call App Server `thread/resume`; load additionally reads/replays history [D1].

The adapter receives `account/rateLimits/updated` into session state, but emits standard ACP `usage_update` only from token/context usage. Rate-limit details are rendered as human-readable `/status` output, not sent as typed quota data [D2][D5][D6]. Parsing `/status`, error messages, or reset prose would couple safety behavior to localization/presentation and is rejected.

The adapter's internal classifier maps `usageLimitExceeded` to `quota_exhausted`. Its current typed JetBrains AIR failure extension reduces that to category `limit` with no action, while the wire schema has no quota-specific kind, affected bucket, reset, snapshot age, route identity, or source schema version [D2][D3][D5]. Other limit failures can share the same category. This proves that current typed ACP output is insufficient even though the adapter internally knows a more specific label.

## Reset and bucket trust contract

Automatic waiting is allowed only after a conformance-certified adapter emits one terminal, causally associated typed event satisfying all of these conditions:

1. Cause is the known, resettable subscription-window cause; credit depletion, workspace spend caps, usage-not-included, authentication, overload, generic HTTP 429, and unknown future enum values are excluded.
2. Event identifies the failed session and turn, exact route/profile/account or workspace, affected limit ID(s), blocking window(s), `resetNotBefore`, observation time, and full-snapshot generation.
3. Bucket information came from the failed response or another upstream mechanism that establishes causal association. Temporal adjacency to an account update is not enough.
4. Event identifies ACP, adapter, Codex, generated-schema, and extension versions that passed conformance.
5. Kestrel validates timestamp type/range and clock skew, then performs a full rate-limit read at or after `resetNotBefore`; it does not treat a sparse notification as a fresh full snapshot.

State mapping is fail closed:

| Input | Workflow access state | Automatic action |
|---|---|---|
| Certified resettable cause + causally identified bucket + valid future reset | `Waiting for usage reset` | Release resources; enqueue one recheck no earlier than reset. |
| Typed exhaustion, but reset/bucket/causal/version data missing | `Usage limit reached — action required` | None. Preserve compatible checkpoints. |
| Credit depletion or workspace spend/usage cap | `Usage limit reached — action required` | None; operator/admin changes access. |
| Authentication failure | `Needs authentication` | None until identical route/account is reauthenticated. |
| Overload, transport failure, generic 429, unknown enum, or outcome-unknown delivery | `Failed` or profile-nonconformant, according to the existing failure contract | Never infer subscription exhaustion. |

`resetNotBefore` is only a lower bound for a recheck. It does not guarantee credits, model availability, unchanged policy, or that another consumer did not use the refreshed allowance. A reset in the past, absent reset, implausible time, unknown bucket, or failed full read cannot trigger automatic admission.

Kestrel must not automatically consume earned reset credits, purchase credits, raise caps, switch models, or select an API key. Those are access/configuration changes requiring explicit operator authorization.

## Recovery and persistence

### Native thread semantics

ACP distinguishes `session/load` (restore context and replay history) from optional `session/resume` (continue without replay) [A3]. Codex persists non-ephemeral rollout JSONL below `CODEX_HOME/sessions/...` and can reopen it with `thread/resume`; an ephemeral thread is memory-only [C1][C7]. In both protocols, recovery means a later prompt/turn in a restored session, not continuation of the same interrupted model turn.

Native state can survive a process restart only when its durable storage is retained and compatible. It does not survive disposal of a contained Review Environment whose local filesystem is destroyed. Retaining the full native rollout would also retain prompts, model items, commands, and tool events, enlarge the trusted/retention surface, couple recovery to a runtime format, and still not provide same-turn resume [C1][C7].

Therefore quota recovery must work after both process restart and complete runtime disposal without native thread state:

1. persist Kestrel checkpoints and queue state outside the Review Environment;
2. cancel/close the active request, reject late events, and dispose the runtime/environment;
3. at admission, revalidate authorization, Proposal State, source head/revision, Change Intent, Analysis Configuration, account, and exact route/profile;
4. create a fresh contained environment and fresh runtime thread;
5. reconstruct context from immutable Kestrel inputs plus compatible completed checkpoints;
6. run the interrupted capability in a new model turn.

Native session resume may be tested as an optimization for other failure classes, but it is not a correctness dependency for subscription recovery and cannot change the checkpoint boundary.

### Minimum Kestrel checkpoint

The smallest safe checkpoint is one completed, declared, versioned **Analysis Capability invocation**, or one predeclared independently valid partition of it. Kestrel commits it only after:

- the runtime turn ended successfully;
- output and evidence passed local schema and semantic validation;
- provenance and content digests were computed; and
- result plus completion record were atomically stored outside the Review Environment.

Its compatibility/idempotency key includes at least:

```text
project
review revision (base and head)
Change Intent digest
Analysis Configuration digest
capability ID and version
partition ID
dependency checkpoint digests
```

Partial assistant text, streamed chunks, individual tool results, a runtime plan, a failed/cancelled turn, and the native thread/rollout are not checkpoints. A late completion after pause is accepted only if its attempt is still authoritative and the atomic idempotency key is absent; otherwise it is ignored. Completed capabilities are reused exactly once, while the interrupted atomic capability is discarded and rerun. Large work must be split into declared, independently valid partitions before execution, not checkpointed opportunistically inside an opaque turn.

The Change Overview may remain visible during a pause only when it is itself a completed, validated capability checkpoint and the UI labels the workflow as waiting; no partial output is promoted to published analysis.

## Route-scoped admission after reset

Many reviews can become eligible at the same timestamp. They must not each create a runtime and probe the provider.

Kestrel owns one durable, operator-prioritizable queue per constrained access route. The route key includes the exact subscription profile, account/workspace, adapter/schema/extension versions, and model; it includes affected bucket IDs when a certified mapping exists. When mapping is absent, the key is deliberately coarser and serializes all subscription work for that account/profile.

At `resetNotBefore`:

1. a single route coordinator performs the full quota read/revalidation;
2. at most one canary workflow is admitted under the Resource Envelope;
3. remaining eligible workflows stay resource-free and are admitted at controlled route concurrency only after success establishes current availability;
4. order is operator priority, then original pause time/FIFO, with starvation protection;
5. each workflow independently revalidates its proposal, source, intent, configuration, authorization, route, and checkpoint compatibility before allocation;
6. a new certified exhaustion re-pauses the route, stops further admissions, preserves checkpoints, and schedules no tight retry loop.

Queue records, pause reason, signal provenance, reset lower bound, checkpoint keys, and attempt lineage survive Kestrel restart. Stop removes that workflow from the queue. Review Again creates a fresh authorization/configuration lineage rather than mutating a paused run.

## Retry-semantics reconciliation

The earlier Model Provider rule remains valid: usage exhaustion is non-transient for the current model call, and a possibly accepted or outcome-unknown delivery is not automatically retried.

Workflow suspension is a different boundary:

- it begins only after a conclusive typed terminal usage-exhaustion outcome;
- it does not retry or resume the same physical turn;
- it preserves only completed Kestrel capability checkpoints;
- after reset revalidation it starts a new, audited capability attempt and physical turn under the same still-valid authorization and Analysis Configuration;
- the new attempt is linked to the suspended attempt for audit/deduplication.

The Review authorization must explicitly cover this same-input, same-profile suspend-and-resume transition; otherwise recovery is action-required. Any existing cap on physical deliveries remains local to each model-inference attempt and is not reset to replay an outcome-unknown call.

If delivery outcome is unknown, Kestrel does not infer quota from a nearby notification and does not enter the waiting queue. The older no-automatic-retry rule wins. Likewise, changing account, model, adapter profile, or moving to direct API access requires explicit Review Again; it is not recovery of the existing run.

## Required extension contract

The initial profile can support timer-driven recovery only after negotiating a versioned ACP `_meta` capability whose typed terminal event contains:

```text
version
kind: subscription_window_exhausted | credits_depleted |
      workspace_cap_reached | usage_not_included | unknown
session_id, turn_id
route_id, account_or_workspace_id, profile_id, model_id
affected_limits[]: { limit_id, window, reset_not_before }
observed_at, snapshot_generation, snapshot_is_full
acp_version, adapter_version, runtime_version, schema_digest
```

It also needs a typed full-snapshot/read operation. New enum values decode to `unknown`; required fields are never reconstructed from prose. The event must define whether its bucket came directly from the failed response. Merely forwarding the existing AIR category `limit`, account-global update, or `usageLimitExceeded` string does not satisfy this contract.

Prefer adding/generalizing this contract upstream in `codex-acp`. A narrowly scoped native observer is acceptable only if extension work is infeasible; it must expose the same contract and remain subordinate to the ACP agent/session boundary.

## Conformance and release gates

Every exact profile resolution must pass the following suite before it may advertise automatic reset recovery.

### Static and startup attestation

- Pin and record ACP schema/SDK, `codex-acp`, resolved Codex binary, generated App Server schema digest, extension version, and model-access route.
- Reject the profile if the extension is absent, unnegotiated, changes schema, or produces unknown cause enums/required fields.
- Prove the active credential is ChatGPT OAuth/subscription and that direct API/gateway credentials are not reachable by this route.

### Deterministic fault conformance

- Inject certified resettable exhaustion with causal bucket and future reset: state waits, checkpoints persist, request/runtime/environment close, and zero calls occur before the reset lower bound.
- Omit/reset/mutate bucket, reset, turn ID, route identity, snapshot generation, or version: state becomes action-required; no timer is armed.
- Inject credit depletion, owner/member cap, `usage_not_included`, auth failure, overload, generic HTTP 429, and unknown future values: each reaches its explicit non-waiting state.
- Deliver sparse updates with null/missing fields: prior state is not cleared; a full read is required before admission.
- Supply past/implausible resets and clock skew: no immediate retry loop.
- Crash and restart Kestrel while paused: queue, checkpoint, reset provenance, and attempt lineage survive.
- Restart App Server with retained `CODEX_HOME`: restored session accepts only a new turn; no same-turn claim is made.
- Dispose the full Review Environment and native state: fresh-thread reconstruction from Kestrel checkpoints still succeeds.
- Emit partial text/tool events and then fail: none becomes a checkpoint or published analysis.
- Emit a late success after cancellation/pause: attempt authority and atomic idempotency prevent duplicate completion/publication.
- Make several reviews eligible on the same route: one read/canary occurs, priority/FIFO is respected, and runtime allocation stays within controlled admission.
- Keep the provider exhausted after the forecast reset: the route re-pauses without a retry storm or loss of completed checkpoints.
- Change source head, intent, configuration, account, model, or profile while waiting: automatic resume is rejected and incompatible checkpoints are not reused.
- Instrument outbound access: no request uses direct API credentials, paid fallback, a different model, or a different account.

### Live gates

The retained probe is useful shape evidence, not recovery proof [K1][K2]. Before enabling automatic waiting in production, an authorized sacrificial subscription test must exercise, for the exact version-attested profile:

1. real subscription-window exhaustion;
2. causal typed event and full snapshot capture;
3. no provider call before reset;
4. process restart and full runtime/environment disposal while paused;
5. reset recheck, controlled fresh-thread admission, and completion without duplicating a completed capability; and
6. network evidence of no paid API or alternate-route call.

The test must not intentionally burn an operator's working allowance without explicit authorization. If a real exhaustion/reset cannot be reproduced safely, the profile remains action-required-only. Exact runtime/schema/extension upgrades require recertification.

## Unresolved evidence gaps

| Gap | Consequence |
|---|---|
| No negotiated quota/reset extension exists in the examined ACP profile. | Automatic waiting and reset recovery remain unsupported. |
| App Server exposes multiple bucket IDs but no general model-to-bucket mapping. | Queue at the conservative account/profile route scope unless the failed response identifies the bucket. |
| No retained live test exhausted quota, crossed the reset, restarted Kestrel, and disposed the runtime. | The deterministic contract is not yet release-certified. |
| `resetsAt` cannot promise future availability. | Even after certification, use it only as a lower bound for a serialized recheck/canary. |
| `codex-acp` permits the resolved Codex dependency to move within a semver range. | Runtime launch must attest the actual binary and schema digest; upgrades recertify. |

## Acceptance decision

The research question is resolved with a conditional contract:

- **Accept now:** fail-closed handling of the pinned adapter's coarse limit/error surfaces: retained exact-version `usageLimitExceeded` may select action-required, while generic AIR `limit` is unsupported; neither is treated as exact resettable subscription exhaustion. Preserve completed Kestrel checkpoints, release resources, expose an explicit operator state, and never use paid fallback.
- **Do not accept now:** automatic `Waiting for usage reset`, timer-driven resume, or affected-bucket scheduling on standard ACP / `codex-acp` 1.6.2 alone.
- **Enable later only when:** the required versioned extension passes deterministic and live exhaustion/reset/restart/disposal conformance.
- **Recovery semantics:** fresh runtime thread and new turn for the interrupted Analysis Capability; never same-turn continuation.

This closes the design decision without claiming an upstream capability that does not exist.

## Primary sources

- [A1 — ACP v1 schema, pinned commit](https://github.com/agentclientprotocol/agent-client-protocol/blob/44fbe948c46e58adc14a1472eb7856d0d9825b72/schema/v1/schema.json)
- [A2 — ACP extensibility, pinned commit](https://github.com/agentclientprotocol/agent-client-protocol/blob/44fbe948c46e58adc14a1472eb7856d0d9825b72/docs/protocol/v1/extensibility.mdx)
- [A3 — ACP session load/resume, pinned commit](https://github.com/agentclientprotocol/agent-client-protocol/blob/44fbe948c46e58adc14a1472eb7856d0d9825b72/docs/protocol/v1/session-setup.mdx)
- [C1 — Codex App Server protocol README, 0.148.0 commit](https://github.com/openai/codex/blob/3ba0f711642a888aec92a611a3f3b2211157ff89/codex-rs/app-server/README.md)
- [C2 — App Server account/rate-limit types, 0.148.0 commit](https://github.com/openai/codex/blob/3ba0f711642a888aec92a611a3f3b2211157ff89/codex-rs/app-server-protocol/src/protocol/v2/account.rs)
- [C3 — Codex error retryability and public error translation, 0.148.0 commit](https://github.com/openai/codex/blob/3ba0f711642a888aec92a611a3f3b2211157ff89/codex-rs/protocol/src/error.rs)
- [C4 — App Server public turn error type, 0.148.0 commit](https://github.com/openai/codex/blob/3ba0f711642a888aec92a611a3f3b2211157ff89/codex-rs/app-server-protocol/src/protocol/v2/shared.rs)
- [C5 — Backend usage-error mapping, 0.148.0 commit](https://github.com/openai/codex/blob/3ba0f711642a888aec92a611a3f3b2211157ff89/codex-rs/codex-api/src/api_bridge.rs)
- [C6 — Turn retry loop, 0.148.0 commit](https://github.com/openai/codex/blob/3ba0f711642a888aec92a611a3f3b2211157ff89/codex-rs/core/src/session/turn.rs)
- [C7 — Native rollout discovery/storage, 0.148.0 commit](https://github.com/openai/codex/blob/3ba0f711642a888aec92a611a3f3b2211157ff89/codex-rs/rollout/src/list.rs)
- [C8 — App Server CLI stability label, 0.148.0 commit](https://github.com/openai/codex/blob/3ba0f711642a888aec92a611a3f3b2211157ff89/codex-rs/cli/src/main.rs)
- [D1 — `codex-acp` session/thread bridge, v1.6.2 commit](https://github.com/agentclientprotocol/codex-acp/blob/9780d314d34616b476b1ae451ad31089b3dce49a/src/CodexAcpClient.ts)
- [D2 — `codex-acp` event/rate-limit handling, v1.6.2 commit](https://github.com/agentclientprotocol/codex-acp/blob/9780d314d34616b476b1ae451ad31089b3dce49a/src/CodexEventHandler.ts)
- [D3 — `codex-acp` AIR extension contract, v1.6.2 commit](https://github.com/agentclientprotocol/codex-acp/blob/9780d314d34616b476b1ae451ad31089b3dce49a/src/AirExtension.ts)
- [D4 — `codex-acp` package/runtime dependency, v1.6.2 commit](https://github.com/agentclientprotocol/codex-acp/blob/9780d314d34616b476b1ae451ad31089b3dce49a/package.json)
- [D5 — `codex-acp` ACP response and AIR failure types, v1.6.2 commit](https://github.com/agentclientprotocol/codex-acp/blob/9780d314d34616b476b1ae451ad31089b3dce49a/src/CodexAcpServer.ts)
- [D6 — `codex-acp` human `/status` quota rendering, v1.6.2 commit](https://github.com/agentclientprotocol/codex-acp/blob/9780d314d34616b476b1ae451ad31089b3dce49a/src/CodexCommands.ts)
- [K1 — retained Kestrel Codex subscription probe](https://github.com/Ic3b3rg/kestrel/blob/524241732b80bcd60d6e4e445e5a56018a912a56/experiments/model-provider-conformance/README.md)
- [K2 — sanitized retained quota-shape evidence](https://github.com/Ic3b3rg/kestrel/blob/524241732b80bcd60d6e4e445e5a56018a912a56/experiments/model-provider-conformance/evidence/openai-codex-subscription-2026-08-13.json)
