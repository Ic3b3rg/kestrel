import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { discoverRepositories, resolveRepository } from "./discovery.js";
import { readLocalSourceConfig } from "./config.js";
import { inspectRepository } from "./git.js";
import {
  assertFeatureWorkspaceSnapshot,
  checkpointFeatureWorkspace,
  snapshotFeatureWorkspace,
  openFeatureWorkspace,
  type FeatureWorkspaceIdentity,
} from "./feature-workspace.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const featureId = "018f0f89-9192-755f-aa96-f72094c734df";

async function git(repository: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync("/usr/bin/git", ["-C", repository, ...args])).stdout.trim();
}

async function fingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    const directory = queue[index];
    if (directory === undefined) throw new Error("Missing fixture directory");
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      hash.update(relative(root, path)).update("\0").update(String(metadata.mode)).update("\0");
      if (metadata.isDirectory()) queue.push(path);
      else if (metadata.isSymbolicLink()) hash.update(await readlink(path));
      else if (metadata.isFile()) hash.update(await readFile(path));
      else throw new Error("Unexpected fixture file type");
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

async function fixture(objectFormat: "sha1" | "sha256" = "sha1") {
  const root = await mkdtemp(join(tmpdir(), "kestrel-feature-workspace-"));
  temporaryDirectories.push(root);
  const repositories = join(root, "repositories");
  const repository = join(repositories, "operator");
  const artifacts = join(root, "artifacts");
  await mkdir(repository, { recursive: true });
  await mkdir(artifacts, { mode: 0o700 });
  await chmod(artifacts, 0o700);
  await git(repository, ["init", "--initial-branch=main", `--object-format=${objectFormat}`]);
  await git(repository, ["config", "user.name", "Fixture"]);
  await git(repository, ["config", "user.email", "fixture@example.invalid"]);
  await git(repository, ["commit", "--allow-empty", "-m", "Unretained ancestor"]);
  await writeFile(join(repository, ".gitignore"), "ignored.txt\nnode_modules/\n");
  await writeFile(join(repository, "source.txt"), "committed source\n");
  await writeFile(join(repository, "retained.txt"), "export attributes must not omit this file\n");
  await writeFile(join(repository, "binary.bin"), Buffer.from([0, 255, 128, 10]));
  await writeFile(join(repository, "executable.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await symlink("source.txt", join(repository, "source-link"));
  await writeFile(
    join(repository, ".gitattributes"),
    "retained.txt export-ignore\nsource.txt filter=canary eol=crlf\n",
  );
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "Committed base"]);
  const baseCommitId = await git(repository, ["rev-parse", "HEAD"]);
  const baseTreeId = await git(repository, ["rev-parse", "HEAD^{tree}"]);
  await writeFile(join(repository, "source.txt"), "operator dirty source\n");
  await writeFile(join(repository, "staged.txt"), "operator staged bytes\n");
  await git(repository, ["add", "staged.txt"]);
  await writeFile(join(repository, "untracked.txt"), "operator untracked bytes\n");
  await writeFile(join(repository, "ignored.txt"), "operator ignored bytes\n");
  const canary = join(root, "canary-executed");
  const script = join(root, "canary.sh");
  await writeFile(script, `#!/bin/sh\nprintf 'invoked' > '${canary}'\nexit 89\n`, { mode: 0o755 });
  await git(repository, ["config", "filter.canary.clean", script]);
  await git(repository, ["config", "filter.canary.smudge", script]);
  await git(repository, ["config", "credential.helper", `!${script}`]);
  await writeFile(join(repository, ".git", "info", "attributes"), "source.txt filter=canary\n");
  await symlink(script, join(repository, ".git", "hooks", "post-checkout"));
  const config = await readLocalSourceConfig({
    LOCAL_REPOSITORY_ROOTS: JSON.stringify([repositories]),
    LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
    ARTIFACT_ROOT: artifacts,
    REVIEW_REVISION_MAX_BYTES: "1048576",
    REVIEW_REVISION_MAX_OBJECTS: "1000",
  });
  const [candidate] = await discoverRepositories(config);
  if (candidate === undefined) throw new Error("Fixture repository unavailable");
  const resolved = await resolveRepository(config, candidate.repositoryId);
  const inspection = await inspectRepository(config, resolved);
  const identity: FeatureWorkspaceIdentity = {
    projectId,
    featureId,
    repositoryId: candidate.repositoryId,
    sourceIdentity: inspection.sourceIdentity,
    objectFormat,
    baseCommitId,
    branch: `refs/heads/kestrel/feature/${featureId}`,
  };
  return { root, repository, artifacts, config, identity, baseTreeId, canary };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("materializes exact committed bytes into independent Git storage and preserves the entire Operator checkout", async () => {
  const source = await fixture();
  const before = await fingerprint(source.repository);
  const workspace = await openFeatureWorkspace(source.config, source.identity, {
    documents: { planMarkdown: "# Approved plan", specMarkdown: "# Approved scope" },
  });
  expect(await fingerprint(source.repository)).toBe(before);
  expect(await readFile(join(workspace.workspacePath, "source.txt"), "utf8")).toBe(
    "committed source\n",
  );
  expect(await readFile(join(workspace.workspacePath, "retained.txt"), "utf8")).toBe(
    "export attributes must not omit this file\n",
  );
  expect(await readFile(join(workspace.workspacePath, "binary.bin"))).toEqual(
    Buffer.from([0, 255, 128, 10]),
  );
  expect((await lstat(join(workspace.workspacePath, "executable.sh"))).mode & 0o111).not.toBe(0);
  expect(await readlink(join(workspace.workspacePath, "source-link"))).toBe("source.txt");
  for (const path of ["staged.txt", "untracked.txt", "ignored.txt"])
    expect(await lstat(join(workspace.workspacePath, path)).catch(() => null)).toBeNull();
  expect(await lstat(source.canary).catch(() => null)).toBeNull();
  expect(relative(workspace.workspacePath, workspace.gitDirectory).startsWith("..")).toBe(true);
  expect(await readFile(join(workspace.gitDirectory, "shallow"), "utf8")).toBe(
    source.identity.baseCommitId + "\n",
  );
  expect(await readFile(join(workspace.workspacePath, ".kestrel", "plan.md"), "utf8")).toBe(
    "# Approved plan",
  );
  expect(await git(workspace.workspacePath, ["symbolic-ref", "HEAD"])).toBe(source.identity.branch);
  expect(await git(workspace.workspacePath, ["rev-parse", "HEAD^{tree}"])).toBe(source.baseTreeId);
  expect(
    await lstat(join(workspace.gitDirectory, "objects", "info", "alternates")).catch(() => null),
  ).toBeNull();
  await rename(source.repository, source.repository + "-removed");
  const reopened = await openFeatureWorkspace(source.config, source.identity);
  expect(reopened.workspacePath).toBe(workspace.workspacePath);
  expect(await git(reopened.workspacePath, ["show", "HEAD:source.txt"])).toBe("committed source");
  expect(await git(reopened.workspacePath, ["fsck", "--full", "--strict"])).toBe("");
});

it("captures raw added, modified, removed and executable source and rejects mutations during exact verification", async () => {
  const source = await fixture("sha256");
  const workspace = await openFeatureWorkspace(source.config, source.identity, {
    documents: { planMarkdown: "# Plan", specMarkdown: "# Spec" },
  });
  const original = await snapshotFeatureWorkspace(workspace, {
    expectedHead: source.identity.baseCommitId,
  });
  expect(original).toEqual({
    headCommitId: source.identity.baseCommitId,
    treeId: source.baseTreeId,
  });
  await writeFile(join(workspace.workspacePath, "source.txt"), "feature bytes\r\n");
  await writeFile(join(workspace.workspacePath, "new.bin"), Buffer.from([0, 128, 255, 13, 10]));
  await rm(join(workspace.workspacePath, "retained.txt"));
  await chmod(join(workspace.workspacePath, "executable.sh"), 0o644);
  await writeFile(join(workspace.workspacePath, "ignored.txt"), "build output");
  const candidate = await snapshotFeatureWorkspace(workspace, {
    expectedHead: original.headCommitId,
  });
  expect(candidate.headCommitId).toBe(original.headCommitId);
  expect(candidate.treeId).not.toBe(original.treeId);
  expect(
    (
      await execFileAsync("/usr/bin/git", [
        "-C",
        workspace.workspacePath,
        "show",
        `${candidate.treeId}:source.txt`,
      ])
    ).stdout,
  ).toBe("feature bytes\r\n");
  expect(
    await git(workspace.workspacePath, ["ls-tree", candidate.treeId, "executable.sh"]),
  ).toMatch(/^100644 blob /u);
  expect(
    await git(workspace.workspacePath, [
      "ls-tree",
      candidate.treeId,
      "retained.txt",
      "ignored.txt",
      ".kestrel",
    ]),
  ).toBe("");
  await execFileAsync(process.execPath, ["--eval", "process.exit(0)"], {
    cwd: workspace.workspacePath,
  });
  await expect(assertFeatureWorkspaceSnapshot(workspace, candidate)).resolves.toBeUndefined();
  await execFileAsync(
    process.execPath,
    ["--eval", "require('node:fs').appendFileSync('source.txt', 'changed by check')"],
    { cwd: workspace.workspacePath },
  );
  await expect(assertFeatureWorkspaceSnapshot(workspace, candidate)).rejects.toMatchObject({
    code: "workspace_changed",
  });
  expect(await git(workspace.workspacePath, ["rev-parse", "HEAD"])).toBe(original.headCommitId);
  expect(await lstat(source.canary).catch(() => null)).toBeNull();
});

it("checkpoints before verification and reconciles the same durable operation after reopen without duplicate commits", async () => {
  const source = await fixture();
  const before = await fingerprint(source.repository);
  const workspace = await openFeatureWorkspace(source.config, source.identity);
  await writeFile(join(workspace.workspacePath, "source.txt"), "first Work Item\n");
  const candidate = await snapshotFeatureWorkspace(workspace, {
    expectedHead: source.identity.baseCommitId,
  });
  const command = {
    expectedHead: candidate.headCommitId,
    expectedTree: candidate.treeId,
    checkpointId: randomUUID(),
    message: "Implement first Work Item",
  };
  const committed = await checkpointFeatureWorkspace(workspace, command);
  expect(committed.treeId).toBe(candidate.treeId);
  expect(committed.headCommitId).not.toBe(candidate.headCommitId);
  expect(await git(workspace.workspacePath, ["rev-parse", "HEAD^"])).toBe(candidate.headCommitId);
  await expect(assertFeatureWorkspaceSnapshot(workspace, committed)).resolves.toBeUndefined();
  const reopened = await openFeatureWorkspace(source.config, source.identity);
  expect(await checkpointFeatureWorkspace(reopened, command)).toEqual(committed);
  expect(await git(workspace.workspacePath, ["rev-list", "--count", "HEAD"])).toBe("2");
  await expect(
    checkpointFeatureWorkspace(reopened, { ...command, message: "Different intent" }),
  ).rejects.toMatchObject({ code: "workspace_checkpoint_conflict" });
  await expect(
    checkpointFeatureWorkspace(reopened, { ...command, checkpointId: randomUUID() }),
  ).rejects.toMatchObject({ code: "workspace_checkpoint_conflict" });
  await writeFile(join(workspace.workspacePath, "second.txt"), "second Work Item\n");
  const second = await snapshotFeatureWorkspace(reopened, { expectedHead: committed.headCommitId });
  const final = await checkpointFeatureWorkspace(reopened, {
    expectedHead: second.headCommitId,
    expectedTree: second.treeId,
    checkpointId: randomUUID(),
    message: "Implement second Work Item",
  });
  expect(await git(workspace.workspacePath, ["rev-parse", "HEAD^"])).toBe(committed.headCommitId);
  expect(await git(workspace.workspacePath, ["symbolic-ref", "HEAD"])).toBe(source.identity.branch);
  await expect(assertFeatureWorkspaceSnapshot(reopened, final)).resolves.toBeUndefined();
  await expect(checkpointFeatureWorkspace(reopened, command)).rejects.toMatchObject({
    code: "workspace_checkpoint_conflict",
  });
  expect(await fingerprint(source.repository)).toBe(before);
});

it("rejects a source symlink which escapes through an ignored symlink ancestor", async () => {
  const source = await fixture();
  const workspace = await openFeatureWorkspace(source.config, source.identity);
  await symlink(source.repository, join(workspace.workspacePath, "ignored.txt"));
  await symlink("ignored.txt/source.txt", join(workspace.workspacePath, "innocent-link"));
  await expect(
    snapshotFeatureWorkspace(workspace, { expectedHead: source.identity.baseCommitId }),
  ).rejects.toMatchObject({ code: "workspace_source_unsupported" });
});

it("recovers an aborted update-ref response after Git has committed the exact candidate", async () => {
  const source = await fixture();
  const workspace = await openFeatureWorkspace(source.config, source.identity);
  const marker = join(source.root, "checkpoint-was-committed");
  const executable = join(source.root, "git-interrupted.mjs");
  await writeFile(
    executable,
    `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nconst result = spawnSync('/usr/bin/git', args, { stdio: 'inherit' });\nif (result.status !== 0) process.exit(result.status ?? 1);\nif (args.includes('update-ref')) { writeFileSync(${JSON.stringify(marker)}, 'committed'); setInterval(() => {}, 1000); }\n`,
    { mode: 0o755 },
  );
  const interruptible = await openFeatureWorkspace(
    { ...source.config, gitExecutable: executable },
    source.identity,
  );
  await writeFile(join(workspace.workspacePath, "recovered.txt"), "durable source\n");
  const candidate = await snapshotFeatureWorkspace(workspace, {
    expectedHead: source.identity.baseCommitId,
  });
  const request = {
    expectedHead: candidate.headCommitId,
    expectedTree: candidate.treeId,
    checkpointId: randomUUID(),
    message: "Recover this Work Item",
  };
  const cancellation = new AbortController();
  const operation = expect(
    checkpointFeatureWorkspace(interruptible, { ...request, signal: cancellation.signal }),
  ).rejects.toMatchObject({ code: "workspace_cancelled" });
  try {
    await expect
      .poll(
        () =>
          lstat(marker).then(
            () => true,
            () => false,
          ),
        { timeout: 4000 },
      )
      .toBe(true);
  } finally {
    cancellation.abort();
  }
  await operation;
  const committedHead = await git(workspace.workspacePath, ["rev-parse", "HEAD"]);
  expect(committedHead).not.toBe(candidate.headCommitId);
  const reopened = await openFeatureWorkspace(source.config, source.identity);
  const recovered = await checkpointFeatureWorkspace(reopened, request);
  expect(recovered).toEqual({ headCommitId: committedHead, treeId: candidate.treeId });
  expect(await git(workspace.workspacePath, ["rev-list", "--count", "HEAD"])).toBe("2");
  await expect(assertFeatureWorkspaceSnapshot(reopened, recovered)).resolves.toBeUndefined();
});

it("pins the exact base when source HEAD moves and rejects a different identity or approved documents on reopen", async () => {
  const source = await fixture();
  const ancestor = await git(source.repository, ["rev-parse", `${source.identity.baseCommitId}^`]);
  const moved = await git(source.repository, [
    "commit-tree",
    source.baseTreeId,
    "-p",
    source.identity.baseCommitId,
    "-m",
    "Later source head",
  ]);
  await git(source.repository, [
    "update-ref",
    "refs/heads/main",
    moved,
    source.identity.baseCommitId,
  ]);
  const docs = { planMarkdown: "Frozen plan", specMarkdown: "Frozen scope" };
  const workspace = await openFeatureWorkspace(source.config, source.identity, { documents: docs });
  expect(await git(workspace.workspacePath, ["rev-parse", "HEAD"])).toBe(
    source.identity.baseCommitId,
  );
  await expect(git(workspace.workspacePath, ["cat-file", "-e", ancestor])).rejects.toThrow();
  expect(await git(workspace.workspacePath, ["fsck", "--full", "--strict"])).toBe("");
  await expect(
    openFeatureWorkspace(source.config, { ...source.identity, baseCommitId: moved }),
  ).rejects.toMatchObject({ code: "workspace_identity_mismatch" });
  await expect(
    openFeatureWorkspace(source.config, { ...source.identity, sourceIdentity: "0".repeat(64) }),
  ).rejects.toMatchObject({ code: "workspace_identity_mismatch" });
  await expect(
    openFeatureWorkspace(source.config, source.identity, {
      documents: { ...docs, planMarkdown: "Unapproved replacement" },
    }),
  ).rejects.toMatchObject({ code: "workspace_identity_mismatch" });
  await writeFile(
    join(workspace.workspacePath, ".kestrel", "plan.md"),
    "Runtime edits cannot change authority",
  );
  await expect(
    snapshotFeatureWorkspace(workspace, { expectedHead: source.identity.baseCommitId }),
  ).rejects.toMatchObject({ code: "workspace_changed" });
});

it.each(["managed documents", "gitlink", "escaping symlink"])(
  "blocks an unsupported committed %s without touching the source or publishing a partial workspace",
  async (kind) => {
    const source = await fixture();
    if (kind === "managed documents") {
      await mkdir(join(source.repository, ".kestrel"));
      await writeFile(join(source.repository, ".kestrel", "plan.md"), "Repository-controlled plan");
      await git(source.repository, ["add", ".kestrel/plan.md"]);
    } else if (kind === "gitlink") {
      await git(source.repository, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${source.identity.baseCommitId},embedded`,
      ]);
    } else {
      await symlink("../outside", join(source.repository, "escaping-link"));
      await git(source.repository, ["add", "escaping-link"]);
    }
    const tree = await git(source.repository, ["write-tree"]);
    const baseCommitId = await git(source.repository, [
      "commit-tree",
      tree,
      "-p",
      source.identity.baseCommitId,
      "-m",
      "Unsupported source",
    ]);
    const before = await fingerprint(source.repository);
    await expect(
      openFeatureWorkspace(source.config, { ...source.identity, baseCommitId }),
    ).rejects.toMatchObject({ code: "workspace_source_unsupported" });
    expect(await fingerprint(source.repository)).toBe(before);
    expect(
      await readdir(join(source.artifacts, "projects", projectId, "feature-workspaces")),
    ).toEqual([]);
  },
);

it("rejects metadata redirection and hardlinked source files before capturing external bytes", async () => {
  const source = await fixture();
  const workspace = await openFeatureWorkspace(source.config, source.identity);
  await link(join(source.repository, "source.txt"), join(workspace.workspacePath, "linked.txt"));
  await expect(
    snapshotFeatureWorkspace(workspace, { expectedHead: source.identity.baseCommitId }),
  ).rejects.toMatchObject({ code: "workspace_source_unsupported" });
  await rm(join(workspace.workspacePath, "linked.txt"));
  await chmod(join(workspace.workspacePath, ".git"), 0o600);
  await writeFile(
    join(workspace.workspacePath, ".git"),
    `gitdir: ${join(source.repository, ".git")}\n`,
  );
  await expect(
    snapshotFeatureWorkspace(workspace, { expectedHead: source.identity.baseCommitId }),
  ).rejects.toMatchObject({ code: "workspace_invalid" });
});

it("enforces object/byte bounds, aborts before creation and removes incomplete materialization", async () => {
  const source = await fixture();
  await expect(
    openFeatureWorkspace(source.config, source.identity, { signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ code: "workspace_cancelled" });
  await expect(
    openFeatureWorkspace({ ...source.config, maxBytes: 32 }, source.identity),
  ).rejects.toMatchObject({ code: "revision_limit_exceeded" });
  expect(
    await readdir(join(source.artifacts, "projects", projectId, "feature-workspaces")),
  ).toEqual([]);
  await expect(
    openFeatureWorkspace({ ...source.config, maxObjects: 1 }, source.identity),
  ).rejects.toMatchObject({ code: "revision_limit_exceeded" });
  expect(
    await readdir(join(source.artifacts, "projects", projectId, "feature-workspaces")),
  ).toEqual([]);
  await openFeatureWorkspace(source.config, source.identity);
  const limited = await openFeatureWorkspace({ ...source.config, maxBytes: 32 }, source.identity);
  await expect(
    snapshotFeatureWorkspace(limited, { expectedHead: source.identity.baseCommitId }),
  ).rejects.toMatchObject({ code: "workspace_limit_exceeded" });
  const deep = join(...Array.from({ length: 12 }, (_, index) => `level-${String(index)}`));
  const bounded = await openFeatureWorkspace({ ...source.config, maxObjects: 12 }, source.identity);
  await mkdir(join(bounded.workspacePath, deep), { recursive: true });
  await writeFile(join(bounded.workspacePath, deep, "source.txt"), "nested source");
  await expect(
    snapshotFeatureWorkspace(bounded, { expectedHead: source.identity.baseCommitId }),
  ).rejects.toMatchObject({ code: "workspace_limit_exceeded" });
});

it.each(["output", "deadline"])(
  "bounds Git %s and kills its whole subprocess group",
  async (kind) => {
    const source = await fixture();
    await openFeatureWorkspace(source.config, source.identity);
    const canary = join(source.root, "child-survived");
    const executable = join(source.root, "unbounded-git.mjs");
    const childScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(canary)}, 'survived'), 350)`;
    await writeFile(
      executable,
      `#!${process.execPath}\nimport { spawn } from 'node:child_process';\nspawn(${JSON.stringify(process.execPath)}, ['--eval', ${JSON.stringify(childScript)}]);\n${kind === "output" ? "process.stdout.write('x'.repeat(17 * 1024 * 1024));" : ""}\nsetInterval(() => {}, 1000);\n`,
      { mode: 0o755 },
    );
    const workspace = await openFeatureWorkspace(
      {
        ...source.config,
        gitExecutable: executable,
        gitObjectReadTimeoutMs: kind === "deadline" ? 100 : 2000,
      },
      source.identity,
    );
    await expect(
      snapshotFeatureWorkspace(workspace, { expectedHead: source.identity.baseCommitId }),
    ).rejects.toMatchObject({ code: "workspace_limit_exceeded" });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 450));
    expect(await lstat(canary).catch(() => null)).toBeNull();
  },
);

it("rebuilds the candidate from the committed tree if the derived index is absent", async () => {
  const source = await fixture();
  await git(source.repository, ["add", "--force", "ignored.txt"]);
  const tree = await git(source.repository, ["write-tree"]);
  const baseCommitId = await git(source.repository, [
    "commit-tree",
    tree,
    "-p",
    source.identity.baseCommitId,
    "-m",
    "A tracked file matched by ignore rules",
  ]);
  const workspace = await openFeatureWorkspace(source.config, { ...source.identity, baseCommitId });
  await rm(join(workspace.gitDirectory, "index"));
  expect(await snapshotFeatureWorkspace(workspace, { expectedHead: baseCommitId })).toEqual({
    headCommitId: baseCommitId,
    treeId: tree,
  });
  await writeFile(join(workspace.workspacePath, "ignored.txt"), "changed tracked source\n");
  await expect(
    assertFeatureWorkspaceSnapshot(workspace, { headCommitId: baseCommitId, treeId: tree }),
  ).rejects.toMatchObject({ code: "workspace_changed" });
});

it("retains a case-only rename as the actual candidate path", async () => {
  const source = await fixture();
  const workspace = await openFeatureWorkspace(source.config, source.identity);
  await rename(
    join(workspace.workspacePath, "retained.txt"),
    join(workspace.workspacePath, "Retained.txt"),
  );
  const candidate = await snapshotFeatureWorkspace(workspace, {
    expectedHead: source.identity.baseCommitId,
  });
  expect(
    await git(workspace.workspacePath, [
      "ls-tree",
      "--name-only",
      candidate.treeId,
      "retained.txt",
      "Retained.txt",
    ]),
  ).toBe("Retained.txt");
  await mkdir(join(workspace.workspacePath, "caffè"));
  await writeFile(join(workspace.workspacePath, "caffè", "你好.ts"), "Unicode source\n");
  const unicode = await snapshotFeatureWorkspace(workspace, {
    expectedHead: source.identity.baseCommitId,
  });
  expect(await git(workspace.workspacePath, ["show", `${unicode.treeId}:caffè/你好.ts`])).toBe(
    "Unicode source",
  );
});

it("blocks a committed empty subtree that a Git index cannot preserve", async () => {
  const source = await fixture();
  const empty = await git(source.repository, ["hash-object", "-w", "-t", "tree", "/dev/null"]);
  const listing = await git(source.repository, ["ls-tree", source.baseTreeId]);
  const tree = await new Promise<string>((resolveTree, rejectTree) => {
    const child = execFile("/usr/bin/git", ["-C", source.repository, "mktree"], (error, stdout) => {
      if (error !== null) rejectTree(new Error("Fixture tree creation failed", { cause: error }));
      else resolveTree(stdout.trim());
    });
    child.stdin?.end(`${listing}\n040000 tree ${empty}\tempty\n`);
  });
  const baseCommitId = await git(source.repository, [
    "commit-tree",
    tree,
    "-p",
    source.identity.baseCommitId,
    "-m",
    "Empty subtree",
  ]);
  await expect(
    openFeatureWorkspace(source.config, { ...source.identity, baseCommitId }),
  ).rejects.toMatchObject({ code: "workspace_source_unsupported" });
});
