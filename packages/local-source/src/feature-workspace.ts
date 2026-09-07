import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LocalSourceConfig } from "./config.js";
import { resolveRepository } from "./discovery.js";
import {
  inspectRepository,
  listCommitTreeEntries,
  withGitObjectReader,
  type GitObjectFormat,
  type RawGitObject,
} from "./git.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
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

export type FeatureWorkspaceErrorCode =
  | "workspace_invalid"
  | "workspace_identity_mismatch"
  | "workspace_source_unsupported"
  | "workspace_limit_exceeded"
  | "workspace_cancelled"
  | "workspace_changed"
  | "workspace_checkpoint_conflict";

export class FeatureWorkspaceError extends Error {
  constructor(readonly code: FeatureWorkspaceErrorCode) {
    const messages: Record<FeatureWorkspaceErrorCode, string> = {
      workspace_invalid: "The managed Feature workspace could not be verified",
      workspace_identity_mismatch:
        "The managed Feature workspace does not match the frozen source identity",
      workspace_source_unsupported:
        "The source contains a path or entry unsupported by the managed workspace",
      workspace_limit_exceeded: "The managed Feature workspace exceeded its configured limits",
      workspace_cancelled: "The managed Feature workspace operation was cancelled",
      workspace_changed: "The Feature workspace changed from the revision being verified",
      workspace_checkpoint_conflict:
        "The Feature checkpoint conflicts with its previous request or current head",
    };
    super(messages[code]);
    this.name = "FeatureWorkspaceError";
  }
}

export interface FeatureWorkspaceIdentity {
  projectId: string;
  featureId: string;
  repositoryId: string;
  sourceIdentity: string;
  baseCommitId: string;
  objectFormat: GitObjectFormat;
  branch: string;
}

/** Server-only handle. Persist its identity, never its filesystem paths. */
export interface FeatureWorkspace {
  readonly identity: Readonly<FeatureWorkspaceIdentity>;
  readonly workspacePath: string;
  readonly gitDirectory: string;
  readonly shallowBaseCommitId: string;
}

export interface OpenFeatureWorkspaceOptions {
  signal?: AbortSignal;
  documents?: { planMarkdown: string; specMarkdown: string };
}

export interface FeatureWorkspaceSnapshot {
  headCommitId: string;
  treeId: string;
}

export interface FeatureWorkspaceCheckpoint {
  expectedHead: string;
  expectedTree: string;
  checkpointId: string;
  message: string;
  signal?: AbortSignal;
}

interface Manifest {
  version: 1;
  identity: FeatureWorkspaceIdentity;
  configDigest: string;
  documents: { planMarkdown: string; specMarkdown: string } | null;
}

interface Resources {
  config: LocalSourceConfig;
  directory: string;
  manifest: Manifest;
}

const resources = new WeakMap<FeatureWorkspace, Resources>();

function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted)
    throw new FeatureWorkspaceError(
      signal.reason instanceof Error && signal.reason.name === "TimeoutError"
        ? "workspace_limit_exceeded"
        : "workspace_cancelled",
    );
}

function operationSignal(config: LocalSourceConfig, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(config.gitObjectReadTimeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function objectId(value: string, format: GitObjectFormat): string {
  if (!(format === "sha1" ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(value))
    throw new FeatureWorkspaceError("workspace_invalid");
  return value;
}

function canonicalIdentity(identity: FeatureWorkspaceIdentity): FeatureWorkspaceIdentity {
  if (
    ![identity.projectId, identity.featureId, identity.repositoryId].every((value) =>
      UUID.test(value),
    ) ||
    !/^[a-f0-9]{64}$/u.test(identity.sourceIdentity) ||
    !["sha1", "sha256"].includes(identity.objectFormat) ||
    !identity.branch.startsWith("refs/heads/") ||
    identity.branch.length > 256
  )
    throw new FeatureWorkspaceError("workspace_invalid");
  return {
    projectId: identity.projectId,
    featureId: identity.featureId,
    repositoryId: identity.repositoryId,
    sourceIdentity: identity.sourceIdentity,
    baseCommitId: objectId(identity.baseCommitId, identity.objectFormat),
    objectFormat: identity.objectFormat,
    branch: identity.branch,
  };
}

function contained(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

async function directory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.getuid !== undefined && metadata.uid !== process.getuid()) ||
    (await realpath(path)) !== path
  )
    throw new FeatureWorkspaceError("workspace_invalid");
}

async function ownedDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
  await directory(path);
  if (((await lstat(path)).mode & 0o777) !== 0o700)
    throw new FeatureWorkspaceError("workspace_invalid");
}

async function readRegular(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > maxBytes)
      throw new FeatureWorkspaceError("workspace_invalid");
    const bytes = Buffer.alloc(metadata.size + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const result = await file.read(bytes, length, bytes.byteLength - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await file.stat();
    if (
      length !== metadata.size ||
      after.size !== metadata.size ||
      after.mtimeMs !== metadata.mtimeMs ||
      after.ctimeMs !== metadata.ctimeMs
    )
      throw new FeatureWorkspaceError("workspace_changed");
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

async function durableFile(path: string, value: string | Buffer): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

function gitArguments(workspace: FeatureWorkspace, args: readonly string[]): string[] {
  return [`--git-dir=${workspace.gitDirectory}`, `--work-tree=${workspace.workspacePath}`, ...args];
}

async function runGit(
  config: LocalSourceConfig,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  input?: Buffer,
  environment: NodeJS.ProcessEnv = {},
): Promise<Buffer> {
  checkCancellation(signal);
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const child = spawn(
      config.gitExecutable,
      [
        "--no-lazy-fetch",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "core.excludesFile=/dev/null",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "-c",
        "core.fsync=objects,reference",
        "-c",
        "core.fsyncMethod=fsync",
        ...args,
      ],
      {
        cwd,
        detached: process.platform !== "win32",
        env: { ...SAFE_GIT_ENV, ...environment },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let stderrSize = 0;
    let failure: FeatureWorkspaceError | undefined;
    const terminate = () => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          /* Process may have exited. */
        }
      }
      child.kill("SIGKILL");
    };
    const onAbort = () => terminate();
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_OUTPUT_BYTES) {
        failure = new FeatureWorkspaceError("workspace_limit_exceeded");
        terminate();
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.byteLength;
      if (stderrSize > 64 * 1024) {
        failure = new FeatureWorkspaceError("workspace_limit_exceeded");
        terminate();
      }
    });
    child.stdin.on("error", () => {
      failure ??= new FeatureWorkspaceError("workspace_invalid");
      terminate();
    });
    child.once("error", () => {
      failure ??= new FeatureWorkspaceError("workspace_invalid");
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      try {
        checkCancellation(signal);
      } catch (error) {
        rejectPromise(
          error instanceof Error ? error : new FeatureWorkspaceError("workspace_cancelled"),
        );
        return;
      }
      if (failure !== undefined || code !== 0)
        rejectPromise(failure ?? new FeatureWorkspaceError("workspace_invalid"));
      else resolvePromise(Buffer.concat(chunks, size));
    });
    child.stdin.end(input);
  });
}

function validatePath(path: string): void {
  const segments = path.split("/");
  if (
    Buffer.byteLength(path) > 4096 ||
    path.includes("\\") ||
    /[\p{Cc}\p{Cf}]/u.test(path) ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.toLowerCase().replace(/[. ]+$/u, "") === ".git" ||
        segment.includes(":"),
    ) ||
    segments[0]?.toLowerCase() === ".kestrel"
  )
    throw new FeatureWorkspaceError("workspace_source_unsupported");
}

function validateSymlink(root: string, path: string, value: Buffer): string {
  const target = new TextDecoder("utf-8", { fatal: true }).decode(value);
  if (
    target === "" ||
    isAbsolute(target) ||
    target.includes("\\") ||
    /[\p{Cc}\p{Cf}]/u.test(target) ||
    !contained(root, resolve(dirname(join(root, path)), target))
  )
    throw new FeatureWorkspaceError("workspace_source_unsupported");
  const resolved = relative(root, resolve(dirname(join(root, path)), target));
  if (resolved !== "") validatePath(resolved);
  return target;
}

async function validateSymlinkDestination(
  root: string,
  path: string,
  value: Buffer,
  signal: AbortSignal,
): Promise<void> {
  const pending = validateSymlink(root, path, value).split("/");
  const current = path.split("/").slice(0, -1);
  let links = 0;
  while (pending.length > 0) {
    checkCancellation(signal);
    const segment = pending.shift();
    if (segment === undefined || segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (current.length === 0) throw new FeatureWorkspaceError("workspace_source_unsupported");
      current.pop();
      continue;
    }
    const relativePath = [...current, segment].join("/");
    validatePath(relativePath);
    const pathToInspect = join(root, relativePath);
    const metadata = await lstat(pathToInspect).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw new FeatureWorkspaceError("workspace_source_unsupported");
    });
    if (metadata?.isSymbolicLink() === true) {
      if (++links > 40) throw new FeatureWorkspaceError("workspace_source_unsupported");
      const target = validateSymlink(
        root,
        relativePath,
        await readlink(pathToInspect, { encoding: "buffer" }),
      );
      pending.unshift(...target.split("/"));
    } else current.push(segment);
  }
}

function bind(config: LocalSourceConfig, path: string, manifest: Manifest): FeatureWorkspace {
  const workspace = Object.freeze({
    identity: Object.freeze({ ...manifest.identity }),
    workspacePath: join(path, "workspace"),
    gitDirectory: join(path, "control", "repository.git"),
    shallowBaseCommitId: manifest.identity.baseCommitId,
  });
  resources.set(workspace, { config, directory: path, manifest });
  return workspace;
}

async function validateWorkspace(workspace: FeatureWorkspace): Promise<Resources> {
  const state = resources.get(workspace);
  if (state === undefined) throw new FeatureWorkspaceError("workspace_invalid");
  for (const path of [
    state.config.artifactRoot,
    dirname(dirname(state.directory)),
    dirname(state.directory),
    state.directory,
    join(state.directory, "control"),
    workspace.workspacePath,
    workspace.gitDirectory,
  ])
    await directory(path);
  if (
    (await readRegular(join(workspace.workspacePath, ".git"), 4096)).toString("utf8") !==
      `gitdir: ${workspace.gitDirectory}\n` ||
    digest(await readRegular(join(workspace.gitDirectory, "config"), MAX_METADATA_BYTES)) !==
      state.manifest.configDigest ||
    (await readRegular(join(workspace.gitDirectory, "HEAD"), 4096)).toString("utf8") !==
      `ref: ${workspace.identity.branch}\n` ||
    (await readRegular(join(workspace.gitDirectory, "shallow"), 4096)).toString("utf8") !==
      `${workspace.identity.baseCommitId}\n`
  )
    throw new FeatureWorkspaceError("workspace_invalid");
  for (const name of ["objects/info/alternates", "objects/info/http-alternates", "commondir"]) {
    if (
      await lstat(join(workspace.gitDirectory, name)).then(
        () => true,
        () => false,
      )
    )
      throw new FeatureWorkspaceError("workspace_invalid");
  }
  if (state.manifest.documents !== null) {
    await directory(join(workspace.workspacePath, ".kestrel"));
    for (const [name, expected] of [
      ["plan.md", state.manifest.documents.planMarkdown],
      ["spec.md", state.manifest.documents.specMarkdown],
    ]) {
      if (
        name === undefined ||
        expected === undefined ||
        digest(
          await readRegular(join(workspace.workspacePath, ".kestrel", name), MAX_METADATA_BYTES),
        ) !== expected
      )
        throw new FeatureWorkspaceError("workspace_changed");
    }
  }
  return state;
}

async function reopen(
  config: LocalSourceConfig,
  path: string,
  identity: FeatureWorkspaceIdentity,
  options: OpenFeatureWorkspaceOptions,
): Promise<FeatureWorkspace> {
  await directory(path);
  await directory(join(path, "control"));
  const value: unknown = JSON.parse(
    (await readRegular(join(path, "control", "identity.json"), MAX_METADATA_BYTES)).toString(
      "utf8",
    ),
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("identity" in value) ||
    JSON.stringify(value.identity) !== JSON.stringify(identity) ||
    !("configDigest" in value) ||
    typeof value.configDigest !== "string" ||
    !("documents" in value)
  )
    throw new FeatureWorkspaceError("workspace_identity_mismatch");
  let documents: Manifest["documents"] = null;
  if (value.documents !== null) {
    const docs = value.documents;
    if (
      typeof docs !== "object" ||
      !("planMarkdown" in docs) ||
      typeof docs.planMarkdown !== "string" ||
      !("specMarkdown" in docs) ||
      typeof docs.specMarkdown !== "string"
    )
      throw new FeatureWorkspaceError("workspace_invalid");
    documents = { planMarkdown: docs.planMarkdown, specMarkdown: docs.specMarkdown };
  }
  if (
    options.documents !== undefined &&
    (documents?.planMarkdown !== digest(options.documents.planMarkdown) ||
      documents.specMarkdown !== digest(options.documents.specMarkdown))
  )
    throw new FeatureWorkspaceError("workspace_identity_mismatch");
  const workspace = bind(config, path, {
    version: 1,
    identity,
    configDigest: value.configDigest,
    documents,
  });
  await validateWorkspace(workspace);
  return workspace;
}

/** Copies only the frozen commit and its verified tree/blob closure. History before that
 * commit is explicitly shallow; publication must separately verify the provider base.
 * The controller must keep control/ outside runtime write authority and quiesce the
 * runtime before every snapshot/checkpoint operation. */
export async function openFeatureWorkspace(
  config: LocalSourceConfig,
  input: FeatureWorkspaceIdentity,
  options: OpenFeatureWorkspaceOptions = {},
): Promise<FeatureWorkspace> {
  const identity = canonicalIdentity(input);
  const signal = operationSignal(config, options.signal);
  checkCancellation(signal);
  await directory(config.artifactRoot);
  let parent = config.artifactRoot;
  for (const segment of ["projects", identity.projectId, "feature-workspaces"]) {
    parent = join(parent, segment);
    await ownedDirectory(parent);
  }
  const destination = join(parent, identity.featureId);
  if (
    await lstat(destination).then(
      () => true,
      () => false,
    )
  )
    return reopen(config, destination, identity, options);
  await runGit(config, parent, ["check-ref-format", identity.branch], signal);
  const repository = await resolveRepository(config, identity.repositoryId);
  const inspection = await inspectRepository(config, repository, signal);
  if (
    inspection.sourceIdentity !== identity.sourceIdentity ||
    inspection.objectFormat !== identity.objectFormat
  )
    throw new FeatureWorkspaceError("workspace_identity_mismatch");
  const staging = join(parent, `.creating-${identity.featureId}-${randomUUID()}`);
  await ownedDirectory(staging);
  try {
    const control = join(staging, "control");
    const workspacePath = join(staging, "workspace");
    const gitDirectory = join(control, "repository.git");
    await ownedDirectory(control);
    await ownedDirectory(workspacePath);
    await runGit(
      config,
      workspacePath,
      [
        "init",
        "--template=",
        `--object-format=${identity.objectFormat}`,
        `--initial-branch=${identity.branch.slice("refs/heads/".length)}`,
        `--separate-git-dir=${gitDirectory}`,
        workspacePath,
      ],
      signal,
    );
    const initial: FeatureWorkspace = {
      identity,
      workspacePath,
      gitDirectory,
      shallowBaseCommitId: identity.baseCommitId,
    };
    const objects = new Map<string, RawGitObject>();
    const entries = await withGitObjectReader(
      config,
      repository,
      identity.objectFormat,
      inspection.objectDirectories,
      async (readObject) => {
        const capture = async (id: string) => {
          const object = await readObject(id);
          objects.set(id, object);
          return object;
        };
        const tree = await listCommitTreeEntries(
          config,
          repository,
          identity.objectFormat,
          identity.baseCommitId,
          inspection.objectDirectories,
          capture,
        );
        for (const entry of tree) {
          validatePath(entry.path);
          // Gitlinks need separate acquisition. Empty child trees cannot survive the
          // index used for checkpoints; reject instead of silently removing them.
          if (
            entry.type === "commit" ||
            (entry.type === "tree" && objects.get(entry.objectId)?.content.byteLength === 0)
          )
            throw new FeatureWorkspaceError("workspace_source_unsupported");
          if (entry.type === "blob") await capture(entry.objectId);
        }
        return tree;
      },
      "revision_limit_exceeded",
      signal,
    );
    for (const object of objects.values()) {
      const id = (
        await runGit(
          config,
          workspacePath,
          gitArguments(initial, [
            "hash-object",
            "-w",
            "--stdin",
            "--no-filters",
            "-t",
            object.type,
          ]),
          signal,
          object.content,
        )
      )
        .toString("ascii")
        .trim();
      if (id !== object.id) throw new FeatureWorkspaceError("workspace_invalid");
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      checkCancellation(signal);
      const key = entry.path.normalize("NFC").toLowerCase();
      if (seen.has(key)) throw new FeatureWorkspaceError("workspace_source_unsupported");
      seen.add(key);
      const path = join(workspacePath, entry.path);
      if (entry.type === "tree") {
        await mkdir(path, { mode: 0o755 });
        continue;
      }
      const object = objects.get(entry.objectId);
      if (object?.type !== "blob") throw new FeatureWorkspaceError("workspace_invalid");
      if (entry.mode === "120000")
        await symlink(validateSymlink(workspacePath, entry.path, object.content), path);
      else {
        await writeFile(path, object.content, {
          flag: "wx",
          mode: entry.mode === "100755" ? 0o755 : 0o644,
        });
        await chmod(path, entry.mode === "100755" ? 0o755 : 0o644);
      }
    }
    for (const entry of entries) {
      if (entry.mode === "120000")
        await validateSymlinkDestination(
          workspacePath,
          entry.path,
          await readlink(join(workspacePath, entry.path), { encoding: "buffer" }),
          signal,
        );
    }
    await durableFile(join(gitDirectory, "shallow"), `${identity.baseCommitId}\n`);
    await runGit(
      config,
      workspacePath,
      gitArguments(initial, ["update-ref", identity.branch, identity.baseCommitId]),
      signal,
    );
    await runGit(
      config,
      workspacePath,
      gitArguments(initial, ["read-tree", identity.baseCommitId]),
      signal,
    );
    await mkdir(join(gitDirectory, "info"), { recursive: true, mode: 0o700 });
    await writeFile(join(gitDirectory, "info", "exclude"), "/.kestrel/\n", { mode: 0o600 });
    let documents: Manifest["documents"] = null;
    if (options.documents !== undefined) {
      if (
        Buffer.byteLength(options.documents.planMarkdown) +
          Buffer.byteLength(options.documents.specMarkdown) >
        MAX_METADATA_BYTES
      )
        throw new FeatureWorkspaceError("workspace_limit_exceeded");
      await ownedDirectory(join(workspacePath, ".kestrel"));
      await durableFile(join(workspacePath, ".kestrel", "plan.md"), options.documents.planMarkdown);
      await durableFile(join(workspacePath, ".kestrel", "spec.md"), options.documents.specMarkdown);
      documents = {
        planMarkdown: digest(options.documents.planMarkdown),
        specMarkdown: digest(options.documents.specMarkdown),
      };
    }
    const manifest: Manifest = {
      version: 1,
      identity,
      configDigest: digest(await readFile(join(gitDirectory, "config"))),
      documents,
    };
    await durableFile(join(control, "identity.json"), JSON.stringify(manifest));
    await writeFile(
      join(workspacePath, ".git"),
      `gitdir: ${join(destination, "control", "repository.git")}\n`,
      { mode: 0o400 },
    );
    await chmod(join(workspacePath, ".git"), 0o400);
    await runGit(
      config,
      workspacePath,
      gitArguments(initial, ["fsck", "--full", "--strict"]),
      signal,
    );
    const after = await inspectRepository(config, repository, signal);
    if (
      after.sourceIdentity !== identity.sourceIdentity ||
      after.objectFormat !== identity.objectFormat
    )
      throw new FeatureWorkspaceError("workspace_identity_mismatch");
    checkCancellation(signal);
    await rename(staging, destination);
    await syncDirectory(parent);
    return await reopen(config, destination, identity, options);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function readHead(
  workspace: FeatureWorkspace,
  config: LocalSourceConfig,
  signal: AbortSignal,
): Promise<string> {
  return objectId(
    (
      await runGit(
        config,
        workspace.workspacePath,
        gitArguments(workspace, ["rev-parse", "--verify", `${workspace.identity.branch}^{commit}`]),
        signal,
      )
    )
      .toString("ascii")
      .trim(),
    workspace.identity.objectFormat,
  );
}

async function candidateTree(
  workspace: FeatureWorkspace,
  config: LocalSourceConfig,
  signal: AbortSignal,
): Promise<string> {
  // The controller index is derived state, including after an interrupted ref update.
  // read-tree without -u rebuilds it from the branch and never checks out source bytes.
  await runGit(
    config,
    workspace.workspacePath,
    gitArguments(workspace, ["read-tree", workspace.identity.branch]),
    signal,
  );
  const pathsOutput = await runGit(
    config,
    workspace.workspacePath,
    gitArguments(workspace, [
      "-c",
      "core.ignorecase=false",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
    signal,
  );
  const paths = [
    ...new Set(
      new TextDecoder("utf-8", { fatal: true }).decode(pathsOutput).split("\0").filter(Boolean),
    ),
  ];
  if (paths.length > config.maxObjects) throw new FeatureWorkspaceError("workspace_limit_exceeded");
  const indexEntries: string[] = [];
  const trees = new Set<string>([""]);
  const directoryNames = new Map<string, Set<string>>();
  const hasExactName = async (parent: string, name: string): Promise<boolean> => {
    let names = directoryNames.get(parent);
    if (names === undefined) {
      names = new Set<string>();
      for await (const entry of await opendir(parent)) {
        checkCancellation(signal);
        names.add(entry.name);
        if (names.size > config.maxObjects)
          throw new FeatureWorkspaceError("workspace_limit_exceeded");
      }
      directoryNames.set(parent, names);
    }
    return names.has(name);
  };
  let bytes = 0;
  for (const path of paths) {
    checkCancellation(signal);
    validatePath(path);
    const absolute = join(workspace.workspacePath, path);
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const prefix = segments.slice(0, depth).join("/");
      if (!trees.has(prefix)) {
        trees.add(prefix);
        bytes += Buffer.byteLength(segments[depth - 1] ?? "") + 40;
      }
    }
    if (paths.length + trees.size + 1 > config.maxObjects)
      throw new FeatureWorkspaceError("workspace_limit_exceeded");
    bytes += Buffer.byteLength(segments.at(-1) ?? "") + 40;
    let parent = workspace.workspacePath;
    let deleted = false;
    for (const segment of path.split("/").slice(0, -1)) {
      if (!(await hasExactName(parent, segment))) {
        deleted = true;
        break;
      }
      parent = join(parent, segment);
      const metadata = await lstat(parent).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (metadata === null) {
        deleted = true;
        break;
      }
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new FeatureWorkspaceError("workspace_source_unsupported");
    }
    if (deleted) continue;
    if (!(await hasExactName(parent, segments.at(-1) ?? ""))) continue;
    const metadata = await lstat(absolute).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (metadata === null) continue;
    if ((!metadata.isFile() && !metadata.isSymbolicLink()) || metadata.nlink !== 1)
      throw new FeatureWorkspaceError("workspace_source_unsupported");
    bytes += metadata.size;
    if (bytes > config.maxBytes) throw new FeatureWorkspaceError("workspace_limit_exceeded");
    const content = metadata.isSymbolicLink()
      ? Buffer.from(await readlink(absolute))
      : await readRegular(absolute, config.maxBytes);
    if (metadata.isSymbolicLink())
      await validateSymlinkDestination(workspace.workspacePath, path, content, signal);
    const mode = metadata.isSymbolicLink()
      ? "120000"
      : (metadata.mode & 0o111) === 0
        ? "100644"
        : "100755";
    const id = objectId(
      (
        await runGit(
          config,
          workspace.workspacePath,
          gitArguments(workspace, ["hash-object", "-w", "--stdin", "--no-filters"]),
          signal,
          content,
        )
      )
        .toString("ascii")
        .trim(),
      workspace.identity.objectFormat,
    );
    indexEntries.push(`${mode} ${id}\t${path}\0`);
  }
  const index = join(workspace.gitDirectory, `candidate-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await runGit(
      config,
      workspace.workspacePath,
      gitArguments(workspace, ["read-tree", "--empty"]),
      signal,
      undefined,
      env,
    );
    await runGit(
      config,
      workspace.workspacePath,
      gitArguments(workspace, ["update-index", "-z", "--index-info"]),
      signal,
      Buffer.from(indexEntries.join("")),
      env,
    );
    return objectId(
      (
        await runGit(
          config,
          workspace.workspacePath,
          gitArguments(workspace, ["write-tree"]),
          signal,
          undefined,
          env,
        )
      )
        .toString("ascii")
        .trim(),
      workspace.identity.objectFormat,
    );
  } finally {
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
}

/** Snapshots committed paths plus non-ignored additions as raw bytes and Git modes.
 * Git attributes, clean/smudge filters and EOL conversion never rewrite the candidate. */
export async function snapshotFeatureWorkspace(
  workspace: FeatureWorkspace,
  options: { expectedHead: string; signal?: AbortSignal },
): Promise<FeatureWorkspaceSnapshot> {
  const { config } = await validateWorkspace(workspace);
  const signal = operationSignal(config, options.signal);
  const expected = objectId(options.expectedHead, workspace.identity.objectFormat);
  if ((await readHead(workspace, config, signal)) !== expected)
    throw new FeatureWorkspaceError("workspace_changed");
  const treeId = await candidateTree(workspace, config, signal);
  await validateWorkspace(workspace);
  if ((await readHead(workspace, config, signal)) !== expected)
    throw new FeatureWorkspaceError("workspace_changed");
  return { headCommitId: expected, treeId };
}

/** Call after each exact verification command and again before recording success. */
export async function assertFeatureWorkspaceSnapshot(
  workspace: FeatureWorkspace,
  snapshot: FeatureWorkspaceSnapshot,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  objectId(snapshot.treeId, workspace.identity.objectFormat);
  const current = await snapshotFeatureWorkspace(workspace, {
    expectedHead: snapshot.headCommitId,
    ...options,
  });
  if (current.treeId !== snapshot.treeId) throw new FeatureWorkspaceError("workspace_changed");
}

/** The caller persists checkpointId before calling. A durable preparation record makes
 * commit-tree deterministic across restart; update-ref compares the prior head. Repeating
 * the same operation after Git commits but before the caller persists returns that commit. */
export async function checkpointFeatureWorkspace(
  workspace: FeatureWorkspace,
  options: FeatureWorkspaceCheckpoint,
): Promise<FeatureWorkspaceSnapshot> {
  const { config, directory: workspaceDirectory } = await validateWorkspace(workspace);
  const signal = operationSignal(config, options.signal);
  if (
    !UUID.test(options.checkpointId) ||
    options.message.trim() === "" ||
    options.message.includes("\0") ||
    Buffer.byteLength(options.message) > 8192
  )
    throw new FeatureWorkspaceError("workspace_invalid");
  const request = {
    expectedHead: objectId(options.expectedHead, workspace.identity.objectFormat),
    expectedTree: objectId(options.expectedTree, workspace.identity.objectFormat),
    checkpointId: options.checkpointId,
    message: options.message,
  };
  const head = await readHead(workspace, config, signal);
  const records = join(workspaceDirectory, "control", "checkpoints");
  await ownedDirectory(records);
  const recordPath = join(records, `${options.checkpointId}.json`);
  const existing = await readRegular(recordPath, MAX_METADATA_BYTES).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  let createdAt: number;
  if (existing === null) {
    if (head !== request.expectedHead)
      throw new FeatureWorkspaceError("workspace_checkpoint_conflict");
    await assertFeatureWorkspaceSnapshot(
      workspace,
      { headCommitId: head, treeId: request.expectedTree },
      { signal },
    );
    createdAt = Math.floor(Date.now() / 1000);
    await durableFile(recordPath, JSON.stringify({ request, createdAt }));
    await syncDirectory(records);
  } else {
    const record: unknown = JSON.parse(existing.toString("utf8"));
    if (
      typeof record !== "object" ||
      record === null ||
      !("request" in record) ||
      JSON.stringify(record.request) !== JSON.stringify(request) ||
      !("createdAt" in record) ||
      typeof record.createdAt !== "number" ||
      !Number.isSafeInteger(record.createdAt) ||
      record.createdAt < 0
    )
      throw new FeatureWorkspaceError("workspace_checkpoint_conflict");
    createdAt = record.createdAt;
  }
  const date = `${String(createdAt)} +0000`;
  const next = objectId(
    (
      await runGit(
        config,
        workspace.workspacePath,
        gitArguments(workspace, ["commit-tree", request.expectedTree, "-p", request.expectedHead]),
        signal,
        Buffer.from(`${request.message}\n\nKestrel-Checkpoint: ${request.checkpointId}\n`),
        {
          GIT_AUTHOR_NAME: "Kestrel",
          GIT_AUTHOR_EMAIL: "factory@kestrel.invalid",
          GIT_COMMITTER_NAME: "Kestrel",
          GIT_COMMITTER_EMAIL: "factory@kestrel.invalid",
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      )
    )
      .toString("ascii")
      .trim(),
    workspace.identity.objectFormat,
  );
  if (head !== request.expectedHead && head !== next)
    throw new FeatureWorkspaceError("workspace_checkpoint_conflict");
  await assertFeatureWorkspaceSnapshot(
    workspace,
    { headCommitId: head, treeId: request.expectedTree },
    { signal },
  );
  if (head !== next) {
    await runGit(
      config,
      workspace.workspacePath,
      gitArguments(workspace, [
        "update-ref",
        workspace.identity.branch,
        next,
        request.expectedHead,
      ]),
      signal,
    );
  }
  await runGit(
    config,
    workspace.workspacePath,
    gitArguments(workspace, ["read-tree", request.expectedTree]),
    signal,
  );
  await assertFeatureWorkspaceSnapshot(
    workspace,
    { headCommitId: next, treeId: request.expectedTree },
    { signal },
  );
  return { headCommitId: next, treeId: request.expectedTree };
}
