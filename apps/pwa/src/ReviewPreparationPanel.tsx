import { useEffect, useRef, useState } from "react";

import type {
  ReviewPreparation,
  ReviewPreparationBlocker,
  ReviewWorkflowAccepted,
} from "@kestrel/contracts";

import { ApiClientError, fetchReviewPreparation, startReviewWorkflow } from "./api.js";

export interface ReviewPreparationPanelProps {
  disabled: boolean;
  onAuthenticationError?: (error: unknown) => boolean;
  onStarted?: (result: ReviewWorkflowAccepted) => void;
  projectId: string;
  proposalId: string;
  readPreparation?: typeof fetchReviewPreparation;
  startWorkflow?: typeof startReviewWorkflow;
}

const blockerLabels: Record<ReviewPreparationBlocker, string> = {
  revision_not_available: "Retained Review Revision is not available.",
  change_intent_not_resolved: "Change Intent is not resolved.",
  revision_identity_incoherent: "Retained base and head do not match this Change Proposal.",
  model_route_not_available: "Model route is not available.",
  operator_authority_not_available: "Operator authority is not available.",
  resource_envelope_not_available: "Resource Envelope is not available.",
};

const modelRouteLabels = {
  direct_api: "Direct API",
  subscription_acp: "Subscription ACP",
} as const;

function formatObservedAt(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function ReviewInputFacts({ preparation }: { preparation: ReviewPreparation }) {
  const revision = preparation.reviewRevision;
  const intent = preparation.changeIntent;
  const localSource = preparation.source.localRepositorySource;
  const provider = preparation.source.providerObservation;
  const analysis = preparation.analysisConfiguration;
  const resource = preparation.resourceEnvelope;

  return (
    <dl className="review-input-facts">
      <div>
        <dt>Exact retained base</dt>
        <dd>
          {revision === null ? (
            "Unavailable"
          ) : (
            <>
              <code>{revision.base.objectId}</code>
              <span>Ref snapshot: {revision.base.ref}</span>
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>Exact retained head</dt>
        <dd>
          {revision === null ? (
            "Unavailable"
          ) : (
            <>
              <code>{revision.head.objectId}</code>
              <span>Ref snapshot: {revision.head.ref}</span>
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>Change Intent</dt>
        <dd>
          {intent === null ? (
            "Unavailable"
          ) : (
            <>
              <strong>Change Intent v{intent.version}</strong>
              <span>{intent.objective ?? intent.text}</span>
              <code>Source digest {intent.sourceDigest}</code>
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>Local source provenance</dt>
        <dd>
          {localSource === null ? (
            "No Local Repository Source is attached."
          ) : (
            <>
              <strong>
                {localSource.displayName} · {localSource.state} · {localSource.objectFormat}
              </strong>
              <code>{localSource.id}</code>
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>Provider Observation</dt>
        <dd>
          {provider === null ? (
            "Not observed"
          ) : (
            <>
              <strong>
                {provider.route.kind === "host_gh"
                  ? `${provider.route.account} on ${provider.route.host} · host session`
                  : "Public GitHub · no account"}
              </strong>
              <span>
                <a href={provider.repository.canonicalUrl}>
                  {provider.repository.owner}/{provider.repository.name}
                </a>{" "}
                · {provider.repository.providerId}
              </span>
              <span>
                <a href={provider.proposal.canonicalUrl}>PR #{provider.proposal.number}</a> ·{" "}
                {provider.proposal.providerId} · observed{" "}
                <time dateTime={provider.proposal.observedAt}>
                  {formatObservedAt(provider.proposal.observedAt)}
                </time>
              </span>
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>Analysis profile</dt>
        <dd>
          {analysis === null ? (
            <strong>Not configured</strong>
          ) : (
            <>
              <strong>
                {analysis.displayName} · v{analysis.version} ·{" "}
                {modelRouteLabels[analysis.modelRoute]}
              </strong>
              <code>{analysis.id}</code>
              <code>Digest {analysis.digest}</code>
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>Operator authority</dt>
        <dd>
          {preparation.authority.state === "available" ? (
            <>
              <strong>Available</strong>
              <code>{preparation.authority.operatorId}</code>
            </>
          ) : (
            <strong>Unavailable</strong>
          )}
        </dd>
      </div>
      <div>
        <dt>Resource Envelope</dt>
        <dd>
          {resource === null ? (
            <strong>Not available</strong>
          ) : (
            <>
              <strong>
                {resource.displayName} · v{resource.version}
              </strong>
              <code>{resource.id}</code>
              <code>Digest {resource.digest}</code>
            </>
          )}
        </dd>
      </div>
    </dl>
  );
}

export function ReviewPreparationPanel({
  disabled,
  onAuthenticationError,
  onStarted,
  projectId,
  proposalId,
  readPreparation = fetchReviewPreparation,
  startWorkflow = startReviewWorkflow,
}: ReviewPreparationPanelProps) {
  const [preparation, setPreparation] = useState<ReviewPreparation | null>(null);
  const [accepted, setAccepted] = useState<ReviewWorkflowAccepted | null>(null);
  const [pending, setPending] = useState<"prepare" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const prepare = async () => {
    const active = new AbortController();
    controller.current?.abort();
    controller.current = active;
    setPending("prepare");
    setError(null);
    setAccepted(null);
    try {
      setPreparation(await readPreparation(projectId, proposalId, active.signal));
    } catch (caught) {
      if (!active.signal.aborted && onAuthenticationError?.(caught) !== true) {
        setError(
          caught instanceof ApiClientError
            ? caught.details.message
            : "Review preparation could not be read. Try again.",
        );
      }
    } finally {
      if (controller.current === active) {
        controller.current = null;
        setPending(null);
      }
    }
  };

  const start = async () => {
    if (preparation?.readiness !== "ready" || preparation.preparationDigest === null) return;
    const active = new AbortController();
    controller.current?.abort();
    controller.current = active;
    setPending("start");
    setError(null);
    try {
      const result = await startWorkflow(
        projectId,
        proposalId,
        { preparationDigest: preparation.preparationDigest },
        active.signal,
      );
      setAccepted(result);
      onStarted?.(result);
    } catch (caught) {
      if (!active.signal.aborted && onAuthenticationError?.(caught) !== true) {
        setError(
          caught instanceof ApiClientError
            ? caught.details.message
            : "The Review Workflow could not be started. Prepare again and retry.",
        );
      }
    } finally {
      if (controller.current === active) {
        controller.current = null;
        setPending(null);
      }
    }
  };

  return (
    <section className="review-preparation" aria-label="Review preparation">
      <div className="review-preparation-heading">
        <div>
          <p>REVIEW INPUT BINDING</p>
          <h5>Confirm exact inputs</h5>
        </div>
        {preparation === null ? null : (
          <strong className={preparation.readiness === "ready" ? "review-ready" : "review-blocked"}>
            {preparation.readiness === "ready" ? "Ready" : "Blocked"}
          </strong>
        )}
      </div>

      <p className="review-preparation-note">
        Preparation is read-only. Retained object IDs are authoritative; refs and Provider
        Observation are context only.
      </p>

      {preparation === null ? null : (
        <>
          <ReviewInputFacts preparation={preparation} />
          <div className="review-blockers" aria-live="polite">
            <h6>Review blockers</h6>
            {preparation.blockers.length === 0 ? (
              <p>No blockers. These exact inputs can be frozen.</p>
            ) : (
              <ul>
                {preparation.blockers.map((blocker) => (
                  <li key={blocker}>
                    <span>{blockerLabels[blocker]}</span>
                    <code>{blocker}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {preparation.preparationDigest === null ? null : (
            <p className="review-preparation-digest">
              Preparation digest <code>{preparation.preparationDigest}</code>
            </p>
          )}
        </>
      )}

      {accepted === null ? null : (
        <p className="review-queued" role="status">
          <strong>Review queued</strong>
          <span>Workflow {accepted.workflow.id}</span>
        </p>
      )}
      {error === null ? null : (
        <p className="project-form-error" role="alert">
          {error}
        </p>
      )}

      <div className="review-preparation-actions">
        <button
          className="secondary-action"
          type="button"
          disabled={disabled || pending !== null || accepted !== null}
          onClick={() => void prepare()}
        >
          {pending === "prepare"
            ? "Preparing…"
            : preparation === null
              ? "Prepare Review"
              : "Refresh preparation"}
        </button>
        {preparation === null ? null : (
          <button
            type="button"
            disabled={
              disabled ||
              pending !== null ||
              preparation.readiness !== "ready" ||
              preparation.preparationDigest === null ||
              accepted !== null
            }
            onClick={() => void start()}
          >
            {pending === "start" ? "Starting…" : "Start Review"}
          </button>
        )}
      </div>
    </section>
  );
}
