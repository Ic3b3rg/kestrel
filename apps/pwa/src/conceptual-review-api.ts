import {
  FactoryConceptualReviewCheckCatalogSchema,
  FactoryConceptualReviewCheckSchema,
  FactoryConceptualReviewCurrentSchema,
  FactoryConceptualReviewHistorySchema,
  FactoryConceptualReviewPreparationSchema,
  FactoryConceptualReviewStartCommandSchema,
  FactoryConceptualReviewSourceCatalogSchema,
  FactoryConceptualReviewSourceLinesSchema,
  FactoryConceptualReviewWorkflowReadSchema,
  KestrelIdSchema,
  type FactoryConceptualReviewCheck,
  type FactoryConceptualReviewCheckCatalog,
  type FactoryConceptualReviewCurrent,
  type FactoryConceptualReviewHistory,
  type FactoryConceptualReviewPreparation,
  type FactoryConceptualReviewStartCommand,
  type FactoryConceptualReviewSourceCatalog,
  type FactoryConceptualReviewSourceLines,
  type FactoryConceptualReviewWorkflowRead,
} from "@kestrel/contracts";

import { authenticatedMutationHeaders, requireJson } from "./api.js";

function root(projectId: string, featureId: string): string {
  const project = KestrelIdSchema.parse(projectId);
  const feature = KestrelIdSchema.parse(featureId);
  return `/api/v1/projects/${encodeURIComponent(project)}/features/${encodeURIComponent(feature)}/review`;
}

async function read<T>(
  url: string,
  parser: { parse(value: unknown): T },
  description: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "GET",
    signal: signal ?? null,
  });
  return requireJson(response, parser, description);
}

export function fetchFactoryConceptualReviewPreparation(
  projectId: string,
  featureId: string,
  signal?: AbortSignal,
): Promise<FactoryConceptualReviewPreparation> {
  return read(
    `${root(projectId, featureId)}/preparation`,
    FactoryConceptualReviewPreparationSchema,
    "Conceptual Review preparation",
    signal,
  );
}

export function fetchFactoryConceptualReviewSourceCatalog(
  projectId: string,
  featureId: string,
  side: "base" | "head",
  offset = 0,
  limit = 200,
  signal?: AbortSignal,
): Promise<FactoryConceptualReviewSourceCatalog> {
  const query = new URLSearchParams({ side, offset: String(offset), limit: String(limit) });
  return read(
    `${root(projectId, featureId)}/source?${query.toString()}`,
    FactoryConceptualReviewSourceCatalogSchema,
    "Conceptual Review source catalog",
    signal,
  );
}

export function fetchFactoryConceptualReviewSourceLines(
  projectId: string,
  featureId: string,
  side: "base" | "head",
  path: string,
  startLine: number,
  endLine: number,
  signal?: AbortSignal,
): Promise<FactoryConceptualReviewSourceLines> {
  const query = new URLSearchParams({
    side,
    path,
    startLine: String(startLine),
    endLine: String(endLine),
  });
  return read(
    `${root(projectId, featureId)}/source/lines?${query.toString()}`,
    FactoryConceptualReviewSourceLinesSchema,
    "Conceptual Review source lines",
    signal,
  );
}

export function fetchFactoryConceptualReviewChecks(
  projectId: string,
  featureId: string,
  offset = 0,
  limit = 100,
  signal?: AbortSignal,
): Promise<FactoryConceptualReviewCheckCatalog> {
  const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  return read(
    `${root(projectId, featureId)}/checks?${query.toString()}`,
    FactoryConceptualReviewCheckCatalogSchema,
    "Conceptual Review check catalog",
    signal,
  );
}

export function fetchFactoryConceptualReviewCheck(
  projectId: string,
  featureId: string,
  evidenceId: string,
  signal?: AbortSignal,
): Promise<FactoryConceptualReviewCheck> {
  return read(
    `${root(projectId, featureId)}/checks/${encodeURIComponent(KestrelIdSchema.parse(evidenceId))}`,
    FactoryConceptualReviewCheckSchema,
    "Conceptual Review check result",
    signal,
  );
}

export async function startFactoryConceptualReview(
  projectId: string,
  featureId: string,
  command: FactoryConceptualReviewStartCommand,
  signal?: AbortSignal,
): Promise<FactoryConceptualReviewWorkflowRead> {
  const response = await fetch(`${root(projectId, featureId)}/workflows`, {
    credentials: "same-origin",
    method: "POST",
    headers: authenticatedMutationHeaders(),
    body: JSON.stringify(FactoryConceptualReviewStartCommandSchema.parse(command)),
    signal: signal ?? null,
  });
  return requireJson(
    response,
    FactoryConceptualReviewWorkflowReadSchema,
    "Conceptual Review Workflow",
  );
}

export function fetchCurrentFactoryConceptualReview(
  projectId: string,
  featureId: string,
  signal?: AbortSignal,
): Promise<FactoryConceptualReviewCurrent> {
  return read(
    `${root(projectId, featureId)}/workflows/current`,
    FactoryConceptualReviewCurrentSchema,
    "current Conceptual Review",
    signal,
  );
}

export function fetchFactoryConceptualReviewWorkflow(
  projectId: string,
  featureId: string,
  workflowId: string,
  signal?: AbortSignal,
): Promise<FactoryConceptualReviewWorkflowRead> {
  return read(
    `${root(projectId, featureId)}/workflows/${encodeURIComponent(KestrelIdSchema.parse(workflowId))}`,
    FactoryConceptualReviewWorkflowReadSchema,
    "Conceptual Review Workflow",
    signal,
  );
}

export function fetchFactoryConceptualReviewWorkflowSourceLines(
  projectId: string,
  featureId: string,
  workflowId: string,
  side: "base" | "head",
  path: string,
  startLine: number,
  endLine: number,
  signal?: AbortSignal,
): Promise<FactoryConceptualReviewSourceLines> {
  const workflow = KestrelIdSchema.parse(workflowId);
  const query = new URLSearchParams({
    side,
    path,
    startLine: String(startLine),
    endLine: String(endLine),
  });
  return read(
    `${root(projectId, featureId)}/workflows/${encodeURIComponent(workflow)}/source/lines?${query.toString()}`,
    FactoryConceptualReviewSourceLinesSchema,
    "published Conceptual Review source lines",
    signal,
  );
}

export function fetchFactoryConceptualReviewHistory(
  projectId: string,
  featureId: string,
  offset = 0,
  limit = 20,
  signal?: AbortSignal,
): Promise<FactoryConceptualReviewHistory> {
  const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  return read(
    `${root(projectId, featureId)}/artifacts?${query.toString()}`,
    FactoryConceptualReviewHistorySchema,
    "Conceptual Review history",
    signal,
  );
}

export function fetchFactoryConceptualReviewArtifact(
  projectId: string,
  featureId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<FactoryConceptualReviewWorkflowRead> {
  return read(
    `${root(projectId, featureId)}/artifacts/${encodeURIComponent(KestrelIdSchema.parse(artifactId))}`,
    FactoryConceptualReviewWorkflowReadSchema,
    "Conceptual Review artifact",
    signal,
  );
}

export function fetchFactoryConceptualReviewArtifactSourceLines(
  projectId: string,
  featureId: string,
  artifactId: string,
  side: "base" | "head",
  path: string,
  startLine: number,
  endLine: number,
  signal?: AbortSignal,
): Promise<FactoryConceptualReviewSourceLines> {
  const query = new URLSearchParams({
    side,
    path,
    startLine: String(startLine),
    endLine: String(endLine),
  });
  return read(
    `${root(projectId, featureId)}/artifacts/${encodeURIComponent(KestrelIdSchema.parse(artifactId))}/source/lines?${query.toString()}`,
    FactoryConceptualReviewSourceLinesSchema,
    "Conceptual Review artifact source lines",
    signal,
  );
}

export function fetchFactoryConceptualReviewArtifactCheck(
  projectId: string,
  featureId: string,
  artifactId: string,
  evidenceId: string,
  signal?: AbortSignal,
): Promise<FactoryConceptualReviewCheck> {
  return read(
    `${root(projectId, featureId)}/artifacts/${encodeURIComponent(KestrelIdSchema.parse(artifactId))}/checks/${encodeURIComponent(KestrelIdSchema.parse(evidenceId))}`,
    FactoryConceptualReviewCheckSchema,
    "Conceptual Review artifact check result",
    signal,
  );
}
