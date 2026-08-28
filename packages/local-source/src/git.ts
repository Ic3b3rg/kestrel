import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { LocalSourceConfig } from "./config.js";
import type { ResolvedRepository } from "./discovery.js";
import { LocalSourceError, type LocalSourceErrorCode } from "./errors.js";

const MAX_GIT_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_GIT_STDERR_BYTES = 64 * 1024;
const MAX_ALTERNATES_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_GIT_METADATA_ENTRIES = 10_000;
const MAX_ALTERNATE_OBJECT_DIRECTORIES = 100;
const GIT_TIMEOUT_MS = 10_000;
const MAX_REFERENCES = 500;
const REFERENCE_INSPECTION_MAX_BYTES = 64 * 1024 * 1024;
const REFERENCE_INSPECTION_MAX_OBJECTS = MAX_REFERENCES * 17;
const MAX_COMMITTED_ENTRIES = 100_000;
const DEFAULT_TREE_MANIFEST_BUDGET_BYTES = 16 * 1024 * 1024 - 4096;

const SAFE_GIT_ENV: NodeJS.ProcessEnv = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
});

export type GitObjectFormat = "sha1" | "sha256";

export interface GitHubRepositoryIdentity {
  name: string;
  owner: string;
}

export interface RepositoryInspection {
  githubRepository: GitHubRepositoryIdentity | null;
  /** Validated server-only paths. Never serialize this inspection object into an HTTP response. */
  objectDirectories: readonly string[];
  objectFormat: GitObjectFormat;
  sourceIdentity: string;
}

export interface RepositoryReference {
  commitObjectId: string;
  commitSubjectSuggestion: string | null;
  displayName: string;
  kind: "head" | "local_branch" | "remote_branch" | "tag";
  ref: string;
}

export interface RepositoryReferenceInventory {
  objectFormat: GitObjectFormat;
  references: readonly RepositoryReference[];
  repositoryId: string;
}

export interface SelectedRevision extends RepositoryInspection {
  base: { objectId: string; ref: string };
  head: { objectId: string; ref: string };
  repository: ResolvedRepository;
}

interface GitResult {
  exitCode: number;
  stdout: Buffer;
}

function repositoryGitArguments(repository: ResolvedRepository, args: readonly string[]): string[] {
  return [
    "--no-lazy-fetch",
    "-c",
    `safe.directory=${repository.path}`,
    "-C",
    repository.path,
    ...args,
  ];
}

function isContained(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== ".." &&
      !isAbsolute(pathFromParent))
  );
}

async function runGit(
  config: LocalSourceConfig,
  repository: ResolvedRepository,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [0],
  input?: Buffer,
  maxStdoutBytes = MAX_GIT_STDOUT_BYTES,
  timeoutMs = GIT_TIMEOUT_MS,
  stdoutLimitCode: LocalSourceErrorCode = "git_inspection_failed",
  unexpectedExitCode: LocalSourceErrorCode = "repository_invalid",
  signal?: AbortSignal,
): Promise<GitResult> {
  return new Promise<GitResult>((resolvePromise, rejectPromise) => {
    if (signal?.aborted === true) {
      rejectPromise(new LocalSourceError("acquisition_cancelled"));
      return;
    }
    const child = spawn(config.gitExecutable, repositoryGitArguments(repository, args), {
      detached: process.platform !== "win32",
      env: SAFE_GIT_ENV,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let rejected = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const terminate = () => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall back to killing the direct child if its process group already exited.
        }
      }
      child.kill("SIGKILL");
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref();
    const finish = (result?: GitResult, error?: LocalSourceError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) rejectPromise(error);
      else if (result !== undefined) resolvePromise(result);
      else rejectPromise(new LocalSourceError("git_inspection_failed"));
    };
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdin.on("error", () => {
      rejected = true;
      terminate();
    });
    child.stdin.end(input);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        rejected = true;
        terminate();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_GIT_STDERR_BYTES) {
        rejected = true;
        terminate();
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", () => finish(undefined, new LocalSourceError("git_inspection_failed")));
    child.once("close", (exitCode) => {
      if (cancelled) {
        finish(undefined, new LocalSourceError("acquisition_cancelled"));
        return;
      }
      if (rejected || timedOut || exitCode === null) {
        finish(
          undefined,
          new LocalSourceError(
            rejected && stdoutBytes > maxStdoutBytes ? stdoutLimitCode : "git_inspection_failed",
          ),
        );
        return;
      }
      if (!allowedExitCodes.includes(exitCode)) {
        finish(undefined, new LocalSourceError(unexpectedExitCode));
        return;
      }
      finish({ exitCode, stdout: Buffer.concat(stdout, stdoutBytes) });
    });
  });
}

function runInspectionGit(
  config: LocalSourceConfig,
  repository: ResolvedRepository,
  args: readonly string[],
  signal?: AbortSignal,
  allowedExitCodes: readonly number[] = [0],
): Promise<GitResult> {
  return runGit(
    config,
    repository,
    args,
    allowedExitCodes,
    undefined,
    MAX_GIT_STDOUT_BYTES,
    GIT_TIMEOUT_MS,
    "git_inspection_failed",
    "repository_invalid",
    signal,
  );
}

export type GitObjectType = "blob" | "commit" | "tag" | "tree";

export interface RawGitObject {
  content: Buffer;
  id: string;
  size: number;
  type: GitObjectType;
}

export interface GitTreeEntry {
  mode: "040000" | "100644" | "100755" | "120000" | "160000";
  objectId: string;
  path: string;
  type: "blob" | "commit" | "tree";
}

export interface GitTreeTraversalBudget {
  entryCount: number;
  manifestBytes: number;
  maxManifestBytes: number;
  objectIds: Set<string>;
}

function hashObject(objectFormat: GitObjectFormat, object: RawGitObject): string {
  return createHash(objectFormat === "sha1" ? "sha1" : "sha256")
    .update(`${object.type} ${String(object.size)}\0`, "ascii")
    .update(object.content)
    .digest("hex");
}

async function validateLooseObjectPaths(
  objectDirectories: readonly string[],
  objectId: string,
): Promise<void> {
  for (const objectDirectory of objectDirectories) {
    const prefixDirectory = join(objectDirectory, objectId.slice(0, 2));
    let prefixMetadata;
    try {
      prefixMetadata = await lstat(prefixDirectory);
    } catch {
      continue;
    }
    if (!prefixMetadata.isDirectory() || prefixMetadata.isSymbolicLink()) {
      throw new LocalSourceError("source_containment_violation");
    }
    const objectPath = join(prefixDirectory, objectId.slice(2));
    let objectMetadata;
    try {
      objectMetadata = await lstat(objectPath);
    } catch {
      continue;
    }
    if (!objectMetadata.isFile() || objectMetadata.isSymbolicLink()) {
      throw new LocalSourceError("source_containment_violation");
    }
  }
}

export type GitObjectReader = (objectId: string) => Promise<RawGitObject>;

class BufferedGitOutput {
  private availableBytes = 0;
  private readonly chunks: Array<Buffer | undefined> = [];
  private headIndex = 0;
  private headOffset = 0;
  private readonly iterator: AsyncIterator<Buffer>;
  private receivedBytes = 0;

  constructor(
    output: NodeJS.ReadableStream,
    private readonly maxBytes: number,
    private readonly limitCode: LocalSourceErrorCode = "revision_limit_exceeded",
  ) {
    this.iterator = output[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  private async receive(): Promise<void> {
    const next = await this.iterator.next();
    if (next.done === true) throw new LocalSourceError("git_inspection_failed");
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    this.receivedBytes += chunk.byteLength;
    if (this.receivedBytes > this.maxBytes) {
      throw new LocalSourceError(this.limitCode);
    }
    this.chunks.push(chunk);
    this.availableBytes += chunk.byteLength;
  }

  private consume(length: number): Buffer {
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const head = this.chunks[this.headIndex];
      if (head === undefined) throw new LocalSourceError("git_inspection_failed");
      const copied = Math.min(length - written, head.byteLength - this.headOffset);
      head.copy(result, written, this.headOffset, this.headOffset + copied);
      written += copied;
      this.headOffset += copied;
      this.availableBytes -= copied;
      if (this.headOffset === head.byteLength) {
        this.chunks[this.headIndex] = undefined;
        this.headIndex += 1;
        this.headOffset = 0;
        if (this.headIndex >= 1024 && this.headIndex * 2 >= this.chunks.length) {
          this.chunks.splice(0, this.headIndex);
          this.headIndex = 0;
        }
      }
    }
    return result;
  }

  private lineLength(): number | null {
    let length = 0;
    for (let index = this.headIndex; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      if (chunk === undefined) throw new LocalSourceError("git_inspection_failed");
      const start = index === this.headIndex ? this.headOffset : 0;
      const newline = chunk.indexOf(0x0a, start);
      if (newline !== -1) return length + newline - start;
      length += chunk.byteLength - start;
    }
    return null;
  }

  async line(): Promise<Buffer> {
    for (;;) {
      const length = this.lineLength();
      if (length !== null) return this.consume(length + 1).subarray(0, length);
      await this.receive();
    }
  }

  async bytes(length: number): Promise<Buffer> {
    while (this.availableBytes < length) await this.receive();
    return this.consume(length);
  }
}

export async function withGitObjectReader<T>(
  config: LocalSourceConfig,
  repository: ResolvedRepository,
  objectFormat: GitObjectFormat,
  objectDirectories: readonly string[],
  action: (readObject: GitObjectReader) => Promise<T>,
  limitCode: LocalSourceErrorCode = "revision_limit_exceeded",
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted === true) throw new LocalSourceError("acquisition_cancelled");
  const child = spawn(
    config.gitExecutable,
    repositoryGitArguments(repository, ["cat-file", "--batch"]),
    {
      detached: process.platform !== "win32",
      env: SAFE_GIT_ENV,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const terminate = () => {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // Fall back to the direct child when its process group is already gone.
      }
    }
    child.kill("SIGKILL");
  };
  let cancelled = false;
  let rejectCancellation: (error: LocalSourceError) => void = () => undefined;
  const cancellation = new Promise<never>((_resolvePromise, rejectPromise) => {
    rejectCancellation = rejectPromise;
  });
  const onAbort = () => {
    cancelled = true;
    terminate();
    rejectCancellation(new LocalSourceError("acquisition_cancelled"));
  };
  const isCancelled = () => cancelled || signal?.aborted === true;
  signal?.addEventListener("abort", onAbort, { once: true });
  let stderrBytes = 0;
  child.stdin.on("error", () => {
    terminate();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > MAX_GIT_STDERR_BYTES) {
      terminate();
    }
  });
  const completion = new Promise<number | null>((resolveCompletion) => {
    let completed = false;
    const complete = (exitCode: number | null) => {
      if (completed) return;
      completed = true;
      resolveCompletion(exitCode);
    };
    child.once("error", () => {
      complete(null);
    });
    child.once("exit", complete);
    child.once("close", complete);
  });
  const timer = setTimeout(() => {
    terminate();
  }, config.gitObjectReadTimeoutMs);
  timer.unref();
  const maximumOutput = Math.min(
    1024 * 1024 * 1024 + 64 * 1024 * 1024,
    config.maxBytes + Math.min(config.maxObjects, 1_000_000) * 160 + 1024,
  );
  const output = new BufferedGitOutput(child.stdout, maximumOutput, limitCode);
  const cache = new Map<string, RawGitObject>();
  let retainedBytes = 0;

  const writeObjectRequest = async (objectId: string): Promise<void> => {
    if (isCancelled()) {
      throw new LocalSourceError("acquisition_cancelled");
    }
    if (child.stdin.destroyed || child.stdin.errored !== null) {
      throw new LocalSourceError("git_inspection_failed");
    }
    if (child.stdin.write(`${objectId}\n`, "ascii")) return;
    await new Promise<void>((resolveDrain, rejectDrain) => {
      const cleanup = () => {
        child.stdin.off("drain", onDrain);
        child.stdin.off("error", onError);
      };
      const onDrain = () => {
        cleanup();
        resolveDrain();
      };
      const onError = () => {
        cleanup();
        rejectDrain(new LocalSourceError("git_inspection_failed"));
      };
      child.stdin.once("drain", onDrain);
      child.stdin.once("error", onError);
    });
  };

  const readObject: GitObjectReader = async (objectId) => {
    if (isCancelled()) {
      throw new LocalSourceError("acquisition_cancelled");
    }
    validateObjectId(objectId, objectFormat);
    const cached = cache.get(objectId);
    if (cached !== undefined) return cached;
    if (cache.size >= config.maxObjects) {
      throw new LocalSourceError(limitCode);
    }
    await validateLooseObjectPaths(objectDirectories, objectId);
    await writeObjectRequest(objectId);
    const header = (await output.line()).toString("ascii");
    if (header === `${objectId} missing`) throw new LocalSourceError("object_missing");
    const match = /^([a-f0-9]+) (blob|commit|tag|tree) ([0-9]+)$/u.exec(header);
    if (match === null || match[1] !== objectId) {
      throw new LocalSourceError("object_verification_failed");
    }
    const type = match[2] as GitObjectType;
    const size = Number(match[3]);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > config.maxBytes ||
      retainedBytes + size > config.maxBytes
    ) {
      throw new LocalSourceError(limitCode);
    }
    const framedContent = await output.bytes(size + 1);
    if (framedContent[size] !== 0x0a) {
      throw new LocalSourceError("object_verification_failed");
    }
    const object = {
      content: framedContent.subarray(0, size),
      id: objectId,
      size,
      type,
    } satisfies RawGitObject;
    if (hashObject(objectFormat, object) !== objectId) {
      throw new LocalSourceError("object_verification_failed");
    }
    retainedBytes += size;
    cache.set(objectId, object);
    return object;
  };

  try {
    const result = await Promise.race([action(readObject), cancellation]);
    if (isCancelled()) {
      throw new LocalSourceError("acquisition_cancelled");
    }
    child.stdin.end();
    const exitCode = await completion;
    if (isCancelled()) {
      throw new LocalSourceError("acquisition_cancelled");
    }
    if (child.stdin.errored !== null || exitCode !== 0) {
      throw new LocalSourceError("git_inspection_failed");
    }
    return result;
  } catch (error) {
    terminate();
    await completion;
    if (isCancelled()) {
      throw new LocalSourceError("acquisition_cancelled");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function readRawGitObject(
  config: LocalSourceConfig,
  repository: ResolvedRepository,
  objectFormat: GitObjectFormat,
  objectId: string,
  inspectedObjectDirectories?: readonly string[],
): Promise<RawGitObject> {
  validateObjectId(objectId, objectFormat);
  const objectDirectories =
    inspectedObjectDirectories ?? (await inspectRepository(config, repository)).objectDirectories;
  return withGitObjectReader(config, repository, objectFormat, objectDirectories, (readObject) =>
    readObject(objectId),
  );
}

function validateTreePath(pathBytes: Buffer): string {
  if (pathBytes.byteLength === 0 || pathBytes.byteLength > 4096) {
    throw new LocalSourceError("repository_invalid");
  }
  const path = decodeUtf8(pathBytes);
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new LocalSourceError("repository_invalid");
  }
  return path;
}

function reserveTraversalObject(
  config: LocalSourceConfig,
  budget: GitTreeTraversalBudget,
  objectId: string,
): void {
  if (budget.objectIds.has(objectId)) return;
  if (
    budget.objectIds.size >= config.maxObjects ||
    budget.manifestBytes + 256 > budget.maxManifestBytes
  ) {
    throw new LocalSourceError("revision_limit_exceeded");
  }
  budget.objectIds.add(objectId);
  budget.manifestBytes += 256;
}

function consumeTreeEntryBudget(
  config: LocalSourceConfig,
  budget: GitTreeTraversalBudget,
  entry: GitTreeEntry,
): void {
  const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + 128;
  if (budget.entryCount >= MAX_COMMITTED_ENTRIES) {
    throw new LocalSourceError("revision_limit_exceeded");
  }
  if (entry.type !== "commit") {
    reserveTraversalObject(config, budget, entry.objectId);
  }
  if (budget.manifestBytes + entryBytes > budget.maxManifestBytes) {
    throw new LocalSourceError("revision_limit_exceeded");
  }
  budget.entryCount += 1;
  budget.manifestBytes += entryBytes;
}

export async function listCommitTreeEntries(
  config: LocalSourceConfig,
  repository: ResolvedRepository,
  objectFormat: GitObjectFormat,
  commitObjectId: string,
  inspectedObjectDirectories?: readonly string[],
  objectReader?: GitObjectReader,
  traversalBudget: GitTreeTraversalBudget = {
    entryCount: 0,
    manifestBytes: 0,
    maxManifestBytes: DEFAULT_TREE_MANIFEST_BUDGET_BYTES,
    objectIds: new Set<string>(),
  },
): Promise<readonly GitTreeEntry[]> {
  validateObjectId(commitObjectId, objectFormat);
  const objectDirectories =
    inspectedObjectDirectories ?? (await inspectRepository(config, repository)).objectDirectories;
  if (objectReader === undefined) {
    return withGitObjectReader(config, repository, objectFormat, objectDirectories, (readObject) =>
      listCommitTreeEntries(
        config,
        repository,
        objectFormat,
        commitObjectId,
        objectDirectories,
        readObject,
        traversalBudget,
      ),
    );
  }
  const commit = await objectReader(commitObjectId);
  if (commit.type !== "commit") {
    throw new LocalSourceError("object_verification_failed");
  }
  const firstLineEnd = commit.content.indexOf(0x0a);
  const treeMatch =
    firstLineEnd === -1
      ? null
      : /^tree ([a-f0-9]+)$/u.exec(commit.content.subarray(0, firstLineEnd).toString("ascii"));
  const rootTreeId = treeMatch?.[1];
  if (rootTreeId === undefined) {
    throw new LocalSourceError("object_verification_failed");
  }
  validateObjectId(rootTreeId, objectFormat);
  reserveTraversalObject(config, traversalBudget, commitObjectId);
  reserveTraversalObject(config, traversalBudget, rootTreeId);

  const entries: GitTreeEntry[] = [];
  const seenPaths = new Set<string>();
  const objectIdBytes = objectFormat === "sha1" ? 20 : 32;
  const queue: Array<{ objectId: string; prefix: string }> = [{ objectId: rootTreeId, prefix: "" }];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const item = queue[cursor];
    if (item === undefined) break;
    const tree = await objectReader(item.objectId);
    if (tree.type !== "tree") {
      throw new LocalSourceError("object_verification_failed");
    }
    let offset = 0;
    while (offset < tree.content.byteLength) {
      const modeEnd = tree.content.indexOf(0x20, offset);
      const nameEnd = modeEnd === -1 ? -1 : tree.content.indexOf(0x00, modeEnd + 1);
      const objectIdEnd = nameEnd === -1 ? -1 : nameEnd + 1 + objectIdBytes;
      if (modeEnd === -1 || nameEnd === -1 || objectIdEnd > tree.content.byteLength) {
        throw new LocalSourceError("repository_invalid");
      }
      const rawMode = tree.content.subarray(offset, modeEnd).toString("ascii");
      const mode = (rawMode === "40000" ? "040000" : rawMode) as GitTreeEntry["mode"];
      let type: GitTreeEntry["type"];
      if (mode === "040000") type = "tree";
      else if (["100644", "100755", "120000"].includes(mode)) type = "blob";
      else if (mode === "160000") type = "commit";
      else throw new LocalSourceError("repository_invalid");
      const name = validateTreePath(tree.content.subarray(modeEnd + 1, nameEnd));
      if (name.includes("/")) {
        throw new LocalSourceError("repository_invalid");
      }
      const path = validateTreePath(
        Buffer.from(item.prefix === "" ? name : `${item.prefix}/${name}`),
      );
      const objectId = validateObjectId(
        tree.content.subarray(nameEnd + 1, objectIdEnd).toString("hex"),
        objectFormat,
      );
      if (seenPaths.has(path)) {
        throw new LocalSourceError("repository_invalid");
      }
      seenPaths.add(path);
      const entry = { mode, objectId, path, type } satisfies GitTreeEntry;
      consumeTreeEntryBudget(config, traversalBudget, entry);
      entries.push(entry);
      if (type === "tree") {
        queue.push({ objectId, prefix: path });
      }
      offset = objectIdEnd;
    }
  }
  return entries;
}

function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new LocalSourceError("repository_invalid");
  }
}

function oneLine(value: Buffer): string {
  const decoded = decodeUtf8(value).trim();
  if (decoded === "" || decoded.includes("\n") || decoded.includes("\r")) {
    throw new LocalSourceError("repository_invalid");
  }
  return decoded;
}

function validateObjectId(value: string, objectFormat: GitObjectFormat): string {
  const expression = objectFormat === "sha1" ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u;
  if (!expression.test(value)) {
    throw new LocalSourceError("repository_invalid");
  }
  return value;
}

async function canonicalGitPath(
  config: LocalSourceConfig,
  repository: ResolvedRepository,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const path = oneLine((await runInspectionGit(config, repository, args, signal)).stdout);
  return canonicalContainedDirectory(repository, path);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function canonicalContainedDirectory(
  repository: ResolvedRepository,
  path: string,
): Promise<string> {
  const normalized = resolve(path);
  if (!isContained(repository.rootPath, normalized)) {
    throw new LocalSourceError("source_containment_violation");
  }
  const metadata = await lstat(normalized).catch(() => {
    throw new LocalSourceError("repository_invalid");
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalSourceError("source_containment_violation");
  }
  const canonical = await realpath(normalized).catch(() => {
    throw new LocalSourceError("repository_invalid");
  });
  if (canonical !== normalized || !isContained(repository.rootPath, canonical)) {
    throw new LocalSourceError("source_containment_violation");
  }
  return canonical;
}

async function readContainedFile(
  repository: ResolvedRepository,
  path: string,
  maxBytes: number,
  required = false,
): Promise<Buffer | null> {
  const normalized = resolve(path);
  if (!isContained(repository.rootPath, normalized)) {
    throw new LocalSourceError("source_containment_violation");
  }
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(normalized);
  } catch (error) {
    if (!required && isMissing(error)) return null;
    throw new LocalSourceError("repository_invalid");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
    throw new LocalSourceError("source_containment_violation");
  }
  const canonical = await realpath(normalized).catch(() => {
    throw new LocalSourceError("repository_invalid");
  });
  if (canonical !== normalized || !isContained(repository.rootPath, canonical)) {
    throw new LocalSourceError("source_containment_violation");
  }
  return readFile(normalized);
}

function rejectConfigIncludes(contents: Buffer): void {
  const config = decodeUtf8(contents);
  for (const line of config.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (/^\[\s*include(?:if)?(?:\s|\])/iu.test(trimmed)) {
      throw new LocalSourceError("source_containment_violation");
    }
  }
}

interface AdministrativePaths {
  commonGitDirectory: string;
  gitDirectory: string;
}

async function deriveAdministrativePaths(
  repository: ResolvedRepository,
): Promise<AdministrativePaths> {
  const markerPath = join(repository.path, ".git");
  let markerMetadata: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    markerMetadata = await lstat(markerPath);
  } catch (error) {
    if (!isMissing(error)) throw new LocalSourceError("repository_invalid");
  }

  let gitDirectory: string;
  if (markerMetadata?.isDirectory() === true && !markerMetadata.isSymbolicLink()) {
    gitDirectory = await canonicalContainedDirectory(repository, markerPath);
  } else if (markerMetadata?.isFile() === true && !markerMetadata.isSymbolicLink()) {
    const marker = oneLine((await readContainedFile(repository, markerPath, 4096, true)) as Buffer);
    const match = /^gitdir: (.+)$/u.exec(marker);
    if (match?.[1] === undefined || /[\0\r\n]/u.test(match[1])) {
      throw new LocalSourceError("repository_invalid");
    }
    gitDirectory = await canonicalContainedDirectory(
      repository,
      isAbsolute(match[1]) ? match[1] : resolve(repository.path, match[1]),
    );
  } else if (markerMetadata === null) {
    gitDirectory = await canonicalContainedDirectory(repository, repository.path);
  } else {
    throw new LocalSourceError("source_containment_violation");
  }

  const commonDirectoryFile = await readContainedFile(
    repository,
    join(gitDirectory, "commondir"),
    4096,
  );
  const commonGitDirectory =
    commonDirectoryFile === null
      ? gitDirectory
      : await canonicalContainedDirectory(
          repository,
          isAbsolute(oneLine(commonDirectoryFile))
            ? oneLine(commonDirectoryFile)
            : resolve(gitDirectory, oneLine(commonDirectoryFile)),
        );

  for (const configPath of new Set([
    join(commonGitDirectory, "config"),
    join(gitDirectory, "config"),
    join(gitDirectory, "config.worktree"),
  ])) {
    const contents = await readContainedFile(repository, configPath, MAX_CONFIG_BYTES);
    if (contents !== null) rejectConfigIncludes(contents);
  }
  return { commonGitDirectory, gitDirectory };
}

async function boundedDirectoryEntries(
  path: string,
  budget: { entries: number },
): Promise<Dirent[]> {
  let directory;
  try {
    directory = await opendir(path);
  } catch {
    throw new LocalSourceError("repository_invalid");
  }
  const entries: Dirent[] = [];
  for await (const entry of directory) {
    budget.entries += 1;
    if (budget.entries > MAX_GIT_METADATA_ENTRIES) {
      throw new LocalSourceError("repository_invalid");
    }
    entries.push(entry);
  }
  return entries;
}

async function validateMetadataDirectory(
  repository: ResolvedRepository,
  directoryPath: string,
  budget: { entries: number },
  optional = true,
): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(directoryPath);
  } catch (error) {
    if (optional && isMissing(error)) return;
    throw new LocalSourceError("repository_invalid");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalSourceError("source_containment_violation");
  }
  await canonicalContainedDirectory(repository, directoryPath);
  const queue = [directoryPath];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) break;
    for (const entry of await boundedDirectoryEntries(current, budget)) {
      const child = join(current, entry.name);
      const childMetadata = await lstat(child).catch(() => {
        throw new LocalSourceError("repository_invalid");
      });
      if (childMetadata.isSymbolicLink()) {
        throw new LocalSourceError("source_containment_violation");
      }
      if (childMetadata.isDirectory()) {
        await canonicalContainedDirectory(repository, child);
        queue.push(child);
      } else if (!childMetadata.isFile()) {
        throw new LocalSourceError("source_containment_violation");
      }
    }
  }
}

async function validateReferenceStorage(
  repository: ResolvedRepository,
  paths: AdministrativePaths,
): Promise<void> {
  const budget = { entries: 0 };
  for (const directory of new Set([
    join(paths.gitDirectory, "refs"),
    join(paths.commonGitDirectory, "refs"),
    join(paths.gitDirectory, "reftable"),
    join(paths.commonGitDirectory, "reftable"),
  ])) {
    await validateMetadataDirectory(repository, directory, budget);
  }
  await readContainedFile(repository, join(paths.gitDirectory, "HEAD"), 4096, true);
  for (const path of new Set([
    join(paths.gitDirectory, "packed-refs"),
    join(paths.commonGitDirectory, "packed-refs"),
  ])) {
    await readContainedFile(repository, path, MAX_GIT_STDOUT_BYTES);
  }
}

async function validateObjectStorage(
  repository: ResolvedRepository,
  primaryObjectDirectory: string,
): Promise<readonly string[]> {
  const budget = { entries: 0 };
  const queue = [primaryObjectDirectory];
  const validated = new Set<string>();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if (queue.length > MAX_ALTERNATE_OBJECT_DIRECTORIES) {
      throw new LocalSourceError("repository_invalid");
    }
    const objectDirectory = await canonicalContainedDirectory(repository, queue[cursor] ?? "");
    if (validated.has(objectDirectory)) continue;
    validated.add(objectDirectory);

    for (const entry of await boundedDirectoryEntries(objectDirectory, budget)) {
      const child = join(objectDirectory, entry.name);
      const childMetadata = await lstat(child).catch(() => {
        throw new LocalSourceError("repository_invalid");
      });
      if (childMetadata.isSymbolicLink()) {
        throw new LocalSourceError("source_containment_violation");
      }
      if (/^[a-f0-9]{2}$/u.test(entry.name)) {
        if (!childMetadata.isDirectory()) {
          throw new LocalSourceError("source_containment_violation");
        }
        await canonicalContainedDirectory(repository, child);
      }
    }
    await validateMetadataDirectory(repository, join(objectDirectory, "info"), budget);
    await validateMetadataDirectory(repository, join(objectDirectory, "pack"), budget);
    if (
      (await readContainedFile(
        repository,
        join(objectDirectory, "info", "http-alternates"),
        MAX_ALTERNATES_BYTES,
      )) !== null
    ) {
      throw new LocalSourceError("source_containment_violation");
    }
    const alternates = await readContainedFile(
      repository,
      join(objectDirectory, "info", "alternates"),
      MAX_ALTERNATES_BYTES,
    );
    if (alternates === null) continue;
    for (const line of decodeUtf8(alternates).split(/\r?\n/u)) {
      if (line === "") continue;
      if (Buffer.byteLength(line, "utf8") > 4096 || /[\0\p{Cc}]/u.test(line)) {
        throw new LocalSourceError("source_containment_violation");
      }
      const alternatePath = isAbsolute(line) ? line : resolve(objectDirectory, line);
      const canonical = await canonicalContainedDirectory(repository, alternatePath);
      if (!validated.has(canonical)) queue.push(canonical);
    }
  }
  return [...validated];
}

async function validateWorkTree(
  config: LocalSourceConfig,
  repository: ResolvedRepository,
  signal?: AbortSignal,
): Promise<void> {
  const bare = oneLine(
    (await runInspectionGit(config, repository, ["rev-parse", "--is-bare-repository"], signal))
      .stdout,
  );
  if (bare === "false") {
    await canonicalGitPath(config, repository, ["rev-parse", "--show-toplevel"], signal);
  } else if (bare !== "true") {
    throw new LocalSourceError("repository_invalid");
  }
}

async function requireMatchingGitPath(
  config: LocalSourceConfig,
  repository: ResolvedRepository,
  expected: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  if ((await canonicalGitPath(config, repository, args, signal)) !== expected) {
    throw new LocalSourceError("source_containment_violation");
  }
}

function sanitizeGitHubRemote(value: string): GitHubRepositoryIdentity | null {
  let owner: string | undefined;
  let name: string | undefined;
  const scpMatch = /^git@github\.com:([^/]+)\/([^/?#]+)$/iu.exec(value);
  if (scpMatch !== null) {
    owner = scpMatch[1];
    name = scpMatch[2];
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (
      url.hostname.toLowerCase() !== "github.com" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.protocol === "https:" && (url.username !== "" || url.password !== "")) ||
      !["https:", "ssh:"].includes(url.protocol)
    ) {
      return null;
    }
    const segments = url.pathname.replace(/^\//u, "").split("/");
    if (segments.length !== 2) {
      return null;
    }
    [owner, name] = segments;
  }
  name = name?.replace(/\.git$/iu, "");
  if (
    owner === undefined ||
    name === undefined ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner) ||
    !/^[A-Za-z0-9._-]{1,100}$/u.test(name)
  ) {
    return null;
  }
  return { name, owner };
}

async function readGitHubRepository(
  config: LocalSourceConfig,
  repository: ResolvedRepository,
  signal?: AbortSignal,
): Promise<GitHubRepositoryIdentity | null> {
  const result = await runInspectionGit(
    config,
    repository,
    ["config", "--local", "--no-includes", "--get-regexp", "^remote\\..*\\.url$"],
    signal,
    [0, 1],
  );
  if (result.exitCode === 1) {
    return null;
  }
  const identities: Array<{ identity: GitHubRepositoryIdentity; remote: string }> = [];
  for (const line of decodeUtf8(result.stdout).split("\n")) {
    const separator = line.indexOf(" ");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator);
    const remoteMatch = /^remote\.(.+)\.url$/iu.exec(key);
    if (remoteMatch?.[1] === undefined) {
      continue;
    }
    const identity = sanitizeGitHubRemote(line.slice(separator + 1));
    if (identity !== null) {
      identities.push({ identity, remote: remoteMatch[1] });
    }
  }
  const origin = identities.filter(({ remote }) => remote.toLocaleLowerCase("en-US") === "origin");
  const candidates = origin.length > 0 ? origin : identities;
  const distinct = new Map<string, GitHubRepositoryIdentity>();
  for (const { identity } of candidates) {
    distinct.set(
      `${identity.owner.toLocaleLowerCase("en-US")}/${identity.name.toLocaleLowerCase("en-US")}`,
      identity,
    );
  }
  return distinct.size === 1 ? ([...distinct.values()][0] ?? null) : null;
}

export async function inspectRepository(
  config: LocalSourceConfig,
  repository: ResolvedRepository,
  signal?: AbortSignal,
): Promise<RepositoryInspection> {
  const administrativePaths = await deriveAdministrativePaths(repository);
  await validateWorkTree(config, repository, signal);
  const objectFormatValue = oneLine(
    (
      await runInspectionGit(
        config,
        repository,
        ["rev-parse", "--show-object-format=storage"],
        signal,
      )
    ).stdout,
  );
  if (objectFormatValue !== "sha1" && objectFormatValue !== "sha256") {
    throw new LocalSourceError("repository_invalid");
  }
  const objectFormat: GitObjectFormat = objectFormatValue;
  await requireMatchingGitPath(
    config,
    repository,
    administrativePaths.gitDirectory,
    ["rev-parse", "--absolute-git-dir"],
    signal,
  );
  await requireMatchingGitPath(
    config,
    repository,
    administrativePaths.commonGitDirectory,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    signal,
  );
  const objectDirectory = await canonicalGitPath(
    config,
    repository,
    ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
    signal,
  );
  const expectedObjectDirectory = await canonicalContainedDirectory(
    repository,
    join(administrativePaths.commonGitDirectory, "objects"),
  );
  if (objectDirectory !== expectedObjectDirectory) {
    throw new LocalSourceError("source_containment_violation");
  }
  await validateReferenceStorage(repository, administrativePaths);
  const objectDirectories = await validateObjectStorage(repository, objectDirectory);
  const sourceIdentity = createHash("sha256")
    .update("kestrel.local-repository-source.v1")
    .update("\0")
    .update(administrativePaths.commonGitDirectory)
    .update("\0")
    .update(objectFormat)
    .digest("hex");
  return {
    githubRepository: await readGitHubRepository(config, repository, signal),
    objectDirectories,
    objectFormat,
    sourceIdentity,
  };
}

function parseReferenceKind(ref: string): RepositoryReference["kind"] | null {
  if (ref === "HEAD") {
    return "head";
  }
  if (ref.startsWith("refs/heads/")) {
    return "local_branch";
  }
  if (ref.startsWith("refs/remotes/")) {
    return "remote_branch";
  }
  if (ref.startsWith("refs/tags/")) {
    return "tag";
  }
  return null;
}

function referenceDisplayName(ref: string, kind: RepositoryReference["kind"]): string {
  switch (kind) {
    case "head":
      return "HEAD";
    case "local_branch":
      return ref.slice("refs/heads/".length);
    case "remote_branch":
      return ref.slice("refs/remotes/".length);
    case "tag":
      return ref.slice("refs/tags/".length);
  }
}

interface RawReference {
  objectId: string;
  ref: string;
}

function parseRawReferences(output: Buffer, objectFormat: GitObjectFormat): RawReference[] {
  const references: RawReference[] = [];
  for (const line of decodeUtf8(output).split("\n")) {
    if (line === "") continue;
    const fields = line.split("\0");
    if (fields.length !== 2 || fields[0] === undefined || fields[1] === undefined) {
      throw new LocalSourceError("repository_invalid");
    }
    references.push({ objectId: validateObjectId(fields[1], objectFormat), ref: fields[0] });
  }
  return references;
}

async function readRawReferences(
  config: LocalSourceConfig,
  repository: ResolvedRepository,
  objectFormat: GitObjectFormat,
): Promise<RawReference[]> {
  const result = await runGit(config, repository, [
    "for-each-ref",
    `--count=${String(MAX_REFERENCES + 1)}`,
    "--sort=refname",
    "--format=%(refname)%00%(objectname)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]);
  const references = parseRawReferences(result.stdout, objectFormat);
  if (references.length > MAX_REFERENCES) {
    throw new LocalSourceError("reference_limit_exceeded");
  }
  const resolvedHead = await runGit(
    config,
    repository,
    ["rev-parse", "--verify", "--end-of-options", "HEAD"],
    [0, 128],
  );
  const headObjectId =
    resolvedHead.exitCode === 0
      ? validateObjectId(oneLine(resolvedHead.stdout), objectFormat)
      : undefined;
  if (headObjectId !== undefined) {
    references.unshift({ objectId: headObjectId, ref: "HEAD" });
  }
  if (references.length > MAX_REFERENCES) {
    throw new LocalSourceError("reference_limit_exceeded");
  }
  return references;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let resultBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (resultBytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    resultBytes += characterBytes;
  }
  return result;
}

function commitSubject(commit: RawGitObject): string | null {
  const separator = commit.content.indexOf(Buffer.from("\n\n"));
  if (separator === -1) {
    return null;
  }
  const message = commit.content.subarray(separator + 2);
  const newline = message.indexOf(0x0a);
  const subjectLength = newline === -1 ? message.length : newline;
  const subjectBytes = message.subarray(0, Math.min(subjectLength, 4096));
  let subject: string | null = null;
  const maximumTrailingTrim = subjectLength > subjectBytes.length ? 3 : 0;
  for (let trimmedBytes = 0; trimmedBytes <= maximumTrailingTrim; trimmedBytes += 1) {
    try {
      subject = decodeUtf8(subjectBytes.subarray(0, subjectBytes.length - trimmedBytes));
      break;
    } catch {
      // A bounded prefix may split one trailing UTF-8 code point; invalid earlier bytes stay null.
    }
  }
  if (subject === null) {
    return null;
  }
  const sanitized = subject.replace(/\p{Cc}+/gu, " ").trim();
  return sanitized === "" ? null : truncateUtf8(sanitized, 512);
}

async function peelCommit(
  readObject: GitObjectReader,
  objectFormat: GitObjectFormat,
  initialObjectId: string,
): Promise<RawGitObject> {
  let objectId = initialObjectId;
  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth += 1) {
    if (seen.has(objectId)) throw new LocalSourceError("reference_not_available");
    seen.add(objectId);
    const object = await readObject(objectId);
    if (object.type === "commit") return object;
    if (object.type !== "tag") throw new LocalSourceError("reference_not_available");
    const headerEnd = object.content.indexOf(Buffer.from("\n\n"));
    if (headerEnd === -1) throw new LocalSourceError("reference_not_available");
    const header = object.content.subarray(0, headerEnd).toString("ascii");
    const target = /^object ([a-f0-9]+)$/mu.exec(header)?.[1];
    if (target === undefined) throw new LocalSourceError("reference_not_available");
    objectId = validateObjectId(target, objectFormat);
  }
  throw new LocalSourceError("reference_not_available");
}

export async function listRepositoryReferences(
  config: LocalSourceConfig,
  repository: ResolvedRepository,
): Promise<RepositoryReferenceInventory> {
  const inspection = await inspectRepository(config, repository);
  const rawReferences = await readRawReferences(config, repository, inspection.objectFormat);
  const inspectionConfig = {
    ...config,
    maxBytes: REFERENCE_INSPECTION_MAX_BYTES,
    maxObjects: REFERENCE_INSPECTION_MAX_OBJECTS,
  };
  const references = await withGitObjectReader(
    inspectionConfig,
    repository,
    inspection.objectFormat,
    inspection.objectDirectories,
    async (readObject) => {
      const inventory: RepositoryReference[] = [];
      const commits = new Map<string, RawGitObject>();
      for (const { objectId: referencedObjectId, ref } of rawReferences) {
        if (Buffer.byteLength(ref, "utf8") > 255 || /\p{Cc}/u.test(ref)) {
          throw new LocalSourceError("repository_invalid");
        }
        const kind = parseReferenceKind(ref);
        if (kind === null) continue;
        let commit: RawGitObject;
        try {
          commit = await peelCommit(readObject, inspection.objectFormat, referencedObjectId);
        } catch (error) {
          if (
            error instanceof LocalSourceError &&
            ["object_missing", "reference_not_available"].includes(error.code)
          ) {
            continue;
          }
          throw error;
        }
        commits.set(commit.id, commit);
        inventory.push({
          commitObjectId: commit.id,
          commitSubjectSuggestion: commitSubject(commit),
          displayName: referenceDisplayName(ref, kind),
          kind,
          ref,
        });
      }
      return inventory;
    },
    "reference_limit_exceeded",
  );
  return {
    objectFormat: inspection.objectFormat,
    references,
    repositoryId: repository.repositoryId,
  };
}

async function resolveCurrentReferencePair(
  config: LocalSourceConfig,
  repository: ResolvedRepository,
  inspection: RepositoryInspection,
  refs: readonly [string, string],
): Promise<readonly [string, string]> {
  const rawReferences = await readRawReferences(config, repository, inspection.objectFormat);
  const byName = new Map(rawReferences.map((reference) => [reference.ref, reference.objectId]));
  const base = byName.get(refs[0]);
  const head = byName.get(refs[1]);
  if (base === undefined || head === undefined) {
    throw new LocalSourceError("reference_not_available");
  }
  return withGitObjectReader(
    config,
    repository,
    inspection.objectFormat,
    inspection.objectDirectories,
    async (readObject) => {
      try {
        const baseCommit = await peelCommit(readObject, inspection.objectFormat, base);
        const headCommit = await peelCommit(readObject, inspection.objectFormat, head);
        return [baseCommit.id, headCommit.id] as const;
      } catch (error) {
        if (
          error instanceof LocalSourceError &&
          ["object_missing", "reference_not_available"].includes(error.code)
        ) {
          throw new LocalSourceError("reference_not_available");
        }
        throw error;
      }
    },
  );
}

export async function resolveSelectedRevision(
  config: LocalSourceConfig,
  repository: ResolvedRepository,
  inventory: RepositoryReferenceInventory,
  selection: { baseRef: string; headRef: string },
): Promise<SelectedRevision> {
  if (selection.baseRef === selection.headRef) {
    throw new LocalSourceError("reference_not_available");
  }
  if (inventory.repositoryId !== repository.repositoryId) {
    throw new LocalSourceError("reference_not_available");
  }
  const allowed = new Set(inventory.references.map(({ ref }) => ref));
  if (!allowed.has(selection.baseRef) || !allowed.has(selection.headRef)) {
    throw new LocalSourceError("reference_not_available");
  }
  const inspection = await inspectRepository(config, repository);
  if (inspection.objectFormat !== inventory.objectFormat) {
    throw new LocalSourceError("reference_not_available");
  }
  const [baseObjectId, headObjectId] = await resolveCurrentReferencePair(
    config,
    repository,
    inspection,
    [selection.baseRef, selection.headRef],
  );
  return {
    ...inspection,
    base: { objectId: baseObjectId, ref: selection.baseRef },
    head: { objectId: headObjectId, ref: selection.headRef },
    repository,
  };
}
