import { lstat, open, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readLocalSourceConfig, type LocalSourceConfig } from "./config.js";
import { discoverResolvedRepositories } from "./discovery.js";
import { inspectRepository } from "./git.js";
import {
  readRepositoryRootConfiguration,
  writeRepositoryRootConfiguration,
} from "./repository-root-configuration.js";

export class SourceAuthorizationError extends Error {}

export interface SourceAuthorizationPreview {
  existingRoots: readonly string[];
  repositories: { displayName: string; repositoryId: string; path: string; identity: string }[];
  skipped: number;
}

function configurationFile(env: NodeJS.ProcessEnv): string {
  if (env.LOCAL_REPOSITORY_ROOTS_FILE === undefined) {
    throw new SourceAuthorizationError(
      "Local folder authorization is unavailable. Configure the workstation source inventory first.",
    );
  }
  return env.LOCAL_REPOSITORY_ROOTS_FILE;
}

async function validateRoots(
  roots: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<LocalSourceConfig> {
  return readLocalSourceConfig({ ...env, LOCAL_REPOSITORY_ROOTS: JSON.stringify(roots) }).catch(
    (error: unknown) => {
      if (
        error instanceof Error &&
        /^(LOCAL_REPOSITORY_ROOTS|ARTIFACT_ROOT|MODEL_PROVIDER_SECRET_ROOT) /u.test(error.message)
      )
        throw new SourceAuthorizationError(error.message);
      throw new SourceAuthorizationError(
        "Source configuration is unavailable. Check the workstation configuration.",
      );
    },
  );
}

async function hasRepositoryMarker(path: string): Promise<boolean> {
  return (
    (await lstat(join(path, ".git")).catch(() => null)) !== null ||
    (await lstat(join(path, "HEAD")).catch(() => null)) !== null
  );
}

async function identity(path: string): Promise<string> {
  const metadata = await lstat(path);
  const marker = await lstat(join(path, ".git")).catch(() => lstat(join(path, "HEAD")));
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || marker.isSymbolicLink()) {
    throw new SourceAuthorizationError("The selected repository changed. Choose the folder again.");
  }
  return [
    metadata.dev,
    metadata.ino,
    metadata.birthtimeMs,
    marker.dev,
    marker.ino,
    marker.birthtimeMs,
  ].join(":");
}

/** Trusted host paths stay server-side; only the caller's explicit selection is examined. */
export async function previewSourceAuthorization(
  selectedPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SourceAuthorizationPreview> {
  const existingRoots = await readRepositoryRootConfiguration(configurationFile(env));
  // Validate the selected container before reading any of its entries, including overlap rules.
  const validated = await validateRoots([...existingRoots, selectedPath], env);
  const selected = validated.repositoryRoots.at(-1);
  if (selected === undefined)
    throw new SourceAuthorizationError("Choose a readable repository folder.");
  const paths: string[] = [];
  let skipped = 0;
  if (await hasRepositoryMarker(selected.path)) {
    paths.push(selected.path);
  } else {
    const directory = await opendir(selected.path);
    let entries = 0;
    for await (const entry of directory) {
      if (++entries > 1000)
        throw new SourceAuthorizationError(
          "This folder is too large. Choose a repository directly.",
        );
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const path = join(selected.path, entry.name);
        if (await hasRepositoryMarker(path)) paths.push(path);
      }
    }
  }
  if (paths.length > 100)
    throw new SourceAuthorizationError("Too many repositories. Choose a smaller folder.");
  const repositories: SourceAuthorizationPreview["repositories"] = [];
  for (const path of paths.sort()) {
    try {
      const config = await validateRoots([path], env);
      const candidate = (await discoverResolvedRepositories(config))[0];
      if (candidate === undefined || candidate.path !== config.repositoryRoots[0]?.path) {
        throw new SourceAuthorizationError("Invalid repository");
      }
      await inspectRepository(config, candidate);
      repositories.push({
        displayName: candidate.displayName,
        repositoryId: candidate.repositoryId,
        path: candidate.path,
        identity: await identity(candidate.path),
      });
    } catch {
      skipped += 1;
    }
  }
  if (repositories.length === 0)
    throw new SourceAuthorizationError(
      "No readable Git repositories were found. Choose a repository or its immediate parent folder.",
    );
  return { existingRoots, repositories, skipped };
}

/** Serialize UI and CLI authorization and reject an inventory or repository changed since preview. */
export async function confirmSourceAuthorization(
  preview: SourceAuthorizationPreview,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = configurationFile(env);
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch(() => {
    throw new SourceAuthorizationError(
      "Source authorization is busy. Retry after the other authorization finishes.",
    );
  });
  try {
    const current = await readRepositoryRootConfiguration(path);
    if (JSON.stringify(current) !== JSON.stringify(preview.existingRoots)) {
      throw new SourceAuthorizationError(
        "Authorized repositories changed. Choose the folder again.",
      );
    }
    for (const repository of preview.repositories) {
      if ((await identity(repository.path).catch(() => null)) !== repository.identity) {
        throw new SourceAuthorizationError(
          "The selected repository changed. Choose the folder again.",
        );
      }
    }
    const config = await validateRoots(
      [...current, ...preview.repositories.map((repository) => repository.path)],
      env,
    );
    await writeRepositoryRootConfiguration(
      path,
      config.repositoryRoots.map((root) => root.path),
    );
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
