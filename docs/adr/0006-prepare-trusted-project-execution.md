# Prepare trusted Project execution without transferring controller authority

Status: implementation candidate — 2026-10-05.

The lightweight executor in ADR 0005 intentionally lacks dependency download, Docker and browser
provisioning. The documentation-capability task demonstrated that a valid implementation can fail
its retained verification commands because those prerequisites are absent or its resource envelope
is too small. Changing the acceptance commands or asking the Operator to approve an environment
repair would not establish a verification certificate.

Keep the existing controller and Sandbox as owners of authority and custody. Add an
installation-owned Project environment preparer. For an explicitly authorized trusted Node Project,
it prepares a content-derived immutable image with Docker and Chromium, admits one heavy execution
against the Docker VM capacity, and returns a resource lease to the Sandbox. Preparation runs locked
dependency installation and capability probes before the implementation turn, with source-build
warm-up. Every verification operation uses the same environment preparation and preserves its
original program, arguments and deadline.

Dependency preparation has a separate bounded budget. A controller-selected timeout wrapper starts
the approved verification deadline after preparation; an outer failsafe covers preparation, command
time and teardown grace. There is no aggregate implementation deadline.

`KESTREL_FACTORY_TRUSTED_DOCKER_PROJECTS` is an explicit comma-separated Project ID allowlist in the
host supervisor environment. Repository content and agent output cannot grant that capability. An
empty allowlist retains the existing unprivileged, read-only-root, network-isolated executor.

The prepared environment permits the package downloads and Docker image pulls needed by approved
Project commands. Its agent instructions and remote sandbox network declaration reflect that
installation authorization; the host session remains read-only. Its `/tmp` mount permits executable
test fixtures, while retaining `nosuid` and `nodev`. The default executor keeps its restricted
network and temporary mount policy.

The trusted environment uses a privileged outer container with a private cgroup namespace and a
private inner Docker daemon. Its daemon state uses an anonymous local Docker volume attached only to
that outer container; it mounts neither the host daemon socket nor host devices explicitly and
publishes no outer ports. The task runs as the configured unprivileged execution user. Privileged
Docker remains a substantially weaker isolation boundary than the default executor: this route is
for trusted code on a dedicated local Docker VM, not hostile or multi-tenant workloads. It is not a
promise that privileged code cannot escape its resource boundary. That limitation is part of its
installation authorization.

The private daemon uses classic `overlay2` on private native Docker storage. A real nested build
reproduced the default containerd snapshotter's overlay-on-overlay mount failure; a FUSE trial
failed to execute its binaries on this VM. VFS passed the small capability probe, but the
representative execution read approximately 25 GB and wrote 39 GB before multiple HTTP/browser
startup deadlines. Images reached Created state while complete filesystem copies accumulated. The
earlier VFS compatibility fallback therefore did not establish a usable Project environment.

The next cold-daemon check reached its test's 180-second setup limit during image preparation, while
the same check passed after its private cache was warm. Preparation therefore also builds the
declared root Dockerfile, when present, before the approved command clock starts. This uses the same
retained source and resource boundary; it neither replaces tests nor shares writable cache across
operations. Each fresh environment pays the cold build cost, within preparation's separate budget.
Other Docker contexts and toolchains are not certified by this first profile.

Source builds cannot be a mandatory admission gate: a broken build is precisely what an
implementation or repair turn may need to fix. Nonzero exits from the npm build and root Dockerfile
warm-ups are retained as warnings and execution proceeds. Spawn failures, signals, dependency
installation, browser installation and the independent Docker build/run probe remain preparation
failures. Environment readiness never substitutes for approved verification: each original check
still executes and retains its own exit status on the saved revision.

The preparer emits a final aggregate warning summary. For the prerequisite probe only, controller
capture keeps a bounded stderr head and tail (64 KiB total), and persisted activity prioritizes its
final diagnostics within the existing 8 KiB budget. Truncation remains explicit. Ordinary accepted
verification commands keep their existing output capture policy. This preserves preparation warnings
even after verbose builds without introducing an unbounded log buffer.

An anonymous `local` volume provides non-overlay backing storage without a shared daemon or cache.
Docker creates it as part of the already-reserved outer container, avoiding an independently delayed
volume-create request. The ledger records required storage before issuing container creation. A lost
create response with neither parent nor storage receipt retains the stop fence: an inert container
name barrier cannot prove anonymous storage absent. Before start, the controller inspects its exact
mount and records volume name, driver and creation time with the container identity. Teardown
removes the exact container with its anonymous volumes and confirms storage absence. Restart
recovery can finish an interrupted removal only with the retained storage receipt, unchanged daemon
identity and confirmed absent parent. Changed, busy or uncertain storage keeps the existing stop
fence. The volume is disposable per operation; there is no cross-run writable cache or separate
persistent daemon.

Preparation builds and runs an installation-owned scratch image using the installed static Docker
CLI, without network access, before implementation or verification. Daemon readiness alone is not a
usable-environment certificate. The temporary context and successful probe image are removed in
`finally`; remaining daemon cache is removed with the owned outer container and its private storage.

Sources: [Docker storage drivers](https://docs.docker.com/engine/storage/drivers/vfs-driver/),
[daemon feature configuration](https://docs.docker.com/reference/cli/dockerd/), and
[Dev Containers daemon-state storage](https://github.com/devcontainers/features/blob/main/src/docker-in-docker/NOTES.md),
and [Moby create-error cleanup](https://github.com/moby/moby/blob/master/daemon/create.go).

The existing durable outer container ledger owns creation, exact identity and stop witnesses.
Stopping and removing that outer container stops its private daemon and inner workloads together. No
persistent inner daemon or shared writable Docker volume is added. A prerequisite probe consumes one
extra owned container reservation, without granting a verification result or checkpoint.
Implementation and verification remain separate containers; only stopped implementation code may be
checkpointed, and all approved checks must pass on that exact checkpoint.

One heavy slot prevents this installation's Factory attempts from starting heavy phases
concurrently. A database claim and unique index retain that slot across host restart until the
existing execution reservation has stop/release proof. Bounded prerequisite output is explicitly
retained after completion; ordinary transient activity detail keeps its existing disposal policy.
The envelope uses at most 5.5 GiB, 512 processes and two effective CPUs, leaving at least 1.5 GiB of
Docker VM capacity unassigned. Actual running container memory is checked before admission; low
capacity waits visibly and cancellably. This is Docker VM admission, not a complete workstation
memory-pressure scheduler. Local inference, external Docker activity and applications outside the VM
still compete for physical memory. The first live measurement must report those limits honestly.

Routine technical interruptions have an execution status and a bounded repair or retry path. Only
`input_required` represents a product decision and exposes an answer form. Preserve earlier failures
and never promote an experimental runner result into the real application's completion state.

A workspace interruption keeps its source fence. Once its recorded revision has been restored, an
installation-owned inspection may confirm the exact saved workspace under the Feature lock. Gate
resolution records that source-bound revision receipt atomically, without accepting a proof field
from the client. Pending writers, stale approval, changed source identity and failed inspection
still block a retry. The Sandbox checks the same revision again before execution; the receipt does
not authorize new source or certify code. Uncheckpointed changes from the interrupted diagnostic
attempt were archived before restoring its two changed files to the existing checkpoint.

Alternatives rejected for this slice: host Docker socket access, project commands in the Operator
checkout, a universal environment/plugin framework, keeping one mutable implementation process alive
through controller verification, and deleting all resource limits. Flutter, Android emulation,
alternative package managers, cloud runners and complete host memory-pressure scheduling require
their own capability contracts and measurements.

See [the triage and acceptance contract](../factory-v01/prepared-execution.md) and the pinned
Sandcastle source references there.
