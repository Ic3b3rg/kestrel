import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverRepositories, readLocalSourceConfig, resolveRepository } from "./index.js";
import type { LocalSourceError } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("authorized repository discovery", () => {
  it("fails closed when a directory exceeds the entry budget", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "kestrel-local-source-entry-limit-"));
    temporaryDirectories.push(fixture);
    const root = join(fixture, "root");
    const artifacts = join(fixture, "artifacts");
    await mkdir(root);
    await mkdir(artifacts, { mode: 0o700 });
    await chmod(artifacts, 0o700);
    for (let start = 0; start < 10_001; start += 250) {
      await Promise.all(
        Array.from({ length: Math.min(250, 10_001 - start) }, (_, offset) =>
          writeFile(join(root, `entry-${String(start + offset).padStart(5, "0")}`), ""),
        ),
      );
    }
    const config = await readLocalSourceConfig({
      LOCAL_REPOSITORY_ROOTS: JSON.stringify([root]),
      LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
      ARTIFACT_ROOT: artifacts,
      REVIEW_REVISION_MAX_BYTES: "1048576",
      REVIEW_REVISION_MAX_OBJECTS: "1000",
    });

    await expect(discoverRepositories(config)).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "discovery_limit_exceeded" }),
    );
  }, 15_000);

  it("lists stable opaque repository IDs without following symlinks or descending into repositories", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "kestrel-local-source-discovery-"));
    temporaryDirectories.push(fixture);
    const root = join(fixture, "root");
    const artifacts = join(fixture, "artifacts");
    const repository = join(root, "team", "kestrel");
    const nestedRepository = join(repository, "nested");
    const outsideRepository = join(fixture, "outside");
    await mkdir(join(repository, ".git"), { recursive: true });
    await mkdir(join(nestedRepository, ".git"), { recursive: true });
    await mkdir(join(outsideRepository, ".git"), { recursive: true });
    await symlink(outsideRepository, join(root, "linked-outside"));
    await mkdir(artifacts, { mode: 0o700 });
    await chmod(artifacts, 0o700);
    await writeFile(join(root, "ordinary-file"), "not a repository", "utf8");

    const config = await readLocalSourceConfig({
      LOCAL_REPOSITORY_ROOTS: JSON.stringify([root]),
      LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
      ARTIFACT_ROOT: artifacts,
      REVIEW_REVISION_MAX_BYTES: "1048576",
      REVIEW_REVISION_MAX_OBJECTS: "1000",
    });
    const first = await discoverRepositories(config);
    const second = await discoverRepositories(config);

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]?.displayName).toBe("team/kestrel");
    expect(first[0]?.repositoryId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(JSON.stringify(first)).not.toContain(await realpath(root));
    expect(JSON.stringify(first)).not.toContain(await realpath(outsideRepository));

    const candidate = first[0];
    if (candidate === undefined) {
      throw new Error("Repository fixture was not discovered");
    }
    const resolved = await resolveRepository(config, candidate.repositoryId);
    expect(resolved.path).toBe(await realpath(repository));
    await expect(resolveRepository(config, "018f0f89-9a1d-7484-b224-866ef9d69990")).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "repository_not_available" }),
    );
  });
});
