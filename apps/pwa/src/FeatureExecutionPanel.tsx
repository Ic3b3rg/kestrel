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

const phaseLabels: Record<FactoryExecution["state"], string> = {
  not_approved: "Execution starts after plan approval",
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
    "Verification failed. This attempt has not confirmed the Work Item's acceptance outcomes.",
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

function RunDetails({ run }: { run: FactoryExecutionRun }) {
  return (
    <div className="min-w-0 space-y-4 rounded-md border bg-muted/30 p-3">
      <p className="text-sm font-medium">Approved plan · version {run.approvedVersion}</p>
      <ExecutionProblem failure={run.failure} question={run.question} />
      {run.gate == null ? null : <GateAnswer gate={run.gate} />}
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
      {run.runtime === null ? null : (
        <p className="break-words text-sm text-muted-foreground">
          Codex · {displayText(run.runtime.model)}
        </p>
      )}
      <section className="space-y-2">
        <h5 className="text-sm font-semibold">Attempt activity</h5>
        {run.activity.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
        ) : (
          <ol className="factory-activity">
            {run.activity.map((event) => (
              <li key={event.id}>
                <p className="whitespace-pre-wrap break-words">{displayText(event.summary)}</p>
                <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

export interface FeatureExecutionPanelProps {
  projectId: string;
  featureId: string;
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
          result.workItems.some((item) => item.runs.some(pendingRun));
        if (selectedRunId !== null) {
          const selected = result.workItems
            .flatMap((item) => item.runs)
            .find((item) => item.id === selectedRunId);
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
            if (detail.workItemId !== selected.workItemId)
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
  }, [projectId, featureId, active, generation, selectedRunId, onAuthenticationError]);
  const stopUnconfirmed =
    execution?.failure === "stop_unconfirmed" ||
    execution?.workItems.some((item) =>
      item.runs.some(
        (attempt) =>
          !attempt.writerStopped && ["blocked", "cancelled", "interrupted"].includes(attempt.state),
      ),
    ) === true;
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
        <p role="alert" className="planning-error">
          {error}
        </p>
      )}
      {execution === null ? null : (
        <>
          <p role="status" className="font-medium">
            {execution.state === "cancelled" && stopUnconfirmed
              ? "Cancellation requested"
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
                                <RunDetails run={run} />
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
