# Own Sandbox custody with the Agent Run

Status: Accepted — 2026-09-23, implementing the approved architecture review.

ADR 0004 already assigns execution authority to Kestrel and one cumulative checkout to each Feature.
An Agent Run now obtains that checkout through a Sandbox lifecycle module. The processor owns plan
policy, prompts, bounded repair decisions and Human Gate questions. The Sandbox owns source
identity, private paths, container intent, identity and stop witnesses, checkpoint ordering, and
exact-revision verification. The existing local-source and contained runtime implementations remain
its adapters.

A Sandbox is a per-attempt session. Its public results contain revision facts and bounded evidence,
never host paths or container callbacks. Only one operation may use its writer at a time. A stopped
implementation may be checkpointed only after the processor has accepted its structured completion.
Each verification command gets a separate disposable container; every repair invalidates earlier
check results.

PostgreSQL remains authoritative. Container intent commits before creation; exact identity commits
before teardown; confirmed teardown precedes checkpoint and release. Cancellation denies successful
completion but does not bypass teardown. Unknown write responses, unknown daemon identity and
uncertain teardown retain the fence. Recovery uses the persisted reservation and identity, never
replays implementation, and converges idempotently through the same ledger rules. Known absence
requires the existing inert name barrier on the same daemon, not merely a failed lookup.

A bag of workspace/container helper functions was rejected because it leaves order and fencing in
each processor. A generic lifecycle engine was rejected because it would conflate scheduling, Human
Gates, review and execution authority. Moving the Factory to a separate worker is not required to
establish this ownership.

The Codex adapter retains native agent-loop ownership, while Kestrel retains outer containment.
Planning and review can reuse transport or teardown mechanisms without acquiring a writable Sandbox.
No schema migration or additional workflow authority is implied by this decision.

See [the delivery specification](../architecture-deepening/spec.md), ADRs 0003/0004, and the
existing [execution contract](../research/factory-execution-runtime-contract.md).
