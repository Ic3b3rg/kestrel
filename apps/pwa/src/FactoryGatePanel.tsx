import { useEffect, useId, useRef, useState } from "react";
import type { FactoryGate, ResolveFactoryGateCommand } from "@kestrel/contracts";
import { ApiClientError } from "./api.js";
import { resolveFactoryGate } from "./factory-execution-api.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { Button } from "./components/ui/button.js";

const blockedText: Record<NonNullable<FactoryGate["resumeBlockedReason"]>, string> = {
  unconfirmed_stop:
    "The execution environment must be confirmed stopped before another attempt can start.",
  workspace_uncertain:
    "The source or saved revision has changed. A text answer cannot confirm that workspace; inspect the retained attempt before replanning.",
  cancelled:
    "This feature was cancelled. Its attempts and answers remain available for inspection.",
  stale_gate:
    "This gate no longer controls the current attempt. Refresh execution to see its latest state.",
  attempt_limit:
    "This execution has reached its attempt limit. Inspect the retained work before replanning.",
  plan_change_required:
    "The approved plan must change. This feature stays paused. For now, cancel this feature and start a new plan with the required changes; approve that plan before execution.",
  already_resolved: "An answer has already been recorded for this gate.",
};

export function GateAnswer({ gate }: { gate: FactoryGate }) {
  if (gate.resolution === null) return null;
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">Answer saved · plan version {gate.approvedVersion}</p>
      {gate.purpose === "feature_verification" ? (
        <p>Only final verification resumes. Verified Work Item implementations are retained.</p>
      ) : null}
      <p className="whitespace-pre-wrap break-words">{gate.resolution.answer}</p>
      <p className="text-muted-foreground">
        {gate.resumeBlockedReason === "cancelled"
          ? blockedText.cancelled
          : gate.resolution.decision === "requires_plan_change"
            ? blockedText.plan_change_required
            : gate.successorRunId !== null
              ? "One follow-up attempt was created from this answer."
              : "One follow-up attempt is authorized within the approved plan and will start when the Project queue is ready."}
      </p>
    </div>
  );
}

export function FactoryGatePanel({
  projectId,
  gate,
  active,
  onResolved,
  onAuthenticationError,
}: {
  projectId: string;
  gate: FactoryGate;
  active: boolean;
  onResolved: () => void;
  onAuthenticationError: (error: unknown) => boolean;
}) {
  const id = useId();
  const [answer, setAnswer] = useState("");
  const [decision, setDecision] =
    useState<ResolveFactoryGateCommand["decision"]>("resume_within_plan");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<FactoryGate | null>(null);
  const pending = useRef<ResolveFactoryGateCommand | null>(null);
  const submitting = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const current = gate.resolution === null ? (confirmed ?? gate) : gate;
  const canAnswer = ![
    "cancelled",
    "stale_gate",
    "already_resolved",
    "plan_change_required",
  ].includes(current.resumeBlockedReason ?? "");
  const send = async () => {
    if (!active || !canAnswer || submitting.current || current.resolution !== null) return;
    const command = pending.current ?? {
      requestId: crypto.randomUUID(),
      expectedPlanVersion: gate.approvedVersion,
      decision,
      answer: answer.trim(),
    };
    if (!command.answer || (command.decision === "resume_within_plan" && !gate.canResume)) return;
    pending.current = command;
    submitting.current = true;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(null);
    try {
      const result = await resolveFactoryGate(
        projectId,
        gate.featureId,
        gate.id,
        command,
        request.signal,
      );
      if (request.signal.aborted) return;
      pending.current = null;
      setConfirmed(result);
      onResolved();
    } catch (failure) {
      if (request.signal.aborted) return;
      if (
        failure instanceof ApiClientError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        failure.status !== 408
      )
        pending.current = null;
      if (!onAuthenticationError(failure))
        setError(
          planningRequestError(
            failure,
            "The answer could not be confirmed. Retry sending the same answer to check its outcome.",
          ),
        );
    } finally {
      submitting.current = false;
      if (!request.signal.aborted) setBusy(false);
    }
  };
  return (
    <section
      aria-label="Human gate"
      className="min-w-0 space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4"
    >
      {gate.purpose === "feature_verification" ? (
        <p className="text-sm font-medium">
          Final Feature verification · plan version {gate.approvedVersion}
        </p>
      ) : null}
      <h4 className="font-semibold">
        {current.resolution !== null
          ? "Recorded decision"
          : canAnswer
            ? "Your decision is needed"
            : "Retained question"}
      </h4>
      <p className="whitespace-pre-wrap break-words font-medium">{gate.question}</p>
      <p className="text-sm text-muted-foreground">
        {canAnswer && current.resolution === null
          ? "This feature holds its Project queue. Other projects can continue. Your answer applies to "
          : "This question belongs to "}
        approved plan version {gate.approvedVersion}.
      </p>
      {current.resolution !== null ? (
        <GateAnswer gate={current} />
      ) : !canAnswer ? (
        <p className="text-sm">
          {current.resumeBlockedReason === null ? null : blockedText[current.resumeBlockedReason]}
        </p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {gate.resumeBlockedReason === null ? null : (
            <p className="text-sm">{blockedText[gate.resumeBlockedReason]}</p>
          )}
          <div className="space-y-1">
            <label htmlFor={`${id}-decision`} className="block text-sm font-medium">
              What should happen next?
            </label>
            <select
              id={`${id}-decision`}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-ring"
              value={decision}
              disabled={!active || busy || pending.current !== null}
              onChange={(event) =>
                setDecision(
                  event.target.value === "requires_plan_change"
                    ? "requires_plan_change"
                    : "resume_within_plan",
                )
              }
            >
              <option value="resume_within_plan">Continue within the approved plan</option>
              <option value="requires_plan_change">
                Requirements or authorized limits must change
              </option>
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-answer`} className="block text-sm font-medium">
              Your answer
            </label>
            <textarea
              id={`${id}-answer`}
              className="min-h-28 w-full rounded-md border bg-background p-3 text-sm focus-visible:outline-ring disabled:opacity-60"
              maxLength={4000}
              required
              value={answer}
              disabled={!active || busy || pending.current !== null}
              onChange={(event) => setAnswer(event.target.value)}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {decision === "requires_plan_change"
              ? "Record what must change. Execution will stay paused; this does not approve a new scope."
              : "Clarify the technical choice or confirm the problem is resolved. Requirements, checks and authorized limits remain those in the approved plan."}
          </p>
          {error === null ? null : (
            <p role="alert" className="planning-error">
              {error}
            </p>
          )}
          <Button
            type="submit"
            disabled={
              !active ||
              busy ||
              answer.trim() === "" ||
              (decision === "resume_within_plan" && !gate.canResume)
            }
          >
            {busy
              ? "Saving answer…"
              : pending.current !== null
                ? "Retry sending answer"
                : decision === "requires_plan_change"
                  ? "Record required plan change"
                  : "Save answer and resume"}
          </Button>
        </form>
      )}
    </section>
  );
}
