import { z } from "zod";
import {
  FactoryGitHubRepositorySchema,
  RepositorySnapshotSchema,
  type FactoryGitHubRepository,
} from "@kestrel/contracts";
import { runFactoryGitHubCli } from "./factory-github-cli.js";
import {
  createFactoryGitHubAdapter,
  FactoryGitHubError,
  factoryGitHubHttpFailure,
  failedFactoryGitHubWrite,
  hasFactoryGitHubMarker,
  nextFactoryGitHubPage,
  readFactoryGitHubHttpResponse,
  type FactoryGitHubIdentity,
  type Reconciliation,
  type WriteResult,
} from "./factory-github.js";

export interface FactoryFeaturePullRequestPayload {
  title: string;
  body: string;
  marker: string;
  baseRef: string;
  headRef: string;
  baseCommitId: string;
  headCommitId: string;
}
export interface FactoryFeaturePullRequest extends FactoryFeaturePullRequestPayload {
  repository: FactoryGitHubRepository;
  id: string;
  nodeId: string;
  repositoryNodeId: string;
  authorNodeId: string;
  number: number;
  url: string;
  state: "open" | "closed";
  author: string;
}
export interface FactoryFeatureGitHubAdapter {
  identify(
    coordinates: Pick<FactoryGitHubRepository, "owner" | "name">,
    signal?: AbortSignal,
  ): Promise<FactoryGitHubIdentity>;
  readTargetBranch(identity: FactoryGitHubIdentity, signal?: AbortSignal): Promise<string>;
  readPullRequest(
    identity: FactoryGitHubIdentity,
    payload: FactoryFeaturePullRequestPayload,
    number: number,
    signal?: AbortSignal,
  ): Promise<FactoryFeaturePullRequest>;
  findPullRequest(
    identity: FactoryGitHubIdentity,
    payload: FactoryFeaturePullRequestPayload,
    signal?: AbortSignal,
  ): Promise<Reconciliation<FactoryFeaturePullRequest>>;
  createPullRequest(
    identity: FactoryGitHubIdentity,
    payload: FactoryFeaturePullRequestPayload,
    signal?: AbortSignal,
  ): Promise<WriteResult<FactoryFeaturePullRequest>>;
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const numberSchema = z.int().positive().max(2_147_483_647);
const branch = z
  .string()
  .min(1)
  .max(244)
  .refine(
    (value) =>
      !value.startsWith("refs/") &&
      !value.startsWith("-") &&
      !/[\s~^:?*[\\]/u.test(value) &&
      !/\p{Cc}/u.test(value) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.endsWith(".") &&
      value
        .split("/")
        .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock")),
  );
const PayloadSchema = z
  .strictObject({
    title: z.string().min(1).max(256),
    body: z.string().min(1).max(65_536),
    marker: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !/[\r\n]/u.test(value)),
    baseRef: branch,
    headRef: branch,
    baseCommitId: sha,
    headCommitId: sha,
  })
  .refine(
    (value) => value.baseRef !== value.headRef && hasFactoryGitHubMarker(value.body, value.marker),
  );
const nodeId = RepositorySnapshotSchema.shape.providerId;
const providerRepository = FactoryGitHubRepositorySchema.extend({ nodeId });
const refSchema = z.strictObject({
  ref: z.string().min(1).max(255),
  sha,
  repo: providerRepository.nullable(),
});
const PullRequestSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .max(32),
  number: numberSchema,
  nodeId,
  title: z.string().min(1).max(512),
  body: z.string().max(65_536).nullable(),
  state: z.enum(["open", "closed"]),
  html_url: z.string().max(512),
  author: z.string().max(100).nullable(),
  authorNodeId: nodeId.nullable(),
  base: refSchema,
  head: refSchema,
});
type ProviderPullRequest = z.infer<typeof PullRequestSchema>;
const REPO_FIELDS =
  "if . == null then null else {id:(.id|tostring),nodeId:.node_id,owner:.owner.login,name} end";
const PR_FIELDS =
  "{id:(.id|tostring),nodeId:.node_id,number,title,body,state,html_url,author:.user.login,authorNodeId:.user.node_id,base:{ref:.base.ref,sha:.base.sha,repo:(.base.repo|" +
  REPO_FIELDS +
  ")},head:{ref:.head.ref,sha:.head.sha,repo:(.head.repo|" +
  REPO_FIELDS +
  ")}}";
const projection =
  'if type == "array" then map(' +
  PR_FIELDS +
  ') elif has("message") then {message} else ' +
  PR_FIELDS +
  " end";
const base = (repository: FactoryGitHubRepository) =>
  `/repos/${repository.owner}/${repository.name}/pulls`;
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new FactoryGitHubError("invalid_response");
  return result.data;
}
function ownedRepository(
  actual: FactoryGitHubRepository | null,
  expected: FactoryGitHubRepository,
): boolean {
  return (
    actual !== null &&
    actual.id === expected.id &&
    same(actual.owner, expected.owner) &&
    same(actual.name, expected.name)
  );
}
function retainedPullRequest(
  identity: FactoryGitHubIdentity,
  payload: FactoryFeaturePullRequestPayload,
  value: ProviderPullRequest,
): FactoryFeaturePullRequest {
  if (value.author === null || value.authorNodeId === null || !same(value.author, identity.account))
    throw new FactoryGitHubError("access_denied");
  if (
    !ownedRepository(value.base.repo, identity.repository) ||
    !ownedRepository(value.head.repo, identity.repository) ||
    value.base.repo === null ||
    value.head.repo === null ||
    value.base.repo.nodeId !== value.head.repo.nodeId ||
    !same(
      value.html_url,
      `https://github.com/${identity.repository.owner}/${identity.repository.name}/pull/${String(value.number)}`,
    ) ||
    value.title !== payload.title ||
    value.body !== payload.body ||
    !hasFactoryGitHubMarker(value.body, payload.marker) ||
    value.base.ref !== payload.baseRef ||
    value.head.ref !== payload.headRef ||
    value.base.sha !== payload.baseCommitId ||
    value.head.sha !== payload.headCommitId
  )
    throw new FactoryGitHubError("invalid_response");
  return {
    ...payload,
    repository: { ...identity.repository },
    id: value.id,
    nodeId: value.nodeId,
    repositoryNodeId: value.base.repo.nodeId,
    authorNodeId: value.authorNodeId,
    number: value.number,
    url: value.html_url,
    state: value.state,
    author: value.author,
  };
}

/**
 * Controller-only port. Persist the attempt before createPullRequest; after an
 * uncertain attempt use findPullRequest. A missing result does not authorize another POST.
 */
export function createFactoryFeatureGitHubAdapter(
  options: { executable?: string; timeoutMs?: number } = {},
): FactoryFeatureGitHubAdapter {
  const existing = createFactoryGitHubAdapter(options);
  const api = (endpoint: string, signal?: AbortSignal, input?: string, fields = projection) =>
    runFactoryGitHubCli({
      executable: options.executable ?? process.env.KESTREL_GH_EXECUTABLE ?? "gh",
      timeoutMs: options.timeoutMs ?? 10_000,
      args: [
        "api",
        "--hostname",
        "github.com",
        endpoint,
        "--method",
        input === undefined ? "GET" : "POST",
        "--include",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        "--jq",
        fields,
        ...(input === undefined ? [] : ["--input", "-"]),
      ],
      ...(signal === undefined ? {} : { signal }),
      ...(input === undefined ? {} : { input }),
    });
  const get = async (endpoint: string, signal?: AbortSignal, fields = projection) => {
    const output = await api(endpoint, signal, undefined, fields);
    if (output.failure !== undefined) throw new FactoryGitHubError(output.failure);
    if (output.exitCode === 4) throw new FactoryGitHubError("needs_authentication");
    const response = readFactoryGitHubHttpResponse(output.stdout);
    if (response.status !== 200 || output.exitCode !== 0) throw factoryGitHubHttpFailure(response);
    return response;
  };
  const verify = async (identity: FactoryGitHubIdentity, signal?: AbortSignal) => {
    const current = await existing.identify(
      { owner: identity.repository.owner, name: identity.repository.name },
      signal,
    );
    if (current.repository.id !== identity.repository.id)
      throw new FactoryGitHubError("repository_changed");
    if (!same(current.account, identity.account)) throw new FactoryGitHubError("access_denied");
  };
  const find: FactoryFeatureGitHubAdapter["findPullRequest"] = async (identity, input, signal) => {
    const payload = parse(PayloadSchema, input);
    await verify(identity, signal);
    const matches = new Map<string, FactoryFeaturePullRequest>();
    let page: number | null = 1,
      limited = false,
      ambiguous = false;
    while (page !== null) {
      const response = await get(
        `${base(identity.repository)}?state=all&sort=created&direction=desc&per_page=20&page=${String(page)}`,
        signal,
      );
      for (const value of parse(z.array(PullRequestSchema).max(20), response.body)) {
        const marker = hasFactoryGitHubMarker(value.body, payload.marker);
        const branch = value.head.ref === payload.headRef;
        if (!marker && !branch) continue;
        try {
          matches.set(value.id, retainedPullRequest(identity, payload, value));
        } catch {
          ambiguous = true;
        }
      }
      const next = nextFactoryGitHubPage(response, identity.repository, page, "/pulls");
      page = next.nextPage;
      limited = next.limited;
    }
    await verify(identity, signal);
    if (ambiguous || matches.size > 1) return { state: "ambiguous" };
    if (limited) return { state: "limited" };
    const value = matches.values().next().value;
    return value === undefined ? { state: "missing" } : { state: "found", value };
  };
  return {
    identify: (coordinates, signal) => existing.identify(coordinates, signal),
    async readTargetBranch(identity, signal) {
      await verify(identity, signal);
      const result = parse(
        FactoryGitHubRepositorySchema.extend({ defaultBranch: branch }),
        (
          await get(
            `/repos/${identity.repository.owner}/${identity.repository.name}`,
            signal,
            'if has("message") then {message} else {id:(.id|tostring),owner:.owner.login,name,defaultBranch:.default_branch} end',
          )
        ).body,
      );
      if (!ownedRepository(result, identity.repository))
        throw new FactoryGitHubError("repository_changed");
      await verify(identity, signal);
      return result.defaultBranch;
    },
    findPullRequest: find,
    async readPullRequest(identity, input, number, signal) {
      const payload = parse(PayloadSchema, input);
      parse(numberSchema, number);
      await verify(identity, signal);
      const value = parse(
        PullRequestSchema,
        (await get(`${base(identity.repository)}/${String(number)}`, signal)).body,
      );
      if (value.number !== number) throw new FactoryGitHubError("invalid_response");
      const result = retainedPullRequest(identity, payload, value);
      await verify(identity, signal);
      return result;
    },
    async createPullRequest(identity, input, signal) {
      let payload: FactoryFeaturePullRequestPayload;
      try {
        payload = parse(PayloadSchema, input);
        const found = await find(identity, payload, signal);
        if (found.state === "found") return { state: "confirmed", value: found.value };
        if (found.state !== "missing")
          throw new FactoryGitHubError(
            found.state === "limited" ? "reconciliation_limit" : "uncertain_write",
          );
      } catch (error) {
        return failedFactoryGitHubWrite("not_sent", error);
      }
      try {
        const output = await api(
          base(identity.repository),
          signal,
          JSON.stringify({
            title: payload.title,
            body: payload.body,
            base: payload.baseRef,
            head: payload.headRef,
            maintainer_can_modify: false,
          }),
        );
        if (output.failure !== undefined)
          return failedFactoryGitHubWrite(
            output.started ? "uncertain" : "not_sent",
            new FactoryGitHubError(output.failure),
          );
        if (output.exitCode === 4)
          return failedFactoryGitHubWrite(
            "uncertain",
            new FactoryGitHubError("needs_authentication"),
          );
        const response = readFactoryGitHubHttpResponse(output.stdout);
        if (response.status >= 400 && response.status < 500)
          return failedFactoryGitHubWrite("rejected", factoryGitHubHttpFailure(response));
        if (response.status !== 201 || output.exitCode !== 0)
          return failedFactoryGitHubWrite("uncertain", factoryGitHubHttpFailure(response));
        const value = retainedPullRequest(
          identity,
          payload,
          parse(PullRequestSchema, response.body),
        );
        await verify(identity, signal);
        return { state: "confirmed", value };
      } catch (error) {
        return failedFactoryGitHubWrite("uncertain", error);
      }
    },
  };
}
