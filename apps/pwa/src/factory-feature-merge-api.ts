import {
  ApproveFactoryFeatureMergeCommandSchema,
  FactoryFeatureMergeCurrentSchema,
  FactoryFeatureMergeSchema,
  KestrelIdSchema,
  RetryFactoryFeatureMergeCommandSchema,
  type ApproveFactoryFeatureMergeCommand,
  type RetryFactoryFeatureMergeCommand,
} from "@kestrel/contracts";

import { authenticatedMutationHeaders, requireJson } from "./api.js";

function root(projectId: string, featureId: string): string {
  const project = KestrelIdSchema.parse(projectId);
  const feature = KestrelIdSchema.parse(featureId);
  return `/api/v1/projects/${encodeURIComponent(project)}/features/${encodeURIComponent(feature)}/review/merge`;
}

export async function fetchCurrentFactoryFeatureMerge(
  projectId: string,
  featureId: string,
  signal?: AbortSignal,
) {
  const response = await fetch(root(projectId, featureId), {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal: signal ?? null,
  });
  return requireJson(response, FactoryFeatureMergeCurrentSchema, "current Feature merge");
}

export async function approveFactoryFeatureMerge(
  projectId: string,
  featureId: string,
  command: ApproveFactoryFeatureMergeCommand,
  signal?: AbortSignal,
) {
  const response = await fetch(root(projectId, featureId), {
    method: "POST",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    body: JSON.stringify(ApproveFactoryFeatureMergeCommandSchema.parse(command)),
    signal: signal ?? null,
  });
  return requireJson(response, FactoryFeatureMergeSchema, "Feature merge");
}

export async function retryFactoryFeatureMerge(
  projectId: string,
  featureId: string,
  command: RetryFactoryFeatureMergeCommand,
  signal?: AbortSignal,
) {
  const response = await fetch(`${root(projectId, featureId)}/retry`, {
    method: "POST",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    body: JSON.stringify(RetryFactoryFeatureMergeCommandSchema.parse(command)),
    signal: signal ?? null,
  });
  return requireJson(response, FactoryFeatureMergeSchema, "Feature merge retry");
}
