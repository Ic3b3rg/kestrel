import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";

import type { FeaturePlanDocument } from "@kestrel/contracts";
import {
  FactoryConceptualReviewPersistenceError,
  readFactoryConceptualReviewCheck,
  readFactoryConceptualReviewChecks,
  readFactoryConceptualReviewPreparation,
  readFactoryConceptualReviewSourceBinding,
} from "./factory-conceptual-review.js";

const projectId = "01991c36-7f90-7000-8000-000000000001";
const featureId = "01991c36-7f90-7000-8000-000000000002";
const revisionId = "01991c36-7f90-7000-8000-000000000003";
const certificateId = "01991c36-7f90-7000-8000-000000000004";
const runId = "01991c36-7f90-7000-8000-000000000005";
const evidenceId = "01991c36-7f90-7000-8000-000000000006";
const proposalId = "01991c36-7f90-7000-8000-000000000007";
const baseCommitId = "a".repeat(40);
const headCommitId = "b".repeat(40);
const treeId = "c".repeat(40);
const sourceIdentity = "d".repeat(64);
const retainedManifestDigest = "e".repeat(64);
const at = new Date("2026-09-19T12:00:00.000Z");
const command = { program: "npm", args: ["test"], cwd: ".", timeoutSeconds: 60 };
const plan: FeaturePlanDocument = {
  objective: "Keep search results current",
  scope: { includes: ["Refresh results"], excludes: ["Change ranking"] },
  acceptance: [{ key: "refresh", outcome: "New results appear" }],
  workItems: [
    {
      key: "search",
      importedIssueId: null,
      title: "Refresh search",
      description: "Refresh the result list",
      requirementKeys: ["refresh"],
      acceptance: ["The new result appears"],
      dependsOn: [],
      verification: [command],
    },
  ],
  limits: { maxConcurrentProjects: 2, maxActiveFeaturesPerProject: 1, attemptTimeoutSeconds: 60 },
};
const manifest = [{ position: 1, command, origins: [{ workItemKey: "search", position: 1 }] }];
const manifestDigest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
const revision = {
  baseCommitId,
  headCommitId,
  treeId,
  branch: `refs/heads/kestrel/feature/${featureId}`,
};
const certificate = {
  id: certificateId,
  featureId,
  approvedVersion: 2,
  runId,
  source: { repositoryId: projectId, identity: sourceIdentity },
  revision,
  manifest,
  manifestDigest,
  evidenceIds: [evidenceId],
  createdAt: at.toISOString(),
};
const repository = { id: "42", owner: "example", name: "search" };
const pullRequest = {
  repository,
  id: "9",
  nodeId: "PR_example",
  repositoryNodeId: "R_example",
  authorNodeId: "U_example",
  author: "operator",
  number: 9,
  url: "https://github.com/example/search/pull/9",
  state: "open" as const,
  title: "Refresh search results",
  body: "Approved Feature\n<!-- exact -->",
  marker: "<!-- exact -->",
  baseRef: "master",
  headRef: `kestrel/feature/${featureId}`,
  baseCommitId,
  headCommitId,
};
const result = {
  round: 1,
  position: 1,
  command,
  headCommitId,
  treeId,
  outcome: "passed" as const,
  exitCode: 0,
  stdout: "ok\n",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 123,
};
const row = {
  feature_id: featureId,
  project_id: projectId,
  approved_plan_version: 2,
  plan_version_id: revisionId,
  plan_version: 2,
  plan_document: plan,
  plan_author: "assistant",
  approval_id: revisionId,
  approval_operator_id: projectId,
  approved_at: at,
  publication_state: "published",
  publication_plan_version: 2,
  publication_certificate_id: certificateId,
  certificate,
  operation_target: {
    certificateId,
    approvedVersion: 2,
    approvalId: revisionId,
    source: certificate.source,
    revision,
    identity: { repository, account: "operator" },
    remote: {
      repository: { owner: "example", name: "search" },
      remoteName: "origin",
      configuredUrl: "git@github.com:example/search.git",
      configuredPushUrl: null,
      canonicalUrl: "https://github.com/example/search",
      targetRef: "refs/heads/master",
    },
  },
  operation_payload: {
    title: pullRequest.title,
    body: pullRequest.body,
    marker: pullRequest.marker,
    baseRef: pullRequest.baseRef,
    headRef: pullRequest.headRef,
    baseCommitId,
    headCommitId,
  },
  pull_request: pullRequest,
  binding_project_id: projectId,
  binding_change_proposal_id: proposalId,
  revision_id: revisionId,
  revision_project_id: projectId,
  revision_state: "available",
  object_format: "sha1",
  base_ref_snapshot: "master",
  base_object_id: baseCommitId,
  head_ref_snapshot: `kestrel/feature/${featureId}`,
  head_object_id: headCommitId,
  object_count: "5",
  retained_bytes: "1024",
  artifact_locator: `projects/${projectId}/revisions/${revisionId}`,
  retained_manifest_digest: retainedManifestDigest,
  revision_created_at: at,
  available_at: at,
  canonical_revision_project_id: projectId,
  canonical_binding_project_id: projectId,
  canonical_binding_proposal_id: proposalId,
  revision_change_proposal_id: proposalId,
  canonical_revision_proposal_project_id: projectId,
  canonical_revision_proposal_id: proposalId,
  revision_source_repository_id: projectId,
  revision_source_identity: sourceIdentity,
  selected_model_id: "gpt-6-astra",
};

function pool(overrides: Partial<typeof row> = {}, evidence = result) {
  const query = vi.fn((sql: string) => {
    if (sql.includes("FROM factory_features AS feature"))
      return { rows: [{ ...row, ...overrides }] };
    if (sql.includes("FROM unnest($2::uuid[])"))
      return { rows: [{ id: evidenceId, run_id: runId, result: evidence, created_at: at }] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { query };
}

it("prepares the exact published Feature while making the missing review runtime explicit", async () => {
  const database = pool();
  const preparation = await readFactoryConceptualReviewPreparation(
    database as never,
    projectId,
    featureId,
    { profile: null },
  );
  expect(preparation.basis?.objective).toBe(plan.objective);
  expect(preparation.publication?.pullRequest.url).toBe(pullRequest.url);
  expect(preparation.publication?.revision.id).toBe(revisionId);
  expect(preparation.evidence?.checks.total).toBe(1);
  expect(preparation.configuration.resources).toMatchObject({
    maximumOutputBytes: 128 * 1024,
    maximumWorkspaceFiles: 20_000,
    maximumWorkspaceBytes: 256 * 1024 * 1024,
  });
  expect(preparation.preparationDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(preparation.readiness).toEqual({
    state: "blocked",
    startAllowed: false,
    blockers: ["review_runtime_unavailable"],
  });
});

it("freezes the immutable runtime profile and changes the preparation identity when it changes", async () => {
  const profile = {
    containerImage: `sha256:${"1".repeat(64)}`,
    containerUser: "501:20",
    codexExecutable: "/usr/local/bin/codex",
    codexExecutableDigest: "e".repeat(64),
    codexVersion: "0.155.1",
  };
  const first = await readFactoryConceptualReviewPreparation(
    pool() as never,
    projectId,
    featureId,
    { profile },
  );
  const changed = await readFactoryConceptualReviewPreparation(
    pool() as never,
    projectId,
    featureId,
    {
      profile: { ...profile, containerImage: `sha256:${"2".repeat(64)}` },
    },
  );

  expect(first.readiness).toEqual({ state: "ready", startAllowed: true, blockers: [] });
  expect(first.configuration.runtimePolicy).toMatchObject(profile);
  expect(first.preparationDigest).not.toBe(changed.preparationDigest);
});

it("never substitutes stale check evidence for the final certificate", async () => {
  const preparation = await readFactoryConceptualReviewPreparation(
    pool({}, { ...result, headCommitId: "f".repeat(40) }) as never,
    projectId,
    featureId,
    { profile: null },
  );
  expect(preparation.preparationDigest).toBeNull();
  expect(preparation.publication).toBeNull();
  expect(preparation.readiness.blockers).toContain("certificate_mismatch");
});

it.each([
  ["a different approved plan", { publication_plan_version: 1 }, "approved_plan_mismatch"],
  [
    "a foreign retained source",
    { revision_source_identity: "f".repeat(64) },
    "exact_revision_mismatch",
  ],
  [
    "an aliased Project binding",
    { canonical_revision_project_id: featureId },
    "exact_revision_mismatch",
  ],
  [
    "a retained revision from another canonical proposal",
    {
      revision_change_proposal_id: featureId,
      canonical_revision_proposal_id: featureId,
    },
    "exact_revision_mismatch",
  ],
  [
    "a retained revision proposal from another canonical Project",
    { canonical_revision_proposal_project_id: featureId },
    "exact_revision_mismatch",
  ],
  [
    "a pull request from another repository",
    {
      pull_request: {
        ...pullRequest,
        repository: { id: "99", owner: "foreign", name: "search" },
      },
    },
    "certificate_mismatch",
  ],
  [
    "a pull request from another account",
    { pull_request: { ...pullRequest, author: "intruder" } },
    "certificate_mismatch",
  ],
  [
    "a different manifest digest",
    { certificate: { ...certificate, manifestDigest: "f".repeat(64) } },
    "certificate_mismatch",
  ],
  [
    "a different certified tree",
    {
      certificate: {
        ...certificate,
        revision: { ...certificate.revision, treeId: "f".repeat(40) },
      },
    },
    "exact_revision_mismatch",
  ],
] as const)(
  "blocks %s rather than preparing mutable substitutes",
  async (_name, change, blocker) => {
    const preparation = await readFactoryConceptualReviewPreparation(
      pool(change) as never,
      projectId,
      featureId,
      { profile: null },
    );
    expect(preparation.preparationDigest).toBeNull();
    expect(preparation.readiness.blockers).toContain(blocker);
  },
);

it("rejects a Feature outside the canonical Project scope", async () => {
  const query = vi.fn(() => ({ rows: [] }));
  await expect(
    readFactoryConceptualReviewPreparation({ query } as never, projectId, featureId, {
      profile: null,
    }),
  ).rejects.toEqual(new FactoryConceptualReviewPersistenceError("not_found"));
});

it("resolves a server-only retained source binding without exposing it in preparation", async () => {
  const binding = await readFactoryConceptualReviewSourceBinding(
    pool() as never,
    projectId,
    featureId,
    "head",
  );
  expect(binding).toEqual({
    artifactLocator: `projects/${projectId}/revisions/${revisionId}`,
    manifestDigest: retainedManifestDigest,
    expectedBaseCommitId: baseCommitId,
    expectedHeadCommitId: headCommitId,
    expectedHeadTreeId: treeId,
    side: "head",
  });
});

it("pages check metadata and resolves one exact command result", async () => {
  const database = pool();
  const catalog = await readFactoryConceptualReviewChecks(
    database as never,
    projectId,
    featureId,
    0,
    100,
  );
  expect(catalog.checks).toHaveLength(1);
  expect(catalog.checks[0]).toMatchObject({ evidenceId, outcome: "passed", command });
  const check = await readFactoryConceptualReviewCheck(
    database as never,
    projectId,
    featureId,
    evidenceId,
  );
  expect(check.result.stdout).toBe("ok\n");
  expect(check.origins).toEqual(manifest[0]?.origins);
});
