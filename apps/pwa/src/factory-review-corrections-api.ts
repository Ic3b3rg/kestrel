import {
  FactoryReviewCorrectionCommandSchema,
  FactoryReviewCorrectionCurrentSchema,
  FactoryReviewCorrectionSchema,
  KestrelIdSchema,
  RetryFactoryReviewCorrectionCommandSchema,
  type FactoryReviewCorrectionCommand,
  type RetryFactoryReviewCorrectionCommand,
} from "@kestrel/contracts";
import { authenticatedMutationHeaders, requireJson } from "./api.js";

function root(projectId: string, featureId: string): string {
  const project = KestrelIdSchema.parse(projectId);
  const feature = KestrelIdSchema.parse(featureId);
  return `/api/v1/projects/${encodeURIComponent(project)}/features/${encodeURIComponent(feature)}/review/corrections`;
}

export async function fetchCurrentFactoryReviewCorrection(
  projectId: string,
  featureId: string,
  signal?: AbortSignal,
) {
  const response = await fetch(`${root(projectId, featureId)}/current`, {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal: signal ?? null,
  });
  return requireJson(response, FactoryReviewCorrectionCurrentSchema, "current review correction");
}

export async function requestFactoryReviewCorrection(
  projectId: string,
  featureId: string,
  command: FactoryReviewCorrectionCommand,
  signal?: AbortSignal,
) {
  const response = await fetch(root(projectId, featureId), {
    method: "POST",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    body: JSON.stringify(FactoryReviewCorrectionCommandSchema.parse(command)),
    signal: signal ?? null,
  });
  return requireJson(response, FactoryReviewCorrectionSchema, "review correction");
}

export async function retryFactoryReviewCorrection(
  projectId: string,
  featureId: string,
  correctionId: string,
  command: RetryFactoryReviewCorrectionCommand,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `${root(projectId, featureId)}/${encodeURIComponent(KestrelIdSchema.parse(correctionId))}/retry`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      body: JSON.stringify(RetryFactoryReviewCorrectionCommandSchema.parse(command)),
      signal: signal ?? null,
    },
  );
  return requireJson(response, FactoryReviewCorrectionSchema, "review correction retry");
}
