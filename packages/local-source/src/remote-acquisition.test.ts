import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { readLocalSourceConfig, readRawGitObject, withGitHubPullRequestObjects } from "./index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(repository: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function createFixture(options: { hangOnFetch?: boolean } = {}) {
  const fixture = await mkdtemp(join(tmpdir(), "kestrel-remote-acquisition-"));
  temporaryDirectories.push(fixture);
  const artifacts = join(fixture, "artifacts");
  const localRoot = join(fixture, "local-root");
  const source = join(fixture, "source");
  const remote = join(fixture, "remote.git");
  const log = join(fixture, "git-log.jsonl");
  const fetchStarted = join(fixture, "fetch-started");
  const wrapper = join(fixture, "git-wrapper.cjs");
  await Promise.all([
    mkdir(artifacts, { mode: 0o700 }),
    mkdir(localRoot),
    mkdir(source),
    mkdir(remote),
  ]);
  await chmod(artifacts, 0o700);
  await git(source, ["init", "--initial-branch=main"]);
  await git(source, ["config", "user.name", "Kestrel Test"]);
  await git(source, ["config", "user.email", "kestrel@example.invalid"]);
  await writeFile(join(source, "review.txt"), "base\n", "utf8");
  await git(source, ["add", "review.txt"]);
  await git(source, ["commit", "-m", "Base"]);
  const baseObjectId = await git(source, ["rev-parse", "HEAD"]);
  await git(source, ["switch", "-c", "review-source"]);
  await writeFile(join(source, "review.txt"), "head\n", "utf8");
  await git(source, ["commit", "-am", "Head"]);
  const headObjectId = await git(source, ["rev-parse", "HEAD"]);
  await git(remote, ["init", "--bare"]);
  await git(source, ["push", remote, "main:refs/heads/main"]);
  await git(source, ["push", remote, "review-source:refs/pull/42/head"]);

  const canonicalRemote = "https://github.com/kestrel/review-source.git";
  await writeFile(
    wrapper,
    `#!${process.execPath}\n` +
      `const { appendFileSync, writeFileSync } = require("node:fs");\n` +
      `const { spawnSync } = require("node:child_process");\n` +
      `const args = process.argv.slice(2);\n` +
      `const config = {};\n` +
      `for (const [key, value] of Object.entries(process.env)) {\n` +
      `  if (key.startsWith("GIT_CONFIG_") || key === "GIT_TERMINAL_PROMPT" || key === "GIT_ASKPASS") config[key] = value;\n` +
      `}\n` +
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, config }) + "\\n");\n` +
      `if (args.includes("--global") && args.includes("--get-all")) {\n` +
      `  if (args.at(-1) === "credential.https://github.com.helper") { process.stdout.write("test-keychain\\0"); process.exit(0); }\n` +
      `  process.exit(1);\n` +
      `}\n` +
      (options.hangOnFetch === true
        ? `if (args.includes("fetch")) { writeFileSync(${JSON.stringify(fetchStarted)}, "started"); setInterval(() => {}, 1000); }\n`
        : "") +
      `const mapped = args.map((value) => value === ${JSON.stringify(canonicalRemote)} ? ${JSON.stringify(pathToFileURL(remote).href)} : value === "protocol.file.allow=never" ? "protocol.file.allow=always" : value);\n` +
      `const result = spawnSync("/usr/bin/git", mapped, { env: process.env, stdio: "inherit" });\n` +
      `process.exit(result.status ?? 1);\n`,
    { mode: 0o700 },
  );
  await chmod(wrapper, 0o700);

  const config = await readLocalSourceConfig({
    ARTIFACT_ROOT: artifacts,
    LOCAL_GIT_EXECUTABLE: wrapper,
    LOCAL_REPOSITORY_ROOTS: JSON.stringify([localRoot]),
    REVIEW_REVISION_MAX_BYTES: "1048576",
    REVIEW_REVISION_MAX_OBJECTS: "1000",
  });
  return {
    artifacts,
    baseObjectId,
    canonicalRemote,
    config,
    fetchStarted,
    headObjectId,
    log,
    remote,
  };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await lstat(path).catch(() => null)) !== null) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("GitHub pull-request object acquisition", () => {
  it("fetches fixed refs into a Project-scoped bare repository and removes it afterward", async () => {
    const fixture = await createFixture();
    const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
    let acquiredPath = "";

    const contents = await withGitHubPullRequestObjects(
      fixture.config,
      {
        base: { objectId: fixture.baseObjectId, ref: "main" },
        head: { objectId: fixture.headObjectId, ref: "review-source" },
        objectFormat: "sha1",
        projectId,
        pullRequestNumber: 42,
        repository: { name: "review-source", owner: "kestrel" },
      },
      async (acquired) => {
        acquiredPath = acquired.repository.path;
        expect(
          relative(join(fixture.config.artifactRoot, "projects", projectId), acquiredPath),
        ).not.toMatch(/^\.\./u);
        const [base, head] = await Promise.all([
          readRawGitObject(
            fixture.config,
            acquired.repository,
            acquired.inspection.objectFormat,
            fixture.baseObjectId,
            acquired.inspection.objectDirectories,
          ),
          readRawGitObject(
            fixture.config,
            acquired.repository,
            acquired.inspection.objectFormat,
            fixture.headObjectId,
            acquired.inspection.objectDirectories,
          ),
        ]);
        return [base.type, head.type];
      },
    );

    expect(contents).toEqual(["commit", "commit"]);
    await expect(lstat(acquiredPath)).rejects.toMatchObject({ code: "ENOENT" });

    const entries = (await readFile(fixture.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; config: Record<string, string> });
    const fetch = entries.find(({ args }) => args.includes("fetch"));
    expect(fetch?.args).toEqual(
      expect.arrayContaining([
        "--atomic",
        "--no-auto-maintenance",
        "--no-recurse-submodules",
        "--no-tags",
        "--no-write-fetch-head",
        "--refmap=",
        fixture.canonicalRemote,
        "+refs/heads/main:refs/kestrel/base",
        "+refs/pull/42/head:refs/kestrel/head",
      ]),
    );
    expect(fetch?.config).toMatchObject({
      GIT_ASKPASS: "/usr/bin/false",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(Object.values(fetch?.config ?? {})).toContain("test-keychain");
  });

  it("rejects a missing pull-request ref without leaving a usable repository", async () => {
    const fixture = await createFixture();
    const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
    await git(fixture.remote, ["update-ref", "-d", "refs/pull/42/head"]);

    await expect(
      withGitHubPullRequestObjects(
        fixture.config,
        {
          base: { objectId: fixture.baseObjectId, ref: "main" },
          head: { objectId: fixture.headObjectId, ref: "review-source" },
          objectFormat: "sha1",
          projectId,
          pullRequestNumber: 42,
          repository: { name: "review-source", owner: "kestrel" },
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "reference_not_available" });
    await expect(
      readdir(join(fixture.config.artifactRoot, "projects", projectId, "acquisition-repositories")),
    ).resolves.toEqual([]);
  });

  it("kills a cancelled fetch and removes its acquisition repository", async () => {
    const fixture = await createFixture({ hangOnFetch: true });
    const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
    const controller = new AbortController();
    const acquisition = withGitHubPullRequestObjects(
      fixture.config,
      {
        base: { objectId: fixture.baseObjectId, ref: "main" },
        head: { objectId: fixture.headObjectId, ref: "review-source" },
        objectFormat: "sha1",
        projectId,
        pullRequestNumber: 42,
        repository: { name: "review-source", owner: "kestrel" },
        signal: controller.signal,
      },
      async () => undefined,
    );
    await waitForFile(fixture.fetchStarted);
    controller.abort();

    await expect(acquisition).rejects.toMatchObject({ code: "acquisition_cancelled" });
    await expect(
      readdir(join(fixture.config.artifactRoot, "projects", projectId, "acquisition-repositories")),
    ).resolves.toEqual([]);
  });
});
