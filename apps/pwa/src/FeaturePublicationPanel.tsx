import { useContext, useEffect, useRef, useState } from "react";
import type {
  FactoryFeaturePublication,
  FactoryFeaturePublicationFailure,
  FactoryFeaturePublicationReview,
  RetryFactoryFeaturePublicationCommand,
} from "@kestrel/contracts";
import { ApiClientError } from "./api.js";
import {
  fetchFactoryFeaturePublication,
  retryFactoryFeaturePublication,
} from "./factory-feature-publication-api.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { Button } from "./components/ui/button.js";
import { WorkspaceSuspendedContext } from "./components/ui/workspace-suspension.js";

const failureText: Record<FactoryFeaturePublicationFailure, string> = {
  verification_required:
    "Publication waits for all approved verification commands to pass on the final Feature head.",
  certificate_stale:
    "The saved certificate no longer proves the current approved plan and revision. Inspect final verification before continuing.",
  issue_identity_missing:
    "A Work Item is missing its expected GitHub issue. Publication cannot omit or replace that issue.",
  source_changed:
    "The original repository source is unavailable or has changed. Restore its connection before retrying.",
  remote_changed:
    "The original origin remote changed. Publication retains its original repository and cannot switch remotes.",
  target_changed:
    "The target branch moved from the frozen Feature base. Publication cannot substitute a newer base.",
  target_unavailable:
    "The original target branch could not be read. Check its availability before retrying.",
  feature_ref_conflict:
    "The Feature branch does not point to the certified head. Publication will not overwrite a different remote revision.",
  workspace_changed: "The managed Feature workspace no longer matches the certified head and tree.",
  unavailable:
    "Publication could not reach a required local or GitHub service. Restore access, then retry to check the saved operation.",
  cancelled: "This Feature was cancelled. Its recorded external results remain available.",
  timeout:
    "Publication reached its time limit. Retry checks the saved operation before continuing.",
  push_rejected:
    "GitHub rejected the exact Feature branch push. Check repository access and branch rules before retrying.",
  needs_authentication: "Sign in to the original GitHub account on this computer, then retry.",
  access_denied:
    "The original GitHub account cannot access the repository. Restore its access before retrying.",
  rate_limited: "GitHub asked Kestrel to wait. Retry becomes available after the required delay.",
  invalid_response:
    "A response could not be verified against the saved publication. No replacement operation is authorized.",
  project_not_supported: "This Project has no supported original GitHub publication target.",
  repository_changed:
    "The GitHub repository or signed-in account differs from the original issue publication target.",
  uncertain_write:
    "A provider response was lost. Retry checks the exact branch and pull request; it cannot blindly repeat an uncertain write.",
  reconciliation_limit:
    "The bounded GitHub search could not establish one exact pull request. The saved operation remains unresolved.",
  retention_unavailable:
    "The pull request is recorded, but its exact local review revision is not yet available. Retry continues retention of that captured revision.",
  retry_limit:
    "This publication has reached its retry limit. Its saved operation and results remain available for inspection.",
};
const ignoreAuthenticationError = () => false;
export interface FeaturePublicationPanelProps {
  projectId: string;
  featureId: string;
  online?: boolean;
  onOpenRevision: (review: FactoryFeaturePublicationReview) => void;
  onAuthenticationError?: (error: unknown) => boolean;
}
function status(publication: FactoryFeaturePublication): string {
  if (publication.cancelled)
    return publication.state === "uncertain"
      ? "Cancelled · publication outcome is uncertain"
      : "Feature cancelled";
  switch (publication.state) {
    case "pending":
      return publication.certificate === null
        ? "Waiting for final verification"
        : "Waiting to publish the pull request";
    case "publishing":
      return publication.pullRequest === null
        ? "Publishing the certified Feature"
        : "Retaining the exact review revision";
    case "blocked":
      return "Publication needs attention";
    case "uncertain":
      return "Publication outcome is uncertain";
    case "published":
      return "Pull request published";
    case "cancelled":
      return "Feature cancelled";
  }
}

function PublicationDetails({
  publication,
  active,
  onOpenRevision,
}: {
  publication: FactoryFeaturePublication;
  active: boolean;
  onOpenRevision: FeaturePublicationPanelProps["onOpenRevision"];
}) {
  const { certificate, pullRequest, review } = publication;
  return (
    <div className="min-w-0 space-y-3">
      <p className="font-medium" role="status">
        {status(publication)}
      </p>
      {publication.failure === null ? null : (
        <p className="text-sm text-muted-foreground">{failureText[publication.failure]}</p>
      )}
      {pullRequest === null ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <a
            className="text-sm font-medium underline underline-offset-4"
            href={pullRequest.url}
            target="_blank"
            rel="noreferrer"
          >
            Pull request #{pullRequest.number}
          </a>
          {review === null ? (
            <span className="text-sm text-muted-foreground">Exact review revision pending</span>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!active}
              onClick={() => onOpenRevision(review)}
            >
              Open retained revision
            </Button>
          )}
        </div>
      )}
      {publication.issues.length === 0 ? null : (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Work Items stay In review. Linked issues remain open.
          </p>
          <ol className="space-y-1 text-sm">
            {publication.issues.map((item) => (
              <li key={item.workItemId} className="break-words">
                <a
                  className="underline underline-offset-4"
                  href={item.issue.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {item.key} · {item.title} · #{item.issue.number}
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}
      {certificate === null ? null : (
        <details className="min-w-0 text-sm">
          <summary className="cursor-pointer font-medium">
            Certified revision · {certificate.manifest.length} passing{" "}
            {certificate.manifest.length === 1 ? "check" : "checks"}
          </summary>
          <dl className="mt-3 grid min-w-0 gap-2">
            <div>
              <dt className="text-muted-foreground">Approved plan</dt>
              <dd>Version {certificate.approvedVersion}</dd>
            </div>
            {[
              ["Base commit", certificate.revision.baseCommitId],
              ["Feature head", certificate.revision.headCommitId],
              ["Tree", certificate.revision.treeId],
              ["Command manifest SHA-256", certificate.manifestDigest],
              ["Certificate", certificate.id],
              ...(review === null ? [] : [["Retained revision", review.revision.id]]),
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-all font-mono text-xs">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-muted-foreground">
            {certificate.evidenceIds.length} individual passing{" "}
            {certificate.evidenceIds.length === 1 ? "result is" : "results are"} retained for this
            exact head and tree.
          </p>
        </details>
      )}
    </div>
  );
}

function PublicationPanel({
  projectId,
  featureId,
  online = true,
  onOpenRevision,
  onAuthenticationError = ignoreAuthenticationError,
}: FeaturePublicationPanelProps) {
  const suspended = useContext(WorkspaceSuspendedContext);
  const [networkOnline, setNetworkOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine,
  );
  const active = online && networkOnline && !suspended;
  const [publication, setPublication] = useState<FactoryFeaturePublication | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const pending = useRef<RetryFactoryFeaturePublicationCommand | null>(null);
  const submitting = useRef(false);
  const read = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => {
    const connected = () => setNetworkOnline(true);
    const disconnected = () => setNetworkOnline(false);
    window.addEventListener("online", connected);
    window.addEventListener("offline", disconnected);
    return () => {
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", disconnected);
      mutation.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    read.current = controller;
    let timer: number | undefined;
    const cancelled = () => controller.signal.aborted;
    const refresh = async () => {
      if (cancelled() || submitting.current) return;
      setLoading(true);
      setError(null);
      try {
        const result = await fetchFactoryFeaturePublication(
          projectId,
          featureId,
          controller.signal,
        );
        if (cancelled()) return;
        setPublication(result);
        if (!["published", "cancelled"].includes(result.state))
          timer = window.setTimeout(() => {
            void refresh();
          }, 2_000);
      } catch (failure) {
        if (!cancelled() && !onAuthenticationError(failure))
          setError(
            planningRequestError(
              failure,
              "Publication status is unavailable. Refresh to check its saved outcome.",
            ),
          );
      } finally {
        if (!cancelled()) setLoading(false);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [active, projectId, featureId, generation, onAuthenticationError]);
  const retry = async () => {
    if (!active || submitting.current || publication?.canRetry !== true) return;
    const command = pending.current ?? { requestId: crypto.randomUUID() };
    pending.current = command;
    submitting.current = true;
    read.current?.abort();
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await retryFactoryFeaturePublication(
        projectId,
        featureId,
        command,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      pending.current = null;
      setPublication(result);
      setGeneration((value) => value + 1);
    } catch (failure) {
      if (controller.signal.aborted) return;
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
            "The retry could not be confirmed. Retry the same request to check its saved outcome.",
          ),
        );
    } finally {
      submitting.current = false;
      if (!controller.signal.aborted) {
        setBusy(false);
        setLoading(false);
      }
    }
  };
  return (
    <section
      aria-label="Feature pull request"
      className="min-w-0 space-y-4 rounded-lg border border-border bg-background p-4"
    >
      <h3 className="font-semibold">Feature pull request</h3>
      {publication === null ? (
        <p className="text-sm text-muted-foreground">
          {!active
            ? "Connect to check publication status."
            : loading
              ? "Loading publication status…"
              : "Publication status is unavailable."}
        </p>
      ) : (
        <PublicationDetails
          publication={publication}
          active={active}
          onOpenRevision={onOpenRevision}
        />
      )}
      {error === null ? null : (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {!active && publication !== null ? (
        <p className="text-sm text-muted-foreground">
          Showing the last confirmed publication status.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {publication?.canRetry === true ? (
          <Button
            type="button"
            variant="outline"
            disabled={!active || busy}
            onClick={() => {
              void retry();
            }}
          >
            {busy ? "Checking publication…" : "Retry publication"}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!active || busy || loading}
          onClick={() => setGeneration((value) => value + 1)}
        >
          Refresh publication
        </Button>
      </div>
    </section>
  );
}
export function FeaturePublicationPanel(props: FeaturePublicationPanelProps) {
  return <PublicationPanel key={`${props.projectId}:${props.featureId}`} {...props} />;
}
