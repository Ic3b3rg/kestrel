import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { RunningStack } from "./compose.js";

export const PLANNING_SKILL_GITHUB_STATE_PATH = "/tmp/kestrel-planning-skill-github.json";
export const PLANNING_SKILL_COMMIT = "5c89081d4bbeb3d039a42093653f90bb698d780e";
export const DOMAIN_SKILL_PATH = "skills/engineering/domain-modeling/SKILL.md";
const upstreamPaths = [
  "LICENSE",
  "skills/engineering/grill-with-docs/SKILL.md",
  "skills/productivity/grilling/SKILL.md",
  DOMAIN_SKILL_PATH,
  "skills/engineering/domain-modeling/CONTEXT-FORMAT.md",
  "skills/engineering/domain-modeling/ADR-FORMAT.md",
  "skills/engineering/to-spec/SKILL.md",
  "skills/engineering/to-tickets/SKILL.md",
] as const;

export interface PlanningSkillGitHubControls {
  auth?: boolean;
  advanceOnResolve?: boolean;
  main?: "original" | "updated";
}
export interface PlanningSkillGitHubState {
  controls: PlanningSkillGitHubControls;
  calls: Array<{ args: string[]; method: string; endpoint: string }>;
}
interface TreeEntry {
  path: string;
  mode: "040000" | "100644";
  type: "tree" | "blob";
  sha: string;
  size?: number;
}

/** Eight exact upstream files; all provider responses stay inside this task-owned executable. */
export async function createPlanningSkillGitHubFixture(
  statePath = PLANNING_SKILL_GITHUB_STATE_PATH,
) {
  const originals: Record<string, string> = Object.fromEntries(
    await Promise.all(
      upstreamPaths.map(
        async (path) =>
          [
            path,
            await readFile(
              new URL(`../../fixtures/planning-skills/mattpocock/${path}`, import.meta.url),
              "utf8",
            ),
          ] as const,
      ),
    ),
  );
  const blobs: Record<string, { sha: string; encoding: "base64"; size: number; content: string }> =
    {};
  const trees: Record<string, { sha: string; truncated: false; tree: TreeEntry[] }> = {};
  const objectId = (kind: string, bytes: Buffer) =>
    createHash("sha1")
      .update(`${kind} ${String(bytes.length)}\0`)
      .update(bytes)
      .digest("hex");
  const treeFor = (files: Record<string, string>, prefix = ""): string => {
    const paths = Object.keys(files).filter((path) => path.startsWith(prefix));
    const names = [...new Set(paths.map((path) => path.slice(prefix.length).split("/")[0]))];
    const entries: TreeEntry[] = [];
    for (const name of names) {
      if (name === undefined) throw new Error("Fixture path has no filename");
      const path = `${prefix}${name}`;
      const content = files[path];
      if (content === undefined) {
        entries.push({ path: name, mode: "040000", type: "tree", sha: treeFor(files, `${path}/`) });
      } else {
        const bytes = Buffer.from(content);
        const sha = objectId("blob", bytes);
        blobs[sha] = {
          sha,
          encoding: "base64",
          size: bytes.length,
          content: bytes.toString("base64"),
        };
        entries.push({ path: name, mode: "100644", type: "blob", sha, size: bytes.length });
      }
    }
    entries.sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.path + (left.type === "tree" ? "/" : "")),
        Buffer.from(right.path + (right.type === "tree" ? "/" : "")),
      ),
    );
    const bytes = Buffer.concat(
      entries.flatMap((entry) => [
        Buffer.from(`${entry.mode === "040000" ? "40000" : entry.mode} ${entry.path}\0`),
        Buffer.from(entry.sha, "hex"),
      ]),
    );
    const sha = objectId("tree", bytes);
    trees[sha] = { sha, truncated: false, tree: entries };
    return sha;
  };
  const originalTree = treeFor(originals);
  const reference = "skills/engineering/domain-modeling/CONTEXT-FORMAT.md";
  const updatedTree = treeFor({
    ...originals,
    [reference]: `${originals[reference] ?? ""}\nFixture revision two.\n`,
  });
  const missingFiles = Object.fromEntries(
    Object.entries(originals).filter(([path]) => path !== reference),
  );
  const missingTree = treeFor(missingFiles);
  const commitFor = (tree: string, message: string) =>
    objectId(
      "commit",
      Buffer.from(
        `tree ${tree}\nparent ${PLANNING_SKILL_COMMIT}\nauthor Fixture <fixture@example.test> 1 +0000\ncommitter Fixture <fixture@example.test> 1 +0000\n\n${message}\n`,
      ),
    );
  const updatedCommit = commitFor(updatedTree, "Update the domain format");
  const missingReferenceCommit = commitFor(missingTree, "Remove a required reference");
  const commits = {
    [PLANNING_SKILL_COMMIT]: {
      sha: PLANNING_SKILL_COMMIT,
      commit: { tree: { sha: originalTree } },
    },
    [updatedCommit]: { sha: updatedCommit, commit: { tree: { sha: updatedTree } } },
    [missingReferenceCommit]: {
      sha: missingReferenceCommit,
      commit: { tree: { sha: missingTree } },
    },
  };
  const githubFixture = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const fixture = ${JSON.stringify({ blobs, trees, commits, original: PLANNING_SKILL_COMMIT, updated: updatedCommit, missing: missingReferenceCommit })};
const path = ${JSON.stringify(statePath)};
const lock = new DatabaseSync(path + ".sqlite");
lock.exec("PRAGMA busy_timeout = 5000; BEGIN EXCLUSIVE");
process.on("exit", () => lock.close());
const state = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : { controls: {}, calls: [] };
const args = process.argv.slice(2);
const endpoint = args.find(value => value.startsWith("/")) ?? "";
const methodIndex = args.indexOf("--method");
const method = methodIndex < 0 ? "GET" : args[methodIndex + 1];
state.calls.push({ args, endpoint, method });
function save() {
  fs.writeFileSync(path + ".next", JSON.stringify(state));
  fs.renameSync(path + ".next", path);
}
function output(status, body) {
  save();
  if (args.includes("--include")) process.stdout.write("HTTP/2.0 " + status + "\r\nContent-Type: application/json\r\n\r\n");
  process.stdout.write(JSON.stringify(body));
  if (status >= 400) process.stderr.write("gh: HTTP " + status + "\n");
  process.exit(status >= 400 ? 1 : 0);
}
if (args[0] === "version") { save(); process.stdout.write("gh version 2.86.0 (fixture)\n"); process.exit(0); }
if (method !== "GET") output(405, { message: "This fixture prohibits provider writes" });
if (state.controls.auth) output(401, { message: "Bad credentials" });
if (args[0] === "search") output(200, []);
if (args[0] !== "api" || args[args.indexOf("--hostname") + 1] !== "github.com") output(422, { message: "Unsupported provider command" });
if (endpoint === "/user") output(200, { login: "fixture" });
const uri = new URL(endpoint, "https://api.github.com");
const parts = uri.pathname.split("/").filter(Boolean).map(decodeURIComponent);
if (parts[0] !== "repos" || parts[1] !== "mattpocock" || parts[2] !== "skills") output(404, { message: "Not found" });
if (parts[3] === "commits" && parts.length === 5) {
  const ref = parts[4];
  const commitId = ref === "main" ? (state.controls.main === "updated" ? fixture.updated : fixture.original) : ref === "missing-reference" ? fixture.missing : ref;
  const commit = fixture.commits[commitId];
  if (!commit) output(404, { message: "Unknown ref" });
  if (ref === "main" && state.controls.advanceOnResolve) {
    state.controls.main = "updated";
    state.controls.advanceOnResolve = false;
  }
  output(200, commit);
}
if (parts[3] === "git" && parts.length === 6) {
  const object = parts[4] === "trees" ? fixture.trees[parts[5]] : parts[4] === "blobs" ? fixture.blobs[parts[5]] : null;
  if (object) output(200, object);
}
output(404, { message: "Not found" });
`;
  return {
    githubFixture,
    originals,
    originalCommit: PLANNING_SKILL_COMMIT,
    originalTree,
    updatedCommit,
    missingReferenceCommit,
  };
}

export async function readPlanningSkillGitHubState(
  stack: Pick<RunningStack, "executeWebModule">,
): Promise<PlanningSkillGitHubState> {
  return JSON.parse(
    await stack.executeWebModule(
      `import { readFile } from 'node:fs/promises'; console.log(await readFile(${JSON.stringify(PLANNING_SKILL_GITHUB_STATE_PATH)}, 'utf8'));`,
    ),
  ) as PlanningSkillGitHubState;
}

export async function setPlanningSkillGitHubControls(
  stack: Pick<RunningStack, "executeWebModule">,
  controls: PlanningSkillGitHubControls,
): Promise<void> {
  await stack.executeWebModule(
    `import { readFile, writeFile, rename } from 'node:fs/promises'; import { DatabaseSync } from 'node:sqlite'; const path=${JSON.stringify(PLANNING_SKILL_GITHUB_STATE_PATH)}; const lock=new DatabaseSync(path+'.sqlite'); lock.exec('PRAGMA busy_timeout = 5000; BEGIN EXCLUSIVE'); const state=await readFile(path,'utf8').then(JSON.parse).catch(() => ({calls:[],controls:{}})); state.controls=${JSON.stringify(controls)}; await writeFile(path+'.next',JSON.stringify(state)); await rename(path+'.next',path); lock.close();`,
  );
}
