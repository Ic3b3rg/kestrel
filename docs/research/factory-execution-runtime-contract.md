# Factory execution runtime contract

Verified against Codex CLI `0.153.4` on 2026-09-08. Product authority remains the
[approved Factory specification](../factory-v01/spec.md); this note records the implementation
boundary for [#214](https://github.com/Ic3b3rg/kestrel/issues/214).

## Host authentication, isolated writers

Codex App Server retains the Operator's existing ChatGPT authentication on the host. Filesystem
and process tools are routed to the official remote `exec-server` protocol, selected explicitly
for each thread and turn. The runtime verifies that the local environment is unavailable and
the selected remote environment points to the owned workspace. It does not fall back to host
execution. This split exists in the pinned version, including experimental environment
selection. [Codex App Server protocol](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/README.md),
[exec-server protocol](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec-server/README.md).

The remote executor runs in a disposable Linux container with an immutable image ID, no
network, a read-only root filesystem, dropped capabilities, no additional privileges, and
bounded processes, memory and CPU. Only the independently materialized Feature workspace is
writable; controller Git metadata is mounted read-only. Scratch directories are ephemeral.
The host HOME, authentication files and Docker socket are not mounted into the executor.
The model connection remains on the host. A loopback-only host bridge forwards bytes through
`docker exec` to the container's loopback exec-server, without publishing a container port.
[Docker's isolated network](https://docs.docker.com/engine/network/drivers/none/).

The turn declares `externalSandbox` with restricted networking because the container supplies
the actual boundary. Initial thread creation is read-only. Host `command/exec` is not used for
verification: it does not select a remote environment. Verification uses the controller's
fixed Docker invocation with the approved program, arguments, working directory and timeout.
Repository Markdown is reference material and cannot change this policy.

## Why process exit alone is insufficient

A real macOS probe showed that a detached child could keep writing after both its parent
command and App Server had exited. The equivalent container probe showed the child stopping
when the container stopped. Linux kills the remaining processes in a PID namespace when its
initial process terminates. [Linux PID namespaces](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html).

Each implementation invocation therefore ends its container before Git checkpointing. Each
verification command gets a fresh container, which is stopped before the controller compares
the resulting workspace with the exact checkpoint. A successful command that changes source
does not establish verification for the previous tree. Output is bounded and truncation is
explicit in the stored evidence.

Before creation, the controller persists the intended container name against the owned run;
it then records the actual container ID. Completion requires confirmed removal of every
reserved environment. Unknown Docker state retains the Project reservation. Job expiry,
heartbeat expiry, browser closure and a successful model message cannot release a writer.
Cancellation immediately withdraws new-work authority while allowing an already-started
command's final evidence to be retained.

## Setup and practical limits

`npm run factory:prepare` downloads the pinned official Linux Codex release, checks its
published SHA-256 digest, and builds `Dockerfile.execution`. It saves the resulting immutable
Docker image ID in the local Kestrel state directory. The host launcher passes that ID and
its resolved Docker executable to the background web service. The executor itself never
pulls an image or installs dependencies.

The default image contains Codex 0.153.4, Node 24, npm, Git, Bash and ripgrep. Project-specific
dependencies must be available in the execution environment; missing tools or dependencies
produce an inspectable blocker. The Operator's ignored `node_modules`, caches or local files
are never copied into a Feature checkout. An installation may configure another immutable
image ID with the required toolchain and the same compatible executor.

The initial real probe used a disposable source file, a real host-authenticated Codex turn,
and verification in a second container. It checked inside writes, outside and symlink writes,
Git metadata writes, external networking, and detached-child lifetime. The implementation's
process fixtures and public Factory tests separately exercise durable identity and evidence;
none of these probes modify Veduta or publish implementation issues to a live provider.

The opt-in server test also runs real authenticated HTTP commands, the durable PostgreSQL queue,
the host Codex runtime and the execution image together:

```sh
KESTREL_LIVE_FACTORY_EXECUTION=1 \
KESTREL_FACTORY_EXECUTION_IMAGE=sha256:<prepared-image-id> \
npm run test:black-box -- tests/black-box/factory-execution.live.test.ts
```

Run `npm run build` first. GitHub responses are controlled fixtures; the implementation and
verification processes are real. On 2026-09-08 both scenarios passed: two dependent Work Items
advanced on one cumulative branch while preserving dirty, staged, untracked and ignored Operator
files; and stopping the actual server during verification closed an active browser event stream,
confirmed container teardown, and retained the blocked attempt across restart. This opt-in test
uses the configured host model connection and can report authentication or usage limits.
