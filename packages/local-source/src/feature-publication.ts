import { spawn } from "node:child_process";
import type { LocalSourceConfig } from "./config.js";
import { resolveRepository, type ResolvedRepository } from "./discovery.js";
import { LocalSourceError } from "./errors.js";
import {
  assertFeatureWorkspaceSnapshot,
  FeatureWorkspaceError,
  type FeatureWorkspace,
  type FeatureWorkspaceSnapshot,
} from "./feature-workspace.js";
import {
  inspectRepository,
  type GitHubRepositoryIdentity,
  type RepositoryInspection,
} from "./git.js";
import {
  readCredentialConfiguration,
  safeFetchEnvironment,
  SAFE_GIT_CONFIG_ARGUMENTS,
} from "./remote-acquisition.js";

export type FeaturePublicationGitFailure =
  | "invalid_input"
  | "source_changed"
  | "remote_changed"
  | "target_changed"
  | "target_unavailable"
  | "feature_ref_conflict"
  | "workspace_changed"
  | "unavailable"
  | "cancelled"
  | "timeout"
  | "push_rejected";
export class FeaturePublicationGitError extends Error {
  constructor(readonly code: FeaturePublicationGitFailure) {
    super("Feature publication Git operation failed: " + code);
    this.name = "FeaturePublicationGitError";
  }
}
export interface FeaturePublicationSource {
  workspace: FeatureWorkspace;
  snapshot: FeatureWorkspaceSnapshot;
}
export interface FeaturePublicationRemote {
  repository: GitHubRepositoryIdentity;
  remoteName: string;
  configuredUrl: string;
  configuredPushUrl: string | null;
  canonicalUrl: string;
  targetRef: string;
}
export interface FeaturePublicationRefs {
  targetHead: string | null;
  featureHead: string | null;
}
export type FeaturePublicationPushResult =
  | { state: "confirmed"; value: { headCommitId: string; ref: string } }
  | { state: "not_sent" | "rejected" | "uncertain"; failure: FeaturePublicationGitFailure };
interface Options {
  signal?: AbortSignal;
  timeoutMs?: number;
}
interface ProcessResult {
  started: boolean;
  exitCode: number | null;
  stdout: string;
  failure?: FeaturePublicationGitFailure;
}
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const failure = (error: unknown): FeaturePublicationGitFailure =>
  error instanceof FeaturePublicationGitError
    ? error.code
    : error instanceof FeatureWorkspaceError
      ? error.code === "workspace_cancelled"
        ? "cancelled"
        : "workspace_changed"
      : error instanceof LocalSourceError && error.code === "acquisition_cancelled"
        ? "cancelled"
        : "unavailable";

function run(
  config: LocalSourceConfig,
  args: string[],
  options: Options,
  environment = safeFetchEnvironment([]),
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted === true)
      return resolve({ started: false, exitCode: null, stdout: "", failure: "cancelled" });
    const child = spawn(
      config.gitExecutable,
      ["--no-lazy-fetch", ...SAFE_GIT_CONFIG_ARGUMENTS, ...args],
      {
        env: {
          ...environment,
          // Native gh credential helpers must use the same profile as the identity check.
          ...(process.env.GH_CONFIG_DIR === undefined
            ? {}
            : { GH_CONFIG_DIR: process.env.GH_CONFIG_DIR }),
        },
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let problem: FeaturePublicationGitFailure | undefined;
    let started = child.pid !== undefined;
    let settled = false;
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stop = () => {
      if (settled) return;
      try {
        if (process.platform !== "win32" && child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        } else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      // An escaped descendant may retain these pipes after the original group dies.
      child.stdout.destroy();
      child.stderr.destroy();
      finish(null);
    };
    const abort = () => {
      problem = "cancelled";
      stop();
    };
    const timer = setTimeout(() => {
      problem = "timeout";
      stop();
    }, options.timeoutMs ?? 10_000);
    timer.unref();
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      let stdout = "";
      try {
        stdout = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        problem ??= "unavailable";
      }
      resolve({
        started,
        exitCode,
        stdout,
        ...(problem === undefined ? {} : { failure: problem }),
      });
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once("spawn", () => {
      started = true;
    });
    child.once("error", () => {
      problem ??= "unavailable";
      stop();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 64 * 1024) {
        problem = "unavailable";
        stop();
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) {
        problem = "unavailable";
        stop();
      }
    });
    child.once("close", finish);
  });
}
async function checked(
  config: LocalSourceConfig,
  args: string[],
  options: Options,
  allowed = [0],
): Promise<ProcessResult> {
  const result = await run(config, args, options);
  if (
    result.failure !== undefined ||
    result.exitCode === null ||
    !allowed.includes(result.exitCode)
  )
    throw new FeaturePublicationGitError(result.failure ?? "unavailable");
  return result;
}
const workspaceArgs = ({ workspace }: FeaturePublicationSource) => [
  "--git-dir=" + workspace.gitDirectory,
  "--work-tree=" + workspace.workspacePath,
];
function validRef(ref: string): boolean {
  return (
    ref.startsWith("refs/heads/") &&
    ref.length <= 255 &&
    !/[\s~^:?*[\\]/u.test(ref) &&
    !/\p{Cc}/u.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !ref.includes("//") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".") &&
    ref.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"))
  );
}
function validRemoteUrl(url: string, repository: GitHubRepositoryIdentity): boolean {
  const suffix = repository.owner + "/" + repository.name;
  return ["https://github.com/", "git@github.com:", "ssh://git@github.com/"].some((prefix) =>
    [prefix + suffix, prefix + suffix + ".git"].some((candidate) => same(candidate, url)),
  );
}

/** Only the exact original named remote is eligible; another remote never substitutes for it. */
export async function identifyFeaturePublicationRemote(
  config: LocalSourceConfig,
  source: FeaturePublicationSource,
  expected: Pick<FeaturePublicationRemote, "repository" | "remoteName" | "targetRef">,
  options: Options = {},
): Promise<FeaturePublicationRemote> {
  const { workspace, snapshot } = source;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(expected.remoteName) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(expected.repository.owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/u.test(expected.repository.name) ||
    [".", ".."].includes(expected.repository.name) ||
    !validRef(expected.targetRef) ||
    !validRef(workspace.identity.branch) ||
    expected.targetRef === workspace.identity.branch ||
    workspace.identity.objectFormat !== "sha1" ||
    !/^[a-f0-9]{40}$/u.test(snapshot.headCommitId) ||
    !/^[a-f0-9]{40}$/u.test(snapshot.treeId)
  )
    throw new FeaturePublicationGitError("invalid_input");
  try {
    await assertFeatureWorkspaceSnapshot(workspace, snapshot, options);
  } catch (error) {
    throw new FeaturePublicationGitError(failure(error));
  }
  const committedTree = await checked(
    config,
    [
      ...workspaceArgs(source),
      "rev-parse",
      "--verify",
      "--end-of-options",
      snapshot.headCommitId + "^{tree}",
    ],
    options,
  );
  if (committedTree.stdout.trim() !== snapshot.treeId)
    throw new FeaturePublicationGitError("workspace_changed");
  const ancestry = await checked(
    config,
    [
      ...workspaceArgs(source),
      "merge-base",
      "--is-ancestor",
      workspace.identity.baseCommitId,
      snapshot.headCommitId,
    ],
    options,
    [0, 1],
  );
  if (ancestry.exitCode !== 0) throw new FeaturePublicationGitError("workspace_changed");
  let repository: ResolvedRepository;
  let inspection: RepositoryInspection;
  try {
    repository = await resolveRepository(config, workspace.identity.repositoryId);
    inspection = await inspectRepository(config, repository, options.signal);
  } catch (error) {
    throw new FeaturePublicationGitError(
      options.signal?.aborted === true
        ? "cancelled"
        : error instanceof LocalSourceError &&
            [
              "repository_not_available",
              "repository_invalid",
              "source_containment_violation",
            ].includes(error.code)
          ? "source_changed"
          : failure(error),
    );
  }
  if (
    inspection.sourceIdentity !== workspace.identity.sourceIdentity ||
    inspection.objectFormat !== "sha1" ||
    inspection.githubRepository === null ||
    !same(inspection.githubRepository.owner, expected.repository.owner) ||
    !same(inspection.githubRepository.name, expected.repository.name)
  )
    throw new FeaturePublicationGitError("source_changed");
  const values = async (suffix: "url" | "pushurl") => {
    const result = await checked(
      config,
      [
        "-c",
        "safe.directory=" + repository.path,
        "-C",
        repository.path,
        "config",
        "--local",
        "--no-includes",
        "--null",
        "--get-all",
        "remote." + expected.remoteName + "." + suffix,
      ],
      options,
      [0, 1],
    );
    return result.exitCode === 1 ? [] : result.stdout.split("\0").filter((value) => value !== "");
  };
  const urls = await values("url");
  const pushUrls = await values("pushurl");
  const configuredUrl = urls[0];
  const configuredPushUrl = pushUrls[0] ?? null;
  if (
    urls.length !== 1 ||
    configuredUrl === undefined ||
    !validRemoteUrl(configuredUrl, expected.repository) ||
    pushUrls.length > 1 ||
    (configuredPushUrl !== null && !validRemoteUrl(configuredPushUrl, expected.repository))
  )
    throw new FeaturePublicationGitError("remote_changed");
  return {
    repository: { ...expected.repository },
    remoteName: expected.remoteName,
    configuredUrl,
    configuredPushUrl,
    canonicalUrl:
      "https://github.com/" + expected.repository.owner + "/" + expected.repository.name + ".git",
    targetRef: expected.targetRef,
  };
}

export async function readFeaturePublicationRefs(
  config: LocalSourceConfig,
  source: FeaturePublicationSource,
  remote: FeaturePublicationRemote,
  options: Options = {},
): Promise<FeaturePublicationRefs> {
  const current = await identifyFeaturePublicationRemote(config, source, remote, options);
  if (
    current.repository.owner !== remote.repository.owner ||
    current.repository.name !== remote.repository.name ||
    current.remoteName !== remote.remoteName ||
    current.configuredUrl !== remote.configuredUrl ||
    current.configuredPushUrl !== remote.configuredPushUrl ||
    current.canonicalUrl !== remote.canonicalUrl ||
    current.targetRef !== remote.targetRef
  )
    throw new FeaturePublicationGitError("remote_changed");
  const credentials = await readCredentialConfiguration(config, options.signal).catch(
    (error: unknown) => {
      throw new FeaturePublicationGitError(failure(error));
    },
  );
  const result = await run(
    config,
    [
      ...workspaceArgs(source),
      "ls-remote",
      "--refs",
      "--exit-code",
      "--",
      remote.canonicalUrl,
      remote.targetRef,
      source.workspace.identity.branch,
    ],
    options,
    safeFetchEnvironment(credentials),
  );
  if (result.failure !== undefined || ![0, 2].includes(result.exitCode ?? -1))
    throw new FeaturePublicationGitError(result.failure ?? "unavailable");
  const refs = new Map<string, string>();
  for (const line of result.stdout.trimEnd().split("\n")) {
    if (line === "") continue;
    const fields = line.split("\t");
    const [head, ref] = fields;
    if (
      fields.length !== 2 ||
      head === undefined ||
      !/^[a-f0-9]{40}$/u.test(head) ||
      ref === undefined ||
      ![remote.targetRef, source.workspace.identity.branch].includes(ref) ||
      refs.has(ref)
    )
      throw new FeaturePublicationGitError("unavailable");
    refs.set(ref, head);
  }
  return {
    targetHead: refs.get(remote.targetRef) ?? null,
    featureHead: refs.get(source.workspace.identity.branch) ?? null,
  };
}

/**
 * One controller attempt. After uncertainty the durable caller reads the exact
 * ref; an absent ref does not authorize another push.
 */
export async function pushFeaturePublicationHead(
  config: LocalSourceConfig,
  source: FeaturePublicationSource,
  remote: FeaturePublicationRemote,
  options: Options = {},
): Promise<FeaturePublicationPushResult> {
  const confirmed = {
    state: "confirmed" as const,
    value: { headCommitId: source.snapshot.headCommitId, ref: source.workspace.identity.branch },
  };
  let environment: NodeJS.ProcessEnv;
  try {
    const refs = await readFeaturePublicationRefs(config, source, remote, options);
    if (refs.targetHead === null) throw new FeaturePublicationGitError("target_unavailable");
    if (refs.targetHead !== source.workspace.identity.baseCommitId)
      throw new FeaturePublicationGitError("target_changed");
    if (refs.featureHead === source.snapshot.headCommitId) return confirmed;
    if (refs.featureHead !== null) return { state: "rejected", failure: "feature_ref_conflict" };
    environment = safeFetchEnvironment(await readCredentialConfiguration(config, options.signal));
  } catch (error) {
    return { state: "not_sent", failure: failure(error) };
  }
  const result = await run(
    config,
    [
      ...workspaceArgs(source),
      "push",
      "--porcelain",
      "--atomic",
      "--no-follow-tags",
      "--recurse-submodules=no",
      "--force-with-lease=" + source.workspace.identity.branch + ":",
      "--",
      remote.canonicalUrl,
      source.snapshot.headCommitId + ":" + source.workspace.identity.branch,
    ],
    options,
    environment,
  );
  if (result.failure !== undefined || result.exitCode !== 0) {
    const rejected =
      result.failure === undefined &&
      result.stdout
        .split("\n")
        .some(
          (line) =>
            line.startsWith("!\t") &&
            line.split("\t")[1]?.endsWith(":" + source.workspace.identity.branch),
        );
    return {
      state: !result.started ? "not_sent" : rejected ? "rejected" : "uncertain",
      failure: result.failure ?? (rejected ? "push_rejected" : "unavailable"),
    };
  }
  try {
    const refs = await readFeaturePublicationRefs(config, source, remote, options);
    if (refs.targetHead !== source.workspace.identity.baseCommitId)
      throw new FeaturePublicationGitError("target_changed");
    if (refs.featureHead !== source.snapshot.headCommitId)
      throw new FeaturePublicationGitError("feature_ref_conflict");
    return confirmed;
  } catch (error) {
    return { state: "uncertain", failure: failure(error) };
  }
}
