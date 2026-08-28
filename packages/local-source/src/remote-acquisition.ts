import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
const CREDENTIAL_CONFIG_PATTERN = "^credential(\\..*)?\\.(helper|useHttpPath)$";
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
  stdout: Buffer;
}

interface GitProcessOptions {
  allowedExitCodes?: readonly number[];
  environment: NodeJS.ProcessEnv;
  failureCode?: LocalSourceErrorCode;
  maxStdoutBytes?: number;
  signal?: AbortSignal | undefined;
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
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: LocalSourceErrorCode | null = null;
    let settled = false;

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
      options.signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) rejectPromise(error);
      else if (result !== undefined) resolvePromise(result);
      else rejectPromise(new LocalSourceError("git_inspection_failed"));
    };
    const onAbort = () => {
      failure = "acquisition_cancelled";
      terminate();
    };
    const timer = setTimeout(() => {
      failure = "git_inspection_failed";
      terminate();
    }, options.timeoutMs ?? GIT_PROCESS_TIMEOUT_MS);
    timer.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > (options.maxStdoutBytes ?? MAX_GIT_OUTPUT_BYTES)) {
        failure = "git_inspection_failed";
        terminate();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_GIT_OUTPUT_BYTES) {
        failure = "git_inspection_failed";
        terminate();
      }
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
      finish({ exitCode, stdout: Buffer.concat(stdout, stdoutBytes) });
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
    !objectIdPattern.test(input.head.objectId)
  ) {
    throw new LocalSourceError("reference_not_available");
  }
  const branchRef = `refs/heads/${input.base.ref}`;
  if (
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
  const fetch = (refspecs: readonly string[]) =>
    runGitProcess(
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
        environment: safeFetchEnvironment(credentialConfig),
        failureCode: "reference_not_available",
        signal: input.signal,
        timeoutMs: GIT_FETCH_TIMEOUT_MS,
      },
    );
  await fetch([
    `+refs/heads/${input.base.ref}:refs/kestrel/base`,
    `+refs/pull/${String(input.pullRequestNumber)}/head:refs/kestrel/head`,
  ]);
  const inspection = await inspectRepository(config, repository, input.signal);
  if (inspection.objectFormat !== input.objectFormat) {
    throw new LocalSourceError("object_verification_failed");
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
    await fetch(mismatched.map(([ref, expected]) => `+${expected}:${ref}`));
    for (const [ref, expected] of expectedRefs) {
      if ((await readFetchedRef(ref)) !== expected) {
        throw new LocalSourceError("reference_not_available");
      }
    }
  }
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
