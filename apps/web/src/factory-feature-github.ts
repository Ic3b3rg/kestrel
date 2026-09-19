import { z } from "zod";
import {
  FactoryFeaturePublicationIssueSchema,
  FactoryGitHubRepositorySchema,
  RepositorySnapshotSchema,
  type FactoryGitHubRepository,
  type FactoryFeaturePublicationIssue,
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
export interface FactoryFeaturePullRequestObservation {
  baseCommitId: string;
  headCommitId: string;
  state: "open" | "closed";
}
export interface FactoryFeatureMergeCheck {
  name: string;
  state: "success" | "pending" | "failure";
  required: true;
}
export interface FactoryFeatureMergeObservation extends FactoryFeaturePullRequestObservation {
  merged: boolean;
  mergeCommitId: string | null;
  mergedAt: string | null;
  mergeable: boolean | null;
  checks: FactoryFeatureMergeCheck[];
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
  observePullRequest(
    identity: FactoryGitHubIdentity,
    expected: FactoryFeaturePullRequest,
    signal?: AbortSignal,
  ): Promise<FactoryFeaturePullRequestObservation>;
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
  inspectPullRequestForMerge(
    identity: FactoryGitHubIdentity,
    expected: FactoryFeaturePullRequest,
    signal?: AbortSignal,
  ): Promise<FactoryFeatureMergeObservation>;
  mergePullRequest(
    identity: FactoryGitHubIdentity,
    expected: FactoryFeaturePullRequest,
    signal?: AbortSignal,
  ): Promise<WriteResult<{ mergeCommitId: string }>>;
  closeIssue(
    identity: FactoryGitHubIdentity,
    expected: FactoryFeaturePublicationIssue["issue"],
    signal?: AbortSignal,
  ): Promise<WriteResult<{ closedAt: string }>>;
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
const MergePullRequestSchema = PullRequestSchema.extend({
  merged: z.boolean(),
  merge_commit_sha: sha.nullable(),
  merged_at: z.iso.datetime().nullable(),
  mergeable: z.boolean().nullable(),
  mergeable_state: z.string().min(1).max(64),
});
const BranchReadinessSchema = z.strictObject({
  name: branch,
  protected: z.boolean(),
  requiredContexts: z.array(z.string().min(1).max(255)).max(200),
});
const CombinedStatusSchema = z.strictObject({
  state: z.enum(["success", "pending", "failure", "error"]),
  statuses: z
    .array(
      z.strictObject({
        context: z.string().min(1).max(255),
        state: z.enum(["success", "pending", "failure", "error"]),
      }),
    )
    .max(1000),
});
const CheckRunsSchema = z.strictObject({
  check_runs: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(255),
        status: z.enum(["queued", "in_progress", "completed", "pending", "requested", "waiting"]),
        conclusion: z
          .enum([
            "success",
            "failure",
            "neutral",
            "cancelled",
            "skipped",
            "timed_out",
            "action_required",
            "stale",
            "startup_failure",
          ])
          .nullable(),
      }),
    )
    .max(1000),
});
const MergeResultSchema = z.strictObject({
  merged: z.boolean(),
  sha: sha.nullable(),
  message: z.string().max(2048),
});
const CloseIssueInputSchema = FactoryFeaturePublicationIssueSchema.shape.issue;
const ClosedIssueSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .max(32),
  number: numberSchema,
  state: z.enum(["open", "closed"]),
  closed_at: z.iso.datetime().nullable(),
  html_url: z.string().max(512),
  repository_url: z.string().max(512),
  isPullRequest: z.boolean(),
});
type ProviderPullRequest = z.infer<typeof PullRequestSchema>;
const ExpectedPullRequestSchema = PayloadSchema.extend({
  repository: FactoryGitHubRepositorySchema,
  id: PullRequestSchema.shape.id,
  nodeId,
  repositoryNodeId: nodeId,
  authorNodeId: nodeId,
  number: numberSchema,
  url: z.url().max(512),
  state: z.enum(["open", "closed"]),
  author: z.string().min(1).max(100),
});
const REPO_FIELDS =
  "if . == null then null else {id:(.id|tostring),nodeId:.node_id,owner:.owner.login,name} end";
const PR_FIELDS =
  "{id:(.id|tostring),nodeId:.node_id,number,title,body,state,html_url,author:.user.login,authorNodeId:.user.node_id,base:{ref:.base.ref,sha:.base.sha,repo:(.base.repo|" +
  REPO_FIELDS +
  ")},head:{ref:.head.ref,sha:.head.sha,repo:(.head.repo|" +
  REPO_FIELDS +
  ")}}";
const PR_MERGE_FIELDS =
  PR_FIELDS.slice(0, -1) + ",merged,merge_commit_sha,merged_at,mergeable,mergeable_state}";
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

function observedPullRequest(
  identity: FactoryGitHubIdentity,
  input: FactoryFeaturePullRequest,
  value: ProviderPullRequest,
): FactoryFeaturePullRequestObservation {
  const expected = parse(ExpectedPullRequestSchema, input);
  if (
    value.author === null ||
    value.authorNodeId === null ||
    value.base.repo === null ||
    value.head.repo === null ||
    !same(value.author, identity.account) ||
    !same(expected.author, identity.account) ||
    !ownedRepository(value.base.repo, identity.repository) ||
    !ownedRepository(value.head.repo, identity.repository) ||
    value.id !== expected.id ||
    value.nodeId !== expected.nodeId ||
    value.authorNodeId !== expected.authorNodeId ||
    value.base.repo.nodeId !== expected.repositoryNodeId ||
    value.head.repo.nodeId !== expected.repositoryNodeId ||
    value.number !== expected.number ||
    !same(value.html_url, expected.url) ||
    value.base.ref !== expected.baseRef ||
    value.head.ref !== expected.headRef
  )
    throw new FactoryGitHubError("invalid_response");
  return {
    baseCommitId: value.base.sha,
    headCommitId: value.head.sha,
    state: value.state,
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
  const api = (
    endpoint: string,
    signal?: AbortSignal,
    input?: string,
    fields = projection,
    method: "GET" | "POST" | "PUT" | "PATCH" = input === undefined ? "GET" : "POST",
  ) =>
    runFactoryGitHubCli({
      executable: options.executable ?? process.env.KESTREL_GH_EXECUTABLE ?? "gh",
      timeoutMs: options.timeoutMs ?? 10_000,
      args: [
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
  const write = async (
    endpoint: string,
    method: "PUT" | "PATCH",
    input: unknown,
    signal: AbortSignal | undefined,
    fields: string,
  ) => {
    const output = await api(endpoint, signal, JSON.stringify(input), fields, method);
    if (output.failure !== undefined)
      return failedFactoryGitHubWrite(
        output.started ? "uncertain" : "not_sent",
        new FactoryGitHubError(output.failure),
      );
    if (output.exitCode === 4)
      return failedFactoryGitHubWrite("uncertain", new FactoryGitHubError("needs_authentication"));
    let response;
    try {
      response = readFactoryGitHubHttpResponse(output.stdout);
    } catch (error) {
      return failedFactoryGitHubWrite("uncertain", error);
    }
    if (response.status >= 400 && response.status < 500)
      return failedFactoryGitHubWrite("rejected", factoryGitHubHttpFailure(response));
    if (response.status !== 200 || output.exitCode !== 0)
      return failedFactoryGitHubWrite("uncertain", factoryGitHubHttpFailure(response));
    return { state: "confirmed" as const, value: response.body };
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
    async observePullRequest(identity, expected, signal) {
      const input = parse(ExpectedPullRequestSchema, expected);
      await verify(identity, signal);
      const value = parse(
        PullRequestSchema,
        (await get(`${base(identity.repository)}/${String(input.number)}`, signal)).body,
      );
      const result = observedPullRequest(identity, input, value);
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
    async inspectPullRequestForMerge(identity, expected, signal) {
      const input = parse(ExpectedPullRequestSchema, expected);
      await verify(identity, signal);
      const value = parse(
        MergePullRequestSchema,
        (
          await get(
            `${base(identity.repository)}/${String(input.number)}`,
            signal,
            `if has("message") then {message} else ${PR_MERGE_FIELDS} end`,
          )
        ).body,
      );
      const observed = observedPullRequest(identity, input, value);
      if (value.merged) {
        if (value.merge_commit_sha === null || value.merged_at === null || value.state !== "closed")
          throw new FactoryGitHubError("invalid_response");
        await verify(identity, signal);
        return {
          ...observed,
          merged: true,
          mergeCommitId: value.merge_commit_sha,
          mergedAt: new Date(value.merged_at).toISOString(),
          mergeable: value.mergeable,
          checks: [],
        };
      }
      if (value.merge_commit_sha !== null || value.merged_at !== null)
        throw new FactoryGitHubError("invalid_response");
      const escapedBranch = encodeURIComponent(input.baseRef);
      const branchResult = await get(
        `/repos/${identity.repository.owner}/${identity.repository.name}/branches/${escapedBranch}`,
        signal,
        'if has("message") then {message} else {name,protected,requiredContexts:(((.protection.required_status_checks.contexts // []) + ((.protection.required_status_checks.checks // []) | map(.context))) | unique)} end',
      );
      const statusResult = await get(
        `/repos/${identity.repository.owner}/${identity.repository.name}/commits/${input.headCommitId}/status?per_page=100`,
        signal,
        'if has("message") then {message} else {state,statuses:[.statuses[]|{context,state}]} end',
      );
      const checksResult = await get(
        `/repos/${identity.repository.owner}/${identity.repository.name}/commits/${input.headCommitId}/check-runs?per_page=100`,
        signal,
        'if has("message") then {message} else {check_runs:[.check_runs[]|{name,status,conclusion}]} end',
      );
      const protectedBranch = parse(BranchReadinessSchema, branchResult.body);
      if (protectedBranch.name !== input.baseRef) throw new FactoryGitHubError("invalid_response");
      const statuses = parse(CombinedStatusSchema, statusResult.body).statuses;
      const checkRuns = parse(CheckRunsSchema, checksResult.body).check_runs;
      const checks: FactoryFeatureMergeCheck[] = protectedBranch.requiredContexts.map((name) => {
        const status = statuses.find((item) => item.context === name);
        const run = checkRuns.find((item) => item.name === name);
        const success =
          status?.state === "success" ||
          (run?.status === "completed" &&
            ["success", "neutral", "skipped"].includes(run.conclusion ?? ""));
        const pending =
          status?.state === "pending" ||
          (run !== undefined && run.status !== "completed") ||
          (status === undefined && run === undefined);
        return {
          name,
          required: true,
          state: success ? "success" : pending ? "pending" : "failure",
        };
      });
      await verify(identity, signal);
      return {
        ...observed,
        merged: false,
        mergeCommitId: null,
        mergedAt: null,
        mergeable: value.mergeable,
        checks,
      };
    },
    async mergePullRequest(identity, expected, signal) {
      let input: z.infer<typeof ExpectedPullRequestSchema>;
      try {
        input = parse(ExpectedPullRequestSchema, expected);
        await verify(identity, signal);
      } catch (error) {
        return failedFactoryGitHubWrite("not_sent", error);
      }
      try {
        const result = await write(
          `${base(identity.repository)}/${String(input.number)}/merge`,
          "PUT",
          { sha: input.headCommitId },
          signal,
          'if has("message") then {merged,sha,message} else {merged,sha,message} end',
        );
        if (result.state !== "confirmed") return result;
        const merged = parse(MergeResultSchema, result.value);
        if (!merged.merged || merged.sha === null)
          return failedFactoryGitHubWrite("rejected", new FactoryGitHubError("invalid_response"));
        await verify(identity, signal);
        return { state: "confirmed", value: { mergeCommitId: merged.sha } };
      } catch (error) {
        return failedFactoryGitHubWrite("uncertain", error);
      }
    },
    async closeIssue(identity, expected, signal) {
      let input: z.infer<typeof CloseIssueInputSchema>;
      try {
        input = parse(CloseIssueInputSchema, expected);
        if (
          input.repository.id !== identity.repository.id ||
          !same(input.repository.owner, identity.repository.owner) ||
          !same(input.repository.name, identity.repository.name)
        )
          throw new FactoryGitHubError("repository_changed");
        await verify(identity, signal);
        const endpoint = `/repos/${identity.repository.owner}/${identity.repository.name}/issues/${String(input.number)}`;
        const fields =
          'if has("message") then {message} else {id:(.id|tostring),number,state,closed_at,html_url,repository_url,isPullRequest:has("pull_request")} end';
        const current = parse(ClosedIssueSchema, (await get(endpoint, signal, fields)).body);
        const valid =
          current.id === input.id &&
          current.number === input.number &&
          !current.isPullRequest &&
          same(current.html_url, input.url) &&
          same(
            current.repository_url,
            `https://api.github.com/repos/${identity.repository.owner}/${identity.repository.name}`,
          );
        if (!valid) throw new FactoryGitHubError("invalid_response");
        if (current.state === "closed") {
          if (current.closed_at === null) throw new FactoryGitHubError("invalid_response");
          return {
            state: "confirmed",
            value: { closedAt: new Date(current.closed_at).toISOString() },
          };
        }
        const result = await write(
          endpoint,
          "PATCH",
          { state: "closed", state_reason: "completed" },
          signal,
          fields,
        );
        if (result.state !== "confirmed") return result;
        const closed = parse(ClosedIssueSchema, result.value);
        if (
          closed.id !== input.id ||
          closed.number !== input.number ||
          closed.state !== "closed" ||
          closed.closed_at === null ||
          closed.isPullRequest ||
          !same(closed.html_url, input.url)
        )
          return failedFactoryGitHubWrite("uncertain", new FactoryGitHubError("invalid_response"));
        await verify(identity, signal);
        return {
          state: "confirmed",
          value: { closedAt: new Date(closed.closed_at).toISOString() },
        };
      } catch (error) {
        return failedFactoryGitHubWrite("uncertain", error);
      }
    },
  };
}
