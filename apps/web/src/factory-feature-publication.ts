import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  FactoryFeaturePublicationFailureSchema,
  FactoryFeaturePublicationOperationSchema,
  FactoryFeaturePullRequestSchema,
  KestrelIdSchema,
  type FactoryFeaturePublicationOperation,
  type FactoryFeaturePublicationReview,
  type FactoryFeaturePullRequest,
} from "@kestrel/contracts";
import {
  FactoryError,
  FactoryFeaturePublicationError,
  claimFactoryFeaturePublication,
  prepareFactoryFeaturePublicationOperation,
  markFactoryFeaturePublicationWrite,
  confirmFactoryFeaturePublicationPush,
  bindFactoryFeaturePullRequest,
  bindFactoryFeaturePublicationRevision,
  failFactoryFeaturePublication,
  isFactoryFeaturePublicationRunning,
  type ClaimedFactoryFeaturePublication,
  type DatabasePool,
} from "@kestrel/database";
import {
  openFeatureWorkspace,
  assertFeatureWorkspaceSnapshot,
  identifyFeaturePublicationRemote,
  readFeaturePublicationRefs,
  pushFeaturePublicationHead,
  FeaturePublicationGitError,
  FeatureWorkspaceError,
  type FeaturePublicationSource,
  type LocalSourceConfig,
} from "@kestrel/local-source";
import { FactoryGitHubError } from "./factory-github.js";
import {
  createFactoryFeatureGitHubAdapter,
  type FactoryFeatureGitHubAdapter,
} from "./factory-feature-github.js";

export const FACTORY_FEATURE_PUBLICATION_WORK_OPTIONS = {
  batchSize: 1,
  localConcurrency: 2,
  pollingIntervalSeconds: 1,
  notifyPollingIntervalSeconds: 5,
} as const;

export type RetainFactoryFeatureRevision = (
  claim: ClaimedFactoryFeaturePublication,
  operation: FactoryFeaturePublicationOperation,
  pullRequest: FactoryFeaturePullRequest,
  source: FeaturePublicationSource,
  signal: AbortSignal,
) => Promise<FactoryFeaturePublicationReview>;
interface Options {
  pool: DatabasePool;
  readSourceConfig: () => Promise<LocalSourceConfig>;
  retain: RetainFactoryFeatureRevision;
  github?: FactoryFeatureGitHubAdapter;
  git?: {
    identifyRemote: typeof identifyFeaturePublicationRemote;
    readRefs: typeof readFeaturePublicationRefs;
    push: typeof pushFeaturePublicationHead;
  };
}

function bounded(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let result = "";
  let bytes = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > maxBytes - 4) break;
    result += character;
  }
  return `${result} …`;
}
function literal(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("#", "&#35;")
    .replaceAll("@", "&#64;")
    .replace(/[\\`*_[\]]/gu, "\\$&");
}

/** Display text comes from the approved plan; it never supplies publication authority. */
export function renderFactoryFeaturePullRequest(
  claim: ClaimedFactoryFeaturePublication,
  baseRef: string,
) {
  const marker = `<!-- kestrel:feature-pr:${claim.featureId} -->`;
  const scope = literal(
    [
      ...claim.plan.scope.includes.map((item) => `Includes: ${item}`),
      ...claim.plan.scope.excludes.map((item) => `Excludes: ${item}`),
    ].join("\n"),
  );
  const scopeText = bounded(scope, 8_000);
  const quote = (text: string) =>
    text
      .split(/\r?\n/u)
      .map((line) => `> ${line}`)
      .join("\n");
  const body = [
    `Feature ${claim.featureId} · approved plan v${String(claim.version)}`,
    "## Approved purpose",
    quote(literal(claim.plan.objective)),
    "## Approved scope",
    quote(scopeText),
    ...(scopeText !== scope
      ? ["Scope display is shortened; the immutable approved plan retains the full scope."]
      : []),
    "## Work Items",
    ...claim.issues.map(
      (item) =>
        `- ${literal(item.key)}: ${bounded(literal(item.title.replace(/[\r\n]/gu, " ")), 120)} — ${item.issue.url}`,
    ),
    "## Cumulative verification",
    `All ${String(claim.certificate.manifest.length)} approved verification commands passed on the final Feature head.`,
    `Certificate: ${claim.certificate.id}\nApproval: ${claim.approvalId}\nVerification run: ${claim.certificate.runId}`,
    `Base: \`${claim.certificate.revision.baseCommitId}\`\nHead: \`${claim.certificate.revision.headCommitId}\`\nTree: \`${claim.certificate.revision.treeId}\``,
    `Command manifest SHA-256: \`${claim.certificate.manifestDigest}\``,
    `The certificate retains ${String(claim.certificate.evidenceIds.length)} individual passing results. Work Items remain In review; linked issues remain open.`,
    "These results cover the declared verification commands. Conceptual Review has not run yet.",
    marker,
  ].join("\n\n");
  // The approved plan and ordered issue set have fixed bounds; do not silently drop an issue.
  if (Buffer.byteLength(body) > 65_000)
    throw new FactoryFeaturePublicationError("invalid_response");
  return {
    title: claim.title,
    body,
    marker,
    baseRef,
    headRef: claim.certificate.revision.branch.slice("refs/heads/".length),
    baseCommitId: claim.certificate.revision.baseCommitId,
    headCommitId: claim.certificate.revision.headCommitId,
  };
}

export function createFactoryFeaturePublicationProcessor({
  pool,
  readSourceConfig,
  retain,
  github = createFactoryFeatureGitHubAdapter(),
  git = {
    identifyRemote: identifyFeaturePublicationRemote,
    readRefs: readFeaturePublicationRefs,
    push: pushFeaturePublicationHead,
  },
}: Options) {
  const shutdown = new AbortController();
  const active = new Set<Promise<void>>();
  let writes: Promise<void> = Promise.resolve();
  let lastWrite = 0;
  async function write<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const previous = writes;
    let release: (() => void) | undefined;
    writes = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      signal.throwIfAborted();
      const remaining = 1_000 - (Date.now() - lastWrite);
      if (remaining > 0) await delay(remaining, undefined, { signal });
      signal.throwIfAborted();
      lastWrite = Date.now();
      return await action();
    } finally {
      release?.();
    }
  }

  async function publish(claim: ClaimedFactoryFeaturePublication, signal: AbortSignal) {
    signal.throwIfAborted();
    const config = await readSourceConfig();
    const workspace = await openFeatureWorkspace(config, claim.workspace, {
      signal,
      documents: { planMarkdown: claim.planMarkdown, specMarkdown: claim.specMarkdown },
    });
    const source: FeaturePublicationSource = {
      workspace,
      snapshot: {
        headCommitId: claim.certificate.revision.headCommitId,
        treeId: claim.certificate.revision.treeId,
      },
    };
    await assertFeatureWorkspaceSnapshot(workspace, source.snapshot, { signal });
    const identity = await github.identify(
      {
        owner: claim.identity.repository.owner,
        name: claim.identity.repository.name,
      },
      signal,
    );
    if (
      identity.repository.id !== claim.identity.repository.id ||
      identity.repository.owner.toLowerCase() !== claim.identity.repository.owner.toLowerCase() ||
      identity.repository.name.toLowerCase() !== claim.identity.repository.name.toLowerCase() ||
      identity.account.toLowerCase() !== claim.identity.account.toLowerCase()
    )
      throw new FactoryFeaturePublicationError("repository_changed");
    let operation = claim.operation;
    if (operation === null) {
      if (claim.cancelled) throw new FactoryFeaturePublicationError("cancelled");
      const baseRef = await github.readTargetBranch(identity, signal);
      const remote = await git.identifyRemote(
        config,
        source,
        {
          repository: {
            owner: identity.repository.owner,
            name: identity.repository.name,
          },
          remoteName: "origin",
          targetRef: `refs/heads/${baseRef}`,
        },
        { signal },
      );
      const refs = await git.readRefs(config, source, remote, { signal });
      if (refs.targetHead === null) throw new FactoryFeaturePublicationError("target_unavailable");
      if (refs.targetHead !== claim.certificate.revision.baseCommitId)
        throw new FactoryFeaturePublicationError("target_changed");
      if (refs.featureHead !== null && refs.featureHead !== source.snapshot.headCommitId)
        throw new FactoryFeaturePublicationError("feature_ref_conflict");
      operation = await prepareFactoryFeaturePublicationOperation(
        pool,
        claim,
        FactoryFeaturePublicationOperationSchema.parse({
          id: claim.featureId,
          featureId: claim.featureId,
          target: {
            certificateId: claim.certificate.id,
            approvedVersion: claim.version,
            approvalId: claim.approvalId,
            source: claim.certificate.source,
            revision: claim.certificate.revision,
            identity: claim.identity,
            remote,
          },
          issues: claim.issues,
          payload: renderFactoryFeaturePullRequest(claim, baseRef),
        }),
      );
    }
    let pull = claim.pullRequest;
    if (pull === null) {
      if (!claim.pushConfirmed) {
        const refs = await git.readRefs(config, source, operation.target.remote, { signal });
        if (refs.featureHead === source.snapshot.headCommitId) {
          await confirmFactoryFeaturePublicationPush(pool, claim);
        } else {
          if (refs.featureHead !== null)
            throw new FactoryFeaturePublicationError("feature_ref_conflict");
          if (claim.pushAttempted) throw new FactoryFeaturePublicationError("uncertain_write");
          if (claim.cancelled) throw new FactoryFeaturePublicationError("cancelled");
          if (refs.targetHead === null)
            throw new FactoryFeaturePublicationError("target_unavailable");
          if (refs.targetHead !== operation.target.revision.baseCommitId)
            throw new FactoryFeaturePublicationError("target_changed");
          signal.throwIfAborted();
          await markFactoryFeaturePublicationWrite(pool, claim, "push", true);
          const pushed = await git.push(config, source, operation.target.remote, { signal });
          if (pushed.state !== "confirmed") {
            if (pushed.state !== "uncertain")
              await markFactoryFeaturePublicationWrite(pool, claim, "push", false);
            throw new FactoryFeaturePublicationError(
              pushed.state === "uncertain"
                ? "uncertain_write"
                : FactoryFeaturePublicationFailureSchema.catch("invalid_response").parse(
                    pushed.failure,
                  ),
            );
          }
          if (
            pushed.value.headCommitId !== source.snapshot.headCommitId ||
            pushed.value.ref !== operation.target.revision.branch
          )
            throw new FactoryFeaturePublicationError("uncertain_write");
          await confirmFactoryFeaturePublicationPush(pool, claim);
        }
      }
      if (claim.prAttempted) {
        const found = await github.findPullRequest(
          operation.target.identity,
          operation.payload,
          signal,
        );
        if (found.state !== "found")
          throw new FactoryFeaturePublicationError(
            found.state === "limited" ? "reconciliation_limit" : "uncertain_write",
          );
        pull = FactoryFeaturePullRequestSchema.parse(found.value);
      } else {
        if (claim.cancelled) throw new FactoryFeaturePublicationError("cancelled");
        // A moved target or Feature ref cannot be used to create a different PR after push confirmation.
        const refs = await git.readRefs(config, source, operation.target.remote, { signal });
        if (refs.targetHead === null)
          throw new FactoryFeaturePublicationError("target_unavailable");
        if (refs.targetHead !== operation.target.revision.baseCommitId)
          throw new FactoryFeaturePublicationError("target_changed");
        if (refs.featureHead !== source.snapshot.headCommitId)
          throw new FactoryFeaturePublicationError("feature_ref_conflict");
        const prepared = operation;
        pull = await write(signal, async () => {
          await markFactoryFeaturePublicationWrite(pool, claim, "pr", true);
          const created = await github.createPullRequest(
            prepared.target.identity,
            prepared.payload,
            signal,
          );
          if (created.state !== "confirmed") {
            if (created.state !== "uncertain")
              await markFactoryFeaturePublicationWrite(pool, claim, "pr", false);
            throw new FactoryGitHubError(
              created.state === "uncertain" ? "uncertain_write" : created.failure,
              created.retryAt,
            );
          }
          return FactoryFeaturePullRequestSchema.parse(created.value);
        });
      }
      await bindFactoryFeaturePullRequest(pool, claim, pull);
    }
    signal.throwIfAborted();
    const review = await retain(claim, operation, pull, source, signal);
    await bindFactoryFeaturePublicationRevision(pool, claim, review);
  }

  async function run(data: unknown, jobSignal?: AbortSignal): Promise<void> {
    const { featureId } = z.strictObject({ featureId: KestrelIdSchema }).parse(data);
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(175_000);
    const signal = AbortSignal.any([
      controller.signal,
      deadline,
      shutdown.signal,
      ...(jobSignal === undefined ? [] : [jobSignal]),
    ]);
    const claim = await claimFactoryFeaturePublication(pool, featureId);
    if (claim === null) return;
    let pulse: Promise<void> | null = null;
    const cancellation = setInterval(() => {
      if (pulse !== null) return;
      pulse = isFactoryFeaturePublicationRunning(pool, claim)
        .then((running) => {
          if (!running) controller.abort();
        })
        .catch(() => controller.abort())
        .finally(() => {
          pulse = null;
        });
    }, 1_000);
    cancellation.unref();
    try {
      await publish(claim, signal);
    } catch (error) {
      const code =
        error instanceof FactoryFeaturePublicationError ||
        error instanceof FeaturePublicationGitError
          ? error.code
          : error instanceof FactoryGitHubError
            ? error.failure
            : deadline.aborted
              ? "timeout"
              : signal.aborted
                ? "cancelled"
                : error instanceof FeatureWorkspaceError
                  ? "workspace_changed"
                  : "unavailable";
      try {
        await failFactoryFeaturePublication(
          pool,
          claim,
          FactoryFeaturePublicationFailureSchema.catch("invalid_response").parse(code),
          error instanceof FactoryGitHubError ? error.retryAt : undefined,
        );
      } catch (stale) {
        if (!(stale instanceof FactoryError) || stale.code !== "conflict") throw stale;
      }
    } finally {
      clearInterval(cancellation);
      await Promise.resolve(pulse);
    }
  }
  return {
    process(data: unknown, signal?: AbortSignal): Promise<void> {
      if (shutdown.signal.aborted) return Promise.resolve();
      const work = run(data, signal);
      active.add(work);
      void work.finally(() => active.delete(work)).catch(() => {});
      return work;
    },
    async stop(): Promise<void> {
      shutdown.abort();
      await Promise.allSettled(active);
    },
  };
}
