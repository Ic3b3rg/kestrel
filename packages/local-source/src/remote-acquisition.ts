import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

import type { LocalSourceConfig } from "./config.js";
import type { ResolvedRepository } from "./discovery.js";
import { LocalSourceError, type LocalSourceErrorCode } from "./errors.js";
import {
  inspectRepository,
  type GitHubRepositoryIdentity,
  type GitObjectFormat,
  type RepositoryInspection,
} from "./git.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GIT_PROCESS_TIMEOUT_MS = 10_000;
const GIT_FETCH_TIMEOUT_MS = 60_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const MAX_CREDENTIAL_CONFIG_ENTRIES = 32;
const MAX_CREDENTIAL_CONFIG_BYTES = 4096;
const ACQUISITION_STORAGE_POLL_MS = 25;
const ACQUISITION_FIXED_STORAGE_OVERHEAD_BYTES = 64 * 1024;
const ACQUISITION_OBJECT_STORAGE_OVERHEAD_BYTES = 256;
const MAX_ACQUISITION_OVERHEAD_OBJECTS = 1_000_000;
const CREDENTIAL_CONFIG_PATTERN = "^credential(\\..*)?\\.(helper|useHttpPath)$";
const ACQUISITION_LOCAL_CONFIG_KEYS = new Set([
  "core.bare",
  "core.filemode",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.repositoryformatversion",
  "extensions.compatobjectformat",
  "extensions.objectformat",
]);
const HOST_ENVIRONMENT_KEYS = ["HOME", "PATH", "TMPDIR", "XDG_CONFIG_HOME"] as const;
const SAFE_GIT_CONFIG_ARGUMENTS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.interactive=never",
  "-c",
  "credential.modalPrompt=false",
  "-c",
  "fetch.writeCommitGraph=false",
  "-c",
  "gc.auto=0",
  "-c",
  "http.followRedirects=false",
  "-c",
  "maintenance.auto=false",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "protocol.git.allow=never",
  "-c",
  "protocol.http.allow=never",
  "-c",
  "protocol.ssh.allow=never",
  "-c",
  "protocol.https.allow=always",
] as const;

interface GitProcessResult {
  exitCode: number;
  stderr: Buffer;
  stdout: Buffer;
}

interface GitProcessOptions {
  allowedExitCodes?: readonly number[];
  environment: NodeJS.ProcessEnv;
  failureCode?: LocalSourceErrorCode;
  maxStdoutBytes?: number;
  signal?: AbortSignal | undefined;
  storageBudget?: { maxBytes: number; rootPath: string };
  timeoutMs?: number;
}

interface CredentialConfigEntry {
  key: string;
  value: string;
}

export interface GitHubPullRequestObjectAcquisition {
  base: { objectId: string; ref: string };
  head: { objectId: string; ref: string };
  objectFormat: GitObjectFormat;
  projectId: string;
  pullRequestNumber: number;
  repository: GitHubRepositoryIdentity;
  signal?: AbortSignal;
}

export interface AcquiredGitObjectSource {
  inspection: RepositoryInspection;
  repository: ResolvedRepository;
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

function hostEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_ASKPASS: "/usr/bin/false",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    SSH_ASKPASS: "/usr/bin/false",
  };
  for (const key of HOST_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

async function directoryStorageBytes(rootPath: string, stopAfter: number): Promise<number> {
  const pending = [rootPath];
  let total = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (metadata === null) continue;
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) pending.push(path);
      else total += metadata.size;
      if (total > stopAfter) return total;
    }
  }
  return total;
}

function safeFetchEnvironment(
  credentialConfig: readonly CredentialConfigEntry[],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...hostEnvironment(),
    GCM_GUI_PROMPT: "false",
    GCM_INTERACTIVE: "Never",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
  };
  environment.GIT_CONFIG_COUNT = String(credentialConfig.length);
  for (const [index, entry] of credentialConfig.entries()) {
    environment[`GIT_CONFIG_KEY_${String(index)}`] = entry.key;
    environment[`GIT_CONFIG_VALUE_${String(index)}`] = entry.value;
  }
  return environment;
}

function runGitProcess(
  executable: string,
  args: readonly string[],
  options: GitProcessOptions,
): Promise<GitProcessResult> {
  return new Promise<GitProcessResult>((resolvePromise, rejectPromise) => {
    if (options.signal?.aborted === true) {
      rejectPromise(new LocalSourceError("acquisition_cancelled"));
      return;
    }
    const child = spawn(executable, args, {
      detached: process.platform !== "win32",
      env: options.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: LocalSourceErrorCode | null = null;
    let settled = false;
    let storageCheckRunning = false;
    let storageTimer: ReturnType<typeof setInterval> | undefined;

    const terminate = () => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall back to the direct child after its process group exits.
        }
      }
      child.kill("SIGKILL");
    };
    const finish = (result?: GitProcessResult, error?: LocalSourceError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (storageTimer !== undefined) clearInterval(storageTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) rejectPromise(error);
      else if (result !== undefined) resolvePromise(result);
      else rejectPromise(new LocalSourceError("git_inspection_failed"));
    };
    const stopWithFailure = (code: LocalSourceErrorCode) => {
      if (failure === null) failure = code;
      terminate();
    };
    const onAbort = () => stopWithFailure("acquisition_cancelled");
    const timer = setTimeout(() => {
      stopWithFailure("git_inspection_failed");
    }, options.timeoutMs ?? GIT_PROCESS_TIMEOUT_MS);
    timer.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.storageBudget !== undefined) {
      const { maxBytes, rootPath } = options.storageBudget;
      storageTimer = setInterval(() => {
        if (storageCheckRunning || settled) return;
        storageCheckRunning = true;
        void directoryStorageBytes(rootPath, maxBytes)
          .then((bytes) => {
            if (!settled && bytes > maxBytes) stopWithFailure("revision_limit_exceeded");
          })
          .catch(() => {
            if (!settled) stopWithFailure("git_inspection_failed");
          })
          .finally(() => {
            storageCheckRunning = false;
          });
      }, ACQUISITION_STORAGE_POLL_MS);
      storageTimer.unref();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > (options.maxStdoutBytes ?? MAX_GIT_OUTPUT_BYTES)) {
        stopWithFailure("git_inspection_failed");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_GIT_OUTPUT_BYTES) {
        stopWithFailure("git_inspection_failed");
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", () => finish(undefined, new LocalSourceError("git_inspection_failed")));
    child.once("close", (exitCode) => {
      if (failure !== null) return finish(undefined, new LocalSourceError(failure));
      if (exitCode === null) {
        return finish(undefined, new LocalSourceError("git_inspection_failed"));
      }
      if (!(options.allowedExitCodes ?? [0]).includes(exitCode)) {
        return finish(
          undefined,
          new LocalSourceError(options.failureCode ?? "git_inspection_failed"),
        );
      }
      finish({
        exitCode,
        stderr: Buffer.concat(stderr, stderrBytes),
        stdout: Buffer.concat(stdout, stdoutBytes),
      });
    });
  });
}

function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new LocalSourceError("git_inspection_failed");
  }
}

function fetchAuthenticationFailure(stderr: Buffer): boolean {
  let message: string;
  try {
    message = decodeUtf8(stderr).toLocaleLowerCase("en-US");
  } catch {
    return false;
  }
  return [
    "authentication failed",
    "could not read username",
    "http basic: access denied",
    "permission denied",
    "requested url returned error: 401",
    "requested url returned error: 403",
    "single sign-on",
    "sso",
  ].some((pattern) => message.includes(pattern));
}

function fetchProviderResourceFailure(stderr: Buffer): boolean {
  let message: string;
  try {
    message = decodeUtf8(stderr).toLocaleLowerCase("en-US");
  } catch {
    return false;
  }
  return [
    "repository not found",
    "requested url returned error: 404",
    "returned http code 404",
    "http 404",
  ].some((pattern) => message.includes(pattern));
}

function missingFetchRef(
  stderr: Buffer,
  input: GitHubPullRequestObjectAcquisition,
): "base" | "head" | null {
  let message: string;
  try {
    message = decodeUtf8(stderr);
  } catch {
    return null;
  }
  if (message.includes(`refs/heads/${input.base.ref}`)) return "base";
  if (message.includes(`refs/pull/${String(input.pullRequestNumber)}/head`)) return "head";
  return null;
}

async function verifyAcquisitionReferences(
  config: LocalSourceConfig,
  input: GitHubPullRequestObjectAcquisition,
  repository: ResolvedRepository,
): Promise<void> {
  const result = await runGitProcess(
    config.gitExecutable,
    [
      "--no-lazy-fetch",
      ...SAFE_GIT_CONFIG_ARGUMENTS,
      "-C",
      repository.path,
      "for-each-ref",
      "--sort=refname",
      "--format=%(refname)%00%(objectname)",
    ],
    { environment: safeFetchEnvironment([]), signal: input.signal },
  );
  const observed = new Map<string, string>();
  for (const line of decodeUtf8(result.stdout).split("\n")) {
    if (line === "") continue;
    const fields = line.split("\0");
    if (fields.length !== 2 || fields[0] === undefined || fields[1] === undefined) {
      throw new LocalSourceError("object_verification_failed");
    }
    observed.set(fields[0], fields[1]);
  }
  const expected = new Map([
    ["refs/kestrel/base", input.base.objectId],
    ["refs/kestrel/head", input.head.objectId],
  ]);
  if (
    observed.size !== expected.size ||
    [...expected].some(([ref, objectId]) => observed.get(ref) !== objectId)
  ) {
    throw new LocalSourceError("object_verification_failed");
  }
}

async function verifyAcquisitionConfiguration(
  config: LocalSourceConfig,
  input: GitHubPullRequestObjectAcquisition,
  repository: ResolvedRepository,
): Promise<void> {
  const result = await runGitProcess(
    config.gitExecutable,
    [
      "--no-lazy-fetch",
      ...SAFE_GIT_CONFIG_ARGUMENTS,
      "-C",
      repository.path,
      "config",
      "--local",
      "--no-includes",
      "--null",
      "--list",
    ],
    { environment: safeFetchEnvironment([]), signal: input.signal },
  );
  const records = decodeUtf8(result.stdout).split("\0");
  if (records.at(-1) === "") records.pop();
  for (const record of records) {
    const separator = record.indexOf("\n");
    const key = separator === -1 ? "" : record.slice(0, separator).toLocaleLowerCase("en-US");
    if (!ACQUISITION_LOCAL_CONFIG_KEYS.has(key)) {
      throw new LocalSourceError("object_verification_failed");
    }
  }
}

function acquisitionStorageBudget(config: LocalSourceConfig): number {
  const objectOverhead =
    Math.min(config.maxObjects, MAX_ACQUISITION_OVERHEAD_OBJECTS) *
    ACQUISITION_OBJECT_STORAGE_OVERHEAD_BYTES;
  const overhead = ACQUISITION_FIXED_STORAGE_OVERHEAD_BYTES + objectOverhead;
  return config.maxBytes > Number.MAX_SAFE_INTEGER - overhead
    ? Number.MAX_SAFE_INTEGER
    : config.maxBytes + overhead;
}

async function verifyAcquisitionStorageBudget(
  repository: ResolvedRepository,
  maxStorageBytes: number,
): Promise<void> {
  if ((await directoryStorageBytes(repository.rootPath, maxStorageBytes)) > maxStorageBytes) {
    throw new LocalSourceError("revision_limit_exceeded");
  }
}

async function verifyAcquisitionBudget(
  config: LocalSourceConfig,
  input: GitHubPullRequestObjectAcquisition,
  repository: ResolvedRepository,
  maxStorageBytes: number,
): Promise<void> {
  await verifyAcquisitionStorageBudget(repository, maxStorageBytes);
  const result = await runGitProcess(
    config.gitExecutable,
    ["--no-lazy-fetch", ...SAFE_GIT_CONFIG_ARGUMENTS, "-C", repository.path, "count-objects", "-v"],
    { environment: safeFetchEnvironment([]), signal: input.signal },
  );
  const counts = new Map<string, number>();
  for (const line of decodeUtf8(result.stdout).split("\n")) {
    const match = /^(count|in-pack): ([0-9]+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value)) throw new LocalSourceError("object_verification_failed");
    counts.set(match[1], value);
  }
  const loose = counts.get("count");
  const packed = counts.get("in-pack");
  if (loose === undefined || packed === undefined) {
    throw new LocalSourceError("object_verification_failed");
  }
  if (loose > config.maxObjects || packed > config.maxObjects - loose) {
    throw new LocalSourceError("revision_limit_exceeded");
  }
}

async function readCredentialConfiguration(
  config: LocalSourceConfig,
  signal?: AbortSignal,
): Promise<readonly CredentialConfigEntry[]> {
  const entries: CredentialConfigEntry[] = [];
  for (const scope of ["--system", "--global"] as const) {
    const result = await runGitProcess(
      config.gitExecutable,
      ["config", scope, "--includes", "--null", "--get-regexp", CREDENTIAL_CONFIG_PATTERN],
      {
        allowedExitCodes: [0, 1],
        environment: hostEnvironment(),
        signal,
      },
    );
    if (result.exitCode === 1) continue;
    const records = decodeUtf8(result.stdout).split("\0");
    if (records.at(-1) === "") records.pop();
    for (const record of records) {
      const separator = record.indexOf("\n");
      const key = separator === -1 ? "" : record.slice(0, separator);
      const value = separator === -1 ? "" : record.slice(separator + 1);
      if (
        !/^credential(?:\.[^\0\r\n]+)?\.(?:helper|usehttppath)$/iu.test(key) ||
        /\p{Cc}/u.test(value) ||
        Buffer.byteLength(key, "utf8") > MAX_CREDENTIAL_CONFIG_BYTES ||
        Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_CONFIG_BYTES
      ) {
        throw new LocalSourceError("git_inspection_failed");
      }
      entries.push({ key, value });
    }
  }
  if (entries.length > MAX_CREDENTIAL_CONFIG_ENTRIES) {
    throw new LocalSourceError("git_inspection_failed");
  }
  return entries;
}

function validBranchRef(branch: string): boolean {
  const branchRef = `refs/heads/${branch}`;
  return !(
    Buffer.byteLength(branchRef, "utf8") > 255 ||
    /[\0-\x20\x7f~^:?*[\\]/u.test(branchRef) ||
    branchRef.includes("..") ||
    branchRef.includes("@{") ||
    branchRef.includes("//") ||
    branchRef.endsWith("/") ||
    branchRef.endsWith(".") ||
    branchRef
      .split("/")
      .some((component) => component.startsWith(".") || component.endsWith(".lock"))
  );
}

function validateInput(input: GitHubPullRequestObjectAcquisition): void {
  const objectIdPattern = input.objectFormat === "sha1" ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u;
  if (
    !UUID_V7.test(input.projectId) ||
    !Number.isSafeInteger(input.pullRequestNumber) ||
    input.pullRequestNumber < 1 ||
    input.pullRequestNumber > 9_999_999_999 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(input.repository.owner) ||
    !/^[A-Za-z0-9._-]{1,100}$/u.test(input.repository.name) ||
    !objectIdPattern.test(input.base.objectId) ||
    !objectIdPattern.test(input.head.objectId) ||
    !validBranchRef(input.base.ref) ||
    !validBranchRef(input.head.ref)
  ) {
    throw new LocalSourceError("reference_not_available");
  }
}

async function ensureDirectory(path: string, containingRoot: string): Promise<string> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new LocalSourceError("source_containment_violation");
    }
  }
  const metadata = await lstat(path).catch(() => {
    throw new LocalSourceError("source_containment_violation");
  });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.getuid !== undefined && metadata.uid !== process.getuid())
  ) {
    throw new LocalSourceError("source_containment_violation");
  }
  const canonical = await realpath(path).catch(() => {
    throw new LocalSourceError("source_containment_violation");
  });
  if (!isContained(containingRoot, canonical)) {
    throw new LocalSourceError("source_containment_violation");
  }
  return canonical;
}

async function createAcquisitionRepository(
  config: LocalSourceConfig,
  input: GitHubPullRequestObjectAcquisition,
): Promise<{ acquisitionPath: string; repository: ResolvedRepository }> {
  const projects = await ensureDirectory(
    join(config.artifactRoot, "projects"),
    config.artifactRoot,
  );
  const project = await ensureDirectory(join(projects, input.projectId), projects);
  const acquisitions = await ensureDirectory(join(project, "acquisition-repositories"), project);
  const acquisitionPath = await mkdtemp(join(acquisitions, ".acquiring-"));
  await chmod(acquisitionPath, 0o700);
  const canonicalAcquisition = await realpath(acquisitionPath);
  if (!isContained(acquisitions, canonicalAcquisition)) {
    throw new LocalSourceError("source_containment_violation");
  }
  const repositoryPath = join(canonicalAcquisition, "repository.git");
  return {
    acquisitionPath: canonicalAcquisition,
    repository: {
      displayName: `${input.repository.owner}/${input.repository.name}#${String(input.pullRequestNumber)}`,
      path: repositoryPath,
      relativePath: "repository.git",
      repositoryId: input.projectId,
      rootId: input.projectId,
      rootPath: canonicalAcquisition,
    },
  };
}

async function initializeAcquisitionRepository(
  config: LocalSourceConfig,
  input: GitHubPullRequestObjectAcquisition,
  repository: ResolvedRepository,
): Promise<void> {
  await mkdir(repository.path, { mode: 0o700 });
  await runGitProcess(
    config.gitExecutable,
    [
      "--no-lazy-fetch",
      ...SAFE_GIT_CONFIG_ARGUMENTS,
      "-C",
      repository.path,
      "init",
      "--bare",
      `--object-format=${input.objectFormat}`,
      "--template=",
    ],
    { environment: safeFetchEnvironment([]), signal: input.signal },
  );
}

async function removeAcquisitionRepository(
  config: LocalSourceConfig,
  projectId: string,
  acquisitionPath: string,
): Promise<void> {
  const acquisitions = join(config.artifactRoot, "projects", projectId, "acquisition-repositories");
  if (
    !isContained(acquisitions, acquisitionPath) ||
    !basename(acquisitionPath).startsWith(".acquiring-")
  ) {
    throw new LocalSourceError("source_containment_violation");
  }
  await rm(acquisitionPath, { force: true, recursive: true }).catch(() => {
    throw new LocalSourceError("source_containment_violation");
  });
}

async function fetchExactPullRequest(
  config: LocalSourceConfig,
  input: GitHubPullRequestObjectAcquisition,
  repository: ResolvedRepository,
): Promise<RepositoryInspection> {
  const remote = `https://github.com/${input.repository.owner}/${input.repository.name}.git`;
  const credentialConfig = await readCredentialConfiguration(config, input.signal);
  const maxStorageBytes = acquisitionStorageBudget(config);
  const fetch = async (refspecs: readonly string[]) => {
    const result = await runGitProcess(
      config.gitExecutable,
      [
        "--no-lazy-fetch",
        ...SAFE_GIT_CONFIG_ARGUMENTS,
        "-C",
        repository.path,
        "fetch",
        "--atomic",
        "--depth=1",
        "--no-auto-maintenance",
        "--no-recurse-submodules",
        "--no-tags",
        "--no-write-fetch-head",
        "--quiet",
        "--refmap=",
        "--",
        remote,
        ...refspecs,
      ],
      {
        allowedExitCodes: [0, 1, 128],
        environment: safeFetchEnvironment(credentialConfig),
        signal: input.signal,
        storageBudget: { maxBytes: maxStorageBytes, rootPath: repository.rootPath },
        timeoutMs: GIT_FETCH_TIMEOUT_MS,
      },
    );
    await verifyAcquisitionStorageBudget(repository, maxStorageBytes);
    return result;
  };
  const initialFetch = await fetch([
    `+refs/heads/${input.base.ref}:refs/kestrel/base`,
    `+refs/pull/${String(input.pullRequestNumber)}/head:refs/kestrel/head`,
  ]);
  if (initialFetch.exitCode !== 0) {
    if (fetchAuthenticationFailure(initialFetch.stderr)) {
      throw new LocalSourceError("provider_authentication_required");
    }
    const missing = missingFetchRef(initialFetch.stderr, input);
    if (missing === null) {
      throw new LocalSourceError("provider_resource_unavailable");
    }
    const recovery = await fetch([
      `+${input.base.objectId}:refs/kestrel/base`,
      `+${input.head.objectId}:refs/kestrel/head`,
    ]);
    if (recovery.exitCode !== 0) {
      if (fetchAuthenticationFailure(recovery.stderr)) {
        throw new LocalSourceError("provider_authentication_required");
      }
      if (fetchProviderResourceFailure(recovery.stderr)) {
        throw new LocalSourceError("provider_resource_unavailable");
      }
      throw new LocalSourceError(
        missing === "base" ? "base_revision_unresolvable" : "head_revision_unresolvable",
      );
    }
  }
  const readFetchedRef = async (ref: string) =>
    decodeUtf8(
      (
        await runGitProcess(
          config.gitExecutable,
          [
            "--no-lazy-fetch",
            ...SAFE_GIT_CONFIG_ARGUMENTS,
            "-C",
            repository.path,
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${ref}^{commit}`,
          ],
          { environment: safeFetchEnvironment([]), signal: input.signal },
        )
      ).stdout,
    ).trim();
  const expectedRefs = [
    ["refs/kestrel/base", input.base.objectId],
    ["refs/kestrel/head", input.head.objectId],
  ] as const;
  const mismatched = [] as Array<(typeof expectedRefs)[number]>;
  for (const expectedRef of expectedRefs) {
    if ((await readFetchedRef(expectedRef[0])) !== expectedRef[1]) mismatched.push(expectedRef);
  }
  if (mismatched.length > 0) {
    const recovery = await fetch(mismatched.map(([ref, expected]) => `+${expected}:${ref}`));
    if (recovery.exitCode !== 0) {
      if (fetchAuthenticationFailure(recovery.stderr)) {
        throw new LocalSourceError("provider_authentication_required");
      }
      if (fetchProviderResourceFailure(recovery.stderr)) {
        throw new LocalSourceError("provider_resource_unavailable");
      }
      if (mismatched.some(([ref]) => ref === "refs/kestrel/head")) {
        throw new LocalSourceError("pull_ref_mismatch");
      }
      if (mismatched.some(([ref]) => ref === "refs/kestrel/base")) {
        throw new LocalSourceError("base_revision_unresolvable");
      }
      throw new LocalSourceError("provider_resource_unavailable");
    }
    for (const [ref, expected] of expectedRefs) {
      if ((await readFetchedRef(ref)) !== expected) {
        throw new LocalSourceError("reference_not_available");
      }
    }
  }
  await verifyAcquisitionConfiguration(config, input, repository);
  const inspection = await inspectRepository(config, repository, input.signal);
  if (inspection.objectFormat !== input.objectFormat) {
    throw new LocalSourceError("object_verification_failed");
  }
  const primaryObjectDirectory = await realpath(join(repository.path, "objects")).catch(() => {
    throw new LocalSourceError("object_verification_failed");
  });
  if (
    inspection.objectDirectories.length !== 1 ||
    inspection.objectDirectories[0] !== primaryObjectDirectory
  ) {
    throw new LocalSourceError("object_verification_failed");
  }
  await verifyAcquisitionBudget(config, input, repository, maxStorageBytes);
  await verifyAcquisitionReferences(config, input, repository);
  await runGitProcess(
    config.gitExecutable,
    [
      "--no-lazy-fetch",
      ...SAFE_GIT_CONFIG_ARGUMENTS,
      "-C",
      repository.path,
      "fsck",
      "--full",
      "--strict",
      "--no-reflogs",
      "--no-dangling",
      "--no-progress",
    ],
    {
      environment: safeFetchEnvironment([]),
      failureCode: "object_verification_failed",
      signal: input.signal,
      timeoutMs: GIT_FETCH_TIMEOUT_MS,
    },
  );
  return inspection;
}

export async function withGitHubPullRequestObjects<T>(
  config: LocalSourceConfig,
  input: GitHubPullRequestObjectAcquisition,
  action: (source: AcquiredGitObjectSource) => Promise<T>,
): Promise<T> {
  validateInput(input);
  const created = await createAcquisitionRepository(config, input);
  let outcome: PromiseSettledResult<T>;
  try {
    await initializeAcquisitionRepository(config, input, created.repository);
    const inspection = await fetchExactPullRequest(config, input, created.repository);
    outcome = {
      status: "fulfilled",
      value: await action({ inspection, repository: created.repository }),
    };
  } catch (reason) {
    outcome = { reason, status: "rejected" };
  }
  try {
    await removeAcquisitionRepository(config, input.projectId, created.acquisitionPath);
  } catch {
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  }
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}
