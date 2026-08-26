import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import type * as FileSystemPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

const parentSyncFault = vi.hoisted(() => ({ enabled: false, failed: false, published: false }));
const partialWriteFault = vi.hoisted(() => ({ enabled: false, failed: false }));
const renameFault = vi.hoisted(() => ({ enabled: false, failed: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystemPromises>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      if (
        partialWriteFault.enabled &&
        !partialWriteFault.failed &&
        args[1] === "wx" &&
        path.includes("/objects/")
      ) {
        return {
          close: () => handle.close(),
          sync: () => handle.sync(),
          async writeFile(contents: string | Uint8Array) {
            const bytes =
              typeof contents === "string"
                ? Buffer.from(contents)
                : Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength);
            await handle.writeFile(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
            partialWriteFault.failed = true;
            throw new Error("simulated partial object write");
          },
        } as unknown as typeof handle;
      }
      if (
        !parentSyncFault.enabled ||
        !parentSyncFault.published ||
        parentSyncFault.failed ||
        !path.endsWith("/revisions")
      ) {
        return handle;
      }
      return {
        close: () => handle.close(),
        sync: () => {
          parentSyncFault.failed = true;
          return Promise.reject(new Error("simulated parent fsync failure"));
        },
      } as typeof handle;
    },
    async rename(...args: Parameters<typeof actual.rename>) {
      if (renameFault.enabled && !renameFault.failed && String(args[1]).endsWith(REVISION_ID)) {
        renameFault.failed = true;
        throw new Error("simulated publication rename failure");
      }
      await actual.rename(...args);
      if (parentSyncFault.enabled && String(args[1]).endsWith(REVISION_ID)) {
        parentSyncFault.published = true;
      }
    },
  };
});

import {
  discoverRepositories,
  listRepositoryReferences,
  readLocalSourceConfig,
  readRetainedFile,
  resolveRepository,
  resolveSelectedRevision,
  retainRevision,
  type LocalSourceConfig,
  type SelectedRevision,
} from "./index.js";
import type { LocalSourceError } from "./index.js";

const execFileAsync = promisify(execFile);
const PROJECT_ID = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const REVISION_ID = "018f0f89-9a21-7271-b92d-f1cb0d48bb47";
const temporaryDirectories: string[] = [];

async function makeWritable(path: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await makeWritable(join(path, entry));
    return;
  }
  await chmod(path, 0o600);
}

async function git(repository: string, args: readonly string[]): Promise<void> {
  await execFileAsync("/usr/bin/git", ["-C", repository, ...args]);
}

async function retentionFixture(): Promise<{
  config: LocalSourceConfig;
  selected: SelectedRevision;
}> {
  const fixture = await mkdtemp(join(tmpdir(), "kestrel-artifact-failure-"));
  temporaryDirectories.push(fixture);
  const root = join(fixture, "root");
  const repository = join(root, "repository");
  const artifacts = join(fixture, "artifacts");
  await mkdir(repository, { recursive: true });
  await mkdir(artifacts, { mode: 0o700 });
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.name", "Kestrel Test"]);
  await git(repository, ["config", "user.email", "kestrel@example.invalid"]);
  await writeFile(join(repository, "review.txt"), "base\n", "utf8");
  await git(repository, ["add", "review.txt"]);
  await git(repository, ["commit", "-m", "Base"]);
  await git(repository, ["switch", "-c", "review-source"]);
  await writeFile(join(repository, "review.txt"), "head\n", "utf8");
  await git(repository, ["commit", "-am", "Head"]);

  const config = await readLocalSourceConfig({
    LOCAL_REPOSITORY_ROOTS: JSON.stringify([root]),
    LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
    ARTIFACT_ROOT: artifacts,
    REVIEW_REVISION_MAX_BYTES: "1048576",
    REVIEW_REVISION_MAX_OBJECTS: "1000",
  });
  const candidate = (await discoverRepositories(config))[0];
  if (candidate === undefined) throw new Error("Repository fixture was not discovered");
  const repositoryObservation = await resolveRepository(config, candidate.repositoryId);
  const references = await listRepositoryReferences(config, repositoryObservation);
  const selected = await resolveSelectedRevision(config, repositoryObservation, references, {
    baseRef: "refs/heads/main",
    headRef: "refs/heads/review-source",
  });
  return { config, selected };
}

afterEach(async () => {
  parentSyncFault.enabled = false;
  parentSyncFault.failed = false;
  parentSyncFault.published = false;
  partialWriteFault.enabled = false;
  partialWriteFault.failed = false;
  renameFault.enabled = false;
  renameFault.failed = false;
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await makeWritable(directory);
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("artifact publication failure recovery", () => {
  async function expectNoPublishedRevision(config: LocalSourceConfig): Promise<void> {
    const revisions = join(config.artifactRoot, "projects", PROJECT_ID, "revisions");
    await expect(lstat(join(revisions, REVISION_ID))).rejects.toMatchObject({ code: "ENOENT" });
    const entries = await readdir(revisions).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    expect(entries).toEqual([]);
  }

  it.skipIf(process.platform === "win32")(
    "times out a stalled object stream without publishing a final artifact",
    async () => {
      const { config, selected } = await retentionFixture();
      const hangingGit = join(config.artifactRoot, "hanging-git");
      await writeFile(
        hangingGit,
        '#!/bin/sh\ncase "$*" in\n  *" cat-file --batch") while :; do /bin/sleep 1; done ;;\nesac\nexec /usr/bin/git "$@"\n',
        { mode: 0o700 },
      );

      await expect(
        retainRevision(
          { ...config, gitExecutable: hangingGit, gitObjectReadTimeoutMs: 25 },
          { projectId: PROJECT_ID, revisionId: REVISION_ID, selected },
        ),
      ).rejects.toEqual(
        expect.objectContaining<Partial<LocalSourceError>>({ code: "git_inspection_failed" }),
      );
      await expectNoPublishedRevision(config);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a truncated object frame without publishing a final artifact",
    async () => {
      const { config, selected } = await retentionFixture();
      const truncatedGit = join(config.artifactRoot, "truncated-git");
      await writeFile(
        truncatedGit,
        '#!/bin/sh\ncase "$*" in\n  *" cat-file --batch") IFS= read -r object_id; printf \'%s commit 1024\\ntruncated\' "$object_id"; exit 0 ;;\nesac\nexec /usr/bin/git "$@"\n',
        { mode: 0o700 },
      );

      await expect(
        retainRevision(
          { ...config, gitExecutable: truncatedGit },
          { projectId: PROJECT_ID, revisionId: REVISION_ID, selected },
        ),
      ).rejects.toEqual(
        expect.objectContaining<Partial<LocalSourceError>>({ code: "git_inspection_failed" }),
      );
      await expectNoPublishedRevision(config);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects an overlong object stream without publishing a final artifact",
    async () => {
      const { config, selected } = await retentionFixture();
      const overflowingGit = join(config.artifactRoot, "overflowing-git");
      await writeFile(
        overflowingGit,
        '#!/bin/sh\ncase "$*" in\n  *" cat-file --batch") /bin/dd if=/dev/zero bs=2097152 count=1 2>/dev/null; exit 0 ;;\nesac\nexec /usr/bin/git "$@"\n',
        { mode: 0o700 },
      );

      await expect(
        retainRevision(
          { ...config, gitExecutable: overflowingGit },
          { projectId: PROJECT_ID, revisionId: REVISION_ID, selected },
        ),
      ).rejects.toEqual(
        expect.objectContaining<Partial<LocalSourceError>>({ code: "revision_limit_exceeded" }),
      );
      await expectNoPublishedRevision(config);
    },
  );

  it("removes a partially written object and its staging tree", async () => {
    const { config, selected } = await retentionFixture();
    partialWriteFault.enabled = true;

    await expect(
      retainRevision(config, { projectId: PROJECT_ID, revisionId: REVISION_ID, selected }),
    ).rejects.toThrow("simulated partial object write");
    expect(partialWriteFault.failed).toBe(true);
    await expectNoPublishedRevision(config);
  });

  it("removes the complete staging tree when the publication rename fails", async () => {
    const { config, selected } = await retentionFixture();
    renameFault.enabled = true;

    await expect(
      retainRevision(config, { projectId: PROJECT_ID, revisionId: REVISION_ID, selected }),
    ).rejects.toThrow("simulated publication rename failure");
    expect(renameFault.failed).toBe(true);
    await expectNoPublishedRevision(config);
  });

  it("rolls back a final rename when the parent-directory fsync fails", async () => {
    const { config, selected } = await retentionFixture();
    parentSyncFault.enabled = true;

    await expect(
      retainRevision(config, { projectId: PROJECT_ID, revisionId: REVISION_ID, selected }),
    ).rejects.toThrow("simulated parent fsync failure");
    expect(parentSyncFault.failed).toBe(true);
    await expectNoPublishedRevision(config);
  });

  it("never overwrites an existing immutable final artifact", async () => {
    const { config, selected } = await retentionFixture();
    const retained = await retainRevision(config, {
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
      selected,
    });

    await expect(
      retainRevision(config, { projectId: PROJECT_ID, revisionId: REVISION_ID, selected }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalSourceError>>({ code: "object_verification_failed" }),
    );
    await expect(
      readRetainedFile(config, {
        artifactLocator: retained.artifactLocator,
        manifestDigest: retained.manifestDigest,
        path: "review.txt",
        side: "head",
      }),
    ).resolves.toEqual(Buffer.from("head\n"));
  });
});
