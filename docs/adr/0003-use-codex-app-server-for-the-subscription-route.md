# Use Codex App Server for the Codex subscription route

Status: Accepted — 2026-09-01.

Kestrel 0.1 integrates the Operator's existing Codex subscription through the official local
[Codex App Server](https://developers.openai.com/codex/app-server), behind a Kestrel-owned Agent
Runtime port. Codex owns ChatGPT authentication, credential persistence and refresh, its native
agent loop, and provider communication. Kestrel may read only validated public account, plan, model,
usage, lifecycle, approval, and streamed-result facts; it neither reads nor stores Codex tokens nor
implements a Codex OAuth ceremony.

This decision corrects the assumption in the earlier interoperability work that Codex itself would
be consumed as an ACP server. The supported host Codex CLI exposes `app-server`, while the official
embedding contract documents account, model, thread, turn, approval, and event methods and does not
expose a native ACP server. Calling App Server directly removes an unnecessary third-party protocol
bridge from the first useful Review First path without making vendor protocol types part of
Kestrel's durable domain.

The generic ACP adapter remains a possible later Agent Runtime adapter and the full route-parity and
containment work remains open under issue #59. It is not a prerequisite for proving the Codex
subscription route in 0.1. The optional Direct API route also remains separate and explicit; Kestrel
never falls back between App Server, ACP, and Direct API.

Using a third-party Codex-to-ACP shim was rejected for 0.1 because it would add another pre-release
compatibility and process boundary before any user can run a review. Using an API key or the
non-interactive CLI was rejected as the subscription path because the former changes the billing and
authentication route, while the latter omits the richer product-embedding lifecycle supplied by App
Server.
