# Review First control-plane stack

**Status:** historical stack research. [ADR 0002](../adr/0002-make-review-first-v1-local-first.md) supersedes the Ubuntu/VPS, Caddy, and always-on deployment recommendation for Review First V1; the language, persistence, job, artifact, and containment evidence remains prior art for the local implementation.

**Date:** 2026-08-20

**Scope:** Ubuntu Server 26.04 LTS reference host; 4 vCPU, 8 GB RAM, 75 GB storage; always-on responsive PWA; modular-monolith control plane; same-codebase separable workers; PostgreSQL system of record and job queue; content-addressed local artifact store; disposable isolated Review Environments; ACP v1 initial Agent Runtime adapter

## Research question

Which initial implementation stack best fits Kestrel Review First while minimizing idle overhead and operational machinery, preserving strong crash recovery, and avoiding an unnecessary custom ACP implementation?

Sources were checked on 2026-08-20. Runtime, framework, library, and protocol versions are mutable; implementation must pin exact versions and repeat the gates in this note before release.

## Executive recommendation

Start with a **strict TypeScript modular monolith on Node.js 24 LTS**, using:

- **Fastify** for the HTTP API and server-side module composition;
- **React + Vite** for a static responsive PWA shell;
- **HTTP Server-Sent Events (SSE)** backed by a durable PostgreSQL event sequence for live state, with ordinary HTTP commands for mutations;
- **PostgreSQL 18** through [`node-postgres`](https://node-postgres.com/) and explicit SQL migrations as the authoritative store;
- **pg-boss** for PostgreSQL-backed job claiming, retry, scheduling, and transactional enqueueing, while Kestrel domain tables—not pg-boss workflows—remain authoritative for Review Workflow state;
- the official **`@agentclientprotocol/sdk` stable ACP v1 entry point** behind a Kestrel-owned Agent Runtime Port;
- the supported **Docker Compose** control-plane stack, containing Caddy, `kestrel-web`, `kestrel-worker`, PostgreSQL, and a minimal `kestrel-envd` Review Environment supervisor; only Caddy publishes host ports;
- Docker restart policies for the application containers, with host systemd supervising Docker and containerd rather than separate Node application units;
- a capability-scoped Unix API from the worker to `kestrel-envd`; the supervisor is the only application component that receives the raw Docker socket and is therefore an explicit root-equivalent member of the trusted computing base, subject to the containment gate;
- a **SHA-256 content-addressed artifact directory** on the local durable volume, referenced from PostgreSQL only after the blob is durably installed.

This is an architectural inference, not a benchmark result. TypeScript/Node has the shortest verified path through Kestrel's unusually important integration seam: ACP's official project publishes TypeScript and Rust SDKs, but not Go or Elixir SDKs in its checked official-library list; the TypeScript SDK keeps ACP v1 stable while exposing v2 only through an experimental import. The same runtime also has a mature PostgreSQL-only job library and shares language, schemas, and tooling with the PWA. See the [official ACP organization](https://github.com/agentclientprotocol), [TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk), and [pg-boss](https://github.com/timgit/pg-boss).

The selection is **conditional**. Node's event loop and process model do not provide BEAM-style in-process supervision, and no primary source establishes that this exact application fits the reference host. The benchmark must prove fit. Crash recovery must come from PostgreSQL state, idempotent handlers, Docker restart policy plus host supervision, and disposable Review Environments—not from trusting an in-memory promise chain. The deployment reconciliation addendum below records why this replaces the earlier direct-systemd/rootless-Podman topology without changing the language recommendation.

## Evidence boundary

### Recorded Kestrel constraints

The repository's [`CONTEXT.md`](../../CONTEXT.md) makes Kestrel—not ACP, a job library, or an Agent Runtime—the authority for Review Workflow state, retained checkpoints, policy, and artifacts. Its Agent Runtime Profile and Review Environment boundaries also require effective authority to remain contained outside the runtime: capability claims and permission requests cannot expand that ceiling, and Kestrel state stays outside the runtime implementation.

These decisions rule out using an ACP session store, a queue library's workflow abstraction, or a container engine's metadata as Kestrel's system of record.

Three closed Wayfinder decisions also constrain deployment. [Issue #19](https://github.com/Ic3b3rg/kestrel/issues/19#issuecomment-5254430070) fixes one idempotent shell/Docker installation path, a Docker stack with Caddy as its only public reverse proxy, and transactional first-Operator bootstrap before the full environment starts. [Issue #16](https://github.com/Ic3b3rg/kestrel/issues/16#issuecomment-5278718836) fixes the one-command Ubuntu installation and same-host logical recovery contract while allowing Docker or another supervisor to remain an implementation detail. [Issue #20](https://github.com/Ic3b3rg/kestrel/issues/20#issuecomment-5256598204) fixes lifecycle-bound persistence and explicitly excludes a V1 backup or restore facility.

### Documented platform facts

- Ubuntu 26.04 is an LTS release supported until April 2031. Its server distribution advertises PostgreSQL 18 as a supported included component; the reference machine is materially above Ubuntu Server's minimum installation envelope. See the [Ubuntu 26.04 release notes](https://documentation.ubuntu.com/release-notes/26.04/) and [Ubuntu Server download page](https://ubuntu.com/download/server).
- As of the check date, Node 24 is LTS while Node 26 is Current. Node's own policy says production applications should use Active or Maintenance LTS releases. See the [Node release schedule](https://nodejs.org/en/about/previous-releases).
- PostgreSQL 18 documents `SKIP LOCKED` as unsuitable for a general-purpose consistent view but useful for multiple consumers of a queue-like table. `NOTIFY` is delivered only after commit and is a signal to inspect durable table data, not a replacement for that data. Synchronous commit waits for local WAL flush; disabling it can lose recently acknowledged transactions. See PostgreSQL's [`SELECT`](https://www.postgresql.org/docs/current/sql-select.html), [`NOTIFY`](https://www.postgresql.org/docs/current/sql-notify.html), [asynchronous commit](https://www.postgresql.org/docs/current/wal-async-commit.html), and [WAL settings](https://www.postgresql.org/docs/current/runtime-config-wal.html).
- The HTML standard defines browser reconnection for `EventSource` and the `Last-Event-ID` header. The Web App Manifest and Service Worker specifications supply the installable shell and controlled cache primitives. See [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html), [Web App Manifest](https://www.w3.org/TR/appmanifest/), and [Service Workers](https://www.w3.org/TR/service-workers/).
- Podman is daemonless and normally supports unprivileged operation. Its API service can be socket-activated and return to zero running API-service processes when idle. The same documentation warns that possession of its Unix socket grants full Podman authority and arbitrary code execution as the service user. See [`podman(1)`](https://docs.podman.io/en/latest/markdown/podman.1.html) and [`podman-system-service(1)`](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html).
- Docker officially supports Ubuntu 26.04 and distributes Docker Engine plus the Compose plugin through its `apt` repository. Its convenience install script is documented as a development/testing path, not a production installer. See [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
- Docker documents that control of the rootful daemon permits host-root-equivalent effects, including mounting the host root into a container. Its default daemon authorization is all-or-nothing; authorization plugins can mediate API requests but have documented exclusions and parsing requirements. See [Docker daemon attack surface](https://docs.docker.com/engine/security/#docker-daemon-attack-surface), [Linux post-installation warning](https://docs.docker.com/engine/install/linux-postinstall/#manage-docker-as-a-non-root-user), and [Docker authorization plugins](https://docs.docker.com/engine/extend/plugins_authorization/).
- Docker's supported rootless mode moves both daemon and containers into a non-root user's namespace, but requires subordinate UID/GID ranges and a user-systemd service with lingering for boot. Its CPU, memory, and PID controls work only with cgroup v2 plus systemd, and the required controllers may need explicit delegation; binding host ports 80/443 also needs an additional privileged-port configuration. See [Docker rootless mode](https://docs.docker.com/engine/security/rootless/) and [rootless operational constraints](https://docs.docker.com/engine/security/rootless/tips/).
- Compose supports health-gated startup, restart policies, explicit service networks, externally isolated networks, read-only filesystems, dropped capabilities, `no-new-privileges`, PID and memory limits, and a parent cgroup. `docker compose up` recreates changed containers while preserving mounted volumes and can wait for health. See [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/), [Compose services](https://docs.docker.com/reference/compose-file/services/), [Compose networks](https://docs.docker.com/reference/compose-file/networks/), and [`docker compose up`](https://docs.docker.com/reference/cli/docker/compose/up/).
- Caddy's automatic HTTPS manages certificates and HTTP-to-HTTPS redirects. Its data directory contains certificates and private keys and must be persistent; its reverse proxy flushes `text/event-stream` responses immediately. See [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy data-directory convention](https://caddyserver.com/docs/conventions#data-directory), and [Caddy `reverse_proxy`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming).
- Node's `subprocess.kill()` signals one child process. Its documentation explicitly warns that, on Linux, killing a parent does not terminate that process's children. A Node `ChildProcess` handle is therefore not a process-tree containment primitive. See [Node.js 24 child processes](https://nodejs.org/docs/latest-v24.x/api/child_process.html#subprocesskillsignal).
- systemd's `Restart=on-failure` is the upstream-recommended restart policy for long-running services and can combine restart limits, watchdogs, and cgroup resource controls. See [`systemd.service`](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) and [`systemd.resource-control`](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html).

No comparable first-party benchmark was found that measures these four stacks under Kestrel's workload and reference machine. Framework headline benchmarks are therefore not used as selection evidence.

## Documented candidate facts

The table below records capabilities exposed by the cited projects. Comparative judgments and the stack recommendation are intentionally deferred to the following section.

| Dimension | Elixir / Phoenix | Go | Rust | TypeScript / Node |
| --- | --- | --- | --- | --- |
| Concurrency and supervision | Elixir processes are isolated and linked into supervision trees that control restart; Phoenix Channels give each long-lived channel a lightweight process and support WebSocket or long-poll transports. [Elixir processes](https://hexdocs.pm/elixir/processes.html), [`Supervisor`](https://elixir.hexdocs.pm/Supervisor.html), [Phoenix Channels](https://phoenix.hexdocs.pm/channels.html) | Go documents goroutines multiplexed over OS threads and channels used for synchronization. [Effective Go](https://go.dev/doc/effective_go#concurrency) | Tokio provides lightweight asynchronous tasks, task handles, cancellation primitives, and explicit graceful-shutdown patterns. [Tokio spawning](https://tokio.rs/tokio/tutorial/spawning), [graceful shutdown](https://tokio.rs/tokio/topics/shutdown) | Node's built-in asynchronous I/O is suited to I/O-heavy work; worker threads are intended for CPU-heavy JavaScript and subprocess APIs can spawn separate OS processes. [Worker threads](https://nodejs.org/api/worker_threads.html), [child processes](https://nodejs.org/api/child_process.html) |
| PostgreSQL durable jobs | Oban 2.x persists jobs in SQL, supports enqueueing in an application transaction, isolated queues, retries, uniqueness, cancellation, and orphan rescue. [Oban](https://oban.hexdocs.pm/Oban.html), [orphan rescue](https://oban.hexdocs.pm/Oban.Plugins.Lifeline.html) | River supports PostgreSQL, transactional enqueue and completion, retries, queues, unique jobs, graceful stop, and stuck-job rescue; the checked release line is still `v0.x`. [River](https://github.com/riverqueue/river), [releases](https://github.com/riverqueue/river/releases) | Apalis advertises PostgreSQL storage, retry, idempotency, scheduling, and graceful shutdown, but the checked main documentation still installs a `1.0.0-rc` release. [Apalis](https://github.com/apalis-dev/apalis) | pg-boss 12.x uses PostgreSQL, supports enqueueing in an existing transaction, retries, scheduling, dead-letter handling, `LISTEN/NOTIFY` wakeups, and multi-worker claiming. Its checked requirements are Node 22.12+ and PostgreSQL 13+. [pg-boss](https://github.com/timgit/pg-boss) |
| Realtime PWA and API | Phoenix Channels give each connected client a lightweight process and support WebSocket and long-poll transports. [Phoenix Channels](https://phoenix.hexdocs.pm/channels.html) | Go's `net/http` package provides HTTP client and server implementations. [Go HTTP package](https://pkg.go.dev/net/http) | Axum exposes SSE and WebSocket responses over Tokio. [Axum SSE](https://docs.rs/axum/latest/axum/response/sse/), [Axum WebSocket](https://docs.rs/axum/latest/axum/extract/ws/) | Fastify supports module encapsulation and JSON-Schema validation; React and Vite document direct TypeScript support. [Fastify encapsulation](https://fastify.dev/docs/latest/Reference/Encapsulation/), [validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/), [React TypeScript](https://react.dev/learn/typescript), [Vite production builds](https://vite.dev/guide/build.html) |
| Container and process integration | Docker's official SDK list names Go and Python, not Elixir; it exposes a versioned HTTP API for direct integration. [Docker Engine SDKs](https://docs.docker.com/reference/api/engine/sdk/) | Docker publishes an official Go SDK. [Docker Engine SDKs](https://docs.docker.com/reference/api/engine/sdk/) | Bollard is a community asynchronous client for Docker and Podman over Tokio, with API-version negotiation. [Bollard](https://github.com/fussybeaver/bollard) | Docker exposes a versioned HTTP API to languages without a listed SDK; Node also exposes subprocess APIs. Podman's Docker-compatible and native APIs are available over a Unix socket. [Docker Engine SDKs](https://docs.docker.com/reference/api/engine/sdk/), [Node child processes](https://nodejs.org/api/child_process.html), [Podman API service](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html) |
| ACP client ecosystem | The checked ACP official-library list does not include Elixir. A production adapter would require a new client, generated protocol types, or another-runtime sidecar. [ACP official organization](https://github.com/agentclientprotocol) | The checked ACP official-library list does not include Go. A production adapter would require a new client, generated protocol types, or another-runtime sidecar. [ACP official organization](https://github.com/agentclientprotocol) | ACP publishes an official Rust SDK for clients, agents, proxies, and multiple transports. [ACP Rust SDK](https://github.com/agentclientprotocol/rust-sdk) | ACP publishes an official TypeScript SDK whose stable entry point is v1. `acpx/runtime` is TypeScript and close to Kestrel's orchestration seam, but its maintainers explicitly label it alpha and likely to change. [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk), [`acpx`](https://github.com/openclaw/acpx) |
| Deployable shape | A Mix release can package the BEAM application and runtime; exact idle RSS and startup cost are not measured here. [Mix releases](https://hexdocs.pm/mix/Mix.Tasks.Release.html) | `go build` compiles packages and dependencies; exact RSS, startup, and GC behavior are not measured here. [Go build](https://pkg.go.dev/cmd/go#hdr-Compile_packages_and_dependencies) | Cargo builds executable targets; exact build time, binary size, RSS, startup, and allocator behavior are not measured here. [Cargo build](https://doc.rust-lang.org/cargo/commands/cargo-build.html) | Node production use requires an LTS runtime; exact dependency footprint, idle RSS, startup, and event-loop delay are not measured here. [Node releases](https://nodejs.org/en/about/previous-releases) |

## Architectural inferences from those facts

### Elixir / Phoenix

**Inference:** Elixir is the strongest choice for intrinsic supervision, PostgreSQL-backed jobs, and realtime connections. It is the principal alternative to benchmark against the recommendation. It loses the initial selection because ACP is a central product seam, not an incidental integration: writing and maintaining a new ACP client and protocol-conformance layer, or deploying a Node sidecar solely for ACP, gives back much of the simplicity gained from BEAM supervision. A sidecar would also split failure, versioning, tracing, and backpressure behavior across runtimes.

**Reconsider when:** an official maintained Elixir ACP SDK appears, the direct ACP spike proves the client is genuinely small and stable, or the implementation team has materially greater Elixir expertise and the measured Node footprint fails the reference envelope.

### Go

**Inference:** Go is the strongest low-complexity systems alternative. River and Docker's official Go SDK fit PostgreSQL jobs and container lifecycle well, and a compiled service is operationally attractive. It loses initially because Kestrel would still need a custom ACP client or sidecar and a TypeScript browser application, while TypeScript already covers both boundaries. River's pre-1.0 line also requires strict pinning and migration testing.

**Reconsider when:** Node fails resource or event-loop gates, an official Go ACP SDK appears, or Review Environment orchestration becomes the dominant implementation burden.

### Rust

**Inference:** Rust has the best protocol-and-systems pairing: an official ACP SDK, Tokio, Axum, and a credible container API client. It is not the lowest-risk first product stack because the checked PostgreSQL job framework is still a release candidate and the product still needs a browser TypeScript toolchain. Kestrel would either adopt a less-settled job abstraction or implement the most failure-sensitive state machine itself. Rust's memory-safety and possible footprint benefit are valuable only after an identical workload proves they outweigh delivery and migration cost.

**Reconsider when:** a PostgreSQL job library reaches a stable supported contract and passes Kestrel's failure harness, or TypeScript cannot preserve adequate headroom for Review Environments.

### TypeScript / Node

**Inference:** TypeScript minimizes integration boundaries: the PWA, API schemas, ACP adapter, and worker code use one language; both ACP's official SDK and the optional `acpx/runtime` evaluation are native; pg-boss avoids Redis or a broker. That reduces the amount of novel protocol and queue code Kestrel must own in V1.

Its weakness is failure isolation. Kestrel must respond by using process and container boundaries rather than pretending Node has a supervisor tree:

1. web and worker are separate Compose services from the same image, and neither receives the raw container-engine socket;
2. CPU-heavy parsing/indexing never runs on the web event loop—it runs in bounded worker threads or, preferably for untrusted/repository work, inside the Review Environment;
3. every durable transition and work claim is in PostgreSQL;
4. every handler is idempotent and fenced against a stale attempt;
5. all live UI state is replayable from PostgreSQL after reconnect;
6. Docker restarts failed application containers, host systemd restores the engine after reboot, and PostgreSQL leases/retries recover unfinished work;
7. a separate minimal `kestrel-envd` is the only component with the raw engine socket and exposes only Kestrel-owned Review Environment operations to the worker.

**Inference:** Docker restart policy, host systemd, and PostgreSQL are parts of the production recovery contract, not incidental deployment choices. PostgreSQL supplies durable state, claims, fencing, and replay; systemd restores Docker/containerd; Docker restores stateless application containers; provider reconciliation restores agreement between PostgreSQL and disposable Review Environments.

## Concrete initial topology

```text
Internet / installed PWA
           │  only host ports 80/443
           ▼
        Caddy
 automatic HTTPS + reverse proxy
           │  private Compose edge network
           ▼
    kestrel-web container ─────────────┐
 Node 24 / Fastify + static PWA        │
 commands + replayable SSE             ▼
                              PostgreSQL 18
    kestrel-worker container ──────► domain + audit + jobs + events
 pg-boss + workflow + ACP adapter       │
           │                       durable references
           │                            ▼
           │                   local artifact volume
           │  narrow Kestrel Unix API only
           ▼
   kestrel-envd container (trusted supervisor)
 no public network, database, provider credential,
 retained-artifact mount, or arbitrary Docker API
           │  sole raw /var/run/docker.sock holder
           ▼
       Docker Engine
           │
 disposable constrained Review Environment
 owns the complete ACP runtime process tree
```

### Backend and module boundaries

Use one strict TypeScript workspace with separate `web`, `worker`, and `migrate` entry points for the main backend. Build `kestrel-envd` from a dedicated minimal entry point and container image containing only its validated Unix protocol and engine adapter; it must not import the web, workflow, ACP, or persistence adapters. Fastify plugins may compose the HTTP surface, but domain modules must not depend on Fastify, pg-boss, ACP, or container-engine types. The minimum ports are:

- `RepositoryProviderPort`
- `AgentRuntimePort`
- `ReviewEnvironmentPort`
- `ArtifactStorePort`
- `ModelInferencePort`
- `Clock` and stable ID generation

**Inference:** explicit ports are important here because every recommended infrastructure dependency is replaceable or pre-1.0 somewhere in the surrounding ecosystem. ACP types, pg-boss states, and container-engine IDs must stop at adapters.

### PostgreSQL and job semantics

Use PostgreSQL 18 with `fsync=on`, `full_page_writes=on`, and synchronous commit for authoritative state. `LISTEN/NOTIFY` is only a wake-up hint; consumers always query durable rows.

Use pg-boss for eligible-work claiming and retry, but keep each job small: a job identifies a Kestrel workflow/capability attempt and asks the domain module to advance it. It does not contain the authoritative workflow document or opaque resumable runtime state.

Treat business execution as **at least once** even though pg-boss describes exactly-once delivery of a claim. A worker can perform an external action and die before recording completion; recovery must be allowed to retry. Every handler therefore needs:

- an idempotency key derived deterministically from Project, workflow, Review Revision, capability, and effective configuration identity;
- a database uniqueness constraint for the intended transition;
- an attempt/fencing token checked on every terminal write;
- compare-and-set state transitions that reject late workers;
- explicit reconciliation for effects that cannot share the database transaction.

Configure job expiration plus heartbeat so a dead or partitioned worker's PostgreSQL-backed claim becomes eligible for recovery, while the fencing token prevents a stale attempt from committing. See pg-boss's [queue heartbeat and expiration contract](https://github.com/timgit/pg-boss/blob/55ee32f66f0bf683ff823c0ad8be2056dbc91ce4/docs/api/queues.md). Enqueue the next job in the same PostgreSQL transaction as the state transition that authorizes it. Never use asynchronous commit for Review Workflow, audit, queue, or artifact-reference transactions.

### Realtime PWA

Serve a versioned React/Vite shell with a Web App Manifest and a deliberately small service worker cache. Cache static shell assets only; never cache or replay consequential Operator mutations automatically.

Persist an ordered installation-event row with each committed domain transition. The SSE endpoint replays events after the browser's `Last-Event-ID`, then follows new commits. `NOTIFY` wakes the follower but is never the event log. This preserves mobile reconnect across a web-process restart without making a WebSocket connection authoritative.

Use WebSocket only if a later interaction proves bidirectional low-latency streaming is required. Review progress and Operator Attention are server-to-client state changes plus ordinary authenticated commands, so SSE is the smaller initial contract.

Do not add Next.js initially: Review First has no established server-side-rendering requirement, and Fastify can serve the Vite production assets. Reconsider SSR only from a concrete public-discovery or first-render requirement.

### Content-addressed local artifact store

Write each blob to a staging file on the artifact filesystem, hash while writing, flush the file, atomically install it under a SHA-256 path, flush the containing directory, and only then commit its PostgreSQL manifest/reference. A crash between file installation and database reference creates a reclaimable orphan; the reverse ordering could create a dangling authoritative reference and is forbidden.

Deletion is likewise two-phase: remove or tombstone references transactionally, record the deletion receipt in the Installation Audit, then unlink unreferenced blobs asynchronously. A periodic reconciliation job verifies referenced hashes, quarantines corruption, and reclaims aged unreferenced blobs and staging files. Reads fail closed when a referenced blob is absent or its hash does not match; they never silently regenerate AI-derived artifacts. V1 provides no backup or restore facility and makes no recovery claim for independently created host or volume copies; loss of the host or durable store is unrecoverable. Content addressing is deduplication and integrity naming, not a backup. See the [closed retention and recovery decision](https://github.com/Ic3b3rg/kestrel/issues/20#issuecomment-5256598204).

### Review Environment provider

Start with Docker Engine behind a minimal `kestrel-envd` service. `kestrel-envd` alone receives the raw Docker Unix socket; `kestrel-worker` receives only a private Unix socket exposing a small Kestrel protocol such as create-from-approved-profile, inspect/list-by-attempt-ID, stop, and delete. The protocol must not accept arbitrary images, commands, mounts, networks, capabilities, devices, engine paths, or Docker JSON. `kestrel-web`, PostgreSQL, Caddy, and every Review Environment receive neither socket. Run `kestrel-envd` with a read-only root filesystem, no public or data network, no PostgreSQL or provider credential, and no artifact or retained-snapshot mount.

The Review Environment provider, not a Node child-process handle, must own the complete ACP runtime process tree inside one container/cgroup boundary. Teardown kills that boundary and all descendants; startup reconciliation enumerates provider resources labeled with Kestrel attempt IDs and reaps or adopts them according to PostgreSQL state. The Compose control plane and aggregate workload pool use separate parent cgroups, and each attempt receives a child cgroup plus explicit memory, CPU, PID, writable-storage, and cleanup controls. Never infer successful teardown merely from the ACP parent process exiting.

The provider must set non-root identity, read-only retained snapshot mounts, a separate writable disposable work area, CPU/RAM/PID/disk limits, seccomp/capability restrictions, and deny-by-default tool egress. The ACP runtime supervisor and lower-authority Review Verification runner require distinct effective authority as already recorded in `CONTEXT.md`.

**Inference:** the outward `kestrel-envd` API is capability-scoped, but its raw Docker socket is not. Docker documents that the socket holder can obtain host-root-equivalent effects, so `kestrel-envd` is a deliberately small, high-authority trusted component rather than a least-privilege sandbox. If the negative containment suite finds any path from model-controlled input or a Review Environment to that service/socket, any accepted free-form Docker field, or any inability to preserve control-plane resources during teardown, reject this topology. The first fallback is a separate rootless-Podman workload authority under a dedicated Unix user; do not weaken the contract to preserve a one-engine stack.

## Deployment-decision reconciliation addendum

This addendum reconciles the initial direct-systemd/rootless-Podman draft with the closed Operator installation decision. It changes only the deployment and Review Environment provider recommendation; the TypeScript, Fastify, React/Vite, PostgreSQL, pg-boss, artifact, and ACP conclusions remain unchanged.

### Documented decision and platform facts

- The [Operator bootstrap resolution](https://github.com/Ic3b3rg/kestrel/issues/19#issuecomment-5254430070) requires a supported Docker stack in which Caddy is the only public reverse proxy, the durable store starts before transactional first-Operator creation, and rerunning the shell command reconciles rather than creates a second Installation.
- The later [Reference Installation resolution](https://github.com/Ic3b3rg/kestrel/issues/16#issuecomment-5278718836) preserves one idempotent `sh` command and permits the implementation to choose Docker or another supervisor. This makes a future replacement possible; it does not itself specify that the Docker/Caddy decision has been replaced.
- Docker supports the certified Ubuntu 26.04 host and Compose on a single production server. Compose can health-gate dependencies, restart services, recreate changed containers while preserving mounted volumes, and wait for health. [Docker Ubuntu installation](https://docs.docker.com/engine/install/ubuntu/), [Compose production](https://docs.docker.com/compose/how-tos/production/), [startup order](https://docs.docker.com/compose/how-tos/startup-order/), [`compose up`](https://docs.docker.com/reference/cli/docker/compose/up/).
- Neither Docker nor Podman exposes a naturally narrow raw socket. Docker's default authorization is all-or-nothing and a rootful daemon can mount the host root; Podman's API grants all Podman operations and arbitrary code execution as its service user. [Docker authorization](https://docs.docker.com/engine/extend/plugins_authorization/), [Docker daemon attack surface](https://docs.docker.com/engine/security/#docker-daemon-attack-surface), [Podman API security](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html#security).
- Rootless Podman narrows the ceiling to a dedicated Unix identity, is daemonless, and can leave no API process running while idle. It still requires subordinate UID/GID setup, user-systemd lingering for boot activation, a verified cgroup-v2 delegation for resource limits, and separate container/image storage. [Podman rootless mode](https://docs.podman.io/en/latest/markdown/podman.1.html#rootless-mode), [rootless setup](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md), [Podman socket activation](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html#run-the-command-in-a-systemd-service), [Podman resource options](https://docs.podman.io/en/latest/markdown/podman-run.1.html).
- Quadlet is an official Podman/systemd declarative mechanism for containers, networks, volumes, and images and supports rootless unit search paths, but rootless services require a real Unix user and cgroup v2. Rootless Podman also cannot bind ports below 1024 without a host sysctl change or a privileged redirect/proxy. [Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html), [rootless limitations](https://github.com/containers/podman/blob/main/rootless.md).
- Caddy must retain its writable data directory across recreation because it contains certificates and keys. Caddy automatically manages HTTPS and redirects, and its proxy recognizes SSE for immediate flushing. [Caddy data](https://caddyserver.com/docs/conventions#data-directory), [automatic HTTPS](https://caddyserver.com/docs/automatic-https), [streaming proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming).

### Comparative inference

| Topology | Authority boundary | Operations, idle cost, and persistence | Decision impact | Disposition |
| --- | --- | --- | --- | --- |
| **A. Docker/Compose control plane + capability-scoped Docker environment supervisor** | Only `kestrel-envd` holds the raw rootful Docker socket. Worker calls a fixed Kestrel Unix API. The supervisor remains root-equivalent and part of the TCB; the narrow API reduces reachability, not the supervisor's underlying authority. | One engine, one package family, one image store, Compose health/restart/update behavior, and the already-decided Caddy edge. Adds one small always-on supervisor process whose footprint must be measured. PostgreSQL, artifact, and Caddy data use explicit persistent volumes. | Preserves #19 and #16. | **Recommended, conditional on the supervisor gate.** |
| **B. Docker/Compose control plane + dedicated-user rootless Podman Review Environments** | The Podman socket still grants full Podman authority, but only as a Unix identity that owns no Kestrel durable data and cannot control the Docker control plane. A narrow broker can further keep the raw socket out of the worker. | Podman's API service can be idle at zero processes, but the host carries two engines, APIs, storage roots, image caches, version checks, and reconciliation paths. Linger, subordinate IDs, cgroup delegation, and cross-runtime socket permissions enter bootstrap and recovery. | Preserves #19. | **Containment fallback if A fails.** |
| **C. Host systemd Node services + rootless Podman** | Clean service-user separation and a dedicated Podman identity are possible. | Avoids containerizing web/worker/PostgreSQL, but replaces Compose packaging, health/update orchestration, volume conventions, and Caddy-container lifecycle with a bespoke host installer. Any idle saving is unmeasured. | Replaces the Docker stack fixed by #19. | **Reject initially; adopting it requires explicitly superseding #19.** |
| **D. Rootless Podman/Quadlet control plane and Review Environments** | One Podman user would let its socket control both control plane and workloads; meaningful separation therefore requires at least two Unix users and separate Podman storage/authority domains. | Quadlet is official and coherent with systemd, but rootless Caddy on 80/443 needs a host sysctl or privileged edge indirection, and boot needs linger plus verified cgroup delegation. It replaces the supported Docker update surface. | Replaces the Docker stack fixed by #19. | **Defer; adopting it requires explicitly superseding #19.** |

**Inference:** A is the smallest coherent topology because it honors the fixed installation and Caddy edge, adds no second engine, and keeps raw engine access out of the large web/worker surfaces. It is not intrinsically safer than B: its acceptance depends on treating `kestrel-envd` like a compact privileged monitor and proving that no model-influenced value can become a free-form Docker request. If that cannot be proven, choose B despite its operational cost. This recommendation does **not** require superseding issue #19. Choosing C or D does.

Use the standard rootful Docker Engine for A's first certified implementation, conditionally on that gate. Rootless Docker reduces the host-privilege ceiling, but a single rootless engine would still let `kestrel-envd` control Caddy, PostgreSQL, web, and worker, while adding user-service lingering, subordinate-ID, privileged-port, and cgroup-controller setup. It therefore does not remove A's control-plane-integrity risk or simplify the supported bootstrap. Keep it as a benchmarkable hardening variant rather than silently changing the baseline.

### Bootstrap, update, persistence, and recovery contract

The supported command is Kestrel's versioned installer, not Docker's general-purpose convenience script, which Docker documents as unsuitable for production. It should use Docker's signed `apt` repository, pin supported package/image versions, verify the exact Ubuntu architecture and cgroup capabilities, and then:

1. create installation configuration and explicit PostgreSQL, artifact, and Caddy-data volumes without deleting existing state;
2. start only PostgreSQL and wait for its health check;
3. run the idempotent schema migrations needed by setup;
4. run the setup entry point interactively, sending hidden Operator input over the terminal rather than arguments, URLs, environment variables, or generated Compose configuration; the database transaction decides whether creation is needed and concurrent or ambiguous checks fail closed; and
5. start the pinned full Compose project with health waiting, publishing only Caddy's ports 80/443.

On rerun or update, inspect the installed manifest and database compatibility, pull the explicitly selected images, run safe migrations, and let `docker compose up --detach --wait` recreate only changed containers while preserving mounted volumes. Never use `docker compose down --volumes` in install, repair, or update. Rollback to an older application image is supportable only across migrations explicitly tested as backward-compatible; otherwise fail closed and report the blocking version rather than improvising a database rollback. Compose documents both volume-preserving recreation and the fact that volume deletion requires an explicit flag. See [`docker compose up`](https://docs.docker.com/reference/cli/docker/compose/up/) and [`docker compose down`](https://docs.docker.com/reference/cli/docker/compose/down/).

Only Caddy joins the public port boundary; web, worker, PostgreSQL, and `kestrel-envd` publish no host ports. Use separate Compose networks and per-service secrets/mounts, and persist Caddy's `/data`. Caddy forwards the canonical origin to web and does not need special buffering configuration for correctly typed SSE. Docker and the workload containers must have explicit resource limits because Docker documents that containers are unlimited by default. See [Compose networks](https://docs.docker.com/reference/compose-file/networks/), [Compose service controls](https://docs.docker.com/reference/compose-file/services/), [Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/), and the [official Caddy image](https://hub.docker.com/_/caddy).

After a process crash or same-host reboot, systemd restores Docker/containerd, Docker restart policy restores Caddy/web/worker/PostgreSQL/`kestrel-envd`, PostgreSQL leases restore eligible work, and the worker reconciles Kestrel-labeled disposable containers against authoritative database attempts before resuming. PostgreSQL, the artifact volume, and Caddy data survive container recreation. They do not constitute disaster recovery: by the [V1 retention decision](https://github.com/Ic3b3rg/kestrel/issues/20#issuecomment-5256598204), Kestrel offers no backup/restore facility and loss or corruption of the host or durable store is unrecoverable. Only the separate host-local uninstall flow, with an explicit managed-data removal action, may remove the Installation's volumes and keys.

### Required deployment gate

Before accepting A, extend the tracer bullet with these pass/fail cases:

- prove by mount, mode, group, and in-container inspection that Caddy, web, worker, PostgreSQL, ACP runtime, verification runner, and every Review Environment lack the raw Docker socket and cannot reach `kestrel-envd` except for the worker's narrow Unix API;
- fuzz every `kestrel-envd` request field and prove that arbitrary image references, commands, mounts, devices, namespaces, networks, privileges, capabilities, and Docker API paths are rejected before an engine call;
- attempt to mount `/`, PostgreSQL data, artifact storage, Docker state, provider credentials, the envd socket, and another Project; all must fail, including when repository content, ACP output, and tool arguments contain crafted paths;
- kill worker, `kestrel-envd`, Docker, PostgreSQL, and the host at every create/start/stop/delete boundary; restart reconciliation must leave no unmanaged descendant and must never delete a control-plane container or volume;
- enforce and observe distinct control-plane and aggregate-workload parent cgroups plus per-attempt CPU, memory, PID, writable-disk, and cleanup boundaries under pressure;
- update and rerun the installer with an existing Operator and populated volumes; it must neither prompt for or replace the Operator nor erase PostgreSQL, artifacts, or Caddy data;
- expose only 80/443, verify HTTP-to-HTTPS redirect, certificate renewal state persistence, canonical-origin routing, webhook reachability, authenticated control-plane routes, and SSE delivery across Caddy and a web-container restart;
- measure the full Compose baseline—including Docker/containerd, Caddy, `kestrel-envd`, web, worker, and PostgreSQL—against the same 4-vCPU/8-GB/75-GB envelope. Compare B on identical workloads if A fails a security or resource gate.

## Required implementation-language benchmark

Do not use synthetic hello-world HTTP benchmarks. Build the same disposable tracer bullet in Elixir/Phoenix, Go, Rust, and TypeScript/Node, pinned to the source versions evaluated, with no production code reuse. Each must:

1. accept one idempotent `start Conceptual Review` command;
2. transactionally create domain state, audit/event rows, and a PostgreSQL job;
3. claim the job in a separately launchable worker;
4. create one constrained Docker Review Environment through the narrow `kestrel-envd` provider port;
5. launch a fake ACP runtime inside that environment and ingest over stdio a fixed trace containing messages, tool updates, permissions, a diff, usage, malformed input, and a controlled stall, then tear down the complete environment process tree;
6. write and verify a 1 GiB content-addressed artifact;
7. stream progress to a PWA/test client, disconnect it, restart the web process, and replay from `Last-Event-ID`;
8. survive injected worker, web, PostgreSQL, ACP-child, and container crashes without losing authoritative state.

Run on a clean Ubuntu 26.04 reference host and record, for every candidate:

| Measurement | Required scenarios |
| --- | --- |
| Idle footprint | Boot plus 30-minute steady state for Docker/containerd, Caddy, PostgreSQL, web, one worker, and `kestrel-envd`; RSS/PSS, CPU, open FDs, processes/threads, database connections, and disk. |
| Active footprint | One and two concurrent fake reviews; peak and p95 RSS/PSS, CPU, event-loop/scheduler delay, database connections, WAL volume, artifact write amplification, and Review Environment headroom. |
| Latency | Cold start; service restart to healthy; API p50/p95/p99; job enqueue-to-claim; SSE commit-to-render; ACP first event; environment create/ready/kill/delete. |
| Crash recovery | `SIGKILL` before claim, after claim, after an external-effect marker, before completion, during artifact install, and during event delivery; PostgreSQL restart; host reboot; stale worker completion. |
| Backpressure | ACP child emits 10,000 small events, a maximum-size allowed frame, slow stdout consumption, and a stalled client; memory must remain bounded and the web path responsive. |
| Disk envelope | Three repository fixtures (small, medium, pinned large public repository), two concurrent Review Revisions, failed-attempt cleanup, replacement cleanup, Docker image/cache state, WAL, retained canonical data, and the declared safety reserve within 75 GB. Unsupported external backups are outside the V1 envelope. |
| PWA | Narrow and wide viewports, reconnect after radio loss and web restart, installable manifest, static-shell cold/warm load, and no automatic replay of Operator commands. |
| Delivery risk | Time and changed lines for the tracer bullet, dependency count and licenses, build/test time, migration behavior, unsupported custom protocol code, and upgrade surface. |

Before fixing numeric release thresholds, collect one baseline run for all four. The TypeScript recommendation fails if it cannot leave enough measured RAM, CPU, and disk headroom for the supported number of Review Environments, or if CPU/backpressure can make the PWA unresponsive. A Go, Rust, or Elixir replacement must pass the same functional and crash suite; a smaller idle RSS alone is insufficient.

## Required durable-job conformance suite

Run this against pg-boss and the queue library used in every comparison spike:

- two workers race one eligible job; only one current lease/fencing token may advance state;
- enqueue and authorizing domain change commit or roll back together;
- kill after claim and before completion; the job becomes eligible again without manual repair;
- kill after a simulated external effect and before completion; retry occurs, and idempotency prevents a second effect;
- stop gracefully and by `SIGKILL`; compare recovery timing and error/attempt accounting;
- restart PostgreSQL while workers are active; no authorized job disappears;
- deliver duplicate, late, and out-of-order completion attempts; only the current attempt can win;
- exhaust retries, cancel, and supersede a Review Workflow; late work cannot publish;
- prune queue history without deleting Kestrel's Installation Audit or active idempotency records;
- prove all polling/notification paths recover if `LISTEN/NOTIFY` messages are missed.

The suite, not a library's “exactly once” label, is the acceptance evidence.

## Required ACP v1 and containment spike

Use one Kestrel-owned adapter contract against at least Codex ACP and one non-Codex ACP server. Run it first through the official TypeScript SDK and then through `acpx/runtime`; pin exact client and server revisions.

### Protocol cases

- initialize and capture capabilities without assuming optional methods;
- native authentication and reauthentication without persisting vendor tokens in Kestrel domain rows;
- `session/new`, supported load/resume behavior, prompt, updates, plan, file/tool/diff content, usage, and permission allow/deny;
- missing usage, unsupported capability, unknown extension, duplicate response, late notification, malformed JSON-RPC, oversized frame, invalid UTF-8, and server stderr flood;
- bounded cancellation, cancel/effect race, graceful runtime exit, ignored cancellation, provider-boundary kill escalation, and honest `outcome_unknown` classification;
- client, server, worker, and host restart; Kestrel-owned checkpoints survive while runtime-owned interrupted-turn state is never presumed resumable;
- event normalization with stable Kestrel IDs and deterministic replay without ACP becoming the event store.

### Containment cases

- an ACP server that bypasses client filesystem, terminal, and permission methods still cannot write the retained Review Revision, reach PostgreSQL, read the artifact store, access the Docker socket or `kestrel-envd`, inspect another Project, or obtain Repository Provider credentials;
- the model-authenticated runtime supervisor can reach only its approved model channel; lower-authority verification cannot reach that credential or general network paths;
- the provider owns the complete ACP runtime process tree, and all descendants inherit PID, CPU, RAM, disk, mount, syscall, and egress limits;
- cancellation and host restart leave no live descendant, writable retained snapshot, mounted secret, or reachable control-plane socket;
- denial and teardown evidence is retained without storing prompts, source, or model responses in the Installation Audit.

### Dependency decision

Adopt the official `@agentclientprotocol/sdk` as the default production implementation unless the spike shows that `acpx/runtime` removes meaningful, tested lifecycle work. `acpx/runtime` may replace it only if it passes every case, exposes the events Kestrel needs without owning Kestrel session policy, and is isolated behind the Agent Runtime Port. Its current alpha warning forbids allowing its types or store to become domain contracts.

## Rejected initial alternatives

| Alternative | Initial disposition | Why |
| --- | --- | --- |
| Elixir/Phoenix + Oban | **Second choice; benchmark** | Best built-in supervision/jobs/realtime story, but requires a new ACP client or an additional runtime boundary. |
| Go + River | **Benchmark; do not start here** | Excellent container integration and plausible footprint, but custom ACP plus a separate TypeScript PWA increases owned seams; River is still pre-1.0. |
| Rust + Tokio/Axum/Apalis | **Defer** | Official ACP and strong systems integration, but the checked PostgreSQL job framework is still a release candidate and delivery risk is higher for a product-heavy first slice. |
| Node + `acpx/runtime` as an immediate domain foundation | **Reject** | `acpx` is alpha; it may implement an adapter, never Kestrel workflow state, policy, or persistence. |
| Redis/RabbitMQ/Temporal in V1 | **Reject under current decisions** | They add another durable service or workflow authority when PostgreSQL already owns Kestrel state and expected throughput is unproven. Reconsider only from measured pressure or missing semantics. |
| Microservices | **Reject under current decisions** | They add network contracts, deployments, and distributed failure modes without resolving a current scaling boundary. The same codebase already permits independently scaled web and worker processes. |

## Falsifiers and final decision rule

Replace the TypeScript recommendation before implementation if any of these is demonstrated:

1. the benchmark cannot preserve a declared safe resource reserve for Review Environments on 4 vCPU/8 GB/75 GB;
2. ACP parsing, model output, or artifact work can starve the PWA despite bounded queues and process separation;
3. pg-boss cannot pass the crash, fencing, transactional-enqueue, and pruning suite without invasive patches;
4. the official TypeScript ACP SDK or `acpx/runtime` cannot pass Kestrel's protocol and containment contract, while the Rust SDK or another candidate can;
5. the Docker/`kestrel-envd` deployment cannot keep raw engine authority unreachable from model-influenced surfaces, preserve the required cgroup split, or reconcile cleanup safely on Ubuntu 26.04, and the rootless-Podman fallback can;
6. the tracer bullet shows a materially lower implementation and operational risk in Elixir, Go, or Rust after including its ACP and PWA seams—not merely a lower idle-memory number.

Absent a falsifier, proceed with **Node 24 LTS + strict TypeScript + Fastify + React/Vite + PostgreSQL 18 + pg-boss + official ACP TypeScript SDK + Docker Compose + Caddy + capability-scoped `kestrel-envd`**. Host systemd supervises Docker/containerd; it does not need separate application units. Keep all infrastructure behind Kestrel-owned ports, treat PostgreSQL and the artifact volume as the only durable Kestrel authorities, persist Caddy's operational TLS data, and make the benchmark/conformance reports release-gate artifacts. Fall back to dedicated-user rootless Podman only if the Docker supervisor gate fails.

## Primary sources

- [Ubuntu 26.04 LTS release notes](https://documentation.ubuntu.com/release-notes/26.04/)
- [Ubuntu Server](https://ubuntu.com/download/server)
- [Node.js release policy and schedule](https://nodejs.org/en/about/previous-releases)
- [Node.js worker threads](https://nodejs.org/api/worker_threads.html)
- [Node.js child processes](https://nodejs.org/api/child_process.html)
- [Fastify encapsulation](https://fastify.dev/docs/latest/Reference/Encapsulation/)
- [Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [React with TypeScript](https://react.dev/learn/typescript)
- [Vite production build](https://vite.dev/guide/build.html)
- [`node-postgres`](https://github.com/brianc/node-postgres)
- [PostgreSQL `SELECT` / `SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html)
- [PostgreSQL `NOTIFY`](https://www.postgresql.org/docs/current/sql-notify.html)
- [PostgreSQL asynchronous commit](https://www.postgresql.org/docs/current/wal-async-commit.html)
- [PostgreSQL WAL settings](https://www.postgresql.org/docs/current/runtime-config-wal.html)
- [pg-boss](https://github.com/timgit/pg-boss)
- [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP official libraries](https://github.com/agentclientprotocol)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [ACP Rust SDK](https://github.com/agentclientprotocol/rust-sdk)
- [`acpx`](https://github.com/openclaw/acpx)
- [Elixir processes](https://hexdocs.pm/elixir/processes.html)
- [Elixir `Supervisor`](https://elixir.hexdocs.pm/Supervisor.html)
- [Phoenix Channels](https://phoenix.hexdocs.pm/channels.html)
- [Oban](https://oban.hexdocs.pm/Oban.html)
- [Oban orphan rescue](https://oban.hexdocs.pm/Oban.Plugins.Lifeline.html)
- [Effective Go: concurrency](https://go.dev/doc/effective_go#concurrency)
- [River](https://github.com/riverqueue/river)
- [Docker Engine SDKs](https://docs.docker.com/reference/api/engine/sdk/)
- [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Docker daemon attack surface](https://docs.docker.com/engine/security/#docker-daemon-attack-surface)
- [Docker authorization plugins](https://docs.docker.com/engine/extend/plugins_authorization/)
- [Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)
- [Docker rootless mode](https://docs.docker.com/engine/security/rootless/)
- [Docker rootless operational constraints](https://docs.docker.com/engine/security/rootless/tips/)
- [Compose in production](https://docs.docker.com/compose/how-tos/production/)
- [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/)
- [Compose service controls](https://docs.docker.com/reference/compose-file/services/)
- [Compose networks](https://docs.docker.com/reference/compose-file/networks/)
- [`docker compose up`](https://docs.docker.com/reference/cli/docker/compose/up/)
- [`docker compose down`](https://docs.docker.com/reference/cli/docker/compose/down/)
- [Tokio tasks](https://tokio.rs/tokio/tutorial/spawning)
- [Tokio graceful shutdown](https://tokio.rs/tokio/topics/shutdown)
- [Axum SSE](https://docs.rs/axum/latest/axum/response/sse/)
- [Apalis](https://github.com/apalis-dev/apalis)
- [Bollard](https://github.com/fussybeaver/bollard)
- [Podman](https://docs.podman.io/en/latest/markdown/podman.1.html)
- [Podman API service](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html)
- [Podman rootless setup](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md)
- [Podman rootless limitations](https://github.com/containers/podman/blob/main/rootless.md)
- [Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
- [systemd service units](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
- [systemd resource control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [Caddy data directory](https://caddyserver.com/docs/conventions#data-directory)
- [Caddy reverse-proxy streaming](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)
- [Official Caddy container image](https://hub.docker.com/_/caddy)
- [Kestrel Operator bootstrap decision](https://github.com/Ic3b3rg/kestrel/issues/19#issuecomment-5254430070)
- [Kestrel Reference Installation decision](https://github.com/Ic3b3rg/kestrel/issues/16#issuecomment-5278718836)
- [Kestrel V1 retention and recovery decision](https://github.com/Ic3b3rg/kestrel/issues/20#issuecomment-5256598204)
- [HTML Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [Web App Manifest](https://www.w3.org/TR/appmanifest/)
- [Service Workers](https://www.w3.org/TR/service-workers/)
