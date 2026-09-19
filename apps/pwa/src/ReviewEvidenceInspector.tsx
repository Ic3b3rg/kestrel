import { useEffect, useState } from "react";
import type {
  FactoryConceptualReviewDraft,
  FactoryConceptualReviewSourceLines,
} from "@kestrel/contracts";

import { fetchFactoryConceptualReviewWorkflowSourceLines } from "./conceptual-review-api.js";
import { planningRequestError } from "./FeatureNavigation.js";

export function ReviewEvidenceInspector({
  graph,
  selectedId,
  projectId,
  featureId,
  workflowId,
  loadSourceLines = fetchFactoryConceptualReviewWorkflowSourceLines,
  onAuthenticationError,
}: {
  graph: FactoryConceptualReviewDraft;
  selectedId: string;
  projectId: string;
  featureId: string;
  workflowId: string;
  loadSourceLines?: typeof fetchFactoryConceptualReviewWorkflowSourceLines;
  onAuthenticationError: (error: unknown) => boolean;
}) {
  const outcome = graph.outcomes.find(({ id }) => id === selectedId);
  const step = graph.behavioralSteps.find(({ id }) => id === selectedId);
  const evidence = graph.evidence.find(({ id }) => id === selectedId);
  const problem = graph.problems.find(({ id }) => id === selectedId);
  const evidenceKey =
    evidence === undefined
      ? null
      : JSON.stringify([
          selectedId,
          evidence.side,
          evidence.path,
          evidence.startLine,
          evidence.endLine,
        ]);
  const [sourceResult, setSourceResult] = useState<{
    key: string;
    source: FactoryConceptualReviewSourceLines | null;
    error: string | null;
  } | null>(null);
  const currentResult = sourceResult?.key === evidenceKey ? sourceResult : null;
  const selectionStatus =
    evidence !== undefined
      ? currentResult === null
        ? `Loading source evidence ${evidence.path}`
        : currentResult.error !== null
          ? `Source evidence ${evidence.path} is unavailable`
          : `Loaded source evidence ${evidence.path}`
      : outcome !== undefined
        ? `Selected outcome ${outcome.title}`
        : step !== undefined
          ? `Selected behavioral step ${step.title}`
          : problem !== undefined
            ? `Selected problem ${problem.title}`
            : "No review node selected";

  useEffect(() => {
    if (evidence === undefined || evidenceKey === null) return;
    const controller = new AbortController();
    void loadSourceLines(
      projectId,
      featureId,
      workflowId,
      evidence.side,
      evidence.path,
      evidence.startLine,
      evidence.endLine,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted)
          setSourceResult({ key: evidenceKey, source: value, error: null });
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError(failure))
          setSourceResult({
            key: evidenceKey,
            source: null,
            error: planningRequestError(failure, "The published source evidence is unavailable."),
          });
      });
    return () => controller.abort();
  }, [
    evidence,
    evidenceKey,
    featureId,
    loadSourceLines,
    onAuthenticationError,
    projectId,
    workflowId,
  ]);

  return (
    <aside className="min-w-0 rounded-xl border border-border bg-card p-4 [overflow-wrap:anywhere]">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {selectionStatus}
      </p>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Selected review node
      </p>
      {outcome === undefined ? null : (
        <div className="mt-3 min-w-0 space-y-2">
          <h3 className="text-lg font-semibold">{outcome.title}</h3>
          <p className="text-sm">{outcome.reason}</p>
          <p className="text-xs text-muted-foreground">
            Outcome {outcome.outcomeKey} · {outcome.coverage.replaceAll("_", " ")}
          </p>
        </div>
      )}
      {step === undefined ? null : (
        <div className="mt-3 min-w-0 space-y-2">
          <h3 className="text-lg font-semibold">{step.title}</h3>
          <p className="text-sm">{step.description}</p>
          <p className="text-xs text-muted-foreground">
            {step.change} · outcomes {step.outcomeKeys.join(", ")}
          </p>
        </div>
      )}
      {evidence === undefined ? null : (
        <div className="mt-3 min-w-0 space-y-2">
          <h3 className="break-words text-lg font-semibold">{evidence.description}</h3>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {evidence.side} · {evidence.path}:{evidence.startLine}–{evidence.endLine}
          </p>
          <p className="text-sm">{evidence.sufficiency}</p>
          {currentResult?.error == null ? null : <p role="alert">{currentResult.error}</p>}
          {currentResult === null ? (
            <p className="text-sm text-muted-foreground">Loading exact retained lines…</p>
          ) : currentResult.source?.status === "unsupported" ? (
            <p className="text-sm">
              The retained entry is {currentResult.source.reason.replaceAll("_", " ")}.
            </p>
          ) : currentResult.source?.status === "available" ? (
            <pre
              className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 text-xs"
              tabIndex={0}
            >
              {currentResult.source.text}
            </pre>
          ) : null}
          {evidence.limitations.length === 0 ? null : (
            <p className="text-xs text-muted-foreground">
              Limits: {evidence.limitations.join(" · ")}
            </p>
          )}
        </div>
      )}
      {problem === undefined ? null : (
        <div className="mt-3 min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold">{problem.title}</h3>
            {problem.type === "finding" ? (
              <span className="rounded-full border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                {problem.riskLevel} risk
              </span>
            ) : null}
          </div>
          {problem.type === "finding" ? (
            <dl className="grid gap-2 text-sm">
              <div>
                <dt className="text-muted-foreground">Condition</dt>
                <dd>{problem.condition}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Consequence</dt>
                <dd>{problem.consequence}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Reasoning</dt>
                <dd>{problem.reasoning}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Support</dt>
                <dd>{problem.sufficiency}</dd>
              </div>
            </dl>
          ) : problem.type === "observation" ? (
            <p className="text-sm">{problem.description}</p>
          ) : (
            <dl className="grid gap-2 text-sm">
              <div>
                <dt className="text-muted-foreground">Condition</dt>
                <dd>{problem.condition}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Possible consequence</dt>
                <dd>{problem.possibleConsequence}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Why unverified</dt>
                <dd>{problem.reasonUnverified}</dd>
              </div>
            </dl>
          )}
          {problem.limitations.length === 0 ? null : (
            <p className="text-xs text-muted-foreground">
              Limits: {problem.limitations.join(" · ")}
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
