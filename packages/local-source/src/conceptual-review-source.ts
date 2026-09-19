import {
  readRetainedFile,
  readRetainedRevisionIdentity,
  readRetainedSourceManifest,
} from "./artifact.js";
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

function assertBinding(input: unknown): asserts input is ConceptualReviewSourceBinding {
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
    !validCommitId(request["expectedHeadTreeId"]) ||
    (request["side"] !== "base" && request["side"] !== "head")
  ) {
    throw new ConceptualReviewSourceError("invalid_request");
  }
}

async function readBoundManifest(config: LocalSourceConfig, input: ConceptualReviewSourceBinding) {
  const [manifest, identity] = await Promise.all([
    readRetainedSourceManifest(config, input),
    readRetainedRevisionIdentity(config, input),
  ]);
  if (
    manifest.base.commitObjectId !== input.expectedBaseCommitId ||
    manifest.head.commitObjectId !== input.expectedHeadCommitId ||
    identity.head.treeObjectId !== input.expectedHeadTreeId
  ) {
    throw new ConceptualReviewSourceError("revision_mismatch");
  }
  return manifest;
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
export async function readConceptualReviewSourceLines(
  config: LocalSourceConfig,
  input: ConceptualReviewSourceBinding & { path: string; startLine: number; endLine: number },
): Promise<ConceptualReviewSourceLines> {
  assertBinding(input);
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
  const manifest = await readBoundManifest(config, input);
  const entry = manifest[input.side].entries.find(({ path }) => path === input.path);
  if (entry === undefined) throw new LocalSourceError("path_not_retained");
  const identity = { ...entry, side: input.side, commitId: manifest[input.side].commitObjectId };
  const unsupported = (
    reason: ConceptualReviewSourceUnsupported["reason"],
  ): ConceptualReviewSourceUnsupported => ({
    ...identity,
    status: "unsupported",
    reason,
  });
  if (entry.mode === "120000") return unsupported("symlink");
  if (entry.type === "commit") return unsupported("gitlink");
  if (entry.type === "tree") return unsupported("directory");
  const object = manifest.objects.find(({ id }) => id === entry.objectId);
  if (object?.type !== "blob") throw new LocalSourceError("object_verification_failed");
  if (object.size > 512 * 1024) throw new ConceptualReviewSourceError("file_too_large");
  const bytes = await readRetainedFile(config, input);
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
  if (input.endLine > lines.length)
    throw new ConceptualReviewSourceError("range_out_of_bounds", lines.length);
  const selected = lines.slice(input.startLine - 1, input.endLine);
  const result: ConceptualReviewSourceText = {
    ...identity,
    status: "available",
    startLine: input.startLine,
    endLine: input.endLine,
    totalLines: lines.length,
    hasFinalNewline: content.endsWith("\n"),
    lineEndings: selected.map((line) =>
      line.endsWith("\r\n") ? "crlf" : line.endsWith("\n") ? "lf" : "none",
    ),
    text: selected.join(""),
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 32 * 1024) {
    throw new ConceptualReviewSourceError("response_too_large");
  }
  return result;
}

export async function readConceptualReviewSourceCatalog(
  config: LocalSourceConfig,
  input: ConceptualReviewSourceBinding & { offset?: number; limit?: number },
): Promise<ConceptualReviewSourceCatalog> {
  assertBinding(input);
  const offset = input.offset === undefined ? 0 : input.offset;
  const limit = input.limit === undefined ? 200 : input.limit;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200
  ) {
    throw new ConceptualReviewSourceError("invalid_request");
  }
  const manifest = await readBoundManifest(config, input);
  const entries = [...manifest[input.side].entries].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
  );
  const page = entries.slice(offset, offset + limit);
  return {
    side: input.side,
    commitId: manifest[input.side].commitObjectId,
    entries: page,
    offset,
    total: entries.length,
    nextOffset: offset + page.length < entries.length ? offset + page.length : null,
  };
}
