import { factoryGitHubFixture } from "./factory-github-fixture.js";

export const factoryFeaturePublicationFixtureStatePath = "/tmp/kestrel-factory-github.json";
export const factoryFeaturePublicationFixtureRemotePath = "/tmp/kestrel-factory-feature-remote.git";
export const factoryFeaturePublicationFixtureRemoteUrl = "https://github.com/Ic3b3rg/kestrel.git";

/** Controls live in the shared issue/PR state file; Git movement is confined to remotePath. */
export interface FactoryFeaturePublicationFixtureControls {
  uncertainPullRequestCreate?: boolean;
  hidePullRequests?: boolean;
  closedPullRequests?: boolean;
  foreignPullRequest?: boolean;
  limitedPullRequests?: boolean;
  moveTargetAfterPullRequestCreate?: string;
  moveHeadAfterPullRequestCreate?: string;
  requiredCheckState?: "success" | "pending" | "failure";
  mergeConflict?: boolean;
  uncertainMerge?: boolean;
  failIssueCloseOnce?: boolean;
  auth?: boolean;
  account?: string;
  repositoryId?: number;
}

function replaceOnce(source: string, marker: string, replacement: string): string {
  if (!source.includes(marker) || source.indexOf(marker) !== source.lastIndexOf(marker))
    throw new Error("The issue fixture composition seam changed");
  return source.replace(marker, () => replacement);
}

/** Local subprocess only: no gh forwarding, network client, fetch, or push. */
export function createFactoryFeaturePublicationFixture(
  options: { statePath?: string; remotePath?: string } = {},
): string {
  const observation = String.raw`
const {execFileSync} = require("node:child_process");
const publicationRemotePath = ${JSON.stringify(options.remotePath ?? factoryFeaturePublicationFixtureRemotePath)};
function publicationGit(args) {
  state.gitCalls ??= [];
  const argv = ["--no-lazy-fetch", "-c", "core.hooksPath=/dev/null", "--git-dir=" + publicationRemotePath, ...args];
  state.gitCalls.push({args: argv});
  save();
  try {
    return execFileSync("/usr/bin/git", argv, {
      encoding: "utf8", timeout: 5000, maxBuffer: 65536,
      env: {PATH: process.env.PATH, LANG: "C", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1"},
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch { output(503, {message: "Task-owned publication remote is unavailable"}); }
}
function publicationRef(branch) {
  if (typeof branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,243}$/.test(branch) ||
      branch.startsWith("refs/") || branch.includes("..") || branch.includes("//"))
    output(422, {message: "Invalid fixture branch"});
  const sha = publicationGit(["rev-parse", "--verify", "--end-of-options", "refs/heads/" + branch + "^{commit}"]);
  if (!/^[a-f0-9]{40}$/.test(sha)) output(503, {message: "Task-owned commit is unavailable"});
  return sha;
}
const publicationRepository = {id: Number(state.controls.repositoryId ?? 424242), node_id: "R_fixture", owner: {login: owner}, name};
if (parts.length === 3) {
  if (projection.includes("defaultBranch")) {
    const ref = publicationGit(["symbolic-ref", "--quiet", "HEAD"]);
    if (!ref.startsWith("refs/heads/")) output(503, {message: "Task-owned target branch is unavailable"});
    output(200, {id: String(publicationRepository.id), owner, name, defaultBranch: ref.slice(11)});
  }
  if (projection.includes("node_id")) output(200, publicationRepository);
  output(200, {id: String(publicationRepository.id), owner, name});
}
function observePullRequest(original) {
  const value = {...original,
    state: original.merged || state.controls.closedPullRequests ? "closed" : original.state,
    user: state.controls.foreignPullRequest ? {login: "other", node_id: "U_other"} : original.user,
    base: {...original.base, sha: publicationRef(original.base.ref)},
    head: {...original.head, sha: publicationRef(original.head.ref)},
  };
  if (!projection.includes("authorNodeId")) return value;
  const repository = repo => repo === null ? null : {id: String(repo.id), nodeId: repo.node_id, owner: repo.owner.login, name: repo.name};
  const projected = {id: String(value.id), nodeId: value.node_id, number: value.number, title: value.title, body: value.body,
    state: value.state, html_url: value.html_url, author: value.user.login, authorNodeId: value.user.node_id,
    base: {ref: value.base.ref, sha: value.base.sha, repo: repository(value.base.repo)},
    head: {ref: value.head.ref, sha: value.head.sha, repo: repository(value.head.repo)}};
  return projection.includes("merge_commit_sha") ? {...projected,
    merged: value.merged === true, merge_commit_sha: value.merge_commit_sha ?? null,
    merged_at: value.merged_at ?? null,
    mergeable: value.merged === true ? null : !state.controls.mergeConflict,
    mergeable_state: state.controls.mergeConflict ? "dirty" : value.merged === true ? "unknown" : "clean"} : projected;
}
function movePublicationRef(control, branch) {
  const sha = state.controls[control];
  if (sha === undefined) return;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) output(422, {message: "Invalid fixture movement"});
  publicationGit(["cat-file", "-e", sha + "^{commit}"]);
  publicationGit(["update-ref", "refs/heads/" + branch, sha]);
  delete state.controls[control];
}
if (parts[3] === "pulls") {
  if (parts.length === 4 && method === "POST") {
    if (typeof input?.title !== "string" || typeof input?.body !== "string" || input.maintainer_can_modify !== false)
      output(422, {message: "Invalid fixture PR payload"});
    const baseSha = publicationRef(input.base), headSha = publicationRef(input.head);
    if (input.base === input.head || (!state.controls.closedPullRequests && state.pullRequests.some(pr =>
        pr.state === "open" && pr.base.ref === input.base && pr.head.ref === input.head)))
      output(422, {message: "A fixture PR already exists or has an invalid branch pair"});
    const number = state.nextPullRequest++;
    const pullRequest = {id: 900000 + number, node_id: "PR_fixture_" + number, number,
      title: input.title, body: input.body, state: "open", html_url: repoUrl + "/pull/" + number,
      user: {login: state.controls.account ?? "fixture", node_id: "U_fixture"},
      base: {ref: input.base, sha: baseSha, repo: publicationRepository},
      head: {ref: input.head, sha: headSha, repo: publicationRepository},
      merged: false, merge_commit_sha: null, merged_at: null};
    state.pullRequests.push(pullRequest);
    save();
    movePublicationRef("moveTargetAfterPullRequestCreate", input.base);
    movePublicationRef("moveHeadAfterPullRequestCreate", input.head);
    if (state.controls.uncertainPullRequestCreate) {
      state.controls.uncertainPullRequestCreate = false;
      save();
      process.exit(1);
    }
    output(201, observePullRequest(pullRequest));
  }
  if (parts.length === 6 && parts[5] === "merge" && method === "PUT") {
    const pullRequest = state.pullRequests.find(pr => String(pr.number) === parts[4]);
    if (!pullRequest) output(404, {message: "Not found"});
    if (pullRequest.merged) output(200, {merged: true, sha: pullRequest.merge_commit_sha, message: "Already merged"});
    const headSha = publicationRef(pullRequest.head.ref);
    if (input?.sha !== headSha) output(409, {message: "Head branch was modified"});
    if (state.controls.mergeConflict) output(405, {message: "Pull Request is not mergeable"});
    publicationGit(["update-ref", "refs/heads/" + pullRequest.base.ref, headSha]);
    pullRequest.state = "closed";
    pullRequest.merged = true;
    pullRequest.merge_commit_sha = headSha;
    pullRequest.merged_at = "2026-09-20T10:00:00.000Z";
    save();
    if (state.controls.uncertainMerge) {
      state.controls.uncertainMerge = false;
      save();
      process.exit(1);
    }
    output(200, {merged: true, sha: headSha, message: "Pull Request successfully merged"});
  }
  if (method !== "GET") output(422, {message: "Fixture prohibits other PR mutations"});
  const visible = state.controls.hidePullRequests ? [] : state.pullRequests;
  if (parts.length === 5) {
    const value = visible.find(pr => String(pr.number) === parts[4]);
    if (!value) output(404, {message: "Not found"});
    output(200, observePullRequest(value));
  }
  if (parts.length !== 4) output(404, {message: "Not found"});
  const page = Number(uri.searchParams.get("page") ?? 1), size = Number(uri.searchParams.get("per_page") ?? 20);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000 || !Number.isSafeInteger(size) || size < 1 || size > 20 || args.includes("--paginate"))
    output(422, {message: "Fixture PR reads must be bounded"});
  const requestedState = uri.searchParams.get("state") ?? "open";
  const values = visible.filter(pr => requestedState === "all" ||
    (state.controls.closedPullRequests ? "closed" : pr.state) === requestedState).toReversed();
  const headers = state.controls.limitedPullRequests || values.length > page * size
    ? {Link: "<" + apiUrl + "/pulls?state=" + requestedState + "&per_page=" + size + "&page=" + (page + 1) + '>; rel="next"'} : {};
  output(200, values.slice((page - 1) * size, page * size).map(observePullRequest), headers);
}
if (parts[3] === "branches" && parts.length === 5 && method === "GET") {
  const branch = decodeURIComponent(parts[4]);
  publicationRef(branch);
  output(200, {name: branch, protected: true,
    requiredContexts: ["fixture-ci"]});
}
if (parts[3] === "commits" && parts[5] === "status" && method === "GET") {
  const commit = parts[4], stateValue = state.controls.requiredCheckState ?? "success";
  if (!/^[a-f0-9]{40}$/.test(commit)) output(422, {message: "Invalid commit"});
  publicationGit(["cat-file", "-e", commit + "^{commit}"]);
  output(200, {state: stateValue, statuses: [{context: "fixture-ci", state: stateValue}]});
}
if (parts[3] === "commits" && parts[5] === "check-runs" && method === "GET") {
  output(200, {check_runs: []});
}
`;
  let script = replaceOnce(
    factoryGitHubFixture,
    JSON.stringify(factoryFeaturePublicationFixtureStatePath),
    JSON.stringify(options.statePath ?? factoryFeaturePublicationFixtureStatePath),
  );
  script = replaceOnce(
    script,
    "state.calls.push({ args, method, endpoint, input });",
    String.raw`
state.calls.push({ args, method, endpoint, input });
state.pullRequests ??= [];
state.nextPullRequest ??= 300;
state.writes ??= [];
state.gitCalls ??= [];
if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) state.writes.push({args, method, endpoint, input});
`,
  );
  script = replaceOnce(
    script,
    String.raw`if (parts.length === 5) {
  if (method !== "GET") output(422, { message: "Fixture prohibits issue mutation" });
  output(200, projectIssue(issue));
}`,
    String.raw`if (parts.length === 5) {
  if (method === "PATCH") {
    if (input?.state !== "closed" || input?.state_reason !== "completed")
      output(422, {message: "Invalid issue close payload"});
    if (state.controls.failIssueCloseOnce) {
      state.controls.failIssueCloseOnce = false;
      save();
      output(503, {message: "Controlled issue close failure"});
    }
    issue.state = "closed";
    issue.closed_at = issue.closed_at ?? "2026-09-20T10:01:00.000Z";
    output(200, projectIssue(issue));
  }
  if (method !== "GET") output(422, { message: "Fixture prohibits issue mutation" });
  output(200, projectIssue(issue));
}`,
  );
  script = replaceOnce(
    script,
    "function output(status, body, headers = {}) {",
    "save();\nfunction output(status, body, headers = {}) {",
  );
  script = replaceOnce(
    script,
    'if (status < 400 && projection.includes("issue_url")) {',
    String.raw`if (status < 400 && projection.includes("closed_at") && projection.includes("repository_url")) {
    const project = ({id,number,state,closed_at,html_url,repository_url,isPullRequest}) =>
      ({id,number,state,closed_at:closed_at ?? null,html_url,repository_url,isPullRequest});
    body = Array.isArray(body) ? body.map(project) : project(body);
  } else if (status < 400 && projection.includes("issue_url")) {`,
  );
  script = replaceOnce(
    script,
    'if (endpoint === "/user") output(200, { login: "fixture" });',
    'if (endpoint === "/user") output(200, { login: state.controls.account ?? "fixture" });',
  );
  return replaceOnce(
    script,
    String.raw`if (parts.length === 3) {
  if (projection.includes("node_id")) output(200, { id: 424242, node_id: "R_fixture", name, owner: { login: owner } });
  output(200, { id: String(state.controls.repositoryId ?? 424242), owner, name });
}`,
    observation,
  );
}

export const factoryFeaturePublicationFixture = createFactoryFeaturePublicationFixture();
