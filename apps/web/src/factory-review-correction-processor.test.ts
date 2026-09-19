import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { factoryVerificationManifest, type FeaturePlanDocument } from "@kestrel/contracts";
import * as database from "@kestrel/database";
import * as source from "@kestrel/local-source";
import { createFactoryReviewCorrectionProcessor } from "./factory-review-correction-processor.js";
import type { FactoryFeatureGitHubAdapter } from "./factory-feature-github.js";

vi.mock("@kestrel/database", async (original) => ({
  ...(await original<typeof database>()),
  claimFactoryReviewCorrection: vi.fn(),
  markFactoryReviewCorrectionPush: vi.fn(),
  confirmFactoryReviewCorrectionPush: vi.fn(),
  bindFactoryReviewCorrectionRevision: vi.fn(),
  bindFactoryReviewCorrectionWorkflow: vi.fn(),
  failFactoryReviewCorrection: vi.fn(),
}));
vi.mock("@kestrel/local-source", async (original) => ({
  ...(await original<typeof source>()),
  openFeatureWorkspace: vi.fn(),
  assertFeatureWorkspaceSnapshot: vi.fn(),
}));

const featureId = "01991c36-7f90-7000-8000-000000000001";
const projectId = "01991c36-7f90-7000-8000-000000000002";
const correctionId = "01991c36-7f90-7000-8000-000000000003";
const reviewedHead = "b".repeat(40);
const correctedHead = "d".repeat(40);
const plan: FeaturePlanDocument = {
  objective: "Keep the empty-state action visible",
  scope: { includes: ["Empty state"], excludes: ["Navigation redesign"] },
  acceptance: [{ key: "A1", outcome: "The action remains visible after refresh" }],
  workItems: [
    {
      key: "W1",
      title: "Persist the action",
      importedIssueId: null,
      description: "Retain the action",
      requirementKeys: ["A1"],
      acceptance: ["Action remains visible"],
      dependsOn: [],
      verification: [{ program: "npm", args: ["test"], cwd: ".", timeoutSeconds: 60 }],
    },
  ],
  limits: { maxConcurrentProjects: 2, maxActiveFeaturesPerProject: 1, attemptTimeoutSeconds: 60 },
};
const manifest = factoryVerificationManifest(plan);
const identity = {
  repository: { id: "42", owner: "example", name: "factory" },
  account: "operator",
};
const remote = {
  repository: { owner: "example", name: "factory" },
  remoteName: "origin" as const,
  configuredUrl: "git@github.com:example/factory.git",
  configuredPushUrl: null,
  canonicalUrl: "https://github.com/example/factory.git",
  targetRef: "refs/heads/master",
};
const reviewedRevision = {
  baseCommitId: "a".repeat(40),
  headCommitId: reviewedHead,
  treeId: "c".repeat(40),
  branch: `refs/heads/kestrel/feature/${featureId}`,
};
const correctedRevision = {
  ...reviewedRevision,
  headCommitId: correctedHead,
  treeId: "e".repeat(40),
};
const payload = {
  title: "Keep action visible",
  body: `Approved change\n<!-- kestrel:feature-pr:${featureId} -->`,
  marker: `<!-- kestrel:feature-pr:${featureId} -->`,
  baseRef: "master",
  headRef: `kestrel/feature/${featureId}`,
  baseCommitId: reviewedRevision.baseCommitId,
  headCommitId: reviewedHead,
};
const pull = {
  ...payload,
  repository: identity.repository,
  id: "9",
  nodeId: "PR_example",
  repositoryNodeId: "R_example",
  authorNodeId: "U_example",
  number: 9,
  url: "https://github.com/example/factory/pull/9",
  state: "open" as const,
  author: "operator",
};
const operation = {
  id: featureId,
  featureId,
  target: {
    certificateId: featureId,
    approvedVersion: 1,
    approvalId: projectId,
    source: { repositoryId: projectId, identity: "f".repeat(64) },
    revision: reviewedRevision,
    identity,
    remote,
  },
  issues: [
    {
      workItemId: projectId,
      key: "W1",
      title: "Persist the action",
      issue: {
        repository: identity.repository,
        id: "1",
        number: 1,
        url: "https://github.com/example/factory/issues/1",
      },
    },
  ],
  payload,
};

it.each([
  { pushAttempted: false, observedHead: reviewedHead, publishes: true },
  { pushAttempted: true, observedHead: reviewedHead, publishes: true },
  {
    pushAttempted: true,
    observedHead: "f".repeat(40),
    publishes: false,
    fencedDuringFailure: true,
  },
])(
  "reconciles the reviewed branch before publishing: %j",
  async ({ pushAttempted, observedHead, publishes, fencedDuringFailure }) => {
    vi.clearAllMocks();
    const certificate = {
      id: correctionId,
      featureId,
      approvedVersion: 1,
      runId: projectId,
      source: operation.target.source,
      revision: correctedRevision,
      manifest,
      manifestDigest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
      evidenceIds: [projectId],
      createdAt: new Date().toISOString(),
    };
    const claim: database.ClaimedFactoryReviewCorrection = {
      id: correctionId,
      featureId,
      projectId,
      attemptId: correctionId,
      planVersion: 1,
      title: payload.title,
      plan,
      approvalId: projectId,
      operatorId: projectId,
      workspace: {
        featureId,
        projectId,
        repositoryId: projectId,
        sourceIdentity: operation.target.source.identity,
        ...correctedRevision,
        objectFormat: "sha1",
      },
      planMarkdown: "# Plan",
      specMarkdown: "# Spec",
      identity,
      issues: operation.issues,
      reviewRequestId: correctionId,
      sourceReview: {
        workflowId: projectId,
        artifactId: featureId,
        reviewRevisionId: correctionId,
        baseCommitId: reviewedRevision.baseCommitId,
        headCommitId: reviewedHead,
      },
      instruction: "Keep the action visible after refresh",
      findings: [],
      runId: projectId,
      certificate,
      operation,
      pullRequest: pull,
      pushAttempted,
      pushConfirmed: false,
    };
    vi.mocked(database.claimFactoryReviewCorrection).mockResolvedValue(claim);
    vi.mocked(source.openFeatureWorkspace).mockResolvedValue({
      identity: claim.workspace,
      workspacePath: "/private/feature",
      gitDirectory: "/private/repository.git",
      shallowBaseCommitId: reviewedRevision.baseCommitId,
    });
    const correctedPull = { ...pull, headCommitId: correctedHead };
    const github = {
      identify: vi.fn<FactoryFeatureGitHubAdapter["identify"]>(() => Promise.resolve(identity)),
      observePullRequest: vi.fn<FactoryFeatureGitHubAdapter["observePullRequest"]>(() =>
        Promise.resolve({
          baseCommitId: reviewedRevision.baseCommitId,
          headCommitId: observedHead,
          state: "open",
        }),
      ),
      readPullRequest: vi.fn<FactoryFeatureGitHubAdapter["readPullRequest"]>(() =>
        Promise.resolve(correctedPull),
      ),
    };
    const push = vi.fn<typeof source.pushFeatureCorrectionHead>(() =>
      Promise.resolve({
        state: "confirmed",
        value: { headCommitId: correctedHead, ref: correctedRevision.branch },
      }),
    );
    const retained = {
      projectId,
      changeProposalId: featureId,
      revision: {
        id: correctionId,
        state: "available" as const,
        objectFormat: "sha1" as const,
        base: { objectId: reviewedRevision.baseCommitId, ref: "master" },
        head: { objectId: correctedHead, ref: payload.headRef },
        objectCount: 3,
        retainedBytes: 100,
        failureReason: null,
        createdAt: new Date().toISOString(),
        availableAt: new Date().toISOString(),
      },
      manifestDigest: "1".repeat(64),
    };
    const retain = vi.fn(() => Promise.resolve(retained));
    const preparation = {
      preparationDigest: "2".repeat(64),
      readiness: { state: "ready" as const, startAllowed: true, blockers: [] },
      publication: { pullRequest: correctedPull },
    };
    const workflow = {
      schemaVersion: 1 as const,
      workflow: {
        id: correctionId,
        requestId: correctionId,
        projectId,
        featureId,
        changeProposalId: featureId,
        inputDigest: "2".repeat(64),
        reviewRevisionId: correctionId,
        state: "queued" as const,
        attempt: { current: 0, maximum: 3 },
        failure: null,
        artifactId: null,
        requestedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      },
      artifact: null,
      currency: "up_to_date" as const,
    };
    const review = {
      prepare: vi.fn(() => Promise.resolve(preparation)),
      start: vi.fn(() => Promise.resolve(workflow)),
    };
    const processor = createFactoryReviewCorrectionProcessor({
      pool: {} as never,
      readSourceConfig: vi.fn(() => Promise.resolve({} as never)),
      retain,
      github,
      git: { push },
      review: review as never,
    });

    if (fencedDuringFailure)
      vi.mocked(database.failFactoryReviewCorrection).mockRejectedValueOnce(
        new database.FactoryReviewCorrectionError("invalid_state"),
      );

    await processor.process({ correctionId });

    if (!publishes) {
      expect(database.markFactoryReviewCorrectionPush).toHaveBeenCalledWith(
        expect.anything(),
        claim,
        false,
      );
      expect(database.failFactoryReviewCorrection).toHaveBeenCalledWith(
        expect.anything(),
        claim,
        "head_changed",
        undefined,
      );
      expect(push).not.toHaveBeenCalled();
      expect(retain).not.toHaveBeenCalled();
      return;
    }

    const pushCall = push.mock.calls[0];
    expect(pushCall?.[1].snapshot).toMatchObject({
      headCommitId: correctedHead,
      treeId: correctedRevision.treeId,
    });
    expect(pushCall?.[2]).toEqual(remote);
    expect(pushCall?.[3]).toBe(reviewedHead);
    expect(pushCall?.[4]?.signal).toBeInstanceOf(AbortSignal);
    expect(
      vi.mocked(database.markFactoryReviewCorrectionPush).mock.calls.map((call) => call[2]),
    ).toEqual(pushAttempted ? [false, true] : [true]);
    const bindCall = vi.mocked(database.bindFactoryReviewCorrectionRevision).mock.calls[0];
    expect(bindCall?.[1]).toBe(claim);
    expect(bindCall?.[2].payload.headCommitId).toBe(correctedHead);
    expect(bindCall?.[3]).toEqual(correctedPull);
    expect(bindCall?.[4]).toEqual(retained);
    expect(review.start).toHaveBeenCalledWith(
      { projectId, featureId },
      { requestId: correctionId, preparationDigest: preparation.preparationDigest },
      { actorId: projectId, correlationId: correctionId },
    );
    expect(database.bindFactoryReviewCorrectionWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      claim,
      workflow,
    );
  },
);
