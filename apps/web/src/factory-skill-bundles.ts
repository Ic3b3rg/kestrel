import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";

import { JSON_SCHEMA, load } from "js-yaml";

export interface HostSkillCandidate {
  candidateId: string;
  label: string;
}

export interface HostSkillBundle {
  name: string;
  description: string;
  contentDigest: string;
  files: Array<{ path: string; content: string }>;
  source: { kind: "host"; label: string; candidateId: string };
}

const messages = {
  root_unavailable: "Configure an available absolute Skill directory before importing a Skill.",
  candidate_limit:
    "The Skill directory contains too many entries. Authorize a smaller directory with at most 256 entries.",
  unsafe_path: "Skill paths must stay inside the authorized directory without symbolic links.",
  candidate_not_found:
    "This Skill candidate is unavailable. Refresh the authorized directory and select it again.",
  invalid_skill:
    "The Skill needs valid YAML name and description fields followed by Markdown instructions.",
  missing_reference:
    "A required Markdown file is missing. Restore the referenced file inside this Skill and import it again.",
  unreadable_file:
    "Every Skill file must be a readable, unchanged regular UTF-8 text file. Check the source files and import again.",
  invalid_reference:
    "A Skill reference is malformed. Use a relative Markdown link inside the Skill directory.",
  bundle_limit:
    "The Skill exceeds 32 files or 128 KiB. Reduce its required Markdown content before importing.",
  unsupported_execution:
    "This Skill requires running a local script or command. Choose a procedure that works from supplied Markdown during planning.",
  unsupported_reference:
    "This Skill requires a non-Markdown local reference. Supply its required instructions as Markdown inside the Skill directory.",
} as const;

const MAX_BUNDLE_BYTES = 128 * 1024;
const MAX_BUNDLE_FILES = 32;

export class FactorySkillBundleError extends Error {
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "FactorySkillBundleError";
  }
}

export async function loadHostSkillBundle(
  authorizedRoot: string,
  candidateId: string,
): Promise<HostSkillBundle> {
  const root = await canonicalRoot(authorizedRoot);
  const candidate = (await enumerateHostSkillCandidates(root)).find(
    (entry) => entry.candidateId === candidateId,
  );
  if (candidate === undefined) throw new FactorySkillBundleError("candidate_not_found");
  const retained = new Map<string, string>();
  const pending = ["SKILL.md"];
  let remaining = MAX_BUNDLE_BYTES;
  let metadata: { name: string; description: string } | undefined;
  while (pending.length > 0) {
    const path = pending.shift();
    if (path === undefined || retained.has(path)) continue;
    if (retained.size >= MAX_BUNDLE_FILES) throw new FactorySkillBundleError("bundle_limit");
    const content = await readBoundedText(root, `${candidate.label}/${path}`, remaining);
    remaining -= Buffer.byteLength(content);
    retained.set(path, content);
    if (path === "SKILL.md") metadata = entryMetadata(content);
    const prose = instructionProse(content);
    rejectRequiredExecution(prose);
    for (const reference of markdownReferences(prose)) {
      const target = referencePath(path, reference.target, reference.required);
      if (target !== null && !retained.has(target) && !pending.includes(target)) {
        if (retained.size + pending.length >= MAX_BUNDLE_FILES)
          throw new FactorySkillBundleError("bundle_limit");
        pending.push(target);
      }
    }
  }
  if (metadata === undefined) throw new FactorySkillBundleError("invalid_skill");
  const files = [...retained.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, content]) => ({ path, content }));
  return {
    ...metadata,
    files,
    contentDigest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    source: { kind: "host", label: candidate.label, candidateId },
  };
}

export function referencePath(from: string, reference: string, required: boolean): string | null {
  if (/^file:|^[a-z]:[\\/]/iu.test(reference)) throw new FactorySkillBundleError("unsafe_path");
  if (
    reference.startsWith("#") ||
    reference.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/iu.test(reference)
  )
    return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference.split("#")[0] ?? "");
  } catch {
    throw new FactorySkillBundleError("invalid_reference");
  }
  for (const character of decoded) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) throw new FactorySkillBundleError("unsafe_path");
  }
  if (decoded.includes("\\") || decoded.includes(":") || posix.isAbsolute(decoded))
    throw new FactorySkillBundleError("unsafe_path");
  const target = posix.normalize(posix.join(posix.dirname(from), decoded));
  if (target === ".." || target.startsWith("../")) throw new FactorySkillBundleError("unsafe_path");
  if (target.length > 512) throw new FactorySkillBundleError("invalid_reference");
  if (!target.toLowerCase().endsWith(".md")) {
    if (required) throw new FactorySkillBundleError("unsupported_reference");
    return null;
  }
  return target;
}

async function fileMetadata(root: string, relativePath: string): Promise<Stats> {
  let path = root;
  const parts = relativePath.split("/");
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory())
    throw new FactorySkillBundleError("unsafe_path");
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new FactorySkillBundleError("unsafe_path");
    if (index === parts.length - 1) {
      if (!metadata.isFile()) throw new FactorySkillBundleError("unreadable_file");
      return metadata;
    }
    if (!metadata.isDirectory()) throw new FactorySkillBundleError("unreadable_file");
  }
  throw new FactorySkillBundleError("invalid_reference");
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readBoundedText(
  root: string,
  relativePath: string,
  remaining: number,
): Promise<string> {
  try {
    const before = await fileMetadata(root, relativePath);
    if (before.size > remaining) throw new FactorySkillBundleError("bundle_limit");
    const path = join(root, relativePath);
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        !sameFile(before, opened) ||
        !sameFile(opened, await fileMetadata(root, relativePath)) ||
        (await realpath(path)) !== path
      )
        throw new FactorySkillBundleError("unsafe_path");
      // Keep reads bounded even if the file grows after its metadata was checked.
      const bytes = Buffer.alloc(remaining + 1);
      let length = 0;
      while (length <= remaining) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > remaining) throw new FactorySkillBundleError("bundle_limit");
      if (!sameFile(opened, await handle.stat()) || length !== opened.size)
        throw new FactorySkillBundleError("unreadable_file");
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, length),
      );
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof FactorySkillBundleError) throw error;
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === "ENOENT") throw new FactorySkillBundleError("missing_reference");
      if (error.code === "ELOOP") throw new FactorySkillBundleError("unsafe_path");
    }
    throw new FactorySkillBundleError("unreadable_file");
  }
}

export function entryMetadata(content: string): { name: string; description: string } {
  const frontmatter = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/u.exec(
    content,
  );
  if (frontmatter?.[1] === undefined || !frontmatter[2]?.trim())
    throw new FactorySkillBundleError("invalid_skill");
  let metadata: unknown;
  try {
    metadata = load(frontmatter[1], { schema: JSON_SCHEMA });
  } catch {
    throw new FactorySkillBundleError("invalid_skill");
  }
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("name" in metadata) ||
    !("description" in metadata)
  )
    throw new FactorySkillBundleError("invalid_skill");
  const { name, description } = metadata;
  if (
    typeof name !== "string" ||
    name.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) ||
    typeof description !== "string" ||
    !description.trim() ||
    description.length > 1024
  )
    throw new FactorySkillBundleError("invalid_skill");
  return { name, description: description.trim() };
}

export function instructionProse(content: string): string {
  const body = content.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, "");
  let fence: string | undefined;
  return body
    .split(/\r?\n/u)
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
      if (fence !== undefined) {
        if (
          marker !== undefined &&
          marker[0] === fence[0] &&
          marker.length >= fence.length &&
          line.trim() === marker
        )
          fence = undefined;
        return "";
      }
      if (marker !== undefined) {
        fence = marker;
        return "";
      }
      return line;
    })
    .join("\n");
}

function negativeOrOptional(text: string): boolean {
  return /\b(?:not|never|avoid|without|don't|optional(?:ly)?|example)\b/iu.test(text);
}

export function rejectRequiredExecution(prose: string): void {
  for (const sentence of prose.split(/[.!?]\s+|\n/u)) {
    const action = /\b(?:run|execute|launch)\b/iu.exec(sentence);
    if (action === null) continue;
    const before = sentence.slice(0, action.index).replace(/^\s*(?:[-*+]\s+|\d+[.)]\s*)?/u, "");
    if (
      negativeOrOptional(before) ||
      /\bafter\s+(?:the\s+)?(?:plan\s+)?approval\b|\bafter\s+the\s+approved\s+implementation\b/iu.test(
        sentence,
      )
    )
      continue;
    const required =
      before.trim() === "" ||
      /\b(?:must|required|requires|before|first)\b|\bto use this skill\b/iu.test(before);
    const command = sentence.slice(action.index + action[0].length);
    if (
      required &&
      (/\b(?:commands?|scripts?|installers?|python3?|bash|zsh|sh|node|npm|pnpm|yarn|bun|deno|make|ruby|perl|pwsh|powershell)\b|\.[cm]?js\b|\.(?:py|sh|rb|pl|ps1|bat|exe)\b/iu.test(
        command,
      ) ||
        /`(?:\.{1,2}\/|[^`\n]+\s)[^`\n]*`/u.test(command))
    )
      throw new FactorySkillBundleError("unsupported_execution");
  }
}

/** Retain relative inline links and single-line reference links; examples and images are not dependencies. */
export function markdownReferences(prose: string): Array<{ target: string; required: boolean }> {
  const definitions = new Map<string, string>();
  const label = (value: string) => value.trim().replace(/\s+/gu, " ").toLowerCase();
  const text = prose
    .replace(/(`+)[\s\S]*?\1/gu, " ")
    .replace(
      /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^<>\n]+)>|(\S+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\)))?[ \t]*$/gmu,
      (_match, name: string, angled: string | undefined, bare: string | undefined) => {
        const target = angled ?? bare;
        if (target !== undefined && !definitions.has(label(name)))
          definitions.set(label(name), target);
        return "";
      },
    );
  const references: Array<{ target: string; required: boolean }> = [];
  const links =
    /(?<!!|\\)\[([^\]\n]+)\]\(\s*(?:<([^<>\n]+)>|([^\s)]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\)))?\s*\)|(?<!!|\\)\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/gu;
  for (const match of text.matchAll(links)) {
    let target = match[2] ?? match[3];
    if (target === undefined && match[4] !== undefined) {
      target = definitions.get(label(match[5] || match[4]));
      if (target === undefined && match[5] !== undefined)
        throw new FactorySkillBundleError("invalid_reference");
    }
    if (target === undefined) continue;
    const before =
      text
        .slice(text.lastIndexOf("\n", match.index - 1) + 1, match.index)
        .split(/[.!?]\s+/u)
        .at(-1) ?? "";
    references.push({
      target,
      required:
        !negativeOrOptional(before) &&
        /\b(?:read|load|follow|consult|use|must|required|requires)\b/iu.test(before),
    });
  }
  return references;
}

async function canonicalRoot(authorizedRoot: string): Promise<string> {
  if (!isAbsolute(authorizedRoot)) throw new FactorySkillBundleError("root_unavailable");
  try {
    const metadata = await lstat(authorizedRoot);
    if (metadata.isSymbolicLink()) throw new FactorySkillBundleError("unsafe_path");
    if (!metadata.isDirectory()) throw new FactorySkillBundleError("root_unavailable");
    return await realpath(authorizedRoot);
  } catch (error) {
    if (error instanceof FactorySkillBundleError) throw error;
    throw new FactorySkillBundleError("root_unavailable");
  }
}

export async function enumerateHostSkillCandidates(
  authorizedRoot: string,
): Promise<HostSkillCandidate[]> {
  const root = await canonicalRoot(authorizedRoot);
  try {
    const directory = await opendir(root, { bufferSize: 32 });
    const candidates: HostSkillCandidate[] = [];
    let entries = 0;
    for await (const entry of directory) {
      if (++entries > 256) throw new FactorySkillBundleError("candidate_limit");
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name);
      if (!(await lstat(path)).isDirectory()) continue;
      const skill = await lstat(join(path, "SKILL.md")).catch(() => null);
      if (skill === null || (!skill.isFile() && !skill.isSymbolicLink())) continue;
      candidates.push({
        candidateId: createHash("sha256")
          .update(JSON.stringify([root, entry.name]))
          .digest("hex"),
        label: entry.name,
      });
    }
    return candidates.sort((left, right) => left.label.localeCompare(right.label, "en"));
  } catch (error) {
    if (error instanceof FactorySkillBundleError) throw error;
    throw new FactorySkillBundleError("root_unavailable");
  }
}
