import { z } from "zod";
import { KestrelIdSchema, type FactoryFeatureMergeFailure } from "@kestrel/contracts";
import {
  claimFactoryFeatureMerge,
  claimNextFactoryFeatureMergeIssue,
  completeFactoryFeatureMerge,
  completeFactoryFeatureMergeIssue,
  failFactoryFeatureMerge,
  failFactoryFeatureMergeIssue,
  finishFactoryFeatureMerge,
  markFactoryFeatureMergeWrite,
  queueFactoryExecutions,
  type ClaimedFactoryFeatureMerge,
  type DatabasePool,
  type DiagnosticJobSender,
} from "@kestrel/database";

import {
  createFactoryFeatureGitHubAdapter,
  type FactoryFeatureGitHubAdapter,
  type FactoryFeatureMergeObservation,
} from "./factory-feature-github.js";
import { FactoryGitHubError } from "./factory-github.js";

export const FACTORY_FEATURE_MERGE_WORK_OPTIONS = {
  batchSize: 1,
  localConcurrency: 2,
  pollingIntervalSeconds: 1,
  notifyPollingIntervalSeconds: 5,
} as const;

interface Options {
  pool: DatabasePool;
  boss: DiagnosticJobSender;
  github?: Pick<
    FactoryFeatureGitHubAdapter,
    "identify" | "inspectPullRequestForMerge" | "mergePullRequest" | "closeIssue"
  >;
}

class MergeFailure extends Error {
  constructor(
    readonly failure: FactoryFeatureMergeFailure,
    readonly uncertain = false,
  ) {
    super(`Factory Feature merge stopped: ${failure}`);
  }
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

function providerFailure(error: unknown, signal: AbortSignal): MergeFailure {
  if (error instanceof MergeFailure) return error;
  if (signal.aborted) return new MergeFailure("timeout");
  if (error instanceof FactoryGitHubError) {
    if (error.failure === "needs_authentication") return new MergeFailure("needs_authentication");
    if (error.failure === "access_denied") return new MergeFailure("access_denied");
    if (error.failure === "rate_limited") return new MergeFailure("rate_limited");
    if (error.failure === "timeout") return new MergeFailure("timeout");
    if (["repository_changed", "invalid_response"].includes(error.failure))
      return new MergeFailure("invalid_response");
  }
  return new MergeFailure("unavailable");
}

function assertExactReady(
  claim: ClaimedFactoryFeatureMerge,
  observed: FactoryFeatureMergeObservation,
): void {
  if (observed.headCommitId !== claim.sourceReview.headCommitId)
    throw new MergeFailure("pull_request_changed");
  if (observed.merged) {
    if (
      !claim.mergeAttempted ||
      observed.state !== "closed" ||
      observed.mergeCommitId === null ||
      observed.mergedAt === null
    )
      throw new MergeFailure("pull_request_closed");
    return;
  }
  if (observed.baseCommitId !== claim.sourceReview.baseCommitId)
    throw new MergeFailure("pull_request_changed");
  if (observed.state !== "open") throw new MergeFailure("pull_request_closed");
  if (observed.mergeable === false) throw new MergeFailure("merge_conflict");
  if (observed.mergeable === null) throw new MergeFailure("unavailable");
  if (observed.checks.some((check) => check.state === "failure"))
    throw new MergeFailure("checks_failed");
  if (observed.checks.some((check) => check.state === "pending"))
    throw new MergeFailure("checks_pending");
}

function issueFailure(failure: string) {
  return [
    "needs_authentication",
    "access_denied",
    "rate_limited",
    "invalid_response",
    "timeout",
  ].includes(failure)
    ? (failure as
        "needs_authentication" | "access_denied" | "rate_limited" | "invalid_response" | "timeout")
    : ("unavailable" as const);
}

async function closeLinkedIssues(
  options: Options,
  github: Pick<FactoryFeatureGitHubAdapter, "closeIssue">,
  identity: ClaimedFactoryFeatureMerge["identity"],
  claim: ClaimedFactoryFeatureMerge,
  signal: AbortSignal,
) {
  for (;;) {
    const linked = await claimNextFactoryFeatureMergeIssue(options.pool, claim);
    if (linked === null) break;
    try {
      const result = await github.closeIssue(identity, linked.issue, signal);
      if (result.state === "confirmed")
        await completeFactoryFeatureMergeIssue(options.pool, claim, linked, result.value.closedAt);
      else
        await failFactoryFeatureMergeIssue(
          options.pool,
          claim,
          linked,
          issueFailure(result.failure),
        );
    } catch (error) {
      const failure = providerFailure(error, signal);
      await failFactoryFeatureMergeIssue(
        options.pool,
        claim,
        linked,
        issueFailure(failure.failure),
      );
    }
  }
  await finishFactoryFeatureMerge(options.pool, claim);
}

async function processMerge(options: Options, featureId: string, signal: AbortSignal) {
  const claim = await claimFactoryFeatureMerge(options.pool, featureId);
  if (claim === null) return;
  const github = options.github ?? createFactoryFeatureGitHubAdapter();
  let providerConfirmed = claim.provider.merged;
  try {
    signal.throwIfAborted();
    const identity = await github.identify(
      { owner: claim.identity.repository.owner, name: claim.identity.repository.name },
      signal,
    );
    if (
      identity.repository.id !== claim.identity.repository.id ||
      !same(identity.repository.owner, claim.identity.repository.owner) ||
      !same(identity.repository.name, claim.identity.repository.name) ||
      !same(identity.account, claim.identity.account)
    )
      throw new MergeFailure("access_denied");

    if (!claim.provider.merged) {
      const observed = await github.inspectPullRequestForMerge(identity, claim.pullRequest, signal);
      assertExactReady(claim, observed);
      if (observed.merged) {
        if (observed.mergeCommitId === null || observed.mergedAt === null)
          throw new MergeFailure("invalid_response");
        await completeFactoryFeatureMerge(options.pool, claim, {
          mergeCommitId: observed.mergeCommitId,
          mergedAt: observed.mergedAt,
        });
        providerConfirmed = true;
      } else {
        if (!claim.mergeAttempted) await markFactoryFeatureMergeWrite(options.pool, claim);
        const result = await github.mergePullRequest(identity, claim.pullRequest, signal);
        if (result.state !== "confirmed")
          throw new MergeFailure(
            result.state === "uncertain"
              ? "uncertain_write"
              : providerFailure(new FactoryGitHubError(result.failure), signal).failure,
            result.state === "uncertain",
          );
        const confirmed = await github.inspectPullRequestForMerge(
          identity,
          claim.pullRequest,
          signal,
        );
        if (
          confirmed.headCommitId !== claim.sourceReview.headCommitId ||
          !confirmed.merged ||
          confirmed.state !== "closed" ||
          confirmed.mergeCommitId === null ||
          confirmed.mergedAt === null ||
          confirmed.mergeCommitId !== result.value.mergeCommitId
        )
          throw new MergeFailure("uncertain_write", true);
        await completeFactoryFeatureMerge(options.pool, claim, {
          mergeCommitId: confirmed.mergeCommitId,
          mergedAt: confirmed.mergedAt,
        });
        providerConfirmed = true;
      }
      await queueFactoryExecutions(options.pool, options.boss);
    }
    await closeLinkedIssues(options, github, identity, claim, signal);
  } catch (error) {
    if (providerConfirmed) {
      await finishFactoryFeatureMerge(options.pool, claim);
      return;
    }
    const failure = providerFailure(error, signal);
    await failFactoryFeatureMerge(options.pool, claim, failure.failure, failure.uncertain);
  }
}

export function createFactoryFeatureMergeProcessor(options: Options) {
  const shutdown = new AbortController();
  const active = new Set<Promise<void>>();
  let stopped = false;
  return {
    process(data: unknown, jobSignal?: AbortSignal): Promise<void> {
      if (stopped) return Promise.reject(new MergeFailure("unavailable"));
      const { featureId } = z.strictObject({ featureId: KestrelIdSchema }).parse(data);
      const signal = AbortSignal.any([
        shutdown.signal,
        AbortSignal.timeout(170_000),
        ...(jobSignal === undefined ? [] : [jobSignal]),
      ]);
      const operation = processMerge(options, featureId, signal).finally(() => {
        active.delete(operation);
      });
      active.add(operation);
      return operation;
    },
    async stop() {
      stopped = true;
      shutdown.abort();
      await Promise.allSettled([...active]);
    },
  };
}
