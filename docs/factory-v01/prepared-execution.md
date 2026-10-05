# Prepare and recover execution behind the issue conversation

## Delivery card

Outcome: an authorized issue can prepare its development environment, implement and verify without
asking the Operator to resolve routine technical failures. Issue: conversation-authorized work; no
new tracker issue. The existing documentation-capability issue is the integrated acceptance case.
Branch: `fix/factory-prepared-execution` in the dedicated prepared-execution worktree. PR:
[#321](https://github.com/Ic3b3rg/kestrel/pull/321), draft pending integrated acceptance. Next gate:
the measured persisted task; HTTP and regression acceptance passed. Verification tier: contained
runtime, controller, board and one real persisted task. Runtime owner: the canonical Kestrel runtime
supervisor.

## Triage

Category: bug, with an environment-preparation enhancement. State: ready for implementation under
the explicit instruction in this conversation.

The latest retained documentation-capability execution is blocked with `verification_failed`. Its
nine checks include Docker-backed HTTP/browser tests. Five checks failed: missing Docker in the
Linux executor, a Node heap failure, Git/runtime failures and failed integrated checks. This is not
a product question. The board projects the technical gate as “Your decision is needed” and also
displays “Waiting for development”.

Redundancy check: the existing Sandbox already owns source retention, exclusive operations,
persisted container intent/identity/stop witnesses, checkpoints and exact-revision checks. The
processor already repairs failed checks, and transient provider failures already have automatic
backoff. Image preparation currently provides only Codex, Node and Git. There is no project
dependency/browser/Docker preparation. There is no `.out-of-scope` rejection record in this
repository.

## Contract

- Keep the existing durable controller, native agent loop and Sandbox custody. Separate environment
  preparation and technical recovery from product-question handling.
- Retain one issue conversation. Preparation, implementation, checks and recovery are inspectable
  activity, not additional Operator tabs or approval steps.
- Keep the lightweight contained runtime available. The first prepared environment supports a
  trusted Node project with npm lockfile, Docker-backed tests and Chromium. Do not claim Flutter,
  Android, Python or arbitrary toolchains are proven by this case.
- Additional execution privilege requires installation-owned authorization for the exact Project;
  committed project instructions cannot grant it. The current Kestrel Project is authorized by this
  conversation for the Docker experiment and its implementation. Never mount the host Docker socket,
  publish executor ports, or execute project commands in the Operator checkout.
- The prepared environment owns its inner Docker daemon inside the same outer execution resource
  boundary. Persist outer container custody before starting it; teardown confirms the entire outer
  boundary before checkpoint or release. Implementation and controller verification remain separate
  operations and separate containers.
- Preparation must install locked dependencies and required browser tools, preserve image
  environment variables, probe required capabilities and report real failures. It must not alter
  acceptance commands or mark skipped/failed checks successful.
- Admit heavy work against the local Docker VM capacity and serialize owned heavy phases. Record the
  chosen memory/PID/CPU envelope. Do not remove memory limits or silently overcommit a 16 GiB
  workstation. Waiting for resources is technical activity, not an Operator decision.
- Do not introduce an aggregate 30-minute implementation timeout. Individual checks retain their
  approved deadlines. Cancellation and uncertain teardown retain the existing fence.
- Classify product ambiguity separately from environment, resource, provider and code-check
  failures. Repair within approved scope; exhausted technical recovery remains visible as a
  technical interruption, without a product-answer form.
- Preserve all historical attempts and failed evidence. Prove success with a new persisted execution
  and exact-revision results, never a database status edit.
- A source interruption may retry after the server proves that the stopped workspace matches its
  retained checkpoint. A text answer cannot provide that proof. Preserve the exact inspection
  receipt with gate resolution; implementation and verification recheck the revision before
  proceeding.

## Acceptance

1. An authorized prepared Project reaches implementation only after its environment is usable. The
   default lightweight Project keeps its current isolation.
2. The same prepared environment is available to controller verification, including Docker
   CLI/daemon and browser prerequisites. All original verification commands run unchanged,
   sequentially.
3. Cancellation, preparation failure and interrupted execution stop owned resources or retain
   uncertainty; no success can bypass the stop witness.
4. A technical verification failure is represented as a technical interruption on the Project board
   and issue activity. Only an unresolved product decision asks for an answer.
5. Resource admission and selected limits are observable. One representative live task records
   timing and memory/PID evidence across preparation, implementation and verification.
6. The documentation-capability acceptance case has a new real application attempt with retained
   successful checks before it becomes eligible for review. Merge completion remains distinct from
   verification.

## Sandcastle evidence

Inspected upstream commit `62307ab65ad9f8414f7a4893d96328a0353b0c3f` on 2026-10-05. Its
[SandboxProvider interface](https://github.com/mattpocock/sandcastle/blob/62307ab65ad9f8414f7a4893d96328a0353b0c3f/src/SandboxProvider.ts)
separates command execution and environment teardown from the Agent provider. Its
[sequential reviewer template](https://github.com/mattpocock/sandcastle/blob/62307ab65ad9f8414f7a4893d96328a0353b0c3f/src/templates/sequential-reviewer/main.mts)
prepares dependencies with an `onSandboxReady` hook and runs phases sequentially. Its
[Docker provider](https://github.com/mattpocock/sandcastle/blob/62307ab65ad9f8414f7a4893d96328a0353b0c3f/src/sandboxes/docker.ts)
exposes explicit environment/network/device configuration; it does not remove physical resource
constraints.

Kestrel adopts preparation as a separate responsibility, not Sandcastle's whole lifecycle: Kestrel
must preserve its database custody, stopped-writer checkpoint ordering and fresh verification
evidence.
