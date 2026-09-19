import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  createFactoryFeatureGitHubAdapter,
  type FactoryFeaturePullRequest,
} from "./factory-feature-github.js";
import type { FactoryGitHubIdentity } from "./factory-github.js";

const identity: FactoryGitHubIdentity = {
  repository: { id: "41", owner: "owner", name: "notes" },
  account: "operator",
};
const expected: FactoryFeaturePullRequest = {
  repository: identity.repository,
  id: "501",
  nodeId: "PR_fixture7",
  repositoryNodeId: "R_fixture41",
  authorNodeId: "U_fixtureOperator",
  number: 7,
  url: "https://github.com/owner/notes/pull/7",
  state: "open",
  author: "operator",
  title: "Export notes",
  body: "Approved plan\n\n<!-- kestrel:feature-pr:fixture -->",
  marker: "<!-- kestrel:feature-pr:fixture -->",
  baseRef: "main",
  headRef: "kestrel/feature/fixture",
  baseCommitId: "a".repeat(40),
  headCommitId: "b".repeat(40),
};
const issue = {
  repository: identity.repository,
  id: "601",
  number: 12,
  url: "https://github.com/owner/notes/issues/12",
};

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

async function fixture(mode = "ready") {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-merge-github-"));
  directories.push(directory);
  const statePath = join(directory, "state.json");
  const executable = join(directory, "gh.mjs");
  await writeFile(
    statePath,
    JSON.stringify({ mode, merged: false, mergeWrites: 0, closeWrites: 0, calls: [] }),
  );
  await writeFile(
    executable,
    `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
const path=${JSON.stringify(statePath)},state=JSON.parse(readFileSync(path,'utf8')),args=process.argv.slice(2);
let input='';for await(const chunk of process.stdin)input+=chunk;const body=input?JSON.parse(input):null;
const url=new URL(args[3]??'/', 'https://api.github.com'),method=args[args.indexOf('--method')+1];
state.calls.push({path:url.pathname,method,body});
const save=()=>writeFileSync(path,JSON.stringify(state));
const reply=(status,value)=>{save();process.stdout.write('HTTP/2.0 '+status+' Fixture\\r\\n\\r\\n'+JSON.stringify(value));process.exit(status>=400?1:0)};
const repo={id:'41',nodeId:'R_fixture41',owner:'owner',name:'notes'};
const pr=()=>({id:'501',nodeId:'PR_fixture7',authorNodeId:'U_fixtureOperator',number:7,html_url:'https://github.com/owner/notes/pull/7',state:state.merged?'closed':state.mode==='closed'?'closed':'open',author:'operator',title:'Export notes',body:'Approved plan\\n\\n<!-- kestrel:feature-pr:fixture -->',merged:state.merged,merge_commit_sha:state.merged?'c'.repeat(40):null,merged_at:state.merged?'2026-09-19T10:10:00Z':null,mergeable:state.mode==='conflict'?false:true,mergeable_state:state.mode==='checks_pending'?'blocked':'clean',base:{ref:'main',sha:'a'.repeat(40),repo},head:{ref:'kestrel/feature/fixture',sha:state.mode==='moved_head'?'d'.repeat(40):'b'.repeat(40),repo}});
if(args[0]==='version'){process.stdout.write('gh version 2.86.0 (fixture)\\n');process.exit(0)}
if(url.pathname==='/user')reply(200,{login:'operator'});
if(url.pathname==='/repos/owner/notes')reply(200,{id:'41',owner:'owner',name:'notes'});
if(url.pathname==='/repos/owner/notes/pulls/7'&&method==='GET')reply(200,pr());
if(url.pathname==='/repos/owner/notes/branches/main')reply(200,{name:'main',protected:true,requiredContexts:['ci']});
if(url.pathname==='/repos/owner/notes/commits/'+'b'.repeat(40)+'/status')reply(200,{state:state.mode==='checks_failed'?'failure':state.mode==='checks_pending'?'pending':'success',statuses:[{context:'ci',state:state.mode==='checks_failed'?'failure':state.mode==='checks_pending'?'pending':'success'}]});
if(url.pathname==='/repos/owner/notes/commits/'+'b'.repeat(40)+'/check-runs')reply(200,{check_runs:[]});
if(url.pathname==='/repos/owner/notes/pulls/7/merge'&&method==='PUT'){
 state.mergeWrites++;if(body.sha!=='b'.repeat(40))reply(409,{message:'head changed'});state.merged=true;
 if(state.mode==='lost_merge'){save();process.exit(1)}reply(200,{merged:true,sha:'c'.repeat(40),message:'merged'});
}
if(url.pathname==='/repos/owner/notes/issues/12'&&method==='GET')reply(200,{id:'601',number:12,state:state.closeWrites?'closed':'open',closed_at:state.closeWrites?'2026-09-19T10:11:00Z':null,html_url:'https://github.com/owner/notes/issues/12',repository_url:'https://api.github.com/repos/owner/notes',isPullRequest:false});
if(url.pathname==='/repos/owner/notes/issues/12'&&method==='PATCH'){
 state.closeWrites++;if(state.mode==='close_failed')reply(503,{message:'provider unavailable'});reply(200,{id:'601',number:12,state:'closed',closed_at:'2026-09-19T10:11:00Z',html_url:'https://github.com/owner/notes/issues/12',repository_url:'https://api.github.com/repos/owner/notes',isPullRequest:false});
}
reply(400,{message:'unexpected '+method+' '+url.pathname});
`,
    { mode: 0o700 },
  );
  return {
    adapter: createFactoryFeatureGitHubAdapter({ executable }),
    state: async () =>
      JSON.parse(await readFile(statePath, "utf8")) as {
        merged: boolean;
        mergeWrites: number;
        closeWrites: number;
        calls: Array<{ path: string; method: string; body: unknown }>;
      },
  };
}

it("reads required checks and merges only the exact reviewed head", async () => {
  const value = await fixture();
  await expect(value.adapter.inspectPullRequestForMerge(identity, expected)).resolves.toMatchObject(
    {
      merged: false,
      mergeable: true,
      checks: [{ name: "ci", state: "success", required: true }],
    },
  );
  await expect(value.adapter.mergePullRequest(identity, expected)).resolves.toEqual({
    state: "confirmed",
    value: { mergeCommitId: "c".repeat(40) },
  });
  const state = await value.state();
  expect(state.mergeWrites).toBe(1);
  expect(state.calls.find((call) => call.method === "PUT")?.body).toEqual({
    sha: expected.headCommitId,
  });
});

it.each([
  ["checks_pending", "pending"],
  ["checks_failed", "failure"],
  ["conflict", "success"],
] as const)("exposes merge blockers before a write: %s", async (mode, checkState) => {
  const value = await fixture(mode);
  await expect(value.adapter.inspectPullRequestForMerge(identity, expected)).resolves.toMatchObject(
    {
      mergeable: mode !== "conflict",
      checks: [{ name: "ci", state: checkState, required: true }],
    },
  );
  expect((await value.state()).mergeWrites).toBe(0);
});

it("classifies a lost merge response as uncertain and observes it after restart", async () => {
  const value = await fixture("lost_merge");
  await expect(value.adapter.mergePullRequest(identity, expected)).resolves.toMatchObject({
    state: "uncertain",
  });
  await expect(value.adapter.inspectPullRequestForMerge(identity, expected)).resolves.toMatchObject(
    {
      merged: true,
      headCommitId: expected.headCommitId,
      mergeCommitId: "c".repeat(40),
    },
  );
  expect((await value.state()).mergeWrites).toBe(1);
});

it("closes only the frozen linked issue identity and returns a retryable failure", async () => {
  const value = await fixture();
  await expect(value.adapter.closeIssue(identity, issue)).resolves.toMatchObject({
    state: "confirmed",
    value: { closedAt: "2026-09-19T10:11:00.000Z" },
  });
  const failed = await fixture("close_failed");
  await expect(failed.adapter.closeIssue(identity, issue)).resolves.toMatchObject({
    state: "uncertain",
    failure: "unavailable",
  });
});
