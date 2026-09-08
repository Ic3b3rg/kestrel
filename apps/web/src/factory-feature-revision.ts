import { basename, dirname } from "node:path";
import {
  FactoryFeaturePublicationReviewSchema,
  FactoryFeaturePullRequestSchema,
  ReviewRevisionFailureReasonSchema,
} from "@kestrel/contracts";
import {
  FactoryFeaturePublicationError,
  upsertHostGitHubProject,
  withReviewRevisionAcquisitionLease,
  withArtifactAcquisitionLock,
  completeReviewRevision,
  failReviewRevision,
  readFactoryFeaturePublicationRevisionArtifact,
  type DatabasePool,
  type ChangeOverviewRenderingJobCoordinator,
  type FailReviewRevisionInput,
} from "@kestrel/database";
import {
  resolveRepository,
  inspectRepository,
  assertFeatureWorkspaceSnapshot,
  retainRevision,
  readRetainedChangeOverviewFacts,
  quarantineUnattachedArtifact,
  LocalSourceError,
  type LocalSourceConfig,
  type ResolvedRepository,
} from "@kestrel/local-source";
import type { RetainFactoryFeatureRevision } from "./factory-feature-publication.js";

export function createFactoryFeatureRevisionRetainer({
  pool,
  readSourceConfig,
  renderingCoordinator,
}: {
  pool: DatabasePool;
  readSourceConfig: () => Promise<LocalSourceConfig>;
  renderingCoordinator: ChangeOverviewRenderingJobCoordinator;
}): RetainFactoryFeatureRevision {
  return async (claim, operation, input, source, signal) => {
    try {
      signal.throwIfAborted();
      const pull = FactoryFeaturePullRequestSchema.parse(input);
      if (
        operation.featureId !== claim.featureId ||
        operation.target.certificateId !== claim.certificate.id ||
        operation.target.approvalId !== claim.approvalId ||
        operation.target.approvedVersion !== claim.version ||
        Object.entries(operation.payload).some(
          ([key, value]) => pull[key as keyof typeof operation.payload] !== value,
        ) ||
        pull.repository.id !== claim.identity.repository.id ||
        pull.author.toLowerCase() !== claim.identity.account.toLowerCase() ||
        pull.baseCommitId !== claim.certificate.revision.baseCommitId ||
        pull.headCommitId !== claim.certificate.revision.headCommitId ||
        source.workspace.identity.repositoryId !== claim.certificate.source.repositoryId ||
        source.workspace.identity.sourceIdentity !== claim.certificate.source.identity ||
        source.workspace.identity.featureId !== claim.featureId
      )
        throw new FactoryFeaturePublicationError("certificate_stale");
      await assertFeatureWorkspaceSnapshot(source.workspace, claim.certificate.revision, {
        signal,
      });
      const config = await readSourceConfig();
      const repository = await resolveRepository(config, claim.certificate.source.repositoryId);
      const inspection = await inspectRepository(config, repository, signal);
      if (
        inspection.sourceIdentity !== claim.certificate.source.identity ||
        inspection.objectFormat !== claim.workspace.objectFormat ||
        inspection.githubRepository?.owner.toLowerCase() !== pull.repository.owner.toLowerCase() ||
        inspection.githubRepository.name.toLowerCase() !== pull.repository.name.toLowerCase()
      )
        throw new FactoryFeaturePublicationError("source_changed");
      const base = { objectId: pull.baseCommitId, ref: pull.baseRef };
      const head = { objectId: pull.headCommitId, ref: pull.headRef };
      const observed = await upsertHostGitHubProject(
        pool,
        {
          actorId: claim.operatorId,
          correlationId: claim.attemptId,
          enqueueModelRendering: false,
          route: {
            kind: "host_gh",
            host: "github.com",
            account: operation.target.identity.account,
          },
          observation: {
            repository: {
              providerId: pull.repositoryNodeId,
              owner: pull.repository.owner,
              name: pull.repository.name,
              canonicalUrl: `https://github.com/${pull.repository.owner}/${pull.repository.name}`,
            },
            proposal: {
              providerId: pull.nodeId,
              number: pull.number,
              title: pull.title,
              body: pull.body,
              canonicalUrl: pull.url,
              proposalState: pull.state,
              base,
              head,
              author: { providerId: pull.authorNodeId, login: pull.author },
            },
          },
        },
        renderingCoordinator,
      );
      const proposal = observed.project.changeProposals.find(
        (candidate) =>
          candidate.kind === "provider_observed" && candidate.providerId === pull.nodeId,
      );
      if (observed.project.id !== claim.projectId || proposal === undefined)
        throw new FactoryFeaturePublicationError("repository_changed");
      return await withReviewRevisionAcquisitionLease(
        pool,
        {
          actorId: claim.operatorId,
          correlationId: claim.attemptId,
          expectedProjectId: claim.projectId,
          changeProposalId: proposal.id,
          changeIntent: claim.plan.objective,
          approvedFeaturePlan: {
            featureId: claim.featureId,
            approvedVersion: claim.version,
            certificateId: claim.certificate.id,
            approvalId: claim.approvalId,
          },
          base,
          head,
          maxBytes: config.maxBytes,
          maxObjects: config.maxObjects,
          source: {
            displayName: repository.displayName,
            githubRepository: inspection.githubRepository,
            objectFormat: inspection.objectFormat,
            relativePath: repository.relativePath,
            repositoryId: repository.repositoryId,
            rootId: repository.rootId,
            sourceIdentity: inspection.sourceIdentity,
          },
        },
        async (begun, leasedPool) => {
          if (begun.outcome === "acquiring")
            throw new FactoryFeaturePublicationError("retention_unavailable");
          if (
            begun.revision.base.objectId !== pull.baseCommitId ||
            begun.revision.head.objectId !== pull.headCommitId ||
            begun.projectId !== claim.projectId
          )
            throw new FactoryFeaturePublicationError("certificate_stale");
          if (begun.outcome === "already_available") {
            const reference = await readFactoryFeaturePublicationRevisionArtifact(
              leasedPool,
              claim,
              begun.revision.id,
            );
            await readRetainedChangeOverviewFacts(config, reference);
            signal.throwIfAborted();
            // The original acquisition intent stays historical. The Feature certificate/approval binding is explicit.
            return FactoryFeaturePublicationReviewSchema.parse({
              projectId: begun.projectId,
              changeProposalId: begun.changeProposalId,
              revision: begun.revision,
              manifestDigest: reference.manifestDigest,
            });
          }
          return withArtifactAcquisitionLock(leasedPool, async (lockedPool) => {
            async function recordFailure(
              failureReason: FailReviewRevisionInput["failureReason"],
              beforeUnavailable?: () => Promise<void>,
            ) {
              const failure = {
                actorId: claim.operatorId,
                correlationId: claim.attemptId,
                revisionId: begun.revision.id,
                failureReason,
              };
              try {
                await failReviewRevision(lockedPool, failure, beforeUnavailable);
              } catch {
                await failReviewRevision(pool, failure, beforeUnavailable);
              }
            }
            let artifact: Awaited<ReturnType<typeof retainRevision>>;
            try {
              // This private repository supplies only the captured objects missing from the original source.
              // retainRevision independently re-inspects both sources and verifies every retained object hash.
              const fallback: ResolvedRepository = {
                path: source.workspace.workspacePath,
                rootPath: dirname(source.workspace.workspacePath),
                relativePath: basename(source.workspace.workspacePath),
                rootId: source.workspace.identity.projectId,
                repositoryId: claim.featureId,
                displayName: "Certified Feature",
              };
              const fallbackInspection = await inspectRepository(config, fallback, signal);
              artifact = await retainRevision(
                { ...config, maxBytes: begun.maxBytes, maxObjects: begun.maxObjects },
                {
                  projectId: begun.artifactProjectId,
                  revisionId: begun.revision.id,
                  signal,
                  selected: {
                    ...inspection,
                    repository,
                    base: begun.revision.base,
                    head: begun.revision.head,
                  },
                  fallbackSource: { repository: fallback, inspection: fallbackInspection },
                },
              );
            } catch (error) {
              const reason = signal.aborted
                ? "acquisition_interrupted"
                : error instanceof LocalSourceError
                  ? error.code
                  : "artifact_finalization_failed";
              await recordFailure(
                ReviewRevisionFailureReasonSchema.catch("artifact_finalization_failed").parse(
                  reason,
                ),
              );
              throw error;
            }
            let revision;
            try {
              revision = await completeReviewRevision(
                lockedPool,
                {
                  actorId: claim.operatorId,
                  correlationId: claim.attemptId,
                  artifact,
                  base: begun.revision.base,
                  head: begun.revision.head,
                  projectId: begun.artifactProjectId,
                  revisionId: begun.revision.id,
                  objectFormat: begun.revision.objectFormat,
                  enqueueModelRendering: false,
                },
                renderingCoordinator,
              );
            } catch (error) {
              try {
                // Failure persistence checks that completion did not commit before quarantining its artifact.
                await recordFailure("artifact_finalization_failed", () =>
                  quarantineUnattachedArtifact(config, artifact.artifactLocator),
                );
              } catch {
                /* Preserve the artifact while the database outcome is uncertain. */
              }
              throw error;
            }
            return FactoryFeaturePublicationReviewSchema.parse({
              projectId: begun.projectId,
              changeProposalId: begun.changeProposalId,
              revision,
              manifestDigest: artifact.manifestDigest,
            });
          });
        },
      );
    } catch (error) {
      if (error instanceof FactoryFeaturePublicationError) throw error;
      throw new FactoryFeaturePublicationError(
        signal.aborted ? "cancelled" : "retention_unavailable",
        { cause: error },
      );
    }
  };
}
