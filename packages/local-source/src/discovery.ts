import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

import type { LocalSourceConfig, RepositoryRoot } from "./config.js";
import { LocalSourceError } from "./errors.js";

const MAX_SCAN_DEPTH = 6;
const MAX_SCANNED_DIRECTORIES = 10_000;
const MAX_SCANNED_ENTRIES = 10_000;
const MAX_DISCOVERED_REPOSITORIES = 100;

export interface DiscoveredRepository {
  displayName: string;
  repositoryId: string;
  rootId: string;
}

export interface ResolvedRepository extends DiscoveredRepository {
  path: string;
  relativePath: string;
  rootPath: string;
}

type Candidate = ResolvedRepository;

function isContained(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== ".." &&
      !isAbsolute(pathFromParent))
  );
}

function repositoryId(rootId: string, relativePath: string): string {
  const bytes = createHash("sha256")
    .update("kestrel.repository-candidate.v1")
    .update("\0")
    .update(rootId)
    .update("\0")
    .update(relativePath)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    const marker = await lstat(join(directory, ".git"));
    return !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile());
  } catch {
    return false;
  }
}

async function isBareRepositoryCandidate(directory: string): Promise<boolean> {
  try {
    const [head, objects, refs] = await Promise.all([
      lstat(join(directory, "HEAD")),
      lstat(join(directory, "objects")),
      lstat(join(directory, "refs")),
    ]);
    return (
      head.isFile() &&
      !head.isSymbolicLink() &&
      objects.isDirectory() &&
      !objects.isSymbolicLink() &&
      refs.isDirectory() &&
      !refs.isSymbolicLink()
    );
  } catch {
    return false;
  }
}

function displayName(root: RepositoryRoot, relativePath: string): string {
  if (relativePath === "") {
    return basename(root.path).slice(0, 256);
  }
  return relativePath.length <= 256 ? relativePath : `…${relativePath.slice(-255)}`;
}

async function readBoundedEntries(
  path: string,
  budget: { directories: number; entries: number },
): Promise<Dirent[] | null> {
  let directory;
  try {
    directory = await opendir(path);
  } catch {
    return null;
  }
  const entries: Dirent[] = [];
  for await (const entry of directory) {
    budget.entries += 1;
    if (budget.entries > MAX_SCANNED_ENTRIES) {
      throw new LocalSourceError("discovery_limit_exceeded");
    }
    entries.push(entry);
  }
  return entries;
}

async function discoverRoot(
  root: RepositoryRoot,
  budget: { directories: number; entries: number },
): Promise<Candidate[]> {
  const repositories: Candidate[] = [];
  const queue: Array<{ depth: number; path: string; relativePath: string }> = [
    { depth: 0, path: root.path, relativePath: "" },
  ];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) {
      break;
    }
    budget.directories += 1;
    if (budget.directories > MAX_SCANNED_DIRECTORIES) {
      throw new LocalSourceError("discovery_limit_exceeded");
    }

    let metadata;
    let canonical;
    try {
      metadata = await lstat(current.path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        continue;
      }
      canonical = await realpath(current.path);
    } catch {
      continue;
    }
    if (!isContained(root.path, canonical)) {
      continue;
    }

    if ((await hasGitMarker(canonical)) || (await isBareRepositoryCandidate(canonical))) {
      repositories.push({
        displayName: displayName(root, current.relativePath),
        repositoryId: repositoryId(root.id, current.relativePath),
        rootId: root.id,
        path: canonical,
        relativePath: current.relativePath,
        rootPath: root.path,
      });
      if (repositories.length > MAX_DISCOVERED_REPOSITORIES) {
        throw new LocalSourceError("discovery_limit_exceeded");
      }
      continue;
    }
    if (current.depth >= MAX_SCAN_DEPTH) {
      continue;
    }

    const entries = await readBoundedEntries(canonical, budget);
    if (entries === null) {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      const childRelativePath =
        current.relativePath === "" ? entry.name : join(current.relativePath, entry.name);
      queue.push({
        depth: current.depth + 1,
        path: join(canonical, entry.name),
        relativePath: childRelativePath,
      });
    }
  }
  return repositories;
}

async function discoverCandidates(config: LocalSourceConfig): Promise<Candidate[]> {
  const budget = { directories: 0, entries: 0 };
  const repositories: Candidate[] = [];
  for (const root of config.repositoryRoots) {
    repositories.push(...(await discoverRoot(root, budget)));
    if (repositories.length > MAX_DISCOVERED_REPOSITORIES) {
      throw new LocalSourceError("discovery_limit_exceeded");
    }
  }
  return repositories.sort((left, right) =>
    left.displayName === right.displayName
      ? left.repositoryId.localeCompare(right.repositoryId, "en")
      : left.displayName.localeCompare(right.displayName, "en"),
  );
}

export async function discoverRepositories(
  config: LocalSourceConfig,
): Promise<readonly DiscoveredRepository[]> {
  const candidates = await discoverCandidates(config);
  return candidates.map(({ displayName, repositoryId: id, rootId }) => ({
    displayName,
    repositoryId: id,
    rootId,
  }));
}

/** Server-only inventory retaining canonical paths from one bounded discovery pass. */
export function discoverResolvedRepositories(
  config: LocalSourceConfig,
): Promise<readonly ResolvedRepository[]> {
  return discoverCandidates(config);
}

export async function resolveRepository(
  config: LocalSourceConfig,
  requestedRepositoryId: string,
): Promise<ResolvedRepository> {
  const candidates = await discoverCandidates(config);
  const candidate = candidates.find(({ repositoryId: id }) => id === requestedRepositoryId);
  if (candidate === undefined) {
    throw new LocalSourceError("repository_not_available");
  }
  const canonical = await realpath(candidate.path).catch(() => {
    throw new LocalSourceError("repository_not_available");
  });
  if (!isContained(candidate.rootPath, canonical)) {
    throw new LocalSourceError("repository_not_available");
  }
  return { ...candidate, path: canonical };
}
