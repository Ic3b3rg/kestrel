# DinD verification experiment — 2026-10-04

Delivery card: measure an executable environment for the retained #142 checkpoint | #142, no new tracker issue | `fix/factory-runtime-observability`, `kestrel-source-budget` | no PR | diagnose remaining browser failures, then integrate a runner if selected | real Docker, HTTP and browser verification | experiment-owned resources; persistent runtime unchanged.

## Result and scope

Docker-in-Docker ran the project's Node, PostgreSQL, HTTP and browser checks locally. In the corrected profile, all nine accepted verification commands ran to completion: eight passed; the browser command had three passing tests and one failure. The full unit suite passed 1,486 tests with eight existing skips. This is evidence that this project can run nested Docker workloads on this machine, not evidence that #142 is complete or that a production runner is integrated.

This replay starts from the agent's retained committed checkpoint. It does **not** invoke Codex again, implement code, create a review, change the task's database state, or measure inference. No test was removed and the retained source stayed clean. The task's existing blocked state was not turned into success.

## Source and reproduction

The harnesses named below are experiment snapshots retained with the local evidence. They are not
supported application commands or a production DinD runner. Raw logs and snapshots remain outside
the repository; this report records their identity and measured results.

- Run: `01a0f904-c041-7bf5-99d5-43b50fa1ce3a`.
- Feature: `01a0f7ee-bd85-7c5b-8ddd-0942adeadacd`.
- Head: `4cd8b55c1b19a0460c50228f7cb1c075ddbd399d`.
- Tree: `944e5cf36d88f284d6e0559fd29a32348bef6c7c`.
- Base: `f0803bb3ff85e3d2b04743403b5a0361072f1a40`.
- Harness: `scripts/measure-dind-task.mjs`, deliberately specific to this macOS installation and retained-run schema.
- Absolute evidence root: `/Users/silvioceccarini/Library/Application Support/Kestrel/development/measurements/`.
- Attempts: `dind-20261004-a`, `dind-20261004-b`, `dind-20261004-c`.

Each attempt retains its manifest, harness snapshot, command logs, results, resource samples and Docker events. B and C also retain browser screenshots, traces and failure snapshots. `summary.json` aggregates the measurements and C has `checks.csv`. Raw evidence remains outside disposable worktrees. The experiment CLI's exit status reports collection completion; the individual check results, not that status, determine verification success.

To repeat, use a new output directory (the harness refuses an existing one), the retained bare repository and the run ID:

```sh
node scripts/measure-dind-task.mjs \
  '/absolute/state-root/measurements/new-attempt' \
  '/absolute/retained-feature/control/repository.git' \
  01a0f904-c041-7bf5-99d5-43b50fa1ce3a
```

This requires the existing local database and executor image. It is an experiment tool, not a portable or dynamically sized runner.

## Machine and corrected profile

The host has 24 GiB physical RAM. Docker Desktop exposes 8,319,238,144 bytes (7.75 GiB) and 12 CPUs to its Linux VM, arm64, cgroup v2. Other user applications remained running: this was not an otherwise idle machine.

The corrected profile has two sibling outer containers: a private privileged DinD daemon and a non-root job. Each has a 3 GiB memory cap, no additional swap allowance, a 512 PID cap and a two-CPU quota. Both use CPU set `0-1`, so this intentionally limits them to the same two CPUs. The job has 256 MiB shared memory and `NODE_OPTIONS=--max-old-space-size=2048`. These are experimental fixed quotas, not a proposed universal default.

The private daemon includes the inner service containers in its cgroup accounting. Workspace, temporary files, daemon data and socket use exclusive Linux named volumes. The job shares the daemon's network namespace so service ports on localhost are reachable. No host Docker socket is mounted and no Docker daemon TCP port is published. The job runs as `1000:1000`, matching the project's service user, with access to the private socket's supplementary group. It uses `--init` to reap children.

DinD is pinned to `docker@sha256:7dcdfc4a20246236f558175182ccace1eb15a41bd3eb119dd2284f393498b7c1`. The executor base observed after the run is `kestrel-factory-executor:0.155.1`, image ID `sha256:7fb65e8f51f8fb4044a82a12a379a158309a0b928229a98943db2edba6e6be41`. Actual tools: Node 24.18.1, npm 11.16.0, Git 2.47.3, inner Docker 29.8.2, Compose 5.5.1, Playwright 1.62.1 with Chromium. The package manager declaration is npm 11.6.2; the experiment did not install that exact version.

Preparation installs client CA certificates and browser/system dependencies, runs `npm ci` and the workspace build, then builds the project service image **before** the test hooks. All preparation time is recorded separately. The test commands and their existing per-command deadlines remain unchanged. There is no aggregate 30-minute deadline in the harness; C completed in less than 30 minutes and therefore does not by itself prove a multi-hour run.

## Measurements

Sampling occurs approximately every five seconds and at phase boundaries. Logs include host `memory_pressure`, `vm_stat`, process RSS/CPU, whole-VM memory/pressure, outer cgroups, Docker stats, I/O, disk usage and inner Docker lifecycle events. Individual cgroup `memory.peak` counters retain peaks between samples; the simultaneous combined value is sampled and may miss a shorter peak. Client image construction happens on the outer engine before the experiment containers exist; its host impact is sampled but is not included in their cgroup totals.

| Metric | B | C |
| --- | ---: | ---: |
| Resource samples | 191 | 195 |
| Total instrumented wall time, including preparation/cleanup | 15m 10s | 15m 47s |
| Job cgroup peak | 2.80 GiB | 2.77 GiB |
| Daemon + inner services cgroup peak | approximately 3.00 GiB | 3.00 GiB |
| Maximum simultaneous job + daemon charge | 4.37 GiB | 4.13 GiB |
| Job / daemon PID peaks | 117 / 225 | 124 / 237 |
| Job / daemon PID-limit events | 0 / 0 | 0 / 0 |
| Job / daemon OOM events and OOM kills | 0 / 0 | 0 / 0 |
| Daemon memory-limit `max` events | 1,356 | 548 |
| Minimum whole-VM `MemAvailable` | 4.38 GiB | 4.32 GiB |
| Host memory-pressure free percentage, baseline / minimum / after cleanup | 46 / 32 / 39% | 41 / 33 / 35% |
| Job / daemon cumulative CPU time at final sample | 597.53 / 180.82 CPU seconds | 545.00 / 262.88 CPU seconds |

Memory charge includes filesystem cache and kernel accounting; it is not equivalent to process RSS. Do not sum independently timed peaks, and do not add inner-container memory again to the daemon's parent total. C's daemon did reach its memory boundary and perform reclaim: absence of OOM does not mean the cap was never touched. The kernel defines `memory.events:max` as attempts to exceed the boundary and `oom_kill` separately. See [cgroup v2 documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#memory).

Host `vm_stat` counters increased by approximately **2.61 GiB of swap-ins and 2.67 GiB of swap-outs** during C, with 0.77 GiB of pageouts and a 1.28 GiB increase in compressor occupancy. These are system-wide deltas on a shared workstation; they cannot be attributed exclusively to the experiment. They are nevertheless a reason to measure responsiveness and swap rate before admitting additional jobs. The host free percentage is the output of `memory_pressure`, not a direct percentage of unused physical bytes.

### C preparation and checks

The client image build took 7.53 seconds using cache; its initial construction in A took 309.24 seconds. C's private daemon began with an empty data volume: its service image build took 159.91 seconds. Dependency installation took 54.22 seconds and preparatory workspace build 19.92 seconds. This is not a completely cold host-cache benchmark.

| Accepted check | Seconds | Result |
| --- | ---: | --- |
| Focused tests | 72.90 | 234 passed |
| HTTP black-box tests | 127.38 | 2 passed |
| Browser acceptance | 146.53 | 3 passed, 1 failed |
| Contracts | 0.73 | passed |
| Formatting | 6.84 | passed |
| Lint | 38.87 | passed |
| Typecheck | 23.29 | passed |
| Full unit suite | 226.66 | 1,486 passed, 8 skipped |
| Build | 26.29 | passed |

The nine check durations total 11m 10s. Maximum simultaneous charge by sampled phase was 2.63 GiB during service image preparation, 3.71 GiB during HTTP tests, 4.13 GiB during browser tests, 3.87 GiB during lint, and 3.92 GiB during typecheck. Memory retained from earlier phases is included.

## What the unsuccessful attempts taught us

**A:** The initial harness used host bind mounts, omitted `--init`, lacked client CA certificates, and did not build workspace packages before browser tests. It exposed a case-sensitive filename test mismatch, unreaped Git children, missing certificates and missing built packages. Its job reached 518 recorded tasks against a 512 PID cap, with 186 limit events. After inspecting the process, logs and zombie accumulation, we deliberately interrupted it. Its incomplete eighth check is explicitly invalidated (`code: null`, `cancelled: true`), despite Docker's CLI returning zero; check nine did not run. A is not passing evidence. The production runner already uses `--init`: this omission was in the experimental harness.

**B:** Native Linux volumes, init, certificates and a preparatory build fixed the previous environmental failures. All nine commands completed, but root-owned fixture repositories conflicted with non-root services, root execution violated three runtime test contracts, an inherited Git override contaminated a PATH test, and a cold service build exhausted a 180-second test setup hook. These failures motivated C's matching UID, removal of the global Git override, and explicit service preparation. Several variables changed together; these runs do not isolate each variable's performance effect.

**Remaining browser failures:** In B the documentation test failed at line 52 waiting for a pagination button that had disappeared; its snapshot already contained the last file and all 206 artifacts. A synchronization race is the leading explanation. In C the same test failed earlier, at line 31, because the page was still at login. Its trace records the login POST without a completed response (`status: -1`), followed by a new session request returning 401. The test clicks sign-in and immediately navigates again without waiting for authentication completion. Navigation interrupting the pending login is the leading explanation, not an established product root cause. These are distinct failures. C did not reach the pagination section. No test was patched or relaxed to obtain the measurement result.

## Cleanup and unchanged runtime

All three experiment-owned daemon/job containers, named volumes and custom client image tags were removed by label-checked cleanup. Inner stacks left no containers at each completed C check boundary. C's final workspace status was clean. A fresh post-run inventory found no `kestrel.experiment` containers, volumes or tagged images; only the pre-existing healthy `kestrel-postgres-1` container remained. The persistent supervisor remained running with PID 16670; no runtime deployment or database mutation was performed.

Evidence files, the downloaded pinned DinD base image and outer BuildKit cache are retained. They are deliberate residue, not running task processes. Docker's overall post-run inventory showed 22.93 GB of build cache; there is no before/after baseline to attribute that total to this experiment. No global prune was used.

## Decision supported by these data

DinD is a demonstrated execution option for this Node/PostgreSQL/PWA checkpoint. Merely enabling privileged DinD is insufficient: the job also needs appropriate filesystem semantics, credentials/certificates, tools, user identity, process lifecycle and preparation. The existing 2 GiB/128 PID profile should not be treated as sufficient for this workload; this experiment does not establish the smallest sufficient replacement profile.

A first integration should admit one heavy verification phase at a time, retain the private daemon for related checks, and release its services after each phase. Resource admission must consider the execution VM, host pressure/swap and any local inference process separately. The measured 4.13 GiB charge is an observation, not a safe admission threshold. A fixed concurrency count or a FILO queue does not establish a memory budget.

Still unmeasured: a 16 GiB host, local LLM inference, private inference endpoints, Android/Flutter emulation, multi-task concurrency, long-duration leaks and a complete new factory agent loop. No claim about their feasibility or memory allowance follows from this run. Production adapter integration, automatic capability selection and recovery policy remain implementation work. The immediate verification gate is to fix and rerun the affected browser journey without changing its acceptance requirements.
