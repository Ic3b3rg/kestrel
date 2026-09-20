import { expect, it } from "vitest";

import type { Project } from "@kestrel/contracts";

import { buildExternalConceptualReviewPreparation } from "./external-conceptual-review.js";

const projectId = "01991c36-7f90-7000-8000-000000000001";
const proposalId = "01991c36-7f90-7000-8000-000000000002";
const intentId = "01991c36-7f90-7000-8000-000000000003";
const revisionId = "01991c36-7f90-7000-8000-000000000004";
const digest = "d".repeat(64);
const baseCommitId = "a".repeat(40);
const headCommitId = "b".repeat(40);
const headTreeId = "c".repeat(40);
const at = "2026-09-20T00:00:00.000Z";

const project: Project = {
  id: projectId,
  providerObservation: { kind: "public_github", authentication: "none", refresh: "manual" },
  repository: {
    providerId: "R_kgDOGx",
    owner: "example",
    name: "search",
    canonicalUrl: "https://github.com/example/search",
  },
  localRepositorySource: null,
  sourceAvailability: "available",
  modelAccess: "not_configured",
  createdAt: at,
  updatedAt: at,
  changeProposals: [
    {
      kind: "provider_observed",
      id: proposalId,
      version: 1,
      providerId: "91",
      number: 9,
      title: "Refresh search results",
      canonicalUrl: "https://github.com/example/search/pull/9",
      proposalState: "open",
      base: { ref: "refs/heads/master", objectId: baseCommitId },
      head: { ref: "refs/heads/contributor/refresh-search", objectId: headCommitId },
      author: { login: "contributor", providerId: "7" },
      observedAt: at,
      changeIntentCandidates: [],
      changeIntent: {
        id: intentId,
        version: 1,
        text: "Refresh search results",
        objective: "Refresh search results",
        scopeBoundaries: [],
        acceptanceOutcomes: [],
        sources: [
          {
            id: "provider_title",
            kind: "provider_field",
            label: "GitHub title",
            text: "Refresh search results",
            version: at,
            provenance: {
              kind: "provider_field",
              provider: "github",
              field: "title",
              observedAt: at,
              canonicalUrl: "https://github.com/example/search/pull/9",
            },
          },
        ],
        sourceDigest: digest,
        resolution: {
          state: "unresolved",
          issues: [
            { kind: "missing", field: "scope_boundaries" },
            { kind: "missing", field: "acceptance_outcomes" },
          ],
        },
        createdAt: at,
      },
      reviewRevisions: [
        {
          id: revisionId,
          state: "available",
          objectFormat: "sha1",
          base: { ref: "refs/heads/master", objectId: baseCommitId },
          head: { ref: "refs/heads/contributor/refresh-search", objectId: headCommitId },
          objectCount: 10,
          retainedBytes: 4096,
          failureReason: null,
          createdAt: at,
          availableAt: at,
        },
      ],
    },
  ],
};

it("prepares an existing pull request from its stated intent without claiming final checks", () => {
  const preparation = buildExternalConceptualReviewPreparation({
    project,
    changeProposalId: proposalId,
    selectedModelId: "gpt-6-astra",
    verifiedSource: { revisionId, manifestDigest: digest, headTreeId },
    runtimeProfile: {
      containerImage: `sha256:${"e".repeat(64)}`,
      containerUser: "1000:1000",
      codexExecutable: "/opt/codex/codex",
      codexExecutableDigest: "f".repeat(64),
      codexVersion: "1.2.3",
    },
  });

  expect(preparation).toMatchObject({
    projectId,
    featureId: null,
    changeProposalId: proposalId,
    readiness: { state: "ready", startAllowed: true, blockers: [] },
    basis: {
      objective: "Refresh search results",
      outcomes: [
        {
          key: "stated_intent",
          outcome: "Refresh search results",
          intent: { kind: "pull_request_stated", label: "GitHub title" },
        },
      ],
      provenance: {
        kind: "change_intent",
        changeIntentId: intentId,
        resolution: "unresolved",
      },
    },
    publication: {
      kind: "external_pull_request",
      certificate: null,
      pullRequest: {
        repository: { id: "R_kgDOGx", owner: "example", name: "search" },
        number: 9,
        headCommitId,
      },
    },
    evidence: { source: { headTreeId }, checks: null },
  });
  expect(preparation.basis?.limitations).toContain(
    "No acceptance outcomes were confirmed by the Operator.",
  );
  expect(preparation.preparationDigest).toMatch(/^[a-f0-9]{64}$/u);
});

it("keeps missing retained source and review runtime as explicit blockers", () => {
  const preparation = buildExternalConceptualReviewPreparation({
    project,
    changeProposalId: proposalId,
    selectedModelId: null,
    verifiedSource: null,
    runtimeProfile: null,
  });

  expect(preparation).toMatchObject({
    preparationDigest: null,
    publication: null,
    evidence: null,
    readiness: {
      state: "blocked",
      startAllowed: false,
      blockers: ["publication_not_ready", "model_not_selected", "review_runtime_unavailable"],
    },
  });
});

it("preserves every valid intent outcome and limitation in the review input", () => {
  const outcomes = Array.from({ length: 50 }, (_, index) => `Expected result ${String(index + 1)}`);
  const unresolved = Array.from({ length: 20 }, (_, index) => ({
    kind: "ambiguous" as const,
    description: `Open question ${String(index + 1)}`,
  }));
  const proposal = project.changeProposals[0];
  if (proposal?.kind !== "provider_observed" || proposal.changeIntent === null) {
    throw new Error("External pull request fixture is unavailable");
  }
  const preparation = buildExternalConceptualReviewPreparation({
    project: {
      ...project,
      changeProposals: [
        {
          ...proposal,
          changeIntent: {
            ...proposal.changeIntent,
            acceptanceOutcomes: outcomes,
            resolution: { state: "unresolved", issues: unresolved },
            scopeBoundaries: ["The exact pull request change"],
          },
        },
      ],
    },
    changeProposalId: proposalId,
    selectedModelId: "gpt-6-astra",
    verifiedSource: { revisionId, manifestDigest: digest, headTreeId },
    runtimeProfile: {
      containerImage: `sha256:${"e".repeat(64)}`,
      containerUser: "1000:1000",
      codexExecutable: "/opt/codex/codex",
      codexExecutableDigest: "f".repeat(64),
      codexVersion: "1.2.3",
    },
  });

  expect(preparation.basis?.outcomes).toHaveLength(50);
  expect(preparation.basis?.limitations).toHaveLength(21);
});
