import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { LocalSourceConfig } from "./config.js";
import type { ResolvedRepository } from "./discovery.js";
import { LocalSourceError } from "./errors.js";
import {
  inspectRepository,
  listCommitTreeEntries,
  readCommitSuggestions,
  withGitObjectReader,
  type GitObjectFormat,
  type GitObjectReader,
  type GitObjectType,
  type GitTreeEntry,
  type GitTreeTraversalBudget,
  type RawGitObject,
  type RepositoryInspection,
  type SelectedRevision,
} from "./git.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MANIFEST_NAME = "manifest.json";
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

interface ManifestEntry {
  mode: GitTreeEntry["mode"];
  objectId: string;
  path: string;
  type: GitTreeEntry["type"];
}

interface ManifestObject {
  id: string;
  size: number;
  type: GitObjectType;
}

interface RevisionManifest {
  base: { commitObjectId: string; entries: readonly ManifestEntry[]; ref: string };
  head: { commitObjectId: string; entries: readonly ManifestEntry[]; ref: string };
  objectFormat: GitObjectFormat;
  objects: readonly ManifestObject[];
  schemaVersion: 1;
}

export interface RetainedChangeOverviewFileEntry {
  mode: Exclude<GitTreeEntry["mode"], "040000">;
  objectId: string;
  type: Exclude<GitTreeEntry["type"], "tree">;
}

export interface RetainedChangeOverviewFile {
  base: RetainedChangeOverviewFileEntry | null;
  head: RetainedChangeOverviewFileEntry | null;
  path: string;
  status: "added" | "modified" | "deleted";
}

export type RetainedChangeOverviewWarning =
  | { code: "changed_files_truncated"; omittedCount: number }
  | { code: "path_areas_truncated"; omittedCount: number }
  | {
      affectedFileCount: number;
      code: "gitlink_not_expanded" | "git_lfs_pointer_not_hydrated";
      samplePaths: string[];
    };

export interface RetainedChangeOverviewFacts {
  ruleVersion: 1;
  commitStatistics: { baseTreeFileCount: number; headTreeFileCount: number };
  fileStatistics: { added: number; modified: number; deleted: number; total: number };
  changedFiles: RetainedChangeOverviewFile[];
  pathAreas: Array<{
    pathPrefix: string | null;
    changedFileCount: number;
    samplePaths: string[];
  }>;
  warnings: RetainedChangeOverviewWarning[];
}

export interface RetainRevisionInput {
  fallbackSource?: RetainRevisionObjectSource;
  projectId: string;
  revisionId: string;
  selected: SelectedRevision;
  signal?: AbortSignal;
}

export interface RetainRevisionObjectSource {
  inspection: RepositoryInspection;
  repository: ResolvedRepository;
}

export interface RetainedArtifact {
  artifactLocator: string;
  baseCommitAuthor: string | null;
  baseCommitSubject: string | null;
  changeOverviewFacts: RetainedChangeOverviewFacts;
  headCommitAuthor: string | null;
  headCommitSubject: string | null;
  manifestDigest: string;
  objectCount: number;
  retainedBytes: number;
}

const MAX_OVERVIEW_CHANGED_FILES = 200;
const MAX_OVERVIEW_PATH_AREAS = 20;
const MAX_OVERVIEW_SAMPLE_PATHS = 5;
const GIT_LFS_POINTER_PREFIX = Buffer.from("version https://git-lfs.github.com/spec/v1\n", "utf8");

function overviewFileEntry(entry: ManifestEntry): RetainedChangeOverviewFileEntry {
  if (entry.type === "tree" || entry.mode === "040000") {
    throw new LocalSourceError("object_verification_failed");
  }
  return { mode: entry.mode, objectId: entry.objectId, type: entry.type };
}

function overviewPathPrefix(path: string): string | null {
  const separator = path.indexOf("/");
  return separator === -1 ? null : path.slice(0, separator);
}

function isGitLfsPointer(object: RawGitObject | undefined): boolean {
  return (
    object?.type === "blob" &&
    object.content.subarray(0, GIT_LFS_POINTER_PREFIX.byteLength).equals(GIT_LFS_POINTER_PREFIX)
  );
}

function collectChangeOverviewChanges(
  baseEntries: readonly ManifestEntry[],
  headEntries: readonly ManifestEntry[],
) {
  const filesByPath = (entries: readonly ManifestEntry[]) =>
    new Map(entries.filter(({ type }) => type !== "tree").map((entry) => [entry.path, entry]));
  const baseByPath = filesByPath(baseEntries);
  const headByPath = filesByPath(headEntries);
  const paths = [...new Set([...baseByPath.keys(), ...headByPath.keys()])].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  const changes: RetainedChangeOverviewFile[] = [];
  const fileStatistics = { added: 0, modified: 0, deleted: 0, total: 0 };
  for (const path of paths) {
    const base = baseByPath.get(path);
    const head = headByPath.get(path);
    let status: RetainedChangeOverviewFile["status"];
    if (base === undefined && head !== undefined) status = "added";
    else if (base !== undefined && head === undefined) status = "deleted";
    else if (
      base !== undefined &&
      head !== undefined &&
      (base.mode !== head.mode || base.objectId !== head.objectId || base.type !== head.type)
    ) {
      status = "modified";
    } else {
      continue;
    }
    fileStatistics[status] += 1;
    fileStatistics.total += 1;
    changes.push({
      base: base === undefined ? null : overviewFileEntry(base),
      head: head === undefined ? null : overviewFileEntry(head),
      path,
      status,
    });
  }
  return { baseByPath, changes, fileStatistics, headByPath };
}

function buildChangeOverviewFacts(
  baseEntries: readonly ManifestEntry[],
  headEntries: readonly ManifestEntry[],
  objects: ReadonlyMap<string, RawGitObject>,
): RetainedChangeOverviewFacts {
  const { baseByPath, changes, fileStatistics, headByPath } = collectChangeOverviewChanges(
    baseEntries,
    headEntries,
  );

  const pathsByArea = new Map<string | null, string[]>();
  for (const { path } of changes) {
    const prefix = overviewPathPrefix(path);
    const areaPaths = pathsByArea.get(prefix) ?? [];
    areaPaths.push(path);
    pathsByArea.set(prefix, areaPaths);
  }
  const allPathAreas = [...pathsByArea]
    .sort(([left], [right]) => {
      if (left === null) return right === null ? 0 : -1;
      if (right === null) return 1;
      return left.localeCompare(right, "en");
    })
    .map(([pathPrefix, areaPaths]) => ({
      pathPrefix,
      changedFileCount: areaPaths.length,
      samplePaths: areaPaths.slice(0, MAX_OVERVIEW_SAMPLE_PATHS),
    }));

  const warnings: RetainedChangeOverviewWarning[] = [];
  if (changes.length > MAX_OVERVIEW_CHANGED_FILES) {
    warnings.push({
      code: "changed_files_truncated",
      omittedCount: changes.length - MAX_OVERVIEW_CHANGED_FILES,
    });
  }
  if (allPathAreas.length > MAX_OVERVIEW_PATH_AREAS) {
    warnings.push({
      code: "path_areas_truncated",
      omittedCount: allPathAreas.length - MAX_OVERVIEW_PATH_AREAS,
    });
  }
  const gitlinkPaths = changes
    .filter(({ base, head }) => base?.type === "commit" || head?.type === "commit")
    .map(({ path }) => path);
  if (gitlinkPaths.length > 0) {
    warnings.push({
      affectedFileCount: gitlinkPaths.length,
      code: "gitlink_not_expanded",
      samplePaths: gitlinkPaths.slice(0, MAX_OVERVIEW_SAMPLE_PATHS),
    });
  }
  const lfsPointerPaths = changes
    .filter(({ base, head }) =>
      [base, head].some((entry) =>
        entry?.type === "blob" ? isGitLfsPointer(objects.get(entry.objectId)) : false,
      ),
    )
    .map(({ path }) => path);
  if (lfsPointerPaths.length > 0) {
    warnings.push({
      affectedFileCount: lfsPointerPaths.length,
      code: "git_lfs_pointer_not_hydrated",
      samplePaths: lfsPointerPaths.slice(0, MAX_OVERVIEW_SAMPLE_PATHS),
    });
  }

  return {
    ruleVersion: 1,
    commitStatistics: {
      baseTreeFileCount: baseByPath.size,
      headTreeFileCount: headByPath.size,
    },
    fileStatistics,
    changedFiles: changes.slice(0, MAX_OVERVIEW_CHANGED_FILES),
    pathAreas: allPathAreas.slice(0, MAX_OVERVIEW_PATH_AREAS),
    warnings,
  };
}

export interface ReadRetainedFileInput {
  artifactLocator: string;
  manifestDigest: string;
  path: string;
  side: "base" | "head";
}

export interface ReadRetainedChangeOverviewFactsInput {
  artifactLocator: string;
  manifestDigest: string;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new LocalSourceError("acquisition_cancelled");
}

function createSerialExecutor() {
  let tail = Promise.resolve();
  return async function execute<T>(action: () => Promise<T>): Promise<T> {
    const predecessor = tail;
    let release: () => void = () => undefined;
    tail = new Promise<void>((resolvePromise) => {
      release = () => resolvePromise();
    });
    await predecessor;
    try {
      return await action();
    } finally {
      release();
    }
  };
}

const serializeRetention = createSerialExecutor();

function isContained(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== ".." &&
      !isAbsolute(pathFromParent))
  );
}

function hashObject(objectFormat: GitObjectFormat, object: RawGitObject): string {
  const algorithm = objectFormat === "sha1" ? "sha1" : "sha256";
  return createHash(algorithm)
    .update(`${object.type} ${String(object.size)}\0`, "ascii")
    .update(object.content)
    .digest("hex");
}

function verifyRawObject(objectFormat: GitObjectFormat, object: RawGitObject): void {
  if (object.content.byteLength !== object.size || hashObject(objectFormat, object) !== object.id) {
    throw new LocalSourceError("object_verification_failed");
  }
}

function rootTreeId(commit: RawGitObject, objectFormat: GitObjectFormat): string {
  if (commit.type !== "commit") {
    throw new LocalSourceError("object_verification_failed");
  }
  const firstLineEnd = commit.content.indexOf(0x0a);
  if (firstLineEnd === -1) {
    throw new LocalSourceError("object_verification_failed");
  }
  const firstLine = commit.content.subarray(0, firstLineEnd).toString("ascii");
  const match = /^tree ([a-f0-9]+)$/u.exec(firstLine);
  const id = match?.[1];
  const expected = objectFormat === "sha1" ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u;
  if (id === undefined || !expected.test(id)) {
    throw new LocalSourceError("object_verification_failed");
  }
  return id;
}

function addExpectedType(
  expectedTypes: Map<string, GitObjectType>,
  objectId: string,
  type: GitObjectType,
): void {
  const existing = expectedTypes.get(objectId);
  if (existing !== undefined && existing !== type) {
    throw new LocalSourceError("object_verification_failed");
  }
  expectedTypes.set(objectId, type);
}

function canonicalJson(value: unknown): string {
  const sort = (child: unknown): unknown => {
    if (Array.isArray(child)) {
      return child.map(sort);
    }
    if (child !== null && typeof child === "object") {
      return Object.fromEntries(
        Object.entries(child)
          .sort(([left], [right]) => left.localeCompare(right, "en"))
          .map(([key, grandchild]) => [key, sort(grandchild)]),
      );
    }
    return child;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

async function writeExclusive(path: string, contents: Buffer, mode: number): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureOwnedDirectory(path: string, parentToSync?: string): Promise<string> {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new LocalSourceError("source_containment_violation");
    }
  }
  const metadata = await lstat(path).catch(() => {
    throw new LocalSourceError("source_containment_violation");
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalSourceError("source_containment_violation");
  }
  const canonical = await realpath(path).catch(() => {
    throw new LocalSourceError("source_containment_violation");
  });
  if (created) {
    await syncDirectory(canonical);
    if (parentToSync !== undefined) {
      await syncDirectory(parentToSync);
    }
  }
  return canonical;
}

async function requireOwnedDirectory(
  artifactRoot: string,
  path: string,
  missingCode: "path_not_retained" | "source_containment_violation",
): Promise<string> {
  const metadata = await lstat(path).catch(() => {
    throw new LocalSourceError(missingCode);
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalSourceError("source_containment_violation");
  }
  const canonical = await realpath(path).catch(() => {
    throw new LocalSourceError(missingCode);
  });
  if (!isContained(artifactRoot, canonical)) {
    throw new LocalSourceError("source_containment_violation");
  }
  return canonical;
}

function objectPath(root: string, objectId: string): string {
  return join(root, "objects", objectId.slice(0, 2), objectId.slice(2));
}

async function makeArtifactDirectories(
  artifactRoot: string,
  projectId: string,
): Promise<{ parent: string; project: string }> {
  const projects = await ensureOwnedDirectory(join(artifactRoot, "projects"), artifactRoot);
  const project = await ensureOwnedDirectory(join(projects, projectId), projects);
  const parent = await ensureOwnedDirectory(join(project, "revisions"), project);
  if (!isContained(artifactRoot, parent)) {
    throw new LocalSourceError("source_containment_violation");
  }
  return { parent, project };
}

async function retainRevisionExclusive(
  config: LocalSourceConfig,
  input: RetainRevisionInput,
): Promise<RetainedArtifact> {
  if (!UUID_V7.test(input.projectId) || !UUID_V7.test(input.revisionId)) {
    throw new LocalSourceError("source_containment_violation");
  }
  throwIfCancelled(input.signal);
  const currentInspection = await inspectRepository(
    config,
    input.selected.repository,
    input.signal,
  );
  if (
    currentInspection.sourceIdentity !== input.selected.sourceIdentity ||
    currentInspection.objectFormat !== input.selected.objectFormat
  ) {
    throw new LocalSourceError("repository_not_available");
  }
  const objectSources: Array<{
    inspection: RepositoryInspection;
    repository: ResolvedRepository;
  }> = [{ inspection: currentInspection, repository: input.selected.repository }];
  const fallbackSource = input.fallbackSource;
  if (fallbackSource !== undefined) {
    const inspection = await inspectRepository(config, fallbackSource.repository, input.signal);
    if (
      inspection.sourceIdentity !== fallbackSource.inspection.sourceIdentity ||
      inspection.objectFormat !== input.selected.objectFormat
    ) {
      throw new LocalSourceError("repository_not_available");
    }
    objectSources.push({ inspection, repository: fallbackSource.repository });
  }

  const format = input.selected.objectFormat;
  const withObjectSources = async <T>(
    action: (readObject: GitObjectReader) => Promise<T>,
  ): Promise<T> => {
    const readers: GitObjectReader[] = [];
    const cache = new Map<string, RawGitObject>();
    const openSource = async (index: number): Promise<T> => {
      const source = objectSources[index];
      if (source === undefined) {
        const readObject: GitObjectReader = async (objectId) => {
          throwIfCancelled(input.signal);
          const cached = cache.get(objectId);
          if (cached !== undefined) return cached;
          for (const reader of readers) {
            try {
              const object = await reader(objectId);
              cache.set(objectId, object);
              return object;
            } catch (error) {
              if (error instanceof LocalSourceError && error.code === "object_missing") continue;
              throw error;
            }
          }
          throw new LocalSourceError("object_missing");
        };
        return action(readObject);
      }
      return withGitObjectReader(
        config,
        source.repository,
        format,
        source.inspection.objectDirectories,
        async (reader) => {
          readers.push(reader);
          try {
            return await openSource(index + 1);
          } finally {
            readers.pop();
          }
        },
        "revision_limit_exceeded",
        input.signal,
      );
    };
    return openSource(0);
  };
  const { baseEntries, headEntries, objects, retainedBytes } = await withObjectSources(
    async (readObject) => {
      const commits = new Map<string, RawGitObject>();
      for (const objectId of [input.selected.base.objectId, input.selected.head.objectId]) {
        if (!commits.has(objectId)) {
          const object = await readObject(objectId);
          verifyRawObject(format, object);
          if (object.type !== "commit") {
            throw new LocalSourceError("object_verification_failed");
          }
          commits.set(objectId, object);
        }
      }
      const traversalBudget: GitTreeTraversalBudget = {
        entryCount: 0,
        manifestBytes: 4096,
        maxManifestBytes: MAX_MANIFEST_BYTES,
        objectIds: new Set<string>(),
      };
      const baseEntries = await listCommitTreeEntries(
        config,
        input.selected.repository,
        format,
        input.selected.base.objectId,
        currentInspection.objectDirectories,
        readObject,
        traversalBudget,
      );
      const headEntries = await listCommitTreeEntries(
        config,
        input.selected.repository,
        format,
        input.selected.head.objectId,
        currentInspection.objectDirectories,
        readObject,
        traversalBudget,
      );

      const expectedTypes = new Map<string, GitObjectType>();
      for (const commit of commits.values()) {
        addExpectedType(expectedTypes, commit.id, "commit");
        addExpectedType(expectedTypes, rootTreeId(commit, format), "tree");
      }
      for (const entries of [baseEntries, headEntries]) {
        for (const entry of entries) {
          if (entry.type === "tree" || entry.type === "blob") {
            addExpectedType(expectedTypes, entry.objectId, entry.type);
          }
        }
      }
      if (expectedTypes.size > config.maxObjects) {
        throw new LocalSourceError("revision_limit_exceeded");
      }

      const objects = new Map<string, RawGitObject>(commits);
      let retainedBytes = [...commits.values()].reduce((sum, object) => sum + object.size, 0);
      for (const [objectId, expectedType] of [...expectedTypes].sort(([left], [right]) =>
        left.localeCompare(right, "en"),
      )) {
        const existing = objects.get(objectId);
        const object = existing ?? (await readObject(objectId));
        verifyRawObject(format, object);
        if (object.type !== expectedType) {
          throw new LocalSourceError("object_verification_failed");
        }
        if (existing === undefined) {
          retainedBytes += object.size;
          objects.set(objectId, object);
        }
      }
      if (retainedBytes > config.maxBytes) {
        throw new LocalSourceError("revision_limit_exceeded");
      }
      return { baseEntries, headEntries, objects, retainedBytes };
    },
  );
  throwIfCancelled(input.signal);

  const baseCommit = objects.get(input.selected.base.objectId);
  const headCommit = objects.get(input.selected.head.objectId);
  if (baseCommit === undefined || headCommit === undefined) {
    throw new LocalSourceError("object_verification_failed");
  }
  const baseSuggestions = readCommitSuggestions(baseCommit);
  const headSuggestions = readCommitSuggestions(headCommit);
  const changeOverviewFacts = buildChangeOverviewFacts(baseEntries, headEntries, objects);

  const manifest: RevisionManifest = {
    schemaVersion: 1,
    objectFormat: format,
    base: {
      commitObjectId: input.selected.base.objectId,
      entries: [...baseEntries].sort((left, right) => left.path.localeCompare(right.path, "en")),
      ref: input.selected.base.ref,
    },
    head: {
      commitObjectId: input.selected.head.objectId,
      entries: [...headEntries].sort((left, right) => left.path.localeCompare(right.path, "en")),
      ref: input.selected.head.ref,
    },
    objects: [...objects.values()]
      .map(({ id, size, type }) => ({ id, size, type }))
      .sort((left, right) => left.id.localeCompare(right.id, "en")),
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new LocalSourceError("revision_limit_exceeded");
  }
  const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
  const { parent } = await makeArtifactDirectories(config.artifactRoot, input.projectId);
  const staging = join(parent, `.acquiring-${randomUUID()}`);
  const final = join(parent, input.revisionId);
  const directories = new Set<string>([staging]);
  let finalized = false;

  try {
    throwIfCancelled(input.signal);
    await mkdir(staging, { mode: 0o700 });
    const objectsDirectory = join(staging, "objects");
    await mkdir(objectsDirectory, { mode: 0o700 });
    directories.add(objectsDirectory);
    for (const object of objects.values()) {
      throwIfCancelled(input.signal);
      const prefixDirectory = join(objectsDirectory, object.id.slice(0, 2));
      if (!directories.has(prefixDirectory)) {
        await mkdir(prefixDirectory, { mode: 0o700 });
        directories.add(prefixDirectory);
      }
      await writeExclusive(objectPath(staging, object.id), object.content, 0o600);
    }
    const manifestPath = join(staging, MANIFEST_NAME);
    throwIfCancelled(input.signal);
    await writeExclusive(manifestPath, manifestBytes, 0o600);

    for (const object of objects.values()) {
      throwIfCancelled(input.signal);
      const retainedContent = await readFile(objectPath(staging, object.id));
      const retainedObject = { ...object, content: retainedContent };
      verifyRawObject(format, retainedObject);
      await chmod(objectPath(staging, object.id), 0o400);
      await syncFile(objectPath(staging, object.id));
    }
    throwIfCancelled(input.signal);
    if (
      createHash("sha256")
        .update(await readFile(manifestPath))
        .digest("hex") !== manifestDigest
    ) {
      throw new LocalSourceError("object_verification_failed");
    }
    await chmod(manifestPath, 0o400);
    await syncFile(manifestPath);
    for (const directory of [...directories].reverse()) {
      throwIfCancelled(input.signal);
      await chmod(directory, 0o500);
      await syncDirectory(directory);
    }
    if ((await lstat(final).catch(() => null)) !== null) {
      throw new LocalSourceError("object_verification_failed");
    }
    throwIfCancelled(input.signal);
    await rename(staging, final);
    finalized = true;
    await syncDirectory(parent);
    throwIfCancelled(input.signal);
  } catch (error) {
    if (finalized) {
      try {
        await rename(final, staging);
        finalized = false;
      } catch {
        await quarantineUnattachedArtifact(
          config,
          `projects/${input.projectId}/revisions/${input.revisionId}`,
        ).catch(() => undefined);
      }
    }
    if (!finalized) {
      for (const directory of directories) {
        await chmod(directory, 0o700).catch(() => undefined);
      }
      await rm(staging, { force: true, recursive: true }).catch(() => undefined);
      await syncDirectory(parent).catch(() => undefined);
    }
    throw error;
  }

  return {
    artifactLocator: `projects/${input.projectId}/revisions/${input.revisionId}`,
    baseCommitAuthor: baseSuggestions.author,
    baseCommitSubject: baseSuggestions.subject,
    changeOverviewFacts,
    headCommitAuthor: headSuggestions.author,
    headCommitSubject: headSuggestions.subject,
    manifestDigest,
    objectCount: objects.size,
    retainedBytes,
  };
}

export function retainRevision(
  config: LocalSourceConfig,
  input: RetainRevisionInput,
): Promise<RetainedArtifact> {
  throwIfCancelled(input.signal);
  return serializeRetention(() => retainRevisionExclusive(config, input));
}

function parseArtifactLocator(locator: string): [string, string] {
  const match = /^projects\/([^/]+)\/revisions\/([^/]+)$/u.exec(locator);
  const projectId = match?.[1];
  const revisionId = match?.[2];
  if (
    projectId === undefined ||
    revisionId === undefined ||
    !UUID_V7.test(projectId) ||
    !UUID_V7.test(revisionId)
  ) {
    throw new LocalSourceError("source_containment_violation");
  }
  return [projectId, revisionId];
}

function parseManifest(value: unknown): RevisionManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocalSourceError("object_verification_failed");
  }
  const candidate = value as Record<string, unknown>;
  const objectFormat = candidate["objectFormat"];
  const validObjectId = (objectId: unknown): objectId is string =>
    typeof objectId === "string" &&
    (objectFormat === "sha1" ? /^[a-f0-9]{40}$/u.test(objectId) : /^[a-f0-9]{64}$/u.test(objectId));
  const validEntries = (entries: unknown[]): entries is ManifestEntry[] =>
    entries.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        typeof (entry as ManifestEntry).path === "string" &&
        validObjectId((entry as ManifestEntry).objectId) &&
        ["040000", "100644", "100755", "120000", "160000"].includes(
          (entry as ManifestEntry).mode,
        ) &&
        ["blob", "commit", "tree"].includes((entry as ManifestEntry).type),
    );
  const base = candidate["base"];
  const head = candidate["head"];
  const objects = candidate["objects"];
  if (
    candidate["schemaVersion"] !== 1 ||
    (objectFormat !== "sha1" && objectFormat !== "sha256") ||
    !Array.isArray(objects) ||
    typeof base !== "object" ||
    base === null ||
    Array.isArray(base) ||
    typeof head !== "object" ||
    head === null ||
    Array.isArray(head)
  ) {
    throw new LocalSourceError("object_verification_failed");
  }
  const baseRecord = base as Record<string, unknown>;
  const headRecord = head as Record<string, unknown>;
  const baseEntries = baseRecord["entries"];
  const headEntries = headRecord["entries"];
  if (
    !Array.isArray(baseEntries) ||
    !Array.isArray(headEntries) ||
    !validObjectId(baseRecord["commitObjectId"]) ||
    !validObjectId(headRecord["commitObjectId"]) ||
    typeof baseRecord["ref"] !== "string" ||
    typeof headRecord["ref"] !== "string" ||
    !validEntries(baseEntries) ||
    !validEntries(headEntries) ||
    !objects.every(
      (object) =>
        typeof object === "object" &&
        object !== null &&
        !Array.isArray(object) &&
        validObjectId((object as ManifestObject).id) &&
        Number.isSafeInteger((object as ManifestObject).size) &&
        (object as ManifestObject).size >= 0 &&
        ["blob", "commit", "tree"].includes((object as ManifestObject).type),
    )
  ) {
    throw new LocalSourceError("object_verification_failed");
  }
  return {
    schemaVersion: 1,
    objectFormat,
    base: {
      commitObjectId: baseRecord["commitObjectId"],
      entries: baseEntries,
      ref: baseRecord["ref"],
    },
    head: {
      commitObjectId: headRecord["commitObjectId"],
      entries: headEntries,
      ref: headRecord["ref"],
    },
    objects: objects as ManifestObject[],
  };
}

async function readRetainedManifest(
  config: LocalSourceConfig,
  input: ReadRetainedChangeOverviewFactsInput,
): Promise<{ manifest: RevisionManifest; revisionRoot: string }> {
  if (!/^[a-f0-9]{64}$/u.test(input.manifestDigest)) {
    throw new LocalSourceError("object_verification_failed");
  }
  const [projectId, revisionId] = parseArtifactLocator(input.artifactLocator);
  const projectsRoot = await requireOwnedDirectory(
    config.artifactRoot,
    join(config.artifactRoot, "projects"),
    "path_not_retained",
  );
  const projectRoot = await requireOwnedDirectory(
    config.artifactRoot,
    join(projectsRoot, projectId),
    "path_not_retained",
  );
  const revisionsRoot = await requireOwnedDirectory(
    config.artifactRoot,
    join(projectRoot, "revisions"),
    "path_not_retained",
  );
  const revisionRoot = await requireOwnedDirectory(
    config.artifactRoot,
    join(revisionsRoot, revisionId),
    "path_not_retained",
  );
  const manifestPath = join(revisionRoot, MANIFEST_NAME);
  const metadata = await lstat(manifestPath).catch(() => {
    throw new LocalSourceError("object_verification_failed");
  });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MANIFEST_BYTES) {
    throw new LocalSourceError("object_verification_failed");
  }
  const manifestBytes = await readFile(manifestPath);
  if (createHash("sha256").update(manifestBytes).digest("hex") !== input.manifestDigest) {
    throw new LocalSourceError("object_verification_failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as unknown;
  } catch {
    throw new LocalSourceError("object_verification_failed");
  }
  return { manifest: parseManifest(parsed), revisionRoot };
}

async function readRetainedObject(
  revisionRoot: string,
  manifest: RevisionManifest,
  objectId: string,
): Promise<RawGitObject> {
  const objectMetadata = manifest.objects.find(({ id }) => id === objectId);
  if (objectMetadata === undefined) {
    throw new LocalSourceError("object_verification_failed");
  }
  const retainedPath = objectPath(revisionRoot, objectId);
  const retainedMetadata = await lstat(retainedPath).catch(() => {
    throw new LocalSourceError("object_verification_failed");
  });
  if (
    !retainedMetadata.isFile() ||
    retainedMetadata.isSymbolicLink() ||
    retainedMetadata.size !== objectMetadata.size
  ) {
    throw new LocalSourceError("object_verification_failed");
  }
  const object = { ...objectMetadata, content: await readFile(retainedPath) };
  verifyRawObject(manifest.objectFormat, object);
  return object;
}

function validateRequestedPath(path: string): void {
  const segments = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    Buffer.byteLength(path, "utf8") > 4096 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new LocalSourceError("path_not_retained");
  }
}

export async function readRetainedFile(
  config: LocalSourceConfig,
  input: ReadRetainedFileInput,
): Promise<Buffer> {
  validateRequestedPath(input.path);
  const { manifest, revisionRoot } = await readRetainedManifest(config, input);
  const entry = manifest[input.side].entries.find(({ path }) => path === input.path);
  if (entry === undefined || entry.type !== "blob") {
    throw new LocalSourceError("path_not_retained");
  }
  const object = await readRetainedObject(revisionRoot, manifest, entry.objectId);
  if (object.type !== "blob") {
    throw new LocalSourceError("object_verification_failed");
  }
  return object.content;
}

export async function readRetainedChangeOverviewFacts(
  config: LocalSourceConfig,
  input: ReadRetainedChangeOverviewFactsInput,
): Promise<RetainedChangeOverviewFacts> {
  const { manifest, revisionRoot } = await readRetainedManifest(config, input);
  const { changes } = collectChangeOverviewChanges(manifest.base.entries, manifest.head.entries);
  const blobObjectIds = new Set<string>();
  for (const change of changes) {
    for (const entry of [change.base, change.head]) {
      if (entry?.type === "blob") blobObjectIds.add(entry.objectId);
    }
  }
  const objects = new Map<string, RawGitObject>();
  for (const objectId of blobObjectIds) {
    const object = await readRetainedObject(revisionRoot, manifest, objectId);
    if (object.type !== "blob") {
      throw new LocalSourceError("object_verification_failed");
    }
    objects.set(objectId, object);
  }
  return buildChangeOverviewFacts(manifest.base.entries, manifest.head.entries, objects);
}

export async function quarantineUnattachedArtifact(
  config: LocalSourceConfig,
  artifactLocator: string,
): Promise<void> {
  const [projectId, revisionId] = parseArtifactLocator(artifactLocator);
  const projectsRoot = await requireOwnedDirectory(
    config.artifactRoot,
    join(config.artifactRoot, "projects"),
    "source_containment_violation",
  );
  const projectRoot = await requireOwnedDirectory(
    config.artifactRoot,
    join(projectsRoot, projectId),
    "source_containment_violation",
  );
  const revisionsRoot = await requireOwnedDirectory(
    config.artifactRoot,
    join(projectRoot, "revisions"),
    "source_containment_violation",
  );
  const source = join(revisionsRoot, revisionId);
  const metadata = await lstat(source).catch(() => null);
  if (metadata === null) {
    return;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalSourceError("source_containment_violation");
  }
  const canonicalSource = await realpath(source);
  if (!isContained(config.artifactRoot, canonicalSource)) {
    throw new LocalSourceError("source_containment_violation");
  }
  const quarantineRoot = await ensureOwnedDirectory(
    join(config.artifactRoot, "quarantine"),
    config.artifactRoot,
  );
  await rename(source, join(quarantineRoot, `${revisionId}-${randomUUID()}`));
  await syncDirectory(revisionsRoot);
  await syncDirectory(quarantineRoot);
}

export interface ArtifactReconciliation {
  quarantined: number;
  removedStaging: number;
}

async function makeStagingRemovable(path: string, budget: { entries: number }): Promise<void> {
  const metadata = await lstat(path).catch(() => {
    throw new LocalSourceError("source_containment_violation");
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalSourceError("source_containment_violation");
  }
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    budget.entries += 1;
    if (budget.entries > 1_000_000) {
      throw new LocalSourceError("source_containment_violation");
    }
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await makeStagingRemovable(join(path, entry.name), budget);
    }
  }
}

async function reconcileArtifactRootInternal(
  config: LocalSourceConfig,
  referencedArtifactLocators: readonly string[],
): Promise<ArtifactReconciliation> {
  const referenced = new Set(referencedArtifactLocators);
  for (const locator of referenced) {
    parseArtifactLocator(locator);
  }
  const projectsRoot = await ensureOwnedDirectory(
    join(config.artifactRoot, "projects"),
    config.artifactRoot,
  );
  let quarantined = 0;
  let removedStaging = 0;
  for (const projectEntry of await readdir(projectsRoot, { withFileTypes: true })) {
    if (
      !projectEntry.isDirectory() ||
      projectEntry.isSymbolicLink() ||
      !UUID_V7.test(projectEntry.name)
    ) {
      continue;
    }
    const projectRoot = await requireOwnedDirectory(
      config.artifactRoot,
      join(projectsRoot, projectEntry.name),
      "source_containment_violation",
    );
    const revisionsRoot = join(projectRoot, "revisions");
    const revisionsMetadata = await lstat(revisionsRoot).catch(() => null);
    if (
      revisionsMetadata === null ||
      !revisionsMetadata.isDirectory() ||
      revisionsMetadata.isSymbolicLink()
    ) {
      continue;
    }
    const revisionEntries = await readdir(revisionsRoot, { withFileTypes: true }).catch(() => []);
    for (const revisionEntry of revisionEntries) {
      if (!revisionEntry.isDirectory() || revisionEntry.isSymbolicLink()) {
        continue;
      }
      const revisionPath = join(revisionsRoot, revisionEntry.name);
      if (/^\.acquiring-[0-9a-f-]{36}$/u.test(revisionEntry.name)) {
        await makeStagingRemovable(revisionPath, { entries: 0 });
        await rm(revisionPath, { force: true, recursive: true });
        await syncDirectory(revisionsRoot);
        removedStaging += 1;
        continue;
      }
      if (!UUID_V7.test(revisionEntry.name)) {
        continue;
      }
      const locator = `projects/${projectEntry.name}/revisions/${revisionEntry.name}`;
      if (!referenced.has(locator)) {
        await quarantineUnattachedArtifact(config, locator);
        quarantined += 1;
      }
    }
  }
  return { quarantined, removedStaging };
}

export async function reconcileArtifactRoot(
  config: LocalSourceConfig,
  referencedArtifactLocators: readonly string[],
): Promise<ArtifactReconciliation> {
  try {
    return await reconcileArtifactRootInternal(config, referencedArtifactLocators);
  } catch (error) {
    if (error instanceof LocalSourceError) {
      throw error;
    }
    throw new LocalSourceError("object_verification_failed");
  }
}
