# Model Provider conformance evidence

**Status:** two-surface harness complete; live direct/API and managed-cloud captures blocked on disposable credentials

**Checked:** 2026-08-16

**Scope:** disposable evidence only; no production adapter decision

## Result

Kestrel can use an existing ChatGPT subscription programmatically through Codex App Server and ChatGPT OAuth. The final live probe authenticated as a ChatGPT account, selected `gpt-5.6-sol` from the subscription catalog, requested native structured output, received one valid result and one upstream OpenAI response ID, and independently validated the JSON.

That proves the access path. It does **not** make this exact surface eligible for the current strict Review First V1 profile. Codex App Server is an agent runtime, not the public OpenAI Platform Responses API. Its documented boundary does not currently prove that all tools were absent from the upstream request, expose control over built-in OpenAI retries, attest upstream `store=false`, expose account training/retention/residency settings, or report a monetary amount for one subscription-backed call. Exact per-completion usage and the response ID were observable only after requesting an experimental raw-event stream whose generated schema labels the completion notification internal-only.

The recommended domain distinction is therefore:

- `OpenAI / ChatGPT subscription / Codex App Server / model` is one **Model Provider Profile**.
- `OpenAI / Platform account / Responses API / model snapshot` is another Model Provider Profile.
- `AWS / Bedrock Runtime Converse / geographic inference profile` is a third Model Provider Profile.
- A provider name or model name alone must never select between them. Authentication, billing/quota, runtime, data policy, and control semantics are part of profile identity.

This follows the same architectural separation visible in OpenClaw: subscription-backed agent models use the Codex runtime, while non-agent OpenAI APIs remain Platform access. Hermes independently supports ChatGPT OAuth/device-code access for Codex models.

## OAuth clarification

The supplied [plugin authentication guide](https://developers.openai.com/plugins/build/auth) is valid but documents the opposite authorization direction from model inference:

- resource server: the plugin author's MCP server;
- authorization server: the plugin author's identity provider;
- OAuth client: an OpenAI host such as ChatGPT or Codex.

For Kestrel obtaining subscription-backed model access, the relevant official surface is [Codex authentication](https://developers.openai.com/codex/auth) plus [Codex App Server](https://developers.openai.com/codex/app-server). OpenAI documents ChatGPT sign-in for subscription access and App Server login methods for browser and device-code flows. The [Codex SDK](https://developers.openai.com/codex/sdk) is also explicitly intended for integrating Codex into applications and internal workflows.

## What ran

Two model calls used only the public synthetic fixture in `fixtures/review_request.json`: an initial development probe exposed ambient global runtime configuration, then the final probe reran in the isolated configuration below. Only the final isolated call is retained as published evidence.

- one fresh, ephemeral thread;
- a fresh empty working directory;
- a disposable Codex home containing only a permission-`0600` copy of the existing OAuth file;
- no copied user config, plugins, hooks, history, memories, skills, or project instructions;
- read-only sandbox and approval policy `never`;
- no dynamic tools, environments, capability roots, model fallback, repository content, file input, URLs, or callbacks;
- one model turn with `outputSchema`, followed by strict local validation;
- raw event payloads, account identity, subscription tier, quota consumption percentage/reset timestamps, local paths, and exact OS version removed from the published evidence.

The isolated live turn completed in about nine seconds. It reported 13,684 input tokens and 51 output tokens for a deliberately tiny fixture. This is evidence of substantial agent-runtime request overhead; the event stream does not expose a byte-for-byte upstream request, so the harness does not attribute that overhead to one particular internal component.

Three `mcpServer/startupStatus/updated` notifications and one remote-control status notification still occurred in the isolated runtime, but no MCP or other tool item was called. The evidence records the event counts without retaining server names or payloads.

## OpenAI subscription matrix

| Control | Result | Evidence |
| --- | --- | --- |
| ChatGPT subscription OAuth | PASS | `account/read` returned account type `chatgpt`; identity and plan name were removed. |
| Requested model identity | PASS | `model/list` contained `gpt-5.6-sol`; `thread/start` resolved provider `openai` and the same model. |
| Native schema plus local validation | PASS | `turn/start.outputSchema` was used and the completed value passed the Kestrel subset validator. |
| No forbidden tool activity observed | PASS | Only user and agent message items completed; no command, file, MCP-tool, web, dynamic-tool, or multi-agent item completed. |
| Local thread persistence disabled | PASS | `thread/start.ephemeral=true`; this says nothing about upstream provider storage. |
| Upstream response ID observed | PASS, experimental | One `openai.response_id` arrived through `rawResponse/completed`. |
| Exact usage observed | PASS, experimental | One raw completion reported 13,684 input and 51 output tokens. |
| Stable supported ID/usage contract | FAIL | The generated protocol describes the required raw completion event as internal-only. |
| Tools absent at upstream request boundary | FAIL | App Server exposes no documented all-tools-disabled request control. No call observed is weaker evidence. |
| Every physical delivery bounded/debited | FAIL | Built-in OpenAI retry/reconnect behavior is not client-configurable or completely observable. |
| Provider application state disabled | FAIL | `ephemeral` controls local thread materialization, not an attested upstream `store=false`. |
| Per-call monetary reconciliation | FAIL | Subscription quota windows and token activity do not provide a monetary amount for this call. |
| Account data policy attested | FAIL | Auth/account RPCs do not expose training, retention, residency, or human-review settings. |
| Strict Review First V1 profile | **FAIL** | Every hard control must pass; successful generation alone is insufficient. |

The personal-versus-business distinction is material. OpenAI says individual ChatGPT and Codex content may be used for training unless the user opts out, with separate Codex controls for full environments; business offerings are not used for training by default. The RPC used here proves neither setting. Only synthetic data was sent.

## Direct OpenAI Platform leg

The same neutral fixture now maps to one non-streaming OpenAI Responses request using the exact current `gpt-5.6-luna` snapshot. The adapter uses `instructions` separately from user text, native strict `text.format` JSON Schema, `store=false`, `background=false`, `tools=[]`, `tool_choice=none`, and `truncation=disabled`. GPT-5.6 enables an implicit prompt-cache breakpoint by default, so the adapter additionally sends `prompt_cache_options.mode=explicit` and no breakpoint; the official contract says this disables cache reads, writes, and cache-write charges for the request.

The standard-library runner disables redirects and ambient proxies, accepts no caller-defined URL or model, performs one physical POST with no SDK retry layer, bounds the response body, captures both response and request IDs, rejects resolved-model/service-tier drift, and reprices provider-reported usage against a dated price snapshot. A transport failure after delivery becomes `outcome_unknown` and is never replayed.

No Platform call was sent. This machine has no `OPENAI_API_KEY`, project identifier, service-account attestation, account-policy evidence digest, or explicit probe cost cap. The missing ChatGPT OAuth session is intentionally not reused: it authenticates the unlike Codex agent-runtime surface, not this Platform API profile.

## Two-surface conformance matrix

Both columns below use the identical `kestrel.model-inference/v1` request digest. “STATIC PASS” proves adapter and preflight behavior only; it is not presented as live provider evidence.

| Control | OpenAI Platform Responses | Amazon Bedrock Converse |
| --- | --- | --- |
| Privileged instruction separate from task text | STATIC PASS — `instructions` | STATIC PASS — `system` |
| Native `kestrel.review-json-schema/1` plus local validation | STATIC PASS — strict `text.format` | STATIC PASS — `outputConfig.textFormat` |
| Tools/retrieval absent at request boundary | STATIC PASS — empty tools plus `tool_choice=none` | STATIC PASS — no `toolConfig` |
| Provider application state/cache disabled | STATIC PASS — `store=false`, explicit cache mode with no breakpoints | STATIC PASS — Converse request has no state or cache points |
| Exact egress and route | STATIC PASS — fixed origin/path, no redirects/proxies | STATIC PASS — fixed control/runtime origins; live route-set check required |
| One physical model delivery | STATIC PASS — standard-library POST, no retry layer | STATIC PASS — Botocore `total_max_attempts=1` |
| Typed refusal/filter/truncation/malformed/rate/transport/missing-usage outcomes | TEST PASS | TEST PASS |
| Preflight hard cost gate | PASS — `$0.00057220` reserved under `$0.10` | PASS — `$0.00742800` reserved under `$0.10` |
| Live success, correlation ID, usage, and post-call cost | MISSING | MISSING |
| Project/role and account data-policy evidence | MISSING | MISSING |
| Strict Review First V1 profile | **BLOCKED** | **BLOCKED** |

The machine-readable matrix is `evidence/two-surface-matrix-2026-08-16.json`. A live runner emits a stricter per-capture matrix whose `overall.pass` becomes true only when the same capture has a successful validated result, one physical delivery, native IDs and usage, post-call cost accounting, exact target/route, and a bound data-policy attestation digest.

## Bedrock managed-cloud leg

The neutral fixture maps to Amazon Bedrock Runtime Converse without a caller-supplied provider, model, URL, tool, header, or retry field. The adapter requests `outputConfig.textFormat.type=json_schema`, supplies the schema as a JSON string, omits tools and cache points, validates locally, preserves Bedrock stop reasons, request ID, cache/token dimensions, and reads `ResponseMetadata.RetryAttempts`. It also fails closed if tool content appears despite an `end_turn` stop reason.

The evidence profile uses the dated EU geographic inference ID `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` from `eu-west-1`. AWS documents native structured output on Converse and the exact JSON Schema subset includes all of Kestrel's current schema features. Before inference, the runner uses read-only control-plane calls to require an `ACTIVE` system inference profile, compare every returned model ARN and EU destination Region with the approved set, and prove that model-invocation logging is disabled. Runtime and control-plane endpoint overrides and ambient proxies are ignored; the Boto client is fixed to one total physical attempt.

No Bedrock call was sent because this machine currently has no AWS CLI, Boto3/Botocore, shared AWS directory, or recognized AWS credential/profile environment variable. The live leg requires a disposable assumed role with `bedrock:InvokeModel` on the exact inference profile and read access to `bedrock:GetInferenceProfile` and `bedrock:GetModelInvocationLoggingConfiguration`; `sts:GetCallerIdentity` binds the capture to the expected account and role. No dependency was installed and no credential was requested or invented.

## GitHub substitution check

GitHub can supply subscription-backed AI access, but it cannot replace the managed-cloud leg of this exact Review First experiment.

GitHub Models would previously have been structurally suitable: its inference API accepted GitHub credentials and exposed native JSON Schema output. It is no longer an available surface. GitHub retired the playground, model catalog, inference API, and BYOK endpoints for every customer on 2026-07-30. A direct catalog preflight on 2026-08-13 returned HTTP `410` with error code `github_models_retirement_brownout`; no model call was attempted.

GitHub Copilot SDK remains a supported subscription route. GitHub documents OAuth user tokens, per-user Copilot subscription billing, an `empty` mode with explicitly bounded tools, and token/cost usage events. It is nevertheless an agent runtime in public preview: the SDK delegates an agent loop to Copilot CLI and exposes no native response-schema field in its documented session contract or current public SDK source. Prompting for JSON plus local validation would not satisfy `structured_output.native`, and a second agent runtime would not prove the issue's required direct-versus-managed-cloud portability boundary.

The result is therefore a bounded negative preflight, not a credential blocker and not a reason to consume the Operator's Copilot quota. GitHub Copilot remains relevant to a future Agent Run Model Provider Profile, where tools and state are expected and independently governed. No AWS credential is needed to establish this GitHub conclusion; a conforming managed-cloud surface is still needed only if issue #21 is to meet its current acceptance criteria.

## Reproduce

Deterministic tests, which send no network request:

```bash
python3 -m unittest discover -s experiments/model-provider-conformance -p 'test_*.py'
```

One live OpenAI subscription call, using the currently logged-in Codex account:

```bash
python3 experiments/model-provider-conformance/live_codex_probe.py
```

The live runner prints sanitized evidence to standard output. It intentionally has no API-key argument and never prints or persists OAuth tokens.

The two strict runners are inert unless `--execute` is present. Configure their named environment variables through an external secret mechanism; do not put values in arguments or the repository.

```bash
# Requires OPENAI_API_KEY, OPENAI_PROJECT_ID,
# KESTREL_OPENAI_CREDENTIAL_ATTESTATION=project_service_account,
# KESTREL_OPENAI_DATA_POLICY_ATTESTATION_SHA256, and KESTREL_PROBE_COST_CAP_USD.
python3 experiments/model-provider-conformance/live_openai_probe.py --execute

# Requires Boto3/Botocore in an isolated environment, an AWS assumed role,
# expected account/role names, a data-policy evidence digest, and the same cost cap.
python3 experiments/model-provider-conformance/live_bedrock_probe.py --execute
```

Each command prints only sanitized JSON. Capture review and publication remain explicit; the runner does not write an evidence file by itself.

## Artifacts

- `harness.py`: neutral validation, shared result primitives, Codex/Bedrock mappings, typed outcomes, and retry evidence.
- `openai_responses_adapter.py`: isolated direct OpenAI request mapping and normalization.
- `probe_support.py`: shared attestation-expiry, hard-cost, post-call accounting, and strict-matrix logic.
- `live_codex_probe.py`: bounded JSON-line App Server transport and isolated OAuth probe.
- `live_openai_probe.py`: one-shot, redirect-free OpenAI Platform Responses transport.
- `live_bedrock_probe.py`: one-shot Bedrock transport with role, route, endpoint, logging, and retry preflight.
- `fixtures/review_request.json`: provider-neutral synthetic request and schema.
- `fixtures/profiles/openai_codex_subscription.json`: distinct subscription/App Server profile.
- `fixtures/profiles/openai_platform_responses.json`: strict direct-API evidence profile.
- `fixtures/profiles/bedrock_runtime_converse.json`: managed-cloud Converse profile.
- `evidence/openai-codex-subscription-2026-08-13.json`: sanitized live evidence.
- `evidence/*-preflight-2026-08-16.json`: current static, cost, capability, and credential-availability evidence.
- `evidence/two-surface-matrix-2026-08-16.json`: explicit static-pass/live-missing comparison.

## Source-to-decision log

| Decision | Primary source | Confidence |
| --- | --- | --- |
| ChatGPT sign-in is a supported Codex subscription path and differs from API-key billing/policy. | [OpenAI Codex authentication](https://developers.openai.com/codex/auth) | High |
| App Server is the supported programmable runtime and exposes ChatGPT login, schema-constrained turns, account/quota RPCs, and ephemeral threads. | [OpenAI Codex App Server](https://developers.openai.com/codex/app-server) and locally generated `0.146.0` protocol schemas | High |
| The plugin OAuth page governs OpenAI-host access to an MCP resource server, not Kestrel's model access. | [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth) | High |
| External tools use the subscription route in practice while separating it from direct API access. | [OpenClaw OpenAI provider](https://github.com/openclaw/openclaw/blob/main/docs/providers/openai.md), [OpenClaw Codex runtime](https://github.com/openclaw/openclaw/blob/main/docs/plugins/codex-harness-runtime.md), [Hermes providers](https://github.com/hermes-agent-org/hermes/blob/main/website/docs/integrations/providers.md) | High for those projects' behavior |
| Built-in OpenAI retry behavior cannot currently satisfy Kestrel-owned delivery accounting. | [OpenAI Codex provider source](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs), [closed retry report](https://github.com/openai/codex/issues/3026), [current retry request](https://github.com/openai/codex/issues/34053) | Medium; source and observed API lack agree, but this is not a stable product guarantee |
| Personal subscription data policy cannot be inferred from authentication alone. | [OpenAI data-use policy](https://help.openai.com/en/articles/5722486-how-your-data-is-used-), [consumer data FAQ](https://help.openai.com/en/articles/7039943-chatgpt-data-usage-faq), [business data commitments](https://openai.com/business-data/) | High |
| `gpt-5.6-luna` is the current exact snapshot, supports Responses and structured output, has a 1,050,000-token context window, and applies long-context price multipliers above 272K input tokens. | [OpenAI GPT-5.6 Luna model card](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [OpenAI pricing](https://developers.openai.com/api/docs/pricing) | High, time-sensitive |
| GPT-5.6 implicit prompt caching is disabled by explicit mode with no breakpoints. | [OpenAI Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create) | High, time-sensitive |
| GitHub Models cannot serve as the second surface because all inference and catalog endpoints were retired on 2026-07-30. | [GitHub Models retirement](https://github.blog/changelog/2026-07-01-github-models-is-being-fully-retired-on-july-30-2026/) | High |
| GitHub Copilot SDK can use a user's GitHub OAuth token and Copilot subscription without exposing model API keys. | [GitHub OAuth setup](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth) | High |
| Copilot SDK is an agent-runtime surface, currently in public preview, and its public session contract does not offer native response-schema enforcement. | [Copilot agent loop](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/agent-loop), [SDK compatibility](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility), [public SDK source](https://github.com/github/copilot-sdk) | High for the current surface; time-sensitive |
| Bedrock Converse provides native JSON Schema output and rejects unsupported schemas. | [AWS structured outputs](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html) | High |
| The chosen dated model supports Converse and an EU geographic inference route. | [AWS Claude Sonnet 4.5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-5.html) | High, time-sensitive |
| `GetInferenceProfile` exposes status and routed model ARNs so the fixed EU destination set can be checked before inference. | [AWS GetInferenceProfile](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetInferenceProfile.html), [AWS inference-profile support](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html) | High |
| Bedrock invocation logging can retain full request/response data, is disabled by default, and is inspectable before inference. | [AWS model invocation logging](https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html), [AWS GetModelInvocationLoggingConfiguration](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetModelInvocationLoggingConfiguration.html) | High |

## Remaining human inputs

The architecture decision is now explicit: **do not weaken Review First** to admit an agent runtime. Retain the ChatGPT subscription profile as a first-class Codex/Agent Run access path and prove strict Review First through separately conforming inference profiles.

The [Prove the Review First Model Provider boundary across unlike live surfaces](https://github.com/Ic3b3rg/kestrel/issues/21) ticket must remain open until an Operator supplies both disposable scopes, reviews and hashes the two account data-policy attestations, authorizes the `$0.10` per-probe caps, and the two sanitized live outputs pass their complete matrices. Credentials themselves must never be posted to GitHub or committed.
