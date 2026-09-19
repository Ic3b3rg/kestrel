import { openRetainedSourceSnapshot, type RetainedSourceSnapshot } from "./artifact.js";
import type { LocalSourceConfig } from "./config.js";
import { LocalSourceError } from "./errors.js";
import type { GitTreeEntry } from "./git.js";

export interface ConceptualReviewSourceBinding {
  artifactLocator: string;
  manifestDigest: string;
  expectedBaseCommitId: string;
  expectedHeadCommitId: string;
  expectedHeadTreeId: string;
  side: "base" | "head";
}

export type ConceptualReviewSourceRevisionBinding = Omit<ConceptualReviewSourceBinding, "side">;

export interface ConceptualReviewSourceCatalog {
  side: "base" | "head";
  commitId: string;
  entries: GitTreeEntry[];
  offset: number;
  total: number;
  nextOffset: number | null;
}

export type ConceptualReviewSourceErrorCode =
  | "invalid_request"
  | "revision_mismatch"
  | "invalid_utf8"
  | "file_too_large"
  | "range_too_large"
  | "range_out_of_bounds"
  | "response_too_large";

export class ConceptualReviewSourceError extends Error {
  constructor(
    public readonly code: ConceptualReviewSourceErrorCode,
    public readonly totalLines?: number,
  ) {
    super(`Retained source inspection failed: ${code}`);
    this.name = "ConceptualReviewSourceError";
  }
}

function validCommitId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function assertRevisionBinding(
  input: unknown,
): asserts input is ConceptualReviewSourceRevisionBinding {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ConceptualReviewSourceError("invalid_request");
  }
  const request = input as Record<string, unknown>;
  if (
    typeof request["artifactLocator"] !== "string" ||
    typeof request["manifestDigest"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(request["manifestDigest"]) ||
    !validCommitId(request["expectedBaseCommitId"]) ||
    !validCommitId(request["expectedHeadCommitId"]) ||
    !validCommitId(request["expectedHeadTreeId"])
  ) {
    throw new ConceptualReviewSourceError("invalid_request");
  }
}

function assertSide(side: unknown): asserts side is "base" | "head" {
  if (side !== "base" && side !== "head") throw new ConceptualReviewSourceError("invalid_request");
}

function assertBinding(input: unknown): asserts input is ConceptualReviewSourceBinding {
  assertRevisionBinding(input);
  assertSide((input as Record<string, unknown>)["side"]);
}

async function openBoundSnapshot(
  config: LocalSourceConfig,
  input: ConceptualReviewSourceRevisionBinding,
): Promise<RetainedSourceSnapshot> {
  assertRevisionBinding(input);
  const snapshot = await openRetainedSourceSnapshot(config, input);
  const { manifest, identity } = snapshot;
  if (
    manifest.base.commitObjectId !== input.expectedBaseCommitId ||
    manifest.head.commitObjectId !== input.expectedHeadCommitId ||
    identity.head.treeObjectId !== input.expectedHeadTreeId
  ) {
    throw new ConceptualReviewSourceError("revision_mismatch");
  }
  return snapshot;
}

export interface ConceptualReviewSourceText extends GitTreeEntry {
  status: "available";
  side: "base" | "head";
  commitId: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  hasFinalNewline: boolean;
  lineEndings: Array<"lf" | "crlf" | "none">;
  text: string;
}

export interface ConceptualReviewSourceUnsupported extends GitTreeEntry {
  status: "unsupported";
  side: "base" | "head";
  commitId: string;
  reason: "binary" | "symlink" | "gitlink" | "git_lfs_pointer" | "directory";
}

export type ConceptualReviewSourceLines =
  ConceptualReviewSourceText | ConceptualReviewSourceUnsupported;

interface ConceptualReviewSourceLineRequest {
  side: "base" | "head";
  path: string;
  startLine: number;
  endLine: number;
}

interface ConceptualReviewSourceCatalogRequest {
  side: "base" | "head";
  offset?: number;
  limit?: number;
}

export interface ConceptualReviewSourceReader {
  readLines(input: ConceptualReviewSourceLineRequest): Promise<ConceptualReviewSourceLines>;
  readCatalog(input: ConceptualReviewSourceCatalogRequest): ConceptualReviewSourceCatalog;
  readChange(input: ConceptualReviewSourceLineRequest): Promise<ConceptualReviewSourceChange>;
}

export interface ConceptualReviewSourceChange {
  status: "added" | "modified" | "removed" | "unchanged";
  /** Null means the bounded diff could not classify this range. */
  rangeChanged: boolean | null;
}

const MAX_LINE_DIFF_CELLS = 1_000_000;

function sourceLines(bytes: Buffer): string[] | null {
  if (bytes.includes(0)) return null;
  try {
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  } catch {
    return null;
  }
}

function changedLineMaps(
  base: string[],
  head: string[],
): { base: Uint8Array; head: Uint8Array } | null {
  let prefix = 0;
  while (prefix < base.length && prefix < head.length && base[prefix] === head[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < base.length - prefix &&
    suffix < head.length - prefix &&
    base[base.length - suffix - 1] === head[head.length - suffix - 1]
  )
    suffix++;
  const baseMiddle = base.slice(prefix, base.length - suffix);
  const headMiddle = head.slice(prefix, head.length - suffix);
  const width = headMiddle.length + 1;
  const cells = (baseMiddle.length + 1) * width;
  if (!Number.isSafeInteger(cells) || cells > MAX_LINE_DIFF_CELLS) return null;
  const lengths = new Uint32Array(cells);
  for (let baseIndex = baseMiddle.length - 1; baseIndex >= 0; baseIndex--)
    for (let headIndex = headMiddle.length - 1; headIndex >= 0; headIndex--) {
      const index = baseIndex * width + headIndex;
      lengths[index] =
        baseMiddle[baseIndex] === headMiddle[headIndex]
          ? (lengths[(baseIndex + 1) * width + headIndex + 1] ?? 0) + 1
          : Math.max(
              lengths[(baseIndex + 1) * width + headIndex] ?? 0,
              lengths[baseIndex * width + headIndex + 1] ?? 0,
            );
    }
  const baseChanged = new Uint8Array(base.length);
  const headChanged = new Uint8Array(head.length);
  baseChanged.fill(1, prefix, base.length - suffix);
  headChanged.fill(1, prefix, head.length - suffix);
  let baseIndex = 0;
  let headIndex = 0;
  while (baseIndex < baseMiddle.length && headIndex < headMiddle.length) {
    if (baseMiddle[baseIndex] === headMiddle[headIndex]) {
      baseChanged[prefix + baseIndex] = 0;
      headChanged[prefix + headIndex] = 0;
      baseIndex++;
      headIndex++;
    } else if (
      (lengths[(baseIndex + 1) * width + headIndex] ?? 0) >=
      (lengths[baseIndex * width + headIndex + 1] ?? 0)
    )
      baseIndex++;
    else headIndex++;
  }
  return { base: baseChanged, head: headChanged };
}

function validPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path !== "" &&
    Buffer.byteLength(path, "utf8") <= 4096 &&
    !/[\p{Cc}\\]/u.test(path) &&
    !/^[a-z][a-z0-9+.-]*:/iu.test(path) &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

/**
 * Lines are 1-based and inclusive. LF ends a line; CRLF is a single terminator,
 * while a lone CR and a UTF-8 BOM remain source text. A final newline creates no
 * extra line. An empty file has zero lines and rejects every requested range.
 * Text retains the selected line terminators; nothing is normalized or truncated.
 */
function validateLineRequest(input: ConceptualReviewSourceLineRequest): void {
  assertSide(input.side);
  if (
    !validPath(input.path) ||
    !Number.isSafeInteger(input.startLine) ||
    !Number.isSafeInteger(input.endLine) ||
    input.startLine < 1 ||
    input.endLine < input.startLine
  ) {
    throw new ConceptualReviewSourceError("invalid_request");
  }
  if (input.endLine - input.startLine + 1 > 200)
    throw new ConceptualReviewSourceError("range_too_large");
}

/**
 * Opens one verified retained revision for a bounded batch of source reads.
 * The manifest and each referenced object are verified once per reader.
 */
export async function openConceptualReviewSourceReader(
  config: LocalSourceConfig,
  input: ConceptualReviewSourceRevisionBinding,
): Promise<ConceptualReviewSourceReader> {
  const snapshot = await openBoundSnapshot(config, input);
  const { manifest } = snapshot;
  const objects = new Map(manifest.objects.map((object) => [object.id, object]));
  const entries = {
    base: new Map(manifest.base.entries.map((entry) => [entry.path, entry])),
    head: new Map(manifest.head.entries.map((entry) => [entry.path, entry])),
  };
  const sortedEntries = {
    base: [...manifest.base.entries].sort((left, right) =>
      Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
    ),
    head: [...manifest.head.entries].sort((left, right) =>
      Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
    ),
  };
  const changes = new Map<
    string,
    Promise<{
      status: ConceptualReviewSourceChange["status"];
      lines: { base: Uint8Array; head: Uint8Array } | null;
    }>
  >();
  const changeFor = (path: string) => {
    const existing = changes.get(path);
    if (existing !== undefined) return existing;
    const pending = (async () => {
      const base = entries.base.get(path);
      const head = entries.head.get(path);
      if (base === undefined && head === undefined) throw new LocalSourceError("path_not_retained");
      if (base === undefined) return { status: "added" as const, lines: null };
      if (head === undefined) return { status: "removed" as const, lines: null };
      if (base.mode === head.mode && base.objectId === head.objectId && base.type === head.type)
        return { status: "unchanged" as const, lines: null };
      if (base.type !== "blob" || head.type !== "blob")
        return { status: "modified" as const, lines: null };
      const [baseBytes, headBytes] = await Promise.all([
        snapshot.readBlob(base.objectId),
        snapshot.readBlob(head.objectId),
      ]);
      const baseLines = sourceLines(baseBytes);
      const headLines = sourceLines(headBytes);
      return {
        status: "modified" as const,
        lines:
          baseLines === null || headLines === null ? null : changedLineMaps(baseLines, headLines),
      };
    })();
    changes.set(path, pending);
    return pending;
  };
  return {
    async readLines(request) {
      validateLineRequest(request);
      const entry = entries[request.side].get(request.path);
      if (entry === undefined) throw new LocalSourceError("path_not_retained");
      const identity = {
        ...entry,
        side: request.side,
        commitId: manifest[request.side].commitObjectId,
      };
      const unsupported = (
        reason: ConceptualReviewSourceUnsupported["reason"],
      ): ConceptualReviewSourceUnsupported => ({ ...identity, status: "unsupported", reason });
      if (entry.mode === "120000") return unsupported("symlink");
      if (entry.type === "commit") return unsupported("gitlink");
      if (entry.type === "tree") return unsupported("directory");
      const object = objects.get(entry.objectId);
      if (object?.type !== "blob") throw new LocalSourceError("object_verification_failed");
      if (object.size > 512 * 1024) throw new ConceptualReviewSourceError("file_too_large");
      const bytes = await snapshot.readBlob(entry.objectId);
      if (bytes.includes(0)) return unsupported("binary");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new ConceptualReviewSourceError("invalid_utf8");
      }
      if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/u.test(content))
        return unsupported("git_lfs_pointer");
      const lines = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
      if (request.endLine > lines.length)
        throw new ConceptualReviewSourceError("range_out_of_bounds", lines.length);
      const selected = lines.slice(request.startLine - 1, request.endLine);
      const result: ConceptualReviewSourceText = {
        ...identity,
        status: "available",
        startLine: request.startLine,
        endLine: request.endLine,
        totalLines: lines.length,
        hasFinalNewline: content.endsWith("\n"),
        lineEndings: selected.map((line) =>
          line.endsWith("\r\n") ? "crlf" : line.endsWith("\n") ? "lf" : "none",
        ),
        text: selected.join(""),
      };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > 32 * 1024)
        throw new ConceptualReviewSourceError("response_too_large");
      return result;
    },
    readCatalog(request) {
      assertSide(request.side);
      const offset = request.offset === undefined ? 0 : request.offset;
      const limit = request.limit === undefined ? 200 : request.limit;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 200
      )
        throw new ConceptualReviewSourceError("invalid_request");
      const sideEntries = sortedEntries[request.side];
      const page = sideEntries.slice(offset, offset + limit);
      return {
        side: request.side,
        commitId: manifest[request.side].commitObjectId,
        entries: page,
        offset,
        total: sideEntries.length,
        nextOffset: offset + page.length < sideEntries.length ? offset + page.length : null,
      };
    },
    async readChange(request) {
      validateLineRequest(request);
      const change = await changeFor(request.path);
      if (change.status === "added")
        return { status: change.status, rangeChanged: request.side === "head" };
      if (change.status === "removed")
        return { status: change.status, rangeChanged: request.side === "base" };
      if (change.status === "unchanged") return { status: change.status, rangeChanged: false };
      const changed = change.lines?.[request.side];
      if (changed === undefined || request.endLine > changed.length)
        return { status: change.status, rangeChanged: null };
      return {
        status: change.status,
        rangeChanged: changed.slice(request.startLine - 1, request.endLine).includes(1),
      };
    },
  };
}

export async function readConceptualReviewSourceLines(
  config: LocalSourceConfig,
  input: ConceptualReviewSourceBinding & { path: string; startLine: number; endLine: number },
): Promise<ConceptualReviewSourceLines> {
  assertBinding(input);
  const reader = await openConceptualReviewSourceReader(config, input);
  return reader.readLines(input);
}

export async function readConceptualReviewSourceCatalog(
  config: LocalSourceConfig,
  input: ConceptualReviewSourceBinding & { offset?: number; limit?: number },
): Promise<ConceptualReviewSourceCatalog> {
  assertBinding(input);
  const reader = await openConceptualReviewSourceReader(config, input);
  return reader.readCatalog(input);
}
