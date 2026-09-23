import { lifecycleProfileEvidence } from "@kestrel/contracts";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import {
  factoryVerificationManifest,
  type FactoryExecutionFailure,
  type FactoryExecutionRun,
  type FactoryVerificationResult,
} from "@kestrel/contracts";
import {
  identifyFactoryExecutionContainer,
  initializeFactoryFeatureWorkspace,
  readFactoryFeatureWorkspace,
  reconcileFactoryExecutions,
  recordFactoryExecutionCheckpoint,
  reserveFactoryExecutionContainer,
  saveFactoryExecutionRuntime,
  saveFactoryVerification,
  stopFactoryExecutionContainer,
  type ClaimedFactoryExecution,
  type DatabasePool,
  type DiagnosticJobSender,
  type FactoryFeatureWorkspace,
} from "@kestrel/database";
import {
  assertFeatureWorkspaceSnapshot,
  checkpointFeatureWorkspace,
  FeatureWorkspaceError,
  inspectRepository,
  listRepositoryReferences,
  LocalSourceError,
  openFeatureWorkspace,
  resolveRepository,
  snapshotFeatureWorkspace,
  type FeatureWorkspace,
  type LocalSourceConfig,
} from "@kestrel/local-source";
import {
  CodexExecutionError,
  createCodexExecutionRuntime,
  createCodexExecutionContainerRecovery,
  type CodexExecutionLifecycle,
  type CodexExecutionRuntime,
  type CodexExecutionTurnInput,
  type CodexVerificationResult,
} from "./codex-execution-runtime.js";

export class FactoryExecutionError extends Error {
  constructor(
    readonly code: FactoryExecutionFailure,
    readonly question: string | null = null,
  ) {
    super(`Factory execution failed: ${code}`);
  }
}

function checkpointId(runId: string, round: number): string {
  // The random durable run ID and round identify one operation across process restarts.
  // UUID bits are normalized after a domain-separated hash; no new mutable ID is needed.
  const bytes = createHash("sha256")
    .update(`kestrel.factory.checkpoint.v1\0${runId}\0${String(round)}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function boundedText(text: string, maxBytes: number): string {
  return new StringDecoder("utf8").write(Buffer.from(text).subarray(0, maxBytes));
}

async function prepareWorkspace(
  pool: DatabasePool,
  run: ClaimedFactoryExecution,
  config: LocalSourceConfig,
  signal: AbortSignal,
): Promise<{ workspace: FeatureWorkspace; revision: FactoryFeatureWorkspace }> {
  if (run.source === null) throw new FactoryExecutionError("source_unavailable");
  let revision = await readFactoryFeatureWorkspace(pool, run);
  if (run.purpose === "feature_verification" || run.purpose === "correction") {
    const initial = run.initialRevision;
    if (revision === null || initial === undefined)
      throw new FactoryExecutionError("source_unavailable");
    if (
      revision.baseCommitId !== initial.baseCommitId ||
      revision.headCommitId !== initial.headCommitId ||
      revision.treeId !== initial.treeId ||
      revision.branch !== initial.branch
    )
      throw new FactoryExecutionError("revision_changed");
    if (
      JSON.stringify(run.verificationManifest) !==
      JSON.stringify(factoryVerificationManifest(run.plan))
    )
      throw new FactoryExecutionError("invalid_response");
  }
  if (revision !== null) {
    if (
      revision.repositoryId !== run.source.repositoryId ||
      revision.sourceIdentity !== run.source.identity ||
      revision.featureId !== run.featureId
    )
      throw new FactoryExecutionError("source_changed");
    const workspace = await openFeatureWorkspace(config, revision, {
      signal,
      documents: { planMarkdown: run.planMarkdown, specMarkdown: run.specMarkdown },
    });
    await assertFeatureWorkspaceSnapshot(workspace, revision, { signal });
    return { workspace, revision };
  }
  const repository = await resolveRepository(config, run.source.repositoryId);
  const inspected = await inspectRepository(config, repository, signal);
  if (inspected.sourceIdentity !== run.source.identity)
    throw new FactoryExecutionError("source_changed");
  const baseCommitId =
    run.context?.commitId ??
    (await listRepositoryReferences(config, repository)).references.find(
      (reference) => reference.kind === "head",
    )?.commitObjectId;
  signal.throwIfAborted();
  if (baseCommitId === undefined) throw new FactoryExecutionError("source_unavailable");
  const identity = {
    projectId: run.projectId,
    featureId: run.featureId,
    repositoryId: run.source.repositoryId,
    sourceIdentity: run.source.identity,
    baseCommitId,
    objectFormat: inspected.objectFormat,
    branch: `refs/heads/kestrel/feature/${run.featureId}`,
  };
  const workspace = await openFeatureWorkspace(config, identity, {
    signal,
    documents: { planMarkdown: run.planMarkdown, specMarkdown: run.specMarkdown },
  });
  const snapshot = await snapshotFeatureWorkspace(workspace, {
    expectedHead: baseCommitId,
    signal,
  });
  signal.throwIfAborted();
  revision = await initializeFactoryFeatureWorkspace(pool, run, { ...identity, ...snapshot });
  return { workspace, revision };
}

export function factoryExecutionFailure(
  error: unknown,
  signal: AbortSignal,
  verifying: boolean,
): FactoryExecutionError {
  if (
    (error instanceof CodexExecutionError || error instanceof FactoryExecutionError) &&
    error.code === "stop_unconfirmed"
  )
    return new FactoryExecutionError("stop_unconfirmed");
  if (signal.aborted)
    return signal.reason instanceof FactoryExecutionError
      ? signal.reason
      : new FactoryExecutionError("interrupted");
  if (error instanceof FactoryExecutionError) return error;
  if (error instanceof CodexExecutionError)
    return new FactoryExecutionError(error.code, error.question ?? null);
  if (error instanceof FeatureWorkspaceError) {
    if (
      [
        "workspace_changed",
        "workspace_invalid",
        "workspace_identity_mismatch",
        "workspace_checkpoint_conflict",
      ].includes(error.code)
    )
      return new FactoryExecutionError(verifying ? "revision_changed" : "source_changed");
    return new FactoryExecutionError("source_unavailable");
  }
  if (error instanceof LocalSourceError) return new FactoryExecutionError("source_unavailable");
  return new FactoryExecutionError("unavailable");
}

export interface FactorySandboxOptions {
  pool: DatabasePool;
  run: ClaimedFactoryExecution;
  readSourceConfig: () => Promise<LocalSourceConfig>;
  runtime?: CodexExecutionRuntime;
  containerImage?: string;
  dockerExecutable?: string;
  signal: AbortSignal;
  deadline: number;
}

type ImplementationInput = Pick<
  CodexExecutionTurnInput,
  "model" | "effort" | "serviceTier" | "prompt" | "outputSchema" | "onActivity" | "onQuestion"
> & { round: number };

type VerificationFeedback = Pick<
  FactoryVerificationResult,
  "position" | "outcome" | "exitCode" | "stdout" | "stderr"
>;

/** One Agent Run owns this session; only the contained adapter receives private paths. */
export function createFactorySandbox(options: FactorySandboxOptions) {
  const { pool, run, signal } = options;
  const pending = new Set<string>();
  let prepared: Awaited<ReturnType<typeof prepareWorkspace>> | undefined;
  let runtime: CodexExecutionRuntime | undefined;
  let paths = [homedir()];
  let busy = false;
  let unconfirmed = false;
  let checkpointable = false;
  let runtimeState: NonNullable<FactoryExecutionRun["runtime"]> = {
    kind: "codex",
    model: "unknown",
    threadId: null,
    turnId: null,
    containerId: null,
  };
  const publicText = (text: string, limit = 4000) =>
    boundedText(
      paths.reduce((value, path) => value.replaceAll(path, "[private workspace]"), text),
      limit,
    );
  function current() {
    if (prepared === undefined || runtime === undefined)
      throw new FactoryExecutionError("source_unavailable");
    return { ...prepared, runtime };
  }
  function retainStopUncertainty(error: unknown): void {
    if (
      (error instanceof FactoryExecutionError || error instanceof CodexExecutionError) &&
      error.code === "stop_unconfirmed"
    )
      unconfirmed = true;
  }
  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (busy || unconfirmed || pending.size > 0)
      throw new FactoryExecutionError("stop_unconfirmed");
    signal.throwIfAborted();
    busy = true;
    try {
      return await operation();
    } catch (error) {
      retainStopUncertainty(error);
      throw error;
    } finally {
      busy = false;
    }
  }
  const lifecycle = (phase: "implementation" | "verification") => {
    const proof: { name: string | null; id: string | null; stopped: boolean } = {
      name: null,
      id: null,
      stopped: false,
    };
    const callbacks: CodexExecutionLifecycle = {
      beforeContainerCreate: async (name, daemonId) => {
        if (proof.name !== null || pending.size > 0)
          throw new FactoryExecutionError("stop_unconfirmed");
        signal.throwIfAborted();
        // Fence before awaiting the acknowledgement: the transaction may commit even
        // when its response is lost, and another callback must never race this intent.
        proof.name = name;
        pending.add(name);
        await reserveFactoryExecutionContainer(pool, run, name, phase, daemonId);
        signal.throwIfAborted();
      },
      onContainer: async (container) => {
        if (
          proof.name !== container.name ||
          proof.stopped ||
          (proof.id !== null && proof.id !== container.id)
        )
          throw new FactoryExecutionError("stop_unconfirmed");
        proof.id = container.id;
        await identifyFactoryExecutionContainer(pool, run, container);
        if (phase === "implementation") {
          runtimeState = { ...runtimeState, containerId: container.id };
          await saveFactoryExecutionRuntime(pool, run, runtimeState);
        }
      },
      onStopped: async (container) => {
        if (proof.name !== container.name || (proof.id !== null && proof.id !== container.id))
          throw new FactoryExecutionError("stop_unconfirmed");
        await stopFactoryExecutionContainer(pool, run, container);
        pending.delete(container.name);
        proof.stopped = true;
      },
    };
    return {
      callbacks,
      assertStopped() {
        if (proof.name === null || proof.id === null || !proof.stopped || pending.size > 0)
          throw new FactoryExecutionError("stop_unconfirmed");
      },
    };
  };
  return {
    publicText,
    get writerStopped() {
      return !busy && !unconfirmed && pending.size === 0;
    },
    get revision(): FactoryFeatureWorkspace {
      return { ...current().revision };
    },
    async open(): Promise<void> {
      await exclusive(async () => {
        if (prepared !== undefined) return;
        const config = await options.readSourceConfig();
        paths = [
          config.artifactRoot,
          ...config.repositoryRoots.map((root) => root.path),
          homedir(),
        ].sort((left, right) => right.length - left.length);
        if (options.runtime === undefined && !options.containerImage?.trim())
          throw new FactoryExecutionError("sandbox_unavailable");
        runtime =
          options.runtime ??
          createCodexExecutionRuntime({
            containerImage: options.containerImage ?? "",
            timeoutMs: run.plan.limits.attemptTimeoutSeconds * 1000,
            ...(options.dockerExecutable === undefined
              ? {}
              : { dockerExecutable: options.dockerExecutable }),
          });
        prepared = await prepareWorkspace(pool, run, config, signal);
      });
    },
    async implement(input: ImplementationInput) {
      return exclusive(async () => {
        const { workspace, runtime } = current();
        checkpointable = false;
        runtimeState = {
          ...runtimeState,
          model: input.model,
          ...(run.lifecycleProfile == null
            ? {}
            : { lifecycleProfile: lifecycleProfileEvidence(run.lifecycleProfile) }),
          threadId: null,
          turnId: null,
          containerId: null,
        };
        await saveFactoryExecutionRuntime(pool, run, runtimeState);
        const implementation = lifecycle("implementation");
        const result = await runtime.runTurn({
          ...implementation.callbacks,
          ...input,
          cwd: workspace.workspacePath,
          gitDirectory: workspace.gitDirectory,
          requestId: `${run.id}:implementation:${String(input.round)}`,
          signal,
          onActivity: (activity) =>
            input.onActivity({ ...activity, summary: publicText(activity.summary, 2000) }),
          onQuestion: (question) =>
            input.onQuestion({ ...question, question: publicText(question.question) }),
          onThread: async (threadId) => {
            runtimeState = { ...runtimeState, threadId, turnId: null };
            await saveFactoryExecutionRuntime(pool, run, runtimeState);
          },
          onTurn: async (turnId) => {
            runtimeState = { ...runtimeState, turnId };
            await saveFactoryExecutionRuntime(pool, run, runtimeState);
          },
        });
        if (result.effectiveProfile !== undefined) {
          runtimeState = { ...runtimeState, effectiveProfile: result.effectiveProfile };
          await saveFactoryExecutionRuntime(pool, run, runtimeState);
        }
        implementation.assertStopped();
        signal.throwIfAborted();
        checkpointable = true;
        return { text: publicText(result.text, 64_000) };
      });
    },
    async checkpoint(round: number): Promise<void> {
      await exclusive(async () => {
        if (!checkpointable) throw new FactoryExecutionError("stop_unconfirmed");
        const { workspace, revision } = current();
        const candidate = await snapshotFeatureWorkspace(workspace, {
          expectedHead: revision.headCommitId,
          signal,
        });
        const committed = await checkpointFeatureWorkspace(workspace, {
          expectedHead: revision.headCommitId,
          expectedTree: candidate.treeId,
          checkpointId: checkpointId(run.id, round),
          message: `${run.key}: approved implementation (round ${String(round)})`,
          signal,
        });
        signal.throwIfAborted();
        const checkpoint = await recordFactoryExecutionCheckpoint(pool, run, {
          expectedHead: revision.headCommitId,
          ...committed,
        });
        prepared = { workspace, revision: { ...revision, ...checkpoint } };
        checkpointable = false;
      });
    },
    async verify(round: number, position: number): Promise<VerificationFeedback> {
      return exclusive(async () => {
        const commands =
          run.purpose === "feature_verification" || run.purpose === "correction"
            ? run.verificationManifest?.map((entry) => entry.command)
            : run.plan.workItems.find((item) => item.key === run.key)?.verification;
        const command = commands?.[position - 1];
        if (!Number.isInteger(position) || command === undefined)
          throw new FactoryExecutionError("invalid_response");
        const { workspace, revision, runtime } = current();
        if (checkpointable) throw new FactoryExecutionError("revision_changed");
        const committed = { headCommitId: revision.headCommitId, treeId: revision.treeId };
        const started = performance.now();
        let checked: CodexVerificationResult | undefined;
        let checkFailure: FactoryExecutionError | null = null;
        const processId = `${run.id}:verification:${String(round)}:${String(position)}`;
        const verification = lifecycle("verification");
        try {
          // Validate before as well as after the command; a changed workspace may
          // never supply evidence for the retained checkpoint.
          await assertFeatureWorkspaceSnapshot(workspace, committed, { signal });
          checked = await runtime.runVerification({
            ...verification.callbacks,
            workspaceCwd: workspace.workspacePath,
            gitDirectory: workspace.gitDirectory,
            cwd: command.cwd,
            command: [command.program, ...command.args],
            processId,
            timeoutMs: Math.max(
              1,
              Math.min(command.timeoutSeconds * 1000, options.deadline - Date.now()),
            ),
            signal,
          });
          verification.assertStopped();
          if (checked.processId !== processId) throw new FactoryExecutionError("invalid_response");
          await assertFeatureWorkspaceSnapshot(workspace, committed, { signal });
        } catch (error) {
          // Record proof loss before cancellation translation or an evidence-write
          // failure can replace the original error.
          retainStopUncertainty(error);
          checkFailure = factoryExecutionFailure(error, signal, true);
        }
        const outcome =
          checkFailure?.code === "timeout"
            ? "timeout"
            : checkFailure?.code === "cancelled" || checkFailure?.code === "interrupted"
              ? "cancelled"
              : checkFailure?.code === "revision_changed"
                ? "failed"
                : checkFailure !== null
                  ? "unavailable"
                  : checked?.exitCode === 0
                    ? "passed"
                    : "failed";
        const stdout = publicText(checked?.stdout ?? "", 8192);
        const stderr = publicText(checked?.stderr ?? "", 8192);
        await saveFactoryVerification(pool, run, {
          round,
          position,
          command,
          ...committed,
          outcome,
          exitCode: checked?.exitCode ?? null,
          stdout,
          stderr,
          stdoutTruncated:
            checked?.stdoutTruncated === true || Buffer.byteLength(checked?.stdout ?? "") > 8192,
          stderrTruncated:
            checked?.stderrTruncated === true || Buffer.byteLength(checked?.stderr ?? "") > 8192,
          durationMs: checked?.durationMs ?? Math.round(performance.now() - started),
        });
        if (checkFailure !== null) throw checkFailure;
        return {
          position,
          outcome,
          exitCode: checked?.exitCode ?? null,
          stdout: boundedText(stdout, 2048),
          stderr: boundedText(stderr, 2048),
        };
      });
    },
    async assertRevision(): Promise<void> {
      await exclusive(async () => {
        const { workspace, revision } = current();
        await assertFeatureWorkspaceSnapshot(workspace, revision, { signal });
      });
    },
  };
}

/** Restart recovery uses durable identity and stop fences; it never replays a turn. */
export function reconcileFactorySandboxes(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  options: { dockerExecutable?: string } = {},
): Promise<void> {
  return reconcileFactoryExecutions(pool, boss, createCodexExecutionContainerRecovery(options));
}
