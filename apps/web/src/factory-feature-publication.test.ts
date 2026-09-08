import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import {
  factoryVerificationManifest,
  type FeaturePlanDocument,
  type FactoryFeaturePullRequestPayload,
} from "@kestrel/contracts";
import * as database from "@kestrel/database";
import * as source from "@kestrel/local-source";
import { createFactoryFeaturePublicationProcessor } from "./factory-feature-publication.js";
import type { FactoryGitHubIdentity } from "./factory-github.js";

vi.mock("@kestrel/database", async (original) => ({
  ...(await original<typeof database>()),
  claimFactoryFeaturePublication: vi.fn(),
  prepareFactoryFeaturePublicationOperation: vi.fn(),
  markFactoryFeaturePublicationWrite: vi.fn(),
  confirmFactoryFeaturePublicationPush: vi.fn(),
  bindFactoryFeaturePullRequest: vi.fn(),
  bindFactoryFeaturePublicationRevision: vi.fn(),
  failFactoryFeaturePublication: vi.fn(),
  isFactoryFeaturePublicationRunning: vi.fn(),
}));
vi.mock("@kestrel/local-source", async (original) => ({
  ...(await original<typeof source>()),
  openFeatureWorkspace: vi.fn(),
  assertFeatureWorkspaceSnapshot: vi.fn(),
}));

const id = "01991c36-7f90-7000-8000-000000000001";
const projectId = "01991c36-7f90-7000-8000-000000000002";
const plan: FeaturePlanDocument = {
  objective: "Export the approved report",
  scope: { includes: ["CSV export"], excludes: ["Import"] },
  acceptance: [{ key: "A1", outcome: "CSV is valid" }],
  workItems: [
    {
      key: "W1",
      title: "Export CSV",
      importedIssueId: null,
      description: "Export",
      requirementKeys: ["A1"],
      acceptance: ["Valid CSV"],
      dependsOn: [],
      verification: [{ program: "node", args: ["--test"], cwd: ".", timeoutSeconds: 10 }],
    },
  ],
  limits: { maxConcurrentProjects: 2, maxActiveFeaturesPerProject: 1, attemptTimeoutSeconds: 60 },
};
const identity = {
  repository: { id: "42", owner: "example", name: "reports" },
  account: "operator",
};
const revision = {
  baseCommitId: "a".repeat(40),
  headCommitId: "b".repeat(40),
  treeId: "c".repeat(40),
  branch: `refs/heads/kestrel/feature/${id}`,
};
const manifest = factoryVerificationManifest(plan);
const certificate = {
  id,
  featureId: id,
  approvedVersion: 1,
  runId: projectId,
  source: { repositoryId: projectId, identity: "d".repeat(64) },
  revision,
  manifest,
  manifestDigest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  evidenceIds: [projectId],
  createdAt: new Date().toISOString(),
};
const issues = [
  {
    workItemId: projectId,
    key: "W1",
    title: "Export CSV",
    issue: {
      repository: identity.repository,
      id: "10",
      number: 10,
      url: "https://github.com/example/reports/issues/10",
    },
  },
];
const workspace = {
  featureId: id,
  projectId,
  repositoryId: projectId,
  sourceIdentity: certificate.source.identity,
  ...revision,
  objectFormat: "sha1" as const,
};
const remote = {
  repository: { owner: "example", name: "reports" },
  remoteName: "origin" as const,
  configuredUrl: "git@github.com:example/reports.git",
  configuredPushUrl: null,
  canonicalUrl: "https://github.com/example/reports",
  targetRef: "refs/heads/master",
};
const payload = {
  title: "Export reports",
  body: `Approved report\n<!-- kestrel:feature-pr:${id} -->`,
  marker: `<!-- kestrel:feature-pr:${id} -->`,
  baseRef: "master",
  headRef: `kestrel/feature/${id}`,
  baseCommitId: revision.baseCommitId,
  headCommitId: revision.headCommitId,
};
const operation = {
  id,
  featureId: id,
  target: {
    certificateId: id,
    approvalId: projectId,
    approvedVersion: 1,
    source: certificate.source,
    revision,
    identity,
    remote,
  },
  issues,
  payload,
};
const pull = {
  ...payload,
  repository: identity.repository,
  id: "99",
  number: 7,
  nodeId: "PR_example",
  repositoryNodeId: "R_example",
  authorNodeId: "U_example",
  author: "operator",
  url: "https://github.com/example/reports/pull/7",
  state: "open" as const,
};
const review = {
  projectId,
  changeProposalId: id,
  revision: {
    id,
    state: "available" as const,
    objectFormat: "sha1" as const,
    base: { objectId: revision.baseCommitId, ref: "master" },
    head: { objectId: revision.headCommitId, ref: payload.headRef },
    objectCount: 4,
    retainedBytes: 100,
    failureReason: null,
    createdAt: new Date().toISOString(),
    availableAt: new Date().toISOString(),
  },
  manifestDigest: "f".repeat(64),
};

function setup(change: Partial<database.ClaimedFactoryFeaturePublication> = {}) {
  const claim: database.ClaimedFactoryFeaturePublication = {
    featureId: id,
    projectId,
    attemptId: id,
    title: "Export reports",
    version: 1,
    cancelled: false,
    plan,
    approvalId: projectId,
    operatorId: projectId,
    certificate,
    workspace,
    planMarkdown: "# Approved plan",
    specMarkdown: "# Approved spec",
    identity,
    issues,
    operation,
    pullRequest: null,
    pushAttempted: false,
    pushConfirmed: false,
    prAttempted: false,
    ...change,
  };
  vi.mocked(database.claimFactoryFeaturePublication).mockResolvedValue(claim);
  vi.mocked(database.prepareFactoryFeaturePublicationOperation).mockImplementation(
    (_pool, _claim, input) => Promise.resolve(input),
  );
  vi.mocked(database.isFactoryFeaturePublicationRunning).mockResolvedValue(true);
  vi.mocked(source.openFeatureWorkspace).mockResolvedValue({
    identity: workspace,
    workspacePath: "/private/feature",
    gitDirectory: "/private/repository.git",
    shallowBaseCommitId: revision.baseCommitId,
  });
  const github = {
    identify: vi.fn(() => Promise.resolve(identity)),
    readTargetBranch: vi.fn(() => Promise.resolve("master")),
    readPullRequest: vi.fn(() => Promise.resolve(pull)),
    findPullRequest: vi.fn(() => Promise.resolve({ state: "found" as const, value: pull })),
    createPullRequest: vi.fn(
      (_identity: FactoryGitHubIdentity, input: FactoryFeaturePullRequestPayload) =>
        Promise.resolve({
          state: "confirmed" as const,
          value: { ...pull, ...input },
        }),
    ),
  };
  let remoteHead: string | null = null;
  const git = {
    identifyRemote: vi.fn(() => Promise.resolve(remote)),
    readRefs: vi.fn(() =>
      Promise.resolve({ targetHead: revision.baseCommitId, featureHead: remoteHead }),
    ),
    push: vi.fn(() => {
      remoteHead = revision.headCommitId;
      return Promise.resolve({
        state: "confirmed" as const,
        value: { headCommitId: revision.headCommitId, ref: revision.branch },
      });
    }),
  };
  const retain = vi.fn(() => Promise.resolve(review));
  const pool = {} as database.DatabasePool;
  const processor = createFactoryFeaturePublicationProcessor({
    pool,
    github,
    git,
    retain,
    readSourceConfig: () => Promise.resolve({} as source.LocalSourceConfig),
  });
  return { claim, github, git, retain, processor, pool };
}
beforeEach(() => vi.resetAllMocks());

it("persists the complete original operation and attempt before each provider write", async () => {
  const { processor, git, github, retain } = setup({ operation: null });
  await processor.process({ featureId: id });
  expect(database.prepareFactoryFeaturePublicationOperation).toHaveBeenCalledOnce();
  const prepared = vi.mocked(database.prepareFactoryFeaturePublicationOperation).mock.calls[0]?.[2];
  expect(prepared).toMatchObject({
    target: {
      approvalId: projectId,
      certificateId: id,
      source: certificate.source,
      revision,
      identity,
      remote,
    },
    issues,
  });
  expect(prepared?.payload.body).toContain(issues[0]?.issue.url);
  expect(prepared?.payload.body).toContain(certificate.manifestDigest);
  expect(
    vi.mocked(database.prepareFactoryFeaturePublicationOperation).mock.invocationCallOrder[0],
  ).toBeLessThan(
    Number(vi.mocked(database.markFactoryFeaturePublicationWrite).mock.invocationCallOrder[0]),
  );
  expect(
    vi.mocked(database.markFactoryFeaturePublicationWrite).mock.invocationCallOrder[0],
  ).toBeLessThan(Number(git.push.mock.invocationCallOrder[0]));
  expect(
    vi.mocked(database.markFactoryFeaturePublicationWrite).mock.invocationCallOrder[1],
  ).toBeLessThan(Number(github.createPullRequest.mock.invocationCallOrder[0]));
  expect(retain).toHaveBeenCalledOnce();
  expect(database.bindFactoryFeaturePublicationRevision).toHaveBeenCalledOnce();
});

it("keeps a missing ref uncertain after an attempted push and never pushes again", async () => {
  const { processor, git, github } = setup({ pushAttempted: true });
  await processor.process({ featureId: id });
  expect(git.readRefs).toHaveBeenCalledOnce();
  expect(git.push).not.toHaveBeenCalled();
  expect(github.createPullRequest).not.toHaveBeenCalled();
  expect(database.failFactoryFeaturePublication).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    "uncertain_write",
    undefined,
  );
});

it("reconciles the exact pushed head before continuing to the one PR", async () => {
  const { processor, git, github } = setup({ pushAttempted: true });
  git.readRefs.mockResolvedValue({
    targetHead: revision.baseCommitId,
    featureHead: revision.headCommitId,
  });
  await processor.process({ featureId: id });
  expect(database.confirmFactoryFeaturePublicationPush).toHaveBeenCalledOnce();
  expect(git.push).not.toHaveBeenCalled();
  expect(github.createPullRequest).toHaveBeenCalledOnce();
  expect(github.readTargetBranch).not.toHaveBeenCalled();
});

it.each(["missing", "limited", "ambiguous"] as const)(
  "never POSTs again after an uncertain PR with %s reconciliation",
  async (state) => {
    const { processor, github, retain } = setup({ pushConfirmed: true, prAttempted: true });
    github.findPullRequest.mockResolvedValue({ state } as never);
    await processor.process({ featureId: id });
    expect(github.findPullRequest).toHaveBeenCalledWith(identity, payload, expect.any(AbortSignal));
    expect(github.createPullRequest).not.toHaveBeenCalled();
    expect(retain).not.toHaveBeenCalled();
    expect(database.failFactoryFeaturePublication).toHaveBeenCalled();
  },
);

it("retains the captured PR pair on retry without substituting mutable provider refs", async () => {
  const { processor, github, git, retain } = setup({
    pushConfirmed: true,
    prAttempted: true,
    pullRequest: pull,
  });
  await processor.process({ featureId: id });
  expect(github.readPullRequest).not.toHaveBeenCalled();
  expect(github.createPullRequest).not.toHaveBeenCalled();
  expect(git.readRefs).not.toHaveBeenCalled();
  expect(retain).toHaveBeenCalledWith(
    expect.objectContaining({ certificate }),
    operation,
    pull,
    expect.anything(),
    expect.any(AbortSignal),
  );
});

it("allows cancellation to reconcile an existing PR without authorizing another provider write", async () => {
  const { processor, github, git, retain } = setup({
    cancelled: true,
    pushConfirmed: true,
    prAttempted: true,
  });
  await processor.process({ featureId: id });
  expect(github.findPullRequest).toHaveBeenCalledOnce();
  expect(github.createPullRequest).not.toHaveBeenCalled();
  expect(git.push).not.toHaveBeenCalled();
  expect(retain).toHaveBeenCalledOnce();
});

it("blocks a moved target before the initial push", async () => {
  const { processor, github, git } = setup({ operation: null });
  git.readRefs.mockResolvedValue({ targetHead: "f".repeat(40), featureHead: null });
  await processor.process({ featureId: id });
  expect(git.push).not.toHaveBeenCalled();
  expect(github.createPullRequest).not.toHaveBeenCalled();
  expect(database.failFactoryFeaturePublication).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    "target_changed",
    undefined,
  );
});

it("does not clear the attempted flag when a started push returns an uncertain result", async () => {
  const { processor, git } = setup();
  git.push.mockResolvedValue({ state: "uncertain", failure: "timeout" } as never);
  await processor.process({ featureId: id });
  expect(database.markFactoryFeaturePublicationWrite).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.anything(),
    "push",
    true,
  );
  expect(database.failFactoryFeaturePublication).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    "uncertain_write",
    undefined,
  );
});
