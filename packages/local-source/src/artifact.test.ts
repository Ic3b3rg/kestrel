import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverRepositories,
  listRepositoryReferences,
  readLocalSourceConfig,
  readRetainedFile,
  reconcileArtifactRoot,
  resolveRepository,
  resolveSelectedRevision,
  retainRevision,
} from "./index.js";
import type { LocalSourceError } from "./index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function makeWritable(path: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null) {
    return;
  }
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) {
      await makeWritable(join(path, entry));
    }
    return;
  }
  await chmod(path, 0o600);
}

async function readAllFiles(path: string): Promise<Buffer[]> {
  const contents: Buffer[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) contents.push(...(await readAllFiles(entryPath)));
    else if (entry.isFile()) contents.push(await readFile(entryPath));
  }
  return contents;
}

async function git(repository: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function withEnvironment<T>(
  values: Readonly<Record<string, string>>,
  action: () => Promise<T>,
): Promise<T> {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]] as const));
  Object.assign(process.env, values);
  try {
    return await action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
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
    temporaryDirectories.splice(0).map(async (directory) => {
      await makeWritable(directory);
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("exact Review Revision retention", () => {
  it("cancels an in-flight object reader without publishing a Revision artifact", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "kestrel-local-source-cancel-"));
    temporaryDirectories.push(fixture);
    const root = join(fixture, "root");
    const repository = join(root, "kestrel");
    const artifacts = join(fixture, "artifacts");
    const gitWrapper = join(fixture, "git-wrapper.cjs");
    const objectReadArmed = join(fixture, "object-read-armed");
    const objectReadStarted = join(fixture, "object-read-started");
    await mkdir(repository, { recursive: true });
    await mkdir(artifacts, { mode: 0o700 });
    await chmod(artifacts, 0o700);
    await git(repository, ["init", "--initial-branch=main"]);
    await git(repository, ["config", "user.name", "Kestrel Test"]);
    await git(repository, ["config", "user.email", "kestrel@example.invalid"]);
    await writeFile(join(repository, "review.txt"), "base\n", "utf8");
    await git(repository, ["add", "review.txt"]);
    await git(repository, ["commit", "-m", "Base"]);
    await git(repository, ["switch", "-c", "review-source"]);
    await writeFile(join(repository, "review.txt"), "head\n", "utf8");
    await git(repository, ["commit", "-am", "Head"]);
    await writeFile(
      gitWrapper,
      `#!${process.execPath}\n` +
        `const { existsSync, writeFileSync } = require("node:fs");\n` +
        `const { spawnSync } = require("node:child_process");\n` +
        `const args = process.argv.slice(2);\n` +
        `if (existsSync(${JSON.stringify(objectReadArmed)}) && args.includes("cat-file") && args.includes("--batch")) {\n` +
        `  writeFileSync(${JSON.stringify(objectReadStarted)}, "started");\n` +
        `  setInterval(() => {}, 1000);\n` +
        `} else {\n` +
        `  const result = spawnSync("/usr/bin/git", args, { env: process.env, stdio: "inherit" });\n` +
        `  process.exit(result.status ?? 1);\n` +
        `}\n`,
      { mode: 0o700 },
    );
    await chmod(gitWrapper, 0o700);
    const config = await readLocalSourceConfig({
      ARTIFACT_ROOT: artifacts,
      LOCAL_GIT_EXECUTABLE: gitWrapper,
      LOCAL_REPOSITORY_ROOTS: JSON.stringify([root]),
      REVIEW_REVISION_MAX_BYTES: "1048576",
      REVIEW_REVISION_MAX_OBJECTS: "1000",
    });
    const [candidate] = await discoverRepositories(config);
    if (candidate === undefined) throw new Error("Cancellation fixture was not discovered");
    const resolved = await resolveRepository(config, candidate.repositoryId);
    const inventory = await listRepositoryReferences(config, resolved);
    const selected = await resolveSelectedRevision(config, resolved, inventory, {
      baseRef: "refs/heads/main",
      headRef: "refs/heads/review-source",
    });
    const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
    const revisionId = "018f0f89-9a21-7271-b92d-f1cb0d48bb48";
    const controller = new AbortController();
    await writeFile(objectReadArmed, "armed");
    const retention = retainRevision(config, {
      projectId,
      revisionId,
      selected,
      signal: controller.signal,
    });
    await waitForFile(objectReadStarted);
    controller.abort();

    await expect(retention).rejects.toMatchObject({ code: "acquisition_cancelled" });
    await expect(
      lstat(join(artifacts, "projects", projectId, "revisions", revisionId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains and reads SHA-256 repositories with exact 64-character object IDs", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "kestrel-local-source-sha256-"));
    temporaryDirectories.push(fixture);
    const root = join(fixture, "root");
    const repository = join(root, "kestrel");
    const artifacts = join(fixture, "artifacts");
    await mkdir(repository, { recursive: true });
    await mkdir(artifacts, { mode: 0o700 });
    await chmod(artifacts, 0o700);
    await git(repository, ["init", "--object-format=sha256", "--initial-branch=main"]);
    await git(repository, ["config", "user.name", "Kestrel Test"]);
    await git(repository, ["config", "user.email", "kestrel@example.invalid"]);
    await writeFile(join(repository, "review.txt"), "sha256 base\n", "utf8");
    await git(repository, ["add", "review.txt"]);
    await git(repository, ["commit", "-m", "SHA-256 base"]);
    await git(repository, ["switch", "-c", "review-source"]);
    await writeFile(join(repository, "review.txt"), "sha256 head\n", "utf8");
    await git(repository, ["commit", "-am", "SHA-256 head"]);

    const config = await readLocalSourceConfig({
      LOCAL_REPOSITORY_ROOTS: JSON.stringify([root]),
      LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
      ARTIFACT_ROOT: artifacts,
      REVIEW_REVISION_MAX_BYTES: "1048576",
      REVIEW_REVISION_MAX_OBJECTS: "1000",
    });
    const [candidate] = await discoverRepositories(config);
    if (candidate === undefined) {
      throw new Error("SHA-256 repository fixture was not discovered");
    }
    const resolved = await resolveRepository(config, candidate.repositoryId);
    const inventory = await listRepositoryReferences(config, resolved);
    const selected = await resolveSelectedRevision(config, resolved, inventory, {
      baseRef: "refs/heads/main",
      headRef: "refs/heads/review-source",
    });

    expect(selected).toMatchObject({ objectFormat: "sha256" });
    expect(selected.base.objectId).toMatch(/^[a-f0-9]{64}$/u);
    expect(selected.head.objectId).toMatch(/^[a-f0-9]{64}$/u);

    const retained = await retainRevision(config, {
      projectId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
      revisionId: "018f0f89-9a21-7271-b92d-f1cb0d48bb48",
      selected,
    });
    await expect(
      readRetainedFile(config, {
        artifactLocator: retained.artifactLocator,
        manifestDigest: retained.manifestDigest,
        side: "head",
        path: "review.txt",
      }),
    ).resolves.toEqual(Buffer.from("sha256 head\n"));
  });

  it("removes a crash-staging tree after retention made nested directories read-only", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "kestrel-local-source-staging-cleanup-"));
    temporaryDirectories.push(fixture);
    const root = join(fixture, "root");
    const artifacts = join(fixture, "artifacts");
    const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
    const staging = join(
      artifacts,
      "projects",
      projectId,
      "revisions",
      ".acquiring-018f0f89-9a21-7271-b92d-f1cb0d48bb47",
    );
    const prefix = join(staging, "objects", "aa");
    await mkdir(root);
    await mkdir(prefix, { mode: 0o700, recursive: true });
    await chmod(artifacts, 0o700);
    await writeFile(join(prefix, "object"), "retained", { mode: 0o400 });
    await chmod(prefix, 0o500);
    await chmod(join(staging, "objects"), 0o500);
    await chmod(staging, 0o500);
    const config = await readLocalSourceConfig({
      LOCAL_REPOSITORY_ROOTS: JSON.stringify([root]),
      LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
      ARTIFACT_ROOT: artifacts,
      REVIEW_REVISION_MAX_BYTES: "1048576",
      REVIEW_REVISION_MAX_OBJECTS: "1000",
    });

    await expect(reconcileArtifactRoot(config, [])).resolves.toEqual({
      quarantined: 0,
      removedStaging: 1,
    });
    await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("quarantines only well-formed unreferenced finals and leaves unrelated siblings untouched", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "kestrel-local-source-cleanup-scope-"));
    temporaryDirectories.push(fixture);
    const root = join(fixture, "root");
    const artifacts = join(fixture, "artifacts");
    const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
    const referencedRevisionId = "018f0f89-9a21-7271-b92d-f1cb0d48bb47";
    const unreferencedRevisionId = "018f0f89-9a21-7271-b92d-f1cb0d48bb48";
    const revisions = join(artifacts, "projects", projectId, "revisions");
    await mkdir(root);
    await mkdir(join(revisions, referencedRevisionId), { recursive: true });
    await mkdir(join(revisions, unreferencedRevisionId));
    await mkdir(join(revisions, "operator-notes"));
    await chmod(artifacts, 0o700);
    await writeFile(join(artifacts, "unrelated-sentinel"), "leave me\n", "utf8");
    const config = await readLocalSourceConfig({
      LOCAL_REPOSITORY_ROOTS: JSON.stringify([root]),
      LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
      ARTIFACT_ROOT: artifacts,
      REVIEW_REVISION_MAX_BYTES: "1048576",
      REVIEW_REVISION_MAX_OBJECTS: "1000",
    });
    const referencedLocator = `projects/${projectId}/revisions/${referencedRevisionId}`;

    await expect(reconcileArtifactRoot(config, [referencedLocator])).resolves.toEqual({
      quarantined: 1,
      removedStaging: 0,
    });
    await expect(lstat(join(revisions, referencedRevisionId))).resolves.toMatchObject({});
    await expect(lstat(join(revisions, "operator-notes"))).resolves.toMatchObject({});
    await expect(lstat(join(revisions, unreferencedRevisionId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(join(artifacts, "quarantine"))).toEqual([
      expect.stringMatching(new RegExp(`^${unreferencedRevisionId}-`, "u")),
    ]);
    await expect(readFile(join(artifacts, "unrelated-sentinel"), "utf8")).resolves.toBe(
      "leave me\n",
    );
  });

  it("rejects a symlinked artifact namespace", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "kestrel-local-source-artifact-link-"));
    temporaryDirectories.push(fixture);
    const root = join(fixture, "root");
    const artifacts = join(fixture, "artifacts");
    const outside = join(fixture, "outside");
    await mkdir(root);
    await mkdir(artifacts, { mode: 0o700 });
    await mkdir(outside);
    const config = await readLocalSourceConfig({
      LOCAL_REPOSITORY_ROOTS: JSON.stringify([root]),
      LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
      ARTIFACT_ROOT: artifacts,
      REVIEW_REVISION_MAX_BYTES: "1048576",
      REVIEW_REVISION_MAX_OBJECTS: "1000",
    });
    await symlink(outside, join(artifacts, "projects"));

    await expect(reconcileArtifactRoot(config, [])).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({
        code: "source_containment_violation",
      }),
    );
  });

  it("retains committed base/head bytes and remains readable after dirty source disappears", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "kestrel-local-source-artifact-"));
    temporaryDirectories.push(fixture);
    const root = join(fixture, "root");
    const repository = join(root, "kestrel");
    const detachedRepository = join(fixture, "detached-kestrel");
    const artifacts = join(fixture, "artifacts");
    const gitRecorder = join(fixture, "git-recorder");
    const gitRecording = join(fixture, "git-recording.txt");
    const gitEnvironment = join(fixture, "git-environment.txt");
    const commandCanary = join(fixture, "command-canary-invoked");
    const commandCanaryScript = join(fixture, "command-canary");
    const commandCanaryBin = join(fixture, "command-canary-bin");
    await mkdir(repository, { recursive: true });
    await mkdir(artifacts, { mode: 0o700 });
    await mkdir(commandCanaryBin);
    await chmod(artifacts, 0o700);
    await writeFile(
      commandCanaryScript,
      `#!/bin/sh\nprintf 'invoked\\n' >> ${commandCanary}\nexit 86\n`,
      { mode: 0o700 },
    );
    for (const name of ["curl", "gh", "make", "npm", "pnpm", "pytest", "ssh", "yarn"]) {
      await symlink(commandCanaryScript, join(commandCanaryBin, name));
    }
    await writeFile(
      gitRecorder,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${gitRecording}\n/usr/bin/env >> ${gitEnvironment}\nprintf '%s\\n' '-- invocation --' >> ${gitEnvironment}\nexec /usr/bin/git "$@"\n`,
      { mode: 0o700 },
    );
    await git(repository, ["init", "--initial-branch=main"]);
    await git(repository, ["config", "user.name", "Kestrel Test"]);
    await git(repository, ["config", "user.email", "kestrel@example.invalid"]);
    await writeFile(join(repository, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(join(repository, "review.txt"), "committed base\n", "utf8");
    await writeFile(join(repository, "executable.sh"), "#!/bin/sh\nprintf 'retained\\n'\n", "utf8");
    await chmod(join(repository, "executable.sh"), 0o755);
    await writeFile(join(repository, "café.txt"), "unicode retained\n", "utf8");
    await writeFile(join(repository, "binary.bin"), Buffer.from([0x00, 0xff, 0x10, 0x80]));
    const lfsPointer =
      "version https://git-lfs.github.com/spec/v1\n" +
      `oid sha256:${"a".repeat(64)}\n` +
      "size 1234\n";
    await writeFile(join(repository, "large.lfs"), lfsPointer, "utf8");
    await git(repository, ["add", "large.lfs"]);
    await writeFile(
      join(repository, "canary-command"),
      "#!/bin/sh\nprintf 'invoked\\n' > command-canary-invoked\nexit 86\n",
      { mode: 0o755 },
    );
    await writeFile(
      join(repository, "package.json"),
      '{"scripts":{"build":"./canary-command","test":"./canary-command"}}\n',
      "utf8",
    );
    await symlink("review.txt", join(repository, "review-link"));
    await git(repository, [
      "add",
      ".gitignore",
      "review.txt",
      "executable.sh",
      "café.txt",
      "binary.bin",
      "canary-command",
      "package.json",
      "review-link",
    ]);
    await git(repository, ["commit", "-m", "Base source"]);
    const baseTreeObjectId = await git(repository, ["rev-parse", "HEAD^{tree}"]);
    const gitlinkTargetObjectId = await git(repository, [
      "commit-tree",
      baseTreeObjectId,
      "-m",
      "Unretained gitlink target",
    ]);
    await git(repository, ["switch", "-c", "review-source"]);
    await writeFile(join(repository, "review.txt"), "committed head\n", "utf8");
    await git(repository, ["add", "review.txt"]);
    await git(repository, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${gitlinkTargetObjectId},vendor/dependency`,
    ]);
    await git(repository, ["commit", "-m", "Head source"]);

    await writeFile(join(repository, "review.txt"), "dirty worktree secret\n", "utf8");
    await writeFile(join(repository, "staged.txt"), "staged secret\n", "utf8");
    await git(repository, ["add", "staged.txt"]);
    await writeFile(join(repository, "untracked.txt"), "untracked secret\n", "utf8");
    await writeFile(join(repository, "ignored.txt"), "ignored secret\n", "utf8");

    await git(repository, ["config", "filter.kestrel.clean", commandCanaryScript]);
    await git(repository, ["config", "filter.kestrel.smudge", commandCanaryScript]);
    await git(repository, ["config", "credential.helper", `!${commandCanaryScript}`]);
    await writeFile(join(repository, ".git", "info", "attributes"), "review.txt filter=kestrel\n");
    await symlink(commandCanaryScript, join(repository, ".git", "hooks", "post-checkout"));

    const { batchCommandsBeforeRetention, config, retained, selected } = await withEnvironment(
      {
        GH_TOKEN: "provider-client-canary",
        GITHUB_TOKEN: "provider-client-canary",
        GIT_ASKPASS: commandCanaryScript,
        GIT_SSH: commandCanaryScript,
        GIT_SSH_COMMAND: commandCanaryScript,
        PATH: `${commandCanaryBin}:${process.env.PATH ?? ""}`,
        SSH_ASKPASS: commandCanaryScript,
        SSH_AUTH_SOCK: commandCanaryScript,
      },
      async () => {
        const config = await readLocalSourceConfig({
          ...process.env,
          LOCAL_REPOSITORY_ROOTS: JSON.stringify([root]),
          LOCAL_GIT_EXECUTABLE: gitRecorder,
          ARTIFACT_ROOT: artifacts,
          REVIEW_REVISION_MAX_BYTES: "1048576",
          REVIEW_REVISION_MAX_OBJECTS: "1000",
        });
        const [candidate] = await discoverRepositories(config);
        if (candidate === undefined) {
          throw new Error("Repository fixture was not discovered");
        }
        const resolved = await resolveRepository(config, candidate.repositoryId);
        const inventory = await listRepositoryReferences(config, resolved);
        const selected = await resolveSelectedRevision(config, resolved, inventory, {
          baseRef: "refs/heads/main",
          headRef: "refs/heads/review-source",
        });
        const batchCommandsBeforeRetention = (await readFile(gitRecording, "utf8"))
          .split("\n")
          .filter((line) => line.endsWith("cat-file --batch")).length;
        const retained = await retainRevision(config, {
          projectId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
          revisionId: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
          selected,
        });
        return { batchCommandsBeforeRetention, config, retained, selected };
      },
    );
    const recordedCommands = (await readFile(gitRecording, "utf8"))
      .split("\n")
      .filter((line) => line !== "" && line !== "--version");
    const prefix = `--no-lazy-fetch -c safe.directory=${selected.repository.path} -C ${selected.repository.path} `;
    const recordedSuffixes = recordedCommands.map((line) => {
      expect(line.startsWith(prefix)).toBe(true);
      return line.slice(prefix.length);
    });
    const allowedSuffixes = [
      "cat-file --batch",
      "config --local --no-includes --get-regexp ^remote\\..*\\.url$",
      "for-each-ref --count=501 --sort=refname --format=%(refname)%00%(objectname) refs/heads refs/remotes refs/tags",
      "rev-parse --absolute-git-dir",
      "rev-parse --is-bare-repository",
      "rev-parse --path-format=absolute --git-common-dir",
      "rev-parse --path-format=absolute --git-path objects",
      "rev-parse --show-object-format=storage",
      "rev-parse --show-toplevel",
      "rev-parse --verify --end-of-options HEAD",
    ];
    expect([...new Set(recordedSuffixes)].sort()).toEqual(allowedSuffixes.sort());
    expect(
      recordedCommands.filter((line) => line.endsWith("cat-file --batch")).length -
        batchCommandsBeforeRetention,
    ).toBe(1);
    const recordedEnvironment = await readFile(gitEnvironment, "utf8");
    for (const value of [
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_CONFIG_NOSYSTEM=1",
      "GIT_CONFIG_SYSTEM=/dev/null",
      "GIT_NO_LAZY_FETCH=1",
      "GIT_NO_REPLACE_OBJECTS=1",
      "GIT_OPTIONAL_LOCKS=0",
      "GIT_TERMINAL_PROMPT=0",
    ]) {
      expect(recordedEnvironment).toContain(value);
    }
    for (const name of [
      "ALL_PROXY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "GIT_ASKPASS",
      "HOME",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "SSH_AUTH_SOCK",
      "SSH_ASKPASS",
      "all_proxy",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ]) {
      expect(recordedEnvironment).not.toMatch(new RegExp(`^${name}=`, "mu"));
    }
    expect(recordedEnvironment).not.toContain(commandCanaryBin);
    await expect(lstat(commandCanary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(repository, "command-canary-invoked"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    expect(retained.artifactLocator).not.toContain(artifacts);
    expect(retained.objectCount).toBeGreaterThan(0);
    await expect(reconcileArtifactRoot(config, [retained.artifactLocator])).resolves.toEqual({
      quarantined: 0,
      removedStaging: 0,
    });
    await expect(reconcileArtifactRoot(config, [retained.artifactLocator])).resolves.toEqual({
      quarantined: 0,
      removedStaging: 0,
    });
    await rename(repository, detachedRepository);
    await expect(
      readRetainedFile(config, {
        artifactLocator: retained.artifactLocator,
        manifestDigest: retained.manifestDigest,
        side: "base",
        path: "review.txt",
      }),
    ).resolves.toEqual(Buffer.from("committed base\n"));
    await expect(
      readRetainedFile(config, {
        artifactLocator: retained.artifactLocator,
        manifestDigest: retained.manifestDigest,
        side: "head",
        path: "review.txt",
      }),
    ).resolves.toEqual(Buffer.from("committed head\n"));
    await expect(
      readRetainedFile(config, {
        artifactLocator: retained.artifactLocator,
        manifestDigest: retained.manifestDigest,
        side: "head",
        path: "executable.sh",
      }),
    ).resolves.toEqual(Buffer.from("#!/bin/sh\nprintf 'retained\\n'\n"));
    await expect(
      readRetainedFile(config, {
        artifactLocator: retained.artifactLocator,
        manifestDigest: retained.manifestDigest,
        side: "head",
        path: "review-link",
      }),
    ).resolves.toEqual(Buffer.from("review.txt"));
    await expect(
      readRetainedFile(config, {
        artifactLocator: retained.artifactLocator,
        manifestDigest: retained.manifestDigest,
        side: "head",
        path: "café.txt",
      }),
    ).resolves.toEqual(Buffer.from("unicode retained\n"));
    await expect(
      readRetainedFile(config, {
        artifactLocator: retained.artifactLocator,
        manifestDigest: retained.manifestDigest,
        side: "head",
        path: "binary.bin",
      }),
    ).resolves.toEqual(Buffer.from([0x00, 0xff, 0x10, 0x80]));
    await expect(
      readRetainedFile(config, {
        artifactLocator: retained.artifactLocator,
        manifestDigest: retained.manifestDigest,
        side: "head",
        path: "large.lfs",
      }),
    ).resolves.toEqual(Buffer.from(lfsPointer));
    for (const path of ["staged.txt", "untracked.txt", "ignored.txt"]) {
      await expect(
        readRetainedFile(config, {
          artifactLocator: retained.artifactLocator,
          manifestDigest: retained.manifestDigest,
          side: "head",
          path,
        }),
      ).rejects.toEqual(
        expect.objectContaining<Partial<LocalSourceError>>({ code: "path_not_retained" }),
      );
    }

    await expect(
      readRetainedFile(config, {
        artifactLocator: retained.artifactLocator,
        manifestDigest: retained.manifestDigest,
        side: "head",
        path: "../review.txt",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "path_not_retained" }),
    );
    await expect(
      readRetainedFile(config, {
        artifactLocator: `${retained.artifactLocator}/../${retained.artifactLocator}`,
        manifestDigest: retained.manifestDigest,
        side: "head",
        path: "review.txt",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({
        code: "source_containment_violation",
      }),
    );

    const revisionRoot = join(config.artifactRoot, retained.artifactLocator);
    const manifestPath = join(revisionRoot, "manifest.json");
    const manifestBytes = await readFile(manifestPath);
    await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, Buffer.concat([manifestBytes, Buffer.from(" ")]));
    await expect(
      readRetainedFile(config, {
        artifactLocator: retained.artifactLocator,
        manifestDigest: retained.manifestDigest,
        side: "head",
        path: "review.txt",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "object_verification_failed" }),
    );
    await writeFile(manifestPath, manifestBytes);
    await chmod(manifestPath, 0o400);

    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      head: { entries: { mode: string; objectId: string; path: string; type: string }[] };
      objects: { id: string }[];
    };
    expect(manifest.head.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mode: "100755", path: "executable.sh", type: "blob" }),
        expect.objectContaining({ mode: "120000", path: "review-link", type: "blob" }),
        expect.objectContaining({ mode: "160000", path: "vendor/dependency", type: "commit" }),
      ]),
    );
    const gitlink = manifest.head.entries.find(({ path }) => path === "vendor/dependency");
    expect(manifest.objects.some(({ id }) => id === gitlink?.objectId)).toBe(false);
    const retainedArtifactBytes = Buffer.concat(await readAllFiles(revisionRoot)).toString("utf8");
    for (const secret of [
      "dirty worktree secret",
      "staged secret",
      "untracked secret",
      "ignored secret",
    ]) {
      expect(retainedArtifactBytes).not.toContain(secret);
    }
    const headEntry = manifest.head.entries.find(({ path }) => path === "review.txt");
    if (headEntry === undefined) throw new Error("Retained head entry is unavailable");
    const retainedObjectDirectory = join(revisionRoot, "objects", headEntry.objectId.slice(0, 2));
    const retainedObjectPath = join(retainedObjectDirectory, headEntry.objectId.slice(2));
    const retainedObject = await readFile(retainedObjectPath);
    const corruptObject = Buffer.from(retainedObject);
    corruptObject[0] = (corruptObject[0] ?? 0) ^ 0xff;
    await chmod(retainedObjectPath, 0o600);
    await writeFile(retainedObjectPath, corruptObject);
    await chmod(retainedObjectPath, 0o400);
    await expect(
      readRetainedFile(config, {
        artifactLocator: retained.artifactLocator,
        manifestDigest: retained.manifestDigest,
        side: "head",
        path: "review.txt",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "object_verification_failed" }),
    );

    await chmod(retainedObjectPath, 0o600);
    await writeFile(retainedObjectPath, retainedObject);
    await chmod(retainedObjectDirectory, 0o700);
    await rm(retainedObjectPath);
    await expect(
      readRetainedFile(config, {
        artifactLocator: retained.artifactLocator,
        manifestDigest: retained.manifestDigest,
        side: "head",
        path: "review.txt",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "object_verification_failed" }),
    );
  });
});
