import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const LOCAL_SOURCE_COMMAND_CANARY_PATH = "/tmp/kestrel-local-source-command-canary";

export interface MissingPullRequestFixture {
  baseObjectId: string;
  headObjectId: string;
  localHeadObjectId: string;
  providerRelativePath: string;
  repositoryPath: string;
}

export interface GitFixture {
  baseObjectId: string;
  detachedRepositoryPath: string;
  headObjectId: string;
  repositoryPath: string;
  rootPath: string;
  close(): Promise<void>;
  createClone(
    sourceRepositoryPath: string,
    name: string,
    githubName: string,
  ): Promise<{
    baseObjectId: string;
    headObjectId: string;
    repositoryPath: string;
  }>;
  createSibling(
    name: string,
    githubName?: string | null,
  ): Promise<{
    baseObjectId: string;
    headObjectId: string;
    repositoryPath: string;
  }>;
  createFreshClone(name: string): Promise<{
    baseObjectId: string;
    headObjectId: string;
    repositoryPath: string;
  }>;
  createMissingPullRequestClone(
    name: string,
    pullRequestNumber: number,
  ): Promise<MissingPullRequestFixture>;
  detach(): Promise<void>;
  setCoreWorktree(repositoryPath: string, worktreePath: string): Promise<void>;
  setGitHubRemote(repositoryPath: string, githubName: string): Promise<void>;
  snapshotRepository(repositoryPath: string): Promise<string>;
  snapshotSource(): Promise<string>;
}

async function git(repository: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function fingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift();
    if (directory === undefined) break;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      const locator = relative(root, path);
      hash.update(locator).update("\0").update(String(metadata.mode)).update("\0");
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        hash.update("directory\0");
        queue.push(path);
      } else if (metadata.isSymbolicLink()) {
        hash
          .update("symlink\0")
          .update(await readlink(path))
          .update("\0");
      } else if (metadata.isFile()) {
        hash
          .update("file\0")
          .update(await readFile(path))
          .update("\0");
      } else {
        hash.update("other\0");
      }
    }
  }
  return hash.digest("hex");
}

async function initializeRepository(
  rootPath: string,
  name: string,
  githubName: string | null = name,
): Promise<{ baseObjectId: string; headObjectId: string; repositoryPath: string }> {
  const repositoryPath = join(rootPath, name);
  const qualifier = name === "kestrel" ? "" : ` ${name}`;
  await mkdir(repositoryPath, { recursive: true });
  await git(repositoryPath, ["init", "--initial-branch=main"]);
  await git(repositoryPath, ["config", "user.name", "Kestrel Test"]);
  await git(repositoryPath, ["config", "user.email", "kestrel@example.invalid"]);
  if (githubName !== null) {
    await git(repositoryPath, [
      "remote",
      "add",
      "origin",
      `https://github.com/Ic3b3rg/${githubName}.git`,
    ]);
  }
  await writeFile(join(repositoryPath, ".gitignore"), "ignored-secret.txt\n", "utf8");
  await writeFile(join(repositoryPath, "review.txt"), `committed base${qualifier}\n`, "utf8");
  await writeFile(
    join(repositoryPath, "package.json"),
    JSON.stringify({
      scripts: {
        build: `/fixtures/repositories/${name}/.git/kestrel-command-canary`,
        test: `/fixtures/repositories/${name}/.git/kestrel-command-canary`,
      },
    }),
    "utf8",
  );
  await git(repositoryPath, ["add", ".gitignore", "package.json", "review.txt"]);
  await git(repositoryPath, ["commit", "-m", "Base source"]);
  const baseObjectId = await git(repositoryPath, ["rev-parse", "HEAD"]);
  await git(repositoryPath, ["switch", "-c", "review-source"]);
  await writeFile(join(repositoryPath, "review.txt"), `committed head${qualifier}\n`, "utf8");
  await git(repositoryPath, ["commit", "-am", "Head source"]);
  const headObjectId = await git(repositoryPath, ["rev-parse", "HEAD"]);
  await git(repositoryPath, ["tag", "base-alias", baseObjectId]);
  await git(repositoryPath, ["tag", "head-alias", headObjectId]);
  await writeFile(join(repositoryPath, "review.txt"), "dirty worktree secret\n", "utf8");
  await writeFile(join(repositoryPath, "staged-secret.txt"), "staged secret\n", "utf8");
  await git(repositoryPath, ["add", "staged-secret.txt"]);
  await writeFile(join(repositoryPath, "untracked-secret.txt"), "untracked secret\n", "utf8");
  await writeFile(join(repositoryPath, "ignored-secret.txt"), "ignored secret\n", "utf8");
  const canaryScript = join(repositoryPath, ".git", "kestrel-command-canary");
  const canaryContents = `#!/bin/sh\nprintf 'invoked\\n' >> ${LOCAL_SOURCE_COMMAND_CANARY_PATH}\nexit 86\n`;
  await writeFile(canaryScript, canaryContents, { mode: 0o755 });
  await git(repositoryPath, [
    "config",
    "filter.kestrel.clean",
    `/fixtures/repositories/${name}/.git/kestrel-command-canary`,
  ]);
  await git(repositoryPath, [
    "config",
    "filter.kestrel.smudge",
    `/fixtures/repositories/${name}/.git/kestrel-command-canary`,
  ]);
  await git(repositoryPath, [
    "config",
    "credential.helper",
    `!/fixtures/repositories/${name}/.git/kestrel-command-canary`,
  ]);
  await writeFile(
    join(repositoryPath, ".git", "info", "attributes"),
    "review.txt filter=kestrel\n",
  );
  await writeFile(join(repositoryPath, ".git", "hooks", "post-checkout"), canaryContents, {
    mode: 0o755,
  });
  return { baseObjectId, headObjectId, repositoryPath };
}

async function cloneRepository(
  rootPath: string,
  sourceRepositoryPath: string,
  name: string,
  githubName: string,
): Promise<{ baseObjectId: string; headObjectId: string; repositoryPath: string }> {
  const repositoryPath = join(rootPath, name);
  await execFileAsync("/usr/bin/git", [
    "clone",
    "--no-local",
    sourceRepositoryPath,
    repositoryPath,
  ]);
  await git(repositoryPath, [
    "remote",
    "set-url",
    "origin",
    `https://github.com/Ic3b3rg/${githubName}.git`,
  ]);
  const mainExists = await git(repositoryPath, [
    "show-ref",
    "--verify",
    "--hash",
    "refs/heads/main",
  ]).catch(() => "");
  if (mainExists === "") {
    await git(repositoryPath, ["branch", "main", "refs/remotes/origin/main"]);
  }
  return {
    baseObjectId: await git(repositoryPath, ["rev-parse", "refs/heads/main"]),
    headObjectId: await git(repositoryPath, ["rev-parse", "refs/heads/review-source"]),
    repositoryPath,
  };
}

async function createMissingPullRequestClone(
  rootPath: string,
  name: string,
  pullRequestNumber: number,
): Promise<MissingPullRequestFixture> {
  const provider = await initializeRepository(rootPath, `${name}-provider`, name);
  await git(provider.repositoryPath, [
    "update-ref",
    `refs/pull/${String(pullRequestNumber)}/head`,
    provider.headObjectId,
  ]);

  const repositoryPath = join(rootPath, name);
  await execFileAsync("/usr/bin/git", [
    "clone",
    "--no-local",
    "--single-branch",
    "--branch",
    "main",
    provider.repositoryPath,
    repositoryPath,
  ]);
  await git(repositoryPath, [
    "remote",
    "set-url",
    "origin",
    `https://github.com/Ic3b3rg/${name}.git`,
  ]);
  await git(repositoryPath, ["config", "user.name", "Kestrel Test"]);
  await git(repositoryPath, ["config", "user.email", "kestrel@example.invalid"]);
  await git(repositoryPath, ["switch", "-c", "attachment-source"]);
  await writeFile(join(repositoryPath, "attachment.txt"), "local attachment only\n", "utf8");
  await git(repositoryPath, ["add", "attachment.txt"]);
  await git(repositoryPath, ["commit", "-m", "Local attachment source"]);
  const localHeadObjectId = await git(repositoryPath, ["rev-parse", "HEAD"]);

  const remoteHeadIsPresent = await git(repositoryPath, [
    "cat-file",
    "-e",
    `${provider.headObjectId}^{commit}`,
  ]).then(
    () => true,
    () => false,
  );
  if (remoteHeadIsPresent) {
    throw new Error("The missing pull-request fixture unexpectedly contains the provider head");
  }

  const canaryScript = join(repositoryPath, ".git", "kestrel-command-canary");
  await writeFile(
    canaryScript,
    `#!/bin/sh\nprintf 'invoked\\n' >> ${LOCAL_SOURCE_COMMAND_CANARY_PATH}\nexit 86\n`,
    { mode: 0o755 },
  );
  await git(repositoryPath, [
    "config",
    "--replace-all",
    "remote.origin.fetch",
    "+refs/heads/*:refs/heads/kestrel-operator-overwrite/*",
  ]);
  await git(repositoryPath, [
    "config",
    "url.file:///tmp/kestrel-url-rewrite-canary.insteadOf",
    "https://github.com/",
  ]);
  await git(repositoryPath, [
    "config",
    "credential.helper",
    `!/fixtures/repositories/${name}/.git/kestrel-command-canary`,
  ]);
  await git(repositoryPath, [
    "config",
    "core.hooksPath",
    `/fixtures/repositories/${name}/.git/hooks`,
  ]);

  return {
    baseObjectId: provider.baseObjectId,
    headObjectId: provider.headObjectId,
    localHeadObjectId,
    providerRelativePath: relative(rootPath, provider.repositoryPath),
    repositoryPath,
  };
}

export async function createGitFixture(): Promise<GitFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "kestrel-black-box-local-source-"));
  const rootPath = join(fixtureRoot, "repositories");
  const detachedRepositoryPath = join(fixtureRoot, "kestrel-detached");
  const { baseObjectId, headObjectId, repositoryPath } = await initializeRepository(
    rootPath,
    "kestrel",
  );

  return {
    baseObjectId,
    detachedRepositoryPath,
    headObjectId,
    repositoryPath,
    rootPath,
    close: () => rm(fixtureRoot, { force: true, recursive: true }),
    createClone: (sourceRepositoryPath, name, githubName) =>
      cloneRepository(rootPath, sourceRepositoryPath, name, githubName),
    createFreshClone: (name) => cloneRepository(rootPath, detachedRepositoryPath, name, "kestrel"),
    createMissingPullRequestClone: (name, pullRequestNumber) =>
      createMissingPullRequestClone(rootPath, name, pullRequestNumber),
    createSibling: (name, githubName) => initializeRepository(rootPath, name, githubName),
    detach: () => rename(repositoryPath, detachedRepositoryPath),
    setCoreWorktree: async (targetRepositoryPath, worktreePath) => {
      await git(targetRepositoryPath, ["config", "core.worktree", worktreePath]);
    },
    setGitHubRemote: async (targetRepositoryPath, githubName) => {
      await git(targetRepositoryPath, [
        "remote",
        "add",
        "origin",
        `https://github.com/Ic3b3rg/${githubName}.git`,
      ]);
    },
    snapshotRepository: fingerprint,
    snapshotSource: () => fingerprint(repositoryPath),
  };
}
