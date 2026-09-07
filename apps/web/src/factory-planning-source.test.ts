import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { discoverRepositories, readLocalSourceConfig } from "@kestrel/local-source";

import { readPlanningDocuments } from "./factory-planning-source.js";

const exec = promisify(execFile);
let fixtureRoot: string | undefined;
afterEach(async () => {
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true });
});

it("grounds planning in committed Markdown and discloses missing context without reading dirty bytes", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "kestrel-planning-source-"));
  const repository = join(fixtureRoot, "repository");
  const artifactRoot = join(fixtureRoot, "artifacts");
  await mkdir(repository);
  await mkdir(artifactRoot, { mode: 0o700 });
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", repository, ...args])).stdout.trim();
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repository, "CONTEXT.md"), "Exports must preserve the current filter.\n");
  await git("add", "CONTEXT.md");
  await git("commit", "-m", "Document export behavior");
  const commitId = await git("rev-parse", "HEAD");
  await writeFile(join(repository, "CONTEXT.md"), "DIRTY PRIVATE TEXT");
  await writeFile(join(repository, "AGENTS.md"), "UNTRACKED PRIVATE TEXT");
  const executable = (await exec("/usr/bin/which", ["git"])).stdout.trim();
  const config = await readLocalSourceConfig({
    ARTIFACT_ROOT: artifactRoot,
    LOCAL_GIT_EXECUTABLE: executable,
    LOCAL_REPOSITORY_ROOTS: JSON.stringify([repository]),
    REVIEW_REVISION_MAX_BYTES: "1048576",
    REVIEW_REVISION_MAX_OBJECTS: "1000",
  });
  const inventory = await discoverRepositories(config);
  const repositoryId = inventory[0]?.repositoryId;
  if (repositoryId === undefined) throw new Error("Fixture repository missing");
  const result = await readPlanningDocuments(config, repositoryId);
  expect(result.commitId).toBe(commitId);
  expect(result.documents).toEqual([
    expect.objectContaining({
      path: "CONTEXT.md",
      content: "Exports must preserve the current filter.\n",
    }),
  ]);
  expect(result.notice).toContain("AGENTS.md");
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE TEXT|kestrel-planning-source-/u);
});
