import { useEffect, useRef, useState } from "react";
import type { FactoryBoard, FactoryWorkItem, FactoryIssuePublication } from "@kestrel/contracts";
import {
  ApiClientError,
  fetchFactoryBoard,
  fetchFactoryIssuePublication,
  retryFactoryIssuePublication,
} from "./api.js";
import { FactoryProviderProblem } from "./FeatureGitHubIssuesPanel.js";
import { FeatureExecutionPanel } from "./FeatureExecutionPanel.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { VerificationSummary } from "./FeaturePlanDocument.js";
import { Button } from "./components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog.js";

const columnLabels: Record<FactoryBoard["columns"][number]["id"], string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  completed: "Completed",
};
const blockingLabels = {
  dependency: "Waiting for dependencies",
  execution_unavailable: "Waiting for execution",
  publication: "Waiting for GitHub publication",
  cancelled: "Cancelled",
  human_gate: "Needs your decision",
};

function Activity({ activity }: { activity: FactoryBoard["activity"] }) {
  return activity.length === 0 ? (
    <p>No activity recorded.</p>
  ) : (
    <ol className="factory-activity">
      {activity.map((event) => (
        <li key={event.id}>
          <p>{event.summary}</p>
          <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
        </li>
      ))}
    </ol>
  );
}

function WorkItemCard({
  item,
  publication,
}: {
  item: FactoryWorkItem;
  publication?: FactoryIssuePublication["items"][number];
}) {
  const issueUrl = publication?.issue?.url ?? item.providerUrl;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="factory-work-card h-auto w-full flex-col items-start justify-start whitespace-normal text-left"
          aria-label={`${String(item.order)}. ${item.title}`}
        >
          <span className="factory-card-order">
            {item.order} · {item.key}
          </span>
          <strong>{item.title}</strong>
          {item.dependsOn.length === 0 ? null : <span>After {item.dependsOn.join(", ")}</span>}
          {item.blocking === null ? null : (
            <span className="factory-card-blocking">{blockingLabels[item.blocking.kind]}</span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="factory-item-dialog max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle>{item.title}</DialogTitle>
        <DialogDescription>
          Work Item {item.order} · {item.key} · {columnLabels[item.column]}
        </DialogDescription>
        {item.blocking === null ? null : (
          <p className="planning-notice">{item.blocking.explanation}</p>
        )}
        <p className="planning-message-content">{item.description}</p>
        <section>
          <h3>Requirements</h3>
          <ul>
            {item.requirementKeys.map((key) => (
              <li key={key}>{key}</li>
            ))}
          </ul>
        </section>
        <section>
          <h3>Depends on</h3>
          {item.dependsOn.length === 0 ? (
            <p>No dependencies.</p>
          ) : (
            <ul>
              {item.dependsOn.map((key) => (
                <li key={key}>{key}</li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3>Acceptance</h3>
          <ul>
            {item.acceptance.map((value, index) => (
              <li key={index}>{value}</li>
            ))}
          </ul>
        </section>
        <section>
          <h3>Verification</h3>
          <VerificationSummary commands={item.verification} />
        </section>
        <section>
          <h3>GitHub issue</h3>
          {issueUrl === null ? (
            <p>No confirmed GitHub issue link yet.</p>
          ) : (
            <a href={issueUrl} target="_blank" rel="noreferrer">
              Open linked issue
            </a>
          )}
        </section>
        <section>
          <h3>Activity</h3>
          <Activity activity={item.activity} />
        </section>
      </DialogContent>
    </Dialog>
  );
}

const publicationLabels: Record<FactoryIssuePublication["state"], string> = {
  not_approved: "GitHub publication starts after approval",
  pending: "Publishing GitHub issues",
  publishing: "Publishing GitHub issues",
  blocked: "GitHub publication needs attention",
  published: "GitHub issues published",
  cancelled: "GitHub publication cancelled",
};
const itemPublicationLabels: Record<FactoryIssuePublication["items"][number]["state"], string> = {
  pending: "Waiting to publish",
  publishing: "Publishing",
  reconciling: "Checking an existing write",
  published: "Published",
  blocked: "Blocked",
};

function PublicationSummary({
  publication,
  projectId,
  retryDisabled,
  onRetry,
}: {
  publication: FactoryIssuePublication;
  projectId: string;
  retryDisabled: boolean;
  onRetry: () => void;
}) {
  const completed = publication.items.filter((item) => item.state === "published").length;
  return (
    <section className="github-publication" aria-label="GitHub publication">
      <h3>{publicationLabels[publication.state]}</h3>
      {publication.state === "not_approved" ? (
        <p>New issues and imported issue links follow the approved plan.</p>
      ) : (
        <>
          <p role="status">
            {completed} of {publication.items.length} Work Items published
          </p>
          {publication.state === "pending" || publication.state === "publishing" ? (
            <p>
              Publication continues on the workstation if you leave this page. Required issue links
              and dependencies must finish before execution.
            </p>
          ) : null}
          {publication.failure === null ? null : (
            <FactoryProviderProblem failure={publication.failure} projectId={projectId} />
          )}
          <ol className="github-publication-items">
            {publication.items.map((item) => (
              <li key={item.workItemId}>
                <div>
                  <strong>{item.key}</strong> · {itemPublicationLabels[item.state]}
                  {item.issue === null ? null : (
                    <>
                      {" "}
                      ·{" "}
                      <a href={item.issue.url} target="_blank" rel="noreferrer">
                        #{item.issue.number}
                      </a>
                    </>
                  )}
                </div>
                {item.dependencyMode === null ? null : (
                  <p>
                    Dependencies:{" "}
                    {item.dependencyMode === "native"
                      ? "GitHub links"
                      : "text references in GitHub"}
                  </p>
                )}
                {item.failure === null || item.failure === publication.failure ? null : (
                  <FactoryProviderProblem failure={item.failure} projectId={projectId} />
                )}
              </li>
            ))}
          </ol>
          {publication.state === "blocked" ? (
            <Button variant="outline" disabled={retryDisabled} onClick={onRetry}>
              {publication.failure === "uncertain_write" ||
              publication.failure === "reconciliation_limit"
                ? "Reconcile publication"
                : "Retry publication"}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

export interface FeatureBoardPanelProps {
  projectId: string;
  featureId: string;
  online: boolean;
  onAuthenticationError: (error: unknown) => boolean;
  onViewPlan: () => void;
  loadBoard?: typeof fetchFactoryBoard;
  loadPublication?: typeof fetchFactoryIssuePublication;
  retryPublication?: typeof retryFactoryIssuePublication;
}

export function FeatureBoardPanel({
  projectId,
  featureId,
  online,
  onAuthenticationError,
  onViewPlan,
  loadBoard = fetchFactoryBoard,
  loadPublication = fetchFactoryIssuePublication,
  retryPublication = retryFactoryIssuePublication,
}: FeatureBoardPanelProps) {
  const [board, setBoard] = useState<FactoryBoard | null>(null);
  const [publication, setPublication] = useState<FactoryIssuePublication | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [generation, setGeneration] = useState(0);
  const alive = useRef(true);
  const submitting = useRef(false);
  const attempt = useRef<{ requestId: string } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!online) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all([
      loadBoard(projectId, featureId, controller.signal),
      loadPublication(projectId, featureId, controller.signal),
    ])
      .then(([result, publication]) => {
        if (controller.signal.aborted) return;
        if (result.feature.id !== featureId || publication.featureId !== featureId)
          throw new Error("The response contains a different feature");
        setBoard(result);
        setPublication(publication);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError(failure))
          setError(
            planningRequestError(failure, "The board could not be loaded. Refresh to retry."),
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, featureId, online, generation, onAuthenticationError, loadBoard, loadPublication]);
  useEffect(() => {
    if (
      !online ||
      loading ||
      error !== null ||
      (publication?.state !== "pending" &&
        publication?.state !== "publishing" &&
        board?.feature.state !== "queued" &&
        board?.feature.state !== "implementing")
    )
      return;
    const timer = window.setTimeout(() => setGeneration((value) => value + 1), 1000);
    return () => window.clearTimeout(timer);
  }, [online, loading, error, publication, board, generation]);
  const retry = async () => {
    if (!online || submitting.current) return;
    attempt.current ??= { requestId: crypto.randomUUID() };
    submitting.current = true;
    setBusy(true);
    setCommandError(null);
    try {
      const result = await retryPublication(projectId, featureId, attempt.current);
      if (!alive.current) return;
      if (result.featureId !== featureId) throw new Error("Unexpected publication");
      setPublication(result);
      attempt.current = null;
      setUncertain(false);
      setGeneration((value) => value + 1);
    } catch (failure) {
      if (alive.current && !onAuthenticationError(failure)) {
        const rejected =
          failure instanceof ApiClientError && failure.status >= 400 && failure.status < 500;
        if (rejected) attempt.current = null;
        setUncertain(!rejected);
        setCommandError(
          planningRequestError(
            failure,
            "Kestrel could not confirm the retry. Retry the same request safely.",
          ),
        );
        setGeneration((value) => value + 1);
      }
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section className="feature-board-panel" aria-label="Feature board">
      <header className="plan-panel-header">
        <div>
          <h2>Work Items</h2>
          <p>
            {board?.approvedVersion == null
              ? "Work Items appear after you approve a plan."
              : `Approved plan · version ${String(board.approvedVersion)}`}
          </p>
        </div>
        <div className="plan-actions">
          <Button variant="outline" onClick={onViewPlan}>
            View plan
          </Button>
          <Button
            variant="outline"
            disabled={!online || loading}
            onClick={() => setGeneration((value) => value + 1)}
          >
            Refresh board
          </Button>
        </div>
      </header>
      {error === null ? null : (
        <p role="alert" className="planning-error">
          {error}
        </p>
      )}
      {!online ? (
        <p>Reconnect to refresh the board. Previously confirmed issue links are retained.</p>
      ) : board === null && loading ? (
        <p role="status">Loading the board…</p>
      ) : null}
      {commandError === null ? null : (
        <div role="alert" className="planning-command-error">
          <p>{commandError}</p>
          {uncertain ? (
            <Button variant="outline" disabled={!online || busy} onClick={() => void retry()}>
              Retry request
            </Button>
          ) : null}
        </div>
      )}
      {publication === null ? null : (
        <PublicationSummary
          publication={publication}
          projectId={projectId}
          retryDisabled={!online || busy || uncertain || loading}
          onRetry={() => void retry()}
        />
      )}
      {board === null ? null : (
        <>
          {board.approvedVersion === null ? (
            <p className="planning-notice">Approve a saved plan to queue its Work Items.</p>
          ) : (
            <FeatureExecutionPanel
              projectId={projectId}
              featureId={featureId}
              online={online}
              onAuthenticationError={onAuthenticationError}
            />
          )}
          <div className="factory-board">
            {board.columns.map((column) => (
              <section
                className="factory-column"
                key={column.id}
                aria-label={columnLabels[column.id]}
              >
                <h3>
                  {columnLabels[column.id]} <span>{column.items.length}</span>
                </h3>
                {column.items.length === 0 ? (
                  <p className="factory-column-empty">No Work Items</p>
                ) : (
                  <ol>
                    {column.items.map((item) => {
                      const itemPublication = publication?.items.find(
                        (entry) => entry.workItemId === item.id,
                      );
                      return (
                        <li key={item.id}>
                          <WorkItemCard
                            item={item}
                            {...(itemPublication === undefined
                              ? {}
                              : { publication: itemPublication })}
                          />
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            ))}
          </div>
          <details className="factory-board-activity">
            <summary>Feature activity</summary>
            <Activity activity={board.activity} />
          </details>
        </>
      )}
    </section>
  );
}
