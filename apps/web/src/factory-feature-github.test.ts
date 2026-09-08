import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createFactoryFeatureGitHubAdapter,
  type FactoryFeaturePullRequestPayload,
} from "./factory-feature-github.js";
import { type FactoryGitHubIdentity } from "./factory-github.js";

const identity: FactoryGitHubIdentity = {
  repository: { id: "41", owner: "owner", name: "notes" },
  account: "operator",
};
const payload: FactoryFeaturePullRequestPayload = {
  title: "Export notes",
  body: "Approved plan v3\n\n<!-- kestrel-feature-pr:v1:fixture -->\n",
  marker: "<!-- kestrel-feature-pr:v1:fixture -->",
  baseRef: "main",
  headRef: "kestrel/feature/fixture",
  baseCommitId: "a".repeat(40),
  headCommitId: "b".repeat(40),
};
const providerPr = () => ({
  id: "501",
  nodeId: "PR_fixture7",
  authorNodeId: "U_fixtureOperator",
  number: 7,
  html_url: "https://github.com/owner/notes/pull/7",
  state: "open",
  author: "operator",
  title: payload.title,
  body: payload.body,
  base: {
    ref: payload.baseRef,
    sha: payload.baseCommitId,
    repo: { ...identity.repository, nodeId: "R_fixture41" },
  },
  head: {
    ref: payload.headRef,
    sha: payload.headCommitId,
    repo: { ...identity.repository, nodeId: "R_fixture41" },
  },
});
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(mode = "ok") {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-feature-pr-"));
  directories.push(directory);
  const statePath = join(directory, "state.json"),
    callsPath = join(directory, "calls.jsonl"),
    executable = join(directory, "gh.mjs");
  const initial = {
    mode,
    posts: 0,
    reads: 0,
    prs: [] as ReturnType<typeof providerPr>[],
    sample: providerPr(),
  };
  await writeFile(statePath, JSON.stringify(initial));
  await writeFile(
    executable,
    `#!${process.execPath}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const statePath=${JSON.stringify(statePath)},callsPath=${JSON.stringify(callsPath)};
const state=JSON.parse(readFileSync(statePath,'utf8')),args=process.argv.slice(2);
let input=''; for await(const chunk of process.stdin) input+=chunk;
const body=input===''?null:JSON.parse(input);
appendFileSync(callsPath,JSON.stringify({args,body,tokenPresent:['GH_TOKEN','GITHUB_TOKEN','KESTREL_FIXTURE_SECRET'].some(key=>process.env[key]!==undefined)})+'\\n');
function save(){writeFileSync(statePath,JSON.stringify(state));}
function reply(status,value,headers={}){save();process.stdout.write('HTTP/2.0 '+status+' Fixture\\r\\n'+Object.entries(headers).map(([key,value])=>key+': '+value+'\\r\\n').join('')+'\\r\\n'+JSON.stringify(value));process.exit(status>=400?1:0);}
if(args[0]==='version'){process.stdout.write('gh version 2.86.0 (fixture)\\n');process.exit(0);}
if(args[0]!=='api'||args[1]!=='--hostname'||args[2]!=='github.com')reply(400,{message:'unexpected command'});
const url=new URL(args[3],'https://api.github.com'),method=args[args.indexOf('--method')+1];
if(url.pathname==='/user')reply(200,{login:state.mode==='account_changed'||state.mode==='account_after_write'&&state.posts>0?'other':'operator'});
if(url.pathname==='/repos/owner/notes')reply(200,{owner:'owner',name:'notes',id:state.mode==='repository_changed'||state.mode==='repository_after_write'&&state.posts>0?'42':'41',...(args[args.indexOf('--jq')+1].includes('default_branch')?{defaultBranch:state.mode==='invalid_target'?'../invalid':'main'}:{})});
if(url.pathname==='/repos/owner/notes/pulls'&&method==='GET'){
 state.reads++;const page=Number(url.searchParams.get('page'));
 if(state.mode==='unreadable')reply(503,{message:'private provider failure'});
 if(state.mode==='hostile_link')reply(200,[],{Link:'<https://attacker.invalid/pulls?page=2>; rel="next"'});
 if(state.mode==='limited')reply(200,page===1?state.prs:[],{Link:'<https://api.github.com/repositories/41/pulls?state=all&page='+(page+1)+'>; rel="next"'});
 if(state.mode==='pagination'&&page===1)reply(200,[{...state.sample,id:'900',number:90,body:null,head:{...state.sample.head,ref:'unrelated',repo:null}}],{Link:'<https://api.github.com/repositories/41/pulls?state=all&page=2>; rel="next"'});
 reply(200,state.prs);
}
if(url.pathname==='/repos/owner/notes/pulls'&&method==='POST'){
 state.posts++;
 if(state.mode==='rejected')reply(422,{message:'private validation failure'});
 if(state.mode==='rate_limited')reply(403,{message:'rate limit exceeded'},{'Retry-After':'120'});
 if(state.mode==='server_error')reply(503,{message:'private provider failure'});
 const pr={...state.sample,title:body.title,body:body.body};state.prs.push(pr);
 if(state.mode==='disconnected'){save();process.stderr.write('private transport failure');process.exit(1);}
  if(state.mode==='invalid_created')reply(201,{...pr,head:{...pr.head,sha:'c'.repeat(40)}});
  if(state.mode==='different_repository_node')reply(201,{...pr,head:{...pr.head,repo:{...pr.head.repo,nodeId:'R_foreign'}}});
 reply(201,pr);
}
if(url.pathname==='/repos/owner/notes/pulls/7'&&method==='GET')reply(200,state.prs[0]??state.sample);
reply(400,{message:'unexpected endpoint'});
`,
    { mode: 0o700 },
  );
  const state = async () => JSON.parse(await readFile(statePath, "utf8")) as typeof initial;
  return {
    adapter: createFactoryFeatureGitHubAdapter({ executable }),
    restart: () => createFactoryFeatureGitHubAdapter({ executable }),
    state,
    setState: async (changes: Partial<typeof initial>) =>
      writeFile(statePath, JSON.stringify({ ...(await state()), ...changes })),
    calls: async () =>
      (await readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as { args: string[]; body: unknown; tokenPresent: boolean },
        ),
  };
}

it("creates a PR from the exact retained payload and reads its exact base/head identity", async () => {
  const value = await fixture();
  vi.stubEnv("GH_TOKEN", "fixture-not-a-credential");
  vi.stubEnv("KESTREL_FIXTURE_SECRET", "fixture-private");
  const result = await value.adapter.createPullRequest(identity, payload);
  expect(result).toMatchObject({
    state: "confirmed",
    value: {
      repository: identity.repository,
      id: "501",
      number: 7,
      url: "https://github.com/owner/notes/pull/7",
      state: "open",
      author: identity.account,
      nodeId: "PR_fixture7",
      repositoryNodeId: "R_fixture41",
      authorNodeId: "U_fixtureOperator",
      ...payload,
    },
  });
  expect(await value.adapter.readPullRequest(identity, payload, 7)).toMatchObject({
    baseCommitId: payload.baseCommitId,
    headCommitId: payload.headCommitId,
    body: payload.body,
  });
  const calls = await value.calls(),
    posts = calls.filter((call) => call.args.includes("POST"));
  expect(posts).toHaveLength(1);
  expect(posts[0]?.body).toEqual({
    title: payload.title,
    body: payload.body,
    base: payload.baseRef,
    head: payload.headRef,
    maintainer_can_modify: false,
  });
  expect(
    calls
      .filter((call) => call.args[3]?.includes("/pulls?"))
      .every((call) => call.args[3]?.includes("state=all")),
  ).toBe(true);
  expect(calls.some((call) => call.tokenPresent)).toBe(false);
});

it("does not confirm a response with inconsistent canonical repository node IDs", async () => {
  const value = await fixture();
  await value.setState({ mode: "different_repository_node" });
  expect(await value.adapter.createPullRequest(identity, payload)).toMatchObject({
    state: "uncertain",
    failure: "invalid_response",
  });
  expect((await value.state()).posts).toBe(1);
});

it("reconciles a lost response to the same closed PR after restart without another POST", async () => {
  const value = await fixture("disconnected");
  expect(await value.adapter.createPullRequest(identity, payload)).toMatchObject({
    state: "uncertain",
  });
  await value.setState({ mode: "ok", prs: [{ ...providerPr(), state: "closed" }] });
  expect(await value.restart().findPullRequest(identity, payload)).toMatchObject({
    state: "found",
    value: { id: "501", state: "closed", headCommitId: payload.headCommitId },
  });
  expect(await value.restart().createPullRequest(identity, payload)).toMatchObject({
    state: "confirmed",
    value: { id: "501", state: "closed" },
  });
  expect((await value.state()).posts).toBe(1);
});

it.each([
  ["foreign author", { author: "someone-else" }],
  ["edited body", { body: "Changed outcome\n" + payload.marker }],
  ["moved head", { head: { ...providerPr().head, sha: "c".repeat(40) } }],
  ["moved base", { base: { ...providerPr().base, sha: "c".repeat(40) } }],
  ["different branch", { head: { ...providerPr().head, ref: "foreign" } }],
  [
    "foreign head repository",
    { head: { ...providerPr().head, repo: { ...providerPr().head.repo, id: "42" } } },
  ],
  [
    "foreign base repository",
    { base: { ...providerPr().base, repo: { ...providerPr().base.repo, id: "42" } } },
  ],
  ["foreign URL", { html_url: "https://github.com/other/notes/pull/7" }],
  ["same branch without the marker", { body: "Operator's existing PR" }],
  [
    "foreign branch without the marker",
    {
      body: "Existing foreign PR",
      head: { ...providerPr().head, repo: { ...providerPr().head.repo, id: "42" } },
    },
  ],
] as const)("blocks a duplicate POST for %s", async (_name, changes) => {
  const value = await fixture();
  await value.setState({ prs: [{ ...providerPr(), ...changes }] });
  expect(await value.adapter.findPullRequest(identity, payload)).toEqual({ state: "ambiguous" });
  expect(await value.adapter.createPullRequest(identity, payload)).toMatchObject({
    state: "not_sent",
    failure: "uncertain_write",
  });
  expect((await value.state()).posts).toBe(0);
});

it("reads later closed PRs without filtering away foreign branch or marker evidence", async () => {
  const value = await fixture("pagination");
  await value.setState({ prs: [{ ...providerPr(), state: "closed" }] });
  expect(await value.adapter.findPullRequest(identity, payload)).toMatchObject({
    state: "found",
    value: { state: "closed" },
  });
  const pages = (await value.calls()).filter((call) => call.args[3]?.includes("/pulls?"));
  expect(pages).toHaveLength(2);
  expect(
    pages.every(
      (call) =>
        call.args[3]?.includes("state=all") &&
        !call.args[3].includes("head=") &&
        !call.args[3].includes("base="),
    ),
  ).toBe(true);
});

it.each([false, true])(
  "requires an exhaustive scan even when a candidate is present: %s",
  async (present) => {
    const value = await fixture("limited");
    if (present) await value.setState({ prs: [providerPr()] });
    expect(await value.adapter.findPullRequest(identity, payload)).toEqual({ state: "limited" });
    expect((await value.state()).reads).toBe(5);
    expect(await value.adapter.createPullRequest(identity, payload)).toMatchObject({
      state: "not_sent",
      failure: "reconciliation_limit",
    });
    expect((await value.state()).posts).toBe(0);
  },
);

it("rejects two owned PRs with the same marker, including a closed duplicate", async () => {
  const value = await fixture();
  await value.setState({
    prs: [
      providerPr(),
      {
        ...providerPr(),
        id: "502",
        number: 8,
        html_url: "https://github.com/owner/notes/pull/8",
        state: "closed",
      },
    ],
  });
  expect(await value.adapter.findPullRequest(identity, payload)).toEqual({ state: "ambiguous" });
  expect((await value.state()).posts).toBe(0);
});

it.each([
  ["account_changed", "not_sent", "access_denied", 0],
  ["repository_changed", "not_sent", "repository_changed", 0],
  ["account_after_write", "uncertain", "access_denied", 1],
  ["repository_after_write", "uncertain", "repository_changed", 1],
  ["unreadable", "not_sent", "unavailable", 0],
  ["hostile_link", "not_sent", "invalid_response", 0],
  ["rejected", "rejected", "invalid_response", 1],
  ["rate_limited", "rejected", "rate_limited", 1],
  ["server_error", "uncertain", "unavailable", 1],
  ["invalid_created", "uncertain", "invalid_response", 1],
] as const)("classifies %s without another write", async (mode, state, failure, posts) => {
  const value = await fixture(mode);
  const result = await value.adapter.createPullRequest(identity, payload);
  expect(result).toMatchObject({ state, failure });
  expect(JSON.stringify(result)).not.toContain("private");
  expect((await value.state()).posts).toBe(posts);
});

it("refuses to replace the captured pair with moved branch pointers on a later read", async () => {
  const value = await fixture();
  await value.setState({
    prs: [{ ...providerPr(), head: { ...providerPr().head, sha: "c".repeat(40) } }],
  });
  await expect(value.adapter.readPullRequest(identity, payload, 7)).rejects.toMatchObject({
    failure: "invalid_response",
  });
  expect((await value.state()).posts).toBe(0);
});

it("does not start provider commands for a cancelled or malformed request", async () => {
  const value = await fixture();
  expect(await value.adapter.createPullRequest(identity, payload, AbortSignal.abort())).toEqual({
    state: "not_sent",
    failure: "cancelled",
  });
  expect(
    await value.adapter.createPullRequest(identity, { ...payload, body: "Missing marker" }),
  ).toEqual({ state: "not_sent", failure: "invalid_response" });
  expect((await value.state()).posts).toBe(0);
  await expect(value.calls()).rejects.toMatchObject({ code: "ENOENT" });
});

it("reads a default target only from the retained repository and native account", async () => {
  const value = await fixture();
  expect(await value.adapter.readTargetBranch(identity)).toBe("main");
  await value.setState({ mode: "repository_changed" });
  await expect(value.adapter.readTargetBranch(identity)).rejects.toMatchObject({
    failure: "repository_changed",
  });
  await value.setState({ mode: "invalid_target" });
  await expect(value.adapter.readTargetBranch(identity)).rejects.toMatchObject({
    failure: "invalid_response",
  });
  expect((await value.calls()).some((call) => call.args.includes("POST"))).toBe(false);
});
