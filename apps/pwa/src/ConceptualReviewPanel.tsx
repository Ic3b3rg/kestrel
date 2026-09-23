import { LifecycleProfileRecord } from "./LifecycleProfileRecord.js";
import { useEffect, useState } from "react";
import type { FactoryConceptualReviewWorkflowRead } from "@kestrel/contracts";
import { AlertTriangle, Clock3, GitCompareArrows, LoaderCircle } from "lucide-react";

import {
  fetchFactoryConceptualReviewArtifactCheck,
  fetchFactoryConceptualReviewArtifactSourceLines,
} from "./conceptual-review-api.js";
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
  check_unavailable: "A frozen final-check record could not be verified.",
  resource_exhausted: "The review exceeded an approved resource limit.",
  interrupted: "The review was interrupted and exhausted its retry budget.",
  stop_unconfirmed: "Kestrel could not confirm that the review environment stopped.",
  internal_error: "The review stopped because of an internal error.",
};

export function ConceptualReviewPanel({
  review,
  projectId,
  featureId,
  loadSourceLines = fetchFactoryConceptualReviewArtifactSourceLines,
  loadCheck = fetchFactoryConceptualReviewArtifactCheck,
  onAuthenticationError,
}: {
  review: FactoryConceptualReviewWorkflowRead;
  projectId: string;
  featureId: string;
  loadSourceLines?: typeof fetchFactoryConceptualReviewArtifactSourceLines;
  loadCheck?: typeof fetchFactoryConceptualReviewArtifactCheck | null;
  onAuthenticationError: (error: unknown) => boolean;
}) {
  const artifact = review.artifact;
  const external = review.workflow.featureId === null;
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
        <LifecycleProfileRecord
          profile={review.lifecycleProfile}
          effective={review.runtimeProfileResult}
        />
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
        <LifecycleProfileRecord
          profile={review.lifecycleProfile}
          effective={review.runtimeProfileResult}
        />
      </section>
    );

  if (artifact === null) return null;
  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 [overflow-wrap:anywhere] sm:p-5">
      <LifecycleProfileRecord
        profile={review.lifecycleProfile}
        effective={review.runtimeProfileResult}
      />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Published conceptual review
          </p>
          <h3 className="mt-1 text-lg font-semibold">{artifact.graph.summary}</h3>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-border px-2 py-1 capitalize">
            {artifact.status}
          </span>
          {review.currency === "outdated" ? (
            <span className="flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-amber-300">
              <GitCompareArrows className="size-3.5" aria-hidden="true" /> Outdated · PR head moved
            </span>
          ) : review.currency === "unknown" ? (
            <span className="flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-amber-300">
              <GitCompareArrows className="size-3.5" aria-hidden="true" /> Currency unknown · GitHub
              unavailable
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-emerald-300">
              <GitCompareArrows className="size-3.5" aria-hidden="true" /> Up to date · exact head
              still current
            </span>
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {external
          ? "Choose an outcome and follow its highlighted path through behavior, source evidence, and any problem."
          : "Choose an outcome and follow its highlighted path through behavior, source, final checks, and any problem."}
      </p>
      <p className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
        {artifact.evidenceScope.executedChecks === "linked_final_certificate"
          ? "Authority: source and check provenance are resolved by Kestrel against the frozen final certificate. The proposition each check supports or refutes remains model judgment and includes its limitations."
          : external
            ? "This review maps the stated purpose to exact retained source. No executed test results are linked, so it remains Partial; unsupported claims stay explicitly unverified."
            : "This saved review contains model interpretation of exact retained source. Executed checks were not linked, so it remains Partial."}
      </p>
      <dl
        className="grid min-w-0 gap-2 rounded-lg border border-border bg-background p-3 text-xs sm:grid-cols-2"
        aria-label="Published review revision"
      >
        <div>
          <dt className="text-muted-foreground">Reviewed base</dt>
          <dd className="break-all font-mono">{artifact.baseCommitId}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Reviewed head</dt>
          <dd className="break-all font-mono">{artifact.headCommitId}</dd>
        </div>
      </dl>
      <ReviewGraph
        graph={artifact.graph}
        selectedId={selectedId}
        onSelect={setSelectedId}
        {...(external ? { outcomeTitle: "Requested outcomes", showChecks: false } : {})}
      />
      <ReviewEvidenceInspector
        graph={artifact.graph}
        selectedId={selectedId}
        projectId={projectId}
        featureId={featureId}
        artifactId={artifact.id}
        loadSourceLines={loadSourceLines}
        loadCheck={loadCheck}
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
