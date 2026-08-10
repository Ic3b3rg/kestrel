# Review First trust and security model

**Status:** recommended V1 security contract

**Date:** 2026-08-10

**Scope:** self-hosted Kestrel, private and public Projects, GitHub first, selectable Model Providers

**Kestrel stage:** Review First only; Agent Run isolation is a downstream decision

## Research question

What trust boundaries and controls must Review First enforce for private source code, repository credentials, untrusted issue and pull-request content, prompt injection, data exfiltration, Model Provider access, auditability, and read-only analysis?

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` below are Kestrel decisions. Sections labelled **Source fact** report official guidance or first-party service behavior. The sources were checked on 2026-08-10. Provider terms and product controls are not timeless facts and must be re-attested in operation.

## Executive decision

Review First is a **non-agentic, static, read-only analysis pipeline**. Repository content is data, never authority. The pipeline may parse and summarize an exact base/head revision, but it has no capability to run repository code, install dependencies, invoke hooks, call arbitrary networks, mutate a Repository Provider, or start an Agent Run.

The model is an untrusted interpreter inside that pipeline, not a policy engine. Source, comments, documentation, branch names, retrieved text, and model output are all untrusted. Prompt delimiters, classifiers, and injection detectors may reduce risk or produce telemetry; none authorizes an action and none is a security boundary. The durable boundary is deterministic code plus least privilege:

```text
authenticated Operator action
  -> immutable Project + base/head identity
  -> credentialed acquisition broker (read only)
  -> content manifest and isolated static-analysis worker
  -> typed, Project-scoped context assembly
  -> approved Model Provider egress broker (no tools, no secrets)
  -> schema/evidence validation of untrusted model output
  -> safely rendered, immutable review-revision record
```

Review First therefore contains prompt injection rather than claiming to eliminate it. Even a fully compromised model response can at worst become rejected or safely rendered Project-local data; it cannot obtain a repository or provider credential, trigger an automatic network request, execute a command, write to GitHub, cross a Project namespace, or silently change the reviewed revision.

Private code may leave the Kestrel Installation only through a Model Provider path that the Operator has explicitly approved for that Project. The approval is bound to a provider, endpoint/capability set, processing and storage geography, retention/training posture, and effective policy version. A missing, changed, or incompatible attestation stops analysis. Kestrel never silently falls back to a different model, endpoint, region, stateful feature, or provider.

Two human decisions remain genuinely separate and must precede the locked Review First specification: how the first trusted Operator is bootstrapped/authenticated and recovered, and how Kestrel-held review data is retained/deleted. This note defines their security constraints but does not invent those product policies.

## Decision boundary

This ticket owns the non-negotiable security invariants for Review First. It does not own:

- Model Provider capability normalization, credential setup, model selection, accounting, detailed privacy UX, or fallback product behavior;
- the meaning of finding severity, evidence strength, or implementation coverage;
- the mechanism used to reacquire inaccessible GitHub commits;
- the implementation technology for workers, containers, virtual machines, or Agent Run Sandboxes;
- production incident-response procedures; or
- multi-Operator roles and collaboration.

Those subjects remain with their named downstream tickets. In particular, Review First worker isolation invariants apply regardless of what isolation technology is later selected for the more capable Agent Run Sandbox.

## Primary-source findings

### Prompt injection is a residual-risk problem

**Source fact.** OWASP distinguishes direct injection from indirect injection carried in external files or websites. It says retrieval and fine-tuning do not fully mitigate the vulnerability, recommends least privilege and deterministic output validation, and says foolproof prevention is unclear. ([OWASP LLM01:2025](https://genai.owasp.org/llmrisk/llm01-prompt-injection/))

The UK NCSC is more explicit: current LLMs do not enforce a boundary between data and instructions. It advises deterministic safeguards that constrain impact and warns that prompt injection remains residual risk rather than something a filter or appliance can completely stop. ([NCSC prompt-injection guidance](https://www.ncsc.gov.uk/blog-post/prompt-injection-is-not-sql-injection))

OWASP also treats model output as untrusted input. Unsafely forwarding it can cause XSS, SSRF, privilege escalation, or remote code execution; Markdown and external image links are specifically capable of leaking context when rendered. ([OWASP LLM05:2025](https://genai.owasp.org/llmrisk/llm052025-improper-output-handling/), [OWASP Secure Coding with AI](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html#section-12-markdown-link-and-unicode-injection))

**Kestrel decision.** Injection detection is advisory telemetry. Security tests must prove containment even when a malicious instruction succeeds in influencing the model's text. A test that merely expects the model to refuse the instruction is not a security acceptance test.

### Conventional zero-trust and workload controls still apply

**Source fact.** NIST SP 800-207 says trust is not granted from network location or ownership and calls for granular, per-request, least-privilege access to resources. ([NIST SP 800-207](https://doi.org/10.6028/NIST.SP.800-207)) NIST SP 800-190 recommends controlling workload egress, read-only root filesystems, separately defined writable locations, runtime monitoring, and sensitivity-based workload separation. It also records the limit: containers share a host kernel and provide less isolation than hypervisors. ([NIST SP 800-190](https://doi.org/10.6028/NIST.SP.800-190))

The joint NSA/CISA/FBI/partner AI data-security guidance recommends data classification, access control, encryption, revision integrity, provenance, and append-only records. It says AI output should inherit the sensitivity of its input. ([AI Data Security, May 2025](https://media.defense.gov/2025/May/22/2003720601/-1/-1/0/CSI_AI_DATA_SECURITY.PDF))

**Kestrel decision.** A worker boundary reduces blast radius but does not make the host trustworthy. Host root, the control plane, secret storage, isolation policy, and the audit integrity root remain in the trusted computing base.

### GitHub authenticates transport, not content

**Source fact.** GitHub warns that issue and pull-request bodies, titles, branch names, labels, and other context fields can be attacker-controlled and must not be allowed to become executable script. ([GitHub script-injection guidance](https://docs.github.com/en/actions/concepts/security/script-injections)) Git trees explicitly represent executable files, symlinks, and submodules; source archives may contain only Git LFS pointer files or may include LFS objects according to repository settings. ([Git trees](https://docs.github.com/en/rest/git/trees), [LFS in archives](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/managing-git-lfs-objects-in-archives-of-your-repository))

GitHub Apps begin without permissions and GitHub recommends granting only the minimum needed. Installation tokens expire after one hour, while an App private key does not expire until revoked and is described by GitHub as its most valuable secret. ([App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [installation tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app), [private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps))

**Kestrel decision.** A valid webhook signature proves which configured transport secret authenticated the bytes. It does not make the sender authorized, the repository uncompromised, or any body, ref, path, archive, file, or model-facing text safe. Repository credentials never enter the analysis worker.

### Model-provider assurances are capability-specific and mutable

**Source fact.** Current first-party documentation is not uniform:

| Provider surface | Current documented behavior relevant to Kestrel |
| --- | --- |
| OpenAI API | API data is not used for training unless the customer opts in. Default abuse-monitoring logs may retain prompts/responses for up to 30 days. Zero Data Retention and Modified Abuse Monitoring require approval, have endpoint/feature exceptions, and residency support distinguishes storage from processing. ([data controls](https://developers.openai.com/api/docs/guides/your-data#default-usage-policies-by-endpoint)) |
| Anthropic API | Standard API inputs/outputs are deleted within 30 days, with policy/law and feature exceptions; flagged inputs/outputs may be kept up to two years and safety scores up to seven years. Ad-hoc API deletion is unavailable. Approved ZDR is capability-scoped, and designated Covered Models require 30-day retention even for otherwise-ZDR organizations. Anthropic documents US storage even when traffic routing is selected elsewhere. ([retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [API deletion](https://privacy.claude.com/en/articles/7996875-can-you-delete-data-that-i-sent-via-api), [ZDR scope](https://privacy.claude.com/en/articles/8956058-i-have-a-zero-data-retention-agreement-with-anthropic-what-products-does-it-apply-to), [Covered Models](https://privacy.claude.com/en/articles/15425996-data-retention-practices-for-covered-models), [locations](https://privacy.claude.com/en/articles/7996890-where-are-your-servers-located-do-you-host-your-models-on-eu-servers)) |
| Google Cloud models | Google documents a training restriction without prior customer permission, but zero retention requires feature-specific configuration or exceptions. Grounding and stateful interactions can retain data, and a global endpoint does not provide regional processing isolation. ([zero-retention controls](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention), [data residency](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/data-residency)) |
| Microsoft Foundry models sold by Azure | Base inference is documented as stateless and not used to train base models, but optional stateful features store content. Geography depends on deployment type; Global and DataZone processing differ from regional processing. Abuse monitoring can include flagged human review unless a qualified customer receives modified monitoring. ([data, privacy, and security](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/data-privacy), [abuse monitoring](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/abuse-monitoring)) |

**Kestrel decision.** “Provider does not train” and “zero retention” are not Boolean properties of a provider name. Security policy is evaluated against the exact provider account, endpoint, feature, model class/version, region, retention control, and effective terms. Availability is never allowed to override that policy.

## Threat model

### Security objectives

Review First prioritizes four properties:

1. **Confidentiality:** Project content, derived review data, and credentials do not cross an unapproved Project, service, person, log, or external-provider boundary.
2. **Integrity:** the Operator can tell exactly which immutable inputs, analyzers, model configuration, and evidence produced a review; stale or mixed revisions cannot masquerade as the current review.
3. **Constrained authority:** no external content or model output can cause code execution, provider mutation, arbitrary network access, or an Agent Run.
4. **Availability and cost control:** hostile inputs cannot consume unbounded CPU, memory, disk, queue, tokens, provider spend, or browser resources.

### Assumptions and trusted computing base

- One Operator is trusted to authorize Project access and Model Provider egress. Mistakes, stolen sessions, and recovery abuse remain in scope; a deliberately malicious Operator with legitimate access is outside the V1 authorization model.
- The Kestrel host administrator/root, boot chain, control plane, database and object storage administration, secret store, backup operators, and isolation enforcement are trusted. Compromise here can defeat application-level controls.
- The Repository Provider and Model Provider may fail, change policy, return stale or malicious data, or be compromised. Their responses are never trusted merely because TLS or a valid credential was used.
- Kestrel-controlled analyzer binaries and their supply chain are trusted only to the measured version recorded for a job. Parser bugs remain an attack surface.
- Network transport uses authenticated encryption, clocks are sufficiently synchronized for correlation, and cryptographic primitives are correctly provided by the host. These assumptions must be made observable.
- Review First needs no repository code execution. Dynamic tests, builds, hooks, and runtime behavior are outside its evidence coverage and must be disclosed as absent.

### Threat actors and failure sources

- a malicious pull-request contributor controlling code, comments, commit messages, documentation, files, paths, refs, symlinks, submodules, LFS pointers, and archives;
- an unauthorized Repository Provider user or a replaying network client;
- an external attacker targeting the PWA, Operator session, control-plane API, queues, storage, parsers, renderer, or provider brokers;
- compromised or malicious Repository Provider and Model Provider services;
- malicious, hallucinated, policy-violating, or prompt-injected model output;
- a compromised static-analysis worker attempting lateral movement or persistence;
- cross-Project confusion through caches, indexes, embeddings, queues, object keys, authorization filters, observability, or reused scratch space;
- dependency and analyzer supply-chain compromise; and
- accidental configuration drift, stale revisions, operator error, resource exhaustion, audit failure, or incomplete cleanup.

### Asset and data classification

| Class | Assets | Required handling |
| --- | --- | --- |
| `K0 / credential` | GitHub App private key and webhook secret; installation tokens; Model Provider credentials; encryption/signing keys; Operator authenticators and session secrets | Broker/control-plane only; never source workspace, prompt, artifact, ordinary log, URL, process argument, or client storage; narrow use, rotation and revocation |
| `K1 / Project confidential` | private source, diffs, issue/PR content, commit messages, Change Intent, Review Threads, repository metadata | Project-scoped authorization, encryption in transit/at rest, minimized copies and explicit external egress |
| `K2 / derived confidential` | extracted symbols, indexes, embeddings, context packs, prompts, model inputs/outputs, Graph, Change Overview, Conceptual Review, findings and evidence | Inherit the highest input classification; same Project and revision namespace; category-specific retention |
| `K3 / security and operations` | manifests, hashes, policy snapshots, audit events, denial reasons, model request IDs, usage/cost, traces and alerts | Integrity and availability are critical; content-minimized; separate access and retention policy |
| `K4 / public display` | intentionally public repository metadata or explicitly exported review material | Still untrusted for parsing/rendering; public does not mean executable or authorized |

Classification is attached to the object, not inferred from which storage service or network contains it. Derived material never becomes less sensitive because a model summarized it. Embeddings are confidential data, not anonymous metadata.

### Trust boundaries and mandatory enforcement points

| Boundary | Untrusted or sensitive input | Enforcement point |
| --- | --- | --- |
| PWA -> control plane | session, CSRF/navigation context, review action, Project selector | authenticated current Operator session; Project authorization; replay-safe explicit action; secure session and origin controls |
| GitHub webhook -> ingress | signed raw bytes and attacker-controlled fields | size/content-type limits, signature and delivery dedupe, event allowlist, stable-ID authorization; no review/Run side effect from content alone |
| control plane -> credential broker | Project/provider identifiers and requested capability | typed capability allowlist; short-lived scoped token; credential handle rather than credential bytes; audit before use |
| Repository Provider -> acquisition broker | API/Git objects, redirects, errors and mutable PR state | exact captured commit IDs, TLS, response/size limits, no arbitrary URL following, immutable content manifest and hashes |
| acquisition -> source store/workspace | hostile paths, modes, symlinks, archives, submodules, LFS pointers and bytes | canonical path/object validation, quotas, Project/revision namespace, no implicit dereference or execution |
| scheduler/queue -> worker | job envelope and object references | authenticated typed job, schema/version validation, single Project/revision lease, idempotency and expiry |
| source workspace -> analyzer | malformed or adversarial source/configuration | isolated unprivileged worker, read-only revision, non-executable scratch, fixed Kestrel analyzers, resource/process/network limits |
| extraction/retrieval -> context assembler | poisoned text and potentially wrong-Project records | mandatory Project/revision filters, typed provenance on every block, deterministic budgets, no source-controlled prompt/template/config |
| context -> Model Provider broker | private selected context and request metadata | explicit approved egress policy, redaction/quarantine, endpoint allowlist, no tools/stateful features, credential injection only at broker |
| Model Provider -> validator | untrusted text/JSON, citations, links and usage metadata | byte/token limits, strict schema, known identifiers, evidence resolution, no commands/URLs/tool calls, safe failure |
| validator -> durable review | accepted claims and source references | immutable review-revision record, provenance/coverage/limits, transactional audit, no Repository Provider write |
| review -> PWA renderer | source, Markdown, model prose, links, Unicode and graphs | contextual encoding, sanitized Markdown, raw HTML/scripts/external images disabled, CSP, safe link navigation and source-code neutralization |
| all services -> logs/metrics | identifiers, errors and potentially sensitive payloads | structured allowlisted fields, redaction, injection-safe encoding, Project access control, tamper-evident protected audit stream |
| worker -> host/other Projects | processes, filesystem, IPC and network attempts | least privilege, namespace and resource isolation, deny-by-default egress, no host/control sockets, detection and teardown |

### STRIDE and abuse-case register

| Threat / STRIDE lens | Abuse case | Required outcome |
| --- | --- | --- |
| Spoofing | attacker replays a valid GitHub delivery or fabricates the Operator/provider identity | dedupe plus stable identity and current authorization; no review action from transport authenticity alone |
| Spoofing | stolen PWA session explicitly starts reviews or approves new egress | current session protection and auditable sensitive action; bootstrap/recovery policy resolved separately |
| Tampering | PR head moves after capture, a force push occurs, or base/head content is mixed | review remains bound to captured immutable IDs; a new head creates a new review revision, never silent replacement |
| Tampering | acquisition redirect, truncated tree, or mutable ref supplies different bytes | manifest verifies object identity/size/hash and records incompleteness; mismatch is a hard failure |
| Tampering / EoP | path traversal, absolute path, duplicate/case-colliding path, symlink or archive entry escapes workspace | entry rejected; no out-of-root read/write; entire affected input is quarantined or fails deterministically |
| EoP | submodule or LFS pointer causes fetch from attacker URL or an ungranted private repository | no implicit fetch; pointer is metadata and coverage is disclosed unless a separately authorized acquisition resolves it |
| EoP | repository config activates hooks, filters, language-server plugins, parser plugins, generators, package managers, build or test code | repository configuration cannot extend the tool set; no repository-supplied executable is invoked |
| EoP | malformed parser input exploits analyzer and reaches host/control plane | worker has no credentials, host sockets, writable revision or general network; violation terminates and quarantines result |
| Information disclosure | code/comment contains indirect instruction to reveal other files, prompts, secrets or Projects | model sees only preselected Project-local context; no retrieval or tool authority; output remains Project-local data |
| Information disclosure | credential accidentally enters workspace, environment, command line, prompt, artifact or log | automated canary test fails; job is blocked and credential is rotated if exposure occurred |
| Information disclosure / SSRF | source or output induces URL fetch, DNS rebinding, redirect, link preview, Markdown image or browser request | worker cannot egress; broker accepts only configured destinations and no unsafe redirects; renderer makes no automatic external request |
| Information disclosure | cache/vector/retrieval key omits Project or revision | authorization and namespace test fails closed; no shared plaintext result can be observed or returned |
| Tampering | model fabricates a file, line, Graph edge, analyzer result, check or evidence reference | schema accepts only identifiers present in the immutable input/evidence manifest; unresolved references are rejected or marked unsupported |
| Repudiation | Operator/provider/worker/model action cannot later be attributed | protected audit records who/what/when/where/result plus policy, revision and correlation identifiers |
| Repudiation / Tampering | compromised worker deletes or rewrites audit evidence | worker has append-only event submission, not audit-store mutation; unauthorized change is detected and alerted |
| Denial of service | archive bomb, huge file/tree, deeply nested syntax, parser crash loop or oversized graph | preflight and runtime quotas bound bytes, entries, depth, expansion, CPU, memory, processes, output and retries |
| Denial of wallet | hostile content expands context or repeatedly invokes expensive models | per-review/context/token/cost/concurrency budgets and idempotency stop further calls; cost denial is visible |
| Availability / policy | approved provider is unavailable | explicit `provider_unavailable`; never unapproved failover or silent regional/capability downgrade |
| Information disclosure / policy | provider changes retention, Covered Model status, training use, endpoint or residency | policy attestation becomes stale/incompatible and egress stops pending Operator reapproval |
| Tampering / XSS | source or model output embeds script, raw HTML, `javascript:` URL, bidi controls, homoglyphs or hidden text | encoded/sanitized rendering, restrictive CSP, disabled external images, flagged invisible/bidi characters |
| Tampering | malicious content alters prompt template, analyzer config, evidence policy or Project selector | control material is Kestrel-versioned and stored outside source; source is typed only as data |
| Information disclosure | logs capture raw source, prompts, tokens, headers, signed URLs or provider errors | structured field allowlist and redaction; sensitive payloads use separately governed artifact storage if retained |

## Review First security contract

### RF-SEC-01 — Explicit authenticated authority

Every Review First start or reanalysis requires an explicit action in a currently authenticated Operator session and names one Project plus one captured base/head pair. A Repository Provider event, comment, synchronization, model response, retry, or queue message cannot supply that authority. Provider identity does not substitute for local Operator authentication.

The authentication, first-Operator bootstrap, remote-access, authenticator recovery, session lifetime, and step-up policy are intentionally delegated to a new human decision ticket. NIST SP 800-63B-4 is the current primary reference for authenticator and recovery assurance, including phishing-resistant authenticators. ([NIST SP 800-63B-4](https://doi.org/10.6028/NIST.SP.800-63B-4))

### RF-SEC-02 — Read-only provider capability

The effective GitHub capability is the intersection of the configured Review First stage, enabled Project connection, selected repository, current App grant, and API operation. It is limited to Metadata, Issues, Pull requests, and Contents read. Kestrel has no Review First code path or credential capable of comments, reviews, checks, labels, refs, contents, merges, or other provider writes.

A deliberately attempted provider mutation must fail at both the Kestrel capability gate and provider permission. Every future write is a separate explicit Operator action outside this contract.

### RF-SEC-03 — Exact revision and provenance

Acquisition accepts immutable base and head commit identities captured when the Operator starts the review. The manifest records Project/provider IDs, commit IDs, tree/object identities, byte hashes, modes, sizes, acquisition time, missing objects, and acquisition method/version. Branch names and PR numbers are display metadata.

The UI always shows the exact analyzed revision. A newer PR head creates a separate review revision and marks the earlier one superseded or historical; it never rewrites the old review. Failure to acquire or verify either required revision is a hard gate, subject to the explicit partial-coverage rules documented by the review.

The exact GitHub acquisition order and inaccessible-revision behavior remain with “Prove immutable GitHub pull-request revision acquisition.”

### RF-SEC-04 — Hostile repository-object handling

Repository bytes and metadata are handled as an adversarial object graph before they become filesystem entries. Acquisition and materialization MUST:

- reject absolute, parent-traversing, NUL-containing, reserved, malformed, duplicate, and normalization/case-colliding paths;
- never follow a symlink outside the immutable revision root and never use a repository path to address host storage;
- treat executable modes as metadata, not permission to execute;
- cap file count, per-file size, total bytes, nesting, archive expansion ratio, archive depth, and processing time before and during extraction;
- reject device/special entries and unsafe links from any archive representation;
- treat submodules and LFS objects as unresolved external dependencies by default, never as authority to follow a repository-controlled URL; and
- hash and account for every accepted, skipped, truncated, or rejected object in coverage metadata.

Malformed input may yield a scoped skipped-file result only when the integrity of the remaining manifest is established. Boundary escape, revision mismatch, manifest ambiguity, or quota abuse is a hard failure.

### RF-SEC-05 — Static-only analysis

Review First MUST NOT run repository code, builds, tests, package managers, installers, generators, migrations, hooks, Git filters, LFS clients, submodule commands, language-server extensions, editor plugins, repository-provided analyzers, shell fragments, or executable configuration.

Only versioned Kestrel analyzer binaries and fixed parser grammars may process source. Repository configuration may be parsed as data but cannot load a plugin or alter a command line. No model output is ever a command, path, query, template, policy, or tool invocation.

This deliberately limits Review First evidence. A Conceptual Review must say that build, test, and runtime behavior were not observed; it must not imply a complete quality assessment or merge approval.

### RF-SEC-06 — Least-privilege disposable workers

Each analysis lease is bound to one Installation, Project, review operation and revision manifest. Its worker has:

- an unprivileged identity with no privilege escalation;
- a read-only exact-revision view and a separate bounded writable scratch area;
- no repository, Model Provider, database, object-store, session, encryption, or audit credentials;
- no host runtime/orchestrator socket and no access to another job's filesystem, process, IPC, cache, queue or network identity;
- deny-by-default ingress and egress, with model calls possible only through a typed internal broker protocol;
- fixed CPU, memory, disk, process, descriptor, output, wall-time and retry limits; and
- teardown and scratch sanitization on success, failure, timeout or cancellation.

The boundary must detect unexpected processes, system calls, listeners, writes and network destinations. This contract does not select containers, microVMs, VMs or another implementation. A container alone is not accepted as proof of the invariant.

### RF-SEC-07 — Credential confinement

Long-lived GitHub App private keys, webhook secrets, Model Provider credentials, Operator secrets and storage keys remain in control-plane secret handling. Short-lived Repository Provider tokens are minted and used only by the acquisition broker. Model credentials are injected only by the egress broker after policy approval.

Workers receive opaque job/object handles. Credentials MUST NOT appear in workspace files, environment variables visible to analyzers, process arguments, source/context packs, prompts, model output, PWA payloads, ordinary logs, traces, error messages, crash dumps, or retained scratch.

Repository-originated credential candidates are different from Kestrel credentials. High-confidence candidates are quarantined from model context by default and the redaction is disclosed. Any future override requires a separate explicit Operator action warning that external transmission is irreversible. Secret detection remains best effort and never supports a “no secrets present” claim.

### RF-SEC-08 — Typed data/control separation

Prompt templates, system instructions, schemas, tool policy, analyzer configuration, Project authorization and retrieval filters are Kestrel-owned, versioned control objects. Repository content, issue/PR text, Change Intent sources, tool output and prior model output enter only typed data fields carrying Project, revision, origin, object hash, location and trust classification.

Context assembly uses deterministic selection and budgets before the model call. Every included block is traceable to the manifest; every exclusion or truncation is counted. Source-delimiting markup may help the model but is not relied on for authorization, confidentiality, or integrity.

The model has no tools in Review First: no web search, URL fetch, code interpreter, remote MCP, provider-hosted file search, stateful conversation, arbitrary retrieval, or callback. Adding one is a new capability and needs a separate threat decision.

### RF-SEC-09 — Project and revision isolation

Authorization and namespace keys include Installation, Project and review operation or exact revision wherever data can be stored or recovered: database rows, object paths, queues, leases, scratch, caches, search indexes, vector stores, embeddings, prompt state, artifacts, logs and metrics access.

No plaintext extraction, embedding, context, model response, or cache hit may be shared across Projects. Shared physical infrastructure is permitted only when logical access controls and encryption boundaries preserve the same invariant. Blob hashes alone are not authorization keys.

Single-Operator V1 does not weaken this requirement. It prevents accidental context mixing, compromised-worker lateral movement, future multi-Operator migration bugs, and prompt-injection exfiltration paths.

### RF-SEC-10 — Approved, minimal Model Provider egress

Before the first private-data transmission for a Project, the Operator approves an egress policy. Each call re-evaluates an effective policy containing at least:

- provider account and credential handle;
- exact endpoint and allowed host/network destination;
- model/model-class and API capability set;
- storage geography and inference-processing geography;
- training/default-secondary-use terms;
- abuse-monitoring, application-state and deletion/retention behavior;
- ZDR or equivalent entitlement and its feature/model exceptions;
- data classes allowed, maximum request bytes/tokens, cost budget and expiry; and
- the provider-document/contract version and Kestrel attestation timestamp.

Only the minimum manifest-selected source needed for the requested analysis leaves the Installation. Kestrel identifiers are pseudonymous where provider functionality does not need them. Repository credentials, unrelated files, other Projects, full logs, audit secrets and hidden platform configuration never leave.

The broker uses HTTPS, an application and network destination allowlist, refuses unsafe redirects and access to loopback/link-local/private metadata services, and records destination and byte/token counts. OWASP recommends application plus network controls and disabling redirect following where destinations are allowlisted. ([OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html))

No call occurs when the policy is missing, expired, contradicted by current provider documentation/configuration, or incompatible with the selected feature/model. No fallback is fail-open. The Model Provider portability ticket owns the normalized capability model and approval experience that satisfy this gate.

### RF-SEC-11 — Untrusted model-output validation

The broker caps response bytes/tokens and returns model output as untrusted data. Kestrel parses it into a versioned, closed schema. Validation permits only known enumerations, bounded text, safe identifiers, and evidence references resolvable in the same Project/revision manifest.

The validator does not accept model-proposed commands, SQL, paths, URLs, HTML, scripts, tools, retrieval queries, provider calls, authorization decisions, severity policy, or state transitions. A Graph node or review claim without resolvable provenance is rejected or explicitly marked model inference with missing evidence; it can never be silently promoted to fact.

Schema validity proves shape, not truth. “Define risk, evidence, and implementation-coverage claims” owns the semantics for evidence and confidence.

### RF-SEC-12 — Secure presentation

The PWA treats repository and model text identically as hostile. It uses contextual encoding and an allowlist sanitizer for any supported Markdown subset. Raw HTML, scripts, event attributes, active content, data URLs, `javascript:` URLs, automatic link previews and external images are disabled. External navigation is an explicit user action and prevents opener/referrer leakage; a restrictive Content Security Policy supplies defense in depth.

Source and diffs visibly flag or neutralize bidi controls, zero-width characters and ambiguous Unicode without changing the immutable evidence bytes. Downloads use safe content disposition and type handling. No generated link is fetched by the server or browser merely by viewing a review.

### RF-SEC-13 — Encryption and data minimization

`K1` through `K3` data is encrypted in transit and at rest, including backups and temporary durable queues. Access is service- and Project-scoped. Scratch exists only for the lease and is sanitized at teardown; credentials use a distinct protection and rotation boundary.

Raw webhook bodies, source snapshots, prompts, responses, indexes, embeddings, artifacts, error samples and audit events are separate retention categories. Ordinary application logs contain identifiers, hashes, sizes and decisions rather than raw content. OWASP says source, session identifiers, tokens, keys and commercially sensitive data should normally be removed, masked, hashed or encrypted instead of logged directly. ([OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude))

Kestrel needs finite, category-specific deletion rules, Project deletion semantics, cache/index/embedding cleanup, backup aging, legal-hold behavior, and a statement of what remains reproducible after deletion. The exact policy is a new human decision, not a safe default this research can choose on the Operator's behalf.

### RF-SEC-14 — Protected audit and provenance

Security-significant transitions are recorded by the control plane or broker, not trusted to worker self-report alone. Audit storage provides append-only, tamper-evident semantics and denies workers modification or deletion. Unauthorized access/change attempts alert the Operator. NIST control AU-9 requires protecting audit information and tooling from unauthorized access, modification and deletion. ([NIST SP 800-53 Rev. 5, AU-9](https://doi.org/10.6028/NIST.SP.800-53r5))

No acquisition, external egress, review publication, cancellation or deletion reaches its effect unless the mandatory audit intent is durably accepted. Audit failure yields an explicit safe failure. Raw prompts are not required in the security log; if retained for reproducibility they live as separately encrypted, access-controlled artifacts under the data-retention policy.

Reviews record provenance and limitations, not reproducibility theatre. Exact source, context, prompt-template, analyzer, model/configuration and output hashes allow inspection, but an external stochastic model may not reproduce the same output later.

### RF-SEC-15 — Bounded consumption and cancellation

Input size, tree/archive expansion, parser resources, retrieval volume, context tokens, output tokens, request count, retries, queue depth, concurrency, per-review cost and Installation spend are hard limits checked before and during work. Duplicate starts reuse the same idempotent review operation rather than spend again.

An Operator cancellation revokes the lease and prevents new egress/publication; in-flight external processing may not be recallable and is reported honestly. OWASP identifies uncontrolled inference as a denial-of-service and denial-of-wallet risk and recommends quotas, rate limits, timeouts and monitoring. ([OWASP LLM10:2025](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/))

### RF-SEC-16 — Deterministic failure and degraded states

Security gates fail closed with stable machine-readable states and Operator-readable reasons. At minimum:

| State | Meaning |
| --- | --- |
| `authorization_required` | local Operator authentication/authorization is absent or stale |
| `revision_unavailable` | a captured commit cannot currently be acquired under the read-only grant |
| `revision_mismatch` | acquired bytes/object identity do not match the immutable manifest |
| `source_rejected` | unsafe path/object/archive/submodule/LFS condition prevents safe materialization |
| `analysis_limit_exceeded` | a deterministic file/tree/parser/resource budget was reached |
| `egress_unapproved` | Project data has no matching current external-provider approval |
| `provider_policy_changed` | provider/model/feature/region retention or processing posture no longer matches approval |
| `provider_unavailable` | approved provider failed and no approved equivalent path was selected |
| `model_output_invalid` | response exceeded limits, failed schema, or asserted invalid evidence identifiers |
| `audit_unavailable` | mandatory protected audit acceptance failed |
| `completed_partial` | only explicitly listed, non-boundary analysis gaps remain and coverage is disclosed |
| `cancelled` | work stopped; any already-sent external request and retention implication is disclosed |

`completed_partial` is forbidden for authentication, revision identity, Project isolation, credential confinement, egress approval, or audit integrity failures. A generic retry must not turn a hard policy denial into another provider call.

## Security acceptance tests

These tests specify observable outcomes, not container/runtime/framework choices.

| ID | Test | Pass condition |
| --- | --- | --- |
| AT-01 | attempt every GitHub write class using Review First's effective credential | Kestrel denies before request and GitHub permission also rejects; no provider object changes |
| AT-02 | replay valid webhook, forge sender fields, and send non-Operator PR content | no duplicate effect and no Review First start/Agent Run without explicit authenticated Operator action |
| AT-03 | move/force-push/delete PR refs during acquisition and analysis | snapshot stays on captured commit IDs; mismatch/unavailability is explicit; no base/head mixing |
| AT-04 | feed absolute/traversal/NUL/case-collision paths, escaping symlinks, special files and malformed trees | no out-of-root access or ambiguous manifest; deterministic rejection and audit event |
| AT-05 | feed nested/archive bombs, huge/deep files, parser crash/fuzz corpus and repeated failures | all resource ceilings hold; worker/control plane remains available; retry budget is bounded |
| AT-06 | include executable bits, hooks, filters, build scripts, package-manager lifecycle scripts and repository parser plugins | none execute; only fixed Kestrel analyzers/processes appear in telemetry |
| AT-07 | include external/private submodules and Git LFS URLs/pointers | no implicit network fetch; unresolved coverage is recorded; no credential crosses Project/provider scope |
| AT-08 | make a worker read the revision as writable, reach host sockets, another job, control plane storage or metadata service | all attempts fail, alert and terminate without data disclosure |
| AT-09 | plant canary credentials in broker stores and inspection points | no canary occurs in workspace/env/argv/prompt/output/log/trace/artifact; any occurrence blocks release |
| AT-10 | place direct/indirect injection in code, comments, docs, filenames and retrieved text, including an instruction the model follows | model has no tool/credential/network/action path; response is only rejected or safely handled local data |
| AT-11 | prompt model to invent files, lines, checks, Graph nodes and evidence IDs | unknown/cross-revision IDs fail validation; accepted items retain same-snapshot provenance |
| AT-12 | request review for Project B after warming caches/vector/search with unique Project A canaries | no A identifier, content, derived result, cache hit or artifact is returned or made queryable to B; no lookup key omits Project scope |
| AT-13 | induce model output/source containing script, raw HTML, Markdown images, redirects, `javascript:` links, bidi and zero-width text | no script or automatic external request; unsafe constructs are removed/flagged; CSP records no bypass |
| AT-14 | try SSRF via source URL, model URL, redirects, DNS rebinding, loopback, link-local, private and cloud-metadata targets | worker has no path; broker/network enforcement reaches only approved provider destination |
| AT-15 | exhaust input/context/output/cost/concurrency budgets and replay review start | one idempotent operation; hard caps hold; reason and partial coverage/cost are visible |
| AT-16 | remove approved model, change endpoint/region/retention/ZDR/Covered-Model status or make provider fail | call stops with policy/unavailability state; no silent feature, region, model or provider fallback |
| AT-17 | return oversized, malformed, extra-field and adversarial model responses | bounded read; strict schema rejection; no downstream interpreter, query, path or state-transition use |
| AT-18 | tamper with/delete audit events from worker/service identities and fail the audit sink | mutation denied/detected; sensitive effect fails closed; Operator receives a content-safe alert |
| AT-19 | inspect logs, traces, metrics, crash dumps and errors after private review and failures | allowlisted metadata only; no raw source, prompt, token, signed URL, session or secret |
| AT-20 | expire/cancel/delete review while work and provider request are in flight | leases stop, scratch is sanitized, publication is prevented, durable/provider residuals follow and disclose policy |
| AT-21 | restart services mid-stage and redeliver queue messages | idempotent resume or stable failure; no duplicated egress/cost/artifact and audit order remains attributable |
| AT-22 | compromise one worker in a mixed-sensitivity host simulation | no lateral access; alerts identify boundary; test also documents which host/root compromise cannot be contained |

Prompt-injection tests use multiple models and adversarial variants, but their pass condition is deterministic containment. Secret scanners, injection classifiers, and model refusals may be measured separately and must not be promoted to guarantees.

## Required audit and observability fields

Every review operation needs a correlation chain with content-minimized fields:

- `event_id`, event type/schema version, control-plane receive time, asserted source time and clock-confidence/offset where relevant;
- Installation, Project, Work Item, review operation and immutable analyzed-revision IDs;
- actor type/stable ID, authenticated session reference, requested action, authorization-policy version, result and denial reason;
- Repository Provider connection/installation/repository IDs, delivery/request IDs, captured base/head commit IDs and acquisition method/version;
- source-manifest hash, object/file/byte counts, accepted/skipped/rejected/truncated counts, unsafe-object reasons and revision-verification result;
- worker lease/instance identity, measured worker/analyzer/parser versions, isolation policy version, start/end/heartbeat, termination reason and resource maxima;
- unexpected process, syscall, filesystem, IPC, listener, network and namespace-access attempts, without copying private payloads;
- retrieval/context policy version, Project/revision filter, included object/location references, context-manifest hash, byte/token totals, redaction/quarantine counts and prompt-template hash;
- Model Provider/account policy-attestation ID, endpoint/region, model identity and version/snapshot where exposed, feature flags, retention/ZDR class and expiry;
- provider request ID, destination, request/response byte and token counts, latency, retries, rate-limit status, cost/estimate, response hash and cancellation state;
- output schema/version, validation result, unknown/evidence-reference counts, sanitizer decisions, artifact hash, coverage and provenance summary;
- audit append/checkpoint result, retention-class IDs, deletion request/tombstone and scheduled backup/provider residual expiry where known; and
- end-to-end trace/correlation IDs that do not themselves grant access.

Alerts are required for repeated authorization failures, manifest/revision mismatch, path/archive rejection bursts, parser crashes/timeouts, isolation violations, credential canary detection, unexpected egress, cross-Project access attempts, provider-policy drift, invalid-output spikes, budget exhaustion, audit tampering/failure, cleanup failure, and unusual cost/volume.

Raw source, comments, prompts and model responses are not observability fields. If the retention policy keeps them as evidence artifacts, access to them is separately authorized and audited. OWASP recommends recording when, where, who and what while also testing logs for injection, access control and resource-exhaustion failures. ([OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html))

## What Review First cannot guarantee

- It cannot eliminate, reliably detect, or prove the absence of prompt injection. It can only reduce likelihood and deterministically constrain impact.
- It cannot prove that a Model Provider actually deleted data, avoided training, or processed it only in a promised geography. Those are contractual/provider-control assurances corroborated by configuration and audit evidence, not local technical facts.
- It cannot recall content already transmitted to an external provider. Cancellation and Project deletion affect Kestrel-held data according to policy, not the past.
- It cannot protect data from a compromised trusted host/root, control plane, secret store, backup authority, isolation runtime, or audit integrity root.
- It cannot guarantee complete secret detection in arbitrary source, binaries, encodings, generated files, history, submodules or LFS objects.
- It cannot guarantee parser correctness or containment after a host-kernel/runtime escape; isolation and patching reduce, but do not remove, that risk.
- It cannot guarantee that static analysis observes dynamic dispatch, generated code, runtime configuration, build effects, tests or production behavior that it does not execute.
- It cannot guarantee model truth, completeness, stable repeatability, finding severity, or merge safety. Schema and evidence validation constrain claims; they do not make inference correct.
- It cannot preserve full reproducibility after the selected retention policy deletes prompts, provider responses, indexes or source copies. The UI must state what remains reconstructible from the exact repository revision and hashes.
- A single trusted Operator simplifies authorization roles but does not solve remote authentication, session theft, initial bootstrap, recovery, backup compromise, or accidental cross-Project selection.

## Downstream Wayfinder implications

### Existing tickets: exact ownership

| Named ticket | Implication from this contract |
| --- | --- |
| [Define Model Provider portability and control](https://github.com/Ic3b3rg/kestrel/issues/6) | Own the provider-neutral capability/policy-attestation model, credential boundary, Project selection/approval UX, usage accounting and explicit fallback options. It must implement RF-SEC-10, including per-model/feature/region retention drift; this ticket does not choose providers or duplicate that design. |
| [Prototype the conceptual change view](https://github.com/Ic3b3rg/kestrel/issues/7) | Render source/model text through RF-SEC-12 and make exact revision, provider egress, provenance, coverage, partial state and limits visible. It need not prototype authentication or retention settings. |
| [Define risk, evidence, and implementation-coverage claims](https://github.com/Ic3b3rg/kestrel/issues/8) | Define which deterministic/model claims RF-SEC-11 may present and how uncertainty and missing dynamic evidence are communicated. Security containment does not assign finding severity. |
| [Validate conceptual change extraction on real pull requests](https://github.com/Ic3b3rg/kestrel/issues/9) | Measure useful extraction and declared coverage on real PRs, while adversarial security fixtures remain acceptance tests rather than evidence that prompt injection is solved. |
| [Lock the Review First product and technical specification](https://github.com/Ic3b3rg/kestrel/issues/10) | Incorporate every RF-SEC invariant, denial state, audit field and acceptance test; select the worker/control-plane mechanisms only after the two new human policies below are resolved. |
| [Choose the disposable Sandbox isolation and repository execution model](https://github.com/Ic3b3rg/kestrel/issues/13) | Preserve credential, egress, host-root, namespace, cleanup and audit lessons for Agent Runs, but choose the much stronger executable Sandbox separately. Review First does not preselect that runtime. |
| [Set the always-on availability and resource envelope](https://github.com/Ic3b3rg/kestrel/issues/16) | Budget worker limits, queue/cost caps and storage growth after the local retention policy supplies durations; security limits are hard ceilings, not autoscaling hints. |
| [Prove immutable GitHub pull-request revision acquisition](https://github.com/Ic3b3rg/kestrel/issues/18) | Prove RF-SEC-03/04 under deleted refs, removed grants and forks; return a manifest or an explicit failure, never silently acquire a different revision or external dependency. |

No separate ticket is needed for prompt-injection detection, an audit schema, secure rendering, secret scanning, or Review First worker technology. The contract makes those implementation requirements for “Lock the Review First product and technical specification”; splitting them would duplicate rather than clear a decision.

### New sharp human-decision ticket: Operator trust establishment

**Proposed title:** `Define Operator bootstrap, authentication, remote access, and recovery`

**Type:** `wayfinder:grilling` (HITL)

**Question:** How does a new self-hosted Kestrel Installation establish its first and only trusted Operator, authenticate that Operator from responsive PWA devices, bind the Operator's Repository Provider identity, manage session lifetime and sensitive step-up actions, expose the control plane remotely, revoke lost devices/authenticators, and recover from credential loss without creating either an account-takeover path or an unrecoverable Installation?

This is not covered by future team identity in the map's fog. Review First already needs a trustworthy local actor before it can read private code or approve external egress. It is a product/security trade-off requiring the human; NIST authentication guidance supplies constraints but cannot choose Kestrel's bootstrap and recovery experience. It should block “Lock the Review First product and technical specification.”

### New sharp human-decision ticket: local review-data lifecycle

**Proposed title:** `Set Review First data retention, deletion, and recovery policy`

**Type:** `wayfinder:grilling` (HITL)

**Question:** For each Kestrel-held Review First data class—provider receipts, source snapshots, scratch, indexes/embeddings, context/prompt and model output, Graph and Conceptual Review, evidence, audit/security logs, caches and backups—what is retained by default and for how long; what may the Operator configure or export; what does review, Project, provider-connection or Installation deletion erase; how are backup aging, legal/incident holds, deletion evidence and recovery handled; and what loss of reproducibility or unavoidable Model Provider residuals must be disclosed?

This does not duplicate Model Provider privacy controls. “Define Model Provider portability and control” governs data after approved external egress; this new ticket governs Kestrel's own durable and temporary copies. It also differs from the resource envelope, which measures the cost of the chosen policy rather than choosing it. It should block both “Lock the Review First product and technical specification” and the retention-dependent portion of “Set the always-on availability and resource envelope.”

### Fog and scope result

No existing fog item graduates or changes. The two questions above are newly exposed, precise decisions on the visible Review First path, so they are tickets rather than “Not yet specified.” Team roles and governance remain in fog because V1 still has one Operator. Provider-specific expansion remains in fog; the current Model Provider ticket defines the portable first boundary.

No live ticket is ruled out of scope, and no new execution task is justified by this research. Implementation begins only after the Review First specification is locked.

## Compact hand-off

Review First is safe enough to specify when all of the following are true:

- one authenticated Operator explicitly selected one Project and immutable base/head;
- read-only acquisition produced a verified hostile-content manifest;
- a disposable static worker can read only that revision, write only bounded scratch, and cannot execute repository code, obtain credentials, or reach arbitrary networks;
- context is typed, provenance-bearing, Project/revision-scoped and minimized;
- the exact external provider/model/feature/region/retention policy is approved and current, with no silent fallback;
- model output is untrusted, schema/evidence validated and safely rendered;
- Project namespaces, budgets, cleanup, audit and denial states pass the acceptance tests above; and
- the Operator-authentication and local-data-lifecycle tickets have supplied the two missing human policies.

That contract makes a malicious pull request capable of confusing a review, causing a bounded denial, or exposing the limitations of static/model analysis—but not of turning Review First into a credentialed code-execution or data-exfiltration agent.
