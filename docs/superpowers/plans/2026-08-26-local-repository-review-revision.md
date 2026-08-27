# Local Repository Review Revision Implementation Plan

> **Implementation workflow:** Execute this plan with the repository `$implement` skill and finish
> with its required `$code-review` pass. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver issue #90's authenticated local-first path from an authorized read-only Git
repository to an immutable, project-scoped, exact Review Revision that remains usable after its
source disappears.

**Architecture:** Add a dependency-free `@kestrel/local-source` boundary for bounded repository
discovery, fixed Git plumbing, verification, and content-addressed artifact retention. Fastify
coordinates that boundary with PostgreSQL lifecycle records; versioned Zod contracts keep the PWA
free of filesystem paths and command surfaces. Existing public GitHub observations remain optional
metadata on the same Project and matching Change Proposal.

**Tech Stack:** Node 24, TypeScript 6 strict mode, Git 2.45+ plumbing, Fastify 5, React 19/Vite 8,
Zod 4, PostgreSQL 18, Vitest 4, Playwright 1.62, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-26-local-repository-review-revision-design.md`

**Ticket:**
[#90 — Retain an exact change from a local repository](https://github.com/Ic3b3rg/kestrel/issues/90)

## Global Constraints

- Treat `755ca56` as the fixed implementation baseline. The Operator approved work and commits
  directly on the current `master` branch; preserve unrelated worktree changes if any appear.
- Use red-green-refactor at the four approved seams: public contracts, local-source containment,
  database/HTTP orchestration, and black-box/PWA behavior. Run focused tests and `npm run typecheck`
  after every slice.
- Add no new third-party runtime package. `@kestrel/local-source` uses Node built-ins and existing
  Zod contracts; pin no new dependency unless a proven gap is reviewed first.
- Keep all browser input opaque and bounded. The browser may submit a repository ID, one enumerated
  base ref, one enumerated head ref, a confirmed Change Intent, and an optional Change Proposal ID.
  It may never submit a filesystem path, Git directory, raw object ID as selection authority,
  command, artifact locator, or revision expression.
- Configure local access only with `LOCAL_REPOSITORY_ROOTS` (JSON array of absolute paths),
  `LOCAL_GIT_EXECUTABLE` (absolute file), `ARTIFACT_ROOT` (absolute directory outside every source
  root), `REVIEW_REVISION_MAX_BYTES`, and `REVIEW_REVISION_MAX_OBJECTS`. An empty roots array safely
  disables local discovery.
- Use certification constants: scan depth 6, scanned directories 10,000, discovered repositories
  100, refs 500, ref name 255 bytes, committed entries 100,000, repository-relative path 4,096
  bytes, Git stdout 16 MiB, Git stderr 64 KiB, metadata timeout 10 seconds, and object acquisition
  timeout 60 seconds. An `acquiring` row becomes stale after 30 minutes. Default configured
  retention limits are 256 MiB and 200,000 unique objects.
- Resolve/canonicalize configured roots at startup. Reject duplicate, nested, or overlapping roots;
  reject an artifact root inside a source root or a source root inside the artifact root. Never
  follow filesystem symlinks while discovering repositories.
- Use the configured absolute Git executable with `spawn`, `shell: false`, fixed argument vectors,
  bounded stdio, closed stdin except a bounded `cat-file --batch` exchange, timeout, and process
  group termination. Never invoke a shell.
- Give Git only `LANG=C`, `LC_ALL=C`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`,
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_NO_LAZY_FETCH=1`, `GIT_NO_REPLACE_OBJECTS=1`,
  `GIT_OPTIONAL_LOCKS=0`, `GIT_PAGER=cat`, and `GIT_TERMINAL_PROMPT=0`. Do not propagate `HOME`,
  proxy, credential, SSH, provider, Git path, trace, object-directory, or config-injection
  variables.
- Allow only fixed read-only Git plumbing: `--version`; path/object-format `rev-parse`; bounded
  `for-each-ref`; `rev-parse --verify --end-of-options <enumerated-ref>^{commit}`;
  `config --local --no-includes` for remote URLs; raw `cat-file`; and
  `ls-tree -r -t -z --full-tree`. Never call fetch, pull, clone, checkout, archive, upload-pack,
  hooks, filters, textconv, credential helpers, SSH, provider APIs, builds, tests, aliases, or
  repository-defined commands.
- Support Git object formats `sha1` and `sha256`; validate lowercase object IDs at the corresponding
  40- or 64-hex length. Recompute every object ID from `<type> <size>\0<content>` before retention.
- Treat the object closure as the selected base/head commits plus all unique tree/blob objects
  reachable from their source trees. Record gitlinks without traversing them; retain symlink blob
  bytes without following them. Deliberately exclude parents and unrelated history.
- Before acquisition, re-resolve repository identity and both enumerated refs to commits and persist
  their exact IDs. Reject Git/common/object paths or alternates outside the selected configured
  root. Missing/promised objects fail locally; lazy fetch is disabled.
- Never read the worktree or index as source. Dirty, staged, ignored, and untracked bytes cannot
  enter a Review Revision.
- Write only beneath an explicitly resolved mode-0700 staging directory in
  `ARTIFACT_ROOT/projects/<project-id>/revisions/`. Create object files exclusively, fsync data and
  directories, re-open and verify, set final files to 0400 and directories to 0500, then atomically
  rename. Never overwrite an existing artifact and never delete anything outside the exact staging
  directory owned by the current acquisition.
- Store only artifact-root-relative locators in PostgreSQL. Never return/log absolute source paths,
  artifact paths, raw Git stderr, credentials, or remote query strings.
- A Review Revision becomes `available` only after artifact verification and a successful final
  database transaction. Failure leaves no usable locator and records one bounded reason code.
- Extend the V1 error contract with exactly these local-source codes: `REPOSITORY_NOT_AVAILABLE`,
  `REFERENCE_NOT_AVAILABLE`, `SOURCE_CONTAINMENT_VIOLATION`, `REVISION_LIMIT_EXCEEDED`,
  `OBJECT_MISSING`, `OBJECT_VERIFICATION_FAILED`, `CHANGE_PROPOSAL_MISMATCH`, and
  `REVISION_ACQUIRING`. Map them consistently to 404/409/413/422 without including source values;
  unexpected storage/process failures remain `SERVICE_UNAVAILABLE` or `INTERNAL_ERROR`.
- Change Intent is required, trimmed, Operator-submitted text of 1–20,000 UTF-8 bytes. Commit
  messages may be displayed as suggestions only and are never persisted as intent without explicit
  submission.
- Preserve #89 public GitHub behavior and unique provider identity. Match a sanitized GitHub remote
  plus exact base/head IDs to attach source to the existing proposal; reject an explicitly selected
  mismatched proposal and never create a parallel public/private workflow.
- Keep source facts, provider metadata, Revision State, and model access visually and structurally
  separate. The primary Project action is exactly “Open local repository”.
- Use official semantics when implementing Git and filesystem boundaries:
  [git-rev-parse](https://git-scm.com/docs/git-rev-parse),
  [git-for-each-ref](https://git-scm.com/docs/git-for-each-ref),
  [git-ls-tree](https://git-scm.com/docs/git-ls-tree),
  [git-cat-file](https://git-scm.com/docs/git-cat-file),
  [git-config](https://git-scm.com/docs/git-config),
  [partial clone](https://git-scm.com/docs/partial-clone), and
  [Node 24 filesystem APIs](https://nodejs.org/docs/latest-v24.x/api/fs.html).
- Complete `/code-review` against fixed point `755ca56`, resolve every confirmed finding, then run
  the complete verification matrix before claiming completion.

---

## File map

### Shared contracts

- `packages/contracts/src/v1.ts`: opaque source inventory, refs, local/provider proposal union,
  Change Intent, Review Revision, mutation response, and stable error-code schemas.
- `packages/contracts/src/openapi.ts`: the three new authenticated routes and generalized Project
  response models.
- `packages/contracts/src/v1.test.ts`, `src/generated.test.ts`, `generated/*.json`: strict contract
  and deterministic generation evidence.

### Local source boundary

- `packages/local-source/package.json`, `tsconfig*.json`: workspace package and strict build graph.
- `packages/local-source/src/config.ts`: startup configuration, canonical roots, overlap and limit
  validation.
- `packages/local-source/src/discovery.ts`: bounded no-symlink discovery and opaque repository IDs.
- `packages/local-source/src/git.ts`: sanitized subprocess runner, repository inspection, ref
  inventory/resolution, remote sanitization, raw object reads, and tree parsing.
- `packages/local-source/src/artifact.ts`: manifest construction, exact object verification,
  staging/finalization, cleanup, and detached reads.
- `packages/local-source/src/errors.ts`, `types.ts`, `index.ts`: narrow typed API and stable
  internal failures.
- `packages/local-source/src/*.test.ts`: filesystem, process, identity, containment, exactness,
  failure, and source-detachment unit tests.

### Persistence

- `packages/database/migrations/011_local_review_revisions.sql`: provider-nullable Projects and
  proposals, local sources, Change Intent versions, Review Revision lifecycle, constraints,
  idempotency, runtime grants, and audit event allowance.
- `packages/database/src/projects.ts`: generalized Project read/upsert and exact provider-match
  path.
- `packages/database/src/review-revisions.ts`: acquiring/available/unavailable transactions,
  idempotency, retry, reconciliation queries, and minimized audit records.
- `packages/database/src/projects.test.ts`, `review-revisions.test.ts`, `index.ts`: row mapping,
  transaction order, conflict, and lifecycle coverage.

### Web application

- `apps/web/src/routes/local-repository-sources.ts`: authenticated inventory and ref routes.
- `apps/web/src/routes/review-revisions.ts`: authenticated command orchestration and stable errors.
- `apps/web/src/app.ts`, `server.ts`: injectable service registration, validated local
  configuration, and startup reconciliation.
- `apps/web/src/routes/*.test.ts`: contract, authentication, CSRF, orchestration, idempotency, and
  path-redaction tests.

### PWA

- `apps/pwa/src/api.ts`, `api.test.ts`: typed inventory/ref/acquisition clients.
- `apps/pwa/src/OpenLocalRepositoryForm.tsx`, `.test.ts`: primary guided selection and confirmed
  Change Intent flow.
- `apps/pwa/src/App.tsx`, `ProjectInboxPanel.tsx`, `.test.ts`, `styles.css`: refresh/upsert behavior
  and separated source/provider/revision/model facts.

### Runtime and end-to-end evidence

- `Dockerfile`, `compose.yaml`, `compose.test.yaml`: validated Git 2.45+ runtime, explicit read-only
  source mounts, and Kestrel-owned artifact volume; no home/SSH/provider mounts.
- `tests/black-box/support/git-fixture.ts`, `compose.ts`: exact fixture commits, source mutation
  fingerprints, configurable roots, and artifact inspection seam.
- `tests/black-box/local-source.test.ts`: public API, exactness, containment, idempotency, provider
  attachment, disappearance, and no-source-mutation evidence.
- `tests/black-box/local-source.spec.ts`: real-browser primary flow, responsive layout, keyboard,
  accessible names, and axe evidence.
- `README.md`, `CONTEXT.md`: installation/operator flow, security boundary, retained-object closure,
  limitations, and verification commands.

---

### Task 1: Define additive local-source and Review Revision contracts

**Files:**

- Modify `packages/contracts/src/v1.ts`, `src/v1.test.ts`, `src/openapi.ts`.
- Regenerate `packages/contracts/generated/schema-v1.json` and `openapi-v1.json`.

**Interfaces:**

- Produces `LocalRepositoryInventorySchema`, `LocalRepositoryReferencesSchema`.
- Produces `RetainReviewRevisionCommandSchema`, `ReviewRevisionSchema`.
- Produces `LocalRepositorySourceSchema`, `ChangeIntentSchema`, `ReviewRevisionSchema`, and a local
  Change Proposal building-block schema. Task 7 switches the shared Project union only when every
  existing consumer can move in one compilation boundary.

- [ ] **Step 1: Add failing strict-contract tests**

```ts
it("never accepts a browser-supplied path or raw object id", () => {
  expect(() =>
    RetainReviewRevisionCommandSchema.parse({
      repositoryId,
      baseRef: "refs/heads/main",
      headRef: "refs/heads/topic",
      changeIntent: "Review the authorization boundary",
      path: "/Users/operator/repository",
      headObjectId: "a".repeat(40),
    }),
  ).toThrow();
});

it("accepts exact SHA-1 and SHA-256 Review Revision identities", () => {
  expect(ReviewRevisionSchema.parse(sha1Revision).objectFormat).toBe("sha1");
  expect(ReviewRevisionSchema.parse(sha256Revision).objectFormat).toBe("sha256");
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- packages/contracts/src/v1.test.ts`

Expected: FAIL because the inventory, command, revision, intent, and local Project variants do not
exist.

- [ ] **Step 3: Implement bounded additive schemas**

Use opaque `z.uuidv7()` identifiers, `z.strictObject`, 500-item ref inventories, SHA-1/SHA-256
object IDs, and explicit discriminators:

```ts
export const RetainReviewRevisionCommandSchema = z.strictObject({
  repositoryId: KestrelIdSchema,
  baseRef: GitReferenceSchema,
  headRef: GitReferenceSchema,
  changeIntent: ChangeIntentTextSchema,
  changeProposalId: KestrelIdSchema.optional(),
});
```

Represent local source state (`attached`/`detached`) and Revision State
(`acquiring`/`available`/`unavailable`) independently. Validate object-ID length against the
declared object format with `superRefine`; validate trimmed, non-empty Change Intent at both 20,000
characters and 20,000 UTF-8 bytes with `TextEncoder` before storing the normalized value. Keep the
exported provider-only `ChangeProposalSchema` and `ProjectSchema` source-compatible in this slice;
Task 7 installs the final discriminated union and updates all consumers together.

- [ ] **Step 4: Add deterministic schema generation**

Add every building-block schema to the deterministic V1 contract bundle. Do not publish route paths
before their final response contains the generalized Project contract; Task 7 adds all three OpenAPI
operations in the same compilation slice as that union.

- [ ] **Step 5: Verify green and no generated drift**

Run:
`npm run contracts:generate && npm test -- packages/contracts/src/v1.test.ts packages/contracts/src/generated.test.ts && npm run contracts:check && npm run typecheck`

Expected: PASS; a second generation leaves the generated files unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts
git commit -m "feat: define local Review Revision contracts (#90)"
```

---

### Task 2: Validate local-source startup configuration

**Files:**

- Create `packages/local-source/package.json`, `tsconfig.json`, `tsconfig.build.json`.
- Create `packages/local-source/src/config.ts`, `errors.ts`, `types.ts`, `index.ts`.
- Create `packages/local-source/src/config.test.ts`.
- Modify root `package.json`, `package-lock.json`, `tsconfig.json`.

**Interfaces:**

```ts
export interface LocalSourceConfig {
  artifactRoot: string;
  gitExecutable: string;
  maxBytes: number;
  maxObjects: number;
  repositoryRoots: readonly RepositoryRoot[];
}

export function readLocalSourceConfig(env?: NodeJS.ProcessEnv): Promise<LocalSourceConfig>;
```

- [ ] **Step 1: Write failing configuration tests**

Cover empty roots, malformed JSON, relative paths, non-directory roots, symlink canonicalization,
duplicate/nested roots, source/artifact overlap, non-file Git executable, non-positive/unsafe
limits, artifact symlink/wrong owner/group-or-other access, and valid separated paths. Assert all
thrown messages mention configuration keys but never secret or untrusted values.

- [ ] **Step 2: Verify red**

Run: `npm test -- packages/local-source/src/config.test.ts`

Expected: FAIL because `@kestrel/local-source` and `readLocalSourceConfig` do not exist.

- [ ] **Step 3: Implement canonical startup validation**

Parse the five variables, require absolute paths, use `realpath` plus `stat`, compare containment by
`relative(parent, child)` rather than string prefixes, derive opaque root IDs as versioned SHA-256
UUID-shaped values, freeze the returned config, and validate Git `--version` is at least 2.39. Do
not create missing source roots; create the owned artifact root with mode 0700 before canonical
overlap validation. Require an existing artifact root to be a non-symlink directory owned by the
current process UID with no group/other permission bits; reject it instead of silently weakening or
changing permissions.

- [ ] **Step 4: Wire workspace build order**

Add `@kestrel/local-source` to workspaces/build/typecheck references and to `@kestrel/web` as a
workspace dependency. Keep the package dependency-free at runtime.

- [ ] **Step 5: Verify green**

Run:
`npm test -- packages/local-source/src/config.test.ts && npm run typecheck && npm run build -w @kestrel/local-source`

Expected: PASS; invalid configuration fails before the web listener starts.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json packages/local-source apps/web/package.json
git commit -m "feat: validate authorized local source roots (#90)"
```

---

### Task 3: Discover repositories without exposing paths

**Files:**

- Create `packages/local-source/src/discovery.ts`, `discovery.test.ts`.
- Modify `packages/local-source/src/types.ts`, `index.ts`.

**Interfaces:**

```ts
export interface RepositoryInventoryItem {
  displayName: string;
  repositoryId: string;
  rootId: string;
}

export function discoverRepositories(
  config: LocalSourceConfig,
): Promise<readonly RepositoryInventoryItem[]>;

export function resolveRepository(
  config: LocalSourceConfig,
  repositoryId: string,
): Promise<ResolvedRepository>;
```

- [ ] **Step 1: Write the failing containment matrix**

Use temporary roots containing a normal `.git` directory, nested repository, bare repository,
linked-worktree `.git` file, symlinked directory, symlinked `.git`, unreadable entry, >6-depth
repository, >10,000-entry budget, and an outside-root target. Assert deterministic labels/IDs, no
symlink traversal, bounded failure, and no absolute path in public results or errors.

- [ ] **Step 2: Verify red**

Run: `npm test -- packages/local-source/src/discovery.test.ts`

Expected: FAIL because discovery and opaque-ID re-resolution are absent.

- [ ] **Step 3: Implement bounded filesystem discovery**

Use `opendir`, `Dirent`, `lstat`, sorted names, explicit counters, and `realpath` revalidation.
Never descend into a detected repository. Build repository IDs from versioned root ID plus
root-relative locator; return only ID, bounded display label, and root ID. Treat an invalidated or
escaped ID as `REPOSITORY_NOT_AVAILABLE`. The separate durable local-source identity is derived from
the canonical common Git directory during Task 4 inspection.

- [ ] **Step 4: Re-resolve every ID instead of caching authority**

`resolveRepository` performs a fresh bounded discovery, constant-time compares candidate IDs, then
canonicalizes and proves containment immediately before returning its private server-side path. The
returned `ResolvedRepository` type is not exported through contracts or HTTP.

- [ ] **Step 5: Verify green and leak resistance**

Run:
`npm test -- packages/local-source/src/discovery.test.ts && npm run typecheck && npm run lint -- --quiet`

Expected: PASS; serializing every public value/error contains none of the temporary absolute roots.

- [ ] **Step 6: Commit**

```bash
git add packages/local-source/src
git commit -m "feat: discover bounded local repositories (#90)"
```

---

### Task 4: Inspect Git through a fixed read-only boundary

**Files:**

- Create `packages/local-source/src/git.ts`, `git.test.ts`.
- Modify `packages/local-source/src/errors.ts`, `types.ts`, `index.ts`.

**Interfaces:**

```ts
export interface GitRepositoryInspection {
  objectFormat: "sha1" | "sha256";
  repositoryIdentity: string;
  sanitizedGitHubRepository: { owner: string; name: string } | null;
}

export interface GitReferenceInventoryItem {
  commitObjectId: string;
  commitSubjectSuggestion: string | null;
  displayName: string;
  kind: "head" | "local_branch" | "remote_branch" | "tag";
  ref: string;
}

export interface GitInspector {
  inspect(repository: ResolvedRepository): Promise<GitRepositoryInspection>;
  listReferences(repository: ResolvedRepository): Promise<readonly GitReferenceInventoryItem[]>;
  resolveEnumeratedCommit(
    repository: ResolvedRepository,
    ref: string,
    inventory: readonly GitReferenceInventoryItem[],
  ): Promise<string>;
  listTree(
    repository: ResolvedRepository,
    commitObjectId: string,
  ): Promise<readonly GitTreeEntry[]>;
  readObjects(repository: ResolvedRepository, ids: readonly string[]): AsyncIterable<GitObject>;
}
```

- [ ] **Step 1: Write failing process-boundary tests**

Use a real temporary Git fixture for SHA-1 repositories and inject a recording executable for
argument/environment assertions. Cover malicious ref names beginning with `-`, annotated tags,
non-commit refs, 501 refs, oversized stdout/stderr, hung child, closed stdin, child failure, SHA-256
when supported, worktree/common Git directories, alternates escaping the root, malformed batch
responses, missing/promised objects, and remotes containing credentials/query strings.

```ts
expect(recorded).toMatchObject({
  executable: gitExecutable,
  shell: false,
  args: ["-C", repositoryPath, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
});
expect(recorded.env).toEqual(SAFE_GIT_ENV);
```

- [ ] **Step 2: Verify red**

Run: `npm test -- packages/local-source/src/git.test.ts`

Expected: FAIL because no Git subprocess boundary or inspector exists.

- [ ] **Step 3: Implement the sanitized runner**

Implement one private `runGit`/`runGitBatch` seam that always prepends `-C <resolved-repository>`,
uses the configured executable, the exact allowlisted environment, `shell: false`, bounded buffers,
timeouts, and child teardown. Map all failures to stable local-source errors without copying stderr.
Accept only the explicit command shapes in Global Constraints; tests reject any unknown operation.

- [ ] **Step 4: Implement repository and ref inspection**

Resolve and canonicalize the absolute Git directory, common Git directory, top-level/bare status,
object directory, and storage object format. Read `.git/objects/info/alternates` without following
symlinks and reject every alternate or administrative path outside the authorized root. Derive the
versioned source identity from canonical common Git directory plus object format.

Enumerate `HEAD`, `refs/heads/*`, `refs/remotes/*`, and `refs/tags/*` with a 501 sentinel and
NUL-safe fixed formatting. Resolve only an exact ref present in that inventory using
`--verify --end-of-options <ref>^{commit}`, then confirm `cat-file -t` is `commit`. Capture the two
exact IDs before any artifact read. Derive an optional display-only commit-subject suggestion from
the raw commit object, normalize control characters to spaces, and cap it at 512 UTF-8 bytes; never
treat it as Change Intent.

- [ ] **Step 5: Implement raw object/tree parsing and remote sanitization**

Parse `ls-tree -r -t -z --full-tree` bytes without newline assumptions. Accept only modes `040000`,
`100644`, `100755`, `120000`, and `160000`; reject absolute/dot/duplicate/NUL/oversized paths,
invalid UTF-8 decoded with fatal `TextDecoder`, and type/mode mismatches; preserve valid path bytes
without Unicode normalization. Use raw `cat-file --batch` without filters/textconv and validate
every header, byte count, trailing newline, type, and requested ID.

Read local config with `--local --no-includes`; accept only credential-free GitHub HTTPS or SSH
repository identities, strip `.git`, normalize owner/name for matching, and discard all other URLs.

- [ ] **Step 6: Verify green and commit**

Run:
`npm test -- packages/local-source/src/git.test.ts && npm test -- packages/local-source/src/discovery.test.ts && npm run typecheck && npm run lint`

Expected: PASS; the recording runner observes no network-capable command and no ambient sensitive
environment variable.

```bash
git add packages/local-source/src
git commit -m "feat: constrain local Git inspection (#90)"
```

---

### Task 5: Retain and read an exact immutable object closure

**Files:**

- Create `packages/local-source/src/artifact.ts`, `artifact.test.ts`.
- Modify `packages/local-source/src/errors.ts`, `types.ts`, `index.ts`.

**Interfaces:**

```ts
export interface RetainRevisionInput {
  baseObjectId: string;
  headObjectId: string;
  projectId: string;
  repository: ResolvedRepository;
  revisionId: string;
}

export interface RetainedArtifact {
  artifactLocator: string;
  manifestDigest: string;
  objectCount: number;
  retainedBytes: number;
}

export function retainRevision(
  config: LocalSourceConfig,
  inspector: GitInspector,
  input: RetainRevisionInput,
): Promise<RetainedArtifact>;

export function readRetainedFile(
  config: LocalSourceConfig,
  input: {
    artifactLocator: string;
    manifestDigest: string;
    side: "base" | "head";
    path: string;
  },
): Promise<Buffer>;

export function quarantineUnattachedArtifact(
  config: LocalSourceConfig,
  artifactLocator: string,
): Promise<void>;
export function reconcileArtifactRoot(
  config: LocalSourceConfig,
  referencedArtifactLocators: readonly string[],
): Promise<ArtifactReconciliation>;
```

- [ ] **Step 1: Write failing exactness and failure tests**

Create two commits with shared trees/blobs, executable files, a symlink, a gitlink, Unicode names,
and a binary blob. After committing head, alter a tracked worktree file, stage another version, and
add ignored/untracked secrets. Assert retained bytes match commit objects and neither dirty/staged/
untracked value occurs in any artifact file or manifest.

Also cover byte/object/entry/path limits, missing object, hash mismatch, duplicate path, partial
write, fsync/rename/database-handoff simulation, existing final directory, traversal locator,
corrupt manifest/object, cleanup scope, and reading after renaming the entire source repository.

- [ ] **Step 2: Verify red**

Run: `npm test -- packages/local-source/src/artifact.test.ts`

Expected: FAIL because retention, manifest verification, and detached reads are absent.

- [ ] **Step 3: Build and verify the exact closure in memory-bounded phases**

Read raw base/head commit objects, parse their `tree` headers, enumerate both trees, and deduplicate
commit/tree/blob IDs. Do not enqueue parent commits or gitlink targets. Before each read, enforce
the configured count; after its bounded header and before write, enforce cumulative unique raw
bytes. Recompute IDs with the selected object format and reject mismatches.

Use this canonical manifest shape, serialized with recursively sorted keys and a final newline:

```ts
interface RevisionManifestV1 {
  schemaVersion: 1;
  objectFormat: "sha1" | "sha256";
  base: { commitObjectId: string; entries: readonly ManifestEntry[] };
  head: { commitObjectId: string; entries: readonly ManifestEntry[] };
  objects: readonly { id: string; type: "blob" | "commit" | "tree"; size: number }[];
}
```

- [ ] **Step 4: Stage, durability-check, and finalize atomically**

Validate UUID path segments before joining. Resolve the owned revision parent below the canonical
artifact root, create a random `.acquiring-<uuid>` directory with mode 0700 and exclusive object
files under `objects/<first-two>/<remaining>`. Reopen every object, re-hash it, write/verify the
manifest and SHA-256 digest, fsync files/directories, chmod final files 0400/directories 0500, then
rename once to `<revision-id>`. Return only a normalized artifact-root-relative locator.

On failure, validate the exact staging ownership token, chmod only that staging tree as needed, and
remove it. Never remove or alter a finalized directory, sibling revision, source path, or artifact
root. A separately invoked quarantine move accepts only the exact locator returned by the current
acquisition. Startup reconciliation receives the database's referenced locator set, removes only
well-formed abandoned staging directories, and moves well-formed unreferenced finalized artifacts
into an owned quarantine directory without guessing an association.

- [ ] **Step 5: Implement detached reads**

Validate locator grammar rather than accepting a path, re-resolve it under `ARTIFACT_ROOT`, verify
manifest digest/object hash, find the exact normalized path on the requested side, require a blob
entry (including symlink bytes), then read by content ID. Do not depend on repository availability.

- [ ] **Step 6: Verify green and commit**

Run:
`npm test -- packages/local-source/src/artifact.test.ts packages/local-source/src/git.test.ts && npm run typecheck && npm run build -w @kestrel/local-source`

Expected: PASS; the fixture remains byte-for-byte unchanged and the retained file remains readable
after source disappearance.

```bash
git add packages/local-source/src
git commit -m "feat: retain exact immutable Review Revisions (#90)"
```

---

### Task 6: Persist the Review Revision lifecycle atomically

**Files:**

- Create `packages/database/migrations/011_local_review_revisions.sql`.
- Create `packages/database/src/review-revisions.ts`, `review-revisions.test.ts`.
- Modify `packages/database/src/index.ts`, `projects.ts`, `projects.test.ts`, `migrate.test.ts`.

**Interfaces:**

```ts
export interface BeginReviewRevisionResult {
  outcome: "acquire" | "already_available" | "acquiring";
  changeIntent: ChangeIntent;
  changeProposalId: string;
  projectId: string;
  revision: ReviewRevision;
}

export function withReviewRevisionAcquisitionLease<T>(
  pool: DatabasePool,
  input: BeginReviewRevisionInput,
  operation: (begun: BeginReviewRevisionResult, leasedPool: DatabasePool) => Promise<T> | T,
): Promise<T>;
export function completeReviewRevision(
  pool: DatabasePool,
  input: CompleteReviewRevisionInput,
): Promise<ReviewRevision>;
export function failReviewRevision(
  pool: DatabasePool,
  input: FailReviewRevisionInput,
): Promise<void>;
export function reconcileAcquiringRevisions(pool: DatabasePool): Promise<number>;
export function reconcileLocalSourceAttachments(
  pool: DatabasePool,
  observations: readonly LocalSourceAttachmentObservation[],
): Promise<number>;
export function readReferencedArtifactLocators(pool: DatabasePool): Promise<readonly string[]>;
export function withArtifactLifecycleLock<T>(
  pool: DatabasePool,
  operation: () => Promise<T>,
): Promise<T>;
```

- [ ] **Step 1: Write failing migration and transaction tests**

Extend migration tests to assert idempotent application, runtime-role grants, foreign keys,
provider-nullability constraints, partial uniqueness, state/locator consistency, and append-only
intent versions. Use the recording database pool to prove `BEGIN`/write/audit/`COMMIT` ordering and
`ROLLBACK` on every intermediate failure.

Cover first acquisition, same exact revision available, concurrent acquiring conflict, explicit
retry after unavailable, conflicting artifact completion, failure without locator, and stale
acquiring reconciliation.

- [ ] **Step 2: Verify red**

Run:
`npm test -- packages/database/src/migrate.test.ts packages/database/src/review-revisions.test.ts packages/database/src/projects.test.ts`

Expected: FAIL because migration 011 and lifecycle functions do not exist.

- [ ] **Step 3: Implement constrained schema evolution**

Generalize `projects` so provider observation columns are all-null or all-present, retaining the
existing provider uniqueness with a partial index. Add a constrained `proposal_kind` and make
provider proposal fields all-null only for `local`; keep them all-present for `provider_observed`.

Create:

- `local_repository_sources` with Installation/Project ownership, versioned identity, opaque root
  ID, opaque repository-ID snapshot, bounded display-label snapshot, server-only root-relative
  locator, object format, optional sanitized GitHub identity, and `attached`/`detached` state;
- `change_intents` with `(change_proposal_id, version)` uniqueness and immutable submitted text;
- `review_revisions` with exact refs/IDs, object format, configured limits, state, count/bytes,
  relative locator/digest, reason code, and timestamps.

Add `source_availability` to `projects`, constrained to `not_acquired`, `available`, or
`unavailable`; lifecycle transactions, not HTTP code, own its transitions.

Enforce a unique exact key on Project, Change Proposal, local-source identity, base ID, and head ID;
Change Intent version is deliberately not part of source identity. Store the intent used for the
first acquisition as `acquisition_change_intent_id`. Use check constraints so only `available` rows
have locator/digest/counts and only `unavailable` rows have a reason. Grant only required operations
to the runtime role and extend allowed minimized audit event types.

- [ ] **Step 4: Implement lifecycle transactions and provider matching**

`withReviewRevisionAcquisitionLease` upserts/reuses the Project and local source, matches an
existing #89 proposal only when sanitized owner/name plus exact base/head IDs agree, rejects an
explicit mismatch, creates or reuses a local proposal otherwise, reuses an identical current Change
Intent or appends a new Operator-submitted version, and inserts or locks the exact revision in
`acquiring` state. A later intent version may become current on the proposal while an
already-available exact source revision remains the same immutable revision. Before committing a new
or retried acquisition, it takes a per-revision session advisory lease and holds the same client
through retain and complete-or-fail. Stale recovery uses the corresponding nonblocking transaction
advisory lock, so it skips live work but reclaims an orphan after 30 minutes.

`completeReviewRevision` locks the acquiring row and transitions it once with relative locator,
digest, count, and bytes in the same transaction as Project source availability and audit append.
`failReviewRevision` never stores a locator and is idempotent. Reconciliation marks old acquiring
rows unavailable with `ACQUISITION_INTERRUPTED`; it does not infer or attach finalized artifacts.
Attachment reconciliation marks a source attached only after the currently discovered repository ID
and durable source identity agree; missing or changed observations become detached without altering
retained revisions. `withArtifactLifecycleLock` uses one Installation-scoped PostgreSQL session
advisory lock to serialize artifact acquisition, quarantine, and reconciliation across web processes
and always releases its dedicated client in `finally`.

- [ ] **Step 5: Verify green against real PostgreSQL and unit seams**

Run:
`npm test -- packages/database/src/review-revisions.test.ts packages/database/src/projects.test.ts packages/database/src/migrate.test.ts && npm run typecheck && npm run build -w @kestrel/database`

Expected: PASS; provider-only rows from migration 010 remain readable and every lifecycle state
satisfies database constraints.

- [ ] **Step 6: Commit**

```bash
git add packages/database
git commit -m "feat: persist Review Revision lifecycle (#90)"
```

---

### Task 7: Expose authenticated inventory and acquisition routes

**Files:**

- Create `apps/web/src/routes/local-repository-sources.ts`, `local-repository-sources.test.ts`,
  `review-revisions.ts`, `review-revisions.test.ts`.
- Modify `apps/web/src/app.ts`, `app.test.ts`, `server.ts`.
- Modify `packages/contracts/src/v1.ts`, `v1.test.ts`, `openapi.ts` and generated contracts to
  finalize the generalized Project/Change Proposal response.
- Modify `packages/database/src/projects.ts`, `projects.test.ts` for generalized row mapping.

**Interfaces:**

```ts
export interface LocalRepositoryService {
  listRepositories(): Promise<LocalRepositoryInventory>;
  listReferences(repositoryId: string): Promise<LocalRepositoryReferences>;
  prepare(command: RetainReviewRevisionCommand): Promise<PreparedReviewRevision>;
  retain(input: PreparedRetention): Promise<RetainedArtifact>;
}

export function registerLocalRepositoryRoutes(
  app: FastifyInstance,
  service: LocalRepositoryService,
): void;

export function registerReviewRevisionRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  service: LocalRepositoryService,
): void;
```

- [ ] **Step 1: Write failing route tests with injected fakes**

Prove both GET routes require an authenticated Operator, return strict no-store payloads, preserve
opaque IDs, and map stale/escaped/limit failures without paths. Prove POST requires authentication,
same-origin, CSRF, JSON, and a strict body; rejects path/extra fields and mismatched proposal IDs.

For orchestration, record this exact order:

```ts
expect(calls).toEqual([
  "prepare-and-resolve-exact-ids",
  "begin-database-acquisition",
  "retain-and-verify-artifact",
  "complete-database-acquisition",
]);
```

Also assert already-available skips retention, acquiring maps to 409, local failure calls
`failReviewRevision` once, completion failure exposes no locator, and neither response nor logs
contain fixture paths/Git stderr.

- [ ] **Step 2: Verify red**

Run:
`npm test -- apps/web/src/routes/local-repository-sources.test.ts apps/web/src/routes/review-revisions.test.ts`

Expected: FAIL because the services and routes do not exist.

- [ ] **Step 3: Implement route/service orchestration**

Register GET inventory and refs under existing authentication. `prepare` freshly resolves the opaque
repository, inspects identity, obtains a fresh ref inventory, requires the submitted refs to be
exact inventory members, resolves both to commit IDs, and returns those IDs plus private resolved
state. Before publishing inventory, the concrete web service inspects every bounded discovery
candidate and omits candidates that fail repository/containment validation; a systemic Git runtime
failure returns `SERVICE_UNAVAILABLE`. It joins verified repository IDs to database attachment state
without exposing stored locators. Only after exact ref resolution call
`withReviewRevisionAcquisitionLease`.

On `acquire`, retain and verify the artifact, then complete the database transition and return 201.
On `already_available`, return the existing strict response with 200. On `acquiring`, return
`REVISION_ACQUIRING` with 409. On local-source failure after begin, record a bounded reason and
return the mapped status; do not return a partial response or artifact locator. If final artifact
creation succeeds but database completion fails, quarantine that exact just-created locator before
recording failure; a quarantine failure is logged without deleting or exposing the artifact. After
When `withReviewRevisionAcquisitionLease` reports `acquire`, wrap retain/complete-or-fail in
`withArtifactLifecycleLock` on its leased pool, using the same lifecycle lock as startup
reconciliation. A concurrent request can still observe the committed `acquiring` row and receive 409
instead of waiting for artifact I/O.

- [ ] **Step 4: Generalize Project mapping at one compilation boundary**

Now switch `ChangeProposalSchema` to the provider/local discriminated union and make local source
and provider observation nullable independent attachments on `ProjectSchema`. Update database row
mapping, `upsertPublicGitHubProject`, and route fixtures in the same slice so existing #89 provider
responses retain their information with `kind: "provider_observed"`; local proposals use
`kind: "local"` and have no fabricated provider URL/number/author.

Each proposal exposes its nullable current Operator-authored Change Intent and bounded Review
Revision summaries so a fresh Project inbox can render Revision State. The Review Revision response
includes one updated Project, one local source summary, the selected proposal, current Change Intent
version, and an `available` revision; it contains no operational locator.

Publish the three authenticated OpenAPI operations with their strict request/response schemas and
400/401/403/404/409/413/422/500 envelopes only after this final response schema exists.

- [ ] **Step 5: Wire startup configuration and reconciliation**

`server.ts` reads local configuration before constructing/listening, creates the concrete service,
registers it through `buildApp`, and reconciles stale database acquisitions plus owned staging
directories and current attached/detached source observations before readiness. Unit tests continue
to inject fakes and never touch a workstation repository. An explicit `LOCAL_REPOSITORY_ROOTS=[]`
keeps provider-only installations operational and marks previously configured sources detached
without touching their revisions. Hold an Installation-scoped PostgreSQL advisory lock while reading
referenced artifact locators and reconciling the shared artifact root so two web processes cannot
quarantine each other's acquisition.

- [ ] **Step 6: Verify green and commit**

Run:
`npm run contracts:generate && npm test -- apps/web/src/routes/local-repository-sources.test.ts apps/web/src/routes/review-revisions.test.ts apps/web/src/routes/projects.test.ts packages/database/src/projects.test.ts packages/contracts/src/v1.test.ts && npm run contracts:check && npm run typecheck && npm run lint`

Expected: PASS; existing public GitHub route tests remain green and all expected failures use the
versioned `ApiError` envelope.

```bash
git add apps/web packages/contracts packages/database
git commit -m "feat: expose local Review Revision acquisition (#90)"
```

---

### Task 8: Make “Open local repository” the primary Project flow

**Files:**

- Create `apps/pwa/src/OpenLocalRepositoryForm.tsx`, `OpenLocalRepositoryForm.test.ts`.
- Modify `apps/pwa/src/api.ts`, `api.test.ts`, `App.tsx`, `ProjectInboxPanel.tsx`,
  `ProjectInboxPanel.test.ts`, `styles.css`.

**Interfaces:**

```ts
export function getLocalRepositories(): Promise<LocalRepositoryInventory>;
export function getLocalRepositoryReferences(
  repositoryId: string,
): Promise<LocalRepositoryReferences>;
export function retainReviewRevision(
  command: RetainReviewRevisionCommand,
  csrfToken: string,
): Promise<ReviewRevisionAvailable>;
```

- [ ] **Step 1: Write failing API client tests**

Assert exact URL/method/credentials/header/body behavior, strict response parsing, no
caller-supplied path, abort-safe repository/ref reload, CSRF on POST, and safe error messaging for
every stable reason code.

- [ ] **Step 2: Write failing component tests**

Render an authenticated Project screen and assert the primary visible action is “Open local
repository”. Exercise repository selection, async refs, base/head selection, required Change Intent,
optional matching proposal, pending/disabled state, successful inbox replacement, retryable failure,
and no implicit intent derived from displayed commit-message suggestions.

```tsx
await user.click(screen.getByRole("button", { name: "Open local repository" }));
await user.selectOptions(screen.getByLabelText("Repository"), repositoryId);
await user.type(screen.getByLabelText("Change Intent"), "Review authorization boundaries");
expect(screen.getByRole("button", { name: "Retain Review Revision" })).toBeEnabled();
```

- [ ] **Step 3: Verify red**

Run:
`npm test -- apps/pwa/src/api.test.ts apps/pwa/src/OpenLocalRepositoryForm.test.ts apps/pwa/src/ProjectInboxPanel.test.ts`

Expected: FAIL because the local flow and generalized Project rendering do not exist.

- [ ] **Step 4: Implement the guided local flow**

Use native labelled controls and a native `<dialog>` with explicit focus management. Load only
opaque repository inventory; after repository selection load its refs and clear stale choices.
Require different selectable base/head refs and non-empty confirmed intent. Show commit subjects
only in a separate “Suggestions from commits” region with an explicit copy action; never initialize
the intent textarea from them.

On success close/reset the form and replace/upsert the returned Project by ID. Preserve the public
GitHub form as a secondary action and keep its existing manual/no-authentication explanation.

- [ ] **Step 5: Separate Project facts visually and semantically**

Render four named regions/cards:

- `Local Repository Source`: display label, attached/detached state, no path;
- `Provider metadata`: public GitHub observation, or “Not observed”;
- `Revision State`: exact short base/head IDs, availability, intent version;
- `Model access`: “Not configured”.

Provider and local proposal variants are pattern-matched rather than filled with fake values.
Announce request failures and success with an `aria-live` status, preserve keyboard focus, and keep
the mobile layout single-column without horizontal overflow.

- [ ] **Step 6: Verify green and commit**

Run:
`npm test -- apps/pwa/src/api.test.ts apps/pwa/src/OpenLocalRepositoryForm.test.ts apps/pwa/src/ProjectInboxPanel.test.ts && npm run typecheck && npm run build -w @kestrel/pwa`

Expected: PASS; existing public GitHub component/client behavior remains green.

```bash
git add apps/pwa
git commit -m "feat: open local repositories from the Project inbox (#90)"
```

---

### Task 9: Prove containment and durability through the release stack

**Files:**

- Modify `Dockerfile`, `compose.yaml`, `compose.test.yaml`.
- Create `tests/black-box/support/git-fixture.ts`, `tests/black-box/local-source.test.ts`.
- Modify `tests/black-box/support/compose.ts`.

**Interfaces:**

```ts
export interface GitFixture {
  baseObjectId: string;
  headObjectId: string;
  repositoryPath: string;
  rootPath: string;
  snapshotSource(): Promise<SourceFingerprint>;
}

export interface StackOptions {
  repositoryRoot?: string;
  reviewRevisionMaxBytes?: number;
  reviewRevisionMaxObjects?: number;
}
```

- [ ] **Step 1: Write the failing release-stack test**

Create the fixture before Compose starts, mount only its parent root read-only, authenticate through
the public session/CSRF flow, inventory by opaque ID, select refs, and retain. Assert response OIDs
equal the fixture's exact committed IDs and the Project is available. Fingerprint all source
contents/modes/mtimes before and after.

Invoke an internal test helper in the release image against the isolated Kestrel-owned artifact
volume to prove it contains the two committed versions and does not contain dirty, staged, ignored,
or untracked sentinel bytes. Rename the repository directory within the mounted parent root, restart
web, and use the public local-source module read seam from inside the release image to prove the
retained head file remains exact while the Project source reports detached.

- [ ] **Step 2: Add failing containment scenarios**

Cover source root mounted `:ro`, artifact root separate/read-write, escaped symlink, escaped Git
common directory/alternate, stale opaque ID, oversized object closure, missing object, 501 refs,
same exact acquisition twice, concurrent acquisition, and failed acquisition with no usable
revision/artifact locator.

Use a test-only executable recorder mounted at an absolute trusted test path to capture every Git
argv and child environment while delegating to `/usr/bin/git`. Assert the allowlist contains no
network/mutation/build/test operation and no credential/SSH/provider/proxy variable. Seed a matching
#89 observation through the database package, acquire its exact commits, and assert one Project and
one shared proposal rather than a duplicate local proposal.

- [ ] **Step 3: Verify red**

Run: `npm run test:black-box -- tests/black-box/local-source.test.ts`

Expected: FAIL because the image lacks validated Git/local configuration and the stack has no
source/artifact mounts.

- [ ] **Step 4: Implement explicit release wiring**

Install a Git 2.45+ runtime in the pinned Node 24 image and keep the process as non-root. Add
`LOCAL_REPOSITORY_ROOTS`, `LOCAL_GIT_EXECUTABLE`, `ARTIFACT_ROOT`, and both limits explicitly to
Compose. The development file defaults to an empty roots array and a named Kestrel artifact volume;
the black-box override receives one generated fixture parent and one Compose-project-scoped named
artifact volume. Pre-create the image's artifact mountpoint as UID/GID `node` with mode 0700 so a
new named volume inherits the required ownership without a root entrypoint or runtime chmod.

Do not mount a user home, `/`, SSH agent/socket, Docker socket, GitHub config, credentials, or
provider cache. Do not grant source write access or privileged/capability escalation.

- [ ] **Step 5: Make cleanup/restart deterministic**

Extend stack support to pass explicit resolved environment paths, preserve fixtures during a test,
restart web without recreating PostgreSQL/artifacts, and remove only generated per-test directories
after Compose is down. Remove the isolated artifact volume only through the exact Compose project
cleanup. Validate filesystem cleanup targets are descendants of the harness-owned temporary
directory before removal.

- [ ] **Step 6: Verify green and commit**

Run:
`npm run test:black-box -- tests/black-box/local-source.test.ts && npm run test:black-box -- tests/black-box/installation.test.ts tests/black-box/authentication.test.ts`

Expected: PASS; source fingerprint is unchanged, no disallowed Git call/environment is recorded, the
exact artifact survives source disappearance/restart, and existing installation/authentication flows
remain green.

```bash
git add Dockerfile compose.yaml compose.test.yaml tests/black-box
git commit -m "test: certify local source containment and retention (#90)"
```

---

### Task 10: Verify the primary flow in a real browser

**Files:**

- Create `tests/black-box/local-source.spec.ts`.
- Modify `tests/black-box/support/compose.ts` to expose a reusable Playwright fixture-stack setup
  helper.

- [ ] **Step 1: Write the failing browser journey**

Authenticate, open the Project screen, assert “Open local repository” precedes the public GitHub
action in DOM/tab order, open the local form, select fixture repository/base/head, submit confirmed
intent, and observe one available Project without a page reload.

- [ ] **Step 2: Add accessibility and responsive assertions**

Run axe with no serious/critical findings; navigate the entire form by keyboard; assert focus moves
to the dialog/heading, returns to the trigger, and reaches the success status. Check 375×812 and
1280×800 viewports for no horizontal overflow and clearly separated Source, Provider metadata,
Revision State, and Model access regions.

- [ ] **Step 3: Verify red**

Run: `npm run test:browser -- tests/black-box/local-source.spec.ts`

Expected: FAIL until the release-stack fixture and final accessible flow are wired together.

- [ ] **Step 4: Fix only browser-observed integration defects**

Use semantic role/label locators, not CSS implementation details. Correct focus, loading, error,
refresh, or responsive behavior in PWA files; do not weaken assertions or mock the local-source API
for this release test.

- [ ] **Step 5: Verify browser green alongside #89**

Run: `npm run test:browser -- tests/black-box/local-source.spec.ts tests/black-box/pwa.spec.ts`

Expected: PASS in Chromium; both local-first and public GitHub secondary flows remain accessible.

- [ ] **Step 6: Commit**

```bash
git add tests/black-box/local-source.spec.ts tests/black-box/support apps/pwa
git commit -m "test: verify local-first Project flow in browser (#90)"
```

---

### Task 11: Document, audit, and finish the implementation

**Files:**

- Modify `README.md`, `CONTEXT.md`.
- Modify any issue-#90 file only when a failing verification or confirmed review finding requires
  it.

- [ ] **Step 1: Document the operational boundary**

Document the native/Compose variables with safe examples, empty-root disable behavior, read-only
root requirement, separate artifact ownership, Git 2.45+ requirement, root changes/restart, opaque
browser inventory, exact object closure, source-detachment durability, Change Intent confirmation,
provider attachment, stable failure codes, and the explicit list of operations Kestrel never runs.

- [ ] **Step 2: Run focused issue-#90 verification**

Run:

```bash
npm test -- packages/contracts/src/v1.test.ts packages/local-source/src packages/database/src/review-revisions.test.ts packages/database/src/projects.test.ts apps/web/src/routes/local-repository-sources.test.ts apps/web/src/routes/review-revisions.test.ts apps/pwa/src/OpenLocalRepositoryForm.test.ts apps/pwa/src/ProjectInboxPanel.test.ts apps/pwa/src/api.test.ts
npm run test:black-box -- tests/black-box/local-source.test.ts
npm run test:browser -- tests/black-box/local-source.spec.ts
```

Expected: all focused contract, containment, persistence, HTTP, PWA, release, and browser evidence
passes.

- [ ] **Step 3: Run the complete repository verification matrix**

Run in order:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run contracts:check
npm test
npm run build
npm run test:black-box
npm run test:browser
git diff --check
```

Expected: every command exits 0 with no generated drift, no lint/type errors, and no regression in
issues #34, #36, or #89.

- [ ] **Step 4: Perform the required two-axis code review**

Invoke `/code-review` with fixed point `755ca56` and ticket/spec paths. Run the required Standards
and Spec review agents in parallel, independently verify each reported finding, fix all confirmed
Critical/Important issues plus justified Minor issues, and rerun the smallest affected red/green
test followed by the complete matrix above. For every review-fix commit, enumerate and stage only
the files named by `git status --short` that were edited for that confirmed finding.

- [ ] **Step 5: Audit scope, secrets, and repository state**

Inspect `git diff --stat 755ca56`, `git diff --check 755ca56`, tracked filenames, generated contract
diff, Docker/Compose mounts, logs/errors, and test artifacts. Confirm no credentials, absolute local
paths, source bytes, AI metadata, unrelated refactor, partial artifact locator, or unintended
dependency entered the diff.

- [ ] **Step 6: Commit documentation/review fixes and report evidence**

```bash
git add README.md CONTEXT.md
git commit -m "docs: document exact local Review Revisions (#90)"
git status --short --branch
git log --oneline 755ca56..HEAD
```

Expected: the current branch is clean and ahead only by the approved design, plan, atomic
implementation, tests, and documentation commits. Report exact verification commands/results and any
environment limitation; do not claim a skipped check passed.
