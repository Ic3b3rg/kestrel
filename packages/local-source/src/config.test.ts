import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readLocalSourceConfig, writeRepositoryRootConfiguration } from "./index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-local-source-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("local-source configuration", () => {
  it("keeps the previous configuration when a replacement exceeds the read bound", async () => {
    const fixture = await temporaryDirectory();
    const configurationPath = join(fixture, "repository-roots.json");
    await writeRepositoryRootConfiguration(configurationPath, ["/valid/root"]);
    const previousConfiguration = await readFile(configurationPath, "utf8");

    await expect(
      writeRepositoryRootConfiguration(configurationPath, [`/${"a".repeat(64 * 1024)}`]),
    ).rejects.toThrow("must be at most 65536 bytes");
    await expect(readFile(configurationPath, "utf8")).resolves.toBe(previousConfiguration);
  });

  it("loads persisted repository roots when no explicit environment override exists", async () => {
    const fixture = await temporaryDirectory();
    const repositoryRoot = join(fixture, "repositories");
    const artifactRoot = join(fixture, "artifacts");
    const configurationPath = join(fixture, "repository-roots.json");
    await mkdir(repositoryRoot);
    await mkdir(artifactRoot, { mode: 0o700 });
    await chmod(artifactRoot, 0o700);
    await writeFile(
      configurationPath,
      JSON.stringify({ schemaVersion: 1, repositoryRoots: [repositoryRoot] }),
      { mode: 0o600 },
    );

    const config = await readLocalSourceConfig({
      LOCAL_REPOSITORY_ROOTS_FILE: configurationPath,
      LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
      ARTIFACT_ROOT: artifactRoot,
      REVIEW_REVISION_MAX_BYTES: "1048576",
      REVIEW_REVISION_MAX_OBJECTS: "1000",
    });

    expect(config.repositoryRoots.map(({ path }) => path)).toEqual([
      await realpath(repositoryRoot),
    ]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "rejects an unreadable configured repository root",
    async () => {
      const fixture = await temporaryDirectory();
      const repositoryRoot = join(fixture, "repositories");
      const artifactRoot = join(fixture, "artifacts");
      await mkdir(repositoryRoot, { mode: 0o700 });
      await mkdir(artifactRoot, { mode: 0o700 });
      await chmod(repositoryRoot, 0o000);
      try {
        await expect(
          readLocalSourceConfig({
            LOCAL_REPOSITORY_ROOTS: JSON.stringify([repositoryRoot]),
            LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
            ARTIFACT_ROOT: artifactRoot,
            REVIEW_REVISION_MAX_BYTES: "1048576",
            REVIEW_REVISION_MAX_OBJECTS: "1000",
          }),
        ).rejects.toThrow("must be readable");
      } finally {
        await chmod(repositoryRoot, 0o700);
      }
    },
  );

  it.each([0o500, 0o300])("rejects artifact root mode %s", async (mode) => {
    const fixture = await temporaryDirectory();
    const repositoryRoot = join(fixture, "repositories");
    const artifactRoot = join(fixture, "artifacts");
    await mkdir(repositoryRoot, { mode: 0o700 });
    await mkdir(artifactRoot, { mode: 0o700 });
    await chmod(artifactRoot, mode);

    await expect(
      readLocalSourceConfig({
        LOCAL_REPOSITORY_ROOTS: JSON.stringify([repositoryRoot]),
        LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
        ARTIFACT_ROOT: artifactRoot,
        REVIEW_REVISION_MAX_BYTES: "1048576",
        REVIEW_REVISION_MAX_OBJECTS: "1000",
      }),
    ).rejects.toThrow("mode 0700");
  });

  it("rejects a configured repository root that is itself a symlink", async () => {
    const fixture = await temporaryDirectory();
    const repositoryRoot = join(fixture, "repositories");
    const repositoryLink = join(fixture, "repository-link");
    const artifactRoot = join(fixture, "artifacts");
    await mkdir(repositoryRoot);
    await symlink(repositoryRoot, repositoryLink);
    await mkdir(artifactRoot, { mode: 0o700 });
    await chmod(artifactRoot, 0o700);

    await expect(
      readLocalSourceConfig({
        LOCAL_REPOSITORY_ROOTS: JSON.stringify([repositoryLink]),
        LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
        ARTIFACT_ROOT: artifactRoot,
        REVIEW_REVISION_MAX_BYTES: "1048576",
        REVIEW_REVISION_MAX_OBJECTS: "1000",
      }),
    ).rejects.toThrow("must identify a non-symlink directory");
  });

  it("never creates an artifact directory through a symlink into source", async () => {
    const fixture = await temporaryDirectory();
    const repositoryRoot = join(fixture, "repositories");
    const artifactLink = join(fixture, "artifact-link");
    const escapedArtifact = join(repositoryRoot, "kestrel-artifacts");
    await mkdir(repositoryRoot);
    await symlink(repositoryRoot, artifactLink);

    await expect(
      readLocalSourceConfig({
        LOCAL_REPOSITORY_ROOTS: JSON.stringify([repositoryRoot]),
        LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
        ARTIFACT_ROOT: join(artifactLink, "kestrel-artifacts"),
        REVIEW_REVISION_MAX_BYTES: "1048576",
        REVIEW_REVISION_MAX_OBJECTS: "1000",
      }),
    ).rejects.toThrow("ARTIFACT_ROOT");
    await expect(lstat(escapedArtifact)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a Git version with command-level lazy-fetch suppression", async () => {
    const fixture = await temporaryDirectory();
    const repositoryRoot = join(fixture, "repositories");
    const artifactRoot = join(fixture, "artifacts");
    const oldGit = join(fixture, "git-2.44");
    await mkdir(repositoryRoot);
    await mkdir(artifactRoot, { mode: 0o700 });
    await chmod(artifactRoot, 0o700);
    await writeFile(oldGit, "#!/bin/sh\nprintf 'git version 2.44.0\\n'\n", { mode: 0o700 });

    await expect(
      readLocalSourceConfig({
        LOCAL_REPOSITORY_ROOTS: JSON.stringify([repositoryRoot]),
        LOCAL_GIT_EXECUTABLE: oldGit,
        ARTIFACT_ROOT: artifactRoot,
        REVIEW_REVISION_MAX_BYTES: "1048576",
        REVIEW_REVISION_MAX_OBJECTS: "1000",
      }),
    ).rejects.toThrow("Git 2.45 or newer");
  });

  it.skipIf(process.platform === "win32")(
    "kills the Git version process group when startup validation times out",
    async () => {
      const fixture = await temporaryDirectory();
      const repositoryRoot = join(fixture, "repositories");
      const artifactRoot = join(fixture, "artifacts");
      const hangingGit = join(fixture, "hanging-git");
      const childPidFile = join(fixture, "child.pid");
      await mkdir(repositoryRoot);
      await mkdir(artifactRoot, { mode: 0o700 });
      await writeFile(
        hangingGit,
        `#!/bin/sh\nsleep 30 &\nprintf '%s' "$!" > '${childPidFile}'\nwait\n`,
        { mode: 0o700 },
      );

      await expect(
        readLocalSourceConfig({
          LOCAL_REPOSITORY_ROOTS: JSON.stringify([repositoryRoot]),
          LOCAL_GIT_EXECUTABLE: hangingGit,
          ARTIFACT_ROOT: artifactRoot,
          REVIEW_REVISION_MAX_BYTES: "1048576",
          REVIEW_REVISION_MAX_OBJECTS: "1000",
        }),
      ).rejects.toThrow("could not report a supported Git version");

      const childPid = Number(await readFile(childPidFile, "utf8"));
      let childAlive = true;
      for (let attempt = 0; attempt < 20 && childAlive; attempt += 1) {
        try {
          process.kill(childPid, 0);
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          childAlive = false;
        }
      }
      expect(childAlive).toBe(false);
    },
    15_000,
  );

  it("canonicalizes separated authorized roots and rejects an overlapping artifact root", async () => {
    const fixture = await temporaryDirectory();
    const repositoryRoot = join(fixture, "repositories");
    const artifactRoot = join(fixture, "artifacts");
    await mkdir(repositoryRoot, { mode: 0o700 });
    await mkdir(artifactRoot, { mode: 0o700 });
    await chmod(artifactRoot, 0o700);

    const config = await readLocalSourceConfig({
      LOCAL_REPOSITORY_ROOTS: JSON.stringify([repositoryRoot]),
      LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
      ARTIFACT_ROOT: artifactRoot,
      REVIEW_REVISION_MAX_BYTES: "1048576",
      REVIEW_REVISION_MAX_OBJECTS: "1000",
    });
    const canonicalRepositoryRoot = await realpath(repositoryRoot);
    const canonicalArtifactRoot = await realpath(artifactRoot);

    expect(config.repositoryRoots).toHaveLength(1);
    expect(config.repositoryRoots[0]?.path).toBe(canonicalRepositoryRoot);
    expect(config.repositoryRoots[0]?.id).toMatch(/^[a-f0-9-]{36}$/u);
    expect(config).toMatchObject({
      artifactRoot: canonicalArtifactRoot,
      gitExecutable: "/usr/bin/git",
      gitObjectReadTimeoutMs: 60_000,
      maxBytes: 1_048_576,
      maxObjects: 1_000,
    });

    await expect(
      readLocalSourceConfig({
        LOCAL_REPOSITORY_ROOTS: JSON.stringify([repositoryRoot]),
        LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
        ARTIFACT_ROOT: join(repositoryRoot, "kestrel-artifacts"),
        REVIEW_REVISION_MAX_BYTES: "1048576",
        REVIEW_REVISION_MAX_OBJECTS: "1000",
      }),
    ).rejects.toThrow("ARTIFACT_ROOT");
  });
});
