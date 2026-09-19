import { useEffect, useState } from "react";
import type { FactoryConceptualReviewWorkflowRead } from "@kestrel/contracts";
import { AlertTriangle, Clock3, GitCompareArrows, LoaderCircle } from "lucide-react";

import { fetchFactoryConceptualReviewWorkflowSourceLines } from "./conceptual-review-api.js";
import { ReviewEvidenceInspector } from "./ReviewEvidenceInspector.js";
import { ReviewGraph } from "./ReviewGraph.js";

const failures: Record<
  NonNullable<FactoryConceptualReviewWorkflowRead["workflow"]["failure"]>,
  string
> = {
  runtime_unavailable: "The bounded review runner is unavailable.",
  authentication_required: "Codex authentication is required before review can run.",
  usage_limit: "Codex usage is exhausted. Wait for the account usage reset, then start again.",
  timeout: "The review exceeded its approved time limit.",
  invalid_output: "The reviewer did not return a valid, resolvable graph.",
  source_unavailable: "The frozen retained source could not be verified.",
  resource_exhausted: "The review exceeded an approved resource limit.",
  interrupted: "The review was interrupted and exhausted its retry budget.",
  stop_unconfirmed: "Kestrel could not confirm that the review environment stopped.",
  internal_error: "The review stopped because of an internal error.",
};

export function ConceptualReviewPanel({
  review,
  projectId,
  featureId,
  loadSourceLines = fetchFactoryConceptualReviewWorkflowSourceLines,
  onAuthenticationError,
}: {
  review: FactoryConceptualReviewWorkflowRead;
  projectId: string;
  featureId: string;
  loadSourceLines?: typeof fetchFactoryConceptualReviewWorkflowSourceLines;
  onAuthenticationError: (error: unknown) => boolean;
}) {
  const artifact = review.artifact;
  const [selectedId, setSelectedId] = useState(artifact?.graph.outcomes[0]?.id ?? "");
  useEffect(() => {
    setSelectedId(artifact?.graph.outcomes[0]?.id ?? "");
  }, [artifact?.id]);

  if (review.workflow.state === "queued" || review.workflow.state === "running")
    return (
      <section className="rounded-xl border border-border bg-card p-5" aria-live="polite">
        <div className="flex items-start gap-3">
          {review.workflow.state === "running" ? (
            <LoaderCircle className="mt-0.5 size-5 animate-spin" aria-hidden="true" />
          ) : (
            <Clock3 className="mt-0.5 size-5" aria-hidden="true" />
          )}
          <div>
            <h3 className="font-semibold">
              {review.workflow.state === "running"
                ? "Reviewing the frozen revision"
                : "Review queued"}
            </h3>
            <p className="text-sm text-muted-foreground">
              Attempt {review.workflow.attempt.current} of {review.workflow.attempt.maximum}. You
              can leave this page; Kestrel will keep the durable job running.
            </p>
          </div>
        </div>
      </section>
    );

  if (review.workflow.state === "failed")
    return (
      <section
        className="rounded-xl border border-destructive/40 bg-destructive/5 p-5"
        role="alert"
      >
        <h3 className="flex items-center gap-2 font-semibold">
          <AlertTriangle className="size-5" aria-hidden="true" /> Review stopped
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {review.workflow.failure === null
            ? "No failure reason was retained."
            : failures[review.workflow.failure]}
        </p>
      </section>
    );

  if (artifact === null) return null;
  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 [overflow-wrap:anywhere] sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Published conceptual review
          </p>
          <h3 className="mt-1 text-lg font-semibold">{artifact.graph.summary}</h3>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-border px-2 py-1">{artifact.status}</span>
          {review.currency === "outdated" ? (
            <span className="flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-amber-300">
              <GitCompareArrows className="size-3.5" aria-hidden="true" /> Outdated · PR head moved
            </span>
          ) : review.currency === "unknown" ? (
            <span className="flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-amber-300">
              <GitCompareArrows className="size-3.5" aria-hidden="true" /> Currency unknown · GitHub
              unavailable
            </span>
          ) : null}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Choose an outcome and follow its highlighted path through behavior, source, and any problem.
      </p>
      <p className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
        Authority: the narrative below is a model interpretation of exact retained source. Executed
        checks are not linked or assessed, so this review remains Partial even if the narrative
        mentions a check result.
      </p>
      <ReviewGraph graph={artifact.graph} selectedId={selectedId} onSelect={setSelectedId} />
      <ReviewEvidenceInspector
        graph={artifact.graph}
        selectedId={selectedId}
        projectId={projectId}
        featureId={featureId}
        workflowId={review.workflow.id}
        loadSourceLines={loadSourceLines}
        onAuthenticationError={onAuthenticationError}
      />
      {artifact.graph.limitations.length === 0 ? null : (
        <div className="rounded-lg border border-dashed border-border p-3">
          <h4 className="text-sm font-medium">Review limitations</h4>
          <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
            {artifact.graph.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
