import { expect, it } from "vitest";

import {
  FactoryConceptualReviewArtifactSchema,
  FactoryConceptualReviewDraftSchema,
  FactoryConceptualReviewPreparationSchema,
  FactoryConceptualReviewStartCommandSchema,
  FactoryConceptualReviewWorkflowReadSchema,
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
      adapter: "codex_app_server",
      adapterVersion: 1,
      containerImage: null,
      containerUser: null,
      codexExecutable: null,
      codexExecutableDigest: null,
      codexVersion: null,
      codexProtocol: "app_server_v2",
      sourceAccess: "retained_read_only",
      networkAccess: false,
      writeAccess: false,
      status: "unavailable",
    },
    resources: {
      maximumAttempts: 3,
      timeoutSeconds: 900,
      maximumEvidenceItems: 400,
      maximumWorkspaceFiles: 20_000,
      maximumWorkspaceBytes: 268435456,
      maximumGraphNodes: 800,
      maximumOutputBytes: 131072,
      containerPidsLimit: 128,
      containerMemoryBytes: 1073741824,
      containerNanoCpus: 2000000000,
      containerTmpfsBytes: 67108864,
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

const graph = {
  result: "complete" as const,
  summary: "The approved refresh behavior is implemented, with one source-backed risk.",
  outcomes: [
    {
      id: "outcome:refresh",
      outcomeKey: "refresh",
      title: "New results appear",
      coverage: "mapped" as const,
      behavioralStepIds: ["step:refresh"],
      reason: "The refresh path is implemented.",
    },
  ],
  behavioralSteps: [
    {
      id: "step:refresh",
      title: "Refresh visible results",
      description: "The client requests and renders the newest result set.",
      change: "modified" as const,
      outcomeKeys: ["refresh"],
      evidenceIds: ["source:refresh"],
    },
  ],
  evidence: [
    {
      id: "source:refresh",
      type: "source" as const,
      side: "head" as const,
      path: "src/search.ts",
      startLine: 4,
      endLine: 8,
      description: "The exact head invokes the refresh path.",
      sufficiency: "Shows the implemented branch but not browser timing.",
      limitations: ["No executed browser trace is linked in this slice."],
    },
  ],
  problems: [
    {
      id: "finding:race",
      type: "finding" as const,
      title: "A stale response may replace a newer one",
      condition: "Two refreshes finish out of order.",
      consequence: "The visible results can move backwards.",
      reasoning: "The assignment is unconditional after each request resolves.",
      evidenceIds: ["source:refresh"],
      riskLevel: "medium" as const,
      sufficiency: "The exact-head assignment supports the race condition.",
      limitations: ["No deterministic concurrency check was executed."],
    },
  ],
  edges: [
    { from: "outcome:refresh", to: "step:refresh", kind: "implemented_by" as const },
    { from: "step:refresh", to: "source:refresh", kind: "supported_by" as const },
    { from: "source:refresh", to: "finding:race", kind: "reveals" as const },
  ],
  limitations: ["Executed-check linkage is incomplete until the next review slice."],
};

it("accepts a bounded requirements graph with exact source evidence and typed problems", () => {
  expect(FactoryConceptualReviewDraftSchema.parse(graph)).toEqual(graph);
  expect(() =>
    FactoryConceptualReviewDraftSchema.parse({
      ...graph,
      problems: [{ ...graph.problems[0], evidenceIds: [], riskLevel: undefined }],
    }),
  ).toThrow();
  expect(() =>
    FactoryConceptualReviewDraftSchema.parse({
      ...graph,
      edges: [{ from: "outcome:refresh", to: "missing", kind: "implemented_by" }],
    }),
  ).toThrow();
  expect(() =>
    FactoryConceptualReviewDraftSchema.parse({
      ...graph,
      evidence: [graph.evidence[0], graph.evidence[0]],
    }),
  ).toThrow();
});

it("rejects graph relationships that are not declared by both linked nodes", () => {
  expect(() =>
    FactoryConceptualReviewDraftSchema.parse({
      ...graph,
      behavioralSteps: [
        ...graph.behavioralSteps,
        {
          ...graph.behavioralSteps[0],
          id: "step:undeclared",
          title: "An undeclared behavior",
        },
      ],
      edges: [
        ...graph.edges,
        { from: "step:undeclared", to: "source:refresh", kind: "supported_by" },
      ],
    }),
  ).toThrow();

  expect(() =>
    FactoryConceptualReviewDraftSchema.parse({
      ...graph,
      evidence: [
        ...graph.evidence,
        { ...graph.evidence[0], id: "source:undeclared", startLine: 9, endLine: 9 },
      ],
      edges: [
        ...graph.edges,
        { from: "step:refresh", to: "source:undeclared", kind: "supported_by" },
      ],
    }),
  ).toThrow();

  expect(() =>
    FactoryConceptualReviewDraftSchema.parse({
      ...graph,
      evidence: [
        ...graph.evidence,
        { ...graph.evidence[0], id: "source:orphan", startLine: 10, endLine: 10 },
      ],
    }),
  ).toThrow();
});

it("keeps edge identity collision-free when node IDs contain edge-kind delimiters", () => {
  expect(() =>
    FactoryConceptualReviewDraftSchema.parse({
      result: "partial",
      summary: "A forged edge must not satisfy a different declared relationship.",
      outcomes: [
        {
          id: "a",
          outcomeKey: "one",
          title: "First outcome",
          coverage: "mapped",
          behavioralStepIds: ["b:implemented_by:c"],
          reason: "Declared against the long step ID.",
        },
        {
          id: "a:implemented_by:b",
          outcomeKey: "two",
          title: "Second outcome",
          coverage: "gap",
          behavioralStepIds: [],
          reason: "No behavior is mapped.",
        },
        {
          id: "d",
          outcomeKey: "three",
          title: "Third outcome",
          coverage: "mapped",
          behavioralStepIds: ["c"],
          reason: "Mapped to the short step ID.",
        },
      ],
      behavioralSteps: [
        {
          id: "b:implemented_by:c",
          title: "Long step ID",
          description: "Implements only the first outcome.",
          change: "modified",
          outcomeKeys: ["one"],
          evidenceIds: ["e"],
        },
        {
          id: "c",
          title: "Short step ID",
          description: "Implements only the third outcome.",
          change: "modified",
          outcomeKeys: ["three"],
          evidenceIds: ["e"],
        },
      ],
      evidence: [
        {
          ...graph.evidence[0],
          id: "e",
        },
      ],
      problems: [],
      edges: [
        { from: "a:implemented_by:b", to: "c", kind: "implemented_by" },
        { from: "d", to: "c", kind: "implemented_by" },
        { from: "b:implemented_by:c", to: "e", kind: "supported_by" },
        { from: "c", to: "e", kind: "supported_by" },
      ],
      limitations: ["The second outcome remains uncovered."],
    }),
  ).toThrow();
});

it("requires partial review output to disclose every uncovered outcome", () => {
  expect(() =>
    FactoryConceptualReviewDraftSchema.parse({
      ...graph,
      result: "complete",
      outcomes: [
        {
          ...graph.outcomes[0],
          coverage: "unclear",
          behavioralStepIds: [],
          reason: "The source is inconclusive.",
        },
      ],
    }),
  ).toThrow();
});

it("does not map an approved outcome through context or incoherent source sides alone", () => {
  expect(() =>
    FactoryConceptualReviewDraftSchema.parse({
      ...graph,
      behavioralSteps: [{ ...graph.behavioralSteps[0], change: "context" }],
    }),
  ).toThrow();

  expect(() =>
    FactoryConceptualReviewDraftSchema.parse({
      ...graph,
      behavioralSteps: [{ ...graph.behavioralSteps[0], change: "added" }],
      evidence: [{ ...graph.evidence[0], side: "base" }],
    }),
  ).toThrow();

  expect(
    FactoryConceptualReviewDraftSchema.parse({
      ...graph,
      behavioralSteps: [{ ...graph.behavioralSteps[0], change: "removed" }],
      evidence: [{ ...graph.evidence[0], side: "base" }],
      problems: [],
      edges: graph.edges.filter(({ kind }) => kind !== "reveals"),
    }),
  ).toBeDefined();
});

it("models explicit idempotent starts and durable pending, failed, partial and outdated states", () => {
  const command = FactoryConceptualReviewStartCommandSchema.parse({
    requestId: "65cc9964-10c2-49d1-86c4-8f13f5019e86",
    preparationDigest: digest,
  });
  const artifact = FactoryConceptualReviewArtifactSchema.parse({
    schemaVersion: 1,
    id,
    workflowId: secondId,
    inputDigest: digest,
    reviewRevisionId: id,
    baseCommitId,
    headCommitId,
    status: "partial",
    evidenceScope: {
      source: "exact_retained_revision",
      executedChecks: "not_linked",
      narrativeAuthority: "source_only_model_interpretation",
    },
    graph: { ...graph, result: "partial" },
    createdAt: at,
  });
  const read = FactoryConceptualReviewWorkflowReadSchema.parse({
    schemaVersion: 1,
    workflow: {
      id: secondId,
      requestId: command.requestId,
      projectId: id,
      featureId: secondId,
      changeProposalId: secondId,
      inputDigest: digest,
      reviewRevisionId: id,
      state: "published",
      attempt: { current: 1, maximum: 3 },
      failure: null,
      artifactId: id,
      requestedAt: at,
      startedAt: at,
      finishedAt: at,
    },
    artifact,
    currency: "outdated",
  });
  expect(read.artifact?.status).toBe("partial");
  expect(read.currency).toBe("outdated");
});
