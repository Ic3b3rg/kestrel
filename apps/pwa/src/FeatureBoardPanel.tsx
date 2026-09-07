import { useEffect, useState } from "react";
import type { FactoryBoard, FactoryWorkItem } from "@kestrel/contracts";
import { fetchFactoryBoard } from "./api.js";
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
  cancelled: "Cancelled",
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

function WorkItemCard({ item }: { item: FactoryWorkItem }) {
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
          {item.providerUrl === null ? (
            <p>No GitHub issue has been created.</p>
          ) : (
            <a href={item.providerUrl} target="_blank" rel="noreferrer">
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

export function FeatureBoardPanel({
  projectId,
  featureId,
  online,
  onAuthenticationError,
  onViewPlan,
}: {
  projectId: string;
  featureId: string;
  online: boolean;
  onAuthenticationError: (error: unknown) => boolean;
  onViewPlan: () => void;
}) {
  const [board, setBoard] = useState<FactoryBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!online) {
      setBoard(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchFactoryBoard(projectId, featureId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.feature.id !== featureId)
          throw new Error("The response contains a different feature");
        setBoard(result);
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
  }, [projectId, featureId, online, generation, onAuthenticationError]);
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
        <p>Reconnect to read the saved board.</p>
      ) : board === null && loading ? (
        <p role="status">Loading the board…</p>
      ) : null}
      {board === null ? null : (
        <>
          <div className="planning-notice">
            {board.feature.state === "cancelled" ? (
              <p>This feature is cancelled.</p>
            ) : (
              <>
                <p>Execution is not available yet.</p>
                <p>
                  {board.approvedVersion === null
                    ? "Approve a saved plan to queue its Work Items."
                    : "This approved feature is queued. No implementation has started."}
                </p>
              </>
            )}
          </div>
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
                    {column.items.map((item) => (
                      <li key={item.id}>
                        <WorkItemCard item={item} />
                      </li>
                    ))}
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
