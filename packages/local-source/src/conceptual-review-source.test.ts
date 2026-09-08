import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readRetainedSourceManifest, retainRevision } from "./artifact.js";
import { readLocalSourceConfig } from "./config.js";
import {
  readConceptualReviewSourceCatalog,
  readConceptualReviewSourceLines,
} from "./conceptual-review-source.js";
import { discoverRepositories, resolveRepository } from "./discovery.js";
import { listRepositoryReferences, resolveSelectedRevision } from "./git.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
let fixture: Awaited<ReturnType<typeof createFixture>>;

async function git(repository: string, args: string[]) {
  const { stdout } = await execFileAsync("/usr/bin/git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout.trim();
}

async function makeWritable(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  await chmod(path, metadata.isDirectory() ? 0o700 : 0o600);
  if (metadata.isDirectory()) {
    for (const entry of await readdir(path)) await makeWritable(join(path, entry));
  }
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-conceptual-source-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "repositories");
  const repository = join(root, "source");
  const artifacts = join(directory, "artifacts");
  await mkdir(repository, { recursive: true });
  await mkdir(artifacts, { mode: 0o700 });
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.name", "Kestrel Source Test"]);
  await git(repository, ["config", "user.email", "source@example.invalid"]);
  await writeFile(join(repository, "Z.txt"), "base Z\n");
  await writeFile(join(repository, "a.txt"), "base α\r\nsecond base\r\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "Base source"]);
  const baseCommitId = await git(repository, ["rev-parse", "HEAD"]);
  const baseBlobId = await git(repository, ["rev-parse", "HEAD:a.txt"]);
  await git(repository, ["switch", "-c", "review-source"]);
  await writeFile(join(repository, "B.txt"), "head B\n");
  await writeFile(join(repository, "a.txt"), "head α\nline 2\r\nline 3");
  await mkdir(join(repository, "pages"));
  for (let index = 0; index < 205; index += 1) {
    await writeFile(
      join(repository, "pages", `item${String(index).padStart(3, "0")}.txt`),
      "page\n",
    );
  }
  await mkdir(join(repository, "z"));
  const files = {
    "binary.bin": Buffer.from([0, 65]),
    "invalid.bin": Buffer.from([97, 0xc3, 0x28]),
    "lf.txt": "a\nb\n",
    "crlf.txt": "a\r\nb\r\n",
    "empty.txt": "",
    "lone-cr.txt": "left\rright\n",
    "bom.txt": "\ufeffbom\n",
    "lines.txt": Array.from({ length: 201 }, (_, index) => `line ${String(index + 1)}\n`).join(""),
    "max-file.txt": "a\n".repeat(256 * 1024),
    "oversized-file.txt": "a".repeat(512 * 1024 + 1),
    "large-line.txt": "🙂".repeat(8192) + "\n",
    "bounded-line.txt": "🙂".repeat(7900) + "\n",
    "escaped-line.txt": "\t".repeat(16384) + "\n",
    lfs:
      "version https://git-lfs.github.com/spec/v1\n" + `oid sha256:${"a".repeat(64)}\nsize 1234\n`,
    "lfs-crlf":
      "version https://git-lfs.github.com/spec/v1\r\n" +
      `oid sha256:${"a".repeat(64)}\r\nsize 1234\r\n`,
    "lfs-lookalike.txt": "version https://git-lfsXgithub.com/spec/v1\n",
    "executable.sh": "#!/bin/sh\nprintf 'never executed\\n'\n",
  };
  for (const [name, content] of Object.entries(files))
    await writeFile(join(repository, "z", name), content);
  await chmod(join(repository, "z", "executable.sh"), 0o755);
  const secret = join(directory, "outside-secret.txt");
  await writeFile(secret, "outside data must never appear");
  await symlink(secret, join(repository, "z", "link"));
  await git(repository, ["add", "."]);
  await git(repository, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${baseCommitId},z/submodule`,
  ]);
  await git(repository, ["commit", "-m", "Head source"]);
  const headCommitId = await git(repository, ["rev-parse", "HEAD"]);
  const headBlobId = await git(repository, ["rev-parse", "HEAD:a.txt"]);
  const config = await readLocalSourceConfig({
    LOCAL_REPOSITORY_ROOTS: JSON.stringify([root]),
    LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
    ARTIFACT_ROOT: artifacts,
    REVIEW_REVISION_MAX_BYTES: "4194304",
    REVIEW_REVISION_MAX_OBJECTS: "2000",
  });
  const [candidate] = await discoverRepositories(config);
  if (candidate === undefined) throw new Error("Fixture repository was not discovered");
  const resolved = await resolveRepository(config, candidate.repositoryId);
  const references = await listRepositoryReferences(config, resolved);
  const selected = await resolveSelectedRevision(config, resolved, references, {
    baseRef: "refs/heads/main",
    headRef: "refs/heads/review-source",
  });
  const retained = await retainRevision(config, {
    projectId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
    revisionId: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
    selected,
  });
  await writeFile(join(repository, "a.txt"), "uncommitted content must never appear");
  await rename(repository, join(directory, "detached-repository"));
  return {
    directory,
    config: { ...config, repositoryRoots: [], gitExecutable: join(directory, "no-git-allowed") },
    binding: {
      artifactLocator: retained.artifactLocator,
      manifestDigest: retained.manifestDigest,
      expectedBaseCommitId: baseCommitId,
      expectedHeadCommitId: headCommitId,
    },
    baseBlobId,
    headBlobId,
  };
}

beforeAll(async () => {
  fixture = await createFixture();
});

afterAll(async () => {
  for (const directory of temporaryDirectories) {
    await makeWritable(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

describe("retained Conceptual Review source catalog", () => {
  it("paginates the exact retained side deterministically after the source is detached", async () => {
    const base = await readConceptualReviewSourceCatalog(fixture.config, {
      ...fixture.binding,
      side: "base",
    });
    expect(base).toEqual({
      side: "base",
      commitId: fixture.binding.expectedBaseCommitId,
      offset: 0,
      total: 2,
      nextOffset: null,
      entries: [
        expect.objectContaining({ path: "Z.txt", mode: "100644", type: "blob" }),
        { path: "a.txt", mode: "100644", type: "blob", objectId: fixture.baseBlobId },
      ],
    });
    const head = await readConceptualReviewSourceCatalog(fixture.config, {
      ...fixture.binding,
      side: "head",
      limit: 200,
    });
    expect(head).toMatchObject({
      side: "head",
      commitId: fixture.binding.expectedHeadCommitId,
      total: 229,
      offset: 0,
      nextOffset: 200,
    });
    expect(head.entries).toHaveLength(200);
    expect(head.entries.slice(0, 4).map(({ path }) => path)).toEqual([
      "B.txt",
      "Z.txt",
      "a.txt",
      "pages",
    ]);
    expect(head.entries[199]?.path).toBe("pages/item195.txt");
    const tail = await readConceptualReviewSourceCatalog(fixture.config, {
      ...fixture.binding,
      side: "head",
      offset: 200,
      limit: 200,
    });
    expect(tail).toMatchObject({ total: 229, offset: 200, nextOffset: null });
    expect(tail.entries).toHaveLength(29);
    expect(tail.entries[0]?.path).toBe("pages/item196.txt");
    expect(tail.entries[8]?.path).toBe("pages/item204.txt");
    expect(tail.entries[28]?.path).toBe("z/submodule");
    await expect(
      readConceptualReviewSourceCatalog(fixture.config, {
        ...fixture.binding,
        side: "head",
        offset: 229,
        limit: 1,
      }),
    ).resolves.toMatchObject({ entries: [], total: 229, offset: 229, nextOffset: null });
    expect(JSON.stringify(head)).not.toContain(fixture.directory);
    expect(JSON.stringify(head)).not.toContain(fixture.binding.artifactLocator);
  });

  it("rejects a different frozen commit pair even when the retained locator and digest are valid", async () => {
    for (const binding of [
      { expectedBaseCommitId: fixture.binding.expectedHeadCommitId },
      { expectedHeadCommitId: fixture.binding.expectedBaseCommitId },
    ]) {
      await expect(
        readConceptualReviewSourceCatalog(fixture.config, {
          ...fixture.binding,
          ...binding,
          side: "head",
          limit: 1,
        }),
      ).rejects.toMatchObject({ code: "revision_mismatch" });
    }
  });

  it("rejects malformed identity, side and pagination before trying to access source", async () => {
    const input = { ...fixture.binding, side: "head" as const };
    for (const invalid of [
      null,
      { ...input, side: "merge" },
      { ...input, expectedBaseCommitId: "HEAD" },
      { ...input, expectedHeadCommitId: "a".repeat(39) },
      { ...input, artifactLocator: 3 },
      { ...input, manifestDigest: null },
      { ...input, offset: -1 },
      { ...input, offset: null },
      { ...input, offset: 0.5 },
      { ...input, offset: Number.MAX_SAFE_INTEGER + 1 },
      { ...input, limit: 0 },
      { ...input, limit: null },
      { ...input, limit: 201 },
      { ...input, limit: Number.NaN },
      { ...input, limit: "20" },
    ]) {
      await expect(
        readConceptualReviewSourceCatalog(fixture.config, invalid as never),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
  });
});

describe("retained Conceptual Review source lines", () => {
  it("stamps the exact side and blob while preserving UTF-8 and retained line endings", async () => {
    const base = await readConceptualReviewSourceLines(fixture.config, {
      ...fixture.binding,
      side: "base",
      path: "a.txt",
      startLine: 1,
      endLine: 2,
    });
    expect(base).toEqual({
      status: "available",
      side: "base",
      commitId: fixture.binding.expectedBaseCommitId,
      path: "a.txt",
      mode: "100644",
      type: "blob",
      objectId: fixture.baseBlobId,
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      hasFinalNewline: true,
      lineEndings: ["crlf", "crlf"],
      text: "base α\r\nsecond base\r\n",
    });
    const head = await readConceptualReviewSourceLines(fixture.config, {
      ...fixture.binding,
      side: "head",
      path: "a.txt",
      startLine: 2,
      endLine: 3,
    });
    expect(head).toEqual({
      status: "available",
      side: "head",
      commitId: fixture.binding.expectedHeadCommitId,
      path: "a.txt",
      mode: "100644",
      type: "blob",
      objectId: fixture.headBlobId,
      startLine: 2,
      endLine: 3,
      totalLines: 3,
      hasFinalNewline: false,
      lineEndings: ["crlf", "none"],
      text: "line 2\r\nline 3",
    });
    expect(JSON.stringify(head)).not.toContain(fixture.directory);
    expect(JSON.stringify(head)).not.toContain(fixture.binding.artifactLocator);
  });

  it("uses LF boundaries without inventing a trailing line or dropping a BOM or lone CR", async () => {
    for (const [path, text, totalLines, lineEndings] of [
      ["z/lf.txt", "a\nb\n", 2, ["lf", "lf"]],
      ["z/crlf.txt", "a\r\nb\r\n", 2, ["crlf", "crlf"]],
      ["z/bom.txt", "\ufeffbom\n", 1, ["lf"]],
      ["z/lone-cr.txt", "left\rright\n", 1, ["lf"]],
    ] as const) {
      await expect(
        readConceptualReviewSourceLines(fixture.config, {
          ...fixture.binding,
          side: "head",
          path,
          startLine: 1,
          endLine: totalLines,
        }),
      ).resolves.toMatchObject({
        status: "available",
        text,
        totalLines,
        lineEndings,
        hasFinalNewline: true,
      });
    }
    for (const [path, startLine, endLine, totalLines] of [
      ["z/empty.txt", 1, 1, 0],
      ["z/lf.txt", 3, 3, 2],
      ["z/lf.txt", 1, 3, 2],
    ] as const) {
      await expect(
        readConceptualReviewSourceLines(fixture.config, {
          ...fixture.binding,
          side: "head",
          path,
          startLine,
          endLine,
        }),
      ).rejects.toMatchObject({ code: "range_out_of_bounds", totalLines });
    }
  });

  it("discloses unsupported source kinds instead of reading symlink targets or presenting pointers as code", async () => {
    const manifest = await readRetainedSourceManifest(fixture.config, fixture.binding);
    for (const [path, reason, mode, type] of [
      ["z/binary.bin", "binary", "100644", "blob"],
      ["z/link", "symlink", "120000", "blob"],
      ["z/submodule", "gitlink", "160000", "commit"],
      ["z/lfs", "git_lfs_pointer", "100644", "blob"],
      ["z/lfs-crlf", "git_lfs_pointer", "100644", "blob"],
      ["z", "directory", "040000", "tree"],
    ] as const) {
      const result = await readConceptualReviewSourceLines(fixture.config, {
        ...fixture.binding,
        side: "head",
        path,
        startLine: 1,
        endLine: 1,
      });
      expect(result).toEqual({
        status: "unsupported",
        reason,
        path,
        mode,
        type,
        side: "head",
        commitId: fixture.binding.expectedHeadCommitId,
        objectId: manifest.head.entries.find((entry) => entry.path === path)?.objectId,
      });
      expect(result).not.toHaveProperty("text");
      expect(JSON.stringify(result)).not.toContain(fixture.directory);
    }
    await expect(
      readConceptualReviewSourceLines(fixture.config, {
        ...fixture.binding,
        side: "head",
        path: "z/executable.sh",
        startLine: 1,
        endLine: 1,
      }),
    ).resolves.toMatchObject({ status: "available", mode: "100755", text: "#!/bin/sh\n" });
    await expect(
      readConceptualReviewSourceLines(fixture.config, {
        ...fixture.binding,
        side: "head",
        path: "z/invalid.bin",
        startLine: 1,
        endLine: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_utf8" });
    await expect(
      readConceptualReviewSourceLines(fixture.config, {
        ...fixture.binding,
        side: "head",
        path: "z/lfs-lookalike.txt",
        startLine: 1,
        endLine: 1,
      }),
    ).resolves.toMatchObject({
      status: "available",
      text: "version https://git-lfsXgithub.com/spec/v1\n",
    });
  });

  it("rejects traversal and non-exact paths without substituting another side", async () => {
    for (const path of [
      "",
      "/a.txt",
      "../a.txt",
      "pages/../a.txt",
      "./a.txt",
      "pages//item000.txt",
      "a.txt/",
      "..\\a.txt",
      "a.txt\0",
      "C:/a.txt",
      "https://example.invalid/a.txt",
      "a".repeat(4097),
    ]) {
      await expect(
        readConceptualReviewSourceLines(fixture.config, {
          ...fixture.binding,
          side: "head",
          path,
          startLine: 1,
          endLine: 1,
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    for (const [side, path] of [
      ["base", "B.txt"],
      ["head", "missing.txt"],
      ["head", "%2e%2e/a.txt"],
      ["head", "z/link/outside-secret.txt"],
      ["head", "z/submodule/a.txt"],
    ] as const) {
      await expect(
        readConceptualReviewSourceLines(fixture.config, {
          ...fixture.binding,
          side,
          path,
          startLine: 1,
          endLine: 1,
        }),
      ).rejects.toMatchObject({ code: "path_not_retained" });
    }
    await expect(
      readConceptualReviewSourceLines(fixture.config, {
        ...fixture.binding,
        expectedBaseCommitId: fixture.binding.expectedHeadCommitId,
        side: "head",
        path: "a.txt",
        startLine: 1,
        endLine: 1,
      }),
    ).rejects.toMatchObject({ code: "revision_mismatch" });
  });

  it("enforces inclusive safe integer ranges and the 200-line bound", async () => {
    const input = {
      ...fixture.binding,
      side: "head" as const,
      path: "z/lines.txt",
      startLine: 1,
      endLine: 1,
    };
    for (const invalid of [
      null,
      { ...input, path: 1 },
      { ...input, side: "merge" },
      { ...input, startLine: 0 },
      { ...input, startLine: -1 },
      { ...input, startLine: 1.5 },
      { ...input, startLine: Number.NaN },
      { ...input, startLine: 2, endLine: 1 },
      { ...input, endLine: Number.MAX_SAFE_INTEGER + 1 },
      { ...input, endLine: "2" },
    ]) {
      await expect(
        readConceptualReviewSourceLines(fixture.config, invalid as never),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    await expect(
      readConceptualReviewSourceLines(fixture.config, { ...input, endLine: 201 }),
    ).rejects.toMatchObject({ code: "range_too_large" });
    const result = await readConceptualReviewSourceLines(fixture.config, {
      ...input,
      startLine: 2,
      endLine: 201,
    });
    expect(result).toMatchObject({
      status: "available",
      startLine: 2,
      endLine: 201,
      totalLines: 201,
    });
    if (result.status !== "available") throw new Error("Expected retained text");
    expect(result.lineEndings).toHaveLength(200);
    expect(result.text.startsWith("line 2\nline 3\n")).toBe(true);
    expect(result.text.endsWith("line 200\nline 201\n")).toBe(true);
  });

  it("caps serialized UTF-8 response bytes without truncating or splitting a retained line", async () => {
    for (const path of ["z/large-line.txt", "z/escaped-line.txt"]) {
      await expect(
        readConceptualReviewSourceLines(fixture.config, {
          ...fixture.binding,
          side: "head",
          path,
          startLine: 1,
          endLine: 1,
        }),
      ).rejects.toMatchObject({ code: "response_too_large" });
    }
    const result = await readConceptualReviewSourceLines(fixture.config, {
      ...fixture.binding,
      side: "head",
      path: "z/bounded-line.txt",
      startLine: 1,
      endLine: 1,
    });
    expect(result).toMatchObject({ status: "available", text: "🙂".repeat(7900) + "\n" });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(32 * 1024);
  });

  it("checks the 512-KiB file bound from verified metadata before opening the blob", async () => {
    const manifest = await readRetainedSourceManifest(fixture.config, fixture.binding);
    const objectId = manifest.head.entries.find(
      ({ path }) => path === "z/oversized-file.txt",
    )?.objectId;
    if (objectId === undefined) throw new Error("Oversized fixture blob is missing");
    const objectPath = join(
      fixture.config.artifactRoot,
      fixture.binding.artifactLocator,
      "objects",
      objectId.slice(0, 2),
      objectId.slice(2),
    );
    const parentPath = dirname(objectPath);
    await chmod(parentPath, 0o700);
    const hiddenPath = join(fixture.directory, "hidden-large-blob");
    await rename(objectPath, hiddenPath);
    try {
      await expect(
        readConceptualReviewSourceLines(fixture.config, {
          ...fixture.binding,
          side: "head",
          path: "z/oversized-file.txt",
          startLine: 1,
          endLine: 1,
        }),
      ).rejects.toMatchObject({ code: "file_too_large" });
    } finally {
      await rename(hiddenPath, objectPath);
      await chmod(parentPath, 0o500);
    }
    await expect(
      readConceptualReviewSourceLines(fixture.config, {
        ...fixture.binding,
        side: "head",
        path: "z/max-file.txt",
        startLine: 262144,
        endLine: 262144,
      }),
    ).resolves.toMatchObject({ status: "available", text: "a\n", totalLines: 262144 });
  });
});

describe("retained source integrity", () => {
  it("verifies the manifest digest on every catalog and line read", async () => {
    const manifestPath = join(
      fixture.config.artifactRoot,
      fixture.binding.artifactLocator,
      "manifest.json",
    );
    const original = await readFile(manifestPath);
    const readers = [
      () =>
        readConceptualReviewSourceCatalog(fixture.config, {
          ...fixture.binding,
          side: "head",
          limit: 1,
        }),
      () =>
        readConceptualReviewSourceLines(fixture.config, {
          ...fixture.binding,
          side: "head",
          path: "a.txt",
          startLine: 1,
          endLine: 1,
        }),
    ];
    await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, Buffer.concat([original, Buffer.from(" ")]));
    try {
      for (const read of readers)
        await expect(read()).rejects.toMatchObject({ code: "object_verification_failed" });
    } finally {
      await writeFile(manifestPath, original);
      await chmod(manifestPath, 0o400);
    }
    for (const read of readers) await expect(read()).resolves.toBeDefined();
    for (const artifactLocator of [
      "/tmp/manifest.json",
      `${fixture.binding.artifactLocator}/../escape`,
    ]) {
      await expect(
        readConceptualReviewSourceCatalog(fixture.config, {
          ...fixture.binding,
          artifactLocator,
          side: "head",
          limit: 1,
        }),
      ).rejects.toMatchObject({ code: "source_containment_violation" });
    }
  });

  it("rejects a malformed retained manifest even when its supplied digest matches", async () => {
    const manifestPath = join(
      fixture.config.artifactRoot,
      fixture.binding.artifactLocator,
      "manifest.json",
    );
    const original = await readFile(manifestPath);
    const malformed = Buffer.from('{"schemaVersion":1,"base":null,"head":null}');
    await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, malformed);
    try {
      await expect(
        readConceptualReviewSourceCatalog(fixture.config, {
          ...fixture.binding,
          manifestDigest: createHash("sha256").update(malformed).digest("hex"),
          side: "head",
        }),
      ).rejects.toMatchObject({ code: "object_verification_failed" });
    } finally {
      await writeFile(manifestPath, original);
      await chmod(manifestPath, 0o400);
    }
  });

  it("hash-verifies displayed bytes and rejects substituted artifact symlinks", async () => {
    const objectId = fixture.headBlobId;
    const objectPath = join(
      fixture.config.artifactRoot,
      fixture.binding.artifactLocator,
      "objects",
      objectId.slice(0, 2),
      objectId.slice(2),
    );
    const original = await readFile(objectPath);
    const corrupted = Buffer.from(original);
    corrupted[0] = 88;
    const read = () =>
      readConceptualReviewSourceLines(fixture.config, {
        ...fixture.binding,
        side: "head",
        path: "a.txt",
        startLine: 1,
        endLine: 1,
      });
    await chmod(objectPath, 0o600);
    await writeFile(objectPath, corrupted);
    try {
      await expect(read()).rejects.toMatchObject({ code: "object_verification_failed" });
    } finally {
      await writeFile(objectPath, original);
      await chmod(objectPath, 0o400);
    }
    const hiddenPath = join(fixture.directory, "hidden-source-blob");
    await chmod(dirname(objectPath), 0o700);
    await rename(objectPath, hiddenPath);
    await symlink(hiddenPath, objectPath);
    try {
      await expect(read()).rejects.toMatchObject({ code: "object_verification_failed" });
    } finally {
      await rm(objectPath);
      await rename(hiddenPath, objectPath);
      await chmod(dirname(objectPath), 0o500);
    }
    await expect(read()).resolves.toMatchObject({
      status: "available",
      objectId,
      text: "head α\n",
    });
  });
});
