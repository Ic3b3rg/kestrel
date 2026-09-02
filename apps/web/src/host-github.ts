import { spawn } from "node:child_process";

import { z } from "zod";

import {
  HostGitHubConnectionSchema,
  HostGitHubProjectInboxSchema,
  type HostGitHubConnection,
  type HostGitHubProjectInbox,
  type HostGitHubPullRequestGroupState,
  type HostGitHubPullRequestSummary,
} from "@kestrel/contracts";
import type { PublicGitHubObservation } from "./public-github.js";

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const HOST = "github.com";
const ACCOUNT_ARGUMENTS = ["api", "--hostname", HOST, "/user", "--jq", "{login: .login}"] as const;
const REPOSITORY_PROJECTION = "{id, name, node_id, owner: {login: .owner.login}}";

const AccountSchema = z.strictObject({ login: z.string().min(1).max(100) });
const RepositorySchema = z.strictObject({
  id: z.number().int().positive(),
  name: z.string().min(1).max(100),
  node_id: z.string().min(1).max(256),
  owner: z.strictObject({ login: z.string().min(1).max(100) }),
});
const SearchItemSchema = z.strictObject({
  author: z.strictObject({ login: z.string().min(1).max(100) }).nullable(),
  body: z.string().max(65_536),
  number: z.number().int().positive(),
  title: z.string().min(1).max(512),
  updatedAt: z.iso.datetime({ offset: true }),
  url: z.url().max(256),
});
const SearchSchema = z.array(SearchItemSchema).max(100);
const PullRequestSchema = z.strictObject({
  author: z
    .strictObject({ id: z.string().min(1).max(256), login: z.string().min(1).max(100) })
    .nullable(),
  baseRefName: z.string().min(1).max(255),
  baseRefOid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  body: z.string().max(65_536),
  headRefName: z.string().min(1).max(255),
  headRefOid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  id: z.string().min(1).max(256),
  mergedAt: z.iso.datetime({ offset: true }).nullable(),
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  title: z.string().min(1).max(512),
  url: z.url().max(256),
});

export type HostGitHubErrorKind =
  | "unavailable"
  | "needs_authentication"
  | "access_denied"
  | "rate_limited"
  | "invalid_response"
  | "timeout"
  | "cancelled"
  | "project_not_supported";

export class HostGitHubError extends Error {
  constructor(public readonly kind: HostGitHubErrorKind) {
    super(`Host GitHub CLI failed: ${kind}`);
    this.name = "HostGitHubError";
  }
}

interface CommandResult {
  stdout: string;
}
interface HostGitHubCliOptions {
  executable?: string;
  timeoutMs?: number;
}
interface Coordinates {
  owner: string;
  repository: string;
}
type SearchFilter = "all" | "authored" | "review_requested";
type SearchItems = z.infer<typeof SearchSchema>;
type GroupFailureReason = NonNullable<HostGitHubPullRequestGroupState["failureReason"]>;
type SearchOutcome =
  | { state: "available"; items: SearchItems }
  | { state: "unavailable"; failureReason: GroupFailureReason };
interface ConnectionProject {
  projectId: string;
  coordinates: Coordinates | null;
}

function unverifiedProjectAccess(project: ConnectionProject | null) {
  return project === null
    ? null
    : ({ state: "not_verified", projectId: project.projectId, repository: null } as const);
}

function repositoryArguments(coordinates: Coordinates): string[] {
  return [
    "api",
    "--hostname",
    HOST,
    `/repos/${coordinates.owner}/${coordinates.repository}`,
    "--jq",
    REPOSITORY_PROJECTION,
  ];
}

type ConnectionCli = NonNullable<HostGitHubConnection["cli"]>;
type ConnectionIdentity = NonNullable<HostGitHubConnection["identity"]>;
type ConnectionProbeStage = "identity" | "project" | "version";

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GH_HOST: HOST, LANG: "C", LC_ALL: "C", NO_COLOR: "1" };
  for (const name of ["HOME", "PATH", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"] as const) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function classifyFailure(stderr: string): HostGitHubErrorKind {
  const value = stderr.toLowerCase();
  if (value.includes("rate limit") || value.includes("secondary rate")) return "rate_limited";
  if (
    value.includes("not logged") ||
    value.includes("authenticate") ||
    value.includes("bad credentials")
  )
    return "needs_authentication";
  return "access_denied";
}

function run(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new HostGitHubError("cancelled"));
    const child = spawn(executable, args, {
      detached: process.platform !== "win32",
      env: safeEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let failure: HostGitHubErrorKind | null = null;
    const kill = () => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          /* direct-child fallback */
        }
      }
      child.kill("SIGKILL");
    };
    const finish = (error?: HostGitHubError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8") });
    };
    const onAbort = () => {
      failure = "cancelled";
      kill();
    };
    const timer = setTimeout(() => {
      failure = "timeout";
      kill();
    }, timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        failure = "invalid_response";
        kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_STDERR_BYTES) {
        failure = "invalid_response";
        kill();
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", () => finish(new HostGitHubError("unavailable")));
    child.once("close", (code) => {
      if (failure !== null) return finish(new HostGitHubError(failure));
      if (code !== 0)
        return finish(
          new HostGitHubError(classifyFailure(Buffer.concat(stderr, stderrBytes).toString("utf8"))),
        );
      finish();
    });
  });
}

function parseJson<T>(schema: z.ZodType<T>, text: string): T {
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw new HostGitHubError("invalid_response");
  }
}

function parseVersion(text: string): { supported: boolean; version: string } {
  const match = /^gh version (\d+)\.(\d+)\.([^\s]+)(?:\s|$)/u.exec(text);
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new HostGitHubError("invalid_response");
  }
  return {
    supported: Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 40),
    version: `${major}.${minor}.${patch}`,
  };
}

function failedConnection(
  error: unknown,
  stage: ConnectionProbeStage,
  project: ConnectionProject | null,
  cli: ConnectionCli | null,
  identity: ConnectionIdentity | null = null,
): HostGitHubConnection {
  if (!(error instanceof HostGitHubError) || error.kind === "cancelled") throw error;
  const reason = (() => {
    switch (error.kind) {
      case "needs_authentication":
        return "authentication_required" as const;
      case "access_denied":
        return stage === "project"
          ? ("project_access_denied" as const)
          : ("authentication_required" as const);
      case "rate_limited":
        return "rate_limited" as const;
      case "timeout":
        return "timed_out" as const;
      case "unavailable":
        return stage === "version"
          ? ("cli_not_installed" as const)
          : ("unexpected_response" as const);
      case "invalid_response":
      case "project_not_supported":
        return "unexpected_response" as const;
    }
  })();
  const actionRequired = reason === "authentication_required" || reason === "project_access_denied";
  return HostGitHubConnectionSchema.parse({
    schemaVersion: 1,
    state: actionRequired ? "action_required" : "unavailable",
    reason,
    cli,
    identity: stage === "project" && reason !== "authentication_required" ? identity : null,
    projectAccess: unverifiedProjectAccess(project),
    checkedAt: new Date().toISOString(),
  });
}

function driftedConnection(
  project: ConnectionProject | null,
  cli: ConnectionCli,
): HostGitHubConnection {
  return HostGitHubConnectionSchema.parse({
    schemaVersion: 1,
    state: "action_required",
    reason: "account_drift",
    cli,
    identity: null,
    projectAccess: unverifiedProjectAccess(project),
    checkedAt: new Date().toISOString(),
  });
}

function searchArgs(coordinates: Coordinates, filter: SearchFilter): string[] {
  const args = [
    "search",
    "prs",
    "--repo",
    `${coordinates.owner}/${coordinates.repository}`,
    "--state",
    "open",
    "--limit",
    "100",
    "--sort",
    "updated",
    "--order",
    "desc",
  ];
  if (filter === "authored") args.push("--author", "@me");
  if (filter === "review_requested") args.push("--review-requested", "@me");
  args.push("--json", "number,title,body,url,author,updatedAt");
  return args;
}

function normalizeSearch(groups: {
  all: SearchOutcome;
  authored: SearchOutcome;
  review_requested: SearchOutcome;
}): HostGitHubPullRequestSummary[] {
  const requestedItems =
    groups.review_requested.state === "available" ? groups.review_requested.items : [];
  const authoredItems = groups.authored.state === "available" ? groups.authored.items : [];
  const requested = new Set(requestedItems.map(({ number }) => number));
  const authored = new Set(authoredItems.map(({ number }) => number));
  const unique = new Map<number, HostGitHubPullRequestSummary>();
  for (const item of requestedItems) {
    unique.set(item.number, {
      ...item,
      author: item.author?.login ?? null,
      group: "review_requested",
    });
  }
  for (const item of authoredItems) {
    if (!unique.has(item.number))
      unique.set(item.number, { ...item, author: item.author?.login ?? null, group: "authored" });
  }
  if (
    groups.all.state === "available" &&
    groups.authored.state === "available" &&
    groups.review_requested.state === "available"
  ) {
    for (const item of groups.all.items) {
      if (!requested.has(item.number) && !authored.has(item.number)) {
        unique.set(item.number, { ...item, author: item.author?.login ?? null, group: "other" });
      }
    }
  }
  const rank = { review_requested: 0, authored: 1, other: 2 } as const;
  return [...unique.values()].sort(
    (left, right) =>
      rank[left.group] - rank[right.group] ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.number - right.number,
  );
}

function groupFailureReason(error: HostGitHubError): GroupFailureReason {
  switch (error.kind) {
    case "needs_authentication":
      return "authentication_required";
    case "access_denied":
    case "project_not_supported":
      return "project_access_denied";
    case "rate_limited":
      return "rate_limited";
    case "timeout":
    case "cancelled":
      return "timed_out";
    case "invalid_response":
    case "unavailable":
      return "unexpected_response";
  }
}

function searchOutcome(result: PromiseSettledResult<SearchItems>): SearchOutcome {
  if (result.status === "fulfilled") return { state: "available", items: result.value };
  if (!(result.reason instanceof HostGitHubError)) throw result.reason;
  if (
    result.reason.kind === "cancelled" ||
    result.reason.kind === "needs_authentication" ||
    result.reason.kind === "access_denied"
  ) {
    throw result.reason;
  }
  return { state: "unavailable", failureReason: groupFailureReason(result.reason) };
}

function displayedGroupState(
  group: HostGitHubPullRequestGroupState["group"],
  outcome: SearchOutcome,
): HostGitHubPullRequestGroupState {
  return outcome.state === "available"
    ? { group, state: "available", failureReason: null }
    : { group, state: "unavailable", failureReason: outcome.failureReason };
}

function assertProjectPullRequest(coordinates: Coordinates, number: number, url: string): void {
  if (
    url.toLowerCase() !==
    `https://${HOST}/${coordinates.owner}/${coordinates.repository}/pull/${String(number)}`.toLowerCase()
  ) {
    throw new HostGitHubError("invalid_response");
  }
}

export function createHostGitHubCli(options: HostGitHubCliOptions = {}) {
  const executable = options.executable ?? process.env.KESTREL_GH_EXECUTABLE ?? "gh";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const readCliVersion = async (signal?: AbortSignal) =>
    parseVersion((await run(executable, ["version"], timeoutMs, signal)).stdout);
  const readSupportedCliVersion = async (signal?: AbortSignal) => {
    const cli = await readCliVersion(signal);
    if (!cli.supported) throw new HostGitHubError("unavailable");
    return cli.version;
  };
  const readAccount = async (signal?: AbortSignal) =>
    parseJson(AccountSchema, (await run(executable, ACCOUNT_ARGUMENTS, timeoutMs, signal)).stdout);
  const readRepository = async (coordinates: Coordinates, signal?: AbortSignal) => {
    const repository = parseJson(
      RepositorySchema,
      (await run(executable, repositoryArguments(coordinates), timeoutMs, signal)).stdout,
    );
    if (
      repository.owner.login.toLowerCase() !== coordinates.owner.toLowerCase() ||
      repository.name.toLowerCase() !== coordinates.repository.toLowerCase()
    ) {
      throw new HostGitHubError("invalid_response");
    }
    return repository;
  };
  return {
    async readConnection(
      project: ConnectionProject | null,
      signal?: AbortSignal,
    ): Promise<HostGitHubConnection> {
      let cli: ConnectionCli;
      try {
        cli = await readCliVersion(signal);
      } catch (error) {
        return failedConnection(error, "version", project, null);
      }
      if (!cli.supported) {
        return HostGitHubConnectionSchema.parse({
          schemaVersion: 1,
          state: "action_required",
          reason: "cli_version_unsupported",
          cli,
          identity: null,
          projectAccess: unverifiedProjectAccess(project),
          checkedAt: new Date().toISOString(),
        });
      }
      let account: z.infer<typeof AccountSchema>;
      let confirmedAccount: z.infer<typeof AccountSchema>;
      try {
        account = await readAccount(signal);
        confirmedAccount = await readAccount(signal);
      } catch (error) {
        return failedConnection(error, "identity", project, cli);
      }
      if (confirmedAccount.login !== account.login) {
        return driftedConnection(project, cli);
      }
      if (project === null) {
        return HostGitHubConnectionSchema.parse({
          schemaVersion: 1,
          state: "ready",
          reason: null,
          cli,
          identity: { host: HOST, account: account.login },
          projectAccess: null,
          checkedAt: new Date().toISOString(),
        });
      }
      if (project.coordinates === null) {
        return HostGitHubConnectionSchema.parse({
          schemaVersion: 1,
          state: "action_required",
          reason: "project_not_supported",
          cli,
          identity: { host: HOST, account: account.login },
          projectAccess: unverifiedProjectAccess(project),
          checkedAt: new Date().toISOString(),
        });
      }
      let repository: z.infer<typeof RepositorySchema>;
      try {
        repository = await readRepository(project.coordinates, signal);
      } catch (error) {
        return failedConnection(error, "project", project, cli, {
          host: HOST,
          account: account.login,
        });
      }
      let accessedAccount: z.infer<typeof AccountSchema>;
      try {
        accessedAccount = await readAccount(signal);
      } catch (error) {
        return failedConnection(error, "identity", project, cli);
      }
      if (accessedAccount.login !== account.login) return driftedConnection(project, cli);
      return HostGitHubConnectionSchema.parse({
        schemaVersion: 1,
        state: "ready",
        reason: null,
        cli,
        identity: { host: HOST, account: account.login },
        projectAccess: {
          state: "verified",
          projectId: project.projectId,
          repository: { owner: repository.owner.login, name: repository.name },
        },
        checkedAt: new Date().toISOString(),
      });
    },
    async readVersion(signal?: AbortSignal): Promise<string> {
      return readSupportedCliVersion(signal);
    },
    async readActiveAccount(signal?: AbortSignal): Promise<string> {
      return (await readAccount(signal)).login;
    },
    async readProjectInbox(
      projectId: string,
      coordinates: Coordinates,
      signal?: AbortSignal,
    ): Promise<HostGitHubProjectInbox> {
      const executableVersion = await readSupportedCliVersion(signal);
      const account = await readAccount(signal);
      await readRepository(coordinates, signal);
      const readSearch = async (filter: SearchFilter): Promise<SearchItems> => {
        const items = parseJson(
          SearchSchema,
          (await run(executable, searchArgs(coordinates, filter), timeoutMs, signal)).stdout,
        );
        for (const item of items) assertProjectPullRequest(coordinates, item.number, item.url);
        return items;
      };
      const [allResult, authoredResult, reviewRequestedResult] = await Promise.allSettled([
        readSearch("all"),
        readSearch("authored"),
        readSearch("review_requested"),
      ]);
      const all = searchOutcome(allResult);
      const authored = searchOutcome(authoredResult);
      const review_requested = searchOutcome(reviewRequestedResult);
      const pullRequests = normalizeSearch({ all, authored, review_requested });
      const other =
        all.state === "unavailable"
          ? all
          : authored.state === "unavailable"
            ? authored
            : review_requested.state === "unavailable"
              ? review_requested
              : ({ state: "available", items: all.items } as const);
      return HostGitHubProjectInboxSchema.parse({
        schemaVersion: 1,
        projectId,
        route: "host_gh",
        limitations: [
          "Manual refresh only",
          "Provider metadata never supplies source or starts Review",
        ],
        status: {
          executableVersion,
          availability: "available",
          host: HOST,
          authentication: "authenticated",
          account: account.login,
        },
        groupStates: [
          displayedGroupState("review_requested", review_requested),
          displayedGroupState("authored", authored),
          displayedGroupState("other", other),
        ],
        pullRequests,
        observedAt: new Date().toISOString(),
      });
    },
    async observePullRequest(
      coordinates: Coordinates,
      number: number,
      expectedAccount: string,
      signal?: AbortSignal,
    ): Promise<PublicGitHubObservation> {
      const fields =
        "id,number,title,body,state,mergedAt,baseRefName,baseRefOid,headRefName,headRefOid,author,url";
      const pull = parseJson(
        PullRequestSchema,
        (
          await run(
            executable,
            [
              "pr",
              "view",
              String(number),
              "--repo",
              `${coordinates.owner}/${coordinates.repository}`,
              "--json",
              fields,
            ],
            timeoutMs,
            signal,
          )
        ).stdout,
      );
      const repository = await readRepository(coordinates, signal);
      const account = await readAccount(signal);
      if (account.login !== expectedAccount) throw new HostGitHubError("access_denied");
      if (pull.number !== number) {
        throw new HostGitHubError("invalid_response");
      }
      assertProjectPullRequest(coordinates, pull.number, pull.url);
      return {
        repository: {
          canonicalUrl: `https://${HOST}/${coordinates.owner}/${coordinates.repository}`,
          name: repository.name,
          owner: repository.owner.login,
          providerId: repository.node_id,
        },
        proposal: {
          author:
            pull.author === null ? null : { login: pull.author.login, providerId: pull.author.id },
          base: { objectId: pull.baseRefOid, ref: pull.baseRefName },
          canonicalUrl: pull.url,
          head: { objectId: pull.headRefOid, ref: pull.headRefName },
          number: pull.number,
          proposalState:
            pull.state === "MERGED" || pull.mergedAt !== null
              ? "merged"
              : (pull.state.toLowerCase() as "open" | "closed"),
          providerId: pull.id,
          title: pull.title,
          body: pull.body,
        },
      };
    },
  };
}
