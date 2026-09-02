import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const npmCli = process.env.npm_execpath;
const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("trusted-host repository root authorization", () => {
  it("validates and persists one canonical repository root without echoing its path", async () => {
    if (npmCli === undefined) {
      throw new Error("npm did not expose its CLI path to the test process");
    }
    const fixture = await mkdtemp(join(tmpdir(), "kestrel-authorize-repository-root-"));
    temporaryDirectories.push(fixture);
    const authorizedRoot = join(fixture, "repositories");
    const stateRoot = join(fixture, "state");
    const git = join(fixture, "git");
    await mkdir(authorizedRoot);
    await writeFile(git, "#!/bin/sh\nprintf 'git version 2.45.0\\n'\n", { mode: 0o700 });
    await chmod(git, 0o700);

    const result = await execFileAsync(
      process.execPath,
      [npmCli, "run", "authorize-repository-root", "--", authorizedRoot],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          KESTREL_STATE_ROOT: stateRoot,
          LOCAL_GIT_EXECUTABLE: git,
        },
      },
    );

    const configurationPath = join(stateRoot, "repository-roots.json");
    await expect(readFile(configurationPath, "utf8").then(JSON.parse)).resolves.toEqual({
      schemaVersion: 1,
      repositoryRoots: [await realpath(authorizedRoot)],
    });
    expect((await stat(configurationPath)).mode & 0o777).toBe(0o600);
    expect(result.stdout).toContain("Authorized repository root (1 configured).");
    expect(`${result.stdout}${result.stderr}`).not.toContain(await realpath(authorizedRoot));
  });

  it("rejects unsafe additions without changing the previous valid configuration", async () => {
    if (npmCli === undefined) {
      throw new Error("npm did not expose its CLI path to the test process");
    }
    const fixture = await mkdtemp(join(tmpdir(), "kestrel-reject-repository-root-"));
    temporaryDirectories.push(fixture);
    const authorizedRoot = join(fixture, "repositories");
    const nestedRoot = join(authorizedRoot, "nested");
    const symlinkRoot = join(fixture, "linked-repositories");
    const stateRoot = join(fixture, "state");
    const git = join(fixture, "git");
    await mkdir(nestedRoot, { recursive: true });
    await symlink(nestedRoot, symlinkRoot);
    await writeFile(git, "#!/bin/sh\nprintf 'git version 2.45.0\\n'\n", { mode: 0o700 });
    await chmod(git, 0o700);
    const environment = {
      ...process.env,
      KESTREL_STATE_ROOT: stateRoot,
      LOCAL_GIT_EXECUTABLE: git,
    };
    const runAuthorization = (candidate: string) =>
      execFileAsync(
        process.execPath,
        [npmCli, "run", "authorize-repository-root", "--", candidate],
        {
          cwd: repositoryRoot,
          env: environment,
        },
      );

    await runAuthorization(authorizedRoot);
    const configurationPath = join(stateRoot, "repository-roots.json");
    const validConfiguration = await readFile(configurationPath, "utf8");
    const invalidCandidates = [
      { path: nestedRoot, reason: "must not contain duplicate or nested roots" },
      { path: symlinkRoot, reason: "must identify an existing directory" },
      { path: join(fixture, "missing"), reason: "must identify an existing directory" },
      { path: join(stateRoot, "review-artifacts"), reason: "must not overlap a repository root" },
      { path: "relative-root", reason: "must be absolute" },
    ];

    for (const candidate of invalidCandidates) {
      let stdout = "";
      let stderr = "";
      try {
        await runAuthorization(candidate.path);
        throw new Error("Unsafe repository root was unexpectedly authorized");
      } catch (error) {
        if (typeof error === "object" && error !== null) {
          stdout = "stdout" in error ? String(error.stdout) : "";
          stderr = "stderr" in error ? String(error.stderr) : "";
        }
      }
      expect(`${stdout}${stderr}`).toContain(candidate.reason);
      expect(stderr).not.toContain(candidate.path);
      await expect(readFile(configurationPath, "utf8")).resolves.toBe(validConfiguration);
    }
  });
});
