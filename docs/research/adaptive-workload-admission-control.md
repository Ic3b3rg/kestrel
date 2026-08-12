# Adaptive workload admission and control-plane protection

**Status:** evidence base and recommended policy shape

**Research date:** 2026-08-12

**Reference Installation:** one Operator; 4 shared vCPU, 8 GB RAM, 75 GB
NVMe; approximately EUR 10/month; no local model inference

**Scope:** single-host Linux resource admission and containment for concurrent
Conceptual Review analysis and Agent Run workloads

**Decision boundary:** this note selects neither Docker, Kubernetes, systemd,
nor an implementation language. It specifies the Linux-level contract that any
chosen supervisor and Sandbox runtime must satisfy.

## Research question

What evidence-backed policy should Kestrel use to measure, reserve, admit,
queue, constrain, pause, and terminate concurrent workloads while keeping its
control plane responsive, without pretending that the future resource demand
of an arbitrary repository or toolchain is knowable?

The answer must preserve an Operator-configurable maximum parallelism and a
queue. It must not silently reduce the product to one concurrent job.

## Executive conclusion

Kestrel should use a **hybrid conservative-admission and feedback-control
policy**, implemented over a two-level resource hierarchy:

```text
host
├── operating-system services and emergency headroom
└── kestrel
    ├── control plane
    │   ├── PWA/API/scheduler
    │   └── durable data services
    └── workload pool
        ├── Conceptual Review job A
        ├── Agent Run job B
        └── ...
```

The control plane and aggregate workload pool are siblings; every running job
is a child of the pool. Limits imposed above a delegated cgroup subtree cannot
be escaped by settings below it, which makes this hierarchy the enforceable
boundary rather than an accounting convention ([Linux cgroup v2, kernel 6.16,
2025](https://docs.kernel.org/6.16/admin-guide/cgroup-v2.html)).

The policy must treat resources differently:

- **CPU time and I/O bandwidth are compressible:** contention can be throttled
  at the cost of latency or throughput. Kestrel may overcommit them within an
  aggregate workload cap, continuously measuring whether the control plane is
  still meeting its responsiveness objective.
- **Memory and disk space are non-compressible:** exhaustion normally requires
  failing or killing work. Kestrel should therefore make conservative
  bookkeeping commitments before admission and should not overcommit RAM by
  default on the reference Installation.

This distinction is both operationally observed in Borg and reflected in Linux
controller semantics: CPU and I/O can be rate-limited, whereas exhausting RAM
or disk space requires a failure response ([Borg, EuroSys
2015](https://research.google.com/pubs/archive/43438.pdf)). It does **not** imply
that CPU and I/O interference are harmless; they can make the control plane
unusable, so their acceptance criterion is latency, not merely survival.

The Operator's maximum-parallelism setting is a ceiling, not a command to start
that many jobs. A job starts only when all safety gates pass; otherwise it stays
in the queue with an explicit reason. The automatic mode chooses a ceiling from
benchmark-calibrated profiles, while manual mode lets the Operator lower or
raise that ceiling. Neither mode may bypass the non-overcommitted memory budget,
the storage guard, or a live control-plane-health circuit breaker.

No numeric reserve, pressure threshold, job profile, or default concurrency is
justified yet. Linux documentation describes mechanisms, and the academic
systems demonstrate policies on other workloads and hardware; none measures
Kestrel on this VPS. Those values belong to the later runtime benchmark.

## What is knowable

The word “budget” hides five different levels of confidence. Kestrel should
keep them separate in its model, telemetry, UI, and tests.

| Level | Meaning | Examples in this policy |
| --- | --- | --- |
| **Kernel-enforced boundary** | A controller rejects, throttles, or kills according to a configured interface, subject to its documented caveats. | fair-class CPU bandwidth, cgroup-local memory OOM, PID creation limit, filesystem hard quota |
| **Configured Kestrel policy** | A deterministic choice made by Kestrel or the Operator; Linux does not prove it is a good value. | queue order, maximum parallelism, control-plane priority, victim selection, cooldown |
| **Empirically calibrated threshold** | A value accepted only after reproducible benchmark evidence on the supported host. | workload-pool CPU cap, control-plane memory protection, PSI trigger, default per-class job envelope |
| **Workload estimate** | A probabilistic forecast derived from class, Project, revision, toolchain, or prior runs. | expected peak RAM, CPU demand, disk growth, duration |
| **Unknown** | Demand that available evidence cannot bound reliably. | unseen repository behavior, new toolchain phase, memory leak, fork bomb, shared-vCPU steal, provider-side host interference |

An estimate never becomes a kernel guarantee. A historical model may improve
utilization, but an admission decision must remain safe when the model is wrong.

## Linux mechanisms and their actual semantics

The controller interface cited below is the Linux 6.16 cgroup v2 documentation,
not a promise that every VPS image exposes every controller. Installation must
audit the active unified hierarchy, kernel configuration, block stack, and
filesystem. A missing required controller is a failed support precondition, not
a reason to run without containment.

### Hierarchical ownership

Cgroup v2 organizes processes in one hierarchy, and child restrictions cannot
override restrictions placed by an ancestor. New child processes inherit the
parent's cgroup; production supervision should place the initial process in its
final job cgroup before it can fork, and should prevent the Sandbox from moving
processes outside the delegated subtree. The kernel guidance also recommends
assigning a workload once and changing controller values rather than repeatedly
migrating it, because stateful resources such as memory do not migrate with a
process ([cgroup v2: organization, delegation, and “organize once”
guidance](https://docs.kernel.org/6.16/admin-guide/cgroup-v2.html)).

**Kestrel implication:** every process and descendant belonging to one
Conceptual Review or Agent Run must be born into one job subtree. Per-process
sampling without this resource-principal boundary is insufficient. The original
resource-container work made the same general point: a resource principal must
not be confused with a process or protection domain ([Banga, Druschel, and
Mogul, OSDI 1999](https://www.usenix.org/conference/osdi-99/presentation/resource-containers-new-facility-resource-management-server-systems)).

### CPU: throttleable, but not reservable by observation

For fair-class workloads, `cpu.weight` distributes cycles proportionally among
active siblings and is work-conserving; unused capacity can be borrowed.
`cpu.max` sets a maximum amount of CPU bandwidth per period. `cpu.stat` reports
usage and throttling. These controls apply only to documented scheduling
classes, so an unprivileged Sandbox must not be able to enter a scheduling class
that bypasses the intended control ([cgroup v2 CPU
controller](https://docs.kernel.org/6.16/admin-guide/cgroup-v2.html)).

Consequences:

- A higher control-plane weight is a relative priority under contention, not a
  guaranteed number of physical cores.
- An aggregate workload-pool `cpu.max` can leave nominal guest CPU time for the
  control plane, but a shared-vCPU provider can still withhold physical CPU.
- Current CPU utilization says how busy the guest was, not how much CPU the
  next phase of a build will request.
- CPU can be intentionally oversubscribed because the normal failure mode is
  throttling and slower jobs. Admission still stops when CPU pressure or
  control-plane tail latency breaches its calibrated guard.

The control-plane responsiveness target is therefore an empirical service
objective. Linux supplies enforcement and telemetry, not an end-to-end latency
guarantee.

### Memory: protection, throttle, and terminal boundary are different

The memory controller accounts major user memory, page cache, kernel data
structures, and TCP buffers, but the kernel explicitly describes the coverage
as not completely water-tight. Its interfaces serve distinct purposes
([cgroup v2 memory controller](https://docs.kernel.org/6.16/admin-guide/cgroup-v2.html)):

| Interface | Documented behavior | Kestrel use |
| --- | --- | --- |
| `memory.current`, `memory.peak`, `memory.stat` | Current, peak, and classified cgroup usage. | Measurement and profile evidence, never future prediction. |
| `memory.min` | Hard reclaim protection within the effective ancestor boundary. Overcommitting protected memory divides protection and can cause constant OOMs. | A narrow, measured essential control-plane floor only after benchmark and failure testing. |
| `memory.low` | Best-effort reclaim protection. | Additional control-plane preference without claiming a hard guarantee. |
| `memory.high` | Throttles the cgroup under heavy reclaim; may be breached and never itself invokes OOM. It expects an external manager to respond. | Early job/pool pressure boundary and escalation signal. |
| `memory.max` | Main hard limit; if reclaim cannot satisfy it, OOM occurs within the cgroup. Temporary overage and allocation-specific exceptions are documented. | Aggregate workload-pool ceiling and a finite per-job terminal envelope. |
| `memory.oom.group=1` | Treats a workload as indivisible for cgroup OOM and kills it together rather than partially. A cgroup-local OOM does not choose victims outside that cgroup. | Fail one job coherently and preserve control-plane availability. |
| `memory.events(.local)` | Counts low/high/max/OOM/OOM-kill events. | Auditable failure classification and feedback. |

`memory.min` is reclaim protection, not an up-front physical allocation. Kestrel
must still leave an explicit host/OS margin and ensure that its protected values
are not overcommitted. The initial benchmark must find the smallest control-plane
working set that remains responsive under stress; only that measured essential
floor is a candidate for `memory.min`. The remainder can use `memory.low` plus a
finite `memory.high`/`memory.max`, so a control-plane leak is observable and
bounded rather than made unkillable.

For each running job, Kestrel should configure `memory.high < memory.max` and
observe `memory.events` plus PSI. Reaching `memory.high` pauses admissions and
gives the supervisor time to act. Reaching `memory.max` is a contained job
failure, not a capacity-management technique.

### Swap: bounded explicitly, never counted as free RAM

`memory.swap.max` prevents a cgroup from swapping beyond a configured amount;
`memory.swap.current`, `memory.swap.peak`, and swap events expose usage and
failures. Lowering a limit below current use can take an extended time to
reclaim. The kernel also warns that an administrator cannot assume untrusted
jobs are fully swappable when overcommitting them ([cgroup v2 swap interfaces
and caveat](https://docs.kernel.org/6.16/admin-guide/cgroup-v2.html)).

Kestrel should configure, measure, and report a finite workload swap policy.
It should not add swap bytes to the RAM admission budget: swap changes memory
failure into I/O latency and can threaten the database and PWA. The benchmark
must compare no-swap and bounded-swap profiles before choosing a supported
default.

### Processes: a separate exhaustion dimension

`pids.max` is a hard limit on task creation (the controller counts kernel task
IDs, including threads). `fork()` or `clone()` returns `EAGAIN` when it would
violate the limit, and `pids.events` records the event. Administrative attachment
can make the observed count exceed the configured value, so supervision must
also prohibit job-controlled migration ([cgroup v2 PID
controller](https://docs.kernel.org/6.16/admin-guide/cgroup-v2.html)).

Each job and the aggregate pool need calibrated PID ceilings. This contains a
fork bomb that could exhaust the host before a memory limit is reached.

### I/O: useful throttles with stack-dependent caveats

`io.max` delays reads or writes after a configured BPS/IOPS rate, while allowing
temporary bursts. `io.weight` and latency-oriented controls depend on the block
scheduler and device support. Buffered-write attribution additionally depends on
filesystem cgroup-writeback support, and concurrent writers to the same inode
can be attributed imperfectly ([cgroup v2 I/O and writeback
semantics](https://docs.kernel.org/6.16/admin-guide/cgroup-v2.html)).

Kestrel should place a benchmark-derived aggregate cap on workload I/O and give
the control plane preferential service where the supported block stack actually
enforces it. It must continuously probe database/PWA latency because an apparent
configuration file is not proof that the virtual NVMe path honors the intended
isolation.

### Disk space: cgroups do not supply the capacity boundary

The I/O controller limits rate, not bytes retained. A job that writes slowly can
still fill the 75 GB disk. Linux filesystem quotas can set hard per-project
space and inode limits; a hard quota cannot be exceeded, but support and setup
depend on the filesystem ([Linux `quotactl(2)`, man-pages
6.18](https://man7.org/linux/man-pages/man2/quotactl.2.html)).

Each Sandbox therefore needs an enforceable writable-space boundary, such as a
filesystem project quota or a size-limited storage object supplied by the later
Sandbox design. Kestrel must also maintain separate durable-data and host
free-space reserves. Disk admission is based on committed Sandbox capacity,
not only the `free` value at the instant a job starts.

### Freeze, terminate, and Human Gates

Writing `1` to `cgroup.freeze` eventually stops all processes in the subtree;
the `frozen` event confirms completion. `cgroup.kill` sends `SIGKILL` across the
subtree and is designed to handle concurrent forks and migrations ([cgroup v2
core interfaces](https://docs.kernel.org/6.16/admin-guide/cgroup-v2.html)).

The freezer promises stopped execution, not released RAM, PIDs, open files, or
disk. Kestrel must conservatively keep a frozen Agent Run's entire memory and
storage admission charge. A short Human Gate may use freezing, but it does not
create capacity for another memory-hungry job.

To release CPU, RAM, swap, and PIDs at a potentially long Human Gate, Kestrel
must first persist every state needed for recovery outside the disposable
Sandbox, then terminate the job subtree and later reconstruct it. This is
**hibernation**, not process freezing. The built-in-agent and Sandbox tickets
must define which event, repository, tool, and conversation state makes that
rehydration correct. The filesystem charge remains until the Sandbox is deleted.

## Signals: observed pressure is not future demand

### Pressure Stall Information

PSI reports the wall time in which tasks were stalled on CPU, memory, or I/O.
`some` means at least some tasks were stalled; `full` means all non-idle tasks
were stalled, a state the kernel describes as thrashing for memory or I/O.
It exports 10-, 60-, and 300-second trends and pollable threshold triggers;
the same signals are available per cgroup ([Linux PSI, kernel 6.16,
documentation dated April 2018](https://docs.kernel.org/6.16/accounting/psi.html)).

PSI is highly relevant but semantically **reactive**:

- it measures resource delay that has already occurred;
- a trigger can react early enough to prevent a worse OOM or latency collapse;
- it cannot predict the peak of a job that has not started, nor a sudden future
  allocation by a running compiler;
- system CPU `full` is undefined and reported as zero, so it must not be used as
  a system-wide CPU admission signal.

The systemd pressure protocol describes the same limitation plainly:
notifications arrive after latency has already degraded, and applications can
then release caches, reduce parallelism, defer work, or shed load
([systemd resource-pressure handling, accessed
2026-08-12](https://systemd.io/MEMORY_PRESSURE/)). This is evidence for a
feedback circuit breaker, not evidence for PSI-only admission.

Kestrel should monitor three scopes simultaneously:

1. **control-plane PSI and request latency** — is the protected service being
   harmed?
2. **aggregate workload-pool PSI** — are admitted jobs collectively saturated?
3. **per-job PSI and events** — which job is stalled or exceeding its envelope?

### Instantaneous availability and load

`MemAvailable` estimates memory available for starting applications without
swapping; it is still an estimate of present reclaimability, not a reservation
for a future process ([`proc_meminfo(5)`, man-pages
6.18](https://man7.org/linux/man-pages/man5/proc_meminfo.5.html)). A successful
virtual-memory allocation is not evidence that physical pages will remain
available when the process later touches them: Linux's host-wide overcommit
modes govern virtual address commitments, not per-job admission
([Linux overcommit accounting, kernel
6.16](https://docs.kernel.org/6.16/mm/overcommit-accounting.html)). Kestrel
should not change global VM overcommit policy as a substitute for its own
resource envelopes.

Linux load average combines runnable tasks with tasks waiting in uninterruptible
I/O, so it does not isolate the bottleneck that admission needs to control
([`proc_loadavg(5)`, man-pages
6.18](https://man7.org/linux/man-pages/man5/proc_loadavg.5.html)). A shared VPS
also exposes guest CPU steal time: time the virtual CPU was ready but the host
served another guest. Recording it helps explain provider-side contention but
cannot recover the lost capacity ([`proc_stat(5)`, man-pages
6.18](https://man7.org/linux/man-pages/man5/proc_stat.5.html)).

These host signals are useful sanity checks and anomaly evidence. Neither may
replace committed-envelope bookkeeping or per-resource PSI.

### Historical estimates

Production research supports using history, but also explains why it remains a
forecast:

- Borg starts at the requested limit, waits through startup transients, then
  decays reservations slowly toward observed usage plus a margin and raises
  them quickly after higher demand. More aggressive margins increased OOMs;
  Google chose its trade-off empirically ([Borg, sections 5.5 and
  6.2](https://research.google.com/pubs/archive/43438.pdf)).
- Autopilot treats CPU and memory differently. Its memory signal records the
  peak in each sampling window because underprovisioned CPU is throttled while
  underprovisioned memory can terminate a task. Its moving-window policies rise
  quickly and fall slowly, and its hyperparameters were tuned offline on traces
  from representative jobs ([Autopilot, EuroSys
  2020](https://john.e-wilkes.com/papers/2020-EuroSys-Autopilot.pdf)).
- Resource Central found several Azure VM behaviors predictable across prior
  lifetimes and used long-term high-percentile forecasts for selected
  oversubscribable VM types. Its reported prediction accuracy varied by metric,
  and it still required independent interference isolation
  ([Resource Central, SOSP
  2017](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/10/Resource-Central-SOSP17.pdf)).

These systems operated on enormous populations, often with interchangeable or
failure-tolerant tasks. A single Kestrel Agent Run can be unique, stateful, and
expensive to repeat. Kestrel should therefore begin with simple conservative
class profiles, not an opaque model trained on sparse local data.

History should refine a profile only when the workload identity is comparable:
kind (Conceptual Review or Agent Run), Project, repository/revision scale,
toolchain and lockfile fingerprint, command class, and cold/warm-cache state.
Usage should increase a recommendation quickly and reduce it slowly. A new or
materially changed fingerprint falls back to the cold-start profile.

An OOM-terminated run is **censored evidence**: its observed peak is only a
lower bound on what it needed. Treating that peak as a safe next limit would
repeat the failure.

## Policy alternatives

| Design | Benefit | Failure mode | Decision |
| --- | --- | --- | --- |
| Fixed global slot count | Very simple and explainable. | Ignores that two reviews and two builds have different resource vectors; wastes capacity or overloads it. | Reject as the primary policy. Keep maximum parallelism only as an Operator ceiling. |
| Admit from current free RAM/CPU | Responds to current host utilization. | A low-usage job can allocate later; PSI and free memory are reactive. Simultaneous ramps can exceed memory. | Reject as a safety mechanism. Use only as a health veto. |
| Sum static worst-case job limits | Strong, easy admission accounting. | Safe but can leave most of an 8 GB host unused and makes defaults difficult for arbitrary repositories. | Use for cold starts and hard envelopes, then calibrate classes. |
| History-based overcommit | Can improve utilization for repeated stable jobs. | Cold starts, drift, correlated peaks, and censored OOM samples create false confidence. | Use only as a versioned estimate; no default RAM overcommit on the reference host. |
| PSI-only adaptive controller | Directly measures productivity loss and handles changing load. | Acts after degradation begins and cannot size a not-yet-started job. | Use as feedback/circuit breaker, never as the sole admission gate. |
| Hybrid commitments + hierarchy + feedback + history | Keeps a deterministic containment floor while improving utilization from evidence. | More state and calibration work; still cannot guarantee an arbitrary job completes inside its envelope. | **Recommended.** |

Adaptive admission research on Internet services likewise favors explicit
queues and feedback against a user-visible tail-latency objective over an
unvalidated fixed threshold. It also warns that simple models break under
widely varying internal demands and extreme overload ([Welsh and Culler,
USITS 2003](https://www.usenix.org/legacy/event/usits03/tech/full_papers/welsh/welsh_html/usits.html)).

## Recommended Kestrel policy

### 1. Define non-overlapping host budgets

The supported deployment profile must produce these benchmark-calibrated
quantities:

```text
physical guest RAM
  = host/OS emergency margin
  + control-plane terminal envelope
  + workload-pool terminal envelope

usable disk
  = host/durable-data reserve
  + retained Kestrel data budget
  + active Sandbox committed capacity
  + cleanup/emergency reserve
```

The sums must fit without relying on current page-cache reclaim, swap, or a
prediction that all jobs will stay below their limits. A narrow measured part
of the control-plane memory envelope may be protected with `memory.min`; the
rest remains bounded and observable. The aggregate workload pool receives a
finite `memory.max` no larger than its budget.

CPU uses a different shape: a higher control-plane weight plus a calibrated
aggregate workload `cpu.max`. Per-job weights and optional caps divide the
pool. The cap is selected by the control-plane latency benchmark rather than by
assuming that “one vCPU must be reserved.”

### 2. Give each job an admission profile

Each queued job has a versioned profile containing at least:

- hard memory envelope and lower pressure boundary;
- finite swap policy;
- expected CPU demand and optional per-job maximum;
- PID ceiling;
- I/O weight/cap class;
- writable-disk hard quota and expected retained growth;
- maximum runtime or no-progress policy; and
- provenance: cold-start default, benchmark class, Project history, Operator
  override, or a combination.

The UI must show that this is an **envelope**, not a completion guarantee. A
repository may legitimately need more; Kestrel should fail that job with an
actionable `ResourceEnvelopeExceeded` result and retain evidence needed to
choose a larger profile.

### 3. Admit on committed capacity and health

The scheduler should evaluate one queue candidate atomically against a
snapshot of active commitments:

```text
eligible(job) =
  running_jobs < operator_max_parallelism
  AND sum(active memory.max) + job.memory.max <= workload_pool_memory.max
  AND sum(active disk commitments) + job.disk_quota <= sandbox_disk_budget
  AND estimated CPU packing is inside the calibrated automatic budget
  AND control-plane health circuit is green
  AND no resource-limit reconciliation is in progress
```

The CPU packing term is a performance heuristic, not a safety proof. The
aggregate CPU cap, priority, and feedback remain authoritative. Memory and disk
terms are conservative commitments: do not subtract unused bytes from a running
job merely because it is currently below its envelope.

Queue reasons should be explicit, for example `parallelism ceiling`, `memory
commitment`, `disk commitment`, `control-plane pressure`, or `cooldown after
resource failure`. This makes an automatic decision inspectable by the single
Operator.

### 4. Preserve configurable maximum parallelism

- **Automatic mode:** Kestrel selects the current ceiling from calibrated job
  profiles and recent healthy behavior. It may reduce the ceiling immediately
  on pressure and should raise it only after a stable cooldown.
- **Manual mode:** the Operator sets a maximum number of running jobs. Resource
  commitments and the health circuit may still admit fewer. The setting cannot
  force an unsafe memory or disk overcommit.
- **Advanced envelope override:** if exposed later, changing the pool budgets
  must clearly move the Installation outside the certified reference envelope;
  it is distinct from changing maximum parallelism.

This answers the product requirement without inventing “one job at a time.” The
later benchmark may discover that some mixes support several jobs and others
only one.

### 5. Run a hysteretic feedback circuit

Use at least three policy states rather than starting and killing work on every
short spike:

| State | Evidence | Action |
| --- | --- | --- |
| **Green** | Control-plane latency/error SLO healthy; no sustained host/control PSI; commitments fit. | Admit according to queue and ceiling. |
| **Guarded** | Calibrated PSI/latency trigger, repeated `memory.high`, heavy CPU throttling, I/O delay, or low disk reserve. | Stop new admissions; preserve running work; lower background CPU/I/O; request cooperative checkpoint/cleanup; wait through cooldown. |
| **Containment** | Sustained SLO breach, imminent disk exhaustion, cgroup OOM, PID exhaustion, or failed recovery from Guarded. | Terminate or hibernate the selected restartable workload; never kill arbitrary host processes; reconcile limits and remain closed until healthy. |

Thresholds require hysteresis and a minimum healthy cooldown to avoid oscillation.
The exact windows and values must come from stress tests. Heracles supports the
general approach—feedback and isolation protecting a latency-critical workload
while using spare capacity for best-effort work—but its reported results depend
on Google hardware, workloads, and offline profiling and do not transfer as
Kestrel numbers ([Heracles, ISCA
2015](https://research.google.com/pubs/archive/43792.pdf)).

### 6. Make failures local and legible

- Memory pressure crossing `memory.high`: record the event and enter Guarded;
  do not call the job failed solely from a transient crossing.
- Per-job cgroup OOM: terminate the indivisible job subtree, classify it as
  `ResourceEnvelopeExceeded(memory)`, preserve durable Agent Run/Review state,
  and do not start another job until the circuit is healthy.
- PID limit: report process exhaustion for that job; the control plane and other
  jobs remain alive.
- CPU or I/O saturation: throttle and queue first; terminate only for an
  explicit no-progress/latency policy.
- Disk quota: surface `ResourceEnvelopeExceeded(disk)` before global free space
  is threatened. Logs and partial artifacts must not consume the durable-data
  reserve.
- Supervisor restart: reconcile every live cgroup, process, commitment, quota,
  and queued job before reopening admissions. Limits must fail closed.
- Any workload-triggered global OOM, control-plane kill, durable-store
  corruption, or loss of PWA reachability is a benchmark failure, even if the
  job eventually completes.

## Reproducible benchmark and experiment plan

This is the handoff to **Benchmark the runtime boundaries and implementation
languages**. It deliberately defines experiments before setting values.

### Questions the benchmark must answer

1. What is the control plane's idle and burst working set, and what protected
   memory floor keeps it responsive without causing host OOM behavior?
2. What aggregate CPU and I/O workload caps preserve the agreed PWA/API tail
   latency under sustained and bursty contention?
3. Which cold-start envelopes safely cover each initial Review and Agent Run
   class, and which workload properties improve the estimate?
4. Which workload mixes fit concurrently, and how much throughput is gained
   over static one-slot execution?
5. How early do PSI and controller events detect harmful pressure, and how much
   recovery time does Guarded/Containment need?
6. Does each candidate runtime expose the required hierarchy, accounting,
   failure identity, cleanup, and rehydration semantics at acceptable overhead?

### Fixed environment and recorded controls

Run on the actual supported 4-shared-vCPU/8-GB/75-GB reference VPS, not only a
developer laptop. Record for every trial:

- provider/product/region and time of day;
- guest CPU model, `/proc/stat` steal time, RAM, swap, block device, and mount
  topology;
- OS image, exact kernel, cgroup mode/controllers, filesystem, block scheduler,
  quota capability, and relevant sysctls;
- Kestrel commit, runtime/language candidate, compiler/runtime flags, and
  resource-policy version;
- repository commit, dependency lockfiles, fixture seed, cache state, and job
  profile; and
- every controller value actually read back after configuration.

Use a clean machine snapshot. Keep OS services, durable data, probe load, and
network policy constant across candidates. Randomize candidate order to reduce
time-of-day and shared-host bias.

For host-boundary experiments, replace the remote Model Provider with a
deterministic recorded-response server and fixed tool-call trace. This removes
provider latency and response variability without introducing local inference.
Run a smaller end-to-end provider smoke suite separately; do not mix its timing
into host resource comparisons.

### Corpus and workload classes

Use both real pinned repositories and synthetic adversarial workloads.

**Repository corpus:** at least 15 immutable repositories: small, medium, and
large representatives across at least five materially different toolchain
families. Include a monorepo, a repository with many small files, one with large
generated/source artifacts, and one whose tests/builds create many processes.
Do not train and validate a profile on the same repository.

**Conceptual Review classes:**

- small, medium, and large base/head changes;
- cold acquisition/index and warm retained-index paths;
- many-small-file and few-large-file variants;
- parser-unsupported and deliberately malformed inputs; and
- concurrent review mixtures over distinct Projects.

**Agent Run classes:**

- inspect and edit with a small targeted test;
- full compile plus unit tests;
- large test suite with bounded internal parallelism;
- dependency/cache population on a cold Sandbox;
- CPU-bound compile or static analysis;
- memory-ramping and short memory-burst phases;
- I/O-heavy checkout/build/logging;
- high-thread/process test runner; and
- Human Gate freeze, hibernate, rehydrate, cancel, and cleanup.

**Adversarial controls:** fixed CPU burner, gradual leak, sudden allocator,
reclaim/thrashing workload, fork bomb, I/O saturator, disk/inode filler, log
storm, and a process attempting to escape or change its controls. These are
test fixtures, never ordinary Project code.

### Experiment phases

1. **Capability audit:** prove controller availability, hierarchy containment,
   quota enforcement, read-back, event delivery, and atomic job placement.
2. **Baselines:** OS-only idle; Kestrel idle; one unconstrained fixture; one
   controlled fixture. Measure at least 30 minutes after warm-up.
3. **Single-workload characterization:** each corpus case cold and warm, with
   no competing job, to capture phases and peaks rather than only whole-run
   averages.
4. **Concurrency matrix:** homogeneous and mixed pairs, then increasing
   parallelism up to and beyond the configured ceiling while the PWA/API probe
   runs continuously. Include review+review, review+Agent Run, CPU+memory,
   CPU+I/O, and burst-correlated pairs.
5. **Admission replay:** feed recorded job profiles and arrivals through static
   slots, instantaneous-free-resource, conservative-envelope, and recommended
   hybrid policies. Compare completions, queue wait, utilization, local OOMs,
   and control-plane SLO violations.
6. **Failure injection:** cross each hard/soft controller boundary, exhaust swap,
   fill Sandbox quota, crash the workload supervisor, reboot the guest, and
   interrupt cleanup/rehydration. Verify durable-state recovery and closed
   admissions during reconciliation.
7. **Soak and drift:** at least 24 hours with bursty arrivals, cache turnover,
   repeated Projects, revision changes, and injected shared-host variability.
   Confirm that history helps stable classes but resets conservatively on drift.

### Telemetry

Sample at one-second resolution where supported and retain event timestamps at
native precision:

- system, control-plane, workload-pool, and per-job CPU/memory/I/O PSI;
- `cpu.stat` usage, throttled periods/time, host utilization, run queue, and
  guest steal time;
- `memory.current`, `memory.peak`, `memory.stat`, `memory.events(.local)`, swap
  current/peak/events, and global OOM records;
- `io.stat`, read/write throughput/IOPS, throttling/delay, and device latency;
- `pids.current`, `pids.peak`, and PID-limit events;
- filesystem bytes/inodes, per-Sandbox quota, durable-volume free reserve, log
  and artifact growth;
- PWA/API synthetic transaction success and p50/p95/p99 latency, scheduler and
  durable-store latency, event-loop/worker lag where applicable;
- queue length, queue reason, admission decision inputs, start delay, job
  duration, phase, progress, exit/failure classification, and cleanup time; and
- Sandbox freeze/hibernate/rehydration latency and residual resources.

Correlate every point to Installation, policy version, job, Project/revision,
runtime candidate, and monotonic timestamp. A dashboard without raw export is
not reproducible evidence.

### Repetitions and statistical controls

- Run every normal single-workload and concurrency case at least ten times,
  randomized across at least three fresh host boots and multiple time windows.
- Run every destructive failure case at least five times after restoring the
  same snapshot.
- Separate cold and warm cache results; do not average them together.
- Report distributions and confidence intervals, not only means. Preserve
  outliers and correlate them with steal time, pressure, and controller events.
- Use a declared warm-up period and fixed measurement interval. Do not discard a
  run because it OOMed or violated latency; that is the outcome under study.
- Keep an untouched holdout set of repositories and workload mixes for the
  final admission-policy evaluation.

### Acceptance tests

The mechanism contract passes only if all of these hold:

1. Every workload process remains in the intended job subtree, and child
   configuration cannot escape aggregate controls.
2. A CPU burner cannot make the control-plane probe violate the responsiveness
   SLO established by the availability-envelope ticket under the certified
   policy.
3. Per-job memory OOM, PID exhaustion, and disk quota failure leave the control
   plane and unrelated jobs alive and produce the correct durable failure
   classification.
4. No workload trial triggers global OOM, loss of durable state, or global disk
   exhaustion. Those are hard failures, not tolerated percentiles.
5. Jobs beyond the Operator ceiling or any commitment stay queued, and the
   recorded reason exactly matches the admission inputs.
6. A Guarded transition stops admissions within the calibrated reaction bound;
   a Containment action restores the control-plane SLO within its recovery
   objective.
7. A frozen job remains fully charged for memory/PIDs/disk; a hibernated job is
   not released until teardown is confirmed and resumes from durable state.
8. Supervisor restart and host reboot reconcile live/queued jobs before opening
   admission and do not silently relax limits.
9. The runtime/language candidate's own idle and per-job overhead fit the final
   envelope measured by the parent ticket.

Numerical PWA/API latency, recovery time, and allowed local job-failure targets
must be supplied by the availability-envelope decision. This research cannot
derive them honestly from unrelated systems.

### Calibrating without overfitting

Start with the simplest profile that passes the acceptance suite:

1. Derive cold-start envelopes from the training corpus by workload class and
   resource, using a high-tail statistic plus an explicit uncertainty margin.
   Select the statistic and margin against the accepted failure/latency target;
   do not choose a percentile because another platform used it.
2. Validate with leave-one-repository-out tests, then once on the untouched
   holdout corpus. Report false-safe admissions, conservative queueing, and
   utilization separately.
3. Version profiles by policy, runtime, Project/toolchain fingerprint, and host
   class. Material drift resets to the conservative class default.
4. Increase an envelope quickly after higher observed demand; shrink only after
   multiple comparable healthy runs. Never learn a “safe peak” from an OOM- or
   quota-censored trial.
5. Tune CPU/I/O feedback against control-plane tail latency and PSI. Tune memory
   against zero global failures plus the agreed rate of contained job failure.
6. Re-run the holdout and failure suite after every threshold or controller
   change. Prefer conservative moving-window/high-water logic until local data
   demonstrates that a more complex model adds value out of sample.

## Downstream decisions and map impact

This evidence is enough for the availability-envelope ticket to decide the
**policy shape**:

- reference host remains 4 shared vCPU, 8 GB RAM, 75 GB NVMe;
- parallelism is configurable and queued, never hard-coded to one;
- control-plane protection and non-overcommitted memory/disk commitments take
  precedence over the requested parallelism;
- CPU/I/O are shared adaptively under aggregate limits and a responsiveness
  circuit breaker; and
- numeric budgets remain benchmark outputs, not estimates disguised as facts.

No new Wayfinder ticket is required. The newly sharp Human Gate distinction is
already inside **Define the built-in coding-agent execution loop** and **Choose
the disposable Sandbox isolation and repository execution model**: they must
decide freeze versus hibernate/rehydration and the durable state required to
release a Sandbox's RAM safely. **Benchmark the runtime boundaries and
implementation languages** owns the experiment plan above.

## Research limitations

- Kestrel does not yet have a measured implementation, so this note contains no
  defensible numeric reserve, threshold, or concurrency default.
- Kernel interface semantics were checked against the versioned Linux 6.16
  documentation on 2026-08-12. The certified OS image may ship a different
  kernel/configuration, which must be audited and tested.
- Cgroup memory accounting is documented as comprehensive but not perfectly
  water-tight; I/O controls and writeback attribution depend on the block and
  filesystem stack.
- A shared-vCPU VPS adds provider-side scheduling and noisy-neighbor behavior
  that guest cgroups cannot control. Repetition and guest steal-time telemetry
  can characterize, not eliminate, that uncertainty.
- Borg, Autopilot, Resource Central, Heracles, Resource Containers, and SEDA are
  primary peer-reviewed systems evidence, but their scale, workloads, failure
  tolerance, and hardware differ materially from one single-Operator Kestrel
  Installation. Their mechanisms and cautions inform the experiments; their
  reported numbers are not Kestrel defaults.
- Disk retention beyond the admission, quota, and emergency-reserve boundary is
  owned by the availability/retention decisions and is intentionally not
  specified here.
