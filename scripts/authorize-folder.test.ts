import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const installationRoot = resolve(import.meta.dirname, "..");
let fixture = "";
let commandEnvironment: NodeJS.ProcessEnv;

beforeAll(async () => {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined) throw new Error("npm CLI is required");
  fixture = await mkdtemp(join(tmpdir(), "kestrel-authorize-cli-"));
  const prefix = join(fixture, "installation");
  await execFileAsync(
    process.execPath,
    [npmCli, "link", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"],
    {
      cwd: installationRoot,
      env: { ...process.env, npm_config_prefix: prefix },
    },
  );
  commandEnvironment = {
    ...process.env,
    PATH: `${join(prefix, "bin")}:${process.env.PATH ?? ""}`,
    LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
    // npm's inherited launch directory must not override the actual terminal directory.
    INIT_CWD: installationRoot,
  };
}, 15_000);

afterAll(async () => {
  if (fixture !== "") await rm(fixture, { force: true, recursive: true });
});

describe("kestrel authorize", () => {
  it("authorizes the current project from another directory using the installed command", async () => {
    const project = join(fixture, "Pippo");
    const stateRoot = join(fixture, "state");
    await mkdir(project);
    await execFileAsync("/usr/bin/git", ["init", "--quiet", project]);
    const result = await execFileAsync("kestrel", ["authorize"], {
      cwd: project,
      env: { ...commandEnvironment, KESTREL_STATE_ROOT: stateRoot },
    });

    const configurationPath = join(stateRoot, "repository-roots.json");
    expect(JSON.parse(await readFile(configurationPath, "utf8"))).toEqual({
      schemaVersion: 1,
      repositoryRoots: [await realpath(project)],
    });
    expect((await stat(configurationPath)).mode & 0o777).toBe(0o600);
    expect(result.stdout).toContain("Authorized repositories (1 added).");
    expect(`${result.stdout}${result.stderr}`).not.toContain(await realpath(project));
    await expect(access(join(project, ".kestrel"))).rejects.toThrow();
  });

  it("rejects path arguments and unknown actions without creating configuration", async () => {
    const stateRoot = join(fixture, "rejected-state");
    for (const args of [["authorize", installationRoot], ["authorize-repository-root"], []]) {
      await expect(
        execFileAsync("kestrel", args, {
          cwd: fixture,
          env: { ...commandEnvironment, KESTREL_STATE_ROOT: stateRoot },
        }),
      ).rejects.toMatchObject({ code: 1, stderr: "Usage: kestrel authorize\n" });
    }
    await expect(access(stateRoot)).rejects.toThrow();
  });

  it("rejects unsafe current directories without replacing the valid configuration", async () => {
    const project = join(fixture, "safe-project");
    const stateRoot = join(fixture, "safe-state");
    await mkdir(project);
    await execFileAsync("/usr/bin/git", ["init", "--quiet", project]);
    const run = (cwd: string) =>
      execFileAsync("kestrel", ["authorize"], {
        cwd,
        env: { ...commandEnvironment, KESTREL_STATE_ROOT: stateRoot },
      });
    await run(project);
    const config = join(stateRoot, "repository-roots.json");
    const previous = await readFile(config, "utf8");
    const nested = join(project, "nested");
    await mkdir(nested);
    for (const directory of [nested, join(stateRoot, "review-artifacts")]) {
      await expect(run(directory)).rejects.toThrow();
      expect(await readFile(config, "utf8")).toBe(previous);
    }
  });
});
