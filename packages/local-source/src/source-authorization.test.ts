import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readRepositoryRootConfiguration } from "./repository-root-configuration.js";
import { discoverRepositories, readLocalSourceConfig } from "./index.js";
import { previewSourceAuthorization, confirmSourceAuthorization } from "./source-authorization.js";

const run = promisify(execFile);
const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-ux-authorization-")));
  fixtures.push(root);
  const container = join(root, "projects");
  const state = join(root, "state");
  await mkdir(container);
  await mkdir(state, { mode: 0o700 });
  const env = {
    LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
    LOCAL_REPOSITORY_ROOTS_FILE: join(state, "repository-roots.json"),
    ARTIFACT_ROOT: state,
    REVIEW_REVISION_MAX_BYTES: "1048576",
    REVIEW_REVISION_MAX_OBJECTS: "1000",
  };
  const repository = async (name: string) => {
    const path = join(container, name);
    await mkdir(path, { recursive: true });
    await run("/usr/bin/git", ["init", "--quiet", path]);
    return path;
  };
  return { container, env, repository };
}

describe("explicit local source authorization", () => {
  it("previews only direct child repositories and authorizes exactly the confirmed set", async () => {
    const { container, env, repository } = await fixture();
    const alpha = await repository("alpha");
    await repository("group/nested");
    await symlink(alpha, join(container, "linked"));
    const preview = await previewSourceAuthorization(container, env);
    expect(preview.repositories.map((entry) => entry.displayName)).toEqual(["alpha"]);
    expect(await readRepositoryRootConfiguration(env.LOCAL_REPOSITORY_ROOTS_FILE)).toEqual([]);
    await confirmSourceAuthorization(preview, env);
    expect(await readRepositoryRootConfiguration(env.LOCAL_REPOSITORY_ROOTS_FILE)).toEqual([alpha]);
    const inventory = await discoverRepositories(await readLocalSourceConfig(env));
    expect(inventory.map((entry) => entry.displayName)).toEqual(["alpha"]);
  });

  it("selecting a repository authorizes itself and rejects stale confirmation", async () => {
    const { env, repository } = await fixture();
    const alpha = await repository("alpha");
    const beta = await repository("beta");
    const preview = await previewSourceAuthorization(alpha, env);
    const other = await previewSourceAuthorization(beta, env);
    expect(preview.repositories.map((entry) => entry.displayName)).toEqual(["alpha"]);
    await confirmSourceAuthorization(other, env);
    await expect(confirmSourceAuthorization(preview, env)).rejects.toThrow("changed");
    expect(await readRepositoryRootConfiguration(env.LOCAL_REPOSITORY_ROOTS_FILE)).toEqual([beta]);
  });

  it("does not authorize an empty directory or a replaced preview", async () => {
    const { container, env, repository } = await fixture();
    await expect(previewSourceAuthorization(container, env)).rejects.toThrow("No readable");
    const alpha = await repository("alpha");
    const preview = await previewSourceAuthorization(alpha, env);
    await rm(alpha, { recursive: true });
    await repository("alpha");
    await expect(confirmSourceAuthorization(preview, env)).rejects.toThrow("changed");
    expect(await readRepositoryRootConfiguration(env.LOCAL_REPOSITORY_ROOTS_FILE)).toEqual([]);
  });
});
