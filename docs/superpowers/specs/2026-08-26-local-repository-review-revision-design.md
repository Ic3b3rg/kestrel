# Local Repository Source and Review Revision design

Status: design approved in chat; written review pending

Date: 2026-08-26

Issue:
[#90 — V1 local-first 01: Retain an exact change from a local repository](https://github.com/Ic3b3rg/kestrel/issues/90)

Parent contract:
[#33 — Specify Kestrel Review First V1 local-first implementation contract](https://github.com/Ic3b3rg/kestrel/issues/33)

## Purpose

Deliver Kestrel's first authoritative source path. An authenticated Operator selects a Git
repository beneath an explicitly configured read-only root, selects committed base and head
references, supplies or confirms Change Intent, and asks Kestrel to retain the exact source as an
immutable Review Revision.

The retained source remains usable after the Operator's repository is detached or removed. Public
GitHub metadata from issue #89 may enrich the same Project and Change Proposal, but it never
supplies source and is not required for this flow.

## Scope

This ticket includes:

- strict startup configuration for authorized repository roots, the Git executable, the
  Kestrel-owned artifact root, and revision size limits;
- bounded discovery of Git repositories beneath those roots without accepting browser-supplied
  filesystem paths;
- bounded discovery and resolution of committed references;
- repository identity, path, object-type, object-identity, object-closure, and size verification;
- content-addressed, project-scoped retention of exact commit, tree, and blob objects;
- atomic lifecycle persistence for Local Repository Source, Change Intent, Change Proposal, and
  Review Revision;
- reuse of an exact matching public GitHub Change Proposal rather than a second review path;
- one primary PWA flow named “Open local repository”;
- contract, unit, integration, containment, black-box, and browser evidence.

This ticket does not fetch missing objects, read private provider metadata through `gh`, start a
Review Workflow, configure model access, run source code, materialize a checkout, delete Projects,
or provide a general source browser. Those capabilities remain in later tickets.

## Architectural choice

Retain a Kestrel-owned content-addressed snapshot rather than copying the entire repository or
creating an archive of checked-out files.

The snapshot contains the raw selected commit objects, every tree and blob needed to materialize
their base and head trees, and a validated manifest that records paths, modes, object types, sizes,
and object IDs. Kestrel independently hashes every retained object using the repository's declared
Git object format. The artifact therefore preserves exact Git identity without retaining unrelated
branches and history, invoking checkout behavior, or trusting the working tree.

For this tracer bullet, “required object closure” means each selected commit object plus the
transitive tree and blob objects needed to materialize that commit's exact source tree. Ancestor
commit history is deliberately excluded: it is not required to reconstruct base or head and would
turn a bounded two-tree snapshot into retention of an unrelated repository history.

Rejected alternatives:

- Copying or cloning a complete bare repository retains unrelated history and may cross the
  configured size boundary. Local clone/upload-pack behavior also creates a wider command and
  configuration surface than this tracer bullet requires.
- Exporting two tar archives preserves file bytes but not the exact commit/tree/blob identity or a
  verifiable Git object closure.
- Retaining a diff cannot reconstruct either exact tree and would make later evidence depend on the
  source repository still being present.

The new `packages/local-source` workspace owns repository discovery, fixed Git inspection, artifact
retention, and artifact reads behind a narrow TypeScript interface. The web application coordinates
that module with database state; browser and database code never receive an arbitrary local path.

## Installation configuration

The web process reads and validates these values before listening:

- `LOCAL_REPOSITORY_ROOTS`: a JSON array of absolute directory paths. An empty array disables local
  repository discovery safely. Duplicate or nested canonical roots are rejected.
- `LOCAL_GIT_EXECUTABLE`: an absolute path to the supported Git executable. PATH lookup is not used
  by the acquisition process.
- `ARTIFACT_ROOT`: an absolute path to a Kestrel-owned directory outside every repository root.
- `REVIEW_REVISION_MAX_BYTES`: maximum total raw bytes across unique retained objects.
- `REVIEW_REVISION_MAX_OBJECTS`: maximum unique commit, tree, and blob object count.

Product constants additionally bound repository scan depth, directory entries, discovered
repositories, reference count, reference-name length, tree entries, path bytes, Git output, and
subprocess duration. They are certification limits rather than Operator-tunable review behavior.

At startup Kestrel canonicalizes each root and the artifact root with `realpath`, verifies their
types, rejects overlap, and gives every repository root an opaque stable identifier. The default
configuration authorizes no repository. Documentation shows a native workstation start and never
mounts an Operator home directory, Keychain, SSH agent, Docker socket, or provider configuration.

## Repository discovery and identity

Discovery recursively reads directory metadata beneath the configured roots with Node filesystem
APIs. It does not follow symlinks. It stops at configured depth and entry limits, does not descend
into a discovered repository, and reports only bounded display labels plus opaque repository IDs.
Absolute paths and root paths are never returned to the PWA.

Before every operation, Kestrel resolves the opaque ID through a fresh server-side discovery,
canonicalizes the selected directory again, and proves that it remains inside its configured root.
The browser cannot submit a path, Git directory, command, revision expression, or artifact path.

Fixed Git inspection resolves the repository work tree, Git directory, common Git directory, and
object format. Every resolved source path must remain within the selected authorized root. Git
worktrees or alternates whose administrative or object directories escape that root fail closed.
Symlinks in committed trees are retained as blob data and never followed. Gitlinks are recorded as
entries but are not traversed or fetched.

The Local Repository Source identity combines the canonical common Git directory and Git object
format into a versioned SHA-256 identifier. Separate clones are separate local sources. When a
canonical GitHub remote can be parsed from local configuration without includes, it is retained only
as optional provider-matching metadata; credentials, query strings, and unsupported hosts are
discarded. A matching provider identity never replaces the local source identity.

## Fixed Git inspection boundary

All Git calls use `spawn` with `shell: false`, the configured absolute executable, fixed argument
vectors, closed stdin unless a bounded object batch is required, bounded stdout and stderr, a hard
timeout, and process-group teardown. The child environment is allowlisted and disables system and
global Git configuration, terminal prompts, optional locks, replacement objects, pagers, and
credential interaction. Source stderr is not returned to the Operator.

The allowlist contains only the read operations needed to:

1. verify repository and administrative paths and determine the object format;
2. enumerate bounded local heads, remote-tracking refs, tags, and `HEAD`;
3. resolve one enumerated reference to a commit object ID;
4. inspect raw commit, tree, and blob objects;
5. enumerate the complete base and head trees.

References sent by the browser must be values from the server-provided reference inventory. Kestrel
resolves each with end-of-options handling, verifies the resolved object type is `commit`, records
the exact base and head object IDs, and only then begins acquisition. No command invokes fetch,
pull, checkout, archive, clone, upload-pack, hooks, filters, credential helpers, SSH, provider APIs,
builds, tests, or repository-defined commands.

## Snapshot verification and retention

Acquisition performs the following bounded sequence:

1. Revalidate repository identity and resolve the selected base and head references.
2. Persist or reuse the Project, Change Proposal, Change Intent version, Local Repository Source,
   and a Review Revision in `acquiring` state with exact base/head object IDs.
3. Enumerate both trees, rejecting absolute paths, empty segments, `.` or `..` segments, NUL bytes,
   unsupported modes or types, duplicate paths, excessive path lengths, excessive counts, missing
   objects, and inconsistent object IDs.
4. Read every unique required raw object. Before writing, validate its declared type and size and
   enforce total object and byte limits. Recompute the Git object ID from `<type> <size>\0<content>`
   using SHA-1 or SHA-256 as declared by the repository.
5. Write unique object bytes and a canonical manifest into a mode-0700 staging directory beneath
   `ARTIFACT_ROOT/projects/<project-id>/revisions/`. Files are created exclusively with restrictive
   permissions and no symlink following.
6. Reopen and verify the complete staging artifact, compute its manifest digest, fsync files and
   directories, make retained files read-only, and atomically rename it to the immutable revision
   directory.
7. In one database transaction, mark the Review Revision `available`, record its relative artifact
   locator and digest, update Project source availability, and append a minimized audit record.

The final artifact contains no mutable ref name as authority: refs remain snapshots for display,
while exact object IDs identify the Review Revision. Working-tree, index, staged, ignored, and
untracked content are never consulted.

Artifact reads accept a Review Revision ID, side (`base` or `head`), and validated
repository-relative path. They resolve the path through the manifest and read the content-addressed
blob; they never join an untrusted path onto the artifact root. Revalidation of the object hash
detects artifact corruption. This public module seam proves the snapshot remains readable when the
source root no longer exists.

If acquisition fails, Kestrel removes only the explicitly resolved staging directory, records the
Revision State as `unavailable` with a bounded reason code, and exposes no artifact locator. It
never changes or deletes the Operator repository. Startup reconciliation removes abandoned staging
directories and marks stale `acquiring` revisions unavailable; finalized but unreferenced artifacts
are quarantined for later retention handling rather than guessed at or attached automatically.

## Durable data model

A migration generalizes the provider-first schema introduced by #89 without creating public and
private review modes.

### `projects`

Provider observation columns become optional. A Project may have local source, provider metadata, or
both. Existing public GitHub identity uniqueness remains in force when provider columns are present.

### `local_repository_sources`

Stores one current local source attachment per Project:

- UUID identity and Installation/Project foreign keys;
- versioned source identity;
- configured root identifier and repository-relative path, never a browser-provided path;
- Git object format and optional sanitized GitHub repository identity;
- attachment state and timestamps.

The root-relative locator is operational configuration, not Review Revision identity. Losing or
changing the root marks the source detached but does not affect retained artifacts.

### `change_proposals`

Provider identifiers become nullable and a constrained proposal kind distinguishes local proposals
from provider-observed proposals. A local proposal has a stable identity derived from Project plus
exact base/head object IDs. Provider-observed proposals retain their existing unique provider
identity. Both variants share the same Change Proposal contract and Review Revision path.

### `change_intents`

Stores append-only, Operator-authored versions associated with one Change Proposal. This ticket
creates or confirms a non-empty first/current version; commit messages may be returned separately as
suggestions but are never accepted as intent without the Operator submitting the text.

### `review_revisions`

Stores the immutable Project/Change Proposal/Local Repository Source association, selected ref
snapshots, exact base/head object IDs, object format, Revision State, configured limits, artifact
locator and digest, failure reason, and timestamps. A unique exact-revision key makes repeated and
concurrent requests idempotent. Available identity is never updated or retargeted.

A repeated available request returns the existing result. A concurrent request observing `acquiring`
returns `409 REVISION_ACQUIRING`; an unavailable exact revision may be explicitly retried through
the same command while preserving its identity and audit history.

## Public contracts and HTTP flow

All routes require the authenticated Operator. Mutation routes retain the existing same-origin and
CSRF controls.

### `GET /api/v1/local-repository-sources`

Returns the bounded repository inventory as opaque IDs, display labels, and attachment status. It
never returns an absolute path.

### `GET /api/v1/local-repository-sources/:repositoryId/references`

Returns a bounded inventory of selectable committed references with display name, kind, and current
commit object ID. An unknown, stale, escaped, or invalid repository ID fails closed.

### `POST /api/v1/review-revisions`

Accepts only:

- an opaque `repositoryId`;
- one base and one head reference selected from the inventory;
- non-empty Operator-confirmed Change Intent;
- an optional existing Change Proposal ID selected from the current inbox.

The server independently resolves repository and proposal identity. If the selected repository's
sanitized GitHub identity and exact commits match one #89 proposal, Kestrel attaches the retained
source to it even when the optional proposal ID is absent. An explicit proposal ID that does not
match repository and exact commits is rejected. Without a match, Kestrel creates or reuses one local
Change Proposal.

Success returns the affected Project, Local Repository Source, Change Proposal, Change Intent
version, and available Review Revision. Expected discovery, validation, size, missing-object,
conflict, and containment failures use the existing versioned `ApiError` envelope with stable reason
codes and no local path or Git stderr.

### `GET /api/v1/projects`

The inbox contract is generalized so every Project exposes four separate facts:

- Local Repository Source: attached, detached, or absent;
- optional Provider Observation metadata;
- latest Revision State and exact base/head identity when present;
- Model Access Availability, which remains `not_configured` in this ticket.

The existing public GitHub command remains available as supporting Provider Observation behavior. It
can enrich a Project but cannot set source availability to available.

## PWA experience

“Open local repository” is the primary Project entry. The authenticated flow contains:

1. a repository select populated only by the authorized inventory;
2. base and head selects populated by the selected repository's reference inventory;
3. a Change Intent text area, optionally seeded with a clearly labelled commit-message suggestion;
4. a confirmation summary showing repository label and exact commit IDs;
5. one submit action that remains pending until retention succeeds or fails.

The public GitHub URL form remains secondary and is described as optional provider context, not a
public review mode. Project cards render Local Repository Source, provider metadata, Revision State,
and model access in separate labelled rows. No source, absolute path, object content, or
authoritative application state is placed in browser storage.

The new controls use semantic labels and fieldsets, keyboard-operable native selects, visible focus,
textual status in addition to color, a polite announcement region, and actionable loading, empty,
detached, conflict, limit, and failure states. Existing responsive and reduced-motion guarantees
remain.

## Test strategy

Tests remain behavior-focused at four agreed seams.

### Contract seam

- strict repository inventory, reference inventory, retain command, Review Revision, generalized
  Project, and error schemas;
- generated JSON Schema and OpenAPI parity;
- separation of local source, provider metadata, Revision State, and model access.

### Local source and containment seam

- discovery accepts only canonical repositories beneath configured roots and rejects symlink,
  worktree-admin, alternates, and traversal escapes;
- exact refs resolve to commits and mutable ref movement after acquisition cannot retarget a Review
  Revision;
- dirty, staged, ignored, and untracked content is absent from retained manifests;
- retained base/head files remain readable after the source root is renamed or removed;
- missing objects, corrupt objects, unsafe tree paths, unsupported types, excessive count/bytes,
  timeout, truncated output, and hash mismatch fail without a final artifact;
- a recording Git boundary proves only allowlisted argument vectors and sanitized environment are
  used, while canary hooks, filters, credential helpers, SSH variables, provider clients, builds,
  and tests are never invoked;
- source repository metadata and content remain byte-for-byte unchanged.

Test setup may create committed fixture repositories; product acquisition never runs setup or
repository-defined commands.

### Database and HTTP seam

- exact revision state is recorded before acquisition and becomes available only after atomic
  artifact publication;
- local Project/proposal creation, public GitHub attachment, retries, concurrency, and repeated
  requests are idempotent;
- failure and restart reconciliation expose no partially usable revision;
- authentication, CSRF, payload limits, stable errors, and absence of local path leakage hold.

### Black-box and PWA seam

- a read-only mounted fixture repository completes the repository-to-inbox flow;
- detaching the fixture after acquisition does not affect artifact reads;
- root escape and configured size limits fail visibly;
- browser tests prove the primary entry, reference selection, Change Intent confirmation, pending
  state, separated facts, retry, keyboard use, responsive layout, and accessibility checks.

## Observability and audit

Structured logs record bounded event names, correlation ID, Project/Revision IDs, state, duration,
object count, and byte count. They never record absolute repository paths, refs supplied outside the
validated inventory, Git stderr, object content, environment, remote credentials, or Change Intent
text.

Minimized audit records cover source attachment, acquisition success/failure, and retry with actor,
target, outcome, configured profile, and bounded reason. Retained source and Change Intent are not
copied into the Installation audit.

## Documentation and rollout

README documentation adds:

- native workstation configuration and startup;
- explicit examples for repository roots, Git executable, artifact root, and limits;
- the no-network/no-mutation acquisition contract;
- how detached sources differ from retained Review Revisions;
- recovery behavior and test commands.

The default configuration authorizes no repository, so upgrading an existing Installation cannot
expose local source accidentally. Database changes are additive or nullable generalizations and keep
existing #89 data valid. No feature flag is required because the PWA flow is inert until roots are
explicitly configured.

## Acceptance mapping

The design maps the issue requirements as follows:

- explicit roots and opaque IDs prevent arbitrary browser path authority;
- one generalized Project model and primary local entry prevent public/private modes;
- reference inventory plus independent resolution records exact commit IDs before acquisition;
- raw object validation, safe tree paths, closure traversal, independent hashing, and fixed limits
  gate `available`;
- project-scoped immutable artifacts survive source detachment;
- raw object reads exclude all working-tree and index state;
- the fixed Git boundary excludes network, credentials, execution, hooks, and source writes;
- staging plus atomic publication and explicit unavailable state prevent partial artifacts;
- Operator-submitted Change Intent is durable and commit text remains only a suggestion;
- sanitized repository identity plus exact OID comparison attaches matching #89 proposals;
- the Project contract and PWA render local source, provider metadata, revision, and model access
  separately;
- the four test seams provide contract, integration, containment, and PWA evidence.
