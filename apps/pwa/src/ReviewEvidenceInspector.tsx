import { useEffect, useState } from "react";
import type {
  FactoryConceptualReviewCheck,
  FactoryConceptualReviewDraft,
  FactoryConceptualReviewSourceLines,
} from "@kestrel/contracts";

import {
  fetchFactoryConceptualReviewArtifactCheck,
  fetchFactoryConceptualReviewArtifactSourceLines,
} from "./conceptual-review-api.js";
import { planningRequestError } from "./FeatureNavigation.js";

export function ReviewEvidenceInspector({
  graph,
  selectedId,
  projectId,
  featureId,
  artifactId,
  loadSourceLines = fetchFactoryConceptualReviewArtifactSourceLines,
  loadCheck = fetchFactoryConceptualReviewArtifactCheck,
  onAuthenticationError,
}: {
  graph: FactoryConceptualReviewDraft;
  selectedId: string;
  projectId: string;
  featureId: string;
  artifactId: string;
  loadSourceLines?: typeof fetchFactoryConceptualReviewArtifactSourceLines;
  loadCheck?: typeof fetchFactoryConceptualReviewArtifactCheck;
  onAuthenticationError: (error: unknown) => boolean;
}) {
  const outcome = graph.outcomes.find(({ id }) => id === selectedId);
  const step = graph.behavioralSteps.find(({ id }) => id === selectedId);
  const evidence = graph.evidence.find(({ id }) => id === selectedId);
  const sourceEvidence = evidence?.type === "source" ? evidence : undefined;
  const checkEvidence = evidence?.type === "check" ? evidence : undefined;
  const problem = graph.problems.find(({ id }) => id === selectedId);
  const evidenceKey =
    sourceEvidence !== undefined
      ? JSON.stringify([
          selectedId,
          sourceEvidence.side,
          sourceEvidence.path,
          sourceEvidence.startLine,
          sourceEvidence.endLine,
        ])
      : checkEvidence !== undefined
        ? JSON.stringify([selectedId, checkEvidence.evidenceId])
        : null;
  const [evidenceResult, setEvidenceResult] = useState<{
    key: string;
    source: FactoryConceptualReviewSourceLines | null;
    check: FactoryConceptualReviewCheck | null;
    error: string | null;
  } | null>(null);
  const currentResult = evidenceResult?.key === evidenceKey ? evidenceResult : null;
  const selectionStatus =
    sourceEvidence !== undefined
      ? currentResult === null
        ? `Loading source evidence ${sourceEvidence.path}`
        : currentResult.error !== null
          ? `Source evidence ${sourceEvidence.path} is unavailable`
          : `Loaded source evidence ${sourceEvidence.path}`
      : checkEvidence !== undefined
        ? currentResult === null
          ? `Loading final check ${String(checkEvidence.record.manifestPosition)}`
          : currentResult.error !== null
            ? `Final check ${String(checkEvidence.record.manifestPosition)} is unavailable`
            : `Loaded final check ${String(checkEvidence.record.manifestPosition)}`
        : outcome !== undefined
          ? `Selected outcome ${outcome.title}`
          : step !== undefined
            ? `Selected behavioral step ${step.title}`
            : problem !== undefined
              ? `Selected problem ${problem.title}`
              : "No review node selected";

  useEffect(() => {
    if (evidenceKey === null || evidence === undefined) return;
    const controller = new AbortController();
    const pending =
      evidence.type === "source"
        ? loadSourceLines(
            projectId,
            featureId,
            artifactId,
            evidence.side,
            evidence.path,
            evidence.startLine,
            evidence.endLine,
            controller.signal,
          ).then((source) => ({ source, check: null }))
        : loadCheck(projectId, featureId, artifactId, evidence.evidenceId, controller.signal).then(
            (check) => ({ source: null, check }),
          );
    void pending
      .then((value) => {
        if (!controller.signal.aborted)
          setEvidenceResult({ key: evidenceKey, ...value, error: null });
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError(failure))
          setEvidenceResult({
            key: evidenceKey,
            source: null,
            check: null,
            error: planningRequestError(
              failure,
              evidence.type === "source"
                ? "The published source evidence is unavailable."
                : "The published final check is unavailable.",
            ),
          });
      });
    return () => controller.abort();
  }, [
    artifactId,
    evidence,
    evidenceKey,
    featureId,
    loadCheck,
    loadSourceLines,
    onAuthenticationError,
    projectId,
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
      {sourceEvidence === undefined ? null : (
        <div className="mt-3 min-w-0 space-y-2">
          <h3 className="break-words text-lg font-semibold">{sourceEvidence.description}</h3>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {sourceEvidence.side} · {sourceEvidence.path}:{sourceEvidence.startLine}–
            {sourceEvidence.endLine}
          </p>
          <p className="text-sm">{sourceEvidence.sufficiency}</p>
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
          {sourceEvidence.limitations.length === 0 ? null : (
            <p className="text-xs text-muted-foreground">
              Limits: {sourceEvidence.limitations.join(" · ")}
            </p>
          )}
        </div>
      )}
      {checkEvidence === undefined ? null : (
        <div className="mt-3 min-w-0 space-y-3">
          <div>
            <h3 className="break-words text-lg font-semibold">{checkEvidence.description}</h3>
            <p className="text-sm">
              <span className="font-medium capitalize">{checkEvidence.relation}:</span>{" "}
              {checkEvidence.proposition}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{checkEvidence.sufficiency}</p>
          </div>
          <dl className="grid min-w-0 gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Command</dt>
              <dd className="break-words font-mono">
                {[checkEvidence.record.command.program, ...checkEvidence.record.command.args].join(
                  " ",
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Manifest / Work Items</dt>
              <dd>
                #{checkEvidence.record.manifestPosition} ·{" "}
                {checkEvidence.record.origins
                  .map(({ workItemKey, position }) => `${workItemKey}:${String(position)}`)
                  .join(", ")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Run</dt>
              <dd className="break-all font-mono">{checkEvidence.record.runId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Recorded result</dt>
              <dd>
                {checkEvidence.record.outcome} · exit {checkEvidence.record.exitCode} ·{" "}
                {checkEvidence.record.durationMs} ms
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Head</dt>
              <dd className="break-all font-mono">{checkEvidence.record.headCommitId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Tree</dt>
              <dd className="break-all font-mono">{checkEvidence.record.treeId}</dd>
            </div>
          </dl>
          {currentResult?.error == null ? null : <p role="alert">{currentResult.error}</p>}
          {currentResult === null ? (
            <p className="text-sm text-muted-foreground">Loading bounded command output…</p>
          ) : currentResult.check === null ? null : (
            <div className="grid min-w-0 gap-3">
              <div>
                <p className="text-xs text-muted-foreground">
                  stdout{currentResult.check.result.stdoutTruncated ? " · truncated" : ""}
                </p>
                <pre
                  className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 text-xs"
                  tabIndex={0}
                >
                  {currentResult.check.result.stdout || "(empty)"}
                </pre>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">
                  stderr{currentResult.check.result.stderrTruncated ? " · truncated" : ""}
                </p>
                <pre
                  className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 text-xs"
                  tabIndex={0}
                >
                  {currentResult.check.result.stderr || "(empty)"}
                </pre>
              </div>
            </div>
          )}
          {checkEvidence.limitations.length === 0 ? null : (
            <p className="text-xs text-muted-foreground">
              Limits: {checkEvidence.limitations.join(" · ")}
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
            ) : problem.type === "observation" ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-xs">
                Observation
              </span>
            ) : (
              <span className="rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
                Unverified concern
              </span>
            )}
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
