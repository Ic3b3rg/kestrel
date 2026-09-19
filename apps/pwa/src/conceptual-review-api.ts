import {
  FactoryConceptualReviewCheckCatalogSchema,
  FactoryConceptualReviewCheckSchema,
  FactoryConceptualReviewPreparationSchema,
  FactoryConceptualReviewSourceCatalogSchema,
  FactoryConceptualReviewSourceLinesSchema,
  KestrelIdSchema,
  type FactoryConceptualReviewCheck,
  type FactoryConceptualReviewCheckCatalog,
  type FactoryConceptualReviewPreparation,
  type FactoryConceptualReviewSourceCatalog,
  type FactoryConceptualReviewSourceLines,
} from "@kestrel/contracts";

import { requireJson } from "./api.js";

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
