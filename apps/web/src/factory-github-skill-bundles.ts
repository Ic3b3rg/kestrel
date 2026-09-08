import { createHash } from "node:crypto";
import { posix } from "node:path";

import { z } from "zod";

import { runFactoryGitHubCli } from "./factory-github-cli.js";
import { GRILLING_STARTER, GRILLING_STARTER_ADAPTATION } from "./factory-skill-composition.js";
import {
  entryMetadata,
  FactorySkillBundleError,
  instructionProse,
  markdownReferences,
  referencePath,
  rejectRequiredExecution,
} from "./factory-skill-bundles.js";

export interface GitHubSkillSourceRequest {
  owner: string;
  repository: string;
  path: string;
  ref: string;
}

export interface GitHubSkillBundle {
  name: string;
  description: string;
  contentDigest: string;
  files: Array<{ path: string; content: string }>;
  source: {
    kind: "github";
    label: string;
    candidateId: string;
    owner: string;
    repository: string;
    path: string;
    requestedRef: string;
    commitId: string;
  };
}

export interface GitHubSkillReaderOptions {
  executable?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  run?: typeof runFactoryGitHubCli;
}

const MAX_BYTES = 128 * 1024;
const MAX_FILES = 32;
const MANIFEST_PATH = ".kestrel/source.json";
const objectId = z.string().regex(/^[a-f0-9]{40}$/u);
const commitResponse = z.object({
  sha: objectId,
  commit: z.object({ tree: z.object({ sha: objectId }) }),
});
const treeResponse = z.object({
  sha: objectId,
  truncated: z.literal(false),
  tree: z
    .array(
      z.object({
        path: z.string().min(1).max(512),
        mode: z.string(),
        type: z.enum(["blob", "tree", "commit"]),
        sha: objectId,
        size: z.number().int().min(0).optional(),
      }),
    )
    .max(4096),
});
const blobResponse = z.object({
  sha: objectId,
  encoding: z.literal("base64"),
  size: z.number().int().min(0).max(MAX_BYTES),
  content: z.string().max(MAX_BYTES * 2),
});
const messages = {
  invalid_source: "Choose a GitHub owner, repository, relative SKILL.md path and explicit ref.",
  source_unavailable:
    "The GitHub source or ref is unavailable. Check the repository, ref and host GitHub access.",
  needs_authentication: "Sign in to GitHub on the host, then preview this Skill again.",
  access_denied:
    "The host GitHub account cannot read this source. Check repository access and try again.",
  account_changed:
    "The host GitHub account changed during import. Preview the Skill again with the intended account.",
  rate_limited: "GitHub limited this read. Wait for provider access to recover and preview again.",
  provider_unavailable:
    "The host GitHub reader is unavailable. Check GitHub CLI access and preview again.",
  invalid_response:
    "GitHub returned incomplete or inconsistent Skill source. Preview the source again.",
  timeout: "The GitHub Skill read timed out. Preview the source again.",
  cancelled: "The GitHub Skill read was cancelled. Preview again when ready.",
  missing_dependency:
    "This Skill requires another named Skill. Import a complete supported starter instead.",
  unsupported_dependency:
    "This Skill uses an unsupported Skill dependency declaration. Choose a supported starter or a self-contained Skill.",
  reserved_path:
    "The Skill uses Kestrel's reserved source-manifest path. Choose a source without that path.",
} as const;

export class FactoryGitHubSkillBundleError extends Error {
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "FactoryGitHubSkillBundleError";
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new FactoryGitHubSkillBundleError("invalid_response");
  return result.data;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !/[\\:]/u.test(path) &&
    !hasControlCharacters(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function sourceRequest(input: GitHubSkillSourceRequest): GitHubSkillSourceRequest {
  if (
    !/^[a-z0-9][a-z0-9-]{0,38}$/iu.test(input.owner) ||
    !/^[a-z0-9_.-]{1,100}$/iu.test(input.repository) ||
    [".", ".."].includes(input.repository) ||
    !validPath(input.path) ||
    posix.basename(input.path) !== "SKILL.md" ||
    !input.ref.trim() ||
    input.ref !== input.ref.trim() ||
    input.ref.length > 255 ||
    hasControlCharacters(input.ref)
  )
    throw new FactoryGitHubSkillBundleError("invalid_source");
  return { ...input, owner: input.owner.toLowerCase(), repository: input.repository.toLowerCase() };
}

function providerError(result: Awaited<ReturnType<typeof runFactoryGitHubCli>>): never {
  if (result.failure === "cancelled" || result.failure === "timeout")
    throw new FactoryGitHubSkillBundleError(result.failure);
  if (result.failure === "invalid_response")
    throw new FactoryGitHubSkillBundleError("invalid_response");
  if (result.exitCode === 4 || /auth login|HTTP 401/iu.test(result.stderr))
    throw new FactoryGitHubSkillBundleError("needs_authentication");
  if (/rate limit|HTTP 429/iu.test(result.stderr))
    throw new FactoryGitHubSkillBundleError("rate_limited");
  if (/HTTP 403/iu.test(result.stderr)) throw new FactoryGitHubSkillBundleError("access_denied");
  if (/HTTP 404/iu.test(result.stderr))
    throw new FactoryGitHubSkillBundleError("source_unavailable");
  throw new FactoryGitHubSkillBundleError("provider_unavailable");
}

interface RetainedSourceFile {
  path: string;
  content: string;
  sourcePath: string | null;
  blobId: string | null;
}

async function pinnedRepository(
  request: GitHubSkillSourceRequest,
  options: GitHubSkillReaderOptions,
) {
  const run = options.run ?? runFactoryGitHubCli;
  let reads = 0;
  const read = async (endpoint: string): Promise<unknown> => {
    if (options.signal?.aborted) throw new FactoryGitHubSkillBundleError("cancelled");
    if (++reads > 128) throw new FactorySkillBundleError("bundle_limit");
    let result: Awaited<ReturnType<typeof runFactoryGitHubCli>>;
    try {
      result = await run({
        executable: options.executable ?? process.env.KESTREL_GH_EXECUTABLE ?? "gh",
        args: ["api", "--hostname", "github.com", endpoint, "--method", "GET"],
        timeoutMs: options.timeoutMs ?? 10_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch {
      throw new FactoryGitHubSkillBundleError(
        options.signal?.aborted ? "cancelled" : "provider_unavailable",
      );
    }
    if (result.failure !== undefined || result.exitCode !== 0) providerError(result);
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new FactoryGitHubSkillBundleError("invalid_response");
    }
  };
  const account = async () =>
    parse(z.object({ login: z.string().min(1).max(100) }), await read("/user")).login;
  const originalAccount = await account();
  const base = `/repos/${request.owner}/${request.repository}`;
  const commit = parse(
    commitResponse,
    await read(`${base}/commits/${encodeURIComponent(request.ref)}`),
  );
  if (/^[a-f0-9]{40}$/iu.test(request.ref) && commit.sha !== request.ref.toLowerCase())
    throw new FactoryGitHubSkillBundleError("invalid_response");
  const trees = new Map<string, z.infer<typeof treeResponse>>();
  const readTree = async (id: string) => {
    let tree = trees.get(id);
    if (tree === undefined) {
      tree = parse(treeResponse, await read(`${base}/git/trees/${id}`));
      if (tree.sha !== id || new Set(tree.tree.map(({ path }) => path)).size !== tree.tree.length)
        throw new FactoryGitHubSkillBundleError("invalid_response");
      trees.set(id, tree);
    }
    return tree;
  };
  return {
    commitId: commit.sha,
    async confirmAccount() {
      if ((await account()) !== originalAccount)
        throw new FactoryGitHubSkillBundleError("account_changed");
    },
    async readFile(
      sourcePath: string,
      remaining: number,
    ): Promise<{ content: string; blobId: string }> {
      if (!validPath(sourcePath)) throw new FactorySkillBundleError("unsafe_path");
      const parts = sourcePath.split("/");
      let treeId = commit.commit.tree.sha;
      for (const [index, part] of parts.entries()) {
        const entry = (await readTree(treeId)).tree.find(({ path }) => path === part);
        if (entry === undefined) throw new FactorySkillBundleError("missing_reference");
        if (index < parts.length - 1) {
          if (entry.mode !== "040000" || entry.type !== "tree")
            throw new FactorySkillBundleError("unsafe_path");
          treeId = entry.sha;
          continue;
        }
        if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
          throw new FactorySkillBundleError("unsafe_path");
        if (entry.size === undefined) throw new FactoryGitHubSkillBundleError("invalid_response");
        if (entry.size > remaining) throw new FactorySkillBundleError("bundle_limit");
        const blob = parse(blobResponse, await read(`${base}/git/blobs/${entry.sha}`));
        const encoded = blob.content.replace(/[\r\n]/gu, "");
        const bytes = Buffer.from(encoded, "base64");
        if (
          blob.sha !== entry.sha ||
          blob.size !== entry.size ||
          bytes.length !== entry.size ||
          bytes.toString("base64") !== encoded ||
          createHash("sha1")
            .update(`blob ${String(bytes.length)}\0`)
            .update(bytes)
            .digest("hex") !== entry.sha
        )
          throw new FactoryGitHubSkillBundleError("invalid_response");
        try {
          return {
            content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
            blobId: entry.sha,
          };
        } catch {
          throw new FactorySkillBundleError("unreadable_file");
        }
      }
      throw new FactorySkillBundleError("missing_reference");
    },
  };
}

function requiredSkills(prose: string): string[] {
  const names = new Set<string>();
  for (const sentence of prose.split(/[.!?]\s+|\n/u)) {
    const call = /\bcall the Skill tool\b/iu.exec(sentence);
    if (
      call === null ||
      /\b(?:not|never|avoid|without|don't|optional(?:ly)?|example|may)\b/iu.test(
        sentence.slice(0, call.index),
      )
    )
      continue;
    const targets = sentence.slice(call.index + call[0].length).trim();
    const one = /^(?:with|for) "([a-z0-9]+(?:-[a-z0-9]+)*)"\.?$/u.exec(targets);
    const two =
      /^twice, for "([a-z0-9]+(?:-[a-z0-9]+)*)" and "([a-z0-9]+(?:-[a-z0-9]+)*)"\.?$/u.exec(
        targets,
      );
    const values = one === null ? two?.slice(1) : one.slice(1);
    if (values === undefined) throw new FactoryGitHubSkillBundleError("unsupported_dependency");
    for (const name of values) names.add(name);
  }
  return [...names];
}

interface SkillClosure {
  name: string;
  description: string;
  files: RetainedSourceFile[];
  dependencies: string[];
}

async function readSkill(
  repository: Awaited<ReturnType<typeof pinnedRepository>>,
  entryPath: string,
  allowedSkills: ReadonlySet<string> = new Set(),
  budget = { bytes: MAX_BYTES, files: MAX_FILES - 1 },
): Promise<SkillClosure> {
  const retained = new Map<string, RetainedSourceFile>();
  const pending = ["SKILL.md"];
  const dependencies = new Set<string>();
  let metadata: ReturnType<typeof entryMetadata> | undefined;
  while (pending.length > 0) {
    const path = pending.shift();
    if (path === undefined || retained.has(path)) continue;
    if (path === MANIFEST_PATH) throw new FactoryGitHubSkillBundleError("reserved_path");
    if (budget.files === 0) throw new FactorySkillBundleError("bundle_limit");
    const sourcePath = posix.join(posix.dirname(entryPath), path);
    const file = await repository.readFile(sourcePath, budget.bytes);
    budget.bytes -= Buffer.byteLength(file.content);
    budget.files -= 1;
    retained.set(path, { path, sourcePath, ...file });
    if (path === "SKILL.md") metadata = entryMetadata(file.content);
    const prose = instructionProse(file.content);
    rejectRequiredExecution(prose);
    for (const name of requiredSkills(prose)) {
      if (!allowedSkills.has(name)) throw new FactoryGitHubSkillBundleError("missing_dependency");
      dependencies.add(name);
    }
    for (const reference of markdownReferences(prose)) {
      const target = referencePath(path, reference.target, reference.required);
      if (target !== null && !retained.has(target) && !pending.includes(target))
        pending.push(target);
    }
    if (pending.length > budget.files) throw new FactorySkillBundleError("bundle_limit");
  }
  if (metadata === undefined) throw new FactorySkillBundleError("invalid_skill");
  return { ...metadata, files: [...retained.values()], dependencies: [...dependencies] };
}

function retainedBundle(
  request: GitHubSkillSourceRequest,
  commitId: string,
  skill: Pick<SkillClosure, "name" | "description" | "files">,
  composition?: {
    name: string;
    version: number;
    skills: Array<{ name: string; path: string; dependsOn: string[]; contentDigest: string }>;
    license: { author: string; identifier: string; path: string };
  },
): GitHubSkillBundle {
  const source: GitHubSkillBundle["source"] = {
    kind: "github",
    label: `${request.owner}/${request.repository}`,
    candidateId: createHash("sha256")
      .update(
        JSON.stringify([
          "github",
          request.owner,
          request.repository,
          request.path,
          composition?.name ?? null,
        ]),
      )
      .digest("hex"),
    owner: request.owner,
    repository: request.repository,
    path: request.path,
    requestedRef: request.ref,
    commitId,
  };
  const sourceFiles = skill.files.toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  if (sourceFiles.some(({ path }) => path === MANIFEST_PATH))
    throw new FactoryGitHubSkillBundleError("reserved_path");
  const files = [
    {
      path: MANIFEST_PATH,
      content:
        JSON.stringify(
          {
            schemaVersion: 1,
            author: "Kestrel",
            source,
            ...(composition === undefined ? {} : { composition }),
            files: sourceFiles.map(({ path, sourcePath, blobId }) => ({
              path,
              sourcePath,
              blobId,
            })),
          },
          null,
          2,
        ) + "\n",
    },
    ...sourceFiles.map(({ path, content }) => ({ path, content })),
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (
    files.length > MAX_FILES ||
    new Set(files.map(({ path }) => path)).size !== files.length ||
    files.some(({ path }) => !validPath(path)) ||
    files.reduce((sum, { content }) => sum + Buffer.byteLength(content), 0) > MAX_BYTES
  )
    throw new FactorySkillBundleError("bundle_limit");
  return {
    name: skill.name,
    description: skill.description,
    source,
    files,
    contentDigest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}

export async function loadGitHubSkillBundle(
  source: GitHubSkillSourceRequest,
  options: GitHubSkillReaderOptions = {},
): Promise<GitHubSkillBundle> {
  const request = sourceRequest(source);
  const repository = await pinnedRepository(request, options);
  const skill = await readSkill(repository, request.path);
  const result = retainedBundle(request, repository.commitId, skill);
  await repository.confirmAccount();
  return result;
}

export async function loadGitHubPlanningStarter(
  options: GitHubSkillReaderOptions = {},
): Promise<GitHubSkillBundle> {
  const request = sourceRequest(GRILLING_STARTER.source);
  const repository = await pinnedRepository(request, options);
  const files: RetainedSourceFile[] = [
    { path: "SKILL.md", content: GRILLING_STARTER_ADAPTATION, sourcePath: null, blobId: null },
  ];
  const budget = {
    bytes: MAX_BYTES - Buffer.byteLength(GRILLING_STARTER_ADAPTATION),
    files: MAX_FILES - 2,
  };
  const allowed = new Set(GRILLING_STARTER.skills.map(({ name }) => name));
  const skills = [];
  for (const expected of GRILLING_STARTER.skills) {
    const skill = await readSkill(repository, expected.path, allowed, budget);
    if (
      skill.name !== expected.name ||
      JSON.stringify(skill.dependencies) !== JSON.stringify(expected.dependsOn)
    )
      throw new FactoryGitHubSkillBundleError("missing_dependency");
    const originals = skill.files
      .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map(({ path, content }) => ({ path, content }));
    skills.push({
      name: skill.name,
      path: expected.path,
      dependsOn: skill.dependencies,
      contentDigest: createHash("sha256").update(JSON.stringify(originals)).digest("hex"),
    });
    files.push(
      ...skill.files.map((file) => ({ ...file, path: `sources/${file.sourcePath ?? ""}` })),
    );
  }
  if (budget.files === 0) throw new FactorySkillBundleError("bundle_limit");
  const license = await repository.readFile("LICENSE", budget.bytes);
  files.push({ ...license, sourcePath: "LICENSE", path: "sources/LICENSE" });
  const result = retainedBundle(
    request,
    repository.commitId,
    { name: GRILLING_STARTER.name, description: GRILLING_STARTER.description, files },
    {
      name: GRILLING_STARTER.name,
      version: GRILLING_STARTER.version,
      skills,
      license: { author: "Matt Pocock", identifier: "MIT", path: "sources/LICENSE" },
    },
  );
  await repository.confirmAccount();
  return result;
}
