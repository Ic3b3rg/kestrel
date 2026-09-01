import { performance } from "node:perf_hooks";

import {
  claimChangeOverviewRendering,
  completeChangeOverviewRendering,
  parseChangeOverviewRenderingJob,
  readDirectApiProfileBrokerReference,
  type ClaimedChangeOverviewRendering,
  type CompleteChangeOverviewRenderingOutcome,
  type ChangeOverviewRenderingJob,
  type DatabasePool,
  type DirectApiProfileBrokerReference,
} from "@kestrel/database";
import {
  ChangeOverviewRenderingValidationError,
  CredentialStoreError,
  DirectApiBrokerError,
  prepareChangeOverviewRendering,
  runDirectApiStructuredTextInference,
  validateChangeOverviewRendering,
  type CredentialStore,
  type OpenAiTransport,
} from "@kestrel/model-provider";

export type ChangeOverviewRenderingProcessResult = "ready" | "superseded" | "unavailable";

export const CHANGE_OVERVIEW_RENDER_MAXIMUM_OUTPUT_TOKENS = 256;
export const CHANGE_OVERVIEW_KESTREL_P95_TARGET_MILLISECONDS = 250;

export const CHANGE_OVERVIEW_RENDER_WORK_OPTIONS = {
  batchSize: 1,
  localConcurrency: 1,
  maxPriority: -1,
  notifyPollingIntervalSeconds: 5,
  pollingIntervalSeconds: 1,
} as const;

export interface ChangeOverviewRenderingPersistence {
  claim(job: ChangeOverviewRenderingJob): Promise<ClaimedChangeOverviewRendering | null>;
  complete(
    job: ChangeOverviewRenderingJob,
    outcome: CompleteChangeOverviewRenderingOutcome,
  ): Promise<boolean>;
  readProfile(projectId: string): Promise<{
    projectFound: boolean;
    reference: DirectApiProfileBrokerReference | null;
  }>;
}

export interface CreateChangeOverviewRendererOptions {
  clock?: () => number;
  credentialStore: Pick<CredentialStore, "read">;
  persistence: ChangeOverviewRenderingPersistence;
  transport: OpenAiTransport;
}

export interface ChangeOverviewRenderer {
  process(data: unknown): Promise<ChangeOverviewRenderingProcessResult>;
}

export function createDatabaseChangeOverviewRenderingPersistence(
  pool: DatabasePool,
): ChangeOverviewRenderingPersistence {
  return {
    claim: (job) => claimChangeOverviewRendering(pool, job),
    complete: (job, outcome) => completeChangeOverviewRendering(pool, job, outcome),
    readProfile: (projectId) => readDirectApiProfileBrokerReference(pool, projectId),
  };
}

function durationMilliseconds(startedAt: number, completedAt: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return 0;
  return Math.max(0, Math.min(120_000, Math.round(completedAt - startedAt)));
}

function failureReason(
  error: unknown,
): Extract<CompleteChangeOverviewRenderingOutcome, { kind: "unavailable" }>["reason"] {
  if (error instanceof ChangeOverviewRenderingValidationError) return "invalid_rendering";
  if (error instanceof CredentialStoreError) return "credential_unavailable";
  if (error instanceof DirectApiBrokerError) {
    switch (error.code) {
      case "request_timeout":
        return "timed_out";
      case "credential_unavailable":
        return "credential_unavailable";
      case "identity_drift":
        return "profile_unavailable";
      case "request_invalid":
      case "response_invalid":
      case "synthetic_test_failed":
        return "invalid_rendering";
      case "destination_rejected":
      case "provider_unavailable":
        return "model_unavailable";
    }
  }
  return "model_unavailable";
}

export function createChangeOverviewRenderer({
  clock = () => performance.now(),
  credentialStore,
  persistence,
  transport,
}: CreateChangeOverviewRendererOptions): ChangeOverviewRenderer {
  return {
    async process(data) {
      const job = parseChangeOverviewRenderingJob(data);
      const processingStartedAt = clock();
      const claimed = await persistence.claim(job);
      if (claimed === null) return "superseded";

      let modelMilliseconds = 0;
      const finishUnavailable = async (
        reason: Extract<CompleteChangeOverviewRenderingOutcome, { kind: "unavailable" }>["reason"],
      ): Promise<ChangeOverviewRenderingProcessResult> => {
        const elapsed = durationMilliseconds(processingStartedAt, clock());
        const completed = await persistence.complete(job, {
          kind: "unavailable",
          kestrelMilliseconds: Math.max(0, elapsed - modelMilliseconds),
          modelMilliseconds,
          queueMilliseconds: claimed.queueMilliseconds,
          reason,
        });
        return completed ? "unavailable" : "superseded";
      };

      try {
        const stored = await persistence.readProfile(claimed.projectId);
        if (!stored.projectFound) return await finishUnavailable("model_unavailable");
        if (stored.reference === null) return await finishUnavailable("profile_not_configured");
        const { credentialHandle, profile } = stored.reference;
        if (profile.availability !== "available") {
          return await finishUnavailable("profile_unavailable");
        }
        const apiKey = await credentialStore.read(profile.projectId, credentialHandle);
        const prepared = prepareChangeOverviewRendering({
          exactRevision: claimed.exactRevision,
          sourceFacts: claimed.sourceFacts,
        });
        const modelStartedAt = clock();
        let inference;
        try {
          inference = await runDirectApiStructuredTextInference(
            {
              apiKey,
              input: prepared.input,
              inputTokenCount: prepared.inputTokenCount,
              instructions: prepared.instructions,
              limits: {
                ...profile.limits,
                maximumOutputTokens: Math.min(
                  profile.limits.maximumOutputTokens,
                  CHANGE_OVERVIEW_RENDER_MAXIMUM_OUTPUT_TOKENS,
                ),
              },
              model: profile.effectiveIdentity.model,
              openAiProjectId: profile.effectiveIdentity.openAiProjectId,
              organizationId: profile.effectiveIdentity.organizationId,
              output: prepared.output,
            },
            transport,
          );
          modelMilliseconds = durationMilliseconds(modelStartedAt, clock());
        } catch (error) {
          modelMilliseconds = durationMilliseconds(modelStartedAt, clock());
          throw error;
        }
        const rendering = validateChangeOverviewRendering(prepared.manifest, inference.output);
        const elapsed = durationMilliseconds(processingStartedAt, clock());
        const completed = await persistence.complete(job, {
          kind: "ready",
          kestrelMilliseconds: Math.max(0, elapsed - modelMilliseconds),
          modelMilliseconds,
          providerRequestId: inference.identity.requestId,
          queueMilliseconds: claimed.queueMilliseconds,
          sentences: rendering.sentences.map(({ sourceFactIds, text }) => ({
            sourceFactIds: [...sourceFactIds],
            text,
          })),
        });
        return completed ? "ready" : "superseded";
      } catch (error) {
        return finishUnavailable(failureReason(error));
      }
    },
  };
}
