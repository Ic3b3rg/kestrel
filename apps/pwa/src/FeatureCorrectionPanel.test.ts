// @vitest-environment happy-dom
import { mockLifecycleProfileRequests } from "./lifecycle-profile.test-support.js";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FactoryConceptualReviewWorkflowRead } from "@kestrel/contracts";
import { FeatureCorrectionPanel } from "./FeatureCorrectionPanel.js";

const projectId = "01991c36-7f90-7000-8000-000000000001";
const featureId = "01991c36-7f90-7000-8000-000000000002";
const workflowId = "01991c36-7f90-7000-8000-000000000003";
const artifactId = "01991c36-7f90-7000-8000-000000000004";
const headCommitId = "a".repeat(40);
const baseCommitId = "b".repeat(40);
const at = "2026-09-19T12:00:00.000Z";
const review: FactoryConceptualReviewWorkflowRead = {
  schemaVersion: 1,
  workflow: {
    id: workflowId,
    requestId: workflowId,
    projectId,
    featureId,
    changeProposalId: featureId,
    inputDigest: "c".repeat(64),
    reviewRevisionId: artifactId,
    state: "published",
    attempt: { current: 1, maximum: 3 },
    failure: null,
    artifactId,
    requestedAt: at,
    startedAt: at,
    finishedAt: at,
  },
  artifact: {
    schemaVersion: 1,
    id: artifactId,
    workflowId,
    inputDigest: "c".repeat(64),
    reviewRevisionId: artifactId,
    baseCommitId,
    headCommitId,
    status: "partial",
    evidenceScope: {
      source: "exact_retained_revision",
      executedChecks: "not_linked",
      narrativeAuthority: "source_only_model_interpretation",
    },
    graph: {
      result: "partial",
      summary: "The action disappears after refresh.",
      outcomes: [
        {
          id: "outcome:action",
          outcomeKey: "action",
          title: "Action remains available",
          coverage: "gap",
          behavioralStepIds: [],
          reason: "The refreshed state drops it.",
        },
      ],
      behavioralSteps: [],
      evidence: [
        {
          id: "source:action",
          type: "source",
          side: "head",
          path: "src/empty.tsx",
          startLine: 1,
          endLine: 2,
          description: "Refresh path",
          sufficiency: "Shows the action removal.",
          limitations: [],
        },
      ],
      problems: [
        {
          id: "finding:action",
          type: "finding",
          title: "Action disappears",
          condition: "The page refreshes.",
          consequence: "The Operator cannot continue.",
          reasoning: "The action is not restored.",
          evidenceIds: ["source:action"],
          riskLevel: "medium",
          sufficiency: "The exact head shows the behavior.",
          limitations: [],
        },
        {
          id: "observation:copy",
          type: "observation",
          title: "Copy is short",
          description: "The label is concise.",
          evidenceIds: [],
          limitations: [],
        },
      ],
      edges: [],
      limitations: [],
    },
    createdAt: at,
  },
  currency: "up_to_date",
};

let root: Root;
let container: HTMLDivElement;
const renderAct = async (action: () => unknown) => {
  await act(async () => {
    await Promise.resolve(action());
  });
};

beforeEach(() => {
  mockLifecycleProfileRequests();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await renderAct(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("submits only explicit text and selected verified findings from the current review", async () => {
  const requestCorrection = vi.fn(() =>
    Promise.resolve({
      schemaVersion: 1 as const,
      id: artifactId,
      featureId,
      approvedVersion: 2,
      requestedByOperatorId: projectId,
      sourceReview: {
        workflowId,
        artifactId,
        reviewRevisionId: artifactId,
        baseCommitId,
        headCommitId,
      },
      instruction: "Keep the action visible after refresh.",
      findings: [
        { id: "finding:action", title: "Action disappears", riskLevel: "medium" as const },
      ],
      state: "executing" as const,
      failure: null,
      canRetry: false,
      runId: workflowId,
      certificateId: null,
      replacementReview: null,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    }),
  );
  await renderAct(() =>
    root.render(
      createElement(FeatureCorrectionPanel, {
        projectId,
        featureId,
        approvedVersion: 2,
        review,
        online: true,
        onAuthenticationError: vi.fn(() => false),
        onReplacementReview: vi.fn(),
        loadCurrent: vi.fn(() => Promise.resolve({ schemaVersion: 1 as const, correction: null })),
        requestCorrection,
        retryCorrection: vi.fn(),
      }),
    ),
  );
  expect(container.textContent).toContain("Action disappears");
  expect(container.textContent).not.toContain("Copy is short");
  const checkbox = container.querySelector('[role="checkbox"]');
  const textarea = container.querySelector("textarea");
  if (!(checkbox instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement))
    throw new Error("Missing correction controls");
  await renderAct(() => checkbox.click());
  await renderAct(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      "Keep the action visible after refresh.",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const submit = [...container.querySelectorAll("button")].find((button) =>
    button.textContent.includes("Apply correction"),
  );
  if (submit === undefined) throw new Error("Missing correction submit button");
  await renderAct(() => submit.click());
  expect(requestCorrection).toHaveBeenCalledWith(
    projectId,
    featureId,
    expect.objectContaining({
      expectedPlanVersion: 2,
      review: { workflowId, artifactId, headCommitId },
      instruction: "Keep the action visible after refresh.",
      findingIds: ["finding:action"],
    }),
  );
  expect(container.textContent).toContain("Applying only the correction you authorized");
});

it("does not offer another request from the historical source review after replacement failure", async () => {
  await renderAct(() =>
    root.render(
      createElement(FeatureCorrectionPanel, {
        projectId,
        featureId,
        approvedVersion: 2,
        review,
        online: true,
        onAuthenticationError: vi.fn(() => false),
        onReplacementReview: vi.fn(),
        loadCurrent: vi.fn(() =>
          Promise.resolve({
            schemaVersion: 1 as const,
            correction: {
              schemaVersion: 1 as const,
              id: artifactId,
              featureId,
              approvedVersion: 2,
              requestedByOperatorId: projectId,
              sourceReview: {
                workflowId,
                artifactId,
                reviewRevisionId: artifactId,
                baseCommitId,
                headCommitId,
              },
              instruction: "Keep the action visible after refresh.",
              findings: [],
              state: "failed" as const,
              failure: "review_failed" as const,
              canRetry: false,
              runId: workflowId,
              certificateId: projectId,
              replacementReview: {
                workflowId: projectId,
                artifactId: null,
                headCommitId: "d".repeat(40),
              },
              createdAt: at,
              updatedAt: at,
              completedAt: null,
            },
          }),
        ),
        requestCorrection: vi.fn(),
        retryCorrection: vi.fn(),
      }),
    ),
  );

  expect(container.textContent).toContain("The replacement review failed visibly");
  expect(container.querySelector("textarea")).toBeNull();
});
