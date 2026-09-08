import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createFactoryFeatureGitHubAdapter } from "../../../apps/web/src/factory-feature-github.js";
import { createFactoryGitHubAdapter } from "../../../apps/web/src/factory-github.js";
import { createFactoryFeaturePublicationFixture } from "./factory-feature-publication-fixture.js";

const exec = promisify(execFile);
const directories: string[] = [];
const identity = {
  repository: { id: "424242", owner: "Ic3b3rg", name: "kestrel" },
  account: "fixture",
};
interface ProviderState {
  controls: Record<string, unknown>;
  pullRequests: Array<{ number: number; base: { sha: string }; head: { sha: string } }>;
  calls: Array<{ method: string; endpoint: string; input: unknown }>;
  writes: Array<{ method: string; endpoint: string; input: unknown }>;
  gitCalls: Array<{ args: string[] }>;
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-feature-provider-fixture-"));
  directories.push(directory);
  const remotePath = join(directory, "remote.git");
  const statePath = join(directory, "provider.json");
  const executable = join(directory, "gh.cjs");
  const git = async (args: string[]) =>
    (
      await exec(
        "/usr/bin/git",
        ["-c", "core.hooksPath=/dev/null", "--git-dir=" + remotePath, ...args],
        {
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
          },
        },
      )
    ).stdout.trim();
  await git(["init", "--bare", "--initial-branch=main", remotePath]);
  const tree = await git(["hash-object", "-t", "tree", "-w", "/dev/null"]);
  const commit = (message: string, parents: string[] = []) =>
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit-tree",
      tree,
      ...parents.flatMap((parent) => ["-p", parent]),
      "-m",
      message,
    ]);
  const base = await commit("Approved base");
  const head = await commit("Certified cumulative head", [base]);
  await git(["update-ref", "refs/heads/main", base]);
  await git(["update-ref", "refs/heads/kestrel/feature/fixture", head]);
  await writeFile(
    executable,
    createFactoryFeaturePublicationFixture({ statePath, remotePath }).replace(
      "#!/usr/local/bin/node",
      "#!" + process.execPath,
    ),
    { mode: 0o755 },
  );
  await exec(process.execPath, [executable, "version"]);
  const state = async () => JSON.parse(await readFile(statePath, "utf8")) as ProviderState;
  const marker = "<!-- kestrel-feature-publication:v1:fixture -->";
  return {
    executable,
    base,
    head,
    git,
    commit,
    payload: {
      title: "One cumulative Feature",
      body: "Approved scope and final verification evidence\n\n" + marker,
      marker,
      baseRef: "main",
      headRef: "kestrel/feature/fixture",
      baseCommitId: base,
      headCommitId: head,
    },
    adapter: createFactoryFeatureGitHubAdapter({ executable }),
    issues: createFactoryGitHubAdapter({ executable }),
    state,
    controls: async (controls: Record<string, unknown>) => {
      const current = await state();
      await writeFile(
        statePath,
        JSON.stringify({ ...current, controls: { ...current.controls, ...controls } }),
      );
    },
    api: async (endpoint: string, projection: string) => {
      const result = await exec(process.execPath, [
        executable,
        "api",
        "--hostname",
        "github.com",
        endpoint,
        "--method",
        "GET",
        "--jq",
        projection,
      ]);
      return JSON.parse(result.stdout) as unknown;
    },
  };
}

it("generates valid JavaScript and observes the default branch from the real bare remote", async () => {
  const value = await fixture();
  await exec(process.execPath, ["--check", value.executable]);
  expect(
    await value.api(
      "/repos/Ic3b3rg/kestrel",
      "{id:(.id|tostring),owner:.owner.login,name,defaultBranch:.default_branch}",
    ),
  ).toEqual({ id: "424242", owner: "Ic3b3rg", name: "kestrel", defaultBranch: "main" });
});

it("preserves issue publication and creates and reads a PR with exact Git and GraphQL identities", async () => {
  const value = await fixture();
  expect(
    await value.issues.createIssue(identity, { title: "Approved work", body: "Issue body" }),
  ).toMatchObject({ state: "confirmed" });
  const created = await value.adapter.createPullRequest(identity, value.payload);
  expect(created).toEqual({
    state: "confirmed",
    value: {
      ...value.payload,
      repository: identity.repository,
      id: "900300",
      nodeId: "PR_fixture_300",
      repositoryNodeId: "R_fixture",
      authorNodeId: "U_fixture",
      number: 300,
      url: "https://github.com/Ic3b3rg/kestrel/pull/300",
      state: "open",
      author: "fixture",
    },
  });
  if (created.state !== "confirmed") throw new Error("Expected retained PR identity");
  expect(await value.adapter.readPullRequest(identity, value.payload, 300)).toEqual(created.value);
  expect(await value.api("/repos/Ic3b3rg/kestrel/pulls/300", "")).toMatchObject({
    id: 900300,
    node_id: "PR_fixture_300",
    user: { login: "fixture", node_id: "U_fixture" },
    base: { sha: value.base, repo: { id: 424242, node_id: "R_fixture" } },
    head: { sha: value.head, repo: { id: 424242, node_id: "R_fixture" } },
  });
  expect(await value.state()).toMatchObject({
    writes: [
      { method: "POST", endpoint: "/repos/Ic3b3rg/kestrel/issues" },
      { method: "POST", endpoint: "/repos/Ic3b3rg/kestrel/pulls" },
    ],
  });
  expect((await value.state()).gitCalls.every(({ args }) => !args.includes("update-ref"))).toBe(
    true,
  );
});

it("retains a committed but lost PR response, hides it, then reconciles the same closed PR", async () => {
  const value = await fixture();
  await value.controls({ uncertainPullRequestCreate: true, hidePullRequests: true });
  expect(await value.adapter.createPullRequest(identity, value.payload)).toMatchObject({
    state: "uncertain",
  });
  expect((await value.state()).pullRequests).toHaveLength(1);
  expect(await value.adapter.findPullRequest(identity, value.payload)).toEqual({
    state: "missing",
  });
  await value.controls({ hidePullRequests: false, closedPullRequests: true });
  expect(await value.adapter.findPullRequest(identity, value.payload)).toMatchObject({
    state: "found",
    value: { number: 300, state: "closed", ...value.payload },
  });
  expect(await value.adapter.createPullRequest(identity, value.payload)).toMatchObject({
    state: "confirmed",
    value: { number: 300, state: "closed" },
  });
  expect((await value.state()).writes).toHaveLength(1);
});

it.each([
  ["moveTargetAfterPullRequestCreate", "base", "refs/heads/main"],
  ["moveHeadAfterPullRequestCreate", "head", "refs/heads/kestrel/feature/fixture"],
] as const)(
  "observes real ref movement through %s after recording the original PR pair",
  async (control, side, ref) => {
    const value = await fixture();
    const moved = await value.commit("Moved remote ref", [value.head]);
    await value.controls({ [control]: moved });
    expect(await value.adapter.createPullRequest(identity, value.payload)).toMatchObject({
      state: "uncertain",
      failure: "invalid_response",
    });
    expect(await value.git(["rev-parse", ref])).toBe(moved);
    expect((await value.state()).pullRequests[0]?.[side].sha).toBe(
      side === "base" ? value.base : value.head,
    );
    await expect(value.adapter.readPullRequest(identity, value.payload, 300)).rejects.toMatchObject(
      {
        failure: "invalid_response",
      },
    );
    expect(
      (await value.state()).gitCalls.filter(({ args }) => args.includes("update-ref")),
    ).toHaveLength(1);
  },
);

it("exposes a foreign PR and a limited history without authorizing another POST", async () => {
  const value = await fixture();
  await value.adapter.createPullRequest(identity, value.payload);
  await value.controls({ foreignPullRequest: true });
  expect(await value.adapter.findPullRequest(identity, value.payload)).toEqual({
    state: "ambiguous",
  });
  expect(await value.adapter.createPullRequest(identity, value.payload)).toMatchObject({
    state: "not_sent",
  });
  await value.controls({ foreignPullRequest: false, limitedPullRequests: true });
  const before = (await value.state()).calls.length;
  expect(await value.adapter.findPullRequest(identity, value.payload)).toEqual({
    state: "limited",
  });
  expect(
    (await value.state()).calls
      .slice(before)
      .filter(({ endpoint }) => endpoint.includes("/pulls?")),
  ).toHaveLength(5);
  expect((await value.state()).writes).toHaveLength(1);
});

it.each([
  [{ auth: true }, "needs_authentication"],
  [{ account: "other" }, "access_denied"],
  [{ repositoryId: 424243 }, "repository_changed"],
])("exposes identity drift %j before any PR write", async (controls, failure) => {
  const value = await fixture();
  await value.controls(controls);
  expect(await value.adapter.createPullRequest(identity, value.payload)).toEqual({
    state: "not_sent",
    failure,
  });
  expect((await value.state()).writes).toHaveLength(0);
});
