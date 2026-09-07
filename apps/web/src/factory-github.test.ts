import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFactoryGitHubAdapter,
  FactoryGitHubError,
  type FactoryGitHubIdentity,
} from "./factory-github.js";

const identity: FactoryGitHubIdentity = {
  repository: { id: "41", owner: "owner", name: "notes" },
  account: "operator",
};
const directories: string[] = [];
const marker = "<!-- kestrel-publication:v1:fixture-operation -->";

async function fixture(mode = "ok") {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-factory-gh-"));
  directories.push(directory);
  const executable = join(directory, "gh.mjs");
  const initial = {
    mode,
    userReads: 0,
    issuePosts: 0,
    issueReads: 0,
    commentPosts: 0,
    dependencyPosts: 0,
    issues: [
      {
        id: "501",
        number: 1,
        title: "Existing note export",
        body: "Operator body",
        state: "open",
        html_url: "https://github.com/owner/notes/issues/1",
        repository_url: "https://api.github.com/repos/owner/notes",
        isPullRequest: false,
        author: "operator",
      },
    ],
    comments: [],
    dependencies: [],
  };
  await writeFile(join(directory, "state.json"), JSON.stringify(initial));
  const source = `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const statePath = join(directory, 'state.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const body = input === '' ? null : JSON.parse(input);
appendFileSync(join(directory, 'calls.jsonl'), JSON.stringify({ args, body, tokenPresent: ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','KESTREL_FIXTURE_SECRET'].some(key => process.env[key] !== undefined) }) + '\\n');
function reply(status, value, headers = {}) {
  writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write('HTTP/2.0 ' + status + ' Fixture\\r\\n' + Object.entries(headers).map(([key,value]) => key + ': ' + value + '\\r\\n').join('') + '\\r\\n' + JSON.stringify(value) + '\\n');
  process.exit(status >= 400 ? 1 : 0);
}
function hang() { writeFileSync(statePath, JSON.stringify(state)); setTimeout(() => process.exit(0), 10000); }
function dependency(value) { return {id:value.id,number:value.number,title:value.title,html_url:value.html_url,isPullRequest:value.isPullRequest}; }
if (args[0] === 'version') { process.stdout.write('gh version 2.86.0 (fixture)\\n'); process.exit(0); }
if (args[0] !== 'api' || args[1] !== '--hostname' || args[2] !== 'github.com') reply(400, {message:'unexpected command'});
const url = new URL(args[3], 'https://api.github.com');
const method = args[args.indexOf('--method') + 1];
if (url.pathname === '/user') {
  if (state.mode === 'cli_authentication') { process.stderr.write('To get started with GitHub CLI, please run gh auth login.'); process.exit(4); }
  state.userReads++;
  reply(200, {login: (state.mode === 'account_drift' && state.userReads >= 2) || (state.mode === 'account_after_write' && state.issuePosts > 0) ? 'other' : 'operator'});
}
if (url.pathname === '/repos/owner/notes') reply(200, {id: state.mode === 'repository_changed' || state.mode === 'repository_after_write' && state.issuePosts > 0 || state.mode === 'repository_after_read' && state.issueReads > 0 ? '42' : '41', owner:'owner', name:'notes'});
const base = '/repos/owner/notes/issues';
if (url.pathname === base && method === 'GET') {
  state.issueReads++;
  const page = Number(url.searchParams.get('page') ?? 1);
  if (state.mode === 'hostile_link') reply(200, [], {Link:'<https://attacker.invalid/issues?page=2>; rel="next"'});
  if (state.mode === 'limited') {
    const issues = Array.from({length:20}, (_, index) => {
      const number = 1000 + (page - 1) * 20 + index;
      return {...state.issues[0], id:String(number + 10000), number, body:'Older unrelated issue', isPullRequest:index % 3 === 1, html_url:'https://github.com/owner/notes/issues/' + number};
    });
    if (page === 1) state.issues.slice(-20).reverse().forEach((issue, index) => { issues[index] = issue; });
    reply(200, issues, {Link:'<https://api.github.com/repositories/41/issues?state=all&per_page=20&page=' + (page + 1) + '>; rel="next"'});
  }
  if (state.mode === 'pagination') {
    if (page === 1) reply(200, [state.issues[0], {...state.issues[0], id:'502', number:2, isPullRequest:true, html_url:'https://github.com/owner/notes/pull/2'}], {Link:'<https://api.github.com/repositories/41/issues?state=open&sort=created&direction=desc&per_page=20&page=2>; rel="next"'});
    reply(200, [{...state.issues[0], id:'503', number:3, title:'Second page', html_url:'https://github.com/owner/notes/issues/3'}]);
  }
  reply(200, state.mode === 'empty_reconcile' ? [] : state.issues);
}
if (url.pathname === base && method === 'POST') {
  state.issuePosts++;
  if (state.mode === 'rate_limited') reply(403, {message:'API rate limit exceeded'}, {'Retry-After':'120'});
  if (state.mode === 'not_authenticated') reply(401, {message:'Bad credentials ghp_never_expose'});
  if (state.mode === 'not_authenticated_plain') { writeFileSync(statePath, JSON.stringify(state)); process.stdout.write('HTTP/2.0 401 Unauthorized\\r\\n\\r\\nprivate non-JSON provider error'); process.exit(1); }
  if (state.mode === 'server_error') reply(503, {message:'private provider error'});
  const issue = {...state.issues[0], id:'599', number:99, title:body.title, body:body.body, html_url:'https://github.com/owner/notes/issues/99'};
  state.issues.push(issue);
  if (state.mode === 'create_timeout') hang();
  else if (state.mode === 'disconnected') { writeFileSync(statePath, JSON.stringify(state)); process.stderr.write('private provider transport failed'); process.exit(1); }
  else if (state.mode === 'stdout_overflow') { writeFileSync(statePath, JSON.stringify(state)); process.stdout.write('x'.repeat(3 * 1024 * 1024)); }
  else if (state.mode === 'stderr_overflow') { writeFileSync(statePath, JSON.stringify(state)); process.stderr.write('x'.repeat(64 * 1024)); }
  else if (state.mode === 'invalid_created') reply(201, {id:null});
  else reply(201, issue);
} else if (/\\/issues\\/\\d+\\/dependencies\\/blocked_by$/.test(url.pathname)) {
  if (state.mode === 'unsupported' || state.mode === 'unsupported_write' && method === 'POST') reply(501, {message:'Not implemented'});
  if (state.mode === 'masked_notfound') reply(404, {message:'Not Found'});
  if (method === 'GET') reply(200, state.dependencies.map(dependency));
  if (method === 'POST') {
    state.dependencyPosts++;
    if (state.mode !== 'dependency_invalid') state.dependencies.push({...state.issues[0], id:String(body.issue_id)});
    if (state.mode === 'dependency_duplicate' || state.mode === 'dependency_invalid') reply(422, {message:'Validation Failed'});
    if (state.mode === 'dependency_timeout') hang(); else reply(201, dependency(state.dependencies[0]));
  }
} else if (/\\/issues\\/\\d+\\/comments$/.test(url.pathname)) {
  if (method === 'GET') {
    if (state.mode === 'comment_limited') {
      const page = Number(url.searchParams.get('page'));
      const comments = Array.from({length:20}, (_, index) => {
        const id = String(1000 + (page - 1) * 20 + index);
        return {id,body:'Unrelated comment',html_url:'https://github.com/owner/notes/issues/1#issuecomment-' + id,issue_url:'https://api.github.com/repos/owner/notes/issues/1',author:'operator'};
      });
      if (page === 1) state.comments.slice(0, 20).forEach((comment, index) => { comments[index] = comment; });
      reply(200, comments, {Link:'<https://api.github.com/repositories/41/issues/1/comments?per_page=20&page=' + (page + 1) + '>; rel="next"'});
    }
    reply(200, state.comments);
  }
  if (method === 'POST') {
    state.commentPosts++;
    const number = Number(url.pathname.split('/').at(-2));
    const comment = {id:'701', body:body.body, html_url:'https://github.com/owner/notes/issues/' + number + '#issuecomment-701', issue_url:'https://api.github.com/repos/owner/notes/issues/' + number, author:'operator'};
    state.comments.push(comment);
    if (state.mode === 'comment_timeout') hang(); else reply(201, comment);
  }
} else if (/\\/issues\\/comments\\/\\d+$/.test(url.pathname)) {
  const comment = state.comments.find(comment => comment.id === url.pathname.split('/').at(-1));
  if (!comment) reply(404, {message:'Not Found'});
  if (method === 'PATCH') comment.body = body.body;
  reply(200, comment);
} else if (/\\/issues\\/\\d+$/.test(url.pathname) && method === 'GET') {
  const issue = state.issues.find(issue => String(issue.number) === url.pathname.split('/').at(-1));
  reply(issue ? 200 : 404, issue ?? {message:'Not Found'});
} else reply(400, {message:'unexpected endpoint'});
`;
  await writeFile(executable, source, { mode: 0o700 });
  const state = async (): Promise<typeof initial> =>
    JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as typeof initial;
  const waitForPost = async () => {
    const deadline = performance.now() + 4_000;
    while (performance.now() < deadline) {
      const current = await state().catch(() => undefined);
      if (
        current !== undefined &&
        current.issuePosts + current.commentPosts + current.dependencyPosts === 1
      )
        return;
      await delay(20);
    }
    throw new Error("Fixture did not persist its POST before the readiness deadline");
  };
  return {
    adapter: createFactoryGitHubAdapter({ executable }),
    state,
    waitForPost,
    expireAfterPost: async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      // Freeze only the parent deadline; the fixture remains a real subprocess.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const controller = new AbortController();
      const pending = operation(controller.signal);
      try {
        await waitForPost();
        await vi.runOnlyPendingTimersAsync();
        return await pending;
      } finally {
        controller.abort();
        await pending.catch(() => undefined);
        vi.useRealTimers();
      }
    },
    calls: async (): Promise<Array<{ args: string[]; body: unknown; tokenPresent: boolean }>> => {
      return (await readFile(join(directory, "calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as { args: string[]; body: unknown; tokenPresent: boolean },
        );
    },
    setState: async (changes: Record<string, unknown>) => {
      const current: unknown = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
      if (typeof current !== "object" || current === null) throw new Error("Fixture state missing");
      await writeFile(join(directory, "state.json"), JSON.stringify({ ...current, ...changes }));
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Factory GitHub subprocess boundary", () => {
  it("captures repository/account identity and reads bounded pages excluding pull requests", async () => {
    const { adapter, calls } = await fixture("pagination");
    expect(await adapter.identify({ owner: "owner", name: "notes" })).toEqual(identity);
    const first = await adapter.listIssues(identity, 1);
    expect(first).toMatchObject({
      page: 1,
      nextPage: 2,
      limited: false,
      issues: [{ id: "501", number: 1, body: "Operator body", dependencies: null }],
    });
    const second = await adapter.listIssues(identity, 2);
    expect(second).toMatchObject({ page: 2, nextPage: null, issues: [{ id: "503", number: 3 }] });
    const requests = await calls();
    expect(requests.every((call) => call.args[0] === "version" || call.args.includes("GET"))).toBe(
      true,
    );
    expect(requests.some((call) => call.args.some((arg) => arg.includes("per_page=20")))).toBe(
      true,
    );
    expect(requests.some((call) => call.args.includes("--paginate"))).toBe(false);
  });

  it("sends issue payload as JSON stdin and confirms the captured repository and account", async () => {
    const { adapter, calls } = await fixture();
    const input = { title: "Approved export", body: "First line\n`literal` $(literal)\n" + marker };
    expect(await adapter.createIssue(identity, input)).toMatchObject({
      state: "confirmed",
      value: { id: "599", number: 99, ...input },
    });
    const posts = (await calls()).filter((call) => call.args.includes("POST"));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual(input);
    expect(posts[0]?.args).toContain("--input");
    expect(posts[0]?.args).not.toContain(input.body);
  });

  it("reconciles a timed-out create without issuing another POST, including closed issues", async () => {
    const { adapter, calls, state, setState, expireAfterPost } = await fixture("create_timeout");
    expect(
      await expireAfterPost((signal) =>
        adapter.createIssue(identity, { title: "Approved export", body: marker }, signal),
      ),
    ).toEqual({ state: "uncertain", failure: "timeout" });
    const persisted = await state();
    await setState({ issues: persisted.issues.map((issue) => ({ ...issue, state: "closed" })) });
    expect(await adapter.findIssue(identity, marker)).toMatchObject({
      state: "found",
      value: { id: "599", state: "closed" },
    });
    expect((await calls()).filter((call) => call.args.includes("POST"))).toHaveLength(1);
    expect((await calls()).some((call) => call.args.some((arg) => arg.includes("state=all")))).toBe(
      true,
    );
  });

  it.each([
    ["invalid_created", "uncertain", "invalid_response"],
    ["server_error", "uncertain", "unavailable"],
    ["not_authenticated", "rejected", "needs_authentication"],
    ["not_authenticated_plain", "rejected", "needs_authentication"],
    ["repository_changed", "not_sent", "repository_changed"],
    ["account_drift", "not_sent", "access_denied"],
  ])("classifies %s without exposing provider error content", async (mode, state, failure) => {
    const { adapter, calls } = await fixture(mode);
    const result = await adapter.createIssue(identity, { title: "Export", body: marker });
    expect(result).toEqual({ state, failure });
    expect(JSON.stringify(result)).not.toMatch(/ghp_|private provider/u);
    expect((await calls()).filter((call) => call.args.includes("POST"))).toHaveLength(
      state === "not_sent" ? 0 : 1,
    );
  });

  it("retains a rate limit deadline and never automatically retries the rejected request", async () => {
    const { adapter, calls } = await fixture("rate_limited");
    const before = Date.now();
    const result = await adapter.createIssue(identity, { title: "Export", body: marker });
    expect(result).toMatchObject({ state: "rejected", failure: "rate_limited" });
    if (result.state === "confirmed" || result.retryAt === undefined)
      throw new Error("Expected retry deadline");
    expect(Date.parse(result.retryAt)).toBeGreaterThanOrEqual(before + 120_000);
    expect((await calls()).filter((call) => call.args.includes("POST"))).toHaveLength(1);
  });

  it.each(["empty_reconcile", "limited"])(
    "keeps %s reconciliation read-only and bounded",
    async (mode) => {
      const { adapter, calls } = await fixture(mode);
      expect(await adapter.findIssue(identity, marker)).toEqual({
        state: mode === "limited" ? "limited" : "missing",
      });
      const requests = await calls();
      expect(
        requests.filter((call) => call.args.some((arg) => arg.includes("/issues?"))),
      ).toHaveLength(mode === "limited" ? 5 : 1);
      expect(requests.some((call) => call.args.includes("POST"))).toBe(false);
    },
  );

  it.each(["issue", "comment"])(
    "reconciles one owned %s marker after a lost create response even when older history exceeds the scan limit",
    async (kind) => {
      const { adapter, calls, setState, expireAfterPost } = await fixture(
        kind === "issue" ? "create_timeout" : "comment_timeout",
      );
      const result = await expireAfterPost((signal) =>
        kind === "issue"
          ? adapter.createIssue(identity, { title: "Approved export", body: marker }, signal)
          : adapter.createComment(identity, 1, marker, signal),
      );
      expect(result).toEqual({ state: "uncertain", failure: "timeout" });
      await setState({ mode: kind === "issue" ? "limited" : "comment_limited" });
      const found =
        kind === "issue"
          ? await adapter.findIssue(identity, marker)
          : await adapter.findComment(identity, 1, marker);
      expect(found).toMatchObject({
        state: "found",
        value: { id: kind === "issue" ? "599" : "701", body: marker },
      });
      const requests = await calls();
      expect(requests.filter((call) => call.args.includes("POST"))).toHaveLength(1);
      expect(
        requests.filter((call) => call.args.some((arg) => arg.includes("per_page=20"))),
      ).toHaveLength(5);
    },
  );

  it.each(["foreign", "duplicate"])(
    "keeps a %s marker ambiguous when the issue scan is limited",
    async (kind) => {
      const { adapter, calls, state, setState } = await fixture("limited");
      const first = (await state()).issues[0];
      const issues =
        kind === "foreign"
          ? [{ ...first, body: marker, author: "other" }]
          : [
              { ...first, body: marker },
              {
                ...first,
                body: marker,
                id: "502",
                number: 2,
                html_url: "https://github.com/owner/notes/issues/2",
              },
            ];
      await setState({ issues });
      expect(await adapter.findIssue(identity, marker)).toEqual({ state: "ambiguous" });
      expect((await calls()).some((call) => call.args.includes("POST"))).toBe(false);
    },
  );

  it("reports duplicate exact markers as ambiguous and refuses foreign pagination links", async () => {
    const { adapter, state, setState } = await fixture();
    const first = (await state()).issues[0];
    await setState({
      issues: [
        { ...first, body: marker },
        {
          ...first,
          id: "502",
          number: 2,
          body: marker,
          html_url: "https://github.com/owner/notes/issues/2",
        },
      ],
    });
    expect(await adapter.findIssue(identity, marker)).toEqual({ state: "ambiguous" });
    await setState({ mode: "hostile_link" });
    await expect(adapter.listIssues(identity, 1)).rejects.toMatchObject({
      failure: "invalid_response",
    });
  });

  it("reads selected open issues with native dependencies and rejects closed issues or pull requests", async () => {
    const { adapter, state, setState } = await fixture();
    const first = (await state()).issues[0];
    await setState({
      dependencies: [
        { ...first, id: "500", number: 10, html_url: "https://github.com/owner/notes/issues/10" },
      ],
    });
    expect(await adapter.readIssue(identity, 1)).toMatchObject({
      id: "501",
      dependencies: [{ id: "500", number: 10 }],
    });
    await setState({ issues: [{ ...first, state: "closed" }] });
    await expect(adapter.readIssue(identity, 1)).rejects.toBeInstanceOf(FactoryGitHubError);
    await setState({ issues: [{ ...first, isPullRequest: true }] });
    await expect(adapter.readIssue(identity, 1)).rejects.toBeInstanceOf(FactoryGitHubError);
  });

  it("does not POST an existing native dependency and confirms a duplicate only by reading it", async () => {
    const { adapter, state, calls, setState } = await fixture("dependency_duplicate");
    expect(await adapter.addDependency(identity, 1, "500")).toEqual({
      state: "confirmed",
      value: null,
    });
    expect(await adapter.addDependency(identity, 1, "500")).toEqual({
      state: "confirmed",
      value: null,
    });
    expect((await calls()).filter((call) => call.args.includes("POST"))).toMatchObject([
      { body: { issue_id: 500 } },
    ]);
    expect((await state()).dependencyPosts).toBe(1);
    await setState({ mode: "dependency_invalid", dependencies: [] });
    expect(await adapter.addDependency(identity, 1, "500")).toEqual({
      state: "rejected",
      failure: "invalid_response",
    });
  });

  it("exposes native fallback only with explicit unsupported evidence", async () => {
    const { adapter, setState } = await fixture("unsupported");
    expect(await adapter.readDependencies(identity, 1)).toEqual({ state: "unsupported" });
    expect(await adapter.readIssue(identity, 1)).toMatchObject({ dependencies: null });
    expect(await adapter.addDependency(identity, 1, "500")).toEqual({ state: "unsupported" });
    await setState({ mode: "masked_notfound" });
    await expect(adapter.readDependencies(identity, 1)).rejects.toMatchObject({
      failure: "access_denied",
    });
    expect(await adapter.addDependency(identity, 1, "500")).toEqual({
      state: "not_sent",
      failure: "access_denied",
    });
  });

  it("reconciles one uncertain comment and updates its captured id without changing or closing the issue", async () => {
    const { adapter, calls, state, expireAfterPost } = await fixture("comment_timeout");
    expect(
      await expireAfterPost((signal) => adapter.createComment(identity, 1, marker, signal)),
    ).toEqual({
      state: "uncertain",
      failure: "timeout",
    });
    const found = await adapter.findComment(identity, 1, marker);
    expect(found).toMatchObject({ state: "found", value: { id: "701", body: marker } });
    if (found.state !== "found") throw new Error("Missing retained comment");
    const body = marker + "\nStatus: In progress\nDepends on #10";
    expect(await adapter.updateComment(identity, 1, found.value.id, body)).toEqual({
      state: "confirmed",
      value: { ...found.value, body },
    });
    expect((await state()).issues[0]).toMatchObject({ body: "Operator body", state: "open" });
    const mutations = (await calls()).filter(
      (call) => call.args.includes("POST") || call.args.includes("PATCH"),
    );
    expect(mutations).toMatchObject([{ body: { body: marker } }, { body: { body } }]);
    expect(mutations[1]?.args[3]).toBe("/repos/owner/notes/issues/comments/701");
    expect(
      mutations.every(
        (call) => !call.args.includes("--state") && !JSON.stringify(call.body).includes('"state"'),
      ),
    ).toBe(true);
  });

  it("does not overwrite a captured comment belonging to another issue or author", async () => {
    const { adapter, calls, setState } = await fixture();
    await setState({
      comments: [
        {
          id: "701",
          body: marker,
          html_url: "https://github.com/owner/notes/issues/2#issuecomment-701",
          issue_url: "https://api.github.com/repos/owner/notes/issues/2",
          author: "operator",
        },
      ],
    });
    expect(await adapter.updateComment(identity, 1, "701", marker + "\nReady")).toEqual({
      state: "not_sent",
      failure: "invalid_response",
    });
    await setState({
      comments: [
        {
          id: "701",
          body: marker,
          html_url: "https://github.com/owner/notes/issues/1#issuecomment-701",
          issue_url: "https://api.github.com/repos/owner/notes/issues/1",
          author: "other",
        },
      ],
    });
    expect(await adapter.updateComment(identity, 1, "701", marker + "\nReady")).toEqual({
      state: "not_sent",
      failure: "access_denied",
    });
    expect(await adapter.findComment(identity, 1, marker)).toEqual({ state: "ambiguous" });
    expect((await calls()).some((call) => call.args.includes("PATCH"))).toBe(false);
  });

  it("matches a complete marker line only and preserves missing comment reconciliation", async () => {
    const { adapter, setState, calls } = await fixture();
    expect(await adapter.findComment(identity, 1, marker)).toEqual({ state: "missing" });
    await setState({
      comments: [
        {
          id: "701",
          body: "Quoted " + marker,
          html_url: "https://github.com/owner/notes/issues/1#issuecomment-701",
          issue_url: "https://api.github.com/repos/owner/notes/issues/1",
          author: "operator",
        },
      ],
    });
    expect(await adapter.findComment(identity, 1, marker)).toEqual({ state: "missing" });
    expect((await calls()).some((call) => call.args.includes("POST"))).toBe(false);
  });

  it("rejects a repository replacement during an issue page read", async () => {
    const { adapter } = await fixture("repository_after_read");
    await expect(adapter.listIssues(identity, 1)).rejects.toMatchObject({
      failure: "repository_changed",
    });
  });

  it.each([
    ["account_after_write", "access_denied"],
    ["repository_after_write", "repository_changed"],
  ])("preserves an uncertain create if %s changes the captured identity", async (mode, failure) => {
    const { adapter, state } = await fixture(mode);
    expect(await adapter.createIssue(identity, { title: "Export", body: marker })).toEqual({
      state: "uncertain",
      failure,
    });
    expect((await state()).issuePosts).toBe(1);
  });

  it("classifies the CLI authentication-required exit without a provider write", async () => {
    const { adapter, calls } = await fixture("cli_authentication");
    expect(await adapter.createIssue(identity, { title: "Export", body: marker })).toEqual({
      state: "not_sent",
      failure: "needs_authentication",
    });
    expect((await calls()).some((call) => call.args.includes("POST"))).toBe(false);
  });

  it.each(["disconnected", "stdout_overflow", "stderr_overflow"])(
    "bounds %s output and preserves write uncertainty",
    async (mode) => {
      const { adapter, state } = await fixture(mode);
      expect(await adapter.createIssue(identity, { title: "Export", body: marker })).toEqual({
        state: "uncertain",
        failure: "invalid_response",
      });
      expect((await state()).issuePosts).toBe(1);
    },
  );

  it("distinguishes cancellation before dispatch from cancellation after the request was persisted remotely", async () => {
    const { adapter, state, waitForPost } = await fixture("create_timeout");
    expect(
      await adapter.createIssue(identity, { title: "Export", body: marker }, AbortSignal.abort()),
    ).toEqual({ state: "not_sent", failure: "cancelled" });
    expect((await state()).issuePosts).toBe(0);
    const controller = new AbortController();
    const pending = adapter.createIssue(
      identity,
      { title: "Export", body: marker },
      controller.signal,
    );
    try {
      await waitForPost();
    } finally {
      controller.abort();
    }
    expect(await pending).toEqual({ state: "uncertain", failure: "cancelled" });
  });

  it("does not inherit token overrides or unrelated secrets into the host CLI", async () => {
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "KESTREL_FIXTURE_SECRET",
    ])
      vi.stubEnv(name, "fixture-only-do-not-inherit");
    const { adapter, calls } = await fixture();
    expect(await adapter.createComment(identity, 1, marker)).toMatchObject({ state: "confirmed" });
    expect((await calls()).every((call) => !call.tokenPresent)).toBe(true);
  });

  it("bounds a partial comment scan and refuses ambiguous duplicate comments", async () => {
    const { adapter, calls, setState } = await fixture("comment_limited");
    expect(await adapter.findComment(identity, 1, marker)).toEqual({ state: "limited" });
    expect(
      (await calls()).filter((call) => call.args.some((arg) => arg.includes("/comments?"))),
    ).toHaveLength(5);
    await setState({
      mode: "ok",
      comments: ["701", "702"].map((id) => ({
        id,
        body: marker,
        html_url: `https://github.com/owner/notes/issues/1#issuecomment-${id}`,
        issue_url: "https://api.github.com/repos/owner/notes/issues/1",
        author: "operator",
      })),
    });
    expect(await adapter.findComment(identity, 1, marker)).toEqual({ state: "ambiguous" });
    expect((await calls()).some((call) => call.args.includes("POST"))).toBe(false);
  });

  it("confirms an uncertain native edge by rereading and accepts an explicit POST capability failure", async () => {
    const { adapter, calls, setState, expireAfterPost } = await fixture("dependency_timeout");
    expect(
      await expireAfterPost((signal) => adapter.addDependency(identity, 1, "500", signal)),
    ).toEqual({
      state: "confirmed",
      value: null,
    });
    expect((await calls()).filter((call) => call.args.includes("POST"))).toHaveLength(1);
    await setState({ mode: "unsupported_write", dependencies: [] });
    expect(await adapter.addDependency(identity, 1, "500")).toEqual({ state: "unsupported" });
  });
});
