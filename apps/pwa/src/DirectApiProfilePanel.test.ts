import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DirectApiProfile } from "@kestrel/contracts";

import { DirectApiProfileView } from "./DirectApiProfilePanel.js";

const profile: DirectApiProfile = {
  id: "018f0f89-a3fb-75ee-bccc-08c031ce5f10",
  projectId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
  availability: "stale",
  availabilityReasons: ["attestation_expired"],
  displayName: "OpenAI direct review",
  effectiveIdentity: {
    apiSurface: "responses",
    apiVersion: "2020-10-01",
    endpointOrigin: "https://api.openai.com",
    endpointPath: "/v1/responses",
    model: {
      expectedResolvedId: "gpt-test-2026-08-01",
      requestedId: "gpt-test-2026-08-01",
      versionPolicy: "pinned",
    },
    openAiProjectId: "proj_example",
    organizationId: "org_example",
    provider: "openai",
  },
  executionPolicy: {
    arbitraryOptions: "disabled",
    callbacks: "disabled",
    files: "disabled",
    inputModality: "text",
    privilegedInstructions: "developer",
    retrieval: "disabled",
    statefulness: "stateless",
    structuredOutput: "json_schema_strict",
    tools: "disabled",
    urls: "disabled",
  },
  dataPolicy: {
    abuseMonitoring: "modified",
    attestedAt: "2026-08-01T00:00:00.000Z",
    evidenceUrl: "https://developers.openai.com/api/docs/guides/your-data",
    expiresAt: "2026-08-31T00:00:00.000Z",
    humanReview: "restricted",
    processingRegions: ["US"],
    storageRegions: ["US"],
    trainingUse: "not_used_without_opt_in",
  },
  limits: {
    maximumAttempts: 1,
    maximumConcurrentRequests: 1,
    maximumCostUsd: "2.500000",
    maximumInputTokens: 100_000,
    maximumOutputTokens: 8_192,
    maximumRequestBytes: 1_048_576,
    requestTimeoutMilliseconds: 60_000,
  },
  priceSnapshot: {
    cachedInputPerMillionTokensUsd: "0.125000",
    capturedAt: "2026-08-01T00:00:00.000Z",
    currency: "USD",
    effectiveAt: "2026-08-01T00:00:00.000Z",
    inputPerMillionTokensUsd: "1.250000",
    outputPerMillionTokensUsd: "10.000000",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
  },
  profileDigest: "6".repeat(64),
  lastTest: {
    observedApiVersion: "2020-10-01",
    observedModel: "gpt-test-2026-08-01",
    observedOrganizationId: "org_example",
    passedAt: "2026-08-01T00:01:00.000Z",
    requestId: "req_synthetic_example",
  },
  createdAt: "2026-08-01T00:01:00.000Z",
  updatedAt: "2026-08-01T00:01:00.000Z",
};

describe("DirectApiProfileView", () => {
  it("shows attributable identity and attestations without credential details", () => {
    const html = renderToStaticMarkup(createElement(DirectApiProfileView, { profile }));

    expect(html).toContain("Stale");
    expect(html).toContain("Data-policy attestation expired");
    expect(html).toContain("https://api.openai.com/v1/responses");
    expect(html).toContain("gpt-test-2026-08-01");
    expect(html).toContain("org_example");
    expect(html).toContain("proj_example");
    expect(html).toContain("Not used without opt-in");
    expect(html).toContain("US");
    expect(html).toContain(
      "Tools, URLs, files, retrieval, callbacks, and arbitrary options disabled",
    );
    expect(html).not.toContain("credentialHandle");
    expect(html).not.toContain("API key");
    expect(html).not.toContain("sk-");
  });
});
