import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectRepository,
  listCommitTreeEntries,
  listRepositoryReferences,
  readLocalSourceConfig,
  readRawGitObject,
  resolveRepository,
  resolveSelectedRevision,
} from "./index.js";
import type { LocalSourceError } from "./index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(repository: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("fixed read-only Git inspection", () => {
  async function makeRepositoryFixture(prefix: string): Promise<{
    artifacts: string;
    fixture: string;
    repository: string;
    root: string;
  }> {
    const fixture = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(fixture);
    const root = join(fixture, "root");
    const repository = join(root, "kestrel");
    const artifacts = join(fixture, "artifacts");
    await mkdir(repository, { recursive: true });
    await mkdir(artifacts, { mode: 0o700 });
    await chmod(artifacts, 0o700);
    await git(repository, ["init", "--initial-branch=main"]);
    return { artifacts, fixture, repository, root };
  }

  async function resolveFixture(
    artifacts: string,
    repositoryRoot: string,
  ): Promise<{
    config: Awaited<ReturnType<typeof readLocalSourceConfig>>;
    resolved: Awaited<ReturnType<typeof resolveRepository>>;
  }> {
    const config = await readLocalSourceConfig({
      LOCAL_REPOSITORY_ROOTS: JSON.stringify([repositoryRoot]),
      LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
      ARTIFACT_ROOT: artifacts,
      REVIEW_REVISION_MAX_BYTES: "1048576",
      REVIEW_REVISION_MAX_OBJECTS: "1000",
    });
    const [candidate] = await import("./index.js").then(({ discoverRepositories }) =>
      discoverRepositories(config),
    );
    if (candidate === undefined) throw new Error("Repository fixture was not discovered");
    return { config, resolved: await resolveRepository(config, candidate.repositoryId) };
  }

  it("rejects a configured work tree outside the authorized root", async () => {
    const { artifacts, fixture, repository, root } = await makeRepositoryFixture(
      "kestrel-local-source-worktree-",
    );
    const outside = join(fixture, "outside-worktree");
    await mkdir(outside);
    await git(repository, ["config", "core.worktree", outside]);
    const { config, resolved } = await resolveFixture(artifacts, root);

    await expect(inspectRepository(config, resolved)).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({
        code: "source_containment_violation",
      }),
    );
  });

  it("classifies an invalid repository candidate separately from a systemic Git failure", async () => {
    const { artifacts, repository, root } = await makeRepositoryFixture(
      "kestrel-local-source-invalid-repository-",
    );
    await rm(join(repository, ".git", "HEAD"));
    const { config, resolved } = await resolveFixture(artifacts, root);

    await expect(inspectRepository(config, resolved)).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "repository_invalid" }),
    );
  });

  it("rejects repository config includes before regular inspection", async () => {
    const { artifacts, fixture, repository, root } = await makeRepositoryFixture(
      "kestrel-local-source-config-include-",
    );
    const outsideConfig = join(fixture, "outside.gitconfig");
    await writeFile(outsideConfig, "[core]\n\tbare = false\n", "utf8");
    await git(repository, ["config", "--add", "include.path", outsideConfig]);
    const { config, resolved } = await resolveFixture(artifacts, root);

    await expect(inspectRepository(config, resolved)).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({
        code: "source_containment_violation",
      }),
    );
  });

  it("rejects recursive alternates that eventually leave the authorized root", async () => {
    const { artifacts, fixture, repository, root } = await makeRepositoryFixture(
      "kestrel-local-source-nested-alternate-",
    );
    const internalAlternate = join(root, "alternate-objects");
    const externalAlternate = join(fixture, "external-objects");
    await mkdir(join(repository, ".git", "objects", "info"), { recursive: true });
    await mkdir(join(internalAlternate, "info"), { recursive: true });
    await mkdir(externalAlternate);
    await writeFile(
      join(repository, ".git", "objects", "info", "alternates"),
      `${internalAlternate}\n`,
      "utf8",
    );
    await writeFile(
      join(internalAlternate, "info", "alternates"),
      `${externalAlternate}\n`,
      "utf8",
    );
    const { config, resolved } = await resolveFixture(artifacts, root);

    await expect(inspectRepository(config, resolved)).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({
        code: "source_containment_violation",
      }),
    );
  });

  it("rejects symlinked object metadata directories", async () => {
    const { artifacts, fixture, repository, root } = await makeRepositoryFixture(
      "kestrel-local-source-object-symlink-",
    );
    const objectInfo = join(repository, ".git", "objects", "info");
    const outsideInfo = join(fixture, "outside-info");
    await rm(objectInfo, { recursive: true });
    await mkdir(outsideInfo);
    await writeFile(join(outsideInfo, "alternates"), "", "utf8");
    await symlink(outsideInfo, objectInfo);
    const { config, resolved } = await resolveFixture(artifacts, root);

    await expect(inspectRepository(config, resolved)).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({
        code: "source_containment_violation",
      }),
    );
  });

  it("prefers origin and otherwise rejects ambiguous GitHub remote identities", async () => {
    const { artifacts, repository, root } = await makeRepositoryFixture(
      "kestrel-local-source-remotes-",
    );
    await git(repository, ["remote", "add", "upstream", "https://github.com/Ic3b3rg/kestrel.git"]);
    await git(repository, ["remote", "add", "backup", "https://github.com/openai/kestrel.git"]);
    const { config, resolved } = await resolveFixture(artifacts, root);

    await expect(inspectRepository(config, resolved)).resolves.toMatchObject({
      githubRepository: null,
    });
    await git(repository, ["remote", "add", "origin", "git@github.com:Ic3b3rg/kestrel.git"]);
    await expect(inspectRepository(config, resolved)).resolves.toMatchObject({
      githubRepository: { name: "kestrel", owner: "Ic3b3rg" },
    });
  });

  it("lists HEAD when it points to a committed custom reference", async () => {
    const { artifacts, repository, root } = await makeRepositoryFixture(
      "kestrel-local-source-custom-head-",
    );
    await git(repository, ["config", "user.name", "Kestrel Test"]);
    await git(repository, ["config", "user.email", "kestrel@example.invalid"]);
    await writeFile(join(repository, "review.txt"), "base\n", "utf8");
    await git(repository, ["add", "review.txt"]);
    await git(repository, ["commit", "-m", "Base source"]);
    const objectId = await git(repository, ["rev-parse", "HEAD"]);
    await git(repository, ["update-ref", "refs/custom/review", objectId]);
    await git(repository, ["symbolic-ref", "HEAD", "refs/custom/review"]);
    const { config, resolved } = await resolveFixture(artifacts, root);

    const inventory = await listRepositoryReferences(config, resolved);
    expect(inventory.references).toContainEqual(
      expect.objectContaining({ commitObjectId: objectId, kind: "head", ref: "HEAD" }),
    );
  });

  it("stops long tree manifests before accumulating every entry, including gitlinks", async () => {
    const { artifacts, root } = await makeRepositoryFixture("kestrel-local-source-tree-budget-");
    const { config, resolved } = await resolveFixture(artifacts, root);
    const commitObjectId = "1".repeat(40);
    const treeObjectId = "2".repeat(40);
    const entries = Array.from({ length: 50 }, (_, index) => ({
      name: `nested-${String(index).padStart(2, "0")}-${"x".repeat(200)}`,
      objectId: (index + 3).toString(16).padStart(40, "0"),
    }));
    const treeContent = Buffer.concat(
      entries.flatMap(({ name, objectId }) => [
        Buffer.from(`160000 ${name}\0`, "utf8"),
        Buffer.from(objectId, "hex"),
      ]),
    );
    const commitContent = Buffer.from(`tree ${treeObjectId}\n\nSynthetic commit\n`, "ascii");
    const budget = {
      entryCount: 0,
      manifestBytes: 0,
      maxManifestBytes: 5_000,
      objectIds: new Set<string>(),
    };
    const readObject = (objectId: string) => {
      if (objectId === commitObjectId) {
        return Promise.resolve({
          content: commitContent,
          id: commitObjectId,
          size: commitContent.byteLength,
          type: "commit" as const,
        });
      }
      if (objectId === treeObjectId) {
        return Promise.resolve({
          content: treeContent,
          id: treeObjectId,
          size: treeContent.byteLength,
          type: "tree" as const,
        });
      }
      return Promise.reject(new Error(`Unexpected object read: ${objectId}`));
    };

    await expect(
      listCommitTreeEntries(config, resolved, "sha1", commitObjectId, [], readObject, budget),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "revision_limit_exceeded" }),
    );
    expect(budget.entryCount).toBeGreaterThan(0);
    expect(budget.entryCount).toBeLessThan(entries.length);
    expect(budget.objectIds.size).toBe(2);
  });

  it("lists committed refs and re-resolves the selected pair to exact commit IDs", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "kestrel-local-source-git-"));
    temporaryDirectories.push(fixture);
    const root = join(fixture, "root");
    const repository = join(root, "kestrel");
    const artifacts = join(fixture, "artifacts");
    await mkdir(repository, { recursive: true });
    await mkdir(artifacts, { mode: 0o700 });
    await chmod(artifacts, 0o700);
    await git(repository, ["init", "--initial-branch=main"]);
    await git(repository, ["config", "user.name", "Kestrel Test"]);
    await git(repository, ["config", "user.email", "kestrel@example.invalid"]);
    await writeFile(join(repository, "review.txt"), "base\n", "utf8");
    await git(repository, ["add", "review.txt"]);
    await git(repository, ["commit", "-m", "Base source"]);
    const baseObjectId = await git(repository, ["rev-parse", "HEAD"]);
    await git(repository, ["switch", "-c", "review-source"]);
    await writeFile(join(repository, "review.txt"), "head\n", "utf8");
    await git(repository, ["commit", "-am", "Review authorization boundary"]);
    const headObjectId = await git(repository, ["rev-parse", "HEAD"]);
    await git(repository, [
      "tag",
      "--annotate",
      "--message",
      "Reviewed base",
      "reviewed-base",
      baseObjectId,
    ]);
    const baseTreeObjectId = await git(repository, ["rev-parse", `${baseObjectId}^{tree}`]);
    const invalidCommitPath = join(fixture, "non-utf8-commit");
    await writeFile(
      invalidCommitPath,
      Buffer.concat([
        Buffer.from(
          `tree ${baseTreeObjectId}\nparent ${baseObjectId}\nauthor Kestrel Test <kestrel@example.invalid> 1787592000 +0000\ncommitter Kestrel Test <kestrel@example.invalid> 1787592000 +0000\n\n`,
          "ascii",
        ),
        Buffer.from([0x52, 0x65, 0x76, 0x69, 0x65, 0x77, 0x20, 0xff, 0x0a]),
      ]),
    );
    const nonUtf8CommitId = await git(repository, [
      "hash-object",
      "-t",
      "commit",
      "-w",
      invalidCommitPath,
    ]);
    await git(repository, ["update-ref", "refs/tags/non-utf8", nonUtf8CommitId]);
    const largeCommitPath = join(fixture, "large-message-commit");
    await writeFile(
      largeCommitPath,
      Buffer.concat([
        Buffer.from(
          `tree ${baseTreeObjectId}\nparent ${baseObjectId}\nauthor Kestrel Test <kestrel@example.invalid> 1787592001 +0000\ncommitter Kestrel Test <kestrel@example.invalid> 1787592001 +0000\n\n`,
          "ascii",
        ),
        Buffer.from(`${"x".repeat(500_000)}\n`, "ascii"),
      ]),
    );
    const largeCommitId = await git(repository, [
      "hash-object",
      "-t",
      "commit",
      "-w",
      largeCommitPath,
    ]);
    await git(repository, ["update-ref", "refs/tags/large-message", largeCommitId]);
    await git(repository, ["remote", "add", "origin", "https://github.com/Ic3b3rg/kestrel.git"]);

    const config = await readLocalSourceConfig({
      LOCAL_REPOSITORY_ROOTS: JSON.stringify([root]),
      LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
      ARTIFACT_ROOT: artifacts,
      REVIEW_REVISION_MAX_BYTES: "1048576",
      REVIEW_REVISION_MAX_OBJECTS: "1000",
    });
    const discovered = await import("./index.js").then(({ discoverRepositories }) =>
      discoverRepositories(config),
    );
    const candidate = discovered[0];
    if (candidate === undefined) {
      throw new Error("Repository fixture was not discovered");
    }
    const resolved = await resolveRepository(config, candidate.repositoryId);

    const inspection = await inspectRepository(config, resolved);
    expect(inspection.objectFormat).toBe("sha1");
    expect(inspection.githubRepository).toEqual({ owner: "Ic3b3rg", name: "kestrel" });
    expect(inspection.sourceIdentity).toMatch(/^[a-f0-9]{64}$/u);
    const inventory = await listRepositoryReferences(config, resolved);
    expect(inventory.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "refs/heads/main", commitObjectId: baseObjectId }),
        expect.objectContaining({ ref: "refs/tags/reviewed-base", commitObjectId: baseObjectId }),
        expect.objectContaining({
          ref: "refs/tags/non-utf8",
          commitObjectId: nonUtf8CommitId,
          commitSubjectSuggestion: null,
        }),
        expect.objectContaining({
          ref: "refs/tags/large-message",
          commitObjectId: largeCommitId,
          commitSubjectSuggestion: "x".repeat(512),
        }),
        expect.objectContaining({
          ref: "refs/heads/review-source",
          commitObjectId: headObjectId,
          commitSubjectSuggestion: "Review authorization boundary",
        }),
      ]),
    );

    await expect(
      resolveSelectedRevision(config, resolved, inventory, {
        baseRef: "refs/tags/reviewed-base",
        headRef: "refs/heads/review-source",
      }),
    ).resolves.toMatchObject({
      base: { ref: "refs/tags/reviewed-base", objectId: baseObjectId },
      head: { ref: "refs/heads/review-source", objectId: headObjectId },
      objectFormat: "sha1",
    });
    await expect(
      resolveSelectedRevision(config, resolved, inventory, {
        baseRef: "--help",
        headRef: "refs/heads/review-source",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "reference_not_available" }),
    );

    const failingGit = join(fixture, "git-cat-file-failure");
    await writeFile(
      failingGit,
      [
        "#!/bin/sh",
        "previous=''",
        "last=''",
        'for argument in "$@"; do',
        '  previous="$last"',
        '  last="$argument"',
        "done",
        'if [ "$previous" = "cat-file" ] && [ "$last" = "--batch" ]; then',
        "  exit 86",
        "fi",
        'exec /usr/bin/git "$@"',
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await expect(
      resolveSelectedRevision({ ...config, gitExecutable: failingGit }, resolved, inventory, {
        baseRef: "refs/heads/main",
        headRef: "refs/heads/review-source",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "git_inspection_failed" }),
    );

    await writeFile(join(repository, "oversized.txt"), "x".repeat(2048), "utf8");
    const oversizedObjectId = await git(repository, ["hash-object", "-w", "oversized.txt"]);
    await expect(
      readRawGitObject({ ...config, maxBytes: 1 }, resolved, "sha1", oversizedObjectId),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "revision_limit_exceeded" }),
    );

    await expect(readRawGitObject(config, resolved, "sha1", "f".repeat(40))).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "object_missing" }),
    );

    const corruptGit = join(fixture, "git-corrupt-object");
    await writeFile(
      corruptGit,
      [
        "#!/bin/sh",
        "previous=''",
        "last=''",
        'for argument in "$@"; do',
        '  previous="$last"',
        '  last="$argument"',
        "done",
        'if [ "$previous" = "cat-file" ] && [ "$last" = "--batch" ]; then',
        "  while IFS= read -r object_id; do",
        "    printf '%s blob 4\\nevil\\n' \"$object_id\"",
        "  done",
        "  exit 0",
        "fi",
        'exec /usr/bin/git "$@"',
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await expect(
      readRawGitObject({ ...config, gitExecutable: corruptGit }, resolved, "sha1", baseObjectId),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "object_verification_failed" }),
    );
  });

  it("rejects duplicate, overlong, and control-character committed tree paths", async () => {
    const { artifacts, root } = await makeRepositoryFixture(
      "kestrel-local-source-invalid-tree-paths-",
    );
    const { config, resolved } = await resolveFixture(artifacts, root);
    const commitObjectId = "1".repeat(40);
    const treeObjectId = "2".repeat(40);
    const firstBlobId = "3".repeat(40);
    const secondBlobId = "4".repeat(40);
    const commitContent = Buffer.from(`tree ${treeObjectId}\n\nSynthetic commit\n`, "ascii");
    const treeEntry = (name: string, objectId: string) =>
      Buffer.concat([Buffer.from(`100644 ${name}\0`, "utf8"), Buffer.from(objectId, "hex")]);
    const readTree = (content: Buffer) => (objectId: string) => {
      if (objectId === commitObjectId) {
        return Promise.resolve({
          content: commitContent,
          id: commitObjectId,
          size: commitContent.byteLength,
          type: "commit" as const,
        });
      }
      if (objectId === treeObjectId) {
        return Promise.resolve({
          content,
          id: treeObjectId,
          size: content.byteLength,
          type: "tree" as const,
        });
      }
      return Promise.reject(new Error(`Unexpected object read: ${objectId}`));
    };

    const duplicateTree = Buffer.concat([
      treeEntry("duplicate.txt", firstBlobId),
      treeEntry("duplicate.txt", secondBlobId),
    ]);
    await expect(
      listCommitTreeEntries(config, resolved, "sha1", commitObjectId, [], readTree(duplicateTree)),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "repository_invalid" }),
    );

    const overlongTree = treeEntry("x".repeat(4097), firstBlobId);
    await expect(
      listCommitTreeEntries(config, resolved, "sha1", commitObjectId, [], readTree(overlongTree)),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "repository_invalid" }),
    );

    const controlCharacterTree = treeEntry("line\nbreak.txt", firstBlobId);
    await expect(
      listCommitTreeEntries(
        config,
        resolved,
        "sha1",
        commitObjectId,
        [],
        readTree(controlCharacterTree),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "repository_invalid" }),
    );
  });

  it("counts HEAD inside the bounded reference inventory", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "kestrel-local-source-ref-limit-"));
    temporaryDirectories.push(fixture);
    const root = join(fixture, "root");
    const repository = join(root, "kestrel");
    const artifacts = join(fixture, "artifacts");
    const gitRecorder = join(fixture, "git-recorder");
    const gitRecording = join(fixture, "git-recording.txt");
    await mkdir(repository, { recursive: true });
    await mkdir(artifacts, { mode: 0o700 });
    await chmod(artifacts, 0o700);
    await git(repository, ["init", "--initial-branch=main"]);
    await git(repository, ["config", "user.name", "Kestrel Test"]);
    await git(repository, ["config", "user.email", "kestrel@example.invalid"]);
    await writeFile(join(repository, "review.txt"), "base\n", "utf8");
    await git(repository, ["add", "review.txt"]);
    await git(repository, ["commit", "-m", "Base source"]);
    const objectId = await git(repository, ["rev-parse", "HEAD"]);
    const packedRefs = (count: number) =>
      [
        "# pack-refs with: peeled fully-peeled sorted ",
        ...Array.from(
          { length: count },
          (_, index) => `${objectId} refs/tags/review-${String(index).padStart(3, "0")}`,
        ),
        "",
      ].join("\n");
    await writeFile(join(repository, ".git", "packed-refs"), packedRefs(498), "ascii");
    await writeFile(
      gitRecorder,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${gitRecording}\nexec /usr/bin/git "$@"\n`,
      { mode: 0o700 },
    );

    const config = await readLocalSourceConfig({
      LOCAL_REPOSITORY_ROOTS: JSON.stringify([root]),
      LOCAL_GIT_EXECUTABLE: gitRecorder,
      ARTIFACT_ROOT: artifacts,
      REVIEW_REVISION_MAX_BYTES: "1048576",
      REVIEW_REVISION_MAX_OBJECTS: "1000",
    });
    const [candidate] = await import("./index.js").then(({ discoverRepositories }) =>
      discoverRepositories(config),
    );
    if (candidate === undefined) throw new Error("Repository fixture was not discovered");
    const resolved = await resolveRepository(config, candidate.repositoryId);

    const inventory = await listRepositoryReferences(config, resolved);
    expect(inventory.references).toHaveLength(500);
    const recordedCommands = (await readFile(gitRecording, "utf8"))
      .split("\n")
      .filter((line) => line !== "" && line !== "--version");
    expect(recordedCommands.filter((line) => line.includes("for-each-ref"))).toHaveLength(1);
    expect(recordedCommands.filter((line) => line.endsWith("cat-file --batch"))).toHaveLength(1);
    expect(recordedCommands.length).toBeLessThan(20);

    await writeFile(join(repository, ".git", "packed-refs"), packedRefs(499), "ascii");
    await expect(listRepositoryReferences(config, resolved)).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "reference_limit_exceeded" }),
    );
  });

  it("keeps reference inspection budgets separate from exact revision limits", async () => {
    const { artifacts, repository, root } = await makeRepositoryFixture(
      "kestrel-local-source-reference-budget-",
    );
    await git(repository, ["config", "user.name", "Kestrel Test"]);
    await git(repository, ["config", "user.email", "kestrel@example.invalid"]);
    for (let index = 0; index < 101; index += 1) {
      await git(repository, ["commit", "--allow-empty", "-m", `Reference ${String(index)}`]);
      await git(repository, ["branch", `review-${String(index).padStart(3, "0")}`]);
    }
    const config = await readLocalSourceConfig({
      LOCAL_REPOSITORY_ROOTS: JSON.stringify([root]),
      LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
      ARTIFACT_ROOT: artifacts,
      REVIEW_REVISION_MAX_BYTES: "1024",
      REVIEW_REVISION_MAX_OBJECTS: "2",
    });
    const [candidate] = await import("./index.js").then(({ discoverRepositories }) =>
      discoverRepositories(config),
    );
    if (candidate === undefined) throw new Error("Repository fixture was not discovered");
    const resolved = await resolveRepository(config, candidate.repositoryId);

    const inventory = await listRepositoryReferences(config, resolved);
    expect(inventory.references).toHaveLength(103);
    await expect(
      resolveSelectedRevision(config, resolved, inventory, {
        baseRef: "refs/heads/review-000",
        headRef: "refs/heads/main",
      }),
    ).resolves.toMatchObject({
      base: { ref: "refs/heads/review-000" },
      head: { ref: "refs/heads/main" },
    });
  });
});
