import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const MAX_CONFIGURATION_BYTES = 64 * 1024;

interface RepositoryRootConfiguration {
  readonly repositoryRoots: readonly string[];
  readonly schemaVersion: 1;
}

function configurationError(reason: string): Error {
  return new Error(`LOCAL_REPOSITORY_ROOTS_FILE ${reason}`);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function parseConfiguration(value: unknown): RepositoryRootConfiguration {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("repositoryRoots" in value) ||
    !Array.isArray(value.repositoryRoots) ||
    !value.repositoryRoots.every((root) => typeof root === "string")
  ) {
    throw configurationError("must contain a valid version 1 configuration");
  }
  return value as unknown as RepositoryRootConfiguration;
}

export async function readRepositoryRootConfiguration(
  configurationPath: string,
): Promise<readonly string[]> {
  if (!isAbsolute(configurationPath)) {
    throw configurationError("must be an absolute path");
  }

  let handle;
  try {
    handle = await open(configurationPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return [];
    throw configurationError("must identify an owner-only regular file");
  }

  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (process.getuid !== undefined && metadata.uid !== process.getuid()) ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > MAX_CONFIGURATION_BYTES
    ) {
      throw configurationError("must identify a bounded owner-only regular file");
    }
    const contents = await handle.readFile("utf8");
    try {
      return Object.freeze([
        ...parseConfiguration(JSON.parse(contents) as unknown).repositoryRoots,
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("LOCAL_REPOSITORY_ROOTS_FILE ")) {
        throw error;
      }
      throw configurationError("must contain valid JSON");
    }
  } finally {
    await handle.close();
  }
}

export async function writeRepositoryRootConfiguration(
  configurationPath: string,
  repositoryRoots: readonly string[],
): Promise<void> {
  if (!isAbsolute(configurationPath)) {
    throw configurationError("must be an absolute path");
  }
  const temporaryPath = join(
    dirname(configurationPath),
    `.repository-roots-${randomBytes(16).toString("hex")}.tmp`,
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({ schemaVersion: 1, repositoryRoots }, null, 2)}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, configurationPath);
    await chmod(configurationPath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
