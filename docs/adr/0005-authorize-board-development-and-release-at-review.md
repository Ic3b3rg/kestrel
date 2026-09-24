# Authorize issue development from the board and release the Project at review

Status: Accepted — 2026-09-24, by explicit Operator confirmation in conversation.

An explicit Start action or To do → In progress drop authorizes development of an open issue
carrying the Project's configured ready label (default `ready-for-agent`). It is a Run Trigger, not
a cosmetic column edit. It records the Operator and an idempotent request before work begins.

Queued work reads the current issue description and conversation at dispatch and retains that
observation. Kestrel derives a bounded operational plan and enters the existing execution and review
workflow without another approval dialog. Missing consequential requirements remain a human
decision. Provider polling, labels alone and later comments never grant new execution authority.

There is one writable implementation per Project, rather than one Feature throughout its entire
lifecycle. Entering In review releases the next queued issue without waiting for merge. Existing
writer reservations and teardown remain authoritative; review does not permit concurrent writes.
Independent Feature branches can wait for review, and only confirmed integration completes them.

This changes the approval and Project serialization choices in ADR 0004. The trade-off is quicker
flow and less repeated approval in return for relying on the explicitly configured ready label and
the issue content current at dispatch. GitHub remains the only supported tracker; parallel writable
sessions and other providers are separate future decisions. Host custody of credentials, isolated
execution, exact-revision review and explicit merge authority remain in force.

See [the approved behavior](../factory-v01/project-board-workflow.md).
