import { spawn } from "node:child_process";

import { z } from "zod";

import {
  HostGitHubProjectInboxSchema,
  type HostGitHubProjectInbox,
  type HostGitHubPullRequestSummary,
} from "@kestrel/contracts";
import type { PublicGitHubObservation } from "./public-github.js";

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const HOST = "github.com";

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

function parseSupportedVersion(text: string): string {
  const match = /^gh version (\d+)\.(\d+)\.([^\s]+)(?:\s|$)/u.exec(text);
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new HostGitHubError("invalid_response");
  }
  if (Number(major) < 2 || (Number(major) === 2 && Number(minor) < 40)) {
    throw new HostGitHubError("unavailable");
  }
  return `${major}.${minor}.${patch}`;
}

function searchArgs(
  coordinates: Coordinates,
  filter: "all" | "authored" | "review_requested",
): string[] {
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
  all: z.infer<typeof SearchSchema>;
  authored: z.infer<typeof SearchSchema>;
  review_requested: z.infer<typeof SearchSchema>;
}): HostGitHubPullRequestSummary[] {
  const authored = new Set(groups.authored.map(({ number }) => number));
  const requested = new Set(groups.review_requested.map(({ number }) => number));
  const unique = new Map<number, z.infer<typeof SearchItemSchema>>();
  for (const item of [...groups.all, ...groups.authored, ...groups.review_requested])
    unique.set(item.number, item);
  const rank = { review_requested: 0, authored: 1, other: 2 } as const;
  return [...unique.values()]
    .map((item) => ({
      ...item,
      author: item.author?.login ?? null,
      group: requested.has(item.number)
        ? ("review_requested" as const)
        : authored.has(item.number)
          ? ("authored" as const)
          : ("other" as const),
    }))
    .sort(
      (left, right) =>
        rank[left.group] - rank[right.group] ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.number - right.number,
    );
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
  return {
    async readVersion(signal?: AbortSignal): Promise<string> {
      return parseSupportedVersion((await run(executable, ["version"], timeoutMs, signal)).stdout);
    },
    async readActiveAccount(signal?: AbortSignal): Promise<string> {
      return parseJson(
        AccountSchema,
        (await run(executable, ["api", "--hostname", HOST, "/user"], timeoutMs, signal)).stdout,
      ).login;
    },
    async readProjectInbox(
      projectId: string,
      coordinates: Coordinates,
      signal?: AbortSignal,
    ): Promise<HostGitHubProjectInbox> {
      const executableVersion = parseSupportedVersion(
        (await run(executable, ["version"], timeoutMs, signal)).stdout,
      );
      const account = parseJson(
        AccountSchema,
        (await run(executable, ["api", "--hostname", HOST, "/user"], timeoutMs, signal)).stdout,
      );
      const repository = parseJson(
        RepositorySchema,
        (
          await run(
            executable,
            ["api", "--hostname", HOST, `/repos/${coordinates.owner}/${coordinates.repository}`],
            timeoutMs,
            signal,
          )
        ).stdout,
      );
      if (
        repository.owner.login.toLowerCase() !== coordinates.owner.toLowerCase() ||
        repository.name.toLowerCase() !== coordinates.repository.toLowerCase()
      )
        throw new HostGitHubError("invalid_response");
      const all = parseJson(
        SearchSchema,
        (await run(executable, searchArgs(coordinates, "all"), timeoutMs, signal)).stdout,
      );
      const authored = parseJson(
        SearchSchema,
        (await run(executable, searchArgs(coordinates, "authored"), timeoutMs, signal)).stdout,
      );
      const review_requested = parseJson(
        SearchSchema,
        (await run(executable, searchArgs(coordinates, "review_requested"), timeoutMs, signal))
          .stdout,
      );
      const pullRequests = normalizeSearch({ all, authored, review_requested });
      for (const pullRequest of pullRequests) {
        assertProjectPullRequest(coordinates, pullRequest.number, pullRequest.url);
      }
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
      const repository = parseJson(
        RepositorySchema,
        (
          await run(
            executable,
            ["api", "--hostname", HOST, `/repos/${coordinates.owner}/${coordinates.repository}`],
            timeoutMs,
            signal,
          )
        ).stdout,
      );
      const account = parseJson(
        AccountSchema,
        (await run(executable, ["api", "--hostname", HOST, "/user"], timeoutMs, signal)).stdout,
      );
      if (account.login !== expectedAccount) throw new HostGitHubError("access_denied");
      if (
        repository.owner.login.toLowerCase() !== coordinates.owner.toLowerCase() ||
        repository.name.toLowerCase() !== coordinates.repository.toLowerCase() ||
        pull.number !== number
      ) {
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
