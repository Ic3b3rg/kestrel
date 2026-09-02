import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { readRepositoryRootConfiguration } from "./repository-root-configuration.js";

const GIT_VERSION_TIMEOUT_MS = 10_000;
const GIT_OBJECT_READ_TIMEOUT_MS = 60_000;
const MAX_GIT_VERSION_OUTPUT_BYTES = 4096;
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

export interface RepositoryRoot {
  id: string;
  path: string;
}

export interface LocalSourceConfig {
  artifactRoot: string;
  gitExecutable: string;
  gitObjectReadTimeoutMs: number;
  maxBytes: number;
  maxObjects: number;
  repositoryRoots: readonly RepositoryRoot[];
}

function configurationError(key: string, reason: string): Error {
  return new Error(`${key} ${reason}`);
}

function parsePositiveInteger(value: string | undefined, key: string): number {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) {
    throw configurationError(key, "must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw configurationError(key, "must be a safe integer");
  }
  return parsed;
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

function opaqueUuid(namespace: string, value: string): string {
  const bytes = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(value)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function canonicalDirectory(path: string, key: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw configurationError(key, "must be absolute");
  }
  let canonical: string;
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("not a non-symlink directory");
    }
    await access(path, constants.R_OK | constants.X_OK);
    canonical = await realpath(path);
  } catch {
    throw configurationError(key, "must identify an existing directory");
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw configurationError(key, "must identify a directory");
  }
  return canonical;
}

async function canonicalArtifactRoot(
  path: string,
  repositoryRoots: readonly string[],
): Promise<string> {
  if (!isAbsolute(path)) {
    throw configurationError("ARTIFACT_ROOT", "must be absolute");
  }
  const candidate = resolve(path);
  for (const repositoryRoot of repositoryRoots) {
    if (isContained(repositoryRoot, candidate) || isContained(candidate, repositoryRoot)) {
      throw configurationError("ARTIFACT_ROOT", "must not overlap a repository root");
    }
  }
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch {
    throw configurationError("ARTIFACT_ROOT", "must identify an existing directory");
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw configurationError("ARTIFACT_ROOT", "must identify a non-symlink directory");
  }
  if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
    throw configurationError("ARTIFACT_ROOT", "must be owned by the Kestrel process");
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    throw configurationError("ARTIFACT_ROOT", "must have mode 0700");
  }
  const canonical = await realpath(candidate).catch(() => {
    throw configurationError("ARTIFACT_ROOT", "could not be canonicalized");
  });
  for (const repositoryRoot of repositoryRoots) {
    if (isContained(repositoryRoot, canonical) || isContained(canonical, repositoryRoot)) {
      throw configurationError("ARTIFACT_ROOT", "must not overlap a repository root");
    }
  }
  return canonical;
}

async function validateGitExecutable(value: string | undefined): Promise<string> {
  if (value === undefined || !isAbsolute(value)) {
    throw configurationError("LOCAL_GIT_EXECUTABLE", "must be an absolute executable path");
  }
  let canonical: string;
  try {
    canonical = await realpath(value);
    if (!(await stat(canonical)).isFile()) {
      throw new Error("not a file");
    }
    await access(canonical, constants.X_OK);
  } catch {
    throw configurationError("LOCAL_GIT_EXECUTABLE", "must identify an executable file");
  }
  let stdout: string;
  try {
    stdout = await readGitVersion(canonical);
  } catch {
    throw configurationError("LOCAL_GIT_EXECUTABLE", "could not report a supported Git version");
  }
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/u.exec(stdout.trim());
  if (match === null) {
    throw configurationError("LOCAL_GIT_EXECUTABLE", "could not report a supported Git version");
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 2 || (major === 2 && minor < 45)) {
    throw configurationError("LOCAL_GIT_EXECUTABLE", "must provide Git 2.45 or newer");
  }
  return canonical;
}

function readGitVersion(executable: string): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, ["--version"], {
      detached: process.platform !== "win32",
      env: SAFE_GIT_ENV,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let rejected = false;
    let timedOut = false;
    let settled = false;

    const terminate = () => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // The group may already be gone; kill the direct child as a final fallback.
        }
      }
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, GIT_VERSION_TIMEOUT_MS);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_GIT_VERSION_OUTPUT_BYTES) {
        rejected = true;
        terminate();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_GIT_VERSION_OUTPUT_BYTES) {
        rejected = true;
        terminate();
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectPromise(new Error("Git version process failed"));
      }
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (rejected || timedOut || exitCode !== 0) {
        rejectPromise(new Error("Git version process failed"));
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

export async function readLocalSourceConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalSourceConfig> {
  let configuredRoots: unknown;
  if (env.LOCAL_REPOSITORY_ROOTS !== undefined) {
    try {
      configuredRoots = JSON.parse(env.LOCAL_REPOSITORY_ROOTS) as unknown;
    } catch {
      throw configurationError("LOCAL_REPOSITORY_ROOTS", "must be a JSON array");
    }
  } else if (env.LOCAL_REPOSITORY_ROOTS_FILE !== undefined) {
    configuredRoots = await readRepositoryRootConfiguration(env.LOCAL_REPOSITORY_ROOTS_FILE);
  } else {
    configuredRoots = [];
  }
  if (
    !Array.isArray(configuredRoots) ||
    !configuredRoots.every((value) => typeof value === "string")
  ) {
    throw configurationError("LOCAL_REPOSITORY_ROOTS", "must be a JSON array of paths");
  }

  const canonicalRoots = await Promise.all(
    configuredRoots.map((path) => canonicalDirectory(path, "LOCAL_REPOSITORY_ROOTS")),
  );
  for (const [index, root] of canonicalRoots.entries()) {
    for (const other of canonicalRoots.slice(index + 1)) {
      if (isContained(root, other) || isContained(other, root)) {
        throw configurationError(
          "LOCAL_REPOSITORY_ROOTS",
          "must not contain duplicate or nested roots",
        );
      }
    }
  }

  const [artifactRoot, gitExecutable] = await Promise.all([
    canonicalArtifactRoot(env.ARTIFACT_ROOT ?? "", canonicalRoots),
    validateGitExecutable(env.LOCAL_GIT_EXECUTABLE),
  ]);
  const repositoryRoots = canonicalRoots.map((path) =>
    Object.freeze({ id: opaqueUuid("kestrel.repository-root.v1", path), path }),
  );
  return Object.freeze({
    artifactRoot,
    gitExecutable,
    gitObjectReadTimeoutMs: GIT_OBJECT_READ_TIMEOUT_MS,
    maxBytes: parsePositiveInteger(env.REVIEW_REVISION_MAX_BYTES, "REVIEW_REVISION_MAX_BYTES"),
    maxObjects: parsePositiveInteger(
      env.REVIEW_REVISION_MAX_OBJECTS,
      "REVIEW_REVISION_MAX_OBJECTS",
    ),
    repositoryRoots: Object.freeze(repositoryRoots),
  });
}
