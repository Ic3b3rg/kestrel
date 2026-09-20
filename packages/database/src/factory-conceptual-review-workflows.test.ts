import { expect, it, vi } from "vitest";

import type {
  ExternalConceptualReviewPreparation,
  FactoryConceptualReviewDraft,
  FactoryFeatureConceptualReviewPreparation,
} from "@kestrel/contracts";

import {
  FactoryConceptualReviewWorkflowPersistenceError,
  claimFactoryConceptualReviewWorkflow,
  failFactoryConceptualReviewWorkflow,
  heartbeatFactoryConceptualReviewWorkflow,
  identifyFactoryConceptualReviewContainer,
  observeFactoryConceptualReviewHead,
  publishFactoryConceptualReview,
  readFactoryConceptualReviewArtifact,
  readFactoryConceptualReviewHistory,
  readCurrentFactoryConceptualReviewWorkflow,
  reconcileFactoryConceptualReviewWorkflows,
  recordFactoryConceptualReviewSession,
  reserveFactoryConceptualReviewContainer,
  stopFactoryConceptualReviewContainer,
  startFactoryConceptualReviewWorkflow,
  startExternalConceptualReviewWorkflow,
} from "./factory-conceptual-review-workflows.js";

const projectId = "01991c36-7f90-7000-8000-000000000001";
const featureId = "01991c36-7f90-7000-8000-000000000002";
const proposalId = "01991c36-7f90-7000-8000-000000000003";
const revisionId = "01991c36-7f90-7000-8000-000000000004";
const workflowId = "01991c36-7f90-7000-8000-000000000005";
const artifactId = "01991c36-7f90-7000-8000-000000000006";
const actorId = "01991c36-7f90-7000-8000-000000000007";
const baseCommitId = "a".repeat(40);
const headCommitId = "b".repeat(40);
const treeId = "c".repeat(40);
const digest = "d".repeat(64);
const at = new Date("2026-09-19T12:00:00.000Z");
const requestId = "65cc9964-10c2-49d1-86c4-8f13f5019e86";
const command = { program: "npm", args: ["test"], cwd: ".", timeoutSeconds: 60 };

const preparation: FactoryFeatureConceptualReviewPreparation = {
  schemaVersion: 1,
  projectId,
  featureId,
  changeProposalId: proposalId,
  preparationDigest: digest,
  basis: {
    objective: "Refresh search",
    scope: { includes: ["Refresh results"], excludes: [] },
    outcomes: [
      {
        key: "refresh",
        outcome: "New results appear",
        intent: { kind: "approved_feature_plan", label: "Approved Feature plan · version 1" },
      },
    ],
    provenance: {
      planVersionId: revisionId,
      version: 1,
      author: "operator",
      approvalId: revisionId,
      approvedByOperatorId: actorId,
      approvedAt: at.toISOString(),
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
      title: "Refresh search",
      body: "Approved Feature\n<!-- exact -->",
      marker: "<!-- exact -->",
      baseRef: "master",
      headRef: "kestrel/search",
      baseCommitId,
      headCommitId,
    },
    revision: {
      id: revisionId,
      state: "available",
      objectFormat: "sha1",
      base: { objectId: baseCommitId, ref: "master" },
      head: { objectId: headCommitId, ref: "kestrel/search" },
      objectCount: 4,
      retainedBytes: 100,
      failureReason: null,
      createdAt: at.toISOString(),
      availableAt: at.toISOString(),
    },
    retainedManifestDigest: digest,
    certificate: {
      id: revisionId,
      featureId,
      approvedVersion: 1,
      runId: featureId,
      source: { repositoryId: projectId, identity: digest },
      revision: { baseCommitId, headCommitId, treeId, branch: "refs/heads/kestrel/search" },
      manifest: [{ position: 1, command, origins: [{ workItemKey: "search", position: 1 }] }],
      manifestDigest: digest,
      evidenceIds: [revisionId],
      createdAt: at.toISOString(),
    },
  },
  evidence: {
    source: {
      baseCommitId,
      headCommitId,
      retainedManifestDigest: digest,
      limits: { catalogPageEntries: 200, fileBytes: 524288, lineRange: 200, responseBytes: 32768 },
    },
    checks: {
      runId: featureId,
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
      containerImage: `sha256:${"1".repeat(64)}`,
      containerUser: "501:20",
      codexExecutable: "/usr/local/bin/codex",
      codexExecutableDigest: "e".repeat(64),
      codexVersion: "0.155.1",
      codexProtocol: "app_server_v2",
      sourceAccess: "retained_read_only",
      networkAccess: false,
      writeAccess: false,
      status: "available",
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
  readiness: { state: "ready", startAllowed: true, blockers: [] },
};

if (preparation.publication === null || preparation.evidence === null) {
  throw new Error("Factory review preparation fixture is incomplete");
}
const factoryPublication = preparation.publication;
const factoryEvidence = preparation.evidence;

const externalPreparation: ExternalConceptualReviewPreparation = {
  ...preparation,
  featureId: null,
  changeProposalId: proposalId,
  basis: {
    objective: "Refresh search",
    scope: { includes: ["The exact pull request change"], excludes: [] },
    outcomes: [
      {
        key: "stated_intent",
        outcome: "Refresh search",
        intent: { kind: "pull_request_stated", label: "GitHub title" },
      },
    ],
    provenance: {
      kind: "change_intent",
      changeIntentId: revisionId,
      version: 1,
      sourceDigest: digest,
      resolution: "unresolved",
      sources: [{ kind: "pull_request_stated", label: "GitHub title" }],
    },
    limitations: ["No acceptance outcomes were confirmed by the Operator."],
  },
  publication: {
    kind: "external_pull_request",
    pullRequest: {
      repository: { id: "42", owner: "example", name: "search" },
      author: "contributor",
      number: 9,
      url: "https://github.com/example/search/pull/9",
      state: "open",
      title: "Refresh search",
      body: null,
      baseRef: "refs/heads/master",
      headRef: "refs/heads/contributor/search",
      baseCommitId,
      headCommitId,
    },
    revision: factoryPublication.revision,
    retainedManifestDigest: digest,
    certificate: null,
  },
  evidence: {
    source: {
      ...factoryEvidence.source,
      headTreeId: treeId,
    },
    checks: null,
  },
};

const draft: FactoryConceptualReviewDraft = {
  result: "partial",
  summary: "The approved refresh is implemented.",
  outcomes: [
    {
      id: "outcome:refresh",
      outcomeKey: "refresh",
      title: "New results appear",
      coverage: "mapped",
      behavioralStepIds: ["step:refresh"],
      reason: "The source implements the outcome.",
    },
  ],
  behavioralSteps: [
    {
      id: "step:refresh",
      title: "Refresh results",
      description: "The exact head refreshes the result list.",
      change: "modified",
      outcomeKeys: ["refresh"],
      evidenceIds: ["source:refresh"],
    },
  ],
  evidence: [
    {
      id: "source:refresh",
      type: "source",
      side: "head",
      path: "src/search.ts",
      startLine: 1,
      endLine: 4,
      description: "The refresh implementation.",
      sufficiency: "Shows the implemented behavior.",
      limitations: [],
    },
  ],
  problems: [],
  edges: [
    { from: "outcome:refresh", to: "step:refresh", kind: "implemented_by" },
    { from: "step:refresh", to: "source:refresh", kind: "supported_by" },
  ],
  limitations: ["Browser interaction was not observed."],
};

function startPool(existing: unknown[] = [], insertError?: Error, unresolvedEnvironment = false) {
  const query = vi.fn((sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    if (sql.includes("set_config('lock_timeout'")) return { rowCount: 1, rows: [{}] };
    if (sql.includes("FOR UPDATE OF feature"))
      return {
        rowCount: 1,
        rows: [
          {
            project_id: projectId,
            change_proposal_id: proposalId,
            change_intent_id: revisionId,
            review_revision_id: revisionId,
          },
        ],
      };
    if (sql.includes("request_id = $2")) return { rowCount: existing.length, rows: existing };
    if (sql.includes("failure_code = 'stop_unconfirmed'"))
      return {
        rowCount: unresolvedEnvironment ? 1 : 0,
        rows: unresolvedEnvironment ? [{ present: 1 }] : [],
      };
    if (sql.includes("INSERT INTO review_workflows")) {
      if (insertError !== undefined) throw insertError;
      return { rowCount: 1, rows: [{ id: workflowId, requested_at: at }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { pool: { connect: vi.fn(() => ({ query, release: vi.fn() })) }, query };
}

it("atomically accepts and durably queues one explicit review request", async () => {
  const { pool, query } = startPool();
  const boss = { send: vi.fn(() => Promise.resolve(workflowId)) };
  const prepare = vi.fn(() => Promise.resolve(preparation));
  const accepted = await startFactoryConceptualReviewWorkflow(
    pool as never,
    boss,
    {
      actorId,
      correlationId: requestId,
      projectId,
      featureId,
      command: { requestId, preparationDigest: digest },
    },
    prepare,
  );
  expect(accepted).toMatchObject({
    workflow: {
      id: workflowId,
      requestId,
      state: "queued",
      inputDigest: digest,
      attempt: { current: 0, maximum: 3 },
    },
    artifact: null,
    currency: "unknown",
  });
  expect(prepare).toHaveBeenCalledOnce();
  expect(boss.send).toHaveBeenCalledWith(
    "factory-conceptual-review-v1",
    { workflowId },
    expect.objectContaining({ id: workflowId }),
  );
  expect(query.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
});

it("starts the same durable review engine for an existing pull request without a Feature", async () => {
  const query = vi.fn((sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    if (sql.includes("set_config('lock_timeout'")) return { rowCount: 1, rows: [{}] };
    if (sql.includes("FOR UPDATE OF project, proposal")) {
      return {
        rowCount: 1,
        rows: [
          {
            project_id: projectId,
            change_proposal_id: proposalId,
            change_intent_id: revisionId,
            review_revision_id: revisionId,
          },
        ],
      };
    }
    if (sql.includes("feature_id IS NULL") && sql.includes("request_id = $2")) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes("failure_code = 'stop_unconfirmed'")) return { rowCount: 0, rows: [] };
    if (sql.includes("INSERT INTO review_workflows")) {
      return { rowCount: 1, rows: [{ id: workflowId, requested_at: at }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const boss = { send: vi.fn(() => Promise.resolve(workflowId)) };
  const accepted = await startExternalConceptualReviewWorkflow(
    { connect: vi.fn(() => ({ query, release: vi.fn() })) } as never,
    boss,
    {
      actorId,
      correlationId: requestId,
      projectId,
      changeProposalId: proposalId,
      command: { requestId, preparationDigest: digest },
    },
    vi.fn(() => Promise.resolve(externalPreparation)),
  );

  expect(accepted).toMatchObject({
    workflow: {
      id: workflowId,
      featureId: null,
      changeProposalId: proposalId,
      reviewRevisionId: revisionId,
      state: "queued",
    },
  });
  expect(boss.send).toHaveBeenCalledWith(
    "factory-conceptual-review-v1",
    { workflowId },
    expect.objectContaining({ id: workflowId }),
  );
});

it("replays the same request from frozen inputs even after current inputs move", async () => {
  const retained = {
    id: workflowId,
    request_id: requestId,
    project_id: projectId,
    feature_id: featureId,
    change_proposal_id: proposalId,
    review_revision_id: revisionId,
    input_digest: digest,
    factory_input: preparation,
    workflow_state: "queued",
    attempt_count: 0,
    maximum_attempts: 3,
    failure_code: null,
    artifact_id: null,
    requested_at: at,
    started_at: null,
    finished_at: null,
    artifact: null,
    current_head_commit_id: headCommitId,
  };
  const { pool } = startPool([retained]);
  const boss = { send: vi.fn() };
  const prepare = vi.fn(() => Promise.reject(new Error("current inputs moved")));

  const replayed = await startFactoryConceptualReviewWorkflow(
    pool as never,
    boss,
    {
      actorId,
      correlationId: requestId,
      projectId,
      featureId,
      command: { requestId, preparationDigest: "e".repeat(64) },
    },
    prepare,
  );

  expect(replayed).toMatchObject({
    workflow: { id: workflowId, requestId, inputDigest: digest, state: "queued" },
    currency: "up_to_date",
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(boss.send).not.toHaveBeenCalled();
});

it("rejects a concurrent distinct request while another review is active", async () => {
  const { pool } = startPool([], Object.assign(new Error("unique conflict"), { code: "23505" }));

  await expect(
    startFactoryConceptualReviewWorkflow(
      pool as never,
      { send: vi.fn() },
      {
        actorId,
        correlationId: requestId,
        projectId,
        featureId,
        command: { requestId, preparationDigest: digest },
      },
      vi.fn(() => Promise.resolve(preparation)),
    ),
  ).rejects.toEqual(new FactoryConceptualReviewWorkflowPersistenceError("active_review"));
});

it("rejects a new request while an unconfirmed review environment still owns resources", async () => {
  const { pool, query } = startPool([], undefined, true);

  await expect(
    startFactoryConceptualReviewWorkflow(
      pool as never,
      { send: vi.fn() },
      {
        actorId,
        correlationId: requestId,
        projectId,
        featureId,
        command: { requestId, preparationDigest: digest },
      },
      vi.fn(() => Promise.resolve(preparation)),
    ),
  ).rejects.toEqual(new FactoryConceptualReviewWorkflowPersistenceError("active_review"));
  expect(
    query.mock.calls.some(
      ([sql]) =>
        sql.includes("failure_code = 'stop_unconfirmed'") &&
        sql.includes("workspace_disposed_at IS NULL"),
    ),
  ).toBe(true);
});

it("claims a queued Factory review with a fresh fenced attempt identity", async () => {
  const attemptId = "85cc9964-10c2-49d1-86c4-8f13f5019e86";
  const query = vi.fn((sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    if (sql.includes("set_config('lock_timeout'")) return { rowCount: 1, rows: [{}] };
    if (sql.includes("UPDATE review_workflows") && sql.includes("RETURNING"))
      return {
        rowCount: 1,
        rows: [
          {
            id: workflowId,
            attempt_id: attemptId,
            attempt_count: 1,
            factory_input: preparation,
          },
        ],
      };
    if (sql.includes("INSERT INTO review_workflow_attempts")) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const claim = await claimFactoryConceptualReviewWorkflow(
    { connect: vi.fn(() => ({ query, release: vi.fn() })) } as never,
    workflowId,
  );
  expect(claim).toEqual({
    workflowId,
    attemptId,
    attemptNumber: 1,
    preparation,
  });
});

it("publishes one immutable graph only for the current attempt", async () => {
  const attemptId = "85cc9964-10c2-49d1-86c4-8f13f5019e86";
  const query = vi.fn((sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    if (sql.includes("set_config('lock_timeout'")) return { rowCount: 1, rows: [{}] };
    if (sql.includes("SELECT uuidv7()")) return { rows: [{ id: artifactId, created_at: at }] };
    if (sql.includes("SELECT factory_input") && sql.includes("FOR UPDATE"))
      return { rowCount: 1, rows: [{ factory_input: preparation }] };
    if (sql.includes("INSERT INTO factory_conceptual_review_artifacts"))
      return { rowCount: 1, rows: [] };
    if (sql.includes("UPDATE review_workflow_attempts")) return { rowCount: 1, rows: [] };
    if (sql.includes("UPDATE review_workflows")) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const artifact = await publishFactoryConceptualReview(
    { connect: vi.fn(() => ({ query, release: vi.fn() })) } as never,
    { workflowId, attemptId, attemptNumber: 1 },
    draft,
    undefined,
    250,
  );
  expect(artifact).toMatchObject({
    id: artifactId,
    workflowId,
    inputDigest: digest,
    status: "partial",
    graph: draft,
  });
  expect(query.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
  expect(query).toHaveBeenCalledWith(expect.stringContaining("set_config('lock_timeout'"), [
    "250ms",
  ]);
});

it("refuses to publish invented executed-check evidence for an external pull request", async () => {
  const checkId = "01991c36-7f90-7000-8000-000000000008";
  const step = draft.behavioralSteps[0];
  if (step === undefined) throw new Error("Review draft fixture has no behavioral step");
  const externalDraft: FactoryConceptualReviewDraft = {
    ...draft,
    behavioralSteps: [{ ...step, evidenceIds: ["source:refresh", "check:refresh"] }],
    evidence: [
      ...draft.evidence,
      {
        id: "check:refresh",
        type: "check",
        evidenceId: checkId,
        relation: "supports",
        proposition: "The refresh verification succeeds.",
        description: "A claimed executed check.",
        sufficiency: "Would establish command success if it were linked.",
        limitations: [],
        record: {
          evidenceId: checkId,
          runId: featureId,
          manifestPosition: 1,
          origins: [{ workItemKey: "search", position: 1 }],
          command,
          headCommitId,
          treeId,
          outcome: "passed",
          exitCode: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 10,
          createdAt: at.toISOString(),
        },
      },
    ],
    edges: [...draft.edges, { from: "step:refresh", to: "check:refresh", kind: "supported_by" }],
  };
  const query = vi.fn((sql: string) => {
    if (["BEGIN", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    if (sql.includes("set_config('lock_timeout'")) return { rowCount: 1, rows: [{}] };
    if (sql.includes("SELECT factory_input") && sql.includes("FOR UPDATE"))
      return { rowCount: 1, rows: [{ factory_input: externalPreparation }] };
    throw new Error(`Unexpected query: ${sql}`);
  });

  await expect(
    publishFactoryConceptualReview(
      { connect: vi.fn(() => ({ query, release: vi.fn() })) } as never,
      { workflowId, attemptId: requestId, attemptNumber: 1 },
      externalDraft,
    ),
  ).rejects.toEqual(new FactoryConceptualReviewWorkflowPersistenceError("invalid_state"));
  expect(query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  expect(query.mock.calls.some(([sql]) => sql.includes("SELECT uuidv7()"))).toBe(false);
});

it("rejects publication by a late attempt owner", async () => {
  const query = vi.fn((sql: string) => {
    if (["BEGIN", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    if (sql.includes("set_config('lock_timeout'")) return { rowCount: 1, rows: [{}] };
    if (sql.includes("SELECT factory_input")) return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  await expect(
    publishFactoryConceptualReview(
      { connect: vi.fn(() => ({ query, release: vi.fn() })) } as never,
      {
        workflowId,
        attemptId: "85cc9964-10c2-49d1-86c4-8f13f5019e86",
        attemptNumber: 1,
      },
      draft,
    ),
  ).rejects.toEqual(new FactoryConceptualReviewWorkflowPersistenceError("stale_attempt"));
});

it("rolls back when cancellation arrives inside the publication transaction", async () => {
  const controller = new AbortController();
  const reason = new Error("review deadline elapsed");
  const query = vi.fn((sql: string) => {
    if (["BEGIN", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    if (sql.includes("set_config('lock_timeout'")) return { rowCount: 1, rows: [{}] };
    if (sql.includes("SELECT uuidv7()")) return { rows: [{ id: artifactId, created_at: at }] };
    if (sql.includes("SELECT factory_input") && sql.includes("FOR UPDATE"))
      return { rowCount: 1, rows: [{ factory_input: preparation }] };
    if (sql.includes("INSERT INTO factory_conceptual_review_artifacts"))
      return { rowCount: 1, rows: [] };
    if (sql.includes("UPDATE review_workflow_attempts")) return { rowCount: 1, rows: [] };
    if (sql.includes("UPDATE review_workflows")) {
      controller.abort(reason);
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  await expect(
    publishFactoryConceptualReview(
      { connect: vi.fn(() => ({ query, release: vi.fn() })) } as never,
      { workflowId, attemptId: "85cc9964-10c2-49d1-86c4-8f13f5019e86", attemptNumber: 1 },
      draft,
      controller.signal,
    ),
  ).rejects.toBe(reason);
  expect(query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  expect(query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
});

it("reads the latest durable workflow and marks a moved pull request head outdated", async () => {
  const query = vi.fn((sql: string) => {
    if (sql.includes("FROM review_workflows AS workflow"))
      return {
        rowCount: 1,
        rows: [
          {
            id: workflowId,
            request_id: requestId,
            project_id: projectId,
            feature_id: featureId,
            change_proposal_id: proposalId,
            review_revision_id: revisionId,
            input_digest: digest,
            factory_input: preparation,
            workflow_state: "published",
            attempt_count: 1,
            maximum_attempts: 3,
            failure_code: null,
            artifact_id: artifactId,
            requested_at: at,
            started_at: at,
            finished_at: at,
            artifact: {
              schemaVersion: 1,
              id: artifactId,
              workflowId,
              inputDigest: digest,
              reviewRevisionId: revisionId,
              baseCommitId,
              headCommitId,
              status: "partial",
              evidenceScope: {
                source: "exact_retained_revision",
                executedChecks: "not_linked",
                narrativeAuthority: "source_only_model_interpretation",
              },
              graph: draft,
              createdAt: at.toISOString(),
            },
            current_head_commit_id: "e".repeat(40),
          },
        ],
      };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const result = await readCurrentFactoryConceptualReviewWorkflow(
    { query } as never,
    projectId,
    featureId,
  );
  expect(result).toMatchObject({
    workflow: { id: workflowId, state: "published", artifactId },
    artifact: { id: artifactId, graph: draft },
    currency: "outdated",
  });
});

it("pages immutable published artifacts and reopens the selected artifact identity", async () => {
  const artifact = {
    schemaVersion: 1 as const,
    id: artifactId,
    workflowId,
    inputDigest: digest,
    reviewRevisionId: revisionId,
    baseCommitId,
    headCommitId,
    status: "partial" as const,
    evidenceScope: {
      source: "exact_retained_revision" as const,
      executedChecks: "not_linked" as const,
      narrativeAuthority: "source_only_model_interpretation" as const,
    },
    graph: draft,
    createdAt: at.toISOString(),
  };
  const workflowRow = {
    id: workflowId,
    request_id: requestId,
    project_id: projectId,
    feature_id: featureId,
    change_proposal_id: proposalId,
    review_revision_id: revisionId,
    input_digest: digest,
    factory_input: preparation,
    workflow_state: "published",
    attempt_count: 1,
    maximum_attempts: 3,
    failure_code: null,
    artifact_id: artifactId,
    requested_at: at,
    started_at: at,
    finished_at: at,
    artifact,
    current_head_commit_id: "e".repeat(40),
  };
  const query = vi.fn((sql: string) => {
    if (sql.includes("COUNT(*)")) return { rows: [{ total: "1" }] };
    if (sql.includes("FROM review_workflows AS workflow")) return { rows: [workflowRow] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const database = { query } as never;
  const history = await readFactoryConceptualReviewHistory(database, projectId, featureId, 0, 20);
  const selected = await readFactoryConceptualReviewArtifact(
    database,
    projectId,
    featureId,
    artifactId,
  );
  expect(history).toEqual({
    schemaVersion: 1,
    reviews: [
      {
        artifactId,
        workflowId,
        status: "partial",
        headCommitId,
        requestedAt: at.toISOString(),
        finishedAt: at.toISOString(),
        currency: "outdated",
      },
    ],
    offset: 0,
    total: 1,
    nextOffset: null,
  });
  expect(selected).toMatchObject({ artifact: { id: artifactId }, workflow: { id: workflowId } });
});

it("persists every runtime identity behind the current attempt fence", async () => {
  const query = vi.fn((sql: string, values?: unknown[]) => {
    void values;
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    return { rowCount: 1, rows: [] };
  });
  const pool = {
    connect: vi.fn(() => ({ query, release: vi.fn() })),
  } as never;
  const claim = {
    workflowId,
    attemptId: "85cc9964-10c2-49d1-86c4-8f13f5019e86",
    attemptNumber: 1,
  };
  await reserveFactoryConceptualReviewContainer(
    pool,
    claim,
    `kestrel-factory-${"a".repeat(32)}`,
    "daemon-1",
  );
  await identifyFactoryConceptualReviewContainer(pool, claim, {
    name: `kestrel-factory-${"a".repeat(32)}`,
    id: "a".repeat(64),
  });
  await recordFactoryConceptualReviewSession(pool, claim, { threadId: "thread-1" });
  await recordFactoryConceptualReviewSession(pool, claim, { turnId: "turn-1" });
  expect(await heartbeatFactoryConceptualReviewWorkflow(pool, claim)).toBe(true);
  await stopFactoryConceptualReviewContainer(pool, claim, {
    name: `kestrel-factory-${"a".repeat(32)}`,
    id: "a".repeat(64),
  });
  const updates = query.mock.calls.filter(([sql]) => sql.includes("UPDATE"));
  expect(updates).toHaveLength(6);
  expect(updates.every(([, values]) => (values as unknown[])[1] === claim.attemptId)).toBe(true);
  expect(query.mock.calls.filter(([sql]) => sql.includes("set_config('lock_timeout'")).length).toBe(
    6,
  );
});

it("records the provider-observed PR head only for the current attempt", async () => {
  const query = vi.fn(() => ({ rowCount: 1, rows: [] }));
  const claim = {
    workflowId,
    attemptId: "85cc9964-10c2-49d1-86c4-8f13f5019e86",
    attemptNumber: 1,
  };
  const movedHead = "e".repeat(40);

  await observeFactoryConceptualReviewHead(
    { connect: vi.fn(() => ({ query, release: vi.fn() })) } as never,
    claim,
    movedHead,
  );

  expect(query).toHaveBeenCalledWith(expect.stringContaining("observed_head_commit_id"), [
    workflowId,
    claim.attemptId,
    claim.attemptNumber,
    movedHead,
  ]);
});

it("requeues a retryable failed attempt with a new durable job", async () => {
  const nextJobId = "01991c36-7f90-7000-8000-000000000099";
  const query = vi.fn((sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    if (sql.includes("set_config('lock_timeout'")) return { rowCount: 1, rows: [] };
    if (sql.includes("UPDATE review_workflow_attempts")) return { rowCount: 1, rows: [] };
    if (sql.includes("UPDATE review_workflows") && sql.includes("RETURNING"))
      return { rowCount: 1, rows: [{ job_id: nextJobId, retrying: true }] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const boss = { send: vi.fn(() => Promise.resolve(nextJobId)) };
  const result = await failFactoryConceptualReviewWorkflow(
    { connect: vi.fn(() => ({ query, release: vi.fn() })) } as never,
    boss,
    {
      workflowId,
      attemptId: "85cc9964-10c2-49d1-86c4-8f13f5019e86",
      attemptNumber: 1,
    },
    "invalid_output",
    true,
  );
  expect(result).toBe("queued");
  expect(boss.send).toHaveBeenCalledWith(
    "factory-conceptual-review-v1",
    { workflowId },
    expect.objectContaining({ id: nextJobId }),
  );
});

it("publishes a terminal visible failure after the attempt budget is exhausted", async () => {
  const query = vi.fn((sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    if (sql.includes("set_config('lock_timeout'")) return { rowCount: 1, rows: [] };
    if (sql.includes("UPDATE review_workflow_attempts")) return { rowCount: 1, rows: [] };
    if (sql.includes("UPDATE review_workflows") && sql.includes("RETURNING"))
      return { rowCount: 1, rows: [{ job_id: null, retrying: false }] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const boss = { send: vi.fn() };
  const result = await failFactoryConceptualReviewWorkflow(
    { connect: vi.fn(() => ({ query, release: vi.fn() })) } as never,
    boss,
    {
      workflowId,
      attemptId: "85cc9964-10c2-49d1-86c4-8f13f5019e86",
      attemptNumber: 3,
    },
    "timeout",
    true,
  );
  expect(result).toBe("failed");
  expect(boss.send).not.toHaveBeenCalled();
});

it("recreates a lost durable delivery for engine reviews while excluding legacy review rows", async () => {
  const nextJobId = "01991c36-7f90-7000-8000-000000000099";
  const rootQuery = vi.fn((sql: string) => {
    if (sql.includes("workflow.workflow_state = 'queued'"))
      return { rowCount: 1, rows: [{ id: workflowId }] };
    if (
      sql.includes("workflow.workflow_state = 'running'") ||
      sql.includes("workflow.workflow_state = 'failed'")
    )
      return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected root query: ${sql}`);
  });
  const transactionQuery = vi.fn((sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    if (sql.includes("set_config('lock_timeout'")) return { rowCount: 1, rows: [{}] };
    if (sql.trimStart().startsWith("SELECT workflow.id") && !sql.includes("FOR UPDATE"))
      return rootQuery(sql);
    if (sql.includes("UPDATE review_workflow_attempts")) return { rowCount: 1, rows: [] };
    if (sql.includes("UPDATE review_workflows AS workflow"))
      return { rowCount: 1, rows: [{ job_id: nextJobId }] };
    throw new Error(`Unexpected transaction query: ${sql}`);
  });
  const boss = { send: vi.fn(() => Promise.resolve(nextJobId)) };

  await reconcileFactoryConceptualReviewWorkflows(
    {
      query: rootQuery,
      connect: vi.fn(() => ({ query: transactionQuery, release: vi.fn() })),
    } as never,
    boss,
  );

  expect(boss.send).toHaveBeenCalledWith(
    "factory-conceptual-review-v1",
    { workflowId },
    expect.objectContaining({ id: nextJobId }),
  );
  expect(transactionQuery.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
  expect(
    [...rootQuery.mock.calls, ...transactionQuery.mock.calls]
      .filter(([sql]) => sql.includes("review_workflows"))
      .every(([sql]) => sql.includes("factory_input IS NOT NULL")),
  ).toBe(true);
});

it("recovers and stops an abandoned container before retrying its stale owner", async () => {
  const nextJobId = "01991c36-7f90-7000-8000-000000000099";
  const staleAttemptId = "85cc9964-10c2-49d1-86c4-8f13f5019e86";
  const containerName = `kestrel-factory-${"a".repeat(32)}`;
  const containerId = "b".repeat(64);
  const staleRow = {
    id: workflowId,
    attempt_id: staleAttemptId,
    attempt_count: 1,
    maximum_attempts: 3,
    attempt_failure_code: null,
    container_name: containerName,
    container_id: null,
    docker_daemon_id: "daemon-1",
    container_image: `sha256:${"1".repeat(64)}`,
    container_stopped_at: null,
    workspace_disposed_at: null,
  };
  const rootQuery = vi.fn((sql: string) => {
    if (sql.includes("SET container_id = $5")) return { rowCount: 1, rows: [] };
    if (sql.includes("container_stopped_at = COALESCE")) return { rowCount: 1, rows: [] };
    if (sql.includes("workspace_disposed_at = COALESCE")) return { rowCount: 1, rows: [] };
    if (sql.includes("workflow.workflow_state = 'queued'")) return { rowCount: 0, rows: [] };
    if (sql.includes("workflow.workflow_state = 'running'"))
      return { rowCount: 1, rows: [{ id: workflowId }] };
    if (sql.includes("workflow.workflow_state = 'failed'")) return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected root query: ${sql}`);
  });
  const transactionQuery = vi.fn((sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    if (sql.includes("set_config('lock_timeout'")) return { rowCount: 1, rows: [{}] };
    if (sql.trimStart().startsWith("SELECT workflow.id") && !sql.includes("FOR UPDATE"))
      return rootQuery(sql);
    if (sql.includes("FOR UPDATE OF workflow, attempt")) return { rowCount: 1, rows: [staleRow] };
    if (sql.includes("UPDATE review_workflow_attempts")) return { rowCount: 1, rows: [] };
    if (sql.includes("UPDATE review_workflows AS workflow") && sql.includes("RETURNING"))
      return { rowCount: 1, rows: [{ job_id: nextJobId, retrying: true }] };
    if (sql.includes("UPDATE review_workflows")) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected transaction query: ${sql}`);
  });
  const boss = { send: vi.fn(() => Promise.resolve(nextJobId)) };
  const recover = vi.fn(async (_container, onIdentified: (id: string) => Promise<void>) => {
    await onIdentified(containerId);
    return { name: containerName, id: containerId };
  });
  const disposeWorkspace = vi.fn(() => Promise.resolve());

  await reconcileFactoryConceptualReviewWorkflows(
    {
      query: rootQuery,
      connect: vi.fn(() => ({ query: transactionQuery, release: vi.fn() })),
    } as never,
    boss,
    recover,
    disposeWorkspace,
  );

  expect(recover).toHaveBeenCalledWith(
    {
      name: containerName,
      id: null,
      daemonId: "daemon-1",
      image: `sha256:${"1".repeat(64)}`,
    },
    expect.any(Function),
    expect.any(AbortSignal),
  );
  expect(disposeWorkspace).toHaveBeenCalledWith(staleAttemptId);
  expect(recover.mock.invocationCallOrder[0]).toBeLessThan(
    disposeWorkspace.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
  );
  expect(boss.send).toHaveBeenCalledWith(
    "factory-conceptual-review-v1",
    { workflowId },
    expect.objectContaining({ id: nextJobId }),
  );
});

it("disposes a stopped workspace after a late stop confirmation", async () => {
  const staleAttemptId = "85cc9964-10c2-49d1-86c4-8f13f5019e86";
  const containerName = `kestrel-factory-${"a".repeat(32)}`;
  const rootQuery = vi.fn((sql: string) => {
    if (sql.includes("workflow.workflow_state = 'queued'")) return { rowCount: 0, rows: [] };
    if (sql.includes("workflow.workflow_state = 'running'")) return { rowCount: 0, rows: [] };
    if (sql.includes("workflow.workflow_state = 'failed'"))
      return {
        rowCount: 1,
        rows: [
          {
            id: workflowId,
            attempt_id: staleAttemptId,
            attempt_count: 1,
            maximum_attempts: 3,
            attempt_failure_code: "stop_unconfirmed",
            container_name: containerName,
            container_id: "b".repeat(64),
            docker_daemon_id: "daemon-1",
            container_stopped_at: at,
            workspace_disposed_at: null,
          },
        ],
      };
    if (sql.includes("workspace_disposed_at = COALESCE")) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected root query: ${sql}`);
  });
  const disposeWorkspace = vi.fn(() => Promise.resolve());
  const recover = vi.fn();
  const transactionQuery = vi.fn((sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    if (sql.includes("set_config('lock_timeout'")) return { rowCount: 1, rows: [{}] };
    if (sql.trimStart().startsWith("SELECT workflow.id") && !sql.includes("FOR UPDATE"))
      return rootQuery(sql);
    if (sql.includes("UPDATE review_workflow_attempts")) return { rowCount: 1, rows: [] };
    if (sql.includes("UPDATE review_workflows AS workflow"))
      return { rowCount: 1, rows: [{ job_id: null, retrying: false }] };
    throw new Error(`Unexpected transaction query: ${sql}`);
  });

  await reconcileFactoryConceptualReviewWorkflows(
    {
      query: rootQuery,
      connect: vi.fn(() => ({ query: transactionQuery, release: vi.fn() })),
    } as never,
    { send: vi.fn() },
    recover,
    disposeWorkspace,
  );

  expect(recover).not.toHaveBeenCalled();
  expect(disposeWorkspace).toHaveBeenCalledWith(staleAttemptId);
  expect(rootQuery.mock.calls.some(([sql]) => sql.includes("workspace_disposed_at"))).toBe(true);
  expect(
    transactionQuery.mock.calls.some(
      ([sql]) => sql.includes("failure_code = 'interrupted'") && sql.includes("RETURNING"),
    ),
  ).toBe(true);
});

it("reconciles a stale running owner even when twenty older stopped failures need cleanup", async () => {
  const nextJobId = "01991c36-7f90-7000-8000-000000000099";
  const runningAttemptId = "85cc9964-10c2-49d1-86c4-8f13f5019e86";
  const stoppedFailures = Array.from({ length: 20 }, (_, index) => ({
    id: `01991c36-7f90-7000-8000-${String(index).padStart(12, "0")}`,
    attempt_id: `85cc9964-10c2-4000-8000-${String(index).padStart(12, "0")}`,
    attempt_count: 1,
    maximum_attempts: 3,
    attempt_failure_code: "stop_unconfirmed",
    container_name: `kestrel-factory-${index.toString(16).padStart(32, "0")}`,
    container_id: index.toString(16).padStart(64, "0"),
    docker_daemon_id: "daemon-1",
    container_stopped_at: at,
    workspace_disposed_at: null,
  }));
  const staleRunning = {
    id: workflowId,
    attempt_id: runningAttemptId,
    attempt_count: 1,
    maximum_attempts: 3,
    attempt_failure_code: null,
    container_name: null,
    container_id: null,
    docker_daemon_id: null,
    container_stopped_at: null,
    workspace_disposed_at: null,
  };
  const rootQuery = vi.fn((sql: string) => {
    if (sql.includes("workspace_disposed_at = COALESCE")) return { rowCount: 1, rows: [] };
    if (sql.includes("workflow.workflow_state = 'queued'")) return { rowCount: 0, rows: [] };
    const running = sql.includes("workflow.workflow_state = 'running'");
    const failed = sql.includes("workflow.workflow_state = 'failed'");
    if (running && failed) return { rowCount: stoppedFailures.length, rows: stoppedFailures };
    if (running) return { rowCount: 1, rows: [{ id: workflowId }] };
    if (failed) return { rowCount: stoppedFailures.length, rows: stoppedFailures };
    throw new Error(`Unexpected root query: ${sql}`);
  });
  const transactionQuery = vi.fn((sql: string, values?: unknown[]) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    if (sql.includes("set_config('lock_timeout'")) return { rowCount: 1, rows: [{}] };
    if (sql.trimStart().startsWith("SELECT workflow.id") && !sql.includes("FOR UPDATE"))
      return rootQuery(sql);
    if (sql.includes("FOR UPDATE OF workflow, attempt"))
      return { rowCount: 1, rows: [staleRunning] };
    if (sql.includes("UPDATE review_workflow_attempts")) return { rowCount: 1, rows: [] };
    if (sql.includes("UPDATE review_workflows AS workflow") && sql.includes("RETURNING")) {
      const retrying = values?.[0] === workflowId;
      return {
        rowCount: 1,
        rows: [{ job_id: retrying ? nextJobId : null, retrying }],
      };
    }
    if (sql.includes("UPDATE review_workflows")) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected transaction query: ${sql}`);
  });
  const boss = { send: vi.fn(() => Promise.resolve(nextJobId)) };
  const disposeWorkspace = vi.fn(() => Promise.resolve());

  await reconcileFactoryConceptualReviewWorkflows(
    {
      query: rootQuery,
      connect: vi.fn(() => ({ query: transactionQuery, release: vi.fn() })),
    } as never,
    boss,
    undefined,
    disposeWorkspace,
  );

  expect(disposeWorkspace).toHaveBeenCalledWith(runningAttemptId);
  expect(boss.send).toHaveBeenCalledWith(
    "factory-conceptual-review-v1",
    { workflowId },
    expect.objectContaining({ id: nextJobId }),
  );
});

it("does not fence an owner whose heartbeat renewed after candidate discovery", async () => {
  const transactionQuery = vi.fn((sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: null, rows: [] };
    if (sql.includes("set_config('lock_timeout'")) return { rowCount: 1, rows: [{}] };
    if (sql.trimStart().startsWith("SELECT workflow.id") && !sql.includes("FOR UPDATE"))
      return rootQuery(sql);
    if (sql.includes("FOR UPDATE OF workflow, attempt")) return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected transaction query: ${sql}`);
  });
  const rootQuery = vi.fn((sql: string) => {
    if (sql.includes("workflow.workflow_state = 'queued'")) return { rowCount: 0, rows: [] };
    if (sql.includes("workflow.workflow_state = 'running'"))
      return { rowCount: 1, rows: [{ id: workflowId }] };
    if (sql.includes("workflow.workflow_state = 'failed'")) return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected root query: ${sql}`);
  });
  const recover = vi.fn();
  const disposeWorkspace = vi.fn();
  const boss = { send: vi.fn() };

  await reconcileFactoryConceptualReviewWorkflows(
    {
      query: rootQuery,
      connect: vi.fn(() => ({ query: transactionQuery, release: vi.fn() })),
    } as never,
    boss,
    recover,
    disposeWorkspace,
  );

  expect(recover).not.toHaveBeenCalled();
  expect(disposeWorkspace).not.toHaveBeenCalled();
  expect(boss.send).not.toHaveBeenCalled();
  expect(transactionQuery.mock.calls.some(([sql]) => sql.includes("UPDATE review_workflows"))).toBe(
    false,
  );
});
