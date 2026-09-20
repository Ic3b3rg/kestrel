// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExternalConceptualReviewPreparationSchema,
  FactoryConceptualReviewWorkflowReadSchema,
  type ExternalConceptualReviewPreparation,
} from "@kestrel/contracts";

import { ExternalPullRequestReviewPanel } from "./ExternalPullRequestReviewPanel.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const proposalId = "018f0f89-9192-755f-aa96-f72094c734dd";
const revisionId = "018f0f89-9a21-7271-b92d-f1cb0d48bb47";
const workflowId = "018f0f89-a45f-79af-8544-650e9f15c211";
const artifactId = "018f0f89-a45f-79af-8544-650e9f15c212";
const requestId = "65cc9964-10c2-49d1-86c4-8f13f5019e86";
const digest = "d".repeat(64);
const at = "2026-09-20T00:00:00.000Z";

const preparation: ExternalConceptualReviewPreparation =
  ExternalConceptualReviewPreparationSchema.parse({
    schemaVersion: 1,
    projectId,
    featureId: null,
    changeProposalId: proposalId,
    preparationDigest: digest,
    basis: {
      objective: "Keep repository access explicit",
      scope: { includes: ["The exact pull request change"], excludes: [] },
      outcomes: [
        {
          key: "stated_intent",
          outcome: "Keep repository access explicit",
          intent: { kind: "pull_request_stated", label: "GitHub title" },
        },
      ],
      provenance: {
        kind: "change_intent",
        changeIntentId: "018f0f89-9a20-79f9-9990-dda80c9b917d",
        version: 1,
        sourceDigest: "a".repeat(64),
        resolution: "unresolved",
        sources: [{ kind: "pull_request_stated", label: "GitHub title" }],
      },
      limitations: ["No acceptance outcomes were confirmed by the Operator."],
    },
    publication: {
      kind: "external_pull_request",
      pullRequest: {
        repository: { id: "42", owner: "example", name: "kestrel" },
        author: "octocat",
        number: 42,
        url: "https://github.com/example/kestrel/pull/42",
        state: "open",
        title: "Keep repository access explicit",
        body: null,
        baseRef: "main",
        headRef: "review-source",
        baseCommitId: "a".repeat(40),
        headCommitId: "b".repeat(40),
      },
      revision: {
        id: revisionId,
        state: "available",
        objectFormat: "sha1",
        base: { objectId: "a".repeat(40), ref: "main" },
        head: { objectId: "b".repeat(40), ref: "review-source" },
        objectCount: 7,
        retainedBytes: 4096,
        failureReason: null,
        createdAt: at,
        availableAt: at,
      },
      retainedManifestDigest: "c".repeat(64),
      certificate: null,
    },
    evidence: {
      source: {
        baseCommitId: "a".repeat(40),
        headCommitId: "b".repeat(40),
        headTreeId: "c".repeat(40),
        retainedManifestDigest: "c".repeat(64),
        limits: {
          catalogPageEntries: 200,
          fileBytes: 524288,
          lineRange: 200,
          responseBytes: 32768,
        },
      },
      checks: null,
    },
    configuration: {
      model: { route: "codex_subscription", modelId: "gpt-6-astra" },
      runtimePolicy: {
        kind: "retained_source_review",
        version: 1,
        adapter: "codex_app_server",
        adapterVersion: 1,
        containerImage: `sha256:${"1".repeat(64)}`,
        containerUser: "501:20",
        codexExecutable: "/usr/local/bin/codex",
        codexExecutableDigest: "e".repeat(64),
        codexVersion: "0.155.1",
        codexProtocol: "app_server_v2",
        sourceAccess: "retained_read_only",
        networkAccess: false,
        writeAccess: false,
        status: "available",
      },
      resources: {
        maximumAttempts: 3,
        timeoutSeconds: 900,
        maximumEvidenceItems: 400,
        maximumWorkspaceFiles: 20000,
        maximumWorkspaceBytes: 268435456,
        maximumGraphNodes: 800,
        maximumOutputBytes: 131072,
        containerPidsLimit: 128,
        containerMemoryBytes: 1073741824,
        containerNanoCpus: 2000000000,
        containerTmpfsBytes: 67108864,
      },
    },
    readiness: { state: "ready", startAllowed: true, blockers: [] },
  });

function workflow(state: "queued" | "published" = "published") {
  return FactoryConceptualReviewWorkflowReadSchema.parse({
    schemaVersion: 1,
    workflow: {
      id: workflowId,
      requestId,
      projectId,
      featureId: null,
      changeProposalId: proposalId,
      inputDigest: digest,
      reviewRevisionId: revisionId,
      state,
      attempt: { current: state === "queued" ? 0 : 1, maximum: 3 },
      failure: null,
      artifactId: state === "published" ? artifactId : null,
      requestedAt: at,
      startedAt: state === "published" ? at : null,
      finishedAt: state === "published" ? at : null,
    },
    artifact:
      state === "published"
        ? {
            schemaVersion: 1,
            id: artifactId,
            workflowId,
            inputDigest: digest,
            reviewRevisionId: revisionId,
            baseCommitId: "a".repeat(40),
            headCommitId: "b".repeat(40),
            status: "partial",
            evidenceScope: {
              source: "exact_retained_revision",
              executedChecks: "not_linked",
              narrativeAuthority: "source_only_model_interpretation",
            },
            graph: {
              result: "partial",
              summary: "The access boundary is explicit in the retained source.",
              outcomes: [
                {
                  id: "outcome-access",
                  outcomeKey: "stated_intent",
                  title: "Repository access remains explicit",
                  coverage: "mapped",
                  behavioralStepIds: ["behavior-access"],
                  reason: "The source keeps authorization at the boundary.",
                },
              ],
              behavioralSteps: [
                {
                  id: "behavior-access",
                  title: "Reject implicit access",
                  description: "The handler requires an explicit source binding.",
                  change: "modified",
                  outcomeKeys: ["stated_intent"],
                  evidenceIds: ["source-access"],
                },
              ],
              evidence: [
                {
                  id: "source-access",
                  type: "source",
                  side: "head",
                  path: "src/review.ts",
                  startLine: 10,
                  endLine: 12,
                  description: "Explicit source binding",
                  sufficiency: "These lines show the changed authorization branch.",
                  limitations: [],
                },
              ],
              problems: [],
              edges: [
                { from: "outcome-access", to: "behavior-access", kind: "implemented_by" },
                { from: "behavior-access", to: "source-access", kind: "supported_by" },
              ],
              limitations: ["No executed test results are linked to this external pull request."],
            },
            createdAt: at,
          }
        : null,
    currency: "up_to_date",
  });
}

describe("ExternalPullRequestReviewPanel", () => {
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

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderPanel(overrides: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(
        createElement(ExternalPullRequestReviewPanel, {
          changeProposalId: proposalId,
          disabled: false,
          online: true,
          projectId,
          onAuthenticationError: () => false,
          loadPreparation: vi.fn().mockResolvedValue(preparation),
          loadCurrentReview: vi.fn().mockResolvedValue({ schemaVersion: 1, review: null }),
          loadReviewWorkflow: vi.fn(),
          loadReviewHistory: vi.fn().mockResolvedValue({
            schemaVersion: 1,
            reviews: [],
            offset: 0,
            total: 0,
            nextOffset: null,
          }),
          loadReviewArtifact: vi.fn(),
          loadReviewSourceLines: vi.fn(),
          startReview: vi.fn().mockResolvedValue(workflow("queued")),
          ...overrides,
        }),
      );
      await Promise.resolve();
    });
  }

  it("starts the actual review from the exact server-issued input digest", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
    const startReview = vi.fn().mockResolvedValue(workflow("queued"));
    await renderPanel({ startReview });

    expect(container.textContent).toContain("Did this pull request deliver what it says?");
    expect(container.textContent).toContain("Purpose limits");
    expect(container.textContent).toContain("Retained source is read only");
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent.includes("Start independent review"),
    );
    if (button === undefined) throw new Error("Review start button is unavailable");
    expect(button.disabled).toBe(false);

    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(startReview).toHaveBeenCalledWith(projectId, proposalId, {
      requestId,
      preparationDigest: digest,
    });
    expect(container.textContent).toContain("Review queued");
  });

  it("renders a light partial review, explorable graph, and exact source lines", async () => {
    const published = workflow();
    const loadReviewSourceLines = vi.fn().mockResolvedValue({
      status: "available",
      side: "head",
      commitId: "b".repeat(40),
      mode: "100644",
      objectId: "c".repeat(40),
      path: "src/review.ts",
      type: "blob",
      startLine: 10,
      endLine: 12,
      totalLines: 40,
      hasFinalNewline: true,
      lineEndings: ["lf", "lf", "lf"],
      text: "if (!source) return denied;",
    });
    await renderPanel({
      loadCurrentReview: vi.fn().mockResolvedValue({ schemaVersion: 1, review: published }),
      loadReviewSourceLines,
    });

    expect(container.textContent).toContain("The access boundary is explicit");
    expect(container.textContent).toContain("Requested outcomes");
    expect(container.textContent).toContain("Source evidence");
    expect(container.textContent).toContain("No executed test results are linked");
    expect(container.textContent).not.toMatch(/final checks/iu);
    expect(container.textContent).toContain("Partial means");
    const sourceButton = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent.includes("src/review.ts"),
    );
    if (sourceButton === undefined) throw new Error("Source graph node is unavailable");
    await act(async () => {
      sourceButton.click();
      await Promise.resolve();
    });
    expect(loadReviewSourceLines).toHaveBeenCalledWith(
      projectId,
      proposalId,
      artifactId,
      "head",
      "src/review.ts",
      10,
      12,
      expect.any(AbortSignal),
    );
    expect(container.textContent).toContain("if (!source) return denied;");
  });
});
