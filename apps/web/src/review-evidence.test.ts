import { expect, it, vi } from "vitest";
import { z } from "zod";

import type {
  FactoryConceptualReviewCheck,
  FactoryConceptualReviewDraft,
  FactoryConceptualReviewPreparation,
} from "@kestrel/contracts";

import {
  FactoryConceptualReviewValidationError,
  FactoryConceptualReviewModelOutputSchema,
  parseFactoryConceptualReviewModelOutput,
  validateFactoryConceptualReview,
} from "./review-evidence.js";

const preparation = {
  basis: {
    outcomes: [
      { key: "search", outcome: "Search" },
      { key: "empty", outcome: "Empty state" },
    ],
  },
  configuration: {
    resources: {
      maximumOutputBytes: 131072,
      containerPidsLimit: 128,
      containerMemoryBytes: 1073741824,
      containerNanoCpus: 2000000000,
      containerTmpfsBytes: 67108864,
      maximumGraphNodes: 100,
      maximumEvidenceItems: 20,
      maximumWorkspaceFiles: 1_000,
      maximumWorkspaceBytes: 16777216,
    },
  },
} as FactoryConceptualReviewPreparation;

const draft: FactoryConceptualReviewDraft = {
  result: "partial",
  summary: "0 of 2 approved outcomes map to exact retained source; 0 problems are identified.",
  outcomes: [
    {
      id: "outcome:search",
      outcomeKey: "search",
      title: "Search",
      coverage: "unclear",
      behavioralStepIds: ["step:search"],
      reason: "The exact head implements it, but no final check is linked.",
    },
    {
      id: "outcome:empty",
      outcomeKey: "empty",
      title: "Empty state",
      coverage: "unclear",
      behavioralStepIds: [],
      reason: "No source path established the empty state.",
    },
  ],
  behavioralSteps: [
    {
      id: "step:search",
      title: "Run search",
      description: "The query updates results.",
      change: "modified",
      outcomeKeys: ["search"],
      evidenceIds: ["source:search"],
    },
  ],
  evidence: [
    {
      id: "source:search",
      type: "source",
      side: "head",
      path: "src/search.ts",
      startLine: 2,
      endLine: 4,
      description: "Search handler.",
      sufficiency: "Shows the result update.",
      limitations: [],
    },
  ],
  problems: [],
  edges: [
    { from: "outcome:search", to: "step:search", kind: "implemented_by" },
    { from: "step:search", to: "source:search", kind: "supported_by" },
  ],
  limitations: ["Browser timing was not observed."],
};
const searchStep = draft.behavioralSteps[0];
const searchEvidence = draft.evidence[0];
if (searchStep === undefined || searchEvidence?.type !== "source")
  throw new Error("Conceptual Review fixture is incomplete");

const source = {
  status: "available" as const,
  id: undefined,
  side: "head" as const,
  commitId: "a".repeat(40),
  mode: "100644" as const,
  objectId: "b".repeat(40),
  path: "src/search.ts",
  type: "blob" as const,
  startLine: 2,
  endLine: 4,
  totalLines: 8,
  hasFinalNewline: true,
  lineEndings: ["lf" as const, "lf" as const, "lf" as const],
  text: "two\nthree\nfour\n",
};
const readChangedRange = () => Promise.resolve({ status: "modified" as const, rangeChanged: true });

const finalCheck = {
  schemaVersion: 1 as const,
  evidenceId: "01991c36-7f90-7000-8000-000000000006",
  runId: "01991c36-7f90-7000-8000-000000000005",
  manifestPosition: 1,
  origins: [{ workItemKey: "search", position: 1 }],
  result: {
    id: "01991c36-7f90-7000-8000-000000000006",
    round: 1,
    position: 1,
    command: { program: "npm", args: ["test"], cwd: ".", timeoutSeconds: 60 },
    headCommitId: "b".repeat(40),
    treeId: "c".repeat(40),
    outcome: "passed" as const,
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 123,
    createdAt: "2026-09-19T12:00:00.000Z",
  },
};
const checkPreparation = {
  ...preparation,
  publication: {
    certificate: {
      featureId: "01991c36-7f90-7000-8000-000000000002",
      runId: finalCheck.runId,
      revision: {
        headCommitId: finalCheck.result.headCommitId,
        treeId: finalCheck.result.treeId,
      },
      manifest: [
        {
          position: 1,
          command: finalCheck.result.command,
          origins: finalCheck.origins,
        },
      ],
      evidenceIds: [finalCheck.evidenceId],
    },
  },
} as unknown as FactoryConceptualReviewPreparation;

it("accepts a bounded graph only after resolving every exact source locator", async () => {
  const readSource = vi.fn(() => Promise.resolve(source));
  await expect(
    validateFactoryConceptualReview({
      preparation,
      draft,
      readSource,
      readChange: readChangedRange,
    }),
  ).resolves.toEqual(draft);
  expect(readSource).toHaveBeenCalledWith(draft.evidence[0]);
});

it("does not let source alone present an approved outcome as adequately mapped", async () => {
  await expect(
    validateFactoryConceptualReview({
      preparation,
      draft: {
        ...draft,
        outcomes: [{ ...draft.outcomes[0], coverage: "mapped" }, draft.outcomes[1]],
      },
      readSource: vi.fn(() => Promise.resolve(source)),
      readChange: readChangedRange,
    }),
  ).rejects.toEqual(new FactoryConceptualReviewValidationError("invalid_output"));
});

it("replaces a model check ID with its exact server-owned final result provenance", async () => {
  const unresolved = {
    ...draft,
    behavioralSteps: [{ ...searchStep, evidenceIds: ["source:search", "check:search"] }],
    evidence: [
      searchEvidence,
      {
        id: "check:search",
        type: "check",
        evidenceId: finalCheck.evidenceId,
        relation: "supports",
        proposition: "The approved search command succeeds on the reviewed head.",
        description: "Final search verification.",
        sufficiency: "Records command success; behavior mapping remains model judgment.",
        limitations: ["No browser timing assertion."],
      },
    ],
    edges: [...draft.edges, { from: "step:search", to: "check:search", kind: "supported_by" }],
  };
  const readCheck = vi.fn(() => Promise.resolve(finalCheck));
  const result = await validateFactoryConceptualReview({
    preparation: checkPreparation,
    draft: unresolved,
    readSource: vi.fn(() => Promise.resolve(source)),
    readChange: readChangedRange,
    readCheck,
  });
  expect(readCheck).toHaveBeenCalledWith(finalCheck.evidenceId);
  expect(result.evidence[1]).toMatchObject({
    type: "check",
    evidenceId: finalCheck.evidenceId,
    record: {
      runId: finalCheck.runId,
      manifestPosition: 1,
      headCommitId: finalCheck.result.headCommitId,
      treeId: finalCheck.result.treeId,
      outcome: "passed",
      exitCode: 0,
    },
  });
});

it.each([
  ["foreign run", { runId: "01991c36-7f90-7000-8000-000000000009" }],
  ["wrong head", { result: { ...finalCheck.result, headCommitId: "f".repeat(40) } }],
  ["wrong tree", { result: { ...finalCheck.result, treeId: "f".repeat(40) } }],
  [
    "wrong command",
    {
      result: {
        ...finalCheck.result,
        command: { ...finalCheck.result.command, args: ["test", "--changed"] },
      },
    },
  ],
  ["failed result", { result: { ...finalCheck.result, outcome: "failed", exitCode: 1 } }],
  ["timeout result", { result: { ...finalCheck.result, outcome: "timeout", exitCode: null } }],
] as const)("rejects %s as support for the frozen review", async (_name, change) => {
  const unresolved = {
    ...draft,
    behavioralSteps: [{ ...searchStep, evidenceIds: ["source:search", "check:search"] }],
    evidence: [
      searchEvidence,
      {
        id: "check:search",
        type: "check",
        evidenceId: finalCheck.evidenceId,
        relation: "supports",
        proposition: "The search command succeeds.",
        description: "Final search verification.",
        sufficiency: "Command evidence.",
        limitations: [],
      },
    ],
    edges: [...draft.edges, { from: "step:search", to: "check:search", kind: "supported_by" }],
  };
  await expect(
    validateFactoryConceptualReview({
      preparation: checkPreparation,
      draft: unresolved,
      readSource: vi.fn(() => Promise.resolve(source)),
      readChange: readChangedRange,
      readCheck: vi.fn(() =>
        Promise.resolve({ ...finalCheck, ...change } as unknown as FactoryConceptualReviewCheck),
      ),
    }),
  ).rejects.toEqual(new FactoryConceptualReviewValidationError("check_unavailable"));
});

it("rejects unchanged source presented as a delivered modification", async () => {
  await expect(
    validateFactoryConceptualReview({
      preparation,
      draft,
      readSource: vi.fn(() => Promise.resolve(source)),
      readChange: vi.fn(() =>
        Promise.resolve({ status: "unchanged" as const, rangeChanged: false }),
      ),
    }),
  ).rejects.toEqual(new FactoryConceptualReviewValidationError("invalid_output"));
});

it("rejects base evidence presented as removed while the path remains in the head", async () => {
  const removedDraft: FactoryConceptualReviewDraft = {
    ...draft,
    behavioralSteps: [
      {
        ...searchStep,
        change: "removed",
        evidenceIds: ["source:search"],
      },
    ],
    evidence: [{ ...searchEvidence, side: "base" }],
  };
  await expect(
    validateFactoryConceptualReview({
      preparation,
      draft: removedDraft,
      readSource: vi.fn(() => Promise.resolve({ ...source, side: "base" as const })),
      readChange: vi.fn(() => Promise.resolve({ status: "modified" as const, rangeChanged: true })),
    }),
  ).rejects.toEqual(new FactoryConceptualReviewValidationError("invalid_output"));
});

it("rejects head evidence presented as added when the path already existed", async () => {
  const addedDraft: FactoryConceptualReviewDraft = {
    ...draft,
    behavioralSteps: [{ ...searchStep, change: "added" }],
  };
  await expect(
    validateFactoryConceptualReview({
      preparation,
      draft: addedDraft,
      readSource: vi.fn(() => Promise.resolve(source)),
      readChange: vi.fn(() => Promise.resolve({ status: "modified" as const, rangeChanged: true })),
    }),
  ).rejects.toEqual(new FactoryConceptualReviewValidationError("invalid_output"));
});

it("rejects omitted approved outcomes and invented source ranges", async () => {
  await expect(
    validateFactoryConceptualReview({
      preparation,
      draft: { ...draft, outcomes: draft.outcomes.slice(0, 1) },
      readSource: vi.fn(),
      readChange: readChangedRange,
    }),
  ).rejects.toEqual(new FactoryConceptualReviewValidationError("invalid_output"));
  await expect(
    validateFactoryConceptualReview({
      preparation,
      draft,
      readSource: vi.fn(() => Promise.resolve({ ...source, endLine: 3 })),
      readChange: readChangedRange,
    }),
  ).rejects.toEqual(new FactoryConceptualReviewValidationError("source_unavailable"));
});

it("rejects an outcome title that rewrites the approved outcome", async () => {
  await expect(
    validateFactoryConceptualReview({
      preparation,
      draft: {
        ...draft,
        outcomes: [{ ...draft.outcomes[0], title: "A broader search promise" }, draft.outcomes[1]],
      },
      readSource: vi.fn(() => Promise.resolve(source)),
      readChange: readChangedRange,
    }),
  ).rejects.toEqual(new FactoryConceptualReviewValidationError("invalid_output"));
});

it("cannot present source-only coverage as a complete review", async () => {
  await expect(
    validateFactoryConceptualReview({
      preparation,
      draft: {
        ...draft,
        result: "complete",
        outcomes: draft.outcomes.map((outcome) => ({
          ...outcome,
          coverage: outcome.coverage === "unclear" ? ("not_applicable" as const) : outcome.coverage,
          reason: "Accounted for.",
        })),
      },
      readSource: vi.fn(() => Promise.resolve(source)),
      readChange: readChangedRange,
    }),
  ).rejects.toEqual(new FactoryConceptualReviewValidationError("invalid_output"));
});

it("never derives executed-check authority from unrestricted model prose", async () => {
  const result = await validateFactoryConceptualReview({
    preparation,
    draft: {
      ...draft,
      summary: "RSpec reports 42 examples, 0 failures.",
      evidence: [
        {
          ...searchEvidence,
          sufficiency: "The unit specs returned success.",
        },
      ],
    },
    readSource: vi.fn(() => Promise.resolve(source)),
    readChange: readChangedRange,
  });

  expect(result.result).toBe("partial");
  expect(result.summary).toBe(
    "0 of 2 approved outcomes map to exact retained source; 0 problems are identified.",
  );
  expect(result.evidence[0]?.sufficiency).toBe("The unit specs returned success.");
});

it("reports a bounded diff classification limit as resource exhaustion", async () => {
  await expect(
    validateFactoryConceptualReview({
      preparation,
      draft,
      readSource: vi.fn(() => Promise.resolve(source)),
      readChange: vi.fn(() => Promise.resolve({ status: "modified" as const, rangeChanged: null })),
    }),
  ).rejects.toEqual(new FactoryConceptualReviewValidationError("resource_exhausted"));
});

it("rejects an otherwise valid graph that exhausts its frozen output budget", async () => {
  await expect(
    validateFactoryConceptualReview({
      preparation: {
        ...preparation,
        configuration: {
          ...preparation.configuration,
          resources: {
            ...preparation.configuration.resources,
            maximumOutputBytes: Buffer.byteLength(JSON.stringify(draft), "utf8") - 1,
          },
        },
      },
      draft,
      readSource: vi.fn(() => Promise.resolve(source)),
      readChange: readChangedRange,
    }),
  ).rejects.toEqual(new FactoryConceptualReviewValidationError("resource_exhausted"));
});

it("uses a provider-compatible uniform problem shape before host-side narrowing", () => {
  const modelOutput = {
    ...draft,
    evidence: draft.evidence.map((evidence) => ({
      ...evidence,
      evidenceId: null,
      relation: null,
      proposition: null,
    })),
    problems: [
      {
        id: "finding:stale",
        type: "finding" as const,
        title: "A stale result can win",
        condition: "Two requests finish out of order.",
        consequence: "The older result is returned.",
        reasoning: "The exact head returns the first request.",
        description: null,
        possibleConsequence: null,
        reasonUnverified: null,
        evidenceIds: ["source:search"],
        riskLevel: "medium" as const,
        sufficiency: "The return statement establishes the behavior.",
        limitations: [],
      },
    ],
    edges: [
      ...draft.edges,
      { from: "source:search", to: "finding:stale", kind: "reveals" as const },
    ],
  };
  expect(parseFactoryConceptualReviewModelOutput(modelOutput)).toMatchObject({
    problems: [
      {
        id: "finding:stale",
        type: "finding",
        riskLevel: "medium",
        condition: "Two requests finish out of order.",
      },
    ],
  });
  const providerSchema = JSON.stringify(
    z.toJSONSchema(FactoryConceptualReviewModelOutputSchema, { target: "draft-7" }),
  );
  expect(providerSchema).not.toContain('"oneOf"');
  expect(providerSchema).toContain('"description"');
  expect(() =>
    parseFactoryConceptualReviewModelOutput({
      ...modelOutput,
      problems: [{ ...modelOutput.problems[0], riskLevel: null }],
    }),
  ).toThrow(new FactoryConceptualReviewValidationError("invalid_output"));
});
