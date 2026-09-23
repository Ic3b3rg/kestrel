import { FormFeedback } from "./components/FormFeedback.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FactoryConceptualReviewWorkflowRead,
  FactoryFeatureMerge,
  FactoryFeaturePullRequest,
} from "@kestrel/contracts";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  GitMerge,
  GitPullRequest,
  RotateCw,
  ShieldCheck,
} from "lucide-react";

import {
  approveFactoryFeatureMerge,
  fetchCurrentFactoryFeatureMerge,
  retryFactoryFeatureMerge,
} from "./factory-feature-merge-api.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { Button } from "./components/ui/button.js";
import { Checkbox } from "./components/ui/checkbox.js";

const activeStates: FactoryFeatureMerge["state"][] = [
  "queued",
  "checking",
  "merging",
  "closing_issues",
];

const progressCopy: Record<FactoryFeatureMerge["state"], string> = {
  queued: "Approval is durable. Kestrel is about to reread the pull request and required checks.",
  checking:
    "Checking the exact reviewed head, pull request state, mergeability, and required checks.",
  merging:
    "The exact-head merge request is in flight. Kestrel will observe GitHub before advancing.",
  uncertain:
    "GitHub may have received the merge. Retry makes Kestrel observe the exact pull request before another write.",
  closing_issues:
    "The PR is merged. Kestrel is closing each linked issue and preserving every result.",
  blocked: "The merge stopped before completion. Resolve the reported condition, then retry.",
  completed: "The PR is merged, linked issues are closed, and the project queue is released.",
};

function shortId(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-7)}`;
}

export interface FeatureMergePanelProps {
  projectId: string;
  featureId: string;
  approvedVersion: number;
  review: FactoryConceptualReviewWorkflowRead;
  publication: { pullRequest: FactoryFeaturePullRequest; certificate: { id: string } };
  online: boolean;
  onAuthenticationError: (error: unknown) => boolean;
  onFeatureChanged?: () => void;
  loadCurrent?: typeof fetchCurrentFactoryFeatureMerge;
  approveMerge?: typeof approveFactoryFeatureMerge;
  retryMerge?: typeof retryFactoryFeatureMerge;
}

export function FeatureMergePanel({
  projectId,
  featureId,
  approvedVersion,
  review,
  publication,
  online,
  onAuthenticationError,
  onFeatureChanged = () => undefined,
  loadCurrent = fetchCurrentFactoryFeatureMerge,
  approveMerge = approveFactoryFeatureMerge,
  retryMerge = retryFactoryFeatureMerge,
}: FeatureMergePanelProps) {
  const [merge, setMerge] = useState<FactoryFeatureMerge | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const submitting = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approvalRequestId = useRef<string | null>(null);
  const retryRequestId = useRef<string | null>(null);
  const announcedFeatureChange = useRef(false);

  const read = useCallback(async () => {
    if (!online) return;
    try {
      const current = await loadCurrent(projectId, featureId);
      if (!alive.current) return;
      setMerge(current.merge);
      setReadError(null);
    } catch (failure) {
      if (alive.current && !onAuthenticationError(failure))
        setReadError(planningRequestError(failure, "The merge status is unavailable."));
    }
  }, [featureId, loadCurrent, onAuthenticationError, online, projectId]);

  useEffect(() => {
    void read();
  }, [read]);

  const active =
    merge !== null &&
    (activeStates.includes(merge.state) || (merge.failure === "rate_limited" && !merge.canRetry));
  useEffect(() => {
    if (!merge?.provider.merged || announcedFeatureChange.current) return;
    announcedFeatureChange.current = true;
    onFeatureChanged();
  }, [merge, onFeatureChanged]);
  useEffect(() => {
    if (!online || !active) return;
    const timer = window.setInterval(() => void read(), 1_000);
    return () => window.clearInterval(timer);
  }, [active, online, read]);

  const completeReview = review.artifact?.status === "complete";
  const exact =
    review.artifact !== null &&
    review.artifact.headCommitId === publication.pullRequest.headCommitId &&
    review.artifact.baseCommitId === publication.pullRequest.baseCommitId;

  const approve = async () => {
    if (
      !online ||
      submitting.current ||
      busy ||
      !acknowledged ||
      !completeReview ||
      !exact ||
      review.artifact === null
    )
      return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const requestId = approvalRequestId.current ?? crypto.randomUUID();
    approvalRequestId.current = requestId;
    try {
      const result = await approveMerge(projectId, featureId, {
        requestId,
        decision: "approve_merge",
        expectedPlanVersion: approvedVersion,
        review: {
          workflowId: review.workflow.id,
          artifactId: review.artifact.id,
          headCommitId: review.artifact.headCommitId,
        },
      });
      if (!alive.current) return;
      setMerge(result);
      approvalRequestId.current = null;
    } catch (failure) {
      if (alive.current && !onAuthenticationError(failure))
        setError(planningRequestError(failure, "The exact-head merge was not approved."));
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const retry = async () => {
    if (!online || submitting.current || busy || merge === null || !merge.canRetry) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const requestId = retryRequestId.current ?? crypto.randomUUID();
    retryRequestId.current = requestId;
    try {
      setMerge(
        await retryMerge(projectId, featureId, {
          requestId,
        }),
      );
      retryRequestId.current = null;
    } catch (failure) {
      if (alive.current && !onAuthenticationError(failure))
        setError(planningRequestError(failure, "The remaining merge work was not queued."));
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return (
    <section
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4"
      aria-label="Approve reviewed Feature merge"
    >
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-emerald-500/10 text-emerald-400">
          <GitMerge className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-emerald-400">
            Human merge gate
          </p>
          <h3 className="font-semibold">Approve exact reviewed head</h3>
          <p className="text-sm text-muted-foreground">
            Kestrel will reread GitHub, require the same head and successful required checks, then
            merge without bypassing repository protection. Completion closes linked issues and
            releases this project&apos;s next Feature.
          </p>
        </div>
      </div>

      <div className="grid gap-3 rounded-lg border border-border bg-background p-3 sm:grid-cols-3">
        <div>
          <p className="text-xs text-muted-foreground">Pull request</p>
          <a
            href={publication.pullRequest.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 flex items-center gap-1.5 text-sm font-medium underline underline-offset-4"
          >
            <GitPullRequest className="size-3.5" aria-hidden="true" /> #
            {publication.pullRequest.number}
          </a>
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Reviewed head</p>
          <p
            className="mt-1 truncate font-mono text-xs"
            title={publication.pullRequest.headCommitId}
          >
            {shortId(publication.pullRequest.headCommitId)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Final verification</p>
          <p className="mt-1 flex items-center gap-1.5 text-sm font-medium">
            <ShieldCheck className="size-3.5 text-emerald-400" aria-hidden="true" />
            {completeReview ? "All final checks are linked" : "Complete review required"}
          </p>
        </div>
      </div>

      {merge === null ? (
        <div className="grid gap-3">
          {!exact ? (
            <FormFeedback kind="error" className="text-sm text-amber-300">
              This review does not identify the currently published pull request head.
            </FormFeedback>
          ) : null}
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-background p-3 text-sm">
            <Checkbox
              checked={acknowledged}
              disabled={!online || busy || !completeReview || !exact}
              onCheckedChange={(value) => setAcknowledged(value === true)}
              aria-label="Confirm review and exact-head merge"
            />
            <span>
              I reviewed the approved outcomes, implemented behaviors, evidence, and reported
              problems. I approve merging this exact head.
            </span>
          </label>
          <Button
            type="button"
            className="w-fit"
            disabled={!online || busy || !acknowledged || !completeReview || !exact}
            onClick={() => void approve()}
          >
            {busy
              ? "Approving merge…"
              : `Approve and merge PR #${String(publication.pullRequest.number)}`}
          </Button>
        </div>
      ) : (
        <div
          className="space-y-3 rounded-lg border border-border bg-background p-3"
          aria-live="polite"
        >
          <p className="flex items-center gap-2 text-sm font-medium">
            {merge.state === "completed" ? (
              <CheckCircle2 className="size-4 text-emerald-400" aria-hidden="true" />
            ) : ["blocked", "uncertain"].includes(merge.state) || merge.failure !== null ? (
              <AlertTriangle className="size-4 text-amber-300" aria-hidden="true" />
            ) : (
              <RotateCw className="size-4 animate-spin" aria-hidden="true" />
            )}
            {merge.provider.merged ? "PR merged" : merge.state.replaceAll("_", " ")}
          </p>
          <p className="text-sm text-muted-foreground">{progressCopy[merge.state]}</p>
          {merge.failure === null ? null : (
            <p className="text-xs text-amber-300">Reason: {merge.failure.replaceAll("_", " ")}</p>
          )}
          {merge.provider.mergeCommitId === null ? null : (
            <p className="font-mono text-xs text-muted-foreground">
              Merge commit {shortId(merge.provider.mergeCommitId)}
            </p>
          )}
          <ul className="grid gap-2" aria-label="Linked issue closure results">
            {merge.issues.map((issue) => (
              <li
                key={issue.workItemId}
                className="flex items-start justify-between gap-3 rounded-md border border-border p-2 text-sm"
              >
                <span className="min-w-0">
                  <a
                    href={issue.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline underline-offset-4"
                  >
                    {issue.key} · issue #{issue.number}
                  </a>
                  {issue.failure === null ? null : (
                    <span className="mt-0.5 block text-xs text-amber-300">
                      {issue.failure.replaceAll("_", " ")}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  {issue.state === "closed" ? (
                    <CheckCircle2 className="size-3.5 text-emerald-400" aria-hidden="true" />
                  ) : (
                    <CircleDot className="size-3.5" aria-hidden="true" />
                  )}
                  {issue.state}
                </span>
              </li>
            ))}
          </ul>
          {merge.canRetry ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void retry()}
            >
              {busy ? "Queuing retry…" : "Retry remaining work"}
            </Button>
          ) : null}
        </div>
      )}

      {busy ? (
        <FormFeedback kind="pending">Submitting the exact-head merge command…</FormFeedback>
      ) : null}
      {readError === null ? null : <FormFeedback kind="error">{readError}</FormFeedback>}
      {error === null ? null : (
        <FormFeedback kind="error" focus className="text-sm text-destructive">
          {error}
        </FormFeedback>
      )}
    </section>
  );
}
