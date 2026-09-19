import { z } from "zod";
import {
  FactoryConceptualReviewWorkflowReadSchema,
  FactoryFeaturePublicationOperationSchema,
  FactoryFeaturePullRequestSchema,
  KestrelIdSchema,
  type FactoryConceptualReviewPreparation,
  type FactoryConceptualReviewStartCommand,
  type FactoryConceptualReviewWorkflowRead,
  type FactoryReviewCorrectionFailure,
} from "@kestrel/contracts";
import {
  bindFactoryReviewCorrectionRevision,
  bindFactoryReviewCorrectionWorkflow,
  claimFactoryReviewCorrection,
  confirmFactoryReviewCorrectionPush,
  failFactoryReviewCorrection,
  markFactoryReviewCorrectionPush,
  FactoryReviewCorrectionError,
  FactoryFeaturePublicationError,
  type ClaimedFactoryFeaturePublication,
  type DatabasePool,
} from "@kestrel/database";
import {
  assertFeatureWorkspaceSnapshot,
  FeaturePublicationGitError,
  openFeatureWorkspace,
  pushFeatureCorrectionHead,
  type FeaturePublicationSource,
  type LocalSourceConfig,
} from "@kestrel/local-source";
import {
  createFactoryFeatureGitHubAdapter,
  type FactoryFeatureGitHubAdapter,
} from "./factory-feature-github.js";
import { FactoryGitHubError } from "./factory-github.js";
import type { RetainFactoryFeatureRevision } from "./factory-feature-publication.js";

export const FACTORY_REVIEW_CORRECTION_WORK_OPTIONS = {
  batchSize: 1,
  localConcurrency: 2,
  pollingIntervalSeconds: 1,
  notifyPollingIntervalSeconds: 5,
} as const;

interface ReviewStarter {
  prepare(context: {
    projectId: string;
    featureId: string;
  }): Promise<FactoryConceptualReviewPreparation>;
  start(
    context: { projectId: string; featureId: string },
    command: FactoryConceptualReviewStartCommand,
    actor: { actorId: string; correlationId: string },
  ): Promise<FactoryConceptualReviewWorkflowRead>;
}

interface Options {
  pool: DatabasePool;
  readSourceConfig: () => Promise<LocalSourceConfig>;
  retain: RetainFactoryFeatureRevision;
  review: ReviewStarter;
  github?: Pick<FactoryFeatureGitHubAdapter, "identify" | "observePullRequest" | "readPullRequest">;
  git?: { push: typeof pushFeatureCorrectionHead };
}

class CorrectionPublicationFailure extends Error {
  constructor(
    readonly failure: FactoryReviewCorrectionFailure,
    readonly retryAt?: Date,
  ) {
    super(`Correction publication failed: ${failure}`);
  }
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

function failureFor(error: unknown, signal: AbortSignal): CorrectionPublicationFailure {
  if (error instanceof CorrectionPublicationFailure) return error;
  if (signal.aborted) return new CorrectionPublicationFailure("cancelled");
  if (error instanceof FeaturePublicationGitError) {
    if (["source_changed", "remote_changed", "workspace_changed"].includes(error.code))
      return new CorrectionPublicationFailure("source_changed");
    if (["feature_ref_conflict", "target_changed", "target_unavailable"].includes(error.code))
      return new CorrectionPublicationFailure("head_changed");
    if (error.code === "push_rejected") return new CorrectionPublicationFailure("push_rejected");
    if (error.code === "timeout") return new CorrectionPublicationFailure("timeout");
    if (error.code === "cancelled") return new CorrectionPublicationFailure("cancelled");
    return new CorrectionPublicationFailure("unavailable");
  }
  if (error instanceof FactoryGitHubError) {
    if (error.failure === "needs_authentication")
      return new CorrectionPublicationFailure("authentication_required");
    if (error.failure === "timeout") return new CorrectionPublicationFailure("timeout");
    if (error.failure === "cancelled") return new CorrectionPublicationFailure("cancelled");
    if (error.failure === "uncertain_write")
      return new CorrectionPublicationFailure("uncertain_write");
    if (["repository_changed", "invalid_response"].includes(error.failure))
      return new CorrectionPublicationFailure("head_changed");
    return new CorrectionPublicationFailure(
      "unavailable",
      error.retryAt === undefined ? undefined : new Date(error.retryAt),
    );
  }
  if (error instanceof FactoryFeaturePublicationError)
    return new CorrectionPublicationFailure(
      error.code === "retention_unavailable" ? "retention_unavailable" : "source_changed",
    );
  return new CorrectionPublicationFailure("unavailable");
}

async function publish(options: Options, correctionId: string, signal: AbortSignal): Promise<void> {
  const claim = await claimFactoryReviewCorrection(options.pool, correctionId);
  if (claim === null) return;
  try {
    signal.throwIfAborted();
    const config = await options.readSourceConfig();
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
    await assertFeatureWorkspaceSnapshot(workspace, claim.certificate.revision, { signal });
    const github = options.github ?? createFactoryFeatureGitHubAdapter();
    const identity = await github.identify(
      {
        owner: claim.operation.target.identity.repository.owner,
        name: claim.operation.target.identity.repository.name,
      },
      signal,
    );
    if (
      identity.repository.id !== claim.operation.target.identity.repository.id ||
      !same(identity.repository.owner, claim.operation.target.identity.repository.owner) ||
      !same(identity.repository.name, claim.operation.target.identity.repository.name) ||
      !same(identity.account, claim.operation.target.identity.account)
    )
      throw new CorrectionPublicationFailure("source_changed");

    const observed = await github.observePullRequest(identity, claim.pullRequest, signal);
    if (observed.state !== "open" || observed.baseCommitId !== claim.sourceReview.baseCommitId) {
      if (claim.pushAttempted && !claim.pushConfirmed)
        await markFactoryReviewCorrectionPush(options.pool, claim, false);
      throw new CorrectionPublicationFailure("head_changed");
    }
    const correctedHead = claim.certificate.revision.headCommitId;
    if (observed.headCommitId === correctedHead) {
      await confirmFactoryReviewCorrectionPush(options.pool, claim);
    } else {
      if (observed.headCommitId !== claim.sourceReview.headCommitId || claim.pushConfirmed) {
        if (claim.pushAttempted && !claim.pushConfirmed)
          await markFactoryReviewCorrectionPush(options.pool, claim, false);
        throw new CorrectionPublicationFailure("head_changed");
      }
      // A provider read of the exact reviewed head proves that an earlier uncertain
      // attempt did not take effect. Clear only that write witness before issuing a
      // new exact-head lease; any concurrent change still loses the Git CAS.
      if (claim.pushAttempted) await markFactoryReviewCorrectionPush(options.pool, claim, false);
      await markFactoryReviewCorrectionPush(options.pool, claim, true);
      const pushed = await (options.git?.push ?? pushFeatureCorrectionHead)(
        config,
        source,
        claim.operation.target.remote,
        claim.sourceReview.headCommitId,
        { signal },
      );
      if (pushed.state !== "confirmed") {
        if (pushed.state !== "uncertain")
          await markFactoryReviewCorrectionPush(options.pool, claim, false);
        throw new CorrectionPublicationFailure(
          pushed.state === "uncertain"
            ? "uncertain_write"
            : pushed.failure === "push_rejected"
              ? "push_rejected"
              : pushed.failure === "feature_ref_conflict"
                ? "head_changed"
                : pushed.failure === "timeout"
                  ? "timeout"
                  : pushed.failure === "cancelled"
                    ? "cancelled"
                    : "source_changed",
        );
      }
      await confirmFactoryReviewCorrectionPush(options.pool, claim);
    }

    const operation = FactoryFeaturePublicationOperationSchema.parse({
      ...claim.operation,
      target: {
        ...claim.operation.target,
        certificateId: claim.certificate.id,
        source: claim.certificate.source,
        revision: claim.certificate.revision,
      },
      payload: {
        ...claim.operation.payload,
        headCommitId: correctedHead,
      },
    });
    const pullRequest = FactoryFeaturePullRequestSchema.parse(
      await github.readPullRequest(identity, operation.payload, claim.pullRequest.number, signal),
    );
    const retentionClaim: ClaimedFactoryFeaturePublication = {
      featureId: claim.featureId,
      projectId: claim.projectId,
      attemptId: claim.attemptId,
      title: claim.title,
      version: claim.planVersion,
      cancelled: false,
      plan: claim.plan,
      approvalId: claim.approvalId,
      operatorId: claim.operatorId,
      certificate: claim.certificate,
      workspace: claim.workspace,
      planMarkdown: claim.planMarkdown,
      specMarkdown: claim.specMarkdown,
      identity: claim.identity,
      issues: claim.issues,
      operation,
      pullRequest,
      pushAttempted: true,
      pushConfirmed: true,
      prAttempted: true,
    };
    const retained = await options.retain(retentionClaim, operation, pullRequest, source, signal);
    await bindFactoryReviewCorrectionRevision(
      options.pool,
      claim,
      operation,
      pullRequest,
      retained,
    );
    const context = { projectId: claim.projectId, featureId: claim.featureId };
    const preparation = await options.review.prepare(context);
    if (
      !preparation.readiness.startAllowed ||
      preparation.preparationDigest === null ||
      preparation.publication?.pullRequest.headCommitId !== correctedHead
    )
      throw new CorrectionPublicationFailure("review_failed");
    const workflow = FactoryConceptualReviewWorkflowReadSchema.parse(
      await options.review.start(
        context,
        { requestId: claim.reviewRequestId, preparationDigest: preparation.preparationDigest },
        { actorId: claim.operatorId, correlationId: claim.id },
      ),
    );
    await bindFactoryReviewCorrectionWorkflow(options.pool, claim, workflow);
  } catch (error) {
    const failure = failureFor(error, signal);
    try {
      await failFactoryReviewCorrection(options.pool, claim, failure.failure, failure.retryAt);
    } catch (persistenceError) {
      // Cancellation or another reconciler can fence this attempt while an external
      // read/write is in flight. Its newer durable state owns the outcome.
      if (
        persistenceError instanceof FactoryReviewCorrectionError &&
        persistenceError.code === "invalid_state"
      )
        return;
      throw persistenceError;
    }
  }
}

export function createFactoryReviewCorrectionProcessor(options: Options) {
  const shutdown = new AbortController();
  const active = new Set<Promise<void>>();
  let stopped = false;
  return {
    process(data: unknown, jobSignal?: AbortSignal): Promise<void> {
      if (stopped) return Promise.reject(new CorrectionPublicationFailure("cancelled"));
      const { correctionId } = z.strictObject({ correctionId: KestrelIdSchema }).parse(data);
      const signal = AbortSignal.any([
        shutdown.signal,
        AbortSignal.timeout(900_000),
        ...(jobSignal === undefined ? [] : [jobSignal]),
      ]);
      const operation = publish(options, correctionId, signal).finally(() => {
        active.delete(operation);
      });
      active.add(operation);
      return operation;
    },
    async stop(): Promise<void> {
      stopped = true;
      shutdown.abort();
      await Promise.allSettled([...active]);
    },
  };
}
