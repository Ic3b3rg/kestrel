import { createHash } from "node:crypto";
import { z } from "zod";

import {
  KestrelIdSchema,
  type FactoryConceptualReviewCheckSummary,
  type FactoryConceptualReviewFailure,
  type FactoryConceptualReviewPreparation,
} from "@kestrel/contracts";
import {
  FactoryConceptualReviewWorkflowPersistenceError,
  claimFactoryConceptualReviewWorkflow,
  failFactoryConceptualReviewWorkflow,
  heartbeatFactoryConceptualReviewWorkflow,
  identifyFactoryConceptualReviewContainer,
  observeFactoryConceptualReviewHead,
  publishFactoryConceptualReview,
  readFactoryConceptualReviewWorkflowCheck,
  readFactoryConceptualReviewWorkflowChecks,
  readFactoryConceptualReviewWorkflowSourceBinding,
  recordFactoryConceptualReviewResourceDisposal,
  recordFactoryConceptualReviewSession,
  reserveFactoryConceptualReviewContainer,
  stopFactoryConceptualReviewContainer,
  type DatabasePool,
  type DiagnosticJobSender,
  type FactoryConceptualReviewAttemptIdentity,
} from "@kestrel/database";
import {
  ConceptualReviewSourceError,
  disposeConceptualReviewControlDirectory,
  LocalSourceError,
  materializeConceptualReviewWorkspace,
  openConceptualReviewSourceReader,
  prepareConceptualReviewControlDirectory,
  type ConceptualReviewWorkspace,
  type LocalSourceConfig,
} from "@kestrel/local-source";

import {
  CERTIFIED_CODEX_REVIEW_VERSION,
  createCodexReviewRuntime,
  type CodexReviewRuntime,
} from "./codex-review-runtime.js";
import { CodexExecutionError, type CodexExecutionLifecycle } from "./codex-execution-runtime.js";
import {
  createFactoryFeatureGitHubAdapter,
  type FactoryFeatureGitHubAdapter,
} from "./factory-feature-github.js";
import { FactoryGitHubError } from "./factory-github.js";
import {
  FactoryConceptualReviewModelOutputSchema,
  FactoryConceptualReviewValidationError,
  parseFactoryConceptualReviewModelOutput,
  validateFactoryConceptualReview,
} from "./review-evidence.js";

export const FACTORY_CONCEPTUAL_REVIEW_WORK_OPTIONS = {
  batchSize: 1,
  localConcurrency: 2,
  pollingIntervalSeconds: 1,
  notifyPollingIntervalSeconds: 5,
} as const;
const DATABASE_MUTATION_TIMEOUT_MS = 5_000;
const CHECK_COMMAND_PREVIEW_BYTES = 384;

export interface FactoryConceptualReviewProcessorOptions {
  pool: DatabasePool;
  boss: DiagnosticJobSender;
  readSourceConfig: () => Promise<LocalSourceConfig>;
  runtime?: CodexReviewRuntime;
  containerImage?: string;
  containerUser?: string;
  codexExecutable?: string;
  codexExecutableDigest?: string;
  codexVersion?: string;
  dockerExecutable?: string;
  materialize?: typeof materializeConceptualReviewWorkspace;
  github?: Pick<FactoryFeatureGitHubAdapter, "observePullRequest">;
}

function checkCatalogForPrompt(
  preparation: FactoryConceptualReviewPreparation,
  checks: FactoryConceptualReviewCheckSummary[],
) {
  const first = checks[0];
  return {
    total: checks.length,
    runId: preparation.evidence?.checks.runId,
    manifestDigest: preparation.evidence?.checks.manifestDigest,
    headCommitId: first?.headCommitId,
    treeId: first?.treeId,
    outputIncluded: false,
    commandEncoding: {
      kind: "bounded_json_preview_sha256" as const,
      previewBytes: CHECK_COMMAND_PREVIEW_BYTES,
    },
    checks: checks.map((check) => {
      const serialized = JSON.stringify(check.command);
      const bytes = Buffer.from(serialized, "utf8");
      const truncated = bytes.length > CHECK_COMMAND_PREVIEW_BYTES;
      const preview = truncated
        ? bytes
            .subarray(0, CHECK_COMMAND_PREVIEW_BYTES)
            .toString("utf8")
            .replace(/\uFFFD$/u, "")
        : serialized;
      return {
        evidenceId: check.evidenceId,
        manifestPosition: check.manifestPosition,
        origins: check.origins,
        command: {
          preview,
          sha256: createHash("sha256").update(serialized).digest("hex"),
          truncated,
        },
        outcome: check.outcome,
        exitCode: check.exitCode,
        stdoutTruncated: check.stdoutTruncated,
        stderrTruncated: check.stderrTruncated,
        durationMs: check.durationMs,
        createdAt: check.createdAt,
      };
    }),
  };
}

function reviewPrompt(
  preparation: FactoryConceptualReviewPreparation,
  checks: FactoryConceptualReviewCheckSummary[],
): string {
  if (preparation.basis === null || preparation.publication === null)
    throw new FactoryConceptualReviewValidationError("invalid_output");
  const prompt = [
    "Review the exact frozen Feature source independently. Source is available only in /workspace/base and /workspace/head and is intentionally absent from this prompt. Inspect it with read-only shell commands before answering.",
    "Return JSON matching the supplied schema. Account for every approved outcome exactly once and copy its approved outcome text verbatim into outcome.title. Link mapped outcomes to human Behavioral Steps, each step to exact source and relevant final-check evidence, and evidence to any problems.",
    'Treat /workspace/base and /workspace/head as side roots. In every evidence object, path is relative to that side root, for example path:"src/file.ts". Never emit /workspace, base/, head/, an absolute path, or .git in path.',
    "Graph consistency is mandatory: mapped outcomes must name at least one Behavioral Step ID and have matching implemented_by edges; every Behavioral Step must name its outcome keys and source evidence IDs and have matching supported_by edges; every problem evidence ID must have a matching reveals edge from that evidence to the problem.",
    "A mapped outcome must reach at least one Added, Modified, or Removed Behavioral Step; Context alone cannot establish delivery. Added and Modified steps require head evidence. Removed steps require base evidence.",
    "A Finding requires an exact-head condition, adverse consequence, reasoning, supporting source IDs, Risk Level, sufficiency, and limitations. Observations and Unverified Concerns have no Risk Level.",
    "Finding evidenceIds may reference head-side evidence only. Base-side evidence can provide context but cannot support a Finding.",
    "Every problem object must include every schema field. Use null for fields that do not apply to that problem type.",
    "Every evidence object must include every schema field. For source evidence set evidenceId, relation, and proposition to null. For check evidence set side, path, startLine, and endLine to null.",
    "Use inclusive source ranges of at most 200 lines. Never invent a path or range. Do not execute project code or implement fixes.",
    "The final-check catalog contains every check with server-resolved metadata; stdout and stderr are intentionally omitted. Commands are bounded JSON previews plus a digest, and command.truncated says when the preview is incomplete. Reference a check only by its exact evidenceId. State one narrow proposition and whether the recorded execution supports or refutes it. A passed command does not by itself prove a product behavior: the semantic link remains your stated judgment and its limitations must be explicit. If a truncated command prevents a sound link, keep the requirement Gap or Unclear.",
    "Use result:complete only when every outcome is mapped or not applicable, every changed Behavioral Step has exact source and a genuinely relevant supporting final check, no referenced check refutes it, and no Unverified Concern remains. Otherwise use result:partial and keep inadequately supported requirements Gap or Unclear, or disclose an Unverified Concern.",
    JSON.stringify({
      objective: preparation.basis.objective,
      scope: preparation.basis.scope,
      approvedOutcomes: preparation.basis.outcomes.map(({ key, outcome }) => ({ key, outcome })),
      revision: {
        baseCommitId: preparation.publication.revision.base.objectId,
        headCommitId: preparation.publication.revision.head.objectId,
      },
      finalCheckCatalog: checkCatalogForPrompt(preparation, checks),
      limits: preparation.configuration.resources,
    }),
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > 512 * 1024)
    throw new FactoryConceptualReviewValidationError("resource_exhausted");
  return prompt;
}

async function readCompleteCheckCatalog(
  pool: DatabasePool,
  preparation: FactoryConceptualReviewPreparation,
  workflowId: string,
): Promise<FactoryConceptualReviewCheckSummary[]> {
  const expected = preparation.evidence?.checks;
  if (expected === undefined) throw new FactoryConceptualReviewValidationError("check_unavailable");
  const checks: FactoryConceptualReviewCheckSummary[] = [];
  let offset = 0;
  do {
    const page = await readFactoryConceptualReviewWorkflowChecks(
      pool,
      preparation.projectId,
      preparation.featureId,
      workflowId,
      offset,
      100,
    );
    if (
      page.runId !== expected.runId ||
      page.manifestDigest !== expected.manifestDigest ||
      page.total !== expected.total ||
      page.offset !== offset
    )
      throw new FactoryConceptualReviewValidationError("check_unavailable");
    checks.push(...page.checks);
    if (page.nextOffset === null) break;
    if (page.nextOffset <= offset || page.checks.length === 0)
      throw new FactoryConceptualReviewValidationError("check_unavailable");
    offset = page.nextOffset;
  } while (checks.length <= expected.total);
  if (
    checks.length !== expected.total ||
    new Set(checks.map(({ evidenceId }) => evidenceId)).size !== checks.length
  )
    throw new FactoryConceptualReviewValidationError("check_unavailable");
  return checks;
}

function parseDraft(text: string): unknown {
  try {
    return parseFactoryConceptualReviewModelOutput(JSON.parse(text) as unknown);
  } catch {
    throw new FactoryConceptualReviewValidationError("invalid_output");
  }
}

function classifyFailure(error: unknown): {
  code: FactoryConceptualReviewFailure;
  retryable: boolean;
} {
  if (error instanceof FactoryConceptualReviewValidationError)
    return {
      code: error.code,
      retryable: error.code === "invalid_output",
    };
  if (error instanceof FactoryConceptualReviewWorkflowPersistenceError && error.code === "timeout")
    return { code: "timeout", retryable: true };
  if (error instanceof ConceptualReviewSourceError || error instanceof LocalSourceError)
    return error instanceof LocalSourceError && error.code === "review_workspace_limit_exceeded"
      ? { code: "resource_exhausted", retryable: false }
      : { code: "source_unavailable", retryable: false };
  if (error instanceof FactoryGitHubError) {
    if (error.failure === "needs_authentication")
      return { code: "authentication_required", retryable: false };
    if (error.failure === "cancelled") return { code: "interrupted", retryable: true };
    if (["unavailable", "rate_limited", "timeout"].includes(error.failure))
      return { code: "runtime_unavailable", retryable: true };
    return { code: "internal_error", retryable: false };
  }
  if (error instanceof CodexExecutionError) {
    if (error.code === "authentication")
      return { code: "authentication_required", retryable: false };
    if (error.code === "usage_limit") return { code: "usage_limit", retryable: false };
    if (error.code === "timeout") return { code: "timeout", retryable: true };
    if (error.code === "stop_unconfirmed") return { code: "stop_unconfirmed", retryable: false };
    if (["invalid_response", "permission_required", "input_required"].includes(error.code))
      return { code: "invalid_output", retryable: error.code === "invalid_response" };
    if (["interrupted", "cancelled"].includes(error.code))
      return { code: "interrupted", retryable: true };
    return { code: "runtime_unavailable", retryable: true };
  }
  return { code: "internal_error", retryable: true };
}

function assertReviewActive(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof CodexExecutionError) throw signal.reason;
  throw new CodexExecutionError("interrupted");
}

function lifecycle(
  pool: DatabasePool,
  claim: FactoryConceptualReviewAttemptIdentity,
): CodexExecutionLifecycle & { assertStopped(): void; workspaceMayBeDisposed(): boolean } {
  const proof: { name: string | null; id: string | null; stopped: boolean } = {
    name: null,
    id: null,
    stopped: false,
  };
  return {
    async beforeContainerCreate(name, daemonId) {
      if (proof.name !== null) throw new CodexExecutionError("stop_unconfirmed");
      proof.name = name;
      await reserveFactoryConceptualReviewContainer(
        pool,
        claim,
        name,
        daemonId,
        DATABASE_MUTATION_TIMEOUT_MS,
      );
    },
    async onContainer(container) {
      if (proof.name !== container.name) throw new CodexExecutionError("stop_unconfirmed");
      await identifyFactoryConceptualReviewContainer(
        pool,
        claim,
        container,
        DATABASE_MUTATION_TIMEOUT_MS,
      );
      proof.id = container.id;
    },
    async onStopped(container) {
      if (proof.name !== container.name || (proof.id !== null && proof.id !== container.id))
        throw new CodexExecutionError("stop_unconfirmed");
      await stopFactoryConceptualReviewContainer(
        pool,
        claim,
        container,
        DATABASE_MUTATION_TIMEOUT_MS,
      );
      proof.stopped = true;
    },
    assertStopped() {
      if (proof.name === null || proof.id === null || !proof.stopped)
        throw new CodexExecutionError("stop_unconfirmed");
    },
    workspaceMayBeDisposed() {
      return proof.name === null || proof.stopped;
    },
  };
}

async function runReview(
  options: FactoryConceptualReviewProcessorOptions,
  workflowId: string,
  shutdown: AbortSignal,
  jobSignal?: AbortSignal,
): Promise<void> {
  const claimSignal = jobSignal === undefined ? shutdown : AbortSignal.any([shutdown, jobSignal]);
  assertReviewActive(claimSignal);
  const claim = await claimFactoryConceptualReviewWorkflow(
    options.pool,
    workflowId,
    DATABASE_MUTATION_TIMEOUT_MS,
  );
  assertReviewActive(claimSignal);
  if (claim === null) return;
  const timeoutMs = claim.preparation.configuration.resources.timeoutSeconds * 1000;
  const deadlineAt = Date.now() + timeoutMs;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new CodexExecutionError("timeout")), timeoutMs);
  timer.unref();
  const signal = AbortSignal.any([
    shutdown,
    deadline.signal,
    ...(jobSignal === undefined ? [] : [jobSignal]),
  ]);
  const pulses = new Set<Promise<void>>();
  const heartbeat = setInterval(() => {
    if (pulses.size > 0) return;
    const pulse = heartbeatFactoryConceptualReviewWorkflow(
      options.pool,
      claim,
      DATABASE_MUTATION_TIMEOUT_MS,
    )
      .then((active) => {
        if (!active) deadline.abort(new CodexExecutionError("interrupted"));
      })
      .catch(() => deadline.abort(new CodexExecutionError("interrupted")))
      .finally(() => pulses.delete(pulse));
    pulses.add(pulse);
  }, 1_000);
  heartbeat.unref();
  let workspace: ConceptualReviewWorkspace | undefined;
  let sourceConfig: LocalSourceConfig | undefined;
  let controlPrepared = false;
  let runtimeLifecycle: ReturnType<typeof lifecycle> | undefined;
  let published = false;
  try {
    assertReviewActive(signal);
    const model = claim.preparation.configuration.model.modelId;
    if (model === null) throw new CodexExecutionError("unavailable");
    const [config, binding] = await Promise.all([
      options.readSourceConfig(),
      readFactoryConceptualReviewWorkflowSourceBinding(options.pool, workflowId),
    ]);
    const checks = await readCompleteCheckCatalog(options.pool, claim.preparation, workflowId);
    sourceConfig = config;
    try {
      workspace = await (options.materialize ?? materializeConceptualReviewWorkspace)(
        config,
        binding,
        claim.attemptId,
        {
          maximumFiles: claim.preparation.configuration.resources.maximumWorkspaceFiles,
          maximumBytes: claim.preparation.configuration.resources.maximumWorkspaceBytes,
        },
        signal,
      );
    } catch (error) {
      assertReviewActive(signal);
      throw error;
    }
    assertReviewActive(signal);
    if (options.runtime === undefined && !options.containerImage?.trim())
      throw new CodexExecutionError("sandbox_unavailable");
    let runtime = options.runtime;
    if (runtime === undefined) {
      const policy = claim.preparation.configuration.runtimePolicy;
      const resources = claim.preparation.configuration.resources;
      if (
        policy.containerImage === null ||
        policy.containerUser === null ||
        policy.codexExecutable === null ||
        policy.codexExecutableDigest === null ||
        policy.codexVersion !== CERTIFIED_CODEX_REVIEW_VERSION ||
        options.containerImage !== policy.containerImage ||
        options.containerUser !== policy.containerUser ||
        options.codexExecutable !== policy.codexExecutable ||
        options.codexExecutableDigest !== policy.codexExecutableDigest ||
        options.codexVersion !== policy.codexVersion
      )
        throw new CodexExecutionError("sandbox_unavailable", undefined, "runtime_profile_mismatch");
      const controlDirectory = await prepareConceptualReviewControlDirectory(
        config,
        claim.attemptId,
      );
      controlPrepared = true;
      runtime = createCodexReviewRuntime({
        containerImage: policy.containerImage,
        containerUser: policy.containerUser,
        executable: policy.codexExecutable,
        expectedExecutableDigest: policy.codexExecutableDigest,
        expectedCodexVersion: policy.codexVersion,
        containerResources: {
          pidsLimit: resources.containerPidsLimit,
          memoryBytes: resources.containerMemoryBytes,
          nanoCpus: resources.containerNanoCpus,
          tmpfsBytes: resources.containerTmpfsBytes,
        },
        timeoutMs,
        controlDirectory,
        ...(options.dockerExecutable === undefined
          ? {}
          : { dockerExecutable: options.dockerExecutable }),
      });
    }
    runtimeLifecycle = lifecycle(options.pool, claim);
    const result = await runtime.runTurn({
      ...runtimeLifecycle,
      cwd: workspace.path,
      model,
      prompt: reviewPrompt(claim.preparation, checks),
      requestId: `${claim.workflowId}:review:${String(claim.attemptNumber)}`,
      outputSchema: z.toJSONSchema(FactoryConceptualReviewModelOutputSchema, {
        target: "draft-7",
      }),
      signal,
      onThread: (threadId) =>
        recordFactoryConceptualReviewSession(
          options.pool,
          claim,
          { threadId },
          DATABASE_MUTATION_TIMEOUT_MS,
        ),
      onTurn: (turnId) =>
        recordFactoryConceptualReviewSession(
          options.pool,
          claim,
          { turnId },
          DATABASE_MUTATION_TIMEOUT_MS,
        ),
      onActivity: () => Promise.resolve(),
      onQuestion: () => Promise.reject(new CodexExecutionError("permission_required")),
    });
    runtimeLifecycle.assertStopped();
    assertReviewActive(signal);
    await workspace.verify(signal);
    assertReviewActive(signal);
    const sourceReader = await openConceptualReviewSourceReader(config, binding);
    const resolvedChecks = new Map<
      string,
      Awaited<ReturnType<typeof readFactoryConceptualReviewWorkflowCheck>>
    >();
    assertReviewActive(signal);
    const draft = await validateFactoryConceptualReview({
      preparation: claim.preparation,
      draft: parseDraft(result.text),
      signal,
      readSource: async (evidence) => {
        assertReviewActive(signal);
        const source = await sourceReader.readLines({
          side: evidence.side,
          path: evidence.path,
          startLine: evidence.startLine,
          endLine: evidence.endLine,
        });
        assertReviewActive(signal);
        return source;
      },
      readChange: (evidence) => sourceReader.readChange(evidence),
      readCheck: async (evidenceId) => {
        const retained = resolvedChecks.get(evidenceId);
        if (retained !== undefined) return retained;
        const check = await readFactoryConceptualReviewWorkflowCheck(
          options.pool,
          claim.preparation.projectId,
          claim.preparation.featureId,
          workflowId,
          evidenceId,
        );
        resolvedChecks.set(evidenceId, check);
        return check;
      },
    });
    assertReviewActive(signal);
    await workspace.verify(signal);
    assertReviewActive(signal);
    await workspace.dispose();
    workspace = undefined;
    if (controlPrepared) {
      await disposeConceptualReviewControlDirectory(config, claim.attemptId);
      controlPrepared = false;
    }
    await recordFactoryConceptualReviewResourceDisposal(
      options.pool,
      claim,
      DATABASE_MUTATION_TIMEOUT_MS,
    );
    const pullRequest = claim.preparation.publication?.pullRequest;
    if (pullRequest === undefined)
      throw new FactoryConceptualReviewValidationError("invalid_output");
    try {
      const observation = await (
        options.github ?? createFactoryFeatureGitHubAdapter()
      ).observePullRequest(
        { repository: pullRequest.repository, account: pullRequest.author },
        pullRequest,
        signal,
      );
      assertReviewActive(signal);
      await observeFactoryConceptualReviewHead(
        options.pool,
        claim,
        observation.headCommitId,
        DATABASE_MUTATION_TIMEOUT_MS,
      );
    } catch (error) {
      assertReviewActive(signal);
      if (!(error instanceof FactoryGitHubError)) throw error;
    }
    assertReviewActive(signal);
    await publishFactoryConceptualReview(
      options.pool,
      claim,
      draft,
      signal,
      Math.max(1, deadlineAt - Date.now()),
    );
    published = true;
  } catch (error) {
    let failureCause = error;
    if (signal.aborted)
      try {
        assertReviewActive(signal);
      } catch (abortReason) {
        failureCause = abortReason;
      }
    let failure = classifyFailure(failureCause);
    const mayDispose = runtimeLifecycle?.workspaceMayBeDisposed() ?? true;
    if (!mayDispose) failure = { code: "stop_unconfirmed", retryable: false };
    if (workspace !== undefined && mayDispose) {
      try {
        await workspace.verify();
      } catch {
        failure = { code: "source_unavailable", retryable: false };
      }
      await workspace.dispose();
    }
    if (controlPrepared && mayDispose && sourceConfig !== undefined) {
      await disposeConceptualReviewControlDirectory(sourceConfig, claim.attemptId);
    }
    if (mayDispose) {
      try {
        await recordFactoryConceptualReviewResourceDisposal(
          options.pool,
          claim,
          DATABASE_MUTATION_TIMEOUT_MS,
        );
      } catch (disposalError) {
        if (!(
          disposalError instanceof FactoryConceptualReviewWorkflowPersistenceError &&
          disposalError.code === "stale_attempt"
        ))
          failure = { code: "stop_unconfirmed", retryable: false };
      }
    }
    if (
      error instanceof FactoryConceptualReviewWorkflowPersistenceError &&
      error.code === "stale_attempt"
    )
      return;
    if (!published) {
      try {
        await failFactoryConceptualReviewWorkflow(
          options.pool,
          options.boss,
          claim,
          failure.code,
          failure.retryable,
          DATABASE_MUTATION_TIMEOUT_MS,
        );
      } catch (persistenceError) {
        if (!(
          persistenceError instanceof FactoryConceptualReviewWorkflowPersistenceError &&
          persistenceError.code === "stale_attempt"
        ))
          throw persistenceError;
      }
    }
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    await Promise.allSettled(pulses);
  }
}

export function createFactoryConceptualReviewProcessor(
  options: FactoryConceptualReviewProcessorOptions,
): {
  process(data: unknown, signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
} {
  const running = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  let stopped = false;
  return {
    process(data, signal) {
      const workflowId = KestrelIdSchema.parse(
        typeof data === "object" && data !== null && "workflowId" in data
          ? data.workflowId
          : undefined,
      );
      if (stopped) return Promise.resolve();
      const existing = running.get(workflowId);
      if (existing !== undefined) return existing.promise;
      const abort = new AbortController();
      const promise = runReview(options, workflowId, abort.signal, signal).finally(() => {
        running.delete(workflowId);
      });
      running.set(workflowId, { abort, promise });
      return promise;
    },
    async stop() {
      stopped = true;
      for (const operation of running.values())
        operation.abort.abort(new CodexExecutionError("interrupted"));
      await Promise.allSettled([...running.values()].map(({ promise }) => promise));
    },
  };
}
