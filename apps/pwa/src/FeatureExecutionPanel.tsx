import { FormFeedback } from "./components/FormFeedback.js";
import { LifecycleProfileRecord } from "./LifecycleProfileRecord.js";
import { useContext, useEffect, useId, useRef, useState } from "react";
import type {
  FactoryExecution,
  FactoryExecutionFailure,
  FactoryExecutionRevision,
  FactoryExecutionRun,
  FactoryExecutionRunSummary,
  FactoryVerificationResult,
} from "@kestrel/contracts";
import { InvalidServerResponseError } from "./api.js";
import { fetchFactoryExecution, fetchFactoryExecutionRun } from "./factory-execution-api.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { Button } from "./components/ui/button.js";
import { WorkspaceSuspendedContext } from "./components/ui/workspace-suspension.js";
import { FactoryGatePanel, GateAnswer } from "./FactoryGatePanel.js";

type FactoryVerificationCommand = FactoryExecutionRun["acceptedCommands"][number];
type ExecutionActivity = FactoryExecutionRun["activity"][number];

const phaseLabels: Record<FactoryExecution["state"], string> = {
  not_approved: "No execution has been authorized",
  pending: "Waiting to start execution",
  running: "Implementing the approved plan",
  stopping: "Stopping execution",
  blocked: "Execution needs attention",
  verified: "Implementation verified",
  cancelled: "Execution cancelled",
};
const runLabels: Record<FactoryExecutionRunSummary["state"], string> = {
  queued: "Queued",
  running: "Implementing",
  verifying: "Verifying",
  stopping: "Stopping",
  verified: "Verified",
  blocked: "Needs attention",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};
const failureText: Record<FactoryExecutionFailure, string> = {
  unavailable: "Codex could not be reached. Check the runtime on this computer.",
  authentication: "Sign in to Codex on this computer to restore access.",
  usage_limit: "The Codex usage limit was reached. Check when usage becomes available again.",
  sandbox_unavailable:
    "Docker or the required execution image is unavailable or incompatible. Restore the execution environment before continuing.",
  source_unavailable:
    "The approved source is unavailable. Restore the Project's source connection.",
  source_changed: "The repository identity changed. Check its source against the approved plan.",
  permission_required:
    "Execution needs permission beyond the approved scope. Review the question before authorizing more work.",
  input_required: "An Operator decision is needed before work can continue.",
  timeout: "The approved time limit was reached. Review this attempt before continuing.",
  cancelled: "Cancellation was requested. The saved work remains available for inspection.",
  interrupted: "Execution was interrupted. Inspect the saved attempt before continuing.",
  invalid_response:
    "The runtime returned an invalid result. Successful implementation has not been confirmed.",
  verification_failed:
    "Verification failed. This attempt has not confirmed the approved acceptance outcomes.",
  revision_changed:
    "Files changed while verification was being recorded. These checks do not confirm the current revision.",
  stop_unconfirmed:
    "Environment stop is unconfirmed. Kestrel keeps this Project reserved until the execution environment is confirmed stopped.",
};
const outcomeLabels: Record<FactoryVerificationResult["outcome"], string> = {
  passed: "Passed",
  failed: "Failed",
  timeout: "Timed out",
  cancelled: "Cancelled",
  unavailable: "Unavailable",
};

function displayText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10) ||
      (code >= 127 && code <= 159) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : character;
  }).join("");
}

function ExecutionProblem({
  failure,
  question,
}: {
  failure: FactoryExecutionFailure | null;
  question: string | null;
}) {
  if (failure === null && question === null) return null;
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted p-3 text-sm">
      {failure === null ? null : <p>{failureText[failure]}</p>}
      {question === null ? null : (
        <p className="whitespace-pre-wrap break-words font-medium">{displayText(question)}</p>
      )}
    </div>
  );
}

function Revision({ revision }: { revision: FactoryExecutionRevision }) {
  return (
    <dl className="grid min-w-0 gap-2 text-sm">
      <div>
        <dt className="text-muted-foreground">Branch</dt>
        <dd className="break-all">{displayText(revision.branch)}</dd>
      </div>
      {(
        [
          ["Base commit", revision.baseCommitId],
          ["Head commit", revision.headCommitId],
          ["Tree", revision.treeId],
        ] as const
      ).map(([label, value]) => (
        <div key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-all font-mono text-xs">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Command({ command }: { command: FactoryVerificationCommand }) {
  return (
    <div className="min-w-0 space-y-2">
      <pre className="max-w-full whitespace-pre-wrap break-all rounded-md border bg-background p-3 text-xs">
        <code>{displayText(JSON.stringify([command.program, ...command.args]))}</code>
      </pre>
      <p className="break-words text-sm text-muted-foreground">
        Directory: <code>{displayText(command.cwd)}</code> · Timeout: {command.timeoutSeconds}{" "}
        seconds
      </p>
    </div>
  );
}

function VerificationResult({ result }: { result: FactoryVerificationResult }) {
  return (
    <li className="min-w-0 space-y-3 rounded-md border p-3">
      <p className="font-medium">
        Round {result.round} · Check {result.position} · {outcomeLabels[result.outcome]}
      </p>
      <Command command={result.command} />
      <p className="text-sm">
        {result.exitCode === null
          ? "No exit code recorded"
          : `Exit code ${String(result.exitCode)}`}{" "}
        · {result.durationMs} ms
      </p>
      <details className="min-w-0">
        <summary className="cursor-pointer rounded-sm text-sm focus-visible:outline focus-visible:outline-ring">
          Captured output and revision
        </summary>
        <div className="mt-3 min-w-0 space-y-3">
          {(
            [
              ["stdout", result.stdout, result.stdoutTruncated],
              ["stderr", result.stderr, result.stderrTruncated],
            ] as const
          ).map(([stream, output, truncated]) => (
            <div key={stream} className="min-w-0 space-y-1">
              <p className="text-sm font-medium">{stream}</p>
              <pre
                className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-background p-3 text-xs"
                tabIndex={0}
                aria-label={`${stream} for round ${String(result.round)} check ${String(result.position)}`}
              >
                <code>{output === "" ? `No ${stream} captured.` : displayText(output)}</code>
              </pre>
              {truncated ? (
                <p className="text-sm text-muted-foreground">
                  Output truncated ({stream}); only the retained portion is shown.
                </p>
              ) : null}
              {displayText(output) !== output ? (
                <p className="text-sm text-muted-foreground">
                  Control characters are shown as escapes.
                </p>
              ) : null}
            </div>
          ))}
          <dl className="grid gap-2 text-xs">
            <div>
              <dt className="text-muted-foreground">Checked head commit</dt>
              <dd className="break-all font-mono">{result.headCommitId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Checked tree</dt>
              <dd className="break-all font-mono">{result.treeId}</dd>
            </div>
          </dl>
        </div>
      </details>
    </li>
  );
}

function ActivityEntry({ event }: { event: ExecutionActivity }) {
  return (
    <li className="min-w-0 border-b border-border/60 py-2 text-sm last:border-b-0">
      <p className="whitespace-pre-wrap break-words font-medium">{displayText(event.summary)}</p>
      {event.itemState === "started" ? <p className="text-muted-foreground">Running…</p> : null}
      {event.itemState === "failed" ? <p className="text-destructive">Failed</p> : null}
      {event.exitCode === undefined ? null : <p>Exit code {event.exitCode}</p>}
      {event.detail === undefined ? null : (
        <details className="min-w-0">
          <summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-ring">
            Output
          </summary>
          <pre
            className="mt-2 max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs"
            tabIndex={0}
          >
            <code>{displayText(event.detail)}</code>
          </pre>
        </details>
      )}
      <time className="text-xs text-muted-foreground" dateTime={event.createdAt}>
        {new Date(event.createdAt).toLocaleString()}
      </time>
    </li>
  );
}

function CommandGroup({ events }: { events: ExecutionActivity[] }) {
  const running = events.some((event) => event.itemState === "started");
  return (
    <li className="min-w-0 border-b border-border/60 py-2 text-sm last:border-b-0">
      <details className="min-w-0">
        <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline focus-visible:outline-ring">
          {running ? "Running" : "Ran"}{" "}
          {events.length === 1 ? "a command" : `${String(events.length)} commands`}
          {events.length === 1 ? ` · ${displayText(events[0]?.summary.split("\n")[0] ?? "")}` : ""}
        </summary>
        <ol className="mt-2 space-y-2 border-l border-border pl-3">
          {events.map((event) => (
            <li key={event.id} className="min-w-0">
              <details>
                <summary className="cursor-pointer break-all font-mono text-xs focus-visible:outline focus-visible:outline-ring">
                  {displayText(event.summary.split("\n")[0] ?? "Command")}
                  {event.itemState === "started"
                    ? " · running"
                    : event.exitCode === undefined
                      ? ""
                      : ` · exit ${String(event.exitCode)}`}
                </summary>
                <div className="mt-2 min-w-0 space-y-2">
                  <pre
                    className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs"
                    tabIndex={0}
                  >
                    <code>{displayText(event.summary)}</code>
                  </pre>
                  {event.detail === undefined ? null : (
                    <pre
                      className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs"
                      tabIndex={0}
                    >
                      <code>{displayText(event.detail)}</code>
                    </pre>
                  )}
                </div>
              </details>
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

function TimelineItems({
  events,
  parentPath,
}: {
  events: ExecutionActivity[];
  parentPath: string;
}) {
  const seen = new Set<string>();
  const entries: Array<
    | { kind: "event"; event: ExecutionActivity }
    | { kind: "commands"; events: ExecutionActivity[] }
    | { kind: "agent"; path: string }
  > = [];
  for (const event of events) {
    const path = event.agentPath ?? "/root";
    if (path === parentPath) {
      if (event.kind === "command") {
        const previous = entries.at(-1);
        if (previous?.kind === "commands") previous.events.push(event);
        else entries.push({ kind: "commands", events: [event] });
      } else if (event.kind !== "subagent") entries.push({ kind: "event", event });
      continue;
    }
    if (!path.startsWith(`${parentPath}/`)) continue;
    const segment = path.slice(parentPath.length + 1).split("/")[0];
    if (!segment) continue;
    const childPath = `${parentPath}/${segment}`;
    if (seen.has(childPath)) continue;
    seen.add(childPath);
    entries.push({ kind: "agent", path: childPath });
  }
  return (
    <>
      {entries.map((entry) => {
        if (entry.kind === "event")
          return <ActivityEntry key={entry.event.id} event={entry.event} />;
        if (entry.kind === "commands")
          return <CommandGroup key={entry.events[0]?.id} events={entry.events} />;
        const lifecycle = events.filter(
          (event) => event.kind === "subagent" && event.agentPath === entry.path,
        );
        const status = lifecycle.some((event) => event.itemState === "failed")
          ? "Failed"
          : lifecycle.some((event) => event.itemState === "completed")
            ? "Completed"
            : "Working";
        const name = entry.path.split("/").at(-1) ?? "agent";
        return (
          <li key={entry.path} className="min-w-0 rounded-md border bg-background p-3 text-sm">
            <details className="min-w-0">
              <summary className="cursor-pointer break-words rounded-sm font-medium focus-visible:outline focus-visible:outline-ring">
                Subagent {displayText(name)} · {status}
              </summary>
              <ol className="mt-3 grid min-w-0 gap-2">
                <TimelineItems events={events} parentPath={entry.path} />
              </ol>
            </details>
          </li>
        );
      })}
    </>
  );
}

function RunDetails({
  run,
  conversation = false,
}: {
  run: FactoryExecutionRun;
  conversation?: boolean;
}) {
  const live = ["queued", "running", "verifying", "stopping"].includes(run.state);
  const completedItems = new Set(
    run.activity.filter((event) => event.itemState === "completed").map((event) => event.itemId),
  );
  const liveActivity = run.activity.filter(
    (event) =>
      event.itemState !== "started" ||
      event.itemId === undefined ||
      !completedItems.has(event.itemId),
  );
  const latestRound = Math.max(0, ...run.verification.map((check) => check.round));
  const latestChecks = run.verification.filter((check) => check.round === latestRound);
  const passedChecks = latestChecks.filter((check) => check.outcome === "passed").length;
  return (
    <div
      className={
        conversation ? "issue-run space-y-4" : "min-w-0 space-y-4 rounded-md border bg-muted/30 p-3"
      }
    >
      {live || conversation ? (
        <section className="space-y-2" aria-label="Live activity">
          {conversation ? null : <h5 className="text-sm font-semibold">Live activity</h5>}
          {liveActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
          ) : (
            <ol className="grid min-w-0 gap-2" aria-live="polite">
              <TimelineItems events={liveActivity} parentPath="/root" />
            </ol>
          )}
        </section>
      ) : null}
      {live ? null : (
        <div className="space-y-2 rounded-md border bg-background p-3">
          <h5 className="text-sm font-semibold">Result</h5>
          <p className="whitespace-pre-wrap break-words text-sm">
            {displayText(
              run.finalSummary ??
                (run.failure === null
                  ? run.state === "verified"
                    ? "Implementation verified."
                    : "This attempt ended before verification."
                  : failureText[run.failure]),
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            {latestChecks.length === 0
              ? "No checks were completed."
              : `${String(passedChecks)} of ${String(latestChecks.length)} checks passed in the latest round.`}
          </p>
        </div>
      )}
      <ExecutionProblem failure={live ? run.failure : null} question={run.question} />
      {run.gate == null ? null : <GateAnswer gate={run.gate} />}
      <details open={!conversation}>
        <summary className="cursor-pointer text-sm text-muted-foreground">
          Checks and execution details
        </summary>
        <p className="text-sm text-muted-foreground">
          {run.writerStopped
            ? "Execution environment stopped."
            : "Execution environment stop has not been confirmed."}
        </p>
        <section className="space-y-2">
          <h5 className="text-sm font-semibold">Accepted verification commands</h5>
          <ol className="grid gap-3">
            {run.acceptedCommands.map((command, index) => (
              <li key={index}>
                {run.purpose !== "feature_verification" ? null : (
                  <p className="mb-2 break-words text-sm text-muted-foreground">
                    {run.verificationManifest[index]?.origins
                      .map(
                        (origin) =>
                          `${displayText(origin.workItemKey)} · command ${String(origin.position)}`,
                      )
                      .join("; ")}
                  </p>
                )}
                <Command command={command} />
              </li>
            ))}
          </ol>
        </section>
        <section className="space-y-2">
          <h5 className="text-sm font-semibold">Verification results</h5>
          {run.verification.length === 0 ? (
            <p className="text-sm text-muted-foreground">No verification results recorded yet.</p>
          ) : (
            <ol className="grid gap-3">
              {run.verification.map((result) => (
                <VerificationResult key={result.id} result={result} />
              ))}
            </ol>
          )}
        </section>
        {run.revision === null ? null : (
          <details>
            <summary className="cursor-pointer rounded-sm text-sm focus-visible:outline focus-visible:outline-ring">
              Attempt revision
            </summary>
            <div className="mt-3">
              <Revision revision={run.revision} />
            </div>
          </details>
        )}
        {run.runtime?.lifecycleProfile == null ? null : (
          <LifecycleProfileRecord
            profile={run.runtime.lifecycleProfile}
            effective={run.runtime.effectiveProfile}
          />
        )}
        {run.runtime === null ? null : (
          <p className="break-words text-sm text-muted-foreground">
            Codex · {displayText(run.runtime.model)}
          </p>
        )}
        <details>
          <summary className="cursor-pointer rounded-sm text-sm focus-visible:outline focus-visible:outline-ring">
            Plan and attempt details
          </summary>
          <p className="mt-2 text-sm">Approved plan · version {run.approvedVersion}</p>
        </details>
      </details>
    </div>
  );
}

export interface FeatureExecutionPanelProps {
  projectId: string;
  featureId: string;
  conversation?: boolean;
  online?: boolean;
  onGateResolved?: () => void;
  onAuthenticationError?: (error: unknown) => boolean;
}

const ignoreAuthenticationError = () => false;

function pendingRun(run: FactoryExecutionRunSummary): boolean {
  return ["queued", "running", "verifying", "stopping"].includes(run.state) || !run.writerStopped;
}

function ExecutionPanel({
  projectId,
  featureId,
  online = true,
  conversation = false,
  onGateResolved,
  onAuthenticationError = ignoreAuthenticationError,
}: FeatureExecutionPanelProps) {
  const suspended = useContext(WorkspaceSuspendedContext);
  const [networkOnline, setNetworkOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine,
  );
  const active = online && networkOnline && !suspended;
  const detailId = useId();
  const [execution, setExecution] = useState<FactoryExecution | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const [run, setRun] = useState<FactoryExecutionRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const cachedRun = useRef<FactoryExecutionRun | null>(null);
  useEffect(() => {
    const connected = () => setNetworkOnline(true);
    const disconnected = () => setNetworkOnline(false);
    window.addEventListener("online", connected);
    window.addEventListener("offline", disconnected);
    return () => {
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", disconnected);
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const refresh = async () => {
      setLoading(true);
      setError(null);
      let poll: boolean;
      try {
        const result = await fetchFactoryExecution(projectId, featureId, controller.signal);
        if (controller.signal.aborted) return;
        setExecution(result);
        poll =
          ["pending", "running", "stopping"].includes(result.state) ||
          result.workItems.some((item) => item.runs.some(pendingRun)) ||
          result.finalVerification?.runs.some(pendingRun) === true;
        const summaries = [
          ...result.workItems.flatMap((item) => item.runs),
          ...(result.finalVerification?.runs ?? []),
        ];
        const activeRun = summaries.find(pendingRun);
        const latestVerified = summaries
          .filter((summary) => summary.state === "verified")
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const latest = summaries.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const autoRun = activeRun ?? (conversation ? latest : latestVerified);
        if (
          autoRun !== undefined &&
          autoRun.id !== selectedRunId &&
          (selectedRunId === null || (conversation && followLatest))
        ) {
          setSelectedRunId(autoRun.id);
          return;
        }
        if (selectedRunId !== null) {
          const selected = summaries.find((item) => item.id === selectedRunId);
          if (selected === undefined)
            throw new InvalidServerResponseError(
              "The selected attempt is missing from this Feature",
            );
          const cached = cachedRun.current;
          if (
            cached?.id !== selectedRunId ||
            pendingRun(selected) ||
            cached.state !== selected.state ||
            cached.failure !== selected.failure ||
            cached.writerStopped !== selected.writerStopped ||
            cached.completedAt !== selected.completedAt ||
            cached.gate != null
          ) {
            const detail = await fetchFactoryExecutionRun(
              projectId,
              featureId,
              selectedRunId,
              controller.signal,
            );
            controller.signal.throwIfAborted();
            if (
              detail.workItemId !== selected.workItemId ||
              (detail.purpose ?? "work_item") !== (selected.purpose ?? "work_item")
            )
              throw new InvalidServerResponseError("The server returned a different Work Item");
            cachedRun.current = detail;
            setRun(detail);
          }
        }
      } catch (failure) {
        poll = false;
        if (!controller.signal.aborted && !onAuthenticationError(failure)) {
          setError(
            planningRequestError(
              failure,
              "Execution could not be refreshed. Showing the last confirmed results. Refresh to retry.",
            ),
          );
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
      if (!controller.signal.aborted && poll) timer = window.setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    projectId,
    featureId,
    active,
    generation,
    selectedRunId,
    onAuthenticationError,
    conversation,
    followLatest,
  ]);
  const stopUnconfirmed =
    execution?.failure === "stop_unconfirmed" ||
    [
      ...(execution?.workItems.flatMap((item) => item.runs) ?? []),
      ...(execution?.finalVerification?.runs ?? []),
    ].some(
      (attempt) =>
        !attempt.writerStopped && ["blocked", "cancelled", "interrupted"].includes(attempt.state),
    );
  if (conversation) {
    const attempts = [
      ...(execution?.workItems.flatMap((item) => item.runs) ?? []),
      ...(execution?.finalVerification?.runs ?? []),
    ].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    return (
      <section aria-label="Feature execution" className="issue-activity min-w-0 space-y-4">
        <header className="flex items-center justify-between gap-3">
          <h3 className="font-semibold">Activity</h3>
          <Button
            variant="ghost"
            disabled={!active || loading}
            onClick={() => {
              cachedRun.current = null;
              setGeneration((value) => value + 1);
            }}
          >
            Refresh activity
          </Button>
        </header>
        {error === null ? null : <FormFeedback kind="error">{error}</FormFeedback>}
        {followLatest ? null : (
          <Button variant="ghost" onClick={() => setFollowLatest(true)}>
            Follow current activity
          </Button>
        )}
        <p role="status" className="text-sm text-muted-foreground">
          {execution == null
            ? "Loading activity…"
            : execution.state === "pending"
              ? "Preparing the work…"
              : execution.state === "running"
                ? "Working on this issue…"
                : execution.state === "verified"
                  ? "Implementation checked. Preparing review."
                  : execution.state === "cancelled"
                    ? "Work stopped. Its history is saved."
                    : execution.gate != null
                      ? "A product decision is needed."
                      : "Work paused."}
        </p>
        {execution?.gate == null ? (
          <ExecutionProblem
            failure={execution?.failure ?? null}
            question={execution?.question ?? null}
          />
        ) : (
          <FactoryGatePanel
            projectId={projectId}
            gate={execution.gate}
            active={active}
            onAuthenticationError={onAuthenticationError}
            onResolved={() => {
              cachedRun.current = null;
              setGeneration((value) => value + 1);
              onGateResolved?.();
            }}
          />
        )}
        {run === null ? null : <RunDetails run={run} conversation />}
        {attempts.length === 0 ? null : (
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Attempt history · {attempts.length}
            </summary>
            <ol className="mt-3 space-y-2">
              {attempts.map((attempt) => (
                <li key={attempt.id}>
                  <Button
                    variant="ghost"
                    aria-pressed={selectedRunId === attempt.id}
                    onClick={() => {
                      setFollowLatest(false);
                      setSelectedRunId(attempt.id);
                    }}
                  >
                    Attempt {attempt.attempt} · {runLabels[attempt.state]}
                  </Button>
                </li>
              ))}
            </ol>
          </details>
        )}
      </section>
    );
  }
  return (
    <section
      className="min-w-0 space-y-4 rounded-xl border bg-card p-4 text-card-foreground"
      aria-label="Feature execution"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">Execution</h3>
        <Button
          variant="outline"
          disabled={!active || loading}
          onClick={() => setGeneration((value) => value + 1)}
        >
          Refresh execution
        </Button>
      </header>
      {!active ? (
        <p className="text-sm text-muted-foreground">
          Reconnect to refresh execution. The last confirmed results remain visible.
        </p>
      ) : execution === null && loading ? (
        <p role="status">Loading execution…</p>
      ) : null}
      {error === null ? null : (
        <FormFeedback kind="error" focus className="planning-error">
          {error}
        </FormFeedback>
      )}
      {execution === null ? null : (
        <>
          <p role="status" className="font-medium">
            {execution.state === "cancelled"
              ? stopUnconfirmed
                ? "Cancellation requested"
                : phaseLabels.cancelled
              : execution.finalVerification?.certificate != null
                ? "Final Feature revision verified"
                : execution.state === "running" &&
                    execution.finalVerification?.runs.some(pendingRun)
                  ? "Verifying the cumulative Feature"
                  : phaseLabels[execution.state]}
          </p>
          <ExecutionProblem
            failure={
              execution.gate != null &&
              ["input_required", "permission_required"].includes(execution.failure ?? "")
                ? null
                : execution.failure
            }
            question={execution.gate == null ? execution.question : null}
          />
          {execution.gate == null ? null : (
            <FactoryGatePanel
              key={execution.gate.id}
              projectId={projectId}
              gate={execution.gate}
              active={active}
              onAuthenticationError={onAuthenticationError}
              onResolved={() => {
                cachedRun.current = null;
                setGeneration((value) => value + 1);
                onGateResolved?.();
              }}
            />
          )}
          {!stopUnconfirmed || execution.failure === "stop_unconfirmed" ? null : (
            <ExecutionProblem failure="stop_unconfirmed" question={null} />
          )}
          {execution.state === "pending" || execution.state === "running" ? (
            <p className="text-sm text-muted-foreground">
              Approved work continues on this computer when you leave the page. Work starts when its
              dependencies and the Project queue are ready.
            </p>
          ) : execution.state === "verified" ? (
            <p className="text-sm text-muted-foreground">
              Verified Work Items remain In review until the feature is reviewed and merged.
            </p>
          ) : null}
          {execution.revision === null ? null : (
            <details>
              <summary className="cursor-pointer rounded-sm text-sm focus-visible:outline focus-visible:outline-ring">
                Current feature revision
              </summary>
              <div className="mt-3">
                <Revision revision={execution.revision} />
              </div>
            </details>
          )}
          {execution.finalVerification === undefined ? null : (
            <section
              aria-label="Final Feature verification"
              className="min-w-0 space-y-3 border-t pt-4"
            >
              <h4 className="font-semibold">Final Feature verification</h4>
              {execution.finalVerification.certificate === null ? (
                <p className="text-sm text-muted-foreground">
                  No final verification record yet. Every approved check must pass on the same
                  cumulative revision. Verified Work Items remain In review.
                </p>
              ) : (
                <div className="space-y-2 text-sm">
                  <p>
                    All {execution.finalVerification.certificate.manifest.length} approved checks
                    passed · plan version {execution.finalVerification.certificate.approvedVersion}.
                  </p>
                  <p className="text-muted-foreground">
                    The final verification record is retained. Pull request publication is tracked
                    below.
                  </p>
                  <details>
                    <summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-ring">
                      Certified revision
                    </summary>
                    <div className="mt-3">
                      <Revision revision={execution.finalVerification.certificate.revision} />
                    </div>
                  </details>
                </div>
              )}
              {execution.finalVerification.progress === null ? null : (
                <p role="status" className="text-sm">
                  Pass {execution.finalVerification.progress.round} ·{" "}
                  {execution.finalVerification.progress.checked} of{" "}
                  {execution.finalVerification.progress.total} checks recorded ·{" "}
                  {execution.finalVerification.progress.passed} passed
                </p>
              )}
              {execution.finalVerification.runs.length > 0 ? (
                <ol className="grid min-w-0 gap-2">
                  {execution.finalVerification.runs.map((summary) => (
                    <li key={summary.id} className="min-w-0 space-y-2">
                      <Button
                        variant="outline"
                        className="h-auto w-full justify-start whitespace-normal text-left"
                        aria-expanded={selectedRunId === summary.id}
                        aria-controls={`${detailId}-${summary.id}`}
                        onClick={() => {
                          cachedRun.current = null;
                          setRun(null);
                          setSelectedRunId((selected) =>
                            selected === summary.id ? null : summary.id,
                          );
                        }}
                      >
                        Final attempt {summary.attempt} ·{" "}
                        {summary.state === "running"
                          ? "Repairing within the approved plan"
                          : runLabels[summary.state]}
                      </Button>
                      {selectedRunId !== summary.id ? null : (
                        <section
                          id={`${detailId}-${summary.id}`}
                          aria-label={`Final attempt ${String(summary.attempt)} details`}
                          className="min-w-0"
                        >
                          {run?.id === summary.id ? (
                            <RunDetails run={run} conversation={conversation} />
                          ) : !active ? (
                            <p className="text-sm text-muted-foreground">
                              Reconnect to load attempt details.
                            </p>
                          ) : loading ? (
                            <p role="status">Loading attempt details…</p>
                          ) : (
                            <p className="text-sm text-muted-foreground">
                              Attempt details are unavailable. Refresh to retry.
                            </p>
                          )}
                        </section>
                      )}
                    </li>
                  ))}
                </ol>
              ) : null}
            </section>
          )}
          {execution.workItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No execution attempts yet.</p>
          ) : (
            <ol aria-label="Work Item attempts" className="grid min-w-0 gap-4">
              {execution.workItems.map((item) => (
                <li key={item.id} className="min-w-0 space-y-2">
                  <h4 className="break-words text-sm font-semibold">{displayText(item.key)}</h4>
                  {item.runs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No attempts yet.</p>
                  ) : (
                    <ol className="grid min-w-0 gap-2">
                      {item.runs.map((summary) => (
                        <li key={summary.id} className="min-w-0 space-y-2">
                          <Button
                            variant="outline"
                            className="h-auto w-full flex-wrap justify-between gap-2 whitespace-normal text-left"
                            aria-expanded={selectedRunId === summary.id}
                            aria-controls={
                              selectedRunId === summary.id ? `${detailId}-${summary.id}` : undefined
                            }
                            onClick={() =>
                              setSelectedRunId((current) =>
                                current === summary.id ? null : summary.id,
                              )
                            }
                          >
                            <span>
                              Attempt {summary.attempt} · {runLabels[summary.state]}
                            </span>
                            <time
                              dateTime={summary.createdAt}
                              className="text-xs text-muted-foreground"
                            >
                              {new Date(summary.createdAt).toLocaleString()}
                            </time>
                          </Button>
                          {selectedRunId !== summary.id ? null : (
                            <section
                              id={`${detailId}-${summary.id}`}
                              aria-label={`Attempt ${String(summary.attempt)} details`}
                              className="min-w-0"
                            >
                              {run?.id === summary.id ? (
                                <RunDetails run={run} conversation={conversation} />
                              ) : !active ? (
                                <p className="text-sm text-muted-foreground">
                                  Reconnect to load attempt details.
                                </p>
                              ) : loading ? (
                                <p role="status">Loading attempt details…</p>
                              ) : (
                                <p className="text-sm text-muted-foreground">
                                  Attempt details are unavailable. Refresh to retry.
                                </p>
                              )}
                            </section>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

export function FeatureExecutionPanel(props: FeatureExecutionPanelProps) {
  return <ExecutionPanel key={`${props.projectId}:${props.featureId}`} {...props} />;
}
