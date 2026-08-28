import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverResolvedRepositories,
  inspectRepository,
  readLocalSourceConfig,
  readRetainedFile,
  retainRevision,
} from "./index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function makeWritable(path: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await makeWritable(join(path, entry));
    return;
  }
  await chmod(path, 0o600);
}

async function git(repository: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        makeWritable(directory).then(() => rm(directory, { force: true, recursive: true })),
      ),
  );
});

describe("composite Review Revision retention", () => {
  it("reads local objects first and falls back only for missing objects", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "kestrel-composite-retention-"));
    temporaryDirectories.push(fixture);
    const root = join(fixture, "repositories");
    const source = join(root, "acquired.git-source");
    const local = join(root, "operator-clone");
    const artifacts = join(fixture, "artifacts");
    await mkdir(source, { recursive: true });
    await mkdir(artifacts, { mode: 0o700 });
    await chmod(artifacts, 0o700);
    await git(source, ["init", "--initial-branch=main"]);
    await git(source, ["config", "user.name", "Kestrel Test"]);
    await git(source, ["config", "user.email", "kestrel@example.invalid"]);
    await writeFile(join(source, "review.txt"), "base\n", "utf8");
    await git(source, ["add", "review.txt"]);
    await git(source, ["commit", "-m", "Base"]);
    const baseObjectId = await git(source, ["rev-parse", "HEAD"]);
    await execFileAsync("/usr/bin/git", ["clone", "--no-hardlinks", source, local]);
    await git(source, ["switch", "-c", "review-source"]);
    await writeFile(join(source, "review.txt"), "head\n", "utf8");
    await git(source, ["commit", "-am", "Head"]);
    const headObjectId = await git(source, ["rev-parse", "HEAD"]);

    const config = await readLocalSourceConfig({
      ARTIFACT_ROOT: artifacts,
      LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
      LOCAL_REPOSITORY_ROOTS: JSON.stringify([root]),
      REVIEW_REVISION_MAX_BYTES: "1048576",
      REVIEW_REVISION_MAX_OBJECTS: "1000",
    });
    const repositories = await discoverResolvedRepositories(config);
    const localRepository = repositories.find(
      ({ displayName }) => displayName === "operator-clone",
    );
    const acquiredRepository = repositories.find(
      ({ displayName }) => displayName === "acquired.git-source",
    );
    if (localRepository === undefined || acquiredRepository === undefined) {
      throw new Error("Composite source fixture was not discovered");
    }
    const localInspection = await inspectRepository(config, localRepository);
    const acquiredInspection = await inspectRepository(config, acquiredRepository);
    const selected = {
      ...localInspection,
      base: { objectId: baseObjectId, ref: "main" },
      head: { objectId: headObjectId, ref: "review-source" },
      repository: localRepository,
    };
    await rm(join(source, ".git", "objects", baseObjectId.slice(0, 2), baseObjectId.slice(2)));

    await expect(
      retainRevision(config, {
        projectId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
        revisionId: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
        selected,
      }),
    ).rejects.toMatchObject({ code: "object_missing" });

    const retained = await retainRevision(config, {
      fallbackSource: { inspection: acquiredInspection, repository: acquiredRepository },
      projectId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
      revisionId: "018f0f89-9a21-7271-b92d-f1cb0d48bb48",
      selected,
    });
    await expect(
      readRetainedFile(config, {
        artifactLocator: retained.artifactLocator,
        manifestDigest: retained.manifestDigest,
        path: "review.txt",
        side: "base",
      }),
    ).resolves.toEqual(Buffer.from("base\n"));
    await expect(
      readRetainedFile(config, {
        artifactLocator: retained.artifactLocator,
        manifestDigest: retained.manifestDigest,
        path: "review.txt",
        side: "head",
      }),
    ).resolves.toEqual(Buffer.from("head\n"));
  });
});
