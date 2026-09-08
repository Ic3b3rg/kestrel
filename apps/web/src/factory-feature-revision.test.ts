import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  factoryVerificationManifest,
  type FeaturePlanDocument,
  type FactoryFeaturePublicationOperation,
  type FactoryFeaturePullRequest,
} from "@kestrel/contracts";
import * as database from "@kestrel/database";
import {
  readLocalSourceConfig,
  discoverRepositories,
  resolveRepository,
  inspectRepository,
  openFeatureWorkspace,
  snapshotFeatureWorkspace,
  checkpointFeatureWorkspace,
  readRetainedFile,
} from "@kestrel/local-source";
import { createFactoryFeatureRevisionRetainer } from "./factory-feature-revision.js";

vi.mock("@kestrel/database", async (original) => ({
  ...(await original<typeof database>()),
  upsertHostGitHubProject: vi.fn(),
  withReviewRevisionAcquisitionLease: vi.fn(),
  withArtifactAcquisitionLock: vi.fn(),
  completeReviewRevision: vi.fn(),
  failReviewRevision: vi.fn(),
  readFactoryFeaturePublicationRevisionArtifact: vi.fn(),
}));
const exec = promisify(execFile);
const roots: string[] = [];
const id = "01991c36-7f90-7000-8000-000000000001";
const projectId = "01991c36-7f90-7000-8000-000000000002";
const revisionId = "01991c36-7f90-7000-8000-000000000003";
const git = async (path: string, args: string[]) =>
  (
    await exec("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-C", path, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    })
  ).stdout.trim();
beforeEach(() => vi.resetAllMocks());
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await exec("/bin/chmod", ["-R", "u+rwX", root]);
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kestrel-feature-revision-"));
  roots.push(root);
  const checkout = join(root, "repositories", "source");
  const artifactRoot = join(root, "artifacts");
  await mkdir(checkout, { recursive: true });
  await mkdir(artifactRoot, { mode: 0o700 });
  await git(checkout, ["init", "--initial-branch=master"]);
  await git(checkout, ["config", "user.name", "Fixture"]);
  await git(checkout, ["config", "user.email", "fixture@example.test"]);
  await git(checkout, ["remote", "add", "origin", "https://github.com/example/reports.git"]);
  await writeFile(join(checkout, "report.txt"), "Approved base\n");
  await git(checkout, ["add", "report.txt"]);
  await git(checkout, ["commit", "-m", "Approved base"]);
  const baseCommitId = await git(checkout, ["rev-parse", "HEAD"]);
  const config = await readLocalSourceConfig({
    LOCAL_REPOSITORY_ROOTS: JSON.stringify([join(root, "repositories")]),
    ARTIFACT_ROOT: artifactRoot,
    LOCAL_GIT_EXECUTABLE: "/usr/bin/git",
    REVIEW_REVISION_MAX_BYTES: "1048576",
    REVIEW_REVISION_MAX_OBJECTS: "1000",
  });
  const candidate = (await discoverRepositories(config))[0];
  if (candidate === undefined) throw new Error("Fixture source is missing");
  const repository = await resolveRepository(config, candidate.repositoryId);
  const inspection = await inspectRepository(config, repository);
  const identity = {
    featureId: id,
    projectId,
    repositoryId: repository.repositoryId,
    sourceIdentity: inspection.sourceIdentity,
    baseCommitId,
    objectFormat: "sha1" as const,
    branch: `refs/heads/kestrel/feature/${id}`,
  };
  const workspace = await openFeatureWorkspace(config, identity);
  await writeFile(join(workspace.workspacePath, "report.txt"), "Certified cumulative Feature\n");
  const pending = await snapshotFeatureWorkspace(workspace, { expectedHead: baseCommitId });
  const snapshot = await checkpointFeatureWorkspace(workspace, {
    expectedHead: baseCommitId,
    expectedTree: pending.treeId,
    checkpointId: randomUUID(),
    message: "Verified Feature",
  });
  await writeFile(join(checkout, "report.txt"), "Operator dirty work\n");
  await writeFile(join(checkout, "staged.txt"), "Operator staged work\n");
  await git(checkout, ["add", "staged.txt"]);
  const before = {
    refs: await git(checkout, ["show-ref", "--head"]),
    index: await readFile(join(checkout, ".git", "index")),
  };
  const plan: FeaturePlanDocument = {
    objective: "Export the approved report",
    scope: { includes: ["CSV export"], excludes: [] },
    acceptance: [{ key: "A1", outcome: "Valid CSV" }],
    workItems: [
      {
        key: "W1",
        title: "CSV export",
        importedIssueId: null,
        description: "Export",
        requirementKeys: ["A1"],
        acceptance: ["CSV"],
        dependsOn: [],
        verification: [{ program: "node", args: ["--test"], cwd: ".", timeoutSeconds: 10 }],
      },
    ],
    limits: { maxConcurrentProjects: 2, maxActiveFeaturesPerProject: 1, attemptTimeoutSeconds: 60 },
  };
  const manifest = factoryVerificationManifest(plan);
  const revision = { baseCommitId, ...snapshot, branch: identity.branch };
  const certificate = {
    id,
    featureId: id,
    approvedVersion: 1,
    runId: revisionId,
    revision,
    source: { repositoryId: repository.repositoryId, identity: inspection.sourceIdentity },
    manifest,
    manifestDigest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    evidenceIds: [revisionId],
    createdAt: new Date().toISOString(),
  };
  const target = {
    certificateId: id,
    approvedVersion: 1,
    approvalId: revisionId,
    source: certificate.source,
    revision,
    identity: { repository: { id: "42", owner: "example", name: "reports" }, account: "operator" },
    remote: {
      repository: { owner: "example", name: "reports" },
      remoteName: "origin" as const,
      configuredUrl: "https://github.com/example/reports.git",
      configuredPushUrl: null,
      canonicalUrl: "https://github.com/example/reports",
      targetRef: "refs/heads/master",
    },
  };
  const payload = {
    title: "CSV export",
    body: `Approved Feature\n<!-- kestrel:feature-pr:${id} -->`,
    marker: `<!-- kestrel:feature-pr:${id} -->`,
    baseRef: "master",
    headRef: identity.branch.slice(11),
    baseCommitId,
    headCommitId: snapshot.headCommitId,
  };
  const operation: FactoryFeaturePublicationOperation = {
    id,
    featureId: id,
    target,
    issues: [
      {
        workItemId: projectId,
        key: "W1",
        title: "CSV export",
        issue: {
          repository: target.identity.repository,
          id: "5",
          number: 5,
          url: "https://github.com/example/reports/issues/5",
        },
      },
    ],
    payload,
  };
  const pull: FactoryFeaturePullRequest = {
    ...payload,
    repository: target.identity.repository,
    id: "99",
    number: 7,
    nodeId: "PR_example",
    repositoryNodeId: "R_example",
    authorNodeId: "U_example",
    author: "operator",
    url: "https://github.com/example/reports/pull/7",
    state: "open",
  };
  const claim: database.ClaimedFactoryFeaturePublication = {
    featureId: id,
    projectId,
    attemptId: id,
    title: "CSV export",
    version: 1,
    cancelled: false,
    plan,
    approvalId: revisionId,
    operatorId: projectId,
    certificate,
    workspace: { ...identity, ...snapshot },
    planMarkdown: "# Plan",
    specMarkdown: "# Spec",
    identity: target.identity,
    issues: operation.issues,
    operation,
    pullRequest: pull,
    pushAttempted: true,
    pushConfirmed: true,
    prAttempted: true,
  };
  const begun: database.BeginReviewRevisionResult = {
    artifactProjectId: projectId,
    projectId,
    changeProposalId: id,
    localRepositorySourceId: projectId,
    changeIntent: { text: "Historical acquisition purpose" } as never,
    maxBytes: config.maxBytes,
    maxObjects: config.maxObjects,
    outcome: "acquire",
    revision: {
      id: revisionId,
      state: "acquiring",
      objectFormat: "sha1",
      base: { objectId: baseCommitId, ref: payload.baseRef },
      head: { objectId: snapshot.headCommitId, ref: payload.headRef },
      objectCount: null,
      retainedBytes: null,
      failureReason: null,
      createdAt: new Date().toISOString(),
      availableAt: null,
    },
  };
  const pool = {} as database.DatabasePool;
  const coordinator = { upsert: vi.fn() };
  vi.mocked(database.upsertHostGitHubProject).mockResolvedValue({
    schemaVersion: 1,
    project: {
      id: projectId,
      changeProposals: [{ id, kind: "provider_observed", providerId: pull.nodeId }],
    },
  } as never);
  vi.mocked(database.withReviewRevisionAcquisitionLease).mockImplementation(
    (_pool, _input, action) => Promise.resolve(action(begun, pool)),
  );
  vi.mocked(database.withArtifactAcquisitionLock).mockImplementation((_pool, action) =>
    Promise.resolve(action(pool)),
  );
  vi.mocked(database.completeReviewRevision).mockImplementation((_pool, input) =>
    Promise.resolve({
      ...begun.revision,
      state: "available" as const,
      objectCount: input.artifact.objectCount,
      retainedBytes: input.artifact.retainedBytes,
      availableAt: new Date().toISOString(),
    }),
  );
  const retain = createFactoryFeatureRevisionRetainer({
    pool,
    readSourceConfig: () => Promise.resolve(config),
    renderingCoordinator: coordinator,
  });
  return {
    config,
    checkout,
    before,
    claim,
    operation,
    pull,
    source: { workspace, snapshot },
    begun,
    retain,
    coordinator,
  };
}

it("retains the exact private Feature head through verified Review First acquisition with actual approval provenance", async () => {
  const value = await fixture();
  const retained = await value.retain(
    value.claim,
    value.operation,
    value.pull,
    value.source,
    new AbortController().signal,
  );
  expect(retained.revision).toMatchObject({
    state: "available",
    base: { objectId: value.pull.baseCommitId },
    head: { objectId: value.pull.headCommitId },
  });
  const begun = vi.mocked(database.withReviewRevisionAcquisitionLease).mock.calls[0]?.[1];
  expect(begun).toMatchObject({
    actorId: value.claim.operatorId,
    changeIntent: value.claim.plan.objective,
    approvedFeaturePlan: {
      featureId: id,
      approvedVersion: 1,
      certificateId: id,
      approvalId: revisionId,
    },
    source: {
      repositoryId: value.claim.certificate.source.repositoryId,
      sourceIdentity: value.claim.certificate.source.identity,
    },
  });
  const observed = vi.mocked(database.upsertHostGitHubProject).mock.calls[0]?.[1];
  expect(observed).toMatchObject({
    enqueueModelRendering: false,
    observation: {
      repository: { providerId: "R_example" },
      proposal: {
        providerId: "PR_example",
        author: { providerId: "U_example", login: "operator" },
      },
    },
  });
  const completed = vi.mocked(database.completeReviewRevision).mock.calls[0]?.[1];
  if (completed === undefined) throw new Error("No retained artifact");
  expect(completed.enqueueModelRendering).toBe(false);
  expect(
    (
      await readRetainedFile(value.config, {
        artifactLocator: completed.artifact.artifactLocator,
        manifestDigest: retained.manifestDigest,
        side: "head",
        path: "report.txt",
      })
    ).toString(),
  ).toBe("Certified cumulative Feature\n");
  expect(await git(value.checkout, ["show-ref", "--head"])).toBe(value.before.refs);
  expect(await readFile(join(value.checkout, ".git", "index"))).toEqual(value.before.index);
  expect(await readFile(join(value.checkout, "report.txt"), "utf8")).toBe("Operator dirty work\n");
  expect(value.coordinator.upsert).not.toHaveBeenCalled();
}, 20_000);

it("reuses an available exact revision while preserving its historical acquisition intent", async () => {
  const value = await fixture();
  const first = await value.retain(
    value.claim,
    value.operation,
    value.pull,
    value.source,
    new AbortController().signal,
  );
  const completed = vi.mocked(database.completeReviewRevision).mock.calls[0]?.[1];
  if (completed === undefined) throw new Error("No retained artifact");
  value.begun.outcome = "already_available";
  value.begun.revision = first.revision;
  vi.mocked(database.readFactoryFeaturePublicationRevisionArtifact).mockResolvedValue({
    artifactLocator: completed.artifact.artifactLocator,
    manifestDigest: first.manifestDigest,
  });
  const again = await value.retain(
    value.claim,
    value.operation,
    value.pull,
    value.source,
    new AbortController().signal,
  );
  expect(again).toEqual(first);
  expect(database.completeReviewRevision).toHaveBeenCalledOnce();
  expect(value.begun.changeIntent).toEqual({ text: "Historical acquisition purpose" });
  expect(database.withReviewRevisionAcquisitionLease).toHaveBeenCalledTimes(2);
}, 20_000);

it("rejects a changed captured head before it can create a different review family", async () => {
  const value = await fixture();
  await expect(
    value.retain(
      value.claim,
      value.operation,
      { ...value.pull, headCommitId: "f".repeat(40) },
      value.source,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(database.upsertHostGitHubProject).not.toHaveBeenCalled();
}, 20_000);

it("keeps a finalized artifact when completion and failure persistence are both uncertain", async () => {
  const value = await fixture();
  vi.mocked(database.completeReviewRevision).mockRejectedValue(new Error("Commit response lost"));
  vi.mocked(database.failReviewRevision).mockRejectedValue(new Error("Database unavailable"));
  await expect(
    value.retain(
      value.claim,
      value.operation,
      value.pull,
      value.source,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  const completed = vi.mocked(database.completeReviewRevision).mock.calls[0]?.[1];
  if (completed === undefined) throw new Error("No retained artifact");
  expect(
    (
      await readRetainedFile(value.config, {
        artifactLocator: completed.artifact.artifactLocator,
        manifestDigest: completed.artifact.manifestDigest,
        side: "head",
        path: "report.txt",
      })
    ).toString(),
  ).toBe("Certified cumulative Feature\n");
}, 20_000);
