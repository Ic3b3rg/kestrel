import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createManagedSourceService, normalizeCloneUrl } from "./managed-source.js";
import { discoverRepositories, readLocalSourceConfig } from "./index.js";

const run = promisify(execFile);
const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("clones once into managed storage and reuses the authorized source after restart", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-ux-clone-")));
  fixtures.push(root);
  const upstream = join(root, "upstream");
  const state = join(root, "state");
  const artifacts = join(state, "artifacts");
  await mkdir(upstream);
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  await run("/usr/bin/git", ["init", "--quiet", upstream]);
  await writeFile(join(upstream, "README.md"), "Managed source fixture\n");
  await run("/usr/bin/git", ["-C", upstream, "add", "."]);
  await run("/usr/bin/git", [
    "-C",
    upstream,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const env = {
    KESTREL_STATE_ROOT: state,
    ARTIFACT_ROOT: artifacts,
    LOCAL_REPOSITORY_ROOTS_FILE: join(state, "repository-roots.json"),
    LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
    REVIEW_REVISION_MAX_BYTES: "1048576",
    REVIEW_REVISION_MAX_OBJECTS: "1000",
  };
  const clone = vi.fn(async ({ destination }: { destination: string }) => {
    await run("/usr/bin/git", ["clone", "--quiet", "--no-local", upstream, destination]);
  });
  const service = createManagedSourceService(env, clone);
  clone.mockImplementationOnce(async ({ destination }) => {
    await mkdir(destination);
    await writeFile(join(destination, "partial-file"), "interrupted clone");
    throw new Error("The transport was interrupted");
  });
  await expect(service.clone("https://github.com/example/reports.git")).rejects.toThrow(
    "interrupted",
  );
  expect(await discoverRepositories(await readLocalSourceConfig(env))).toEqual([]);
  const result = await createManagedSourceService(env, clone).clone(
    "https://github.com/example/reports.git",
  );
  expect(result.displayName).toBe("reports");
  expect(JSON.stringify(result)).not.toContain(root);
  expect(
    (await discoverRepositories(await readLocalSourceConfig(env))).map(
      (entry) => entry.repositoryId,
    ),
  ).toEqual([result.repositoryId]);
  expect(
    await createManagedSourceService(env, clone).clone("https://github.com/example/reports"),
  ).toEqual(result);
  expect(clone).toHaveBeenCalledTimes(2);
});

it("rejects credentials and unsupported clone transports before any host operation", () => {
  for (const url of [
    "file:///etc/passwd",
    "https://token@github.com/owner/repo",
    "https://github.com/owner/repo?token=secret",
    "ssh://git:secret@example.test/repo",
    "-uanything",
    "/tmp/repo",
  ]) {
    expect(() => normalizeCloneUrl(url)).toThrow("Git URL");
  }
  expect(normalizeCloneUrl("git@github.com:Owner/Repo.git").identity).toBe(
    normalizeCloneUrl("https://github.com/owner/repo").identity,
  );
});
