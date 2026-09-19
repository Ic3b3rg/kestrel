import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { factoryVerificationManifest, type FeaturePlanDocument } from "@kestrel/contracts";
import {
  assertFactoryFeaturePublicationCertificate,
  bindFactoryFeaturePullRequest,
  failFactoryFeaturePublication,
  markFactoryFeaturePublicationWrite,
  readFactoryFeaturePublication,
} from "./factory-feature-publication.js";

const id = "01991c36-7f90-7000-8000-000000000001";
const secondId = "01991c36-7f90-7000-8000-000000000002";
const command = { program: "node", args: ["--test", "w1.mjs"], cwd: ".", timeoutSeconds: 10 };
const plan: FeaturePlanDocument = {
  objective: "Keep both approved behaviors working",
  scope: { includes: ["Both behaviors"], excludes: [] },
  acceptance: [{ key: "A", outcome: "Both checks pass" }],
  workItems: ["W1", "W2"].map((key, index) => ({
    key,
    title: key,
    importedIssueId: null,
    description: key,
    requirementKeys: ["A"],
    acceptance: ["Its check passes"],
    dependsOn: index ? ["W1"] : [],
    verification: [{ ...command, args: ["--test", `${key.toLowerCase()}.mjs`] }],
  })),
  limits: { maxConcurrentProjects: 2, maxActiveFeaturesPerProject: 1, attemptTimeoutSeconds: 60 },
};
const manifest = factoryVerificationManifest(plan);
const revision = {
  baseCommitId: "a".repeat(40),
  headCommitId: "b".repeat(40),
  treeId: "c".repeat(40),
  branch: `refs/heads/kestrel/feature/${id}`,
};
const source = { repositoryId: secondId, identity: "d".repeat(64) };
const certificate = {
  id,
  featureId: id,
  approvedVersion: 1,
  runId: secondId,
  source,
  revision,
  manifest,
  manifestDigest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  evidenceIds: [id, secondId],
  createdAt: "2026-09-08T12:00:00.000Z",
};
const input = { featureId: id, version: 1, plan, source, revision, certificate };

it("blocks publication when W2 completed but broke W1 and no cumulative certificate exists", () => {
  expect(() =>
    assertFactoryFeaturePublicationCertificate({ ...input, certificate: null }),
  ).toThrow();
});

it.each([
  { revision: { ...revision, headCommitId: "e".repeat(40) } },
  { source: { ...source, identity: "e".repeat(64) } },
  { version: 2 },
  { certificate: { ...certificate, manifest: manifest.slice(1) } },
  { certificate: { ...certificate, evidenceIds: [id, id] } },
])("rejects a stale or incomplete publication certificate: %j", (change) => {
  expect(() => assertFactoryFeaturePublicationCertificate({ ...input, ...change })).toThrow();
});

it("accepts only the exact cumulative certificate and complete deterministic manifest", () => {
  expect(() => assertFactoryFeaturePublicationCertificate(input)).not.toThrow();
});

it.each(["stale", "cancelled", "unprepared", "attempted"])(
  "fences a %s publication before any provider write",
  async (boundary) => {
    const query = vi.fn((sql: string) => {
      if (sql.includes("FROM factory_features") && sql.includes("FOR UPDATE"))
        return {
          rows: [
            {
              id,
              project_id: secondId,
              state: boundary === "cancelled" ? "cancelled" : "in_review",
              approved_plan_version: 1,
            },
          ],
        };
      if (sql.includes("FROM factory_feature_pr_publications"))
        return {
          rows:
            boundary === "stale"
              ? []
              : [
                  {
                    feature_id: id,
                    plan_version: 1,
                    state: "running",
                    push_attempted: boundary === "attempted",
                    pr_attempted: false,
                  },
                ],
        };
      if (sql.includes("FROM factory_feature_pr_operations"))
        return { rows: boundary === "unprepared" ? [] : [{ id }] };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const pool = { query, connect: () => Promise.resolve(client) };
    await expect(
      markFactoryFeaturePublicationWrite(
        pool as never,
        { featureId: id, projectId: secondId, attemptId: id },
        "push",
        true,
      ),
    ).rejects.toThrow();
    expect(
      query.mock.calls.some(([sql]) => sql.startsWith("UPDATE factory_feature_pr_publications")),
    ).toBe(false);
  },
);

const repository = { id: "42", owner: "example", name: "reports" };
const payload = {
  title: "Both behaviors",
  body: "Approved Feature\n<!-- kestrel:feature-pr:exact -->",
  marker: "<!-- kestrel:feature-pr:exact -->",
  baseRef: "master",
  headRef: `kestrel/feature/${id}`,
  baseCommitId: revision.baseCommitId,
  headCommitId: revision.headCommitId,
};
const pullRequest = {
  ...payload,
  repository,
  id: "99",
  number: 8,
  nodeId: "PR_example",
  repositoryNodeId: "R_example",
  authorNodeId: "U_example",
  author: "operator",
  url: "https://github.com/example/reports/pull/8",
  state: "open" as const,
};
const operationRow = {
  id,
  feature_id: id,
  created_at: new Date(),
  target: {
    certificateId: id,
    approvalId: secondId,
    approvedVersion: 1,
    source,
    revision,
    identity: { repository, account: "operator" },
    remote: {
      repository: { owner: repository.owner, name: repository.name },
      remoteName: "origin",
      configuredUrl: "git@github.com:example/reports.git",
      configuredPushUrl: null,
      canonicalUrl: "https://github.com/example/reports",
      targetRef: "refs/heads/master",
    },
  },
  payload,
  issues: [
    {
      workItemId: secondId,
      key: "W1",
      title: "W1",
      issue: { repository, id: "5", number: 5, url: "https://github.com/example/reports/issues/5" },
    },
  ],
};

it("reads a persisted operation with database-only columns before binding its exact PR", async () => {
  const query = vi.fn((sql: string) => {
    if (sql.includes("FROM factory_features"))
      return { rows: [{ id, project_id: secondId, state: "in_review" }] };
    if (sql.includes("FROM factory_feature_pr_publications"))
      return { rows: [{ push_confirmed_at: new Date() }] };
    if (sql.includes("FROM factory_feature_pr_operations")) return { rows: [operationRow] };
    if (sql.includes("FROM factory_feature_pr_results"))
      return { rows: [{ pull_request: pullRequest }] };
    return { rows: [], rowCount: 1 };
  });
  const pool = { query, connect: () => Promise.resolve({ query, release: vi.fn() }) };
  await bindFactoryFeaturePullRequest(
    pool as never,
    { featureId: id, projectId: secondId, attemptId: id },
    pullRequest,
  );
  expect(
    query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO factory_feature_pr_results")),
  ).toBe(true);
});

it("keeps the canonical Feature review binding when the revision was acquired under a historical alias", async () => {
  const historicalId = "01991c36-7f90-7000-8000-000000000003";
  const query = vi.fn((sql: string) => {
    if (sql.includes("FROM factory_features"))
      return { rows: [{ id, project_id: secondId, state: "in_review", approved_plan_version: 1 }] };
    if (sql.includes("FROM factory_feature_pr_publications"))
      return {
        rows: [
          {
            state: "published",
            plan_version: 1,
            certificate_id: id,
            updated_at: new Date(),
            retry_after: null,
          },
        ],
      };
    if (sql.includes("FROM factory_feature_workspaces"))
      return {
        rows: [
          {
            base_commit_id: revision.baseCommitId,
            head_commit_id: revision.headCommitId,
            tree_id: revision.treeId,
            branch: revision.branch,
          },
        ],
      };
    if (sql.includes("FROM factory_feature_verifications"))
      return {
        rows: [
          {
            ...certificate,
            feature_id: id,
            plan_version: 1,
            run_id: secondId,
            manifest_digest: certificate.manifestDigest,
            evidence_ids: certificate.evidenceIds,
            created_at: new Date(certificate.createdAt),
          },
        ],
      };
    if (sql.includes("FROM factory_feature_pr_operations")) return { rows: [] };
    if (sql.includes("FROM factory_feature_pr_results"))
      return { rows: [{ pull_request: pullRequest }] };
    if (sql.includes("FROM factory_feature_pr_revisions"))
      return {
        rows: [
          {
            binding_project_id: secondId,
            binding_change_proposal_id: secondId,
            project_id: historicalId,
            change_proposal_id: historicalId,
            id,
            revision_state: "available",
            object_format: "sha1",
            base_object_id: revision.baseCommitId,
            base_ref_snapshot: "master",
            head_object_id: revision.headCommitId,
            head_ref_snapshot: payload.headRef,
            object_count: "4",
            retained_bytes: "100",
            failure_reason: null,
            created_at: new Date(),
            available_at: new Date(),
            manifest_digest: "f".repeat(64),
          },
        ],
      };
    return { rows: [], rowCount: 1 };
  });
  const pool = { query, connect: () => Promise.resolve({ query, release: vi.fn() }) };
  const view = await readFactoryFeaturePublication(pool as never, secondId, id);
  expect(view.review).toMatchObject({ projectId: secondId, changeProposalId: secondId });
});

it("persists a terminal retry-limit failure after the final admitted attempt fails", async () => {
  const query = vi.fn((sql: string) => {
    if (sql.includes("FROM factory_features") && sql.includes("FOR UPDATE"))
      return {
        rows: [
          {
            id,
            project_id: secondId,
            state: "in_review",
            approved_plan_version: 1,
          },
        ],
      };
    if (sql.includes("FROM factory_feature_pr_publications") && sql.includes("attempt_id"))
      return {
        rows: [
          {
            feature_id: id,
            plan_version: 1,
            state: "running",
            attempt_id: id,
            push_attempted: false,
            push_confirmed_at: null,
            pr_attempted: false,
          },
        ],
      };
    if (sql.includes("FROM factory_feature_pr_results")) return { rows: [] };
    if (sql.includes("count(*) FROM factory_feature_pr_retry_requests"))
      return { rows: [{ count: "200" }] };
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: () => Promise.resolve(client), query };

  await failFactoryFeaturePublication(
    pool as never,
    { featureId: id, projectId: secondId, attemptId: id },
    "unavailable",
  );

  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("UPDATE factory_feature_pr_publications SET state"),
    [id, "blocked", "retry_limit", null],
  );
});
