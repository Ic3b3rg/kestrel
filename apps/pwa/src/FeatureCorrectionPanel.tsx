import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  FactoryConceptualReviewWorkflowRead,
  FactoryReviewCorrection,
} from "@kestrel/contracts";
import { AlertTriangle, CheckCircle2, RotateCw, Wrench } from "lucide-react";

import {
  fetchCurrentFactoryReviewCorrection,
  requestFactoryReviewCorrection,
  retryFactoryReviewCorrection,
} from "./factory-review-corrections-api.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { Button } from "./components/ui/button.js";
import { Checkbox } from "./components/ui/checkbox.js";
import { Textarea } from "./components/ui/textarea.js";

const activeStates: FactoryReviewCorrection["state"][] = [
  "executing",
  "gated",
  "publishing",
  "blocked",
  "uncertain",
  "reviewing",
];

const progressCopy: Record<FactoryReviewCorrection["state"], string> = {
  executing: "Applying only the correction you authorized, then running every approved check.",
  gated: "The correction needs a Human Gate decision before it can continue.",
  publishing: "Checks passed. Updating the same pull request and retaining the new exact head.",
  blocked:
    "Publication stopped with a known failure. Inspect it, then retry when the cause is resolved.",
  uncertain:
    "The provider write outcome is uncertain. Kestrel will reconcile the exact branch head before another write.",
  reviewing: "The corrected revision is retained. Its replacement Conceptual Review is running.",
  completed: "The corrected revision and its replacement Conceptual Review are ready.",
  failed: "The replacement review failed visibly. The corrected revision remains retained.",
  cancelled: "The Feature was cancelled, so this correction will not continue.",
};

export interface FeatureCorrectionPanelProps {
  projectId: string;
  featureId: string;
  approvedVersion: number;
  review: FactoryConceptualReviewWorkflowRead;
  online: boolean;
  onAuthenticationError: (error: unknown) => boolean;
  onReplacementReview: () => void;
  loadCurrent?: typeof fetchCurrentFactoryReviewCorrection;
  requestCorrection?: typeof requestFactoryReviewCorrection;
  retryCorrection?: typeof retryFactoryReviewCorrection;
}

export function FeatureCorrectionPanel({
  projectId,
  featureId,
  approvedVersion,
  review,
  online,
  onAuthenticationError,
  onReplacementReview,
  loadCurrent = fetchCurrentFactoryReviewCorrection,
  requestCorrection = requestFactoryReviewCorrection,
  retryCorrection = retryFactoryReviewCorrection,
}: FeatureCorrectionPanelProps) {
  const findings = useMemo(
    () => review.artifact?.graph.problems.filter((problem) => problem.type === "finding") ?? [],
    [review.artifact],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [instruction, setInstruction] = useState("");
  const [correction, setCorrection] = useState<FactoryReviewCorrection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const instructionId = useId();
  const instructionCountId = `${instructionId}-count`;
  const requestId = useRef<string | null>(null);
  const announcedCompletion = useRef<string | null>(null);

  const read = useCallback(async () => {
    if (!online) return;
    try {
      const current = await loadCurrent(projectId, featureId);
      setCorrection(current.correction);
      setError(null);
      if (
        current.correction?.state === "completed" &&
        current.correction.replacementReview?.artifactId !== null &&
        announcedCompletion.current !== current.correction.id
      ) {
        announcedCompletion.current = current.correction.id;
        onReplacementReview();
      }
    } catch (failure) {
      if (!onAuthenticationError(failure))
        setError(planningRequestError(failure, "The correction status is unavailable."));
    }
  }, [featureId, loadCurrent, onAuthenticationError, onReplacementReview, online, projectId]);

  useEffect(() => {
    void read();
  }, [read]);

  const active = correction !== null && activeStates.includes(correction.state);
  useEffect(() => {
    if (!online || !active) return;
    const timer = window.setInterval(() => void read(), 1_000);
    return () => window.clearInterval(timer);
  }, [active, online, read]);

  const sourceReviewAlreadyUsed =
    correction !== null && correction.sourceReview.artifactId === review.artifact?.id;
  const canRequest = !active && !sourceReviewAlreadyUsed;

  const submit = async () => {
    if (!online || busy || active || review.artifact === null || instruction.trim().length === 0)
      return;
    setBusy(true);
    setError(null);
    const durableRequestId = requestId.current ?? crypto.randomUUID();
    requestId.current = durableRequestId;
    try {
      const result = await requestCorrection(projectId, featureId, {
        requestId: durableRequestId,
        expectedPlanVersion: approvedVersion,
        review: {
          workflowId: review.workflow.id,
          artifactId: review.artifact.id,
          headCommitId: review.artifact.headCommitId,
        },
        instruction: instruction.trim(),
        findingIds: findings.filter(({ id }) => selected.has(id)).map(({ id }) => id),
      });
      setCorrection(result);
      requestId.current = null;
    } catch (failure) {
      if (!onAuthenticationError(failure))
        setError(planningRequestError(failure, "The correction was not started."));
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!online || busy || correction === null || !correction.canRetry) return;
    setBusy(true);
    setError(null);
    try {
      setCorrection(
        await retryCorrection(projectId, featureId, correction.id, {
          requestId: crypto.randomUUID(),
        }),
      );
    } catch (failure) {
      if (!onAuthenticationError(failure))
        setError(planningRequestError(failure, "The correction retry was not queued."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4"
      aria-label="Request review correction"
    >
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Wrench className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold">Request a bounded correction</h3>
          <p className="text-sm text-muted-foreground">
            Describe the defect to fix and optionally select findings from this exact review. The
            approved requirements, acceptance criteria, checks, limits, pull request, and plan stay
            fixed. A required product decision stops at a Human Gate.
          </p>
        </div>
      </div>

      {canRequest ? (
        <div className="grid gap-3">
          {findings.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              This review has no verified findings. You can still describe a concrete technical
              correction.
            </p>
          ) : (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Findings to include</legend>
              {findings.map((finding) => {
                const checked = selected.has(finding.id);
                return (
                  <label
                    key={finding.id}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-background p-3"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(next) => {
                        setSelected((current) => {
                          const updated = new Set(current);
                          if (next === true) updated.add(finding.id);
                          else updated.delete(finding.id);
                          return updated;
                        });
                      }}
                      aria-label={`Include finding: ${finding.title}`}
                    />
                    <span className="min-w-0 text-sm">
                      <span className="block font-medium">{finding.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {finding.riskLevel} risk · {finding.condition}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
          <div className="grid gap-1.5">
            <label htmlFor={instructionId} className="text-sm font-medium">
              Correction request
            </label>
            <Textarea
              id={instructionId}
              aria-describedby={instructionCountId}
              value={instruction}
              maxLength={4_000}
              rows={4}
              placeholder="What should change in the implementation while keeping the approved behavior fixed?"
              disabled={!online || busy}
              onChange={(event) => setInstruction(event.target.value)}
            />
            <span
              id={instructionCountId}
              className="text-right text-xs font-normal text-muted-foreground"
            >
              {instruction.length}/4000
            </span>
          </div>
          <Button
            type="button"
            className="w-fit"
            disabled={!online || busy || instruction.trim().length === 0}
            onClick={() => void submit()}
          >
            {busy ? "Starting correction…" : "Apply correction and review again"}
          </Button>
        </div>
      ) : null}

      {correction === null ? null : (
        <div
          className="rounded-lg border border-border bg-background p-3"
          aria-live="polite"
          data-correction-state={correction.state}
        >
          <p className="flex items-center gap-2 text-sm font-medium">
            {correction.state === "completed" ? (
              <CheckCircle2 className="size-4 text-emerald-400" aria-hidden="true" />
            ) : ["gated", "blocked", "uncertain", "failed", "cancelled"].includes(
                correction.state,
              ) ? (
              <AlertTriangle className="size-4 text-amber-300" aria-hidden="true" />
            ) : (
              <RotateCw className="size-4 animate-spin" aria-hidden="true" />
            )}
            {correction.state.replaceAll("_", " ")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{progressCopy[correction.state]}</p>
          {correction.failure === null ? null : (
            <p className="mt-2 text-xs text-muted-foreground">
              Reason: {correction.failure.replaceAll("_", " ")}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {correction.canRetry ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void retry()}
              >
                Retry publication
              </Button>
            ) : null}
            {correction.state === "completed" ? (
              <Button type="button" size="sm" onClick={onReplacementReview}>
                Open replacement review
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
