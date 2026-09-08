# Final Feature verification

After every approved Work Item has verified its own implementation and released its execution
environments, Kestrel verifies the cumulative Feature revision. Work Item success remains historical
evidence; a later Work Item can change behavior checked by an earlier one.

The execution view separates **Final Feature verification** from individual attempts. It shows the
current pass, recorded and passing checks, command origins and exact revision. Selecting a final
attempt opens the retained command results. An immutable final verification record appears only
after all approved checks pass on one revision and every associated environment has stopped.
Cancellation controls the current status while preserving that record for inspection.

## Frozen inputs and execution

The existing scheduler reserves a `feature_verification` execution for the Feature, with no Work
Item identity. It retains the approved plan version, actual workspace source, initial base/head/tree
and branch, and an ordered verification manifest. Commands are deduplicated only when program,
argument vector, working directory and timeout all match. Every original Work Item key and command
position remains attached to its manifest entry.

The initial pass runs checks before requesting a model. A failed pass can receive at most two
technical repair turns within the approved scope and original attempt deadline. Each repair uses the
existing isolated runtime, records a new checkpoint and reruns the entire manifest. Earlier results
remain readable but cannot count toward the new revision's progress or final record. Unresolved
failures become a concrete Human Gate; published conceptual-review findings belong to the later
review phase and do not enter this repair loop.

The per-Work Item bounds remain 12 commands, 36 results and 39 execution environments. Final
verification supports at most 480 distinct commands, 1,440 results and 1,442 environments across its
three passes and two repair turns. Recovery processes bounded batches of pending environments, so a
large stopped history cannot hide a still-running environment.

## Durable evidence and authority

`factory_feature_verifications` retains the Feature, approved version, owning run, source identity,
exact revision, manifest and its SHA-256 digest, and ordered evidence IDs. The record is inserted
transactionally with final success and reservation release. Missing, failed, mismatched or
incomplete results and uncertain teardown cannot produce a record. The runtime database role can
append and read certification history but cannot rewrite it.

Historic Work Item runs with a SQL NULL source keep that value. Eligibility requires their retained
checkpoints to share the actual workspace's immutable base and branch; runs with a recorded source
must also match its repository and identity. The final attempt binds the actual retained workspace.
Missing or inconsistent proof is an explicit blocker and cannot silently select a new source.

A final-verification gate preserves the original purpose, manifest, source and approved version. One
accepted answer can create one successor final attempt. It does not replay verified Work Items,
change the plan, release an environment without stop evidence, or authorize a provider write.

Verification leaves Work Items **In review** and the Feature active in its Project. The cumulative
PR, conceptual review and explicit merge consume this evidence in subsequent steps; certification
alone does not publish, merge, close issues or start the next Feature in the same Project.

## Public entry points

The existing authenticated `.../features/:featureId/execution` response includes
`finalVerification: { runs, certificate, progress }`. The existing run detail and Human Gate routes
carry the final purpose and nullable Work Item identity. Browser closure does not cancel accepted
verification; workstation interruption follows the same durable ownership and recovery rules as
implementation.
