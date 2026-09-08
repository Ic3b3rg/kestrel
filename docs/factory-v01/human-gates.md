# Human Gates and recovery

A Feature holds its Project queue from approval through review. Other Projects may execute
concurrently, up to the approved limit (two by default). The queue uses persisted approval order and
verified Work Item dependencies. GitHub labels do not grant execution authority.

When execution needs a decision, the Work Item returns to **To do**. Its card shows the concrete
question; **Execution** shows the reason, approved plan version, previous attempts and captured
verification output. Kestrel releases the execution slot after confirming that the previous
environment has stopped. The paused Feature still blocks later Features in that Project.

## Answering a gate

Choose **Continue within the approved plan** to clarify the technical choice or confirm that the
reported cause has been resolved. **Save answer and resume** saves an immutable answer and
authorizes one successor attempt of the affected Work Item. Repeated delivery of the same request
does not create more attempts. A different answer, stale gate or mismatched approved version
requires a fresh read; the previous decision cannot be overwritten.

The successor receives the original question and answer in a fresh execution context. It retains the
approved source identity, requirements, checks and limits. Verified Work Items are not replayed;
their dependents become eligible in order. Browser closure does not cancel accepted work.

Choose **Requirements or authorized limits must change** to record a scope change. This grants no
new execution authority. The current implementation keeps that Feature paused: cancel it and start a
new plan containing the required changes, then approve that plan. Editing an already approved plan
in place and transferring its partial workspace into a replacement plan are not supported by this
slice.

## Stopping and restarting

**Cancel feature**, in the plan view, stops active work and preserves its plans, messages, attempts
and evidence. Until teardown is confirmed, the UI reports a pending stop and the Project reservation
remains held. A cancellation racing completion cannot authorize another writer.

An expired heartbeat fences the abandoned attempt; it never proves that its execution environment is
stopped. Recovery inspects only persisted Kestrel execution environment identities. Confirmed
teardown can release the reservation and expose the retained Human Gate. An unavailable Docker
service or an unverifiable container identity keeps the reservation held. No recovery operation
silently restarts model execution or repeats an external write.

New attempts persist the Docker Engine identity before creating an environment. Recovery checks that
identity as well as the full container ID, name and ownership label; changing Docker contexts does
not count as stopping the original environment. A retained ID already absent from the same recorded
Engine can be reconciled after a crash between removal and recording teardown. Legacy records
without Engine provenance require an inspectable matching environment. A reserved name without a
discovered ID remains uncertain because an earlier create may still finish.

Source or revision uncertainty cannot be overridden by a text answer. The retained workspace must
still match its recorded checkpoint before a successor runtime is started. Authentication, usage,
verification, permission and environment failures remain distinct; a retry does not switch to a paid
model route.

## Public operations

- `GET /api/v1/projects/:projectId/features/:featureId/execution` includes the current gate.
- `GET .../execution/runs/:runId` includes the attempt's retained question and answer.
- `GET .../execution/gates/:gateId` reads a gate and its current resumption eligibility.
- `POST .../execution/gates/:gateId/resolve` accepts a UUID request identity, exact approved plan
  version, explicit decision and a nonempty answer up to 4,000 characters. Authentication, origin
  and CSRF protections apply.

Gate identity and question are immutable. The database runtime role can update only the resolution
fields, and the Feature transaction lock ensures one recorded decision and one successor attempt.
