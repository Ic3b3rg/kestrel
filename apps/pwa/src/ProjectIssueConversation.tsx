import { useEffect, useState } from "react";
import type { Feature, ProjectIssueStart } from "@kestrel/contracts";
import { FeatureChatPanel } from "./FeatureChatPanel.js";
import { changeProjectIssueStart, fetchProjectIssueStart } from "./project-issue-api.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { appPath, type AppRoute } from "./app-route.js";
import { Button } from "./components/ui/button.js";
import { FormFeedback } from "./components/FormFeedback.js";

export interface ProjectIssueConversationProps {
  projectId: string;
  projectName: string;
  startId: string;
  online: boolean;
  onNavigate: (route: Exclude<AppRoute, { kind: "not_found" }>) => void;
  onAuthenticationError: (error: unknown) => boolean;
  onFeatureRead: (feature: Feature) => void;
  onFeatureUnavailable: (projectId: string, featureId: string) => void;
  onPlanDirtyChange?: (dirty: boolean) => void;
}

const labels: Record<ProjectIssueStart["state"], string> = {
  queued: "Waiting for development",
  preparing: "Preparing development",
  running: "Development started",
  blocked: "Preparation paused",
  done: "Work ended",
};

export function ProjectIssueConversation({
  projectId,
  projectName,
  startId,
  online,
  onNavigate,
  onAuthenticationError,
  onFeatureRead,
  onFeatureUnavailable,
  onPlanDirtyChange,
}: ProjectIssueConversationProps) {
  const [start, setStart] = useState<ProjectIssueStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const result = await fetchProjectIssueStart(projectId, startId, controller.signal);
        if (controller.signal.aborted) return;
        setStart(result);
        setError(null);
        if (result.state !== "done") timer = setTimeout(() => void read(), 2_000);
      } catch (failure) {
        if (controller.signal.aborted || onAuthenticationError(failure)) return;
        setError(planningRequestError(failure, "This issue conversation could not be refreshed."));
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [projectId, startId, online, generation, onAuthenticationError]);

  const retry = async () => {
    if (!online || retrying) return;
    setRetrying(true);
    setError(null);
    try {
      await changeProjectIssueStart(projectId, startId, "retry");
      setStart((current) =>
        current?.id === startId ? { ...current, state: "preparing", message: null } : current,
      );
      setGeneration((value) => value + 1);
    } catch (failure) {
      if (!onAuthenticationError(failure))
        setError(planningRequestError(failure, "Preparation could not be retried."));
    } finally {
      setRetrying(false);
    }
  };

  const projectRoute = { kind: "project" as const, projectId };
  return (
    <section className="min-w-0 space-y-4" aria-label="Issue conversation">
      <a
        href={appPath(projectRoute)}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          onNavigate(projectRoute);
        }}
      >
        {projectName} board
      </a>
      {start === null ? (
        <div role="status" aria-busy={online && error === null}>
          {error !== null
            ? "Issue conversation unavailable"
            : online
              ? "Opening issue conversation…"
              : "Reconnect to open this issue conversation."}
        </div>
      ) : (
        <>
          <header className="min-w-0 space-y-2">
            <p className="text-sm text-muted-foreground">Issue #{start.issueNumber}</p>
            {start.featureId === null ? (
              <h1 className="break-words text-2xl font-semibold">{start.title}</h1>
            ) : null}
            <a href={start.issueUrl} target="_blank" rel="noreferrer">
              View GitHub issue
            </a>
          </header>
          <div className="min-w-0 space-y-2 text-sm text-muted-foreground" role="status">
            <strong>
              {start.state === "done" && start.featureId === null
                ? "Queued work cancelled"
                : labels[start.state]}
            </strong>
            {start.message === null ? null : (
              <p className="whitespace-pre-wrap break-words">{start.message}</p>
            )}
            {start.state !== "blocked" ? null : (
              <>
                {start.featureId === null ? null : (
                  <p>Answer the question in the conversation, then resume preparation.</p>
                )}
                <Button type="button" disabled={!online || retrying} onClick={() => void retry()}>
                  {retrying ? "Retrying…" : "Retry preparation"}
                </Button>
              </>
            )}
          </div>
          {start.featureId === null ? null : (
            <FeatureChatPanel
              key={`${start.featureId}:${start.state}`}
              projectId={projectId}
              projectName={projectName}
              featureId={start.featureId}
              issueConversation
              online={online}
              onNavigate={onNavigate}
              onAuthenticationError={onAuthenticationError}
              onFeatureRead={onFeatureRead}
              onFeatureUnavailable={onFeatureUnavailable}
              {...(onPlanDirtyChange === undefined ? {} : { onPlanDirtyChange })}
            />
          )}
        </>
      )}
      {error === null ? null : (
        <FormFeedback kind="error">
          {error}
          <Button
            type="button"
            variant="outline"
            onClick={() => setGeneration((value) => value + 1)}
          >
            Refresh conversation
          </Button>
        </FormFeedback>
      )}
    </section>
  );
}
