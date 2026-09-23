import { LifecycleProfileRecord } from "./LifecycleProfileRecord.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExternalConceptualReviewPreparation,
  FactoryConceptualReviewHistory,
  FactoryConceptualReviewStartCommand,
  FactoryConceptualReviewWorkflowRead,
} from "@kestrel/contracts";
import {
  AlertTriangle,
  CheckCircle2,
  GitCompareArrows,
  History,
  Play,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import { ConceptualReviewPanel } from "./ConceptualReviewPanel.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { Button } from "./components/ui/button.js";
import {
  fetchCurrentExternalConceptualReview,
  fetchExternalConceptualReviewArtifact,
  fetchExternalConceptualReviewArtifactSourceLines,
  fetchExternalConceptualReviewHistory,
  fetchExternalConceptualReviewPreparation,
  fetchExternalConceptualReviewWorkflow,
  startExternalConceptualReview,
} from "./conceptual-review-api.js";

const blockerMessages: Record<
  ExternalConceptualReviewPreparation["readiness"]["blockers"][number],
  string
> = {
  publication_not_ready: "Retain the exact current pull request revision before starting review.",
  approved_plan_mismatch: "The approved purpose no longer matches this pull request.",
  certificate_mismatch: "The recorded verification does not match this pull request.",
  exact_revision_mismatch: "The retained source does not match the current pull request head.",
  change_intent_not_available: "Confirm a purpose for this pull request before starting review.",
  lifecycle_profile_unavailable:
    "Choose an available Conceptual Review profile in Project Lifecycle settings.",
  model_not_selected: "Choose a Codex review model in Project settings.",
  review_runtime_unavailable:
    "The local review runner is unavailable. Check the Codex connection and runtime.",
};

export interface ExternalPullRequestReviewPanelProps {
  changeProposalId: string;
  disabled: boolean;
  online: boolean;
  projectId: string;
  onAuthenticationError: (error: unknown) => boolean;
  loadPreparation?: typeof fetchExternalConceptualReviewPreparation;
  loadCurrentReview?: typeof fetchCurrentExternalConceptualReview;
  loadReviewWorkflow?: typeof fetchExternalConceptualReviewWorkflow;
  loadReviewHistory?: typeof fetchExternalConceptualReviewHistory;
  loadReviewArtifact?: typeof fetchExternalConceptualReviewArtifact;
  loadReviewSourceLines?: typeof fetchExternalConceptualReviewArtifactSourceLines;
  startReview?: typeof startExternalConceptualReview;
}

function shortId(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 9)}…${value.slice(-6)}`;
}

function ReviewInputs({ preparation }: { preparation: ExternalConceptualReviewPreparation }) {
  const publication = preparation.publication;
  if (publication === null) return null;
  return (
    <dl
      className="grid min-w-0 gap-3 rounded-lg border border-border bg-background p-3 text-sm sm:grid-cols-2"
      aria-label="Exact pull request review inputs"
    >
      <div>
        <dt className="text-xs text-muted-foreground">Exact revision</dt>
        <dd className="mt-0.5 font-mono text-xs" title={publication.pullRequest.headCommitId}>
          {publication.pullRequest.baseRef} → {publication.pullRequest.headRef} · head{" "}
          {shortId(publication.pullRequest.headCommitId)}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Review boundary</dt>
        <dd className="mt-0.5">
          Retained source is read only. Network and repository writes are disabled.
        </dd>
      </div>
    </dl>
  );
}

function ReviewScope({ preparation }: { preparation: ExternalConceptualReviewPreparation }) {
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-3">
      <div className="rounded-lg border border-border bg-background p-3">
        <p className="text-xs text-muted-foreground">1 · Purpose</p>
        <p className="mt-1 text-sm">The stated or operator-confirmed outcomes.</p>
      </div>
      <div className="rounded-lg border border-border bg-background p-3">
        <p className="text-xs text-muted-foreground">2 · Behavior and source</p>
        <p className="mt-1 text-sm">What changed and the exact retained lines supporting it.</p>
      </div>
      <div className="rounded-lg border border-border bg-background p-3">
        <p className="text-xs text-muted-foreground">3 · Problems</p>
        <p className="mt-1 text-sm">
          Findings and unverified concerns, with their limits made visible.
        </p>
      </div>
      {preparation.basis?.limitations.length ? (
        <p className="text-xs text-muted-foreground sm:col-span-3">
          Purpose limits: {preparation.basis.limitations.join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function ExternalPullRequestReviewPanelContent({
  changeProposalId,
  disabled,
  online,
  projectId,
  onAuthenticationError,
  loadPreparation = fetchExternalConceptualReviewPreparation,
  loadCurrentReview = fetchCurrentExternalConceptualReview,
  loadReviewWorkflow = fetchExternalConceptualReviewWorkflow,
  loadReviewHistory = fetchExternalConceptualReviewHistory,
  loadReviewArtifact = fetchExternalConceptualReviewArtifact,
  loadReviewSourceLines = fetchExternalConceptualReviewArtifactSourceLines,
  startReview = startExternalConceptualReview,
}: ExternalPullRequestReviewPanelProps) {
  const [preparation, setPreparation] = useState<ExternalConceptualReviewPreparation | null>(null);
  const [review, setReview] = useState<FactoryConceptualReviewWorkflowRead | null>(null);
  const [history, setHistory] = useState<FactoryConceptualReviewHistory | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const pendingStart = useRef<FactoryConceptualReviewStartCommand | null>(null);

  const read = useCallback(async () => {
    if (!online) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    setLoading(true);
    setError(null);
    try {
      const [nextPreparation, nextReview, nextHistory] = await Promise.all([
        loadPreparation(projectId, changeProposalId, controller.signal),
        selectedArtifactId === undefined
          ? loadCurrentReview(projectId, changeProposalId, controller.signal).then(
              ({ review: current }) => current,
            )
          : loadReviewArtifact(projectId, changeProposalId, selectedArtifactId, controller.signal),
        loadReviewHistory(projectId, changeProposalId, 0, 20, controller.signal),
      ]);
      if (!controller.signal.aborted && generation.current === currentGeneration) {
        setPreparation(nextPreparation);
        setReview(nextReview);
        setHistory(nextHistory);
        if (nextReview !== null) pendingStart.current = null;
      }
    } catch (failure) {
      if (
        !controller.signal.aborted &&
        generation.current === currentGeneration &&
        !onAuthenticationError(failure)
      ) {
        setError(planningRequestError(failure, "The pull request review is unavailable."));
      }
    } finally {
      if (!controller.signal.aborted && generation.current === currentGeneration) setLoading(false);
    }
  }, [
    changeProposalId,
    loadCurrentReview,
    loadPreparation,
    loadReviewArtifact,
    loadReviewHistory,
    onAuthenticationError,
    online,
    projectId,
    selectedArtifactId,
  ]);

  useEffect(() => {
    void read();
    return () => request.current?.abort();
  }, [read]);

  const activeReviewId =
    review !== null &&
    (review.workflow.state === "queued" ||
      review.workflow.state === "running" ||
      (review.workflow.state === "failed" && review.workflow.failure === "stop_unconfirmed"))
      ? review.workflow.id
      : null;
  useEffect(() => {
    if (!online || activeReviewId === null || selectedArtifactId !== undefined) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await loadReviewWorkflow(
          projectId,
          changeProposalId,
          activeReviewId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setReview(next);
        setError(null);
        const stillActive =
          next.workflow.state === "queued" ||
          next.workflow.state === "running" ||
          (next.workflow.state === "failed" && next.workflow.failure === "stop_unconfirmed");
        if (stillActive) {
          timer = window.setTimeout(() => void poll(), 1_000);
          return;
        }
        setHistory(await loadReviewHistory(projectId, changeProposalId, 0, 20, controller.signal));
      } catch (failure) {
        if (!controller.signal.aborted && !onAuthenticationError(failure)) {
          setError(planningRequestError(failure, "Kestrel could not refresh the running review."));
          timer = window.setTimeout(() => void poll(), 1_000);
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 1_000);
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    activeReviewId,
    changeProposalId,
    loadReviewHistory,
    loadReviewWorkflow,
    onAuthenticationError,
    online,
    projectId,
    selectedArtifactId,
  ]);

  const start = async () => {
    if (
      disabled ||
      !online ||
      starting ||
      preparation?.preparationDigest === null ||
      preparation?.preparationDigest === undefined
    ) {
      return;
    }
    const command =
      pendingStart.current?.preparationDigest === preparation.preparationDigest
        ? pendingStart.current
        : {
            requestId: crypto.randomUUID(),
            preparationDigest: preparation.preparationDigest,
          };
    pendingStart.current = command;
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    request.current?.abort();
    setStarting(true);
    setError(null);
    try {
      const accepted = await startReview(projectId, changeProposalId, command);
      if (generation.current === currentGeneration) {
        setSelectedArtifactId(undefined);
        setReview(accepted);
        pendingStart.current = null;
      }
    } catch (failure) {
      if (generation.current === currentGeneration && !onAuthenticationError(failure)) {
        setError(planningRequestError(failure, "Kestrel could not start the review."));
      }
    } finally {
      if (generation.current === currentGeneration) setStarting(false);
    }
  };

  const active = review?.workflow.state === "queued" || review?.workflow.state === "running";
  const teardownPending =
    review?.workflow.state === "failed" && review.workflow.failure === "stop_unconfirmed";
  const inputsChanged =
    review !== null &&
    preparation !== null &&
    (preparation.preparationDigest === null ||
      preparation.preparationDigest !== review.workflow.inputDigest);

  return (
    <section className="grid min-w-0 gap-4" aria-labelledby={`review-${changeProposalId}`}>
      <div className="grid min-w-0 gap-4 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Independent review
            </p>
            <h3 id={`review-${changeProposalId}`} className="mt-1 text-lg font-semibold">
              Did this pull request deliver what it says?
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Kestrel reviews the exact retained revision and builds an explorable path from purpose
              to behavior, source evidence, and problems. It does not edit code, update GitHub, or
              merge the pull request.
            </p>
          </div>
          <div className="min-w-52 space-y-2">
            <LifecycleProfileRecord
              label="Review profile"
              profile={preparation?.configuration.lifecycleProfile}
            />
            {preparation?.configuration.profileBlocker == null ? null : (
              <p role="alert">{preparation.configuration.profileBlocker}</p>
            )}
            <Button
              type="button"
              className="w-full"
              disabled={
                disabled ||
                !online ||
                loading ||
                starting ||
                preparation?.readiness.startAllowed !== true ||
                active ||
                teardownPending
              }
              onClick={() => void start()}
            >
              {starting ? (
                "Starting review…"
              ) : active ? (
                "Review in progress"
              ) : (
                <>
                  <Play className="size-4" aria-hidden="true" /> Start independent review
                </>
              )}
            </Button>
            {preparation?.readiness.blockers.map((blocker) => (
              <p key={blocker} className="flex gap-2 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {blockerMessages[blocker]}
              </p>
            ))}
          </div>
        </div>

        {preparation === null ? (
          <p className="text-sm text-muted-foreground" aria-busy={loading}>
            {online ? "Checking exact review inputs…" : "Reconnect to inspect review readiness."}
          </p>
        ) : (
          <>
            <ReviewScope preparation={preparation} />
            <ReviewInputs preparation={preparation} />
          </>
        )}

        {error === null ? null : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
            <p role="alert" className="text-sm">
              {error}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={() => void read()}>
              Try again
            </Button>
          </div>
        )}
      </div>

      {inputsChanged || review?.currency === "outdated" ? (
        <section className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <h4 className="flex items-center gap-2 font-semibold">
            <GitCompareArrows className="size-4" aria-hidden="true" /> Review is from an earlier PR
            revision
          </h4>
          <p className="mt-1 text-sm text-muted-foreground">
            The saved result remains inspectable. Start a new review to evaluate the current exact
            head.
          </p>
        </section>
      ) : null}

      {history === null || history.reviews.length === 0 ? null : (
        <section
          className="rounded-xl border border-border bg-card p-4"
          aria-label="Review history"
        >
          <div className="flex items-center gap-2">
            <History className="size-4" aria-hidden="true" />
            <h4 className="font-semibold">Previous reviews</h4>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Each result stays bound to the exact source revision it inspected.
          </p>
          <div className="mt-3 flex max-w-full gap-2 overflow-x-auto pb-1">
            <Button
              type="button"
              size="sm"
              variant={selectedArtifactId === undefined ? "default" : "outline"}
              aria-pressed={selectedArtifactId === undefined}
              onClick={() => setSelectedArtifactId(undefined)}
            >
              Current
            </Button>
            {history.reviews.map((entry, index) => (
              <Button
                key={entry.artifactId}
                type="button"
                size="sm"
                variant={selectedArtifactId === entry.artifactId ? "default" : "outline"}
                aria-pressed={selectedArtifactId === entry.artifactId}
                className="h-auto min-w-44 justify-start whitespace-normal py-2 text-left"
                onClick={() => setSelectedArtifactId(entry.artifactId)}
              >
                <span>
                  <span className="block">Review {history.offset + index + 1}</span>
                  <span className="block text-xs opacity-75">
                    {entry.status} · head {shortId(entry.headCommitId)}
                  </span>
                </span>
              </Button>
            ))}
          </div>
        </section>
      )}

      {review === null ? null : (
        <ConceptualReviewPanel
          review={review}
          projectId={projectId}
          featureId={changeProposalId}
          loadSourceLines={loadReviewSourceLines}
          loadCheck={null}
          onAuthenticationError={onAuthenticationError}
        />
      )}

      {review?.workflow.state === "published" && review.artifact !== null ? (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
          {review.artifact.status === "partial" ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          )}
          {review.artifact.status === "partial"
            ? "Partial means the source-backed explanation is useful, but Kestrel could not prove every requested outcome or had no linked executed tests."
            : "Complete means every requested outcome is mapped to supported behavior and evidence."}
        </p>
      ) : null}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-fit"
        disabled={!online || loading}
        onClick={() => void read()}
      >
        {preparation?.readiness.state === "ready" ? (
          <ShieldCheck className="size-4" aria-hidden="true" />
        ) : (
          <RefreshCw className="size-4" aria-hidden="true" />
        )}
        Refresh review status
      </Button>
    </section>
  );
}

export function ExternalPullRequestReviewPanel(props: ExternalPullRequestReviewPanelProps) {
  return (
    <ExternalPullRequestReviewPanelContent
      key={`${props.projectId}:${props.changeProposalId}`}
      {...props}
    />
  );
}
