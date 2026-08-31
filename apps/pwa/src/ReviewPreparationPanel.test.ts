// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewPreparation, ReviewWorkflowAccepted } from "@kestrel/contracts";

import { ReviewPreparationPanel } from "./ReviewPreparationPanel.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const proposalId = "018f0f89-9192-755f-aa96-f72094c734dd";
const operatorId = "018f0f89-a3fb-75ee-bccc-08c031ce5f10";
const revisionId = "018f0f89-9a21-7271-b92d-f1cb0d48bb47";
const intentId = "018f0f89-9a20-79f9-9990-dda80c9b917e";

const blockedPreparation: ReviewPreparation = {
  schemaVersion: 1,
  projectId,
  changeProposalId: proposalId,
  proposal: {
    version: 4,
    base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
    head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
  },
  reviewRevision: {
    id: revisionId,
    state: "available",
    objectFormat: "sha1",
    base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
    head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
    objectCount: 7,
    retainedBytes: 4096,
    failureReason: null,
    createdAt: "2026-08-24T12:00:30.000Z",
    availableAt: "2026-08-24T12:01:00.000Z",
  },
  changeIntent: {
    id: intentId,
    version: 2,
    text: "Review the local authorization boundary.",
    objective: "Review the local authorization boundary.",
    scopeBoundaries: ["No provider writes."],
    acceptanceOutcomes: ["Only retained source is reviewed."],
    sources: [
      {
        id: "operator_input",
        kind: "operator_input",
        label: "Operator input",
        text: "Review the local authorization boundary.",
        version: "2",
        provenance: { kind: "operator_input" },
      },
    ],
    sourceDigest: "c".repeat(64),
    resolution: { state: "resolved", issues: [] },
    createdAt: "2026-08-24T12:02:00.000Z",
  },
  source: {
    localRepositorySource: {
      id: "018f0f89-9a1d-7484-b224-866ef9d69990",
      repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
      displayName: "kestrel",
      state: "detached",
      objectFormat: "sha1",
      createdAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T12:03:00.000Z",
    },
    providerObservation: {
      route: {
        kind: "host_gh",
        authentication: "host_session",
        refresh: "manual",
        host: "github.com",
        account: "operator",
      },
      repository: {
        canonicalUrl: "https://github.com/openai/openai-node",
        name: "openai-node",
        owner: "openai",
        providerId: "R_kgDOGx",
      },
      proposal: {
        canonicalUrl: "https://github.com/openai/openai-node/pull/1234",
        number: 1234,
        observedAt: "2026-08-24T12:01:00.000Z",
        providerId: "PR_kwDOGx",
      },
    },
  },
  analysisConfiguration: null,
  modelRouteAvailability: "unavailable",
  authority: { action: "start_review", operatorId: null, state: "unavailable" },
  resourceEnvelope: null,
  readiness: "blocked",
  blockers: [
    "model_route_not_available",
    "operator_authority_not_available",
    "resource_envelope_not_available",
  ],
  preparationDigest: null,
};

const readyPreparation: ReviewPreparation = {
  ...blockedPreparation,
  analysisConfiguration: {
    id: "018f0f89-a45f-79af-8544-650e9f15c211",
    version: 3,
    displayName: "Direct API review profile",
    modelRoute: "direct_api",
    digest: "d".repeat(64),
  },
  modelRouteAvailability: "available",
  authority: { action: "start_review", operatorId, state: "available" },
  resourceEnvelope: {
    id: "review-first-v1-default",
    version: 1,
    displayName: "Review First V1 default envelope",
    limits: {
      maximumMemoryBytes: 1_073_741_824,
      maximumProcesses: 64,
      maximumWritableDiskBytes: 2_147_483_648,
      maximumCpuMillicores: 1_000,
      maximumConcurrentAttempts: 1,
    },
    terminalBoundary: {
      onExhaustion: "partial_or_failed",
      requiresUncoveredAreaDisclosure: true,
    },
    digest: "e".repeat(64),
  },
  readiness: "ready",
  blockers: [],
  preparationDigest: "f".repeat(64),
};

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return match;
}

describe("ReviewPreparationPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("shows the exact retained inputs, provider provenance, and every blocker", async () => {
    const readPreparation = vi.fn().mockResolvedValue(blockedPreparation);
    await act(async () => {
      root.render(
        createElement(ReviewPreparationPanel, {
          disabled: false,
          projectId,
          proposalId,
          readPreparation,
        }),
      );
      await Promise.resolve();
    });

    await act(async () => {
      button(container, "Prepare Review").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readPreparation).toHaveBeenCalledWith(projectId, proposalId, expect.any(AbortSignal));
    expect(container.textContent).toContain("a".repeat(40));
    expect(container.textContent).toContain("b".repeat(40));
    expect(container.textContent).toContain("Change Intent v2");
    expect(container.textContent).toContain("kestrel · detached · sha1");
    expect(container.textContent).toContain("operator on github.com");
    expect(container.textContent).toContain("PR_kwDOGx");
    expect(container.textContent).toContain("Route unavailable");
    expect(container.textContent).toContain("Model route is not available");
    expect(container.textContent).toContain("Operator authority is not available");
    expect(container.textContent).toContain("Resource Envelope is not available");
    expect(button(container, "Start Review").disabled).toBe(true);
  });

  it("starts from only the displayed preparation digest when every input is ready", async () => {
    const readPreparation = vi.fn().mockResolvedValue(readyPreparation);
    const analysisConfiguration = readyPreparation.analysisConfiguration;
    const resourceEnvelope = readyPreparation.resourceEnvelope;
    if (analysisConfiguration === null || resourceEnvelope === null) {
      throw new Error("Ready Review fixture is incomplete");
    }
    const accepted: ReviewWorkflowAccepted = {
      schemaVersion: 1,
      workflow: {
        id: "018f0f89-a45f-79af-8544-650e9f15c212",
        projectId,
        changeProposalId: proposalId,
        reviewRevisionId: revisionId,
        changeIntentId: intentId,
        inputDigest: readyPreparation.preparationDigest ?? "",
        analysisConfiguration,
        authority: readyPreparation.authority,
        resourceEnvelope,
        state: "queued",
        requestedAt: "2026-08-24T12:04:00.000Z",
      },
    };
    const startWorkflow = vi.fn().mockResolvedValue(accepted);
    await act(async () => {
      root.render(
        createElement(ReviewPreparationPanel, {
          disabled: false,
          projectId,
          proposalId,
          readPreparation,
          startWorkflow,
        }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      button(container, "Prepare Review").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      button(container, "Start Review").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(startWorkflow).toHaveBeenCalledWith(
      projectId,
      proposalId,
      { preparationDigest: readyPreparation.preparationDigest },
      expect.any(AbortSignal),
    );
    expect(container.textContent).toContain("Review queued");
    expect(container.textContent).toContain("1 GiB memory");
    expect(container.textContent).toContain("64 processes");
    expect(container.textContent).toContain("2 GiB writable disk");
    expect(container.textContent).toContain("1000 millicores");
    expect(container.textContent).toContain("1 concurrent attempt");
    expect(container.textContent).toContain("Partial or failed on exhaustion");
  });
});
