import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createPlanningSkillGitHubFixture } from "./planning-skill-github-fixture.js";
import {
  loadGitHubPlanningStarter,
  loadGitHubSkillBundle,
} from "../../../apps/web/src/factory-github-skill-bundles.js";

const exec = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

it("serves the exact starter closure through the real gh subprocess boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-planning-skill-provider-"));
  temporary.push(directory);
  const statePath = join(directory, "state.json");
  const fixture = await createPlanningSkillGitHubFixture(statePath);
  const executable = join(directory, "gh");
  await writeFile(executable, fixture.githubFixture, { mode: 0o755 });
  const starter = await loadGitHubPlanningStarter({ executable });
  expect(starter.source.commitId).toBe(fixture.originalCommit);
  expect(starter.files).toHaveLength(10);
  for (const [path, content] of Object.entries(fixture.originals))
    expect(starter.files.find((file) => file.path === `sources/${path}`)?.content).toBe(content);
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    calls: Array<{ method: string; endpoint: string }>;
  };
  expect(state.calls.filter(({ endpoint }) => endpoint.includes("/commits/"))).toHaveLength(1);
  expect(state.calls.every(({ method }) => method === "GET")).toBe(true);
  const root = await exec(process.execPath, [
    executable,
    "api",
    "--hostname",
    "github.com",
    `/repos/mattpocock/skills/git/trees/${fixture.originalTree}`,
    "--method",
    "GET",
  ]);
  const tree = JSON.parse(root.stdout) as {
    sha: string;
    tree: Array<{ mode: string; path: string; sha: string }>;
  };
  const raw = Buffer.concat(
    tree.tree.flatMap((entry) => [
      Buffer.from(`${entry.mode === "040000" ? "40000" : entry.mode} ${entry.path}\0`),
      Buffer.from(entry.sha, "hex"),
    ]),
  );
  const treePath = join(directory, "tree");
  await writeFile(treePath, raw);
  const hashed = await exec("/usr/bin/git", ["hash-object", "-t", "tree", treePath]);
  expect(hashed.stdout.trim()).toBe(tree.sha);
});

it("moves only the mutable ref while retained tree reads keep their original contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-planning-skill-provider-"));
  temporary.push(directory);
  const statePath = join(directory, "state.json");
  const fixture = await createPlanningSkillGitHubFixture(statePath);
  const executable = join(directory, "gh");
  await writeFile(executable, fixture.githubFixture, { mode: 0o755 });
  await writeFile(statePath, JSON.stringify({ controls: { advanceOnResolve: true }, calls: [] }));
  const source = {
    owner: "mattpocock",
    repository: "skills",
    path: "skills/engineering/domain-modeling/SKILL.md",
    ref: "main",
  };
  const first = await loadGitHubSkillBundle(source, { executable });
  const second = await loadGitHubSkillBundle(source, { executable });
  expect(first.source.commitId).toBe(fixture.originalCommit);
  expect(second.source.commitId).toBe(fixture.updatedCommit);
  expect(first.files.find(({ path }) => path === "CONTEXT-FORMAT.md")?.content).toBe(
    fixture.originals["skills/engineering/domain-modeling/CONTEXT-FORMAT.md"],
  );
  expect(second.files.find(({ path }) => path === "CONTEXT-FORMAT.md")?.content).toContain(
    "Fixture revision two.",
  );
  expect(first.contentDigest).not.toBe(second.contentDigest);
});

it("exposes actionable auth and missing-reference failures and rejects write commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-planning-skill-provider-"));
  temporary.push(directory);
  const statePath = join(directory, "state.json");
  const fixture = await createPlanningSkillGitHubFixture(statePath);
  const executable = join(directory, "gh");
  await writeFile(executable, fixture.githubFixture, { mode: 0o755 });
  await writeFile(statePath, JSON.stringify({ controls: { auth: true }, calls: [] }));
  await expect(loadGitHubPlanningStarter({ executable })).rejects.toMatchObject({
    code: "needs_authentication",
  });
  await writeFile(statePath, JSON.stringify({ controls: {}, calls: [] }));
  await expect(
    loadGitHubSkillBundle(
      {
        owner: "mattpocock",
        repository: "skills",
        path: "skills/engineering/domain-modeling/SKILL.md",
        ref: "missing-reference",
      },
      { executable },
    ),
  ).rejects.toMatchObject({ code: "missing_reference" });
  await expect(
    exec(process.execPath, [
      executable,
      "api",
      "--hostname",
      "github.com",
      "/repos/mattpocock/skills/issues",
      "--method",
      "POST",
    ]),
  ).rejects.toMatchObject({ code: 1, stderr: "gh: HTTP 405\n" });
});
