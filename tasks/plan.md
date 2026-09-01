# Kestrel 0.1 — Usable Review First delivery plan

Status: approved delivery rebaseline, 2026-09-01  
Tracker: [0.1 — Usable Review First](https://github.com/Ic3b3rg/kestrel/milestone/1)  
Product contract:
[Review First V1 local-first specification](https://github.com/Ic3b3rg/kestrel/issues/33)

## Outcome

The first useful Kestrel checkpoint is a local Mac application in which one authenticated Operator
can:

1. authorize a local Git repository without exposing an arbitrary filesystem browser;
2. see the existing host `gh` account and the relevant pull requests for a Project;
3. see and select a model from the existing Codex subscription;
4. retain the exact base/head revision and confirm Change Intent;
5. explicitly start one durable Review Workflow; and
6. understand the result through the accepted narrative, focused Graph, Evidence, Findings, and
   Coverage surface.

The exact cold-start path is:

```text
start Kestrel
  -> authorize a Local Repository Source
  -> open/select a Project
  -> observe its pull requests through host gh
  -> select and retain an exact revision
  -> confirm Change Intent
  -> confirm Codex subscription + model
  -> start Review
  -> follow honest durable progress
  -> read narrative + Graph + Evidence + Findings + Coverage
  -> restart and recover the same result
```

## Non-goals

- AFK coding, automations, development sandboxes, speculative fixes, or source mutation.
- A GitHub App, Kestrel-owned OAuth, token import, webhook synchronization, or provider writes.
- Remote/VPS operation, teams, multi-Operator collaboration, or mobile availability while the Mac is
  offline.
- Whole-repository Graph construction, a persistent Project Graph, Review Threads, or provider
  review submission.
- Completing every full-V1 containment, verification, recovery, deletion, and release ticket before
  proving the useful Review First path.

## Integration decisions

### Host GitHub

Kestrel uses the Operator's already authenticated host `gh` session. GitHub remains optional,
manually refreshed Provider Observation. Kestrel stores no GitHub token and never treats provider
metadata as source.

### Codex subscription

The 0.1 Codex integration uses the official
[Codex App Server](https://developers.openai.com/codex/app-server) behind a Kestrel-owned Agent
Runtime port. The supported protocol exposes account state, available models, usage limits, threads,
approvals, and streamed events. The current host `codex` executable exposes `app-server` but no
native ACP server. [ADR 0003](../docs/adr/0003-use-codex-app-server-for-the-subscription-route.md)
records why this corrects the earlier transport assumption without changing the Review First product
contract.

Codex therefore owns ChatGPT login, token persistence, refresh, and provider communication. Kestrel
does not read or store those credentials and does not implement an OAuth ceremony. The generic ACP
adapter and full route-parity/containment contract remain later V1 scope under #59; 0.1 does not put
an artificial ACP bridge in front of the official Codex protocol.

### Process boundary

PostgreSQL and one-shot database preparation remain Kestrel-owned containers. Web, worker, and PWA
processes run under the current macOS Operator so the existing `git`, `gh`, and `codex` sessions
remain in their native custody. No application container receives the home directory, Keychain, SSH
agent, provider configuration, Codex home, or Docker socket.

## Delivery contract

- One issue produces one focused pull request and is merged before the next issue is claimed.
- Each issue targets 60–180 minutes, three acceptance criteria, and about five primary files. If the
  implementation forecast exceeds that envelope, split the issue before writing code.
- Start every behavior change with the smallest failing regression test.
- Run focused checks while iterating, then the relevant full suite once after the behavior works.
- Exercise the exact local command, API route, and browser path changed by the issue.
- Perform one review pass against the issue and repository standards, then one repair pass for
  concrete findings.
- A local commit is not completion: the pull request must be pushed, merged into `master`, and the
  issue closed before the next frontier advances.

## Ordered issue index

GitHub's native `blocked_by` edges form one strict chain. Only the first open issue without an open
blocker is claimable.

| Order | Issue                                                 | Size | Outcome                                                                         | Likely primary files/surfaces                                                                   | Verification                                                                                |
| ----: | ----------------------------------------------------- | :--: | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
|    01 | [#102](https://github.com/Ic3b3rg/kestrel/issues/102) |  M   | Run web, worker, and PWA on the host while retaining containerized PostgreSQL.  | `package.json`, `compose.yaml`, `scripts/local-development.mjs`, launcher test, `README.md`     | Cold start, bootstrap, readiness, restart, stop, and executable smoke probes.               |
|    02 | [#103](https://github.com/Ic3b3rg/kestrel/issues/103) |  S   | Authorize repository roots explicitly and explain empty local-repository state. | local configuration script/test, `package.json`, `OpenLocalRepositoryForm.tsx` and test         | Configure a fixture root and select its opaque repository/ref values in-browser.            |
|    03 | [#104](https://github.com/Ic3b3rg/kestrel/issues/104) |  M   | Make Projects and the scope rail the signed-in workspace.                       | `App.tsx`, new scope/workspace component, `ProjectInboxPanel.tsx` and test, `styles.css`        | Multi-Project routing, reload, keyboard, empty/error states, narrow viewport.               |
|    04 | [#105](https://github.com/Ic3b3rg/kestrel/issues/105) |  S   | Surface the selected Project's live host-`gh` inbox.                            | `HostGitHubProjectPanel.tsx` and test, `ProjectInboxPanel.tsx`, host-`gh` live test, PWA API    | Real account/status read, grouped PRs, manual refresh/select, zero writes.                  |
|    05 | [#106](https://github.com/Ic3b3rg/kestrel/issues/106) |  M   | Probe the existing Codex subscription through App Server.                       | Agent Runtime port, Codex adapter and test, package entry/config, generated dependency metadata | Fake protocol failures plus opt-in live `account/read` and `model/list`.                    |
|    06 | [#107](https://github.com/Ic3b3rg/kestrel/issues/107) |  M   | Show Codex readiness and choose a live available model.                         | public contract/OpenAPI, runtime-status route/test, PWA API, status/model component and test    | Connected/auth/usage/error/refresh states in a real browser; no stored token.               |
|    07 | [#108](https://github.com/Ic3b3rg/kestrel/issues/108) |  M   | Freeze a Codex Analysis Configuration when Review starts.                       | review contract/test, `review-workflows.ts` persistence/test, web route/test                    | Change the model/status across preparations and prove digest conflict/fail-closed behavior. |
|    08 | [#109](https://github.com/Ic3b3rg/kestrel/issues/109) |  M   | Generate a validated documentation-only review through Codex.                   | Codex review generator/test, prompt/schema fixture, exact-revision reader boundary              | Fake/adversarial streams and one live documentation-only capture with full cleanup.         |
|    09 | [#110](https://github.com/Ic3b3rg/kestrel/issues/110) |  M   | Execute and atomically publish the queued workflow.                             | review migration, database workflow module/test, worker processor/test                          | Interrupt/restart the real worker and prove one terminal workflow and publication.          |
|    10 | [#111](https://github.com/Ic3b3rg/kestrel/issues/111) |  M   | Expose authoritative workflow progress and current review.                      | public contract/OpenAPI, database read model, web route/test, SSE invalidation                  | Empty/running/finished/failed/stale reads across reload and restart.                        |
|    11 | [#112](https://github.com/Ic3b3rg/kestrel/issues/112) |  M   | Start and read the first review in the PWA.                                     | `ReviewPreparationPanel.tsx` and test, review result component, PWA API, `styles.css`           | Cold browser run, mid-run reload, final narrative/empty Graph, keyboard/responsive.         |
|    12 | [#113](https://github.com/Ic3b3rg/kestrel/issues/113) |  S   | Define compact Graph and Evidence artifacts.                                    | contract/test, OpenAPI generation, compact/adversarial fixtures                                 | Resolve every locator and reject dangling/cross-revision/unsupported structure.             |
|    13 | [#114](https://github.com/Ic3b3rg/kestrel/issues/114) |  M   | Generate a compact Graph with resolvable Evidence through Codex.                | review generator/test, compact prompt fixture, publication validator/test                       | One live compact change plus malformed-locator and Partial adversarial traces.              |
|    14 | [#115](https://github.com/Ic3b3rg/kestrel/issues/115) |  M   | Render the accepted variant-D Graph and inspector.                              | Graph component/test, review result component, inspector/source drill-down, `styles.css`        | Desktop/narrow browser comparison, keyboard/a11y, three-interaction Evidence path.          |
|    15 | [#116](https://github.com/Ic3b3rg/kestrel/issues/116) |  M   | Publish Findings and honest Coverage for the compact review.                    | claim/coverage contract/test, generator/test, publication validation/persistence                | Trace every claim and intent outcome; reject hidden gaps and false certainty.               |
|    16 | [#117](https://github.com/Ic3b3rg/kestrel/issues/117) |  M   | Render Findings, Coverage, and exact-revision source drill-down.                | review result/Graph inspector components and tests, PWA API, `styles.css`                       | Zero/multiple Finding and Partial states; source reached within three interactions.         |
|    17 | [#118](https://github.com/Ic3b3rg/kestrel/issues/118) |  M   | Certify and document the 0.1 cold-start journey.                                | browser/black-box tests, local runbook, release evidence, package verification command          | Empty-state reset, full happy path, forced restart, full relevant suite, human checkpoint.  |

## Dependency chain

```text
#102 -> #103 -> #104 -> #105
     host + repository + Project + GitHub checkpoint

-> #106 -> #107
   Codex subscription checkpoint

-> #108 -> #109 -> #110 -> #111 -> #112
   first durable documentation-only Review checkpoint

-> #113 -> #114 -> #115 -> #116 -> #117
   complete compact variant-D Review checkpoint

-> #118
   0.1 release checkpoint
```

## Checkpoints

### Checkpoint A — usable source and GitHub entry (#105)

The Operator starts the host-integrated Installation, authorizes a repository, selects its Project,
sees the real `gh` account and grouped pull requests, and selects one without creating another
source route.

### Checkpoint B — visible Codex connection (#107)

The same Project shows the existing Codex subscription state and live model catalog. Authentication
and usage failures have explicit remediation, and neither browser nor database contains a Codex
token.

### Checkpoint C — first real Review (#112)

A documentation-only exact revision runs through Codex, survives worker/browser restart, and
publishes a source-grounded narrative, evidenced empty Graph, and honest Coverage.

### Checkpoint D — product-shaped compact Review (#117)

One compact behavioral change is understandable through the accepted variant-D narrative, focused
Graph, node inspector, Evidence, Findings, Coverage, and exact-revision source drill-down.

### Checkpoint E — 0.1 release (#118)

The public runbook reproduces the complete path from empty Kestrel state on the supported Mac. A
human validates navigation and comprehension before the milestone closes.

## Definition of done for the milestone

- #102–#118 are closed in order, and their pull requests are merged to `master`.
- No open pull request or native blocker remains in milestone 0.1.
- The exact cold-start path passes after deletion of Kestrel-owned state and after one forced
  application restart.
- Host `gh` and Codex authentication remain externally owned; Kestrel stores no corresponding raw
  credential.
- The Operator can explain the representative compact change, principal risk or absence of risk,
  Evidence, and uncovered scope without starting from a raw diff.
- Existing full-V1 issues remain linked as umbrellas/backlog rather than masquerading as the current
  executable frontier.
