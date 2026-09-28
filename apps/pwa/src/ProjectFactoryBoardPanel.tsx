import { FormFeedback } from "./components/FormFeedback.js";
import { useId, type MouseEvent } from "react";
import { ArrowUpRight, GitPullRequest, Plus, RefreshCw, Settings } from "lucide-react";
import type { ProjectBoardSnapshot, ProjectBoardWorkItem } from "@kestrel/contracts";
import { Button } from "./components/ui/button.js";
import { FactoryProviderProblem } from "./FeatureGitHubIssuesPanel.js";

const columns = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "in_review", label: "In review" },
  { id: "completed", label: "Completed" },
] as const;

export interface ProjectFactoryBoardPanelProps {
  projectId: string;
  projectName: string;
  snapshot: ProjectBoardSnapshot | null;
  online: boolean;
  loading: boolean;
  error: string | null;
  onStartPlan: () => void;
  onStartIssue?: (entry: ProjectBoardWorkItem) => void;
  onStartGitHubIssue?: (issue: ProjectBoardSnapshot["github"]["issues"][number]) => void;
  startingIssueId?: string | null;
  startError?: string | null;
  onOpenFeature: (featureId: string, view: "chat" | "plan" | "board") => void;
  onRefresh: () => void;
  onOpenPullRequests: () => void;
  onOpenSettings: () => void;
  settingsHref: string;
}

function openSettings(event: MouseEvent<HTMLAnchorElement>, onOpenSettings: () => void): void {
  if (
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.currentTarget.target === "_blank"
  )
    return;
  event.preventDefault();
  onOpenSettings();
}

function GitHubIssueCard({
  issue,
  onStart,
  disabled,
}: {
  issue: ProjectBoardSnapshot["github"]["issues"][number];
  onStart?: ProjectFactoryBoardPanelProps["onStartGitHubIssue"];
  disabled: boolean;
}) {
  return (
    <li
      className="min-w-0"
      draggable={!disabled && onStart !== undefined}
      onDragStart={(event) =>
        event.dataTransfer.setData("application/x-kestrel-github-issue", issue.id)
      }
    >
      <Button
        asChild
        variant="outline"
        className="h-auto w-full min-w-0 flex-col items-start gap-2 p-3 text-left"
      >
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open GitHub issue #${String(issue.number)}: ${issue.title}`}
        >
          <span className="text-xs font-normal text-muted-foreground">
            GitHub issue #{issue.number}
          </span>
          <strong className="max-w-full break-words font-medium">{issue.title}</strong>
          <span className="max-w-full break-words text-xs font-normal text-muted-foreground">
            {issue.repository.owner}/{issue.repository.name}
          </span>
        </a>
      </Button>
      {onStart === undefined ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onStart(issue)}
          aria-label={`Review requirements: ${issue.title}`}
        >
          Review requirements
        </Button>
      )}
      {onStart === undefined ? null : (
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          Review this issue's requirements before starting execution.
        </p>
      )}
    </li>
  );
}

function WorkItemCard({
  feature,
  item,
  onOpenFeature,
  onStart,
  disabled,
}: {
  onStart?: ProjectFactoryBoardPanelProps["onStartIssue"];
  disabled: boolean;
  feature: ProjectBoardWorkItem["feature"];
  item: ProjectBoardWorkItem["item"];
  onOpenFeature: ProjectFactoryBoardPanelProps["onOpenFeature"];
}) {
  const contextId = useId();
  const hasContext = item.dependsOn.length > 0 || item.blocking !== null;
  return (
    <li
      className="min-w-0 rounded-lg border border-border bg-card"
      draggable={
        !disabled &&
        onStart !== undefined &&
        item.column === "todo" &&
        item.executionFeatureId == null &&
        item.blocking === null
      }
      onDragStart={(event) =>
        event.dataTransfer.setData("application/x-kestrel-work-item", item.id)
      }
    >
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full min-w-0 flex-col items-start gap-2 p-3 text-left"
        aria-label={"Open Work Item: " + item.title + " · " + feature.title}
        aria-describedby={hasContext ? contextId : undefined}
        onClick={() => onOpenFeature(item.executionFeatureId ?? feature.id, "board")}
      >
        <span className="max-w-full break-words text-xs font-normal text-muted-foreground">
          Feature · {feature.title}
        </span>
        <strong className="max-w-full break-words font-medium">{item.title}</strong>
        <span className="text-xs font-normal text-muted-foreground">
          {item.order} · {item.key}
        </span>
        {hasContext ? (
          <span id={contextId} className="flex max-w-full flex-col gap-2 text-xs font-normal">
            {item.dependsOn.length === 0 ? null : (
              <span className="break-words text-muted-foreground">
                After {item.dependsOn.join(", ")}
              </span>
            )}
            {item.blocking === null ? null : (
              <span className="break-words border-l-2 border-border pl-2">
                {item.blocking.explanation}
              </span>
            )}
          </span>
        ) : null}
      </Button>
      {item.column === "todo" && item.executionFeatureId != null && item.blocking === null ? (
        <p className="px-3 pb-2 text-xs" role="status">
          Start requested · waiting for capacity
        </p>
      ) : item.column === "todo" && onStart !== undefined ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || item.blocking !== null || item.providerUrl === null}
          onClick={() => onStart({ feature, item })}
          aria-label={`Start issue: ${item.title}`}
        >
          Start issue
        </Button>
      ) : null}
      {item.executionFeatureId == null ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onOpenFeature(feature.id, "chat")}
        >
          Original requirements
        </Button>
      )}
      {item.providerUrl === null ? null : (
        <div className="border-t border-border px-2 py-1">
          <Button asChild variant="ghost" size="sm" className="text-muted-foreground">
            <a
              href={item.providerUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={"Open linked issue for " + item.title}
            >
              Linked issue <ArrowUpRight aria-hidden="true" />
            </a>
          </Button>
        </div>
      )}
    </li>
  );
}

export function ProjectFactoryBoardPanel({
  projectId,
  projectName,
  snapshot,
  online,
  loading,
  error,
  onStartPlan,
  onStartIssue,
  onStartGitHubIssue,
  startingIssueId,
  startError,
  onOpenFeature,
  onRefresh,
  onOpenPullRequests,
  onOpenSettings,
  settingsHref,
}: ProjectFactoryBoardPanelProps) {
  const titleId = useId();
  const planningFeatures = snapshot?.planningFeatures ?? [];
  const workItems = snapshot?.workItems ?? [];
  const availableGitHubIssues = snapshot?.github.issues ?? [];
  const githubIssueFailure = snapshot?.github.failure ?? null;
  const githubIssuesLimited = snapshot?.github.limited ?? false;
  return (
    <section className="min-w-0 space-y-6" aria-labelledby={titleId} aria-busy={loading}>
      {startError == null ? null : <FormFeedback kind="error">{startError}</FormFeedback>}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-1 text-sm text-muted-foreground">Project board</p>
          <h1 id={titleId} className="break-words text-2xl font-semibold tracking-tight">
            {projectName}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button type="button" variant="ghost" onClick={onOpenPullRequests}>
            <GitPullRequest aria-hidden="true" /> Pull requests
          </Button>
          <Button asChild variant="ghost">
            <a href={settingsHref} onClick={(event) => openSettings(event, onOpenSettings)}>
              <Settings aria-hidden="true" /> Project settings
            </a>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Refresh board"
            disabled={!online || loading}
            onClick={onRefresh}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        </div>
      </header>
      {error === null ? null : (
        <FormFeedback kind="error" focus className="text-sm">
          {error}
        </FormFeedback>
      )}
      {!online ? (
        <p role="status" className="text-sm text-muted-foreground">
          Reconnect to refresh this board.
        </p>
      ) : null}
      {githubIssueFailure === null ? null : (
        <FormFeedback kind="error">
          <FactoryProviderProblem failure={githubIssueFailure} projectId={projectId} />
        </FormFeedback>
      )}
      {snapshot?.github.retained ? (
        <p role="status" className="text-sm text-muted-foreground">
          Showing the last available GitHub issues.
        </p>
      ) : null}
      {githubIssuesLimited ? (
        <p role="status" className="text-sm text-muted-foreground">
          Showing a limited set of GitHub issues. More open GitHub issues may exist.
        </p>
      ) : null}
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {columns.map((column) => {
          const items = workItems.filter(({ item }) => item.column === column.id);
          const drafts = column.id === "todo" ? planningFeatures : [];
          const providerIssues = column.id === "todo" ? availableGitHubIssues : [];
          const count = items.length + drafts.length + providerIssues.length;
          return (
            <section
              key={column.id}
              onDragOver={(event) => {
                if (
                  online &&
                  column.id === "in_progress" &&
                  (event.dataTransfer.types.includes("application/x-kestrel-work-item") ||
                    event.dataTransfer.types.includes("application/x-kestrel-github-issue"))
                )
                  event.preventDefault();
              }}
              onDrop={(event) => {
                if (!online || startingIssueId != null || column.id !== "in_progress") return;
                event.preventDefault();
                const id = event.dataTransfer.getData("application/x-kestrel-work-item");
                const entry = workItems.find(
                  ({ item }) => item.id === id && item.column === "todo",
                );
                if (entry !== undefined) onStartIssue?.(entry);
                const providerId = event.dataTransfer.getData("application/x-kestrel-github-issue");
                const issue = availableGitHubIssues.find((item) => item.id === providerId);
                if (issue !== undefined) onStartGitHubIssue?.(issue);
              }}
              aria-label={column.label}
              className="flex min-w-0 flex-col gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 sm:min-h-64"
            >
              <header className="flex min-h-8 items-center justify-between gap-2">
                <h2 className="text-sm font-medium">
                  {column.label} <span className="ml-1 text-muted-foreground">{count}</span>
                </h2>
                {column.id === "todo" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="New interview"
                    onClick={onStartPlan}
                  >
                    <Plus aria-hidden="true" /> New
                  </Button>
                ) : null}
              </header>
              {count === 0 ? (
                loading ? null : (
                  <p className="py-3 text-sm text-muted-foreground">
                    {column.id === "todo"
                      ? "Start an interview to add work."
                      : "Work appears here as it progresses."}
                  </p>
                )
              ) : (
                <ol className="space-y-3">
                  {drafts.map((feature) => (
                    <li key={feature.id} className="min-w-0">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-auto w-full min-w-0 flex-col items-start gap-2 p-3 text-left"
                        aria-label={"Open planning chat: " + feature.title}
                        onClick={() => onOpenFeature(feature.id, "chat")}
                      >
                        <span className="text-xs font-normal text-muted-foreground">Planning</span>
                        <strong className="max-w-full break-words font-medium">
                          {feature.title}
                        </strong>
                        <span className="text-xs font-normal text-muted-foreground">
                          Continue conversation
                        </span>
                      </Button>
                    </li>
                  ))}
                  {providerIssues.map((issue) => (
                    <GitHubIssueCard
                      key={issue.id}
                      issue={issue}
                      onStart={onStartGitHubIssue}
                      disabled={!online || startingIssueId != null}
                    />
                  ))}
                  {items.map(({ feature, item }) => (
                    <WorkItemCard
                      key={item.id}
                      feature={feature}
                      item={item}
                      onOpenFeature={onOpenFeature}
                      onStart={onStartIssue}
                      disabled={!online || startingIssueId != null}
                    />
                  ))}
                </ol>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
