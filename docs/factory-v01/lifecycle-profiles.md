# Lifecycle phase profiles

Settings → Providers owns Installation defaults. Project Settings → Lifecycle profiles can inherit
or override each field: connected runtime, model, reasoning effort, speed, and installed Skills. The
Codex App Server supplies model IDs, wire names, effort choices, suggested defaults and tiers. An
unavailable explicit selection stays visible and blocks new work; it never falls back.

Runtime default and explicit Standard speed are different requests. At acceptance the current model
and supported defaults resolve into a retained profile. Standard uses
`serviceTierForTurn: "default"`; null would inherit a thread tier, so it is not a Standard override.
Older runtimes without tier capabilities cannot accept an explicit tier. See the
[App Server contract](https://learn.chatgpt.com/docs/app-server).

A Planning message freezes its concrete profile and exact Skill bundles in the same database
transaction as the message and queue job. Inline Skills augment the Feature selection; phase
defaults do not become permanent Feature selections. Retries reuse the original profile. The runtime
receives the frozen model, effort and tier, and the response retains runtime-reported values
separately. Changing Settings affects future accepted messages only. Historical messages without a
profile remain readable; new execution cannot invent a profile for an old message. Send a new
message to authorize work under the current profile.

Existing Installation model preferences seed Planning without inventing effort or speed preferences.
Profiles do not change command authority, source containment, networking, verification, or merge.
