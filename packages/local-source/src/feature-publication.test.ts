import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { readLocalSourceConfig } from "./config.js";
import { discoverRepositories, resolveRepository } from "./discovery.js";
import { inspectRepository } from "./git.js";
import {
  checkpointFeatureWorkspace,
  openFeatureWorkspace,
  snapshotFeatureWorkspace,
} from "./feature-workspace.js";
import {
  identifyFeaturePublicationRemote,
  pushFeaturePublicationHead,
  readFeaturePublicationRefs,
} from "./feature-publication.js";

const exec = promisify(execFile);
const directories: string[] = [];
const canonicalUrl = "https://github.com/owner/notes.git";
const git = async (directory: string, args: string[]) =>
  (
    await exec("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-C", directory, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    })
  ).stdout.trim();
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) {
    await stopEscapedChild(path);
    await rm(path, { recursive: true, force: true });
  }
});

async function stopEscapedChild(root: string) {
  const text = await readFile(join(root, "escaped.pid"), "utf8").catch(() => undefined);
  if (text === undefined) return;
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid fixture child identity");
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await rm(join(root, "escaped.pid"), { force: true });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kestrel-feature-publication-"));
  directories.push(root);
  const repositories = join(root, "repositories");
  const operator = join(repositories, "operator");
  const artifacts = join(root, "artifacts");
  const remote = join(root, "remote.git");
  await mkdir(operator, { recursive: true });
  await mkdir(artifacts, { mode: 0o700 });
  await git(operator, ["init", "--initial-branch=main"]);
  await git(operator, ["config", "user.name", "Fixture"]);
  await git(operator, ["config", "user.email", "fixture@example.test"]);
  await writeFile(join(operator, "source.txt"), "Approved base\n");
  await git(operator, ["add", "source.txt"]);
  await git(operator, ["commit", "-m", "Approved base"]);
  const baseCommitId = await git(operator, ["rev-parse", "HEAD"]);
  await git(operator, ["remote", "add", "origin", canonicalUrl]);
  await git(root, ["clone", "--bare", "--no-hardlinks", operator, remote]);
  await writeFile(join(operator, "source.txt"), "Operator dirty source\n");
  await writeFile(join(operator, "staged.txt"), "Operator staged bytes\n");
  await git(operator, ["add", "staged.txt"]);
  await writeFile(join(operator, "untracked.txt"), "Operator untracked bytes\n");
  const controlPath = join(root, "control.json");
  const callsPath = join(root, "calls.jsonl");
  const escapedPidPath = join(root, "escaped.pid");
  const executable = join(root, "git.mjs");
  await writeFile(controlPath, "{}");
  await writeFile(
    executable,
    [
      "#!" + process.execPath,
      "import {appendFileSync,readFileSync} from 'node:fs'; import {spawn,spawnSync} from 'node:child_process';",
      "const args=process.argv.slice(2), control=JSON.parse(readFileSync(" +
        JSON.stringify(controlPath) +
        ",'utf8'));",
      "appendFileSync(" +
        JSON.stringify(callsPath) +
        ",JSON.stringify({args,tokenPresent:process.env.GH_TOKEN!==undefined})+'\\n');",
      "if(args[0]==='config' && (args.includes('--global')||args.includes('--system'))) { if(args.includes('--global')&&control.credentialHelper) { process.stdout.write('credential.helper\\n'+control.credentialHelper+'\\0'); process.exit(0); } process.exit(1); }",
      "if(control.credentialHelper && (args.includes('ls-remote')||args.includes('push'))) { const result=spawnSync('/usr/bin/git',['credential','fill'],{env:process.env,input:'protocol=https\\nhost=github.com\\n\\n',encoding:'utf8'}); if(result.status!==0) process.exit(128); const username=result.stdout.match(/^username=(.+)$/m)?.[1]; appendFileSync(control.credentialLog,JSON.stringify({command:args.includes('push')?'push':'ls-remote',username})+'\\n'); }",
      "if(control.unreadable && args.includes('ls-remote')) process.exit(128);",
      "if(args.includes('push')&&control.raceRef)spawnSync('/usr/bin/git',['--git-dir='+" +
        JSON.stringify(remote) +
        ",'update-ref',control.raceRef," +
        JSON.stringify(baseCommitId) +
        "]);",
      "const mapped=args.map(value=>value===" +
        JSON.stringify(canonicalUrl) +
        "?" +
        JSON.stringify(remote) +
        ":value==='protocol.file.allow=never'?'protocol.file.allow=always':value);",
      "const lose=args.includes('push') && control.losePush;",
      "const child=spawn('/usr/bin/git',mapped,{env:process.env,stdio:lose?['inherit','pipe','pipe']:'inherit'});",
      "if(lose){child.stdout.resume();child.stderr.resume();}",
      "child.on('error',()=>process.exit(128));child.on('exit',code=>{if(args.includes('push')&&code===0&&control.escapeAfterPush) { const escaped=spawn(process.execPath,['-e',\"require('node:fs').writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000);\"," +
        JSON.stringify(escapedPidPath) +
        "],{detached:true,stdio:['ignore',1,2]}); escaped.unref(); setInterval(()=>{},1000); return; } if(args.includes('push')&&code===0&&control.moveTarget)spawnSync('/usr/bin/git',['--git-dir='+" +
        JSON.stringify(remote) +
        ",'update-ref','refs/heads/main',control.moveTarget]);process.exit(lose&&code===0?128:code??128);});",
    ].join("\n"),
    { mode: 0o755 },
  );
  const config = await readLocalSourceConfig({
    LOCAL_REPOSITORY_ROOTS: JSON.stringify([repositories]),
    ARTIFACT_ROOT: artifacts,
    LOCAL_GIT_EXECUTABLE: executable,
    REVIEW_REVISION_MAX_BYTES: "1048576",
    REVIEW_REVISION_MAX_OBJECTS: "1000",
  });
  const candidate = (await discoverRepositories(config))[0];
  if (candidate === undefined) throw new Error("No disposable source");
  const inspection = await inspectRepository(
    config,
    await resolveRepository(config, candidate.repositoryId),
  );
  const featureId = randomUUID();
  const workspace = await openFeatureWorkspace(config, {
    projectId: randomUUID(),
    featureId,
    repositoryId: candidate.repositoryId,
    sourceIdentity: inspection.sourceIdentity,
    baseCommitId,
    objectFormat: "sha1",
    branch: "refs/heads/kestrel/feature/" + featureId,
  });
  await writeFile(join(workspace.workspacePath, "source.txt"), "Verified Feature implementation\n");
  const candidateTree = await snapshotFeatureWorkspace(workspace, { expectedHead: baseCommitId });
  const snapshot = await checkpointFeatureWorkspace(workspace, {
    expectedHead: baseCommitId,
    expectedTree: candidateTree.treeId,
    checkpointId: randomUUID(),
    message: "Verified Feature",
  });
  const source = { workspace, snapshot };
  const target = await identifyFeaturePublicationRemote(config, source, {
    repository: { owner: "owner", name: "notes" },
    remoteName: "origin",
    targetRef: "refs/heads/main",
  });
  const operatorState = async () => ({
    index: (await readFile(join(operator, ".git/index"))).toString("hex"),
    head: await readFile(join(operator, ".git/HEAD"), "utf8"),
    refs: await git(operator, ["show-ref", "--head"]),
    config: await readFile(join(operator, ".git/config"), "utf8"),
    dirty: await readFile(join(operator, "source.txt"), "utf8"),
    staged: await readFile(join(operator, "staged.txt"), "utf8"),
    untracked: await readFile(join(operator, "untracked.txt"), "utf8"),
  });
  return {
    root,
    config,
    source,
    target,
    operator,
    operatorState,
    remote,
    waitForEscapedChild: async () => {
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        const pid = Number(await readFile(escapedPidPath, "utf8").catch(() => undefined));
        if (Number.isSafeInteger(pid) && pid > 0) return pid;
        await delay(20);
      }
      throw new Error("Fixture descendant did not become ready");
    },
    control: (value: unknown) => writeFile(controlPath, JSON.stringify(value)),
    calls: async () =>
      (await readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: string[]; tokenPresent: boolean }),
  };
}

it("uses the selected native GitHub profile for credential helpers during remote reads and pushes", async () => {
  const value = await fixture();
  const xdgConfig = join(value.root, "xdg");
  const selectedProfile = join(value.root, "selected-gh");
  const defaultProfile = join(xdgConfig, "gh");
  for (const [profile, username] of [
    [selectedProfile, "selected-operator"],
    [defaultProfile, "default-operator"],
  ] as const) {
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "account.json"), JSON.stringify({ username }));
  }
  const helper = join(value.root, "gh.mjs");
  await writeFile(
    helper,
    `#!${process.execPath}
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
if (process.argv.slice(2).join(' ') !== 'auth git-credential get') process.exit(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (input !== 'protocol=https\\nhost=github.com\\n') process.exit(3);
const profile = process.env.GH_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME, 'gh');
const {username} = JSON.parse(readFileSync(join(profile, 'account.json'), 'utf8'));
process.stdout.write('username=' + username + '\\npassword=fixture-only\\n');
`,
    { mode: 0o755 },
  );
  const credentialLog = join(value.root, "credential-log.jsonl");
  await value.control({
    credentialHelper: "!'" + helper.replaceAll("'", "'\\''") + "' auth git-credential",
    credentialLog,
  });
  vi.stubEnv("XDG_CONFIG_HOME", xdgConfig);
  vi.stubEnv("GH_CONFIG_DIR", selectedProfile);
  const before = await value.operatorState();

  expect(await readFeaturePublicationRefs(value.config, value.source, value.target)).toEqual({
    targetHead: value.source.workspace.identity.baseCommitId,
    featureHead: null,
  });
  expect(await pushFeaturePublicationHead(value.config, value.source, value.target)).toMatchObject({
    state: "confirmed",
  });
  const credentials = (await readFile(credentialLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { command: string; username: string });
  expect(credentials.map(({ command }) => command)).toEqual([
    "ls-remote",
    "ls-remote",
    "push",
    "ls-remote",
  ]);
  expect(credentials.map(({ username }) => username)).toEqual([
    "selected-operator",
    "selected-operator",
    "selected-operator",
    "selected-operator",
  ]);
  expect(await value.operatorState()).toEqual(before);
}, 30_000);

it("creates only the exact certified Feature ref with an empty lease and preserves the Operator source", async () => {
  const value = await fixture();
  vi.stubEnv("GH_TOKEN", "fixture-not-a-credential");
  const before = await value.operatorState();
  expect(await readFeaturePublicationRefs(value.config, value.source, value.target)).toEqual({
    targetHead: value.source.workspace.identity.baseCommitId,
    featureHead: null,
  });
  expect(await pushFeaturePublicationHead(value.config, value.source, value.target)).toEqual({
    state: "confirmed",
    value: {
      headCommitId: value.source.snapshot.headCommitId,
      ref: value.source.workspace.identity.branch,
    },
  });
  expect(await git(value.remote, ["rev-parse", value.source.workspace.identity.branch])).toBe(
    value.source.snapshot.headCommitId,
  );
  expect(await git(value.remote, ["rev-parse", "refs/heads/main"])).toBe(
    value.source.workspace.identity.baseCommitId,
  );
  expect(await value.operatorState()).toEqual(before);
  const pushes = (await value.calls()).filter(({ args }) => args.includes("push"));
  expect(pushes).toHaveLength(1);
  expect(pushes[0]?.args).toContain(
    "--force-with-lease=" + value.source.workspace.identity.branch + ":",
  );
  expect(pushes[0]?.args).toContain(
    value.source.snapshot.headCommitId + ":" + value.source.workspace.identity.branch,
  );
  expect(pushes[0]?.args).toContain("core.hooksPath=/dev/null");
  expect(pushes[0]?.args).toContain("protocol.file.allow=never");
  expect(pushes[0]?.tokenPresent).toBe(false);
}, 30_000);

it("accepts an unchanged persisted remote descriptor regardless of JSON property order", async () => {
  const value = await fixture();
  const { target } = value;
  const restored = {
    targetRef: target.targetRef,
    canonicalUrl: target.canonicalUrl,
    configuredPushUrl: target.configuredPushUrl,
    configuredUrl: target.configuredUrl,
    remoteName: target.remoteName,
    repository: { name: target.repository.name, owner: target.repository.owner },
  };
  expect(await readFeaturePublicationRefs(value.config, value.source, restored)).toEqual({
    targetHead: value.source.workspace.identity.baseCommitId,
    featureHead: null,
  });
}, 30_000);

it("reconciles a lost push response by the exact remote ref without sending a second push", async () => {
  const value = await fixture();
  await value.control({ losePush: true });
  expect(await pushFeaturePublicationHead(value.config, value.source, value.target)).toMatchObject({
    state: "uncertain",
  });
  expect(await readFeaturePublicationRefs(value.config, value.source, value.target)).toEqual({
    targetHead: value.source.workspace.identity.baseCommitId,
    featureHead: value.source.snapshot.headCommitId,
  });
  expect(await pushFeaturePublicationHead(value.config, value.source, value.target)).toMatchObject({
    state: "confirmed",
  });
  expect((await value.calls()).filter(({ args }) => args.includes("push"))).toHaveLength(1);
}, 30_000);

it.each(["cancelled", "timeout"] as const)(
  "settles an uncertain %s push while an escaped descendant holds its pipes open",
  async (failure) => {
    const value = await fixture();
    await value.control({ escapeAfterPush: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const pending = pushFeaturePublicationHead(value.config, value.source, value.target, {
      signal: controller.signal,
    });
    let result: unknown;
    try {
      const pid = await value.waitForEscapedChild();
      if (failure === "cancelled") controller.abort();
      else await vi.runOnlyPendingTimersAsync();
      result = await Promise.race([pending, delay(1_000, "did not settle")]);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      controller.abort();
      await stopEscapedChild(value.root);
      await pending;
      vi.useRealTimers();
    }
    expect(result).toEqual({ state: "uncertain", failure });
    expect(await readFeaturePublicationRefs(value.config, value.source, value.target)).toEqual({
      targetHead: value.source.workspace.identity.baseCommitId,
      featureHead: value.source.snapshot.headCommitId,
    });
    expect((await value.calls()).filter(({ args }) => args.includes("push"))).toHaveLength(1);
  },
  30_000,
);

it("rejects a foreign Feature ref before writing and rejects a racing ref using Git's empty lease", async () => {
  const value = await fixture();
  const { branch, baseCommitId } = value.source.workspace.identity;
  await git(value.remote, ["update-ref", branch, baseCommitId]);
  expect(await pushFeaturePublicationHead(value.config, value.source, value.target)).toEqual({
    state: "rejected",
    failure: "feature_ref_conflict",
  });
  expect((await value.calls()).filter(({ args }) => args.includes("push"))).toHaveLength(0);
  await git(value.remote, ["update-ref", "-d", branch]);
  await value.control({ raceRef: branch });
  expect(await pushFeaturePublicationHead(value.config, value.source, value.target)).toEqual({
    state: "rejected",
    failure: "push_rejected",
  });
  expect(await git(value.remote, ["rev-parse", branch])).toBe(baseCommitId);
  expect(await git(value.remote, ["rev-parse", "refs/heads/main"])).toBe(baseCommitId);
}, 30_000);

it("does not substitute another remote when the original is removed or has a changed push destination", async () => {
  const value = await fixture();
  await git(value.operator, ["remote", "add", "fallback", canonicalUrl]);
  await git(value.operator, ["remote", "remove", "origin"]);
  expect(await pushFeaturePublicationHead(value.config, value.source, value.target)).toEqual({
    state: "not_sent",
    failure: "remote_changed",
  });
  await git(value.operator, ["remote", "add", "origin", canonicalUrl]);
  await git(value.operator, [
    "remote",
    "set-url",
    "--push",
    "origin",
    "https://github.com/other/notes.git",
  ]);
  expect(await pushFeaturePublicationHead(value.config, value.source, value.target)).toEqual({
    state: "not_sent",
    failure: "remote_changed",
  });
  expect((await value.calls()).filter(({ args }) => args.includes("push"))).toHaveLength(0);
}, 30_000);

it("retains the inspected SSH identity and detects even a later same-repository URL change", async () => {
  const value = await fixture();
  await git(value.operator, ["remote", "set-url", "origin", "git@github.com:owner/notes.git"]);
  const target = await identifyFeaturePublicationRemote(value.config, value.source, value.target);
  expect(target.configuredUrl).toBe("git@github.com:owner/notes.git");
  expect(target.canonicalUrl).toBe(canonicalUrl);
  expect(await readFeaturePublicationRefs(value.config, value.source, target)).toMatchObject({
    targetHead: value.source.workspace.identity.baseCommitId,
  });
  expect(await pushFeaturePublicationHead(value.config, value.source, value.target)).toEqual({
    state: "not_sent",
    failure: "remote_changed",
  });
  expect((await value.calls()).filter(({ args }) => args.includes("push"))).toHaveLength(0);
}, 30_000);

async function driftCommit(remote: string, base: string) {
  const tree = await git(remote, ["rev-parse", base + "^{tree}"]);
  return git(remote, [
    "-c",
    "user.name=Remote fixture",
    "-c",
    "user.email=remote@example.test",
    "commit-tree",
    tree,
    "-p",
    base,
    "-m",
    "Remote base moved",
  ]);
}
it("blocks changed or missing target tips and never changes the frozen base", async () => {
  const value = await fixture();
  const base = value.source.workspace.identity.baseCommitId;
  const moved = await driftCommit(value.remote, base);
  await git(value.remote, ["update-ref", "refs/heads/main", moved]);
  expect(await pushFeaturePublicationHead(value.config, value.source, value.target)).toEqual({
    state: "not_sent",
    failure: "target_changed",
  });
  await git(value.remote, ["update-ref", "-d", "refs/heads/main"]);
  expect(await pushFeaturePublicationHead(value.config, value.source, value.target)).toEqual({
    state: "not_sent",
    failure: "target_unavailable",
  });
  expect((await value.calls()).filter(({ args }) => args.includes("push"))).toHaveLength(0);
  expect(value.source.workspace.identity.baseCommitId).toBe(base);
}, 30_000);

it("keeps a sent push uncertain when the target moves during the write or cannot be read", async () => {
  const value = await fixture();
  const moved = await driftCommit(value.remote, value.source.workspace.identity.baseCommitId);
  await value.control({ moveTarget: moved });
  expect(await pushFeaturePublicationHead(value.config, value.source, value.target)).toEqual({
    state: "uncertain",
    failure: "target_changed",
  });
  expect(await git(value.remote, ["rev-parse", value.source.workspace.identity.branch])).toBe(
    value.source.snapshot.headCommitId,
  );
  await value.control({ unreadable: true });
  await expect(
    readFeaturePublicationRefs(value.config, value.source, value.target),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect((await value.calls()).filter(({ args }) => args.includes("push"))).toHaveLength(1);
}, 30_000);

it("blocks changed workspace bytes and uncommitted snapshots before reading a remote", async () => {
  const value = await fixture();
  const before = (await value.calls()).filter(({ args }) => args.includes("ls-remote")).length;
  await writeFile(
    join(value.source.workspace.workspacePath, "source.txt"),
    "Changed after final verification\n",
  );
  expect(await pushFeaturePublicationHead(value.config, value.source, value.target)).toEqual({
    state: "not_sent",
    failure: "workspace_changed",
  });
  const snapshot = await snapshotFeatureWorkspace(value.source.workspace, {
    expectedHead: value.source.snapshot.headCommitId,
  });
  expect(
    await pushFeaturePublicationHead(
      value.config,
      { workspace: value.source.workspace, snapshot },
      value.target,
    ),
  ).toEqual({ state: "not_sent", failure: "workspace_changed" });
  const calls = await value.calls();
  expect(calls.filter(({ args }) => args.includes("ls-remote"))).toHaveLength(before);
  expect(calls.filter(({ args }) => args.includes("push"))).toHaveLength(0);
}, 30_000);

it("classifies cancellation before provider access as not sent", async () => {
  const value = await fixture();
  const before = (await value.calls()).length;
  expect(
    await pushFeaturePublicationHead(value.config, value.source, value.target, {
      signal: AbortSignal.abort(),
    }),
  ).toEqual({ state: "not_sent", failure: "cancelled" });
  expect((await value.calls()).length).toBe(before);
}, 30_000);

it("reports a missing original source without contacting or substituting a remote", async () => {
  const value = await fixture();
  const before = (await value.calls()).filter(({ args }) => args.includes("ls-remote")).length;
  await rename(value.operator, value.operator + "-removed");
  await expect(
    readFeaturePublicationRefs(value.config, value.source, value.target),
  ).rejects.toMatchObject({ name: "FeaturePublicationGitError", code: "source_changed" });
  expect((await value.calls()).filter(({ args }) => args.includes("ls-remote"))).toHaveLength(
    before,
  );
}, 30_000);
