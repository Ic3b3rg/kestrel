# Support provider-backed and local Change Proposals

Status: Superseded for Review First V1 by [ADR 0002](./0002-make-review-first-v1-local-first.md).

Review First V1 must serve both public open-source work and private organizational work whose
policies may forbid third-party provider integration. A Project therefore declares Repository Access
through public provider data, an authorized Repository Provider Connection, or a read-only Local
Repository Source; every route feeds the same immutable Review Revision and Conceptual Review
contract, while unavailable provider state and Provider Review Input are explicitly not applicable.
Kestrel never updates or deletes the Operator's local repository, and remains self-hosted rather
than depending on a Kestrel cloud service.
