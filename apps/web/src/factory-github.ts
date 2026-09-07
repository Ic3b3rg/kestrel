import { z } from "zod";

import {
  FactoryGitHubIssueSchema,
  FactoryGitHubRepositorySchema,
  type FactoryGitHubIssue,
  type FactoryGitHubRepository,
  type FactoryProviderFailure,
} from "@kestrel/contracts";

import { runFactoryGitHubCli } from "./factory-github-cli.js";

export interface FactoryGitHubIdentity {
  repository: FactoryGitHubRepository;
  account: string;
}
export interface FactoryGitHubComment {
  id: string;
  body: string;
  url: string;
}
export type WriteResult<T> =
  | { state: "confirmed"; value: T }
  | {
      state: "rejected" | "not_sent" | "uncertain";
      failure: FactoryProviderFailure;
      retryAt?: string;
    };
export type Reconciliation<T> =
  { state: "found"; value: T } | { state: "missing" | "limited" | "ambiguous" };
type Dependencies = NonNullable<FactoryGitHubIssue["dependencies"]>;
type Unsupported = { state: "unsupported" };
type WriteFailure = Exclude<WriteResult<never>, { state: "confirmed" }>;
export interface FactoryGitHubAdapter {
  identify(
    coordinates: Pick<FactoryGitHubRepository, "owner" | "name">,
    signal?: AbortSignal,
  ): Promise<FactoryGitHubIdentity>;
  listIssues(
    identity: FactoryGitHubIdentity,
    page: number,
    signal?: AbortSignal,
  ): Promise<{
    issues: FactoryGitHubIssue[];
    page: number;
    nextPage: number | null;
    limited: boolean;
  }>;
  readIssue(
    identity: FactoryGitHubIdentity,
    number: number,
    signal?: AbortSignal,
  ): Promise<FactoryGitHubIssue>;
  createIssue(
    identity: FactoryGitHubIdentity,
    input: { title: string; body: string },
    signal?: AbortSignal,
  ): Promise<WriteResult<FactoryGitHubIssue>>;
  findIssue(
    identity: FactoryGitHubIdentity,
    marker: string,
    signal?: AbortSignal,
  ): Promise<Reconciliation<FactoryGitHubIssue>>;
  readDependencies(
    identity: FactoryGitHubIdentity,
    issueNumber: number,
    signal?: AbortSignal,
  ): Promise<{ state: "supported"; dependencies: Dependencies } | Unsupported>;
  addDependency(
    identity: FactoryGitHubIdentity,
    issueNumber: number,
    blockingIssueId: string,
    signal?: AbortSignal,
  ): Promise<WriteResult<null> | Unsupported>;
  createComment(
    identity: FactoryGitHubIdentity,
    issueNumber: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<WriteResult<FactoryGitHubComment>>;
  findComment(
    identity: FactoryGitHubIdentity,
    issueNumber: number,
    marker: string,
    signal?: AbortSignal,
  ): Promise<Reconciliation<FactoryGitHubComment>>;
  updateComment(
    identity: FactoryGitHubIdentity,
    issueNumber: number,
    commentId: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<WriteResult<FactoryGitHubComment>>;
}

export class FactoryGitHubError extends Error {
  constructor(
    public readonly failure: FactoryProviderFailure,
    public readonly retryAt?: string,
  ) {
    super(`Factory GitHub operation failed: ${failure}`);
    this.name = "FactoryGitHubError";
  }
}

const providerId = z
  .string()
  .regex(/^[1-9][0-9]*$/u)
  .max(32);
const numberSchema = z.int().positive().max(2_147_483_647);
const AccountSchema = z.strictObject({ login: z.string().min(1).max(100) });
const IssueSchema = z.strictObject({
  id: providerId,
  number: numberSchema,
  title: z.string().min(1).max(512),
  body: z.string().max(65_536).nullable(),
  state: z.enum(["open", "closed"]),
  html_url: z.string().max(512),
  repository_url: z.string().max(512),
  isPullRequest: z.boolean(),
  author: z.string().max(100).nullable(),
});
type ProviderIssue = z.infer<typeof IssueSchema>;
const ISSUE_FIELDS =
  '{id:(.id|tostring),number,title,body,state,html_url,repository_url,isPullRequest:has("pull_request"),author:.user.login}';
const issueProjection = `if type == "array" then map(${ISSUE_FIELDS}) elif has("message") then {message} else ${ISSUE_FIELDS} end`;
const DependencySchema = IssueSchema.pick({
  id: true,
  number: true,
  title: true,
  html_url: true,
  isPullRequest: true,
});
const DEPENDENCY_FIELDS =
  '{id:(.id|tostring),number,title,html_url,isPullRequest:has("pull_request")}';
const dependencyProjection = `if type == "array" then map(${DEPENDENCY_FIELDS}) elif has("message") then {message} else ${DEPENDENCY_FIELDS} end`;
const repositoryProjection =
  'if has("message") then {message} else {id:(.id|tostring),owner:.owner.login,name} end';
const accountProjection = 'if has("message") then {message} else {login} end';
const CommentSchema = z.strictObject({
  id: providerId,
  body: z.string().max(65_536),
  html_url: z.string().max(512),
  issue_url: z.string().max(512),
  author: z.string().max(100).nullable(),
});
const COMMENT_FIELDS = "{id:(.id|tostring),body,html_url,issue_url,author:.user.login}";
const commentProjection = `if type == "array" then map(${COMMENT_FIELDS}) elif has("message") then {message} else ${COMMENT_FIELDS} end`;
const CommentBodySchema = z.string().min(1).max(65_536);
const MarkerSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\r\n]/u.test(value));
interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
interface WriteRequest<T> {
  endpoint: string;
  projection: string;
  method: "POST" | "PATCH";
  input: string;
  status: number;
  decode: (value: unknown) => T;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new FactoryGitHubError("invalid_response");
  }
}

function failedWrite(state: WriteFailure["state"], error: unknown): WriteFailure {
  const failure =
    error instanceof FactoryGitHubError ? error : new FactoryGitHubError("invalid_response");
  return {
    state,
    failure: failure.failure,
    ...(failure.retryAt === undefined ? {} : { retryAt: failure.retryAt }),
  };
}

function hasMarker(body: string | null, marker: string): boolean {
  return (body ?? "").split(/\r?\n/u).includes(marker);
}

function response(stdout: string): HttpResponse {
  const separator = /\r?\n\r?\n/u.exec(stdout);
  if (separator === null || separator.index > 16_384)
    throw new FactoryGitHubError("invalid_response");
  const lines = stdout.slice(0, separator.index).split(/\r?\n/u);
  const status = /^HTTP\/(?:1\.[01]|2(?:\.0)?) ([1-5][0-9]{2})(?: [^\r\n]*)?$/u.exec(
    lines.shift() ?? "",
  )?.[1];
  if (status === undefined) throw new FactoryGitHubError("invalid_response");
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const index = line.indexOf(":");
    const name = line.slice(0, index).toLowerCase();
    if (["link", "retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"].includes(name))
      headers[name] = line.slice(index + 1).trim();
  }
  let body: unknown;
  try {
    body = JSON.parse(stdout.slice(separator.index + separator[0].length));
  } catch {
    if (Number(status) < 400) throw new FactoryGitHubError("invalid_response");
    body = null;
  }
  return { status: Number(status), headers, body };
}

function httpFailure(result: HttpResponse): FactoryGitHubError {
  const message =
    typeof result.body === "object" &&
    result.body !== null &&
    "message" in result.body &&
    typeof result.body.message === "string"
      ? result.body.message.slice(0, 2048).toLowerCase()
      : "";
  const limited =
    result.status === 429 ||
    (result.status === 403 &&
      (result.headers["x-ratelimit-remaining"] === "0" || message.includes("rate limit")));
  if (limited) {
    const after = result.headers["retry-after"];
    const seconds = after !== undefined && /^[0-9]+$/u.test(after) ? Number(after) : undefined;
    const reset = Number(result.headers["x-ratelimit-reset"]);
    const now = Date.now();
    const deadline =
      seconds !== undefined && Number.isSafeInteger(seconds) && seconds <= 2_592_000
        ? now + seconds * 1000
        : Number.isSafeInteger(reset) && reset * 1000 > now && reset * 1000 <= now + 2_592_000_000
          ? reset * 1000
          : now + 60_000;
    return new FactoryGitHubError("rate_limited", new Date(deadline).toISOString());
  }
  return new FactoryGitHubError(
    result.status === 401
      ? "needs_authentication"
      : [403, 404].includes(result.status)
        ? "access_denied"
        : result.status === 410
          ? "project_not_supported"
          : result.status >= 500
            ? "unavailable"
            : "invalid_response",
  );
}

function base(repository: FactoryGitHubRepository): string {
  return `/repos/${repository.owner}/${repository.name}`;
}
function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function issue(repository: FactoryGitHubRepository, value: ProviderIssue): FactoryGitHubIssue {
  if (
    value.isPullRequest ||
    !same(value.repository_url, `https://api.github.com${base(repository)}`) ||
    !same(
      value.html_url,
      `https://github.com/${repository.owner}/${repository.name}/issues/${String(value.number)}`,
    )
  )
    throw new FactoryGitHubError("invalid_response");
  return parse(FactoryGitHubIssueSchema, {
    repository,
    id: value.id,
    number: value.number,
    url: value.html_url,
    title: value.title,
    body: value.body ?? "",
    state: value.state,
    dependencies: null,
  });
}

function comment(
  repository: FactoryGitHubRepository,
  issueNumber: number,
  value: z.infer<typeof CommentSchema>,
): FactoryGitHubComment {
  if (
    !same(
      value.issue_url,
      `https://api.github.com${base(repository)}/issues/${String(issueNumber)}`,
    ) ||
    !same(
      value.html_url,
      `https://github.com/${repository.owner}/${repository.name}/issues/${String(issueNumber)}#issuecomment-${value.id}`,
    )
  )
    throw new FactoryGitHubError("invalid_response");
  return { id: value.id, body: value.body, url: value.html_url };
}

function nextPage(
  result: HttpResponse,
  repository: FactoryGitHubRepository,
  page: number,
  suffix = "/issues",
): { nextPage: number | null; limited: boolean } {
  const link = result.headers.link;
  if (link === undefined) return { nextPage: null, limited: false };
  const next = /<([^>]+)>;\s*rel="next"/u.exec(link)?.[1];
  if (next === undefined) return { nextPage: null, limited: false };
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    throw new FactoryGitHubError("invalid_response");
  }
  const paths = [`${base(repository)}${suffix}`, `/repositories/${repository.id}${suffix}`];
  const candidate = Number(url.searchParams.get("page"));
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !paths.some((path) => same(path, url.pathname)) ||
    !Number.isSafeInteger(candidate) ||
    candidate !== page + 1
  )
    throw new FactoryGitHubError("invalid_response");
  return candidate > 5
    ? { nextPage: null, limited: true }
    : { nextPage: candidate, limited: false };
}

export function createFactoryGitHubAdapter(
  options: { executable?: string; timeoutMs?: number } = {},
): FactoryGitHubAdapter {
  const executable = options.executable ?? process.env.KESTREL_GH_EXECUTABLE ?? "gh";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const command = (args: readonly string[], signal?: AbortSignal, input?: string) =>
    runFactoryGitHubCli({
      executable,
      args,
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
      ...(input === undefined ? {} : { input }),
    });
  const api = (
    endpoint: string,
    projection: string,
    signal?: AbortSignal,
    method = "GET",
    input?: string,
  ) =>
    command(
      [
        "api",
        "--hostname",
        "github.com",
        endpoint,
        "--method",
        method,
        "--include",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        "--jq",
        projection,
        ...(input === undefined ? [] : ["--input", "-"]),
      ],
      signal,
      input,
    );
  const get = async (
    endpoint: string,
    projection: string,
    signal?: AbortSignal,
  ): Promise<HttpResponse> => {
    const output = await api(endpoint, projection, signal);
    if (output.failure !== undefined) throw new FactoryGitHubError(output.failure);
    if (output.exitCode === 4) throw new FactoryGitHubError("needs_authentication");
    const result = response(output.stdout);
    if (result.status < 200 || result.status >= 300 || output.exitCode !== 0)
      throw httpFailure(result);
    return result;
  };
  const account = async (signal?: AbortSignal) =>
    parse(AccountSchema, (await get("/user", accountProjection, signal)).body).login;
  const identify: FactoryGitHubAdapter["identify"] = async (coordinates, signal) => {
    const selected = parse(
      FactoryGitHubRepositorySchema.pick({ owner: true, name: true }),
      coordinates,
    );
    if ([".", ".."].includes(selected.name)) throw new FactoryGitHubError("project_not_supported");
    const version = await command(["version"], signal);
    if (version.failure !== undefined) throw new FactoryGitHubError(version.failure);
    const match = /^gh version (\d+)\.(\d+)\./u.exec(version.stdout);
    if (
      version.exitCode !== 0 ||
      match === null ||
      Number(match[1]) < 2 ||
      (Number(match[1]) === 2 && Number(match[2]) < 40)
    )
      throw new FactoryGitHubError("unavailable");
    const before = await account(signal);
    const repository = parse(
      FactoryGitHubRepositorySchema,
      (await get(`/repos/${selected.owner}/${selected.name}`, repositoryProjection, signal)).body,
    );
    if (!same(repository.owner, selected.owner) || !same(repository.name, selected.name))
      throw new FactoryGitHubError("repository_changed");
    if (!same(before, await account(signal))) throw new FactoryGitHubError("access_denied");
    return { repository, account: before };
  };
  const verify = async (identity: FactoryGitHubIdentity, signal?: AbortSignal) => {
    const current = await identify(
      { owner: identity.repository.owner, name: identity.repository.name },
      signal,
    );
    if (current.repository.id !== identity.repository.id)
      throw new FactoryGitHubError("repository_changed");
    if (!same(current.account, identity.account)) throw new FactoryGitHubError("access_denied");
  };
  async function write<T>(
    identity: FactoryGitHubIdentity,
    request: WriteRequest<T> & { nativeDependency: true },
    signal?: AbortSignal,
  ): Promise<WriteResult<T> | Unsupported>;
  async function write<T>(
    identity: FactoryGitHubIdentity,
    request: WriteRequest<T>,
    signal?: AbortSignal,
  ): Promise<WriteResult<T>>;
  async function write<T>(
    identity: FactoryGitHubIdentity,
    request: WriteRequest<T> & { nativeDependency?: true },
    signal?: AbortSignal,
  ): Promise<WriteResult<T> | Unsupported> {
    try {
      await verify(identity, signal);
    } catch (error) {
      return failedWrite("not_sent", error);
    }
    try {
      const output = await api(
        request.endpoint,
        request.projection,
        signal,
        request.method,
        request.input,
      );
      if (output.failure !== undefined)
        return failedWrite(
          output.started ? "uncertain" : "not_sent",
          new FactoryGitHubError(output.failure),
        );
      if (output.exitCode === 4)
        return failedWrite("uncertain", new FactoryGitHubError("needs_authentication"));
      const result = response(output.stdout);
      if (request.nativeDependency === true && result.status === 501)
        return { state: "unsupported" };
      if (result.status >= 400 && result.status < 500)
        return failedWrite("rejected", httpFailure(result));
      if (result.status !== request.status || output.exitCode !== 0)
        return failedWrite("uncertain", httpFailure(result));
      const value = request.decode(result.body);
      await verify(identity, signal);
      return { state: "confirmed", value };
    } catch (error) {
      return failedWrite("uncertain", error);
    }
  }
  const pageOfIssues = async (
    identity: FactoryGitHubIdentity,
    page: number,
    state: "open" | "all",
    signal?: AbortSignal,
  ) => {
    parse(z.int().min(1).max(5), page);
    const result = await get(
      `${base(identity.repository)}/issues?state=${state}&sort=created&direction=desc&per_page=20&page=${String(page)}`,
      issueProjection,
      signal,
    );
    const values = parse(z.array(IssueSchema).max(20), result.body);
    const seen = new Set<string>();
    const issues = values.filter((value) => {
      if (value.isPullRequest || seen.has(value.id)) return false;
      seen.add(value.id);
      return true;
    });
    return { values: issues, ...nextPage(result, identity.repository, page) };
  };
  const dependencies = async (
    identity: FactoryGitHubIdentity,
    issueNumber: number,
    signal?: AbortSignal,
  ): Promise<{ state: "supported"; dependencies: Dependencies } | Unsupported> => {
    const suffix = `/issues/${String(issueNumber)}/dependencies/blocked_by`;
    const output = await api(
      `${base(identity.repository)}${suffix}?per_page=100&page=1`,
      dependencyProjection,
      signal,
    );
    if (output.failure !== undefined) throw new FactoryGitHubError(output.failure);
    if (output.exitCode === 4) throw new FactoryGitHubError("needs_authentication");
    const result = response(output.stdout);
    if (result.status === 501) return { state: "unsupported" };
    if (result.status !== 200 || output.exitCode !== 0) throw httpFailure(result);
    if (nextPage(result, identity.repository, 1, suffix).nextPage !== null)
      throw new FactoryGitHubError("reconciliation_limit");
    const values = parse(z.array(DependencySchema).max(100), result.body);
    if (
      values.some(
        (value) =>
          value.isPullRequest || !value.html_url.endsWith(`/issues/${String(value.number)}`),
      )
    )
      throw new FactoryGitHubError("invalid_response");
    return {
      state: "supported",
      dependencies: parse(
        FactoryGitHubIssueSchema.shape.dependencies.unwrap(),
        values.map((value) => ({
          id: value.id,
          number: value.number,
          title: value.title,
          url: value.html_url,
        })),
      ),
    };
  };
  const readDependencies: FactoryGitHubAdapter["readDependencies"] = async (
    identity,
    issueNumber,
    signal,
  ) => {
    parse(numberSchema, issueNumber);
    await verify(identity, signal);
    const result = await dependencies(identity, issueNumber, signal);
    await verify(identity, signal);
    return result;
  };
  const reconcile = async <
    T extends { id: string },
    Candidate extends { id: string; body: string | null; author: string | null },
  >(
    identity: FactoryGitHubIdentity,
    marker: string,
    readPage: (
      page: number,
    ) => Promise<{ values: Candidate[]; nextPage: number | null; limited: boolean }>,
    decode: (value: Candidate) => T,
    signal?: AbortSignal,
  ): Promise<Reconciliation<T>> => {
    parse(MarkerSchema, marker);
    await verify(identity, signal);
    const matches = new Map<string, T>();
    let page: number | null = 1;
    let limited = false;
    let foreignAuthor = false;
    while (page !== null) {
      const result = await readPage(page);
      for (const value of result.values) {
        if (!hasMarker(value.body, marker)) continue;
        matches.set(value.id, decode(value));
        if (value.author === null || !same(value.author, identity.account)) foreignAuthor = true;
      }
      limited = result.limited;
      page = result.nextPage;
    }
    await verify(identity, signal);
    if (foreignAuthor || matches.size > 1) return { state: "ambiguous" };
    const value = matches.values().next().value;
    // One durable operation authorizes one POST. Its owned UUID marker is positive
    // evidence even when older history falls outside the bounded scan.
    if (value !== undefined) return { state: "found", value };
    return { state: limited ? "limited" : "missing" };
  };
  return {
    identify,
    async listIssues(identity, page, signal) {
      await verify(identity, signal);
      const result = await pageOfIssues(identity, page, "open", signal);
      const issues = result.values
        .filter((value) => value.state === "open")
        .map((value) => issue(identity.repository, value));
      await verify(identity, signal);
      return { issues, page, nextPage: result.nextPage, limited: result.limited };
    },
    async readIssue(identity, number, signal) {
      parse(numberSchema, number);
      await verify(identity, signal);
      const selected = parse(
        IssueSchema,
        (
          await get(
            `${base(identity.repository)}/issues/${String(number)}`,
            issueProjection,
            signal,
          )
        ).body,
      );
      if (selected.number !== number || selected.state !== "open")
        throw new FactoryGitHubError("invalid_response");
      const result = issue(identity.repository, selected);
      const blockers = await dependencies(identity, number, signal);
      await verify(identity, signal);
      return {
        ...result,
        dependencies: blockers.state === "supported" ? blockers.dependencies : null,
      };
    },
    async createIssue(identity, input, signal) {
      try {
        parse(
          z.strictObject({ title: z.string().min(1).max(256), body: z.string().max(65_536) }),
          input,
        );
      } catch (error) {
        return failedWrite("not_sent", error);
      }
      return write(
        identity,
        {
          endpoint: `${base(identity.repository)}/issues`,
          projection: issueProjection,
          method: "POST",
          input: JSON.stringify(input),
          status: 201,
          decode(value) {
            const selected = parse(IssueSchema, value);
            if (selected.author === null || !same(selected.author, identity.account))
              throw new FactoryGitHubError("access_denied");
            return issue(identity.repository, selected);
          },
        },
        signal,
      );
    },
    async findIssue(identity, marker, signal) {
      return reconcile(
        identity,
        marker,
        (page) => pageOfIssues(identity, page, "all", signal),
        (value) => issue(identity.repository, value),
        signal,
      );
    },
    readDependencies,
    async addDependency(identity, issueNumber, blockingIssueId, signal) {
      try {
        parse(numberSchema, issueNumber);
        parse(providerId, blockingIssueId);
        if (!Number.isSafeInteger(Number(blockingIssueId)))
          throw new FactoryGitHubError("invalid_response");
        const existing = await readDependencies(identity, issueNumber, signal);
        if (existing.state === "unsupported") return existing;
        if (existing.dependencies.some((value) => value.id === blockingIssueId))
          return { state: "confirmed", value: null };
      } catch (error) {
        return failedWrite("not_sent", error);
      }
      const result = await write(
        identity,
        {
          endpoint: `${base(identity.repository)}/issues/${String(issueNumber)}/dependencies/blocked_by`,
          projection: dependencyProjection,
          method: "POST",
          input: JSON.stringify({ issue_id: Number(blockingIssueId) }),
          status: 201,
          nativeDependency: true,
          decode(value) {
            const created = parse(DependencySchema, value);
            if (created.id !== blockingIssueId || created.isPullRequest)
              throw new FactoryGitHubError("invalid_response");
            return null;
          },
        },
        signal,
      );
      if (
        result.state === "uncertain" ||
        (result.state === "rejected" && result.failure === "invalid_response")
      ) {
        try {
          const observed = await readDependencies(identity, issueNumber, signal);
          if (
            observed.state === "supported" &&
            observed.dependencies.some((value) => value.id === blockingIssueId)
          )
            return { state: "confirmed", value: null };
        } catch {
          /* A failed read cannot prove or undo the original write. */
        }
      }
      return result;
    },
    async createComment(identity, issueNumber, body, signal) {
      try {
        parse(numberSchema, issueNumber);
        parse(CommentBodySchema, body);
      } catch (error) {
        return failedWrite("not_sent", error);
      }
      return write(
        identity,
        {
          endpoint: `${base(identity.repository)}/issues/${String(issueNumber)}/comments`,
          projection: commentProjection,
          method: "POST",
          input: JSON.stringify({ body }),
          status: 201,
          decode(value) {
            const created = parse(CommentSchema, value);
            if (created.author === null || !same(created.author, identity.account))
              throw new FactoryGitHubError("access_denied");
            return comment(identity.repository, issueNumber, created);
          },
        },
        signal,
      );
    },
    async findComment(identity, issueNumber, marker, signal) {
      parse(numberSchema, issueNumber);
      const suffix = `/issues/${String(issueNumber)}/comments`;
      return reconcile(
        identity,
        marker,
        async (page) => {
          const result = await get(
            `${base(identity.repository)}${suffix}?per_page=20&page=${String(page)}`,
            commentProjection,
            signal,
          );
          return {
            values: parse(z.array(CommentSchema).max(20), result.body),
            ...nextPage(result, identity.repository, page, suffix),
          };
        },
        (value) => comment(identity.repository, issueNumber, value),
        signal,
      );
    },
    async updateComment(identity, issueNumber, commentId, body, signal) {
      try {
        parse(numberSchema, issueNumber);
        parse(providerId, commentId);
        parse(CommentBodySchema, body);
        await verify(identity, signal);
        const current = parse(
          CommentSchema,
          (
            await get(
              `${base(identity.repository)}/issues/comments/${commentId}`,
              commentProjection,
              signal,
            )
          ).body,
        );
        if (current.id !== commentId) throw new FactoryGitHubError("invalid_response");
        comment(identity.repository, issueNumber, current);
        if (current.author === null || !same(current.author, identity.account))
          throw new FactoryGitHubError("access_denied");
      } catch (error) {
        return failedWrite("not_sent", error);
      }
      return write(
        identity,
        {
          endpoint: `${base(identity.repository)}/issues/comments/${commentId}`,
          projection: commentProjection,
          method: "PATCH",
          input: JSON.stringify({ body }),
          status: 200,
          decode(value) {
            const updated = parse(CommentSchema, value);
            if (updated.id !== commentId) throw new FactoryGitHubError("invalid_response");
            if (updated.author === null || !same(updated.author, identity.account))
              throw new FactoryGitHubError("access_denied");
            return comment(identity.repository, issueNumber, updated);
          },
        },
        signal,
      );
    },
  };
}
