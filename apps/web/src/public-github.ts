import { PublicGitHubPullRequestUrlSchema, type Project } from "@kestrel/contracts";
import { z } from "zod";

const GITHUB_API_VERSION = "2026-03-10";
const MAX_RESPONSE_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 10_000;

const GitHubActorSchema = z.object({
  login: z.string().min(1).max(100),
  node_id: z.string().min(1).max(256),
});

const GitHubRepositorySchema = z.object({
  full_name: z.string().min(3).max(140),
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/u),
  node_id: z.string().min(1).max(256),
  owner: z.object({
    login: z
      .string()
      .max(39)
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u),
  }),
  private: z.literal(false),
});

const GitHubPullRequestSchema = z.object({
  base: z.object({
    ref: z.string().min(1).max(255),
    repo: GitHubRepositorySchema,
    sha: z.string().regex(/^[a-f0-9]{40}$/u),
  }),
  head: z.object({
    ref: z.string().min(1).max(255),
    sha: z.string().regex(/^[a-f0-9]{40}$/u),
  }),
  merged: z.boolean(),
  merged_at: z.iso.datetime({ offset: true }).nullable(),
  node_id: z.string().min(1).max(256),
  number: z.number().int().positive().max(9_999_999_999),
  state: z.enum(["open", "closed"]),
  title: z.string().min(1).max(512),
  user: GitHubActorSchema.nullable(),
});

export interface PublicGitHubPullRequestCoordinates {
  number: number;
  owner: string;
  repository: string;
}

type ChangeProposal = Project["changeProposals"][number];

export interface PublicGitHubObservation {
  proposal: Omit<ChangeProposal, "id" | "observedAt">;
  repository: Project["repository"];
}

export type PublicGitHubReadErrorKind =
  "invalid_response" | "not_found" | "rate_limited" | "redirected" | "unavailable";

export class PublicGitHubReadError extends Error {
  constructor(
    public readonly kind: PublicGitHubReadErrorKind,
    public readonly rateLimitReset: string | null = null,
  ) {
    super(`Public GitHub read failed: ${kind}`);
    this.name = "PublicGitHubReadError";
  }
}

export interface PublicGitHubReader {
  read(url: string): Promise<PublicGitHubObservation>;
}

type FetchImplementation = typeof fetch;

export function parsePublicGitHubPullRequestUrl(input: string): PublicGitHubPullRequestCoordinates {
  const url = new URL(PublicGitHubPullRequestUrlSchema.parse(input));
  const segments = url.pathname.slice(1).split("/");
  const owner = segments[0];
  const repository = segments[1];
  const pullSegment = segments[2];
  const numberSegment = segments[3];
  if (
    owner === undefined ||
    repository === undefined ||
    pullSegment !== "pull" ||
    numberSegment === undefined
  ) {
    throw new Error("Canonical public GitHub pull-request URL did not decompose");
  }
  return { number: Number(numberSegment), owner, repository };
}

function normalizedRateLimitReset(response: Response): string | null {
  const reset = response.headers.get("x-ratelimit-reset");
  return reset !== null && /^[0-9]{1,12}$/u.test(reset) ? reset : null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^[0-9]+$/u.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    throw new PublicGitHubReadError("invalid_response");
  }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new PublicGitHubReadError("invalid_response");
  }
  if (response.body === null) {
    throw new PublicGitHubReadError("invalid_response");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    let result = await reader.read();
    while (!result.done) {
      length += result.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new PublicGitHubReadError("invalid_response");
      }
      chunks.push(result.value);
      result = await reader.read();
    }
  } catch (error) {
    if (error instanceof PublicGitHubReadError) {
      throw error;
    }
    throw new PublicGitHubReadError("unavailable");
  } finally {
    reader.releaseLock();
  }

  const contents = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    contents.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents)) as unknown;
  } catch {
    throw new PublicGitHubReadError("invalid_response");
  }
}

function normalizeObservation(
  body: unknown,
  requested: PublicGitHubPullRequestCoordinates,
): PublicGitHubObservation {
  const parsed = GitHubPullRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new PublicGitHubReadError("invalid_response");
  }
  const pullRequest = parsed.data;
  const expectedRepository = `${requested.owner}/${requested.repository}`;
  const owner = pullRequest.base.repo.owner.login;
  const repository = pullRequest.base.repo.name;
  const observedRepository = `${owner}/${repository}`;
  if (
    pullRequest.number !== requested.number ||
    pullRequest.base.repo.full_name.toLowerCase() !== expectedRepository.toLowerCase() ||
    observedRepository.toLowerCase() !== pullRequest.base.repo.full_name.toLowerCase()
  ) {
    throw new PublicGitHubReadError("invalid_response");
  }

  const repositoryUrl = `https://github.com/${owner}/${repository}`;
  const canonicalUrl = `${repositoryUrl}/pull/${String(pullRequest.number)}`;
  return {
    proposal: {
      author:
        pullRequest.user === null
          ? null
          : { login: pullRequest.user.login, providerId: pullRequest.user.node_id },
      base: { objectId: pullRequest.base.sha, ref: pullRequest.base.ref },
      canonicalUrl,
      head: { objectId: pullRequest.head.sha, ref: pullRequest.head.ref },
      number: pullRequest.number,
      proposalState:
        pullRequest.merged || pullRequest.merged_at !== null ? "merged" : pullRequest.state,
      providerId: pullRequest.node_id,
      title: pullRequest.title,
    },
    repository: {
      canonicalUrl: repositoryUrl,
      name: repository,
      owner,
      providerId: pullRequest.base.repo.node_id,
    },
  };
}

export function createPublicGitHubReader(
  fetchImplementation: FetchImplementation = fetch,
): PublicGitHubReader {
  return {
    async read(url) {
      const requested = parsePublicGitHubPullRequestUrl(url);
      const apiUrl = `https://api.github.com/repos/${requested.owner}/${requested.repository}/pulls/${String(requested.number)}`;
      let response: Response;
      try {
        // GitHub requires User-Agent and recommends the vendor Accept and explicit API version.
        // Sources:
        // https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api
        // https://docs.github.com/en/rest/about-the-rest-api/api-versions
        response = await fetchImplementation(apiUrl, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "Kestrel-Review-First-V1",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
          },
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new PublicGitHubReadError("unavailable");
      }

      if (response.status >= 300 && response.status < 400) {
        throw new PublicGitHubReadError("redirected");
      }
      if (response.status === 404) {
        throw new PublicGitHubReadError("not_found");
      }
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after")))
      ) {
        throw new PublicGitHubReadError("rate_limited", normalizedRateLimitReset(response));
      }
      if (response.status !== 200) {
        throw new PublicGitHubReadError("unavailable");
      }

      return normalizeObservation(await readBoundedJson(response), requested);
    },
  };
}
