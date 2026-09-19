import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { openRetainedSourceSnapshot, readRetainedRevisionIdentity } from "./artifact.js";
import type { LocalSourceConfig } from "./config.js";
import {
  ConceptualReviewSourceError,
  type ConceptualReviewSourceBinding,
} from "./conceptual-review-source.js";
import { LocalSourceError } from "./errors.js";

interface MaterializedFile {
  path: string;
  mode: "100644" | "100755";
  digest: string;
}

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const OWNER_FILE = ".kestrel-review-owner";
const CONTROL_OWNER_FILE = ".kestrel-review-control-owner";

export interface ConceptualReviewWorkspace {
  path: string;
  files: { base: number; head: number };
  verify(signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

export interface ConceptualReviewWorkspaceLimits {
  maximumFiles: number;
  maximumBytes: number;
}

function safePath(path: string): boolean {
  const parts = path.split("/");
  return (
    path.length > 0 &&
    Buffer.byteLength(path, "utf8") <= 4096 &&
    !/[\p{Cc}\\]/u.test(path) &&
    !/^[a-z][a-z0-9+.-]*:/iu.test(path) &&
    !parts.some(
      (part) =>
        part === "" || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > 255,
    )
  );
}

function cancelled(signal?: AbortSignal, preserveReason = false): void {
  if (signal?.aborted !== true) return;
  if (preserveReason && signal.reason instanceof Error) throw signal.reason;
  throw new LocalSourceError("acquisition_cancelled");
}

async function makeWritable(path: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(path)) await makeWritable(join(path, entry));
  } else {
    await chmod(path, 0o600);
  }
}

function assertWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID.test(workspaceId)) throw new LocalSourceError("source_containment_violation");
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function workspaceParent(config: LocalSourceConfig): Promise<string> {
  const parent = join(config.artifactRoot, "review-workspaces");
  await mkdir(parent, { mode: 0o700 }).catch((error: unknown) => {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ))
      throw error;
  });
  const metadata = await lstat(parent);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.getuid !== undefined && metadata.uid !== process.getuid()) ||
    (metadata.mode & 0o777) !== 0o700
  )
    throw new LocalSourceError("source_containment_violation");
  return parent;
}

async function privateAttemptParent(config: LocalSourceConfig, name: string): Promise<string> {
  const parent = join(config.artifactRoot, name);
  await mkdir(parent, { mode: 0o700 }).catch((error: unknown) => {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ))
      throw error;
  });
  const metadata = await lstat(parent);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.getuid !== undefined && metadata.uid !== process.getuid()) ||
    (metadata.mode & 0o777) !== 0o700
  )
    throw new LocalSourceError("source_containment_violation");
  return parent;
}

async function disposeAttemptDirectory(
  config: LocalSourceConfig,
  parentName: string,
  attemptId: string,
): Promise<void> {
  assertWorkspaceId(attemptId);
  const parent = join(config.artifactRoot, parentName);
  const parentMetadata = await lstat(parent).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (parentMetadata === null) return;
  if (
    !parentMetadata.isDirectory() ||
    parentMetadata.isSymbolicLink() ||
    (process.getuid !== undefined && parentMetadata.uid !== process.getuid()) ||
    (parentMetadata.mode & 0o777) !== 0o700
  )
    throw new LocalSourceError("source_containment_violation");
  const root = join(parent, attemptId);
  const rootMetadata = await lstat(root).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (rootMetadata === null) return;
  await verifyWorkspaceDirectory(root);
  await makeWritable(root);
  await rm(root, { recursive: true });
}

async function verifyWorkspaceDirectory(root: string): Promise<void> {
  const metadata = await lstat(root);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.getuid !== undefined && metadata.uid !== process.getuid())
  )
    throw new LocalSourceError("source_containment_violation");
}

async function verifyWorkspaceOwner(root: string, workspaceId: string): Promise<void> {
  await verifyWorkspaceDirectory(root);
  const ownerPath = join(root, OWNER_FILE);
  const ownerMetadata = await lstat(ownerPath);
  if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink())
    throw new LocalSourceError("source_containment_violation");
  if ((await readFile(ownerPath, "utf8")) !== `${workspaceId}\n`)
    throw new LocalSourceError("source_containment_violation");
}

export async function disposeConceptualReviewWorkspace(
  config: LocalSourceConfig,
  workspaceId: string,
): Promise<void> {
  await disposeAttemptDirectory(config, "review-workspaces", workspaceId);
}

export async function prepareConceptualReviewControlDirectory(
  config: LocalSourceConfig,
  attemptId: string,
): Promise<string> {
  assertWorkspaceId(attemptId);
  const root = join(await privateAttemptParent(config, "review-controls"), attemptId);
  await mkdir(root, { mode: 0o700 });
  try {
    await writeFile(join(root, CONTROL_OWNER_FILE), `${attemptId}\n`, {
      flag: "wx",
      mode: 0o400,
    });
    return root;
  } catch (error) {
    await makeWritable(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function disposeConceptualReviewControlDirectory(
  config: LocalSourceConfig,
  attemptId: string,
): Promise<void> {
  await disposeAttemptDirectory(config, "review-controls", attemptId);
}

export async function disposeConceptualReviewAttemptResources(
  config: LocalSourceConfig,
  attemptId: string,
): Promise<void> {
  await disposeConceptualReviewWorkspace(config, attemptId);
  await disposeConceptualReviewControlDirectory(config, attemptId);
}

/**
 * Builds an ephemeral, path-safe copy from verified retained Git objects. The
 * returned root contains only base/head regular blobs and an inert `.git`
 * marker required by the contained Codex transport. It never uses a checkout,
 * symlink, gitlink, credential, remote, or Git LFS hydration.
 */
export async function materializeConceptualReviewWorkspace(
  config: LocalSourceConfig,
  binding: Omit<ConceptualReviewSourceBinding, "side">,
  workspaceId: string,
  limits: ConceptualReviewWorkspaceLimits,
  signal?: AbortSignal,
): Promise<ConceptualReviewWorkspace> {
  assertWorkspaceId(workspaceId);
  if (
    !Number.isSafeInteger(limits.maximumFiles) ||
    limits.maximumFiles < 1 ||
    !Number.isSafeInteger(limits.maximumBytes) ||
    limits.maximumBytes < 1
  )
    throw new LocalSourceError("review_workspace_limit_exceeded");
  cancelled(signal);
  const snapshot = await openRetainedSourceSnapshot(config, binding);
  const { manifest, identity } = snapshot;
  if (
    manifest.base.commitObjectId !== binding.expectedBaseCommitId ||
    manifest.head.commitObjectId !== binding.expectedHeadCommitId ||
    identity.head.treeObjectId !== binding.expectedHeadTreeId
  )
    throw new ConceptualReviewSourceError("revision_mismatch");

  const objects = new Map(manifest.objects.map((object) => [object.id, object]));
  const planned: Array<{
    side: "base" | "head";
    entry: (typeof manifest.base.entries)[number];
    object: (typeof manifest.objects)[number];
  }> = [];
  const directories = new Set<string>();
  let plannedBytes = 0;
  for (const side of ["base", "head"] as const) {
    for (const entry of manifest[side].entries) {
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) continue;
      if (!safePath(entry.path)) throw new LocalSourceError("source_containment_violation");
      const parts = entry.path.split("/");
      if (parts.length > 64) throw new LocalSourceError("review_workspace_limit_exceeded");
      for (let index = 1; index < parts.length; index += 1)
        directories.add(`${side}/${parts.slice(0, index).join("/")}`);
      const object = objects.get(entry.objectId);
      if (object === undefined || object.type !== "blob")
        throw new LocalSourceError("review_workspace_limit_exceeded");
      plannedBytes += object.size;
      planned.push({ side, entry, object });
      if (
        planned.length > limits.maximumFiles ||
        directories.size > limits.maximumFiles ||
        plannedBytes > limits.maximumBytes
      )
        throw new LocalSourceError("review_workspace_limit_exceeded");
    }
  }

  const root = join(await workspaceParent(config), workspaceId);
  await mkdir(root, { mode: 0o700 });
  const recorded: MaterializedFile[] = [];
  const counts = { base: 0, head: 0 };
  try {
    await writeFile(join(root, OWNER_FILE), `${workspaceId}\n`, { flag: "wx", mode: 0o400 });
    await writeFile(join(root, ".git"), "gitdir: /kestrel-review-no-git\n", { mode: 0o400 });
    for (const side of ["base", "head"] as const) {
      const sideRoot = join(root, side);
      await mkdir(sideRoot, { mode: 0o700 });
      for (const { entry, object } of planned.filter((candidate) => candidate.side === side)) {
        cancelled(signal);
        const bytes = await snapshot.readBlob(entry.objectId);
        if (bytes.byteLength !== object.size)
          throw new LocalSourceError("object_verification_failed");
        const destination = join(sideRoot, entry.path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const mode = entry.mode as "100644" | "100755";
        await writeFile(destination, bytes, {
          flag: "wx",
          mode: mode === "100755" ? 0o500 : 0o400,
        });
        recorded.push({
          path: `${side}/${entry.path}`,
          mode,
          digest: createHash("sha256").update(bytes).digest("hex"),
        });
        counts[side] += 1;
      }
    }
    const verify = async (verificationSignal?: AbortSignal) => {
      cancelled(verificationSignal, true);
      await verifyWorkspaceOwner(root, workspaceId);
      const currentIdentity = await readRetainedRevisionIdentity(config, binding);
      cancelled(verificationSignal, true);
      if (
        currentIdentity.base.commitObjectId !== identity.base.commitObjectId ||
        currentIdentity.base.treeObjectId !== identity.base.treeObjectId ||
        currentIdentity.head.commitObjectId !== identity.head.commitObjectId ||
        currentIdentity.head.treeObjectId !== identity.head.treeObjectId
      )
        throw new ConceptualReviewSourceError("revision_mismatch");
      for (const file of recorded) {
        cancelled(verificationSignal, true);
        const metadata = await lstat(join(root, file.path));
        if (!metadata.isFile() || metadata.isSymbolicLink())
          throw new LocalSourceError("object_verification_failed");
        const digest = createHash("sha256")
          .update(await readFile(join(root, file.path)))
          .digest("hex");
        cancelled(verificationSignal, true);
        if (digest !== file.digest) throw new LocalSourceError("object_verification_failed");
      }
    };
    return {
      path: root,
      files: counts,
      verify,
      async dispose() {
        await disposeConceptualReviewWorkspace(config, workspaceId);
      },
    };
  } catch (error) {
    await makeWritable(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
