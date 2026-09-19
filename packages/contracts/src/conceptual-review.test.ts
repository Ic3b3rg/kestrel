import { expect, it } from "vitest";

import {
  FactoryConceptualReviewPreparationSchema,
  FactoryConceptualReviewSourceLinesSchema,
  FactoryConceptualReviewCheckSchema,
} from "./conceptual-review.js";

const id = "01991c36-7f90-7000-8000-000000000001";
const secondId = "01991c36-7f90-7000-8000-000000000002";
const at = "2026-09-19T12:00:00.000Z";
const baseCommitId = "a".repeat(40);
const headCommitId = "b".repeat(40);
const treeId = "c".repeat(40);
const digest = "d".repeat(64);
const command = { program: "npm", args: ["test"], cwd: ".", timeoutSeconds: 60 };

const validPreparation = {
  schemaVersion: 1,
  projectId: id,
  featureId: secondId,
  changeProposalId: secondId,
  preparationDigest: digest,
  basis: {
    objective: "Keep search results current",
    scope: { includes: ["Refresh results"], excludes: [] },
    outcomes: [
      {
        key: "refresh",
        outcome: "New results appear",
        intent: { kind: "approved_feature_plan", label: "Approved Feature plan · version 2" },
      },
    ],
    provenance: {
      planVersionId: id,
      version: 2,
      author: "assistant",
      approvalId: secondId,
      approvedByOperatorId: id,
      approvedAt: at,
      planDigest: digest,
    },
  },
  publication: {
    pullRequest: {
      repository: { id: "42", owner: "example", name: "search" },
      id: "9",
      nodeId: "PR_example",
      repositoryNodeId: "R_example",
      authorNodeId: "U_example",
      author: "operator",
      number: 9,
      url: "https://github.com/example/search/pull/9",
      state: "open",
      title: "Refresh search results",
      body: "Approved Feature\n<!-- exact -->",
      marker: "<!-- exact -->",
      baseRef: "master",
      headRef: "kestrel/feature/search",
      baseCommitId,
      headCommitId,
    },
    revision: {
      id,
      state: "available",
      objectFormat: "sha1",
      base: { objectId: baseCommitId, ref: "master" },
      head: { objectId: headCommitId, ref: "kestrel/feature/search" },
      objectCount: 5,
      retainedBytes: 1024,
      failureReason: null,
      createdAt: at,
      availableAt: at,
    },
    retainedManifestDigest: digest,
    certificate: {
      id,
      featureId: secondId,
      approvedVersion: 2,
      runId: secondId,
      source: { repositoryId: id, identity: digest },
      revision: {
        baseCommitId,
        headCommitId,
        treeId,
        branch: "refs/heads/kestrel/feature/search",
      },
      manifest: [{ position: 1, command, origins: [{ workItemKey: "search", position: 1 }] }],
      manifestDigest: digest,
      evidenceIds: [id],
      createdAt: at,
    },
  },
  evidence: {
    source: {
      baseCommitId,
      headCommitId,
      retainedManifestDigest: digest,
      limits: {
        catalogPageEntries: 200,
        fileBytes: 524288,
        lineRange: 200,
        responseBytes: 32768,
      },
    },
    checks: {
      runId: secondId,
      manifestDigest: digest,
      total: 1,
      limits: { catalogPageEntries: 100, outputBytesPerStream: 8192 },
    },
  },
  configuration: {
    model: { route: "codex_subscription", modelId: "gpt-6-astra" },
    runtimePolicy: {
      kind: "retained_source_review",
      version: 1,
      sourceAccess: "retained_read_only",
      networkAccess: false,
      writeAccess: false,
      status: "unavailable",
    },
    resources: {
      maximumAttempts: 3,
      timeoutSeconds: 900,
      maximumSourceReads: 400,
      maximumGraphNodes: 800,
      maximumOutputBytes: 262144,
    },
  },
  readiness: {
    state: "blocked",
    startAllowed: false,
    blockers: ["review_runtime_unavailable"],
  },
};

it("accepts an exact inspectable basis while keeping the unavailable review runtime blocked", () => {
  expect(FactoryConceptualReviewPreparationSchema.parse(validPreparation)).toEqual(
    validPreparation,
  );
});

it("rejects a preparation whose retained revision differs from the certified head", () => {
  expect(() =>
    FactoryConceptualReviewPreparationSchema.parse({
      ...validPreparation,
      publication: {
        ...validPreparation.publication,
        revision: {
          ...validPreparation.publication.revision,
          head: { ...validPreparation.publication.revision.head, objectId: "e".repeat(40) },
        },
      },
    }),
  ).toThrow();
});

it("accepts bounded retained source text without accepting an artifact locator", () => {
  const result = FactoryConceptualReviewSourceLinesSchema.parse({
    status: "available",
    side: "head",
    commitId: headCommitId,
    mode: "100644",
    type: "blob",
    objectId: treeId,
    path: "src/search.ts",
    startLine: 4,
    endLine: 5,
    totalLines: 9,
    hasFinalNewline: true,
    lineEndings: ["lf", "lf"],
    text: "refresh();\nrender();\n",
  });
  expect(result.path).toBe("src/search.ts");
  expect("artifactLocator" in result).toBe(false);
});

it("keeps executed check provenance distinct from the claim it may support", () => {
  const result = FactoryConceptualReviewCheckSchema.parse({
    schemaVersion: 1,
    evidenceId: id,
    runId: secondId,
    manifestPosition: 1,
    origins: [{ workItemKey: "search", position: 1 }],
    result: {
      id,
      round: 1,
      position: 1,
      command,
      headCommitId,
      treeId,
      outcome: "passed",
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 123,
      createdAt: at,
    },
  });
  expect(result.result.outcome).toBe("passed");
  expect(result).not.toHaveProperty("supportedOutcomeKeys");
});
