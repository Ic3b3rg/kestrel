import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { readLocalSourceConfig } from "./config.js";
import { discoverResolvedRepositories } from "./discovery.js";
import { inspectRepository } from "./git.js";
import {
  readCredentialConfiguration,
  safeFetchEnvironment,
  SAFE_GIT_CONFIG_ARGUMENTS,
} from "./remote-acquisition.js";
import {
  confirmSourceAuthorization,
  previewSourceAuthorization,
  SourceAuthorizationError,
} from "./source-authorization.js";

export interface ManagedSource {
  repositoryId: string;
  displayName: string;
}
interface CloneRequest {
  destination: string;
  url: string;
  gitExecutable: string;
  maxBytes: number;
  signal?: AbortSignal | undefined;
}
type Clone = (request: CloneRequest) => Promise<void>;

export function normalizeCloneUrl(input: string): { identity: string; url: string; name: string } {
  const invalid = () =>
    new SourceAuthorizationError(
      "Enter an HTTPS or SSH Git URL without passwords, tokens, query parameters, or fragments.",
    );
  if (input.length > 2048 || /[\s\p{Cc}]/u.test(input)) throw invalid();
  const scp = /^([a-zA-Z0-9_-]+)@([a-zA-Z0-9.-]+):([a-zA-Z0-9_./-]+)$/u.exec(input);
  let parsed: URL;
  try {
    parsed = new URL(scp ? `ssh://${scp[1] ?? ""}@${scp[2] ?? ""}/${scp[3] ?? ""}` : input);
  } catch {
    throw invalid();
  }
  if (
    !["https:", "ssh:"].includes(parsed.protocol) ||
    parsed.password ||
    (parsed.protocol === "https:" && parsed.username) ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname ||
    /%|\\/u.test(parsed.pathname)
  )
    throw invalid();
  const path = parsed.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  if (
    !path ||
    path
      .split("/")
      .some((part) => !/^[a-zA-Z0-9_.-]+$/u.test(part) || part === "." || part === "..")
  )
    throw invalid();
  const identity = `${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}/${parsed.hostname.toLowerCase() === "github.com" ? path.toLowerCase() : path}`;
  return {
    identity,
    url: input,
    name: basename(
      parsed.hostname.toLowerCase() === "github.com" ? path.toLowerCase() : path,
    ).slice(0, 128),
  };
}

async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && metadata.uid !== process.getuid())
  )
    throw new SourceAuthorizationError("Managed source storage must be an owner-only directory.");
  return realpath(path);
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  const queue = [path];
  let count = 0;
  for (const current of queue) {
    const directory = await opendir(current).catch(() => null);
    if (directory === null) continue;
    for await (const entry of directory) {
      if (++count > 200_000)
        throw new SourceAuthorizationError("The clone exceeds the managed source file limit.");
      const child = join(current, entry.name);
      if (entry.isDirectory()) queue.push(child);
      else total += (await lstat(child)).size;
    }
  }
  return total;
}

async function runManagedGit(request: CloneRequest, fetchOnly = false): Promise<void> {
  const config = { gitExecutable: request.gitExecutable };
  const credentials = await readCredentialConfiguration(config, request.signal);
  const environment = {
    ...safeFetchEnvironment(credentials),
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes",
    ...(process.env.SSH_AUTH_SOCK === undefined
      ? {}
      : { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }),
  };
  // Git/SSH and credential helpers retain custody. Their output is never returned or logged.
  await new Promise<void>((resolve, reject) => {
    const args = [
      ...SAFE_GIT_CONFIG_ARGUMENTS,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.ssh.allow=always",
      ...(fetchOnly
        ? [
            "-C",
            request.destination,
            "fetch",
            "--no-recurse-submodules",
            "--",
            request.url,
            "+refs/heads/*:refs/remotes/origin/*",
          ]
        : [
            "clone",
            "--no-checkout",
            "--no-recurse-submodules",
            "--no-local",
            "--",
            request.url,
            request.destination,
          ]),
    ];
    const child = spawn(request.gitExecutable, args, {
      detached: process.platform !== "win32",
      env: environment,
      stdio: ["ignore", "ignore", "ignore"],
      shell: false,
    });
    let failure: string | null = null;
    let checking = false;
    let finished = false;
    const stop = (message: string) => {
      if (finished) return;
      failure ??= message;
      try {
        if (child.pid !== undefined && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* The child already exited. */
      }
    };
    const abort = () => stop("Clone cancelled. Retry when you are ready.");
    const deadline = setTimeout(
      () => stop("The remote operation timed out. Check host Git access and retry."),
      120_000,
    );
    const quota = setInterval(() => {
      if (checking) return;
      checking = true;
      void directoryBytes(request.destination)
        .then((bytes) => {
          if (bytes > request.maxBytes)
            stop("The clone exceeds the configured source storage limit.");
        })
        .catch(() => stop("Managed source storage is unavailable."))
        .finally(() => {
          checking = false;
        });
    }, 500);
    const cleanup = () => {
      finished = true;
      clearTimeout(deadline);
      clearInterval(quota);
      request.signal?.removeEventListener("abort", abort);
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    child.once("error", () => {
      cleanup();
      reject(
        new SourceAuthorizationError(
          "Host Git could not start. Check the workstation Git installation.",
        ),
      );
    });
    child.once("close", (code) => {
      cleanup();
      if (failure !== null || code !== 0)
        reject(
          new SourceAuthorizationError(
            failure ??
              "Git could not access this repository. Check the URL, host credentials, network, and free space, then retry.",
          ),
        );
      else resolve();
    });
  });
  if ((await directoryBytes(request.destination)) > request.maxBytes)
    throw new SourceAuthorizationError("The clone exceeds the configured source storage limit.");
}

export function createManagedSourceService(
  env: NodeJS.ProcessEnv = process.env,
  clone: Clone = runManagedGit,
) {
  const active = new Set<string>();
  const storage = async () => {
    const state =
      env.KESTREL_STATE_ROOT ??
      (env.LOCAL_REPOSITORY_ROOTS_FILE === undefined
        ? ""
        : dirname(env.LOCAL_REPOSITORY_ROOTS_FILE));
    if (!isAbsolute(state))
      throw new SourceAuthorizationError(
        "Configure an absolute workstation state root before cloning.",
      );
    return privateDirectory(join(state, "managed-sources"));
  };
  const managed = async () => {
    const root = await storage();
    const config = await readLocalSourceConfig(env);
    const sources = (await discoverResolvedRepositories(config)).filter((source) => {
      const path = relative(root, source.path);
      return (
        !path.startsWith(`..${sep}`) &&
        !isAbsolute(path) &&
        /^[a-f0-9]{64}$/u.test(path.split(sep)[0] ?? "")
      );
    });
    return { config, sources };
  };
  return {
    async list(): Promise<ManagedSource[]> {
      const { sources } = await managed();
      return sources.map(({ repositoryId, displayName }) => ({ repositoryId, displayName }));
    },
    async refresh(repositoryId: string, signal?: AbortSignal): Promise<ManagedSource> {
      const { config, sources } = await managed();
      const source = sources.find((source) => source.repositoryId === repositoryId);
      if (source === undefined)
        throw new SourceAuthorizationError(
          "This managed source is unavailable. Refresh the repository list.",
        );
      if (active.has(repositoryId))
        throw new SourceAuthorizationError("This source is already being updated.");
      active.add(repositoryId);
      try {
        const { stdout } = await promisify(execFile)(
          config.gitExecutable,
          ["-C", source.path, "config", "--local", "--no-includes", "--get", "remote.origin.url"],
          { env: safeFetchEnvironment([]), maxBuffer: 4096, timeout: 10_000 },
        );
        const remote = normalizeCloneUrl(stdout.trim());
        const key = createHash("sha256").update(remote.identity).digest("hex");
        if (basename(dirname(source.path)) !== key)
          throw new SourceAuthorizationError(
            "The managed source remote changed. Clone the intended Git URL again.",
          );
        await runManagedGit(
          {
            destination: source.path,
            url: remote.url,
            gitExecutable: config.gitExecutable,
            maxBytes: config.maxBytes,
            signal,
          },
          true,
        );
        return { repositoryId, displayName: source.displayName };
      } finally {
        active.delete(repositoryId);
      }
    },
    async clone(input: string, signal?: AbortSignal): Promise<ManagedSource> {
      const remote = normalizeCloneUrl(input);
      const root = await storage();
      const key = createHash("sha256").update(remote.identity).digest("hex");
      if (active.has(key))
        throw new SourceAuthorizationError(
          "This repository is already being cloned. Wait, then refresh or retry.",
        );
      active.add(key);
      const record = await privateDirectory(join(root, key)).catch((error: unknown) => {
        active.delete(key);
        throw error;
      });
      const destination = join(record, remote.name);
      const partial = join(record, "partial");
      const lockPath = join(record, "operation.lock");
      let lock;
      try {
        lock = await open(lockPath, "wx", 0o600).catch(async () => {
          const pid = Number(await readFile(lockPath, "utf8").catch(() => ""));
          if (!Number.isSafeInteger(pid) || pid <= 0)
            throw new SourceAuthorizationError(
              "Managed source recovery is waiting for the previous operation. Try again shortly.",
            );
          try {
            process.kill(pid, 0);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ESRCH") {
              await unlink(lockPath);
              return open(lockPath, "wx", 0o600);
            }
          }
          throw new SourceAuthorizationError(
            "Another workstation operation owns this clone. Wait and retry.",
          );
        });
        await lock.writeFile(String(process.pid));
        await lock.sync();
        await writeFile(join(record, "remote.json"), JSON.stringify({ url: remote.url }), {
          mode: 0o600,
          flag: "wx",
        }).catch((error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        });
        const config = await readLocalSourceConfig(env);
        const existing = await discoverResolvedRepositories(config);
        const available = existing.find((source) => source.path === destination);
        if (available !== undefined)
          return { repositoryId: available.repositoryId, displayName: remote.name };
        for (const source of existing) {
          const inspection = await inspectRepository(config, source);
          if (
            inspection.githubRepository !== null &&
            remote.identity.toLowerCase() ===
              `github.com/${inspection.githubRepository.owner}/${inspection.githubRepository.name}`.toLowerCase()
          )
            return { repositoryId: source.repositoryId, displayName: source.displayName };
        }
        if ((await lstat(destination).catch(() => null)) === null) {
          // This location is owned by this canonical remote and guarded by its process lock.
          await rm(partial, { recursive: true, force: true });
          const space = await statfs(root);
          if (space.bavail * space.bsize < config.maxBytes)
            throw new SourceAuthorizationError(
              "There is not enough free space for a managed source. Free space and retry.",
            );
          await clone({
            destination: partial,
            url: remote.url,
            gitExecutable: config.gitExecutable,
            maxBytes: config.maxBytes,
            signal,
          });
          if (signal?.aborted)
            throw new SourceAuthorizationError("Clone cancelled. No source was authorized.");
          const preview = await previewSourceAuthorization(partial, env);
          if (preview.repositories.length !== 1)
            throw new SourceAuthorizationError("The clone did not produce one valid repository.");
          await rename(partial, destination);
        }
        const preview = await previewSourceAuthorization(destination, env);
        await confirmSourceAuthorization(preview, env);
        const source = preview.repositories[0];
        if (source === undefined)
          throw new SourceAuthorizationError("The managed repository is unavailable.");
        return { repositoryId: source.repositoryId, displayName: remote.name };
      } finally {
        if (lock !== undefined) {
          await rm(partial, { recursive: true, force: true });
          await lock.close();
          await unlink(lockPath);
        }
        active.delete(key);
      }
    },
  };
}
