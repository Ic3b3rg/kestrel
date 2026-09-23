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

The approval boundaries are:

| Phase                   | Frozen with                                     | Reused by                                              |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| Planning                | Accepted message or plan-generation request     | Retries of that request                                |
| Implementation & repair | Exact plan-version approval                     | Work Items and technical repair rounds                 |
| Conceptual Review       | Explicit review start and exact revision digest | Attempts of that review, including source-only reviews |
| Corrections             | Authorized instruction and selected findings    | Correction attempts and bounded repair rounds          |

Review settings are part of the immutable Analysis Configuration. Changing them between preview and
start invalidates the preview and requires a fresh review of the inputs. Corrections use their own
profile, not the implementation or review profile. Deterministic checks, publication, and merge do
not consume an agent profile. The interface retains requested profiles and runtime-reported controls
separately, including when a run fails. Missing legacy profiles block new model work before source
mutation; they are never silently filled from current settings.

Existing Installation model preferences seed the phase defaults without inventing effort or speed
preferences. Profiles do not change command authority, source containment, networking, verification,
or merge.
