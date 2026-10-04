import { Skeleton } from "./components/ui/skeleton.js";
import { FormFeedback } from "./components/FormFeedback.js";
import { useEffect, useId, useState, type MouseEvent, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  ArrowUpRight,
  GitPullRequest,
  GripVertical,
  Plus,
  RefreshCw,
  Settings,
} from "lucide-react";
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
  onStartWorkItem?: (entry: ProjectBoardWorkItem) => void;
  onStartGitHubIssue?: (issue: ProjectBoardSnapshot["github"]["issues"][number]) => void;
  startingIssueId?: string | null;
  startError?: string | null;
  onOpenFeature: (featureId: string, view: "chat" | "plan" | "board") => void;
  onRefresh: () => void;
  onOpenPullRequests: () => void;
  onOpenSettings: () => void;
  settingsHref: string;
  onOpenIssue?: (number: number) => void;
  onStartIssue?: (number: number) => void;
  onOpenStart?: (id: string) => void;
  startingIssue?: number | null;
  onCancelStart?: (id: string) => void;
  onRetryStart?: (id: string) => void;
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

function BoardColumn({ id, children }: { id: string; children: ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id, disabled: id !== "in_progress" });
  return (
    <section
      ref={setNodeRef}
      aria-label={columns.find((column) => column.id === id)?.label}
      className={`flex min-w-0 flex-col gap-3 rounded-lg border bg-muted/20 p-3 sm:min-h-64 ${isOver ? "border-primary bg-primary/5" : "border-border/60"}`}
    >
      {children}
    </section>
  );
}

function DraggableCard({
  id,
  enabled,
  children,
}: {
  id: string;
  enabled: boolean;
  children: ReactNode;
}) {
  const { attributes, listeners, isDragging, setNodeRef, setActivatorNodeRef } = useDraggable({
    id,
    disabled: !enabled,
  });
  return (
    <li
      ref={setNodeRef}
      onPointerDown={(event) => {
        if (enabled) listeners?.onPointerDown?.(event);
      }}
      data-draggable={enabled || undefined}
      className={`min-w-0 rounded-lg border border-border bg-card ${isDragging ? "opacity-35" : ""}`}
    >
      {enabled ? (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          onKeyDown={(event) => {
            listeners?.onKeyDown?.(event);
          }}
          aria-label="Drag to In progress"
          className="m-1 rounded p-2 text-muted-foreground hover:bg-muted focus-visible:outline-ring"
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
      ) : null}
      {children}
    </li>
  );
}

function GitHubIssueCard({
  issue,
  readyLabel,
  online,
  onOpen,
  onStart,
  starting,
  onReview,
}: {
  issue: ProjectBoardSnapshot["github"]["issues"][number];
  readyLabel: string;
  online: boolean;
  onOpen?: ((number: number) => void) | undefined;
  onStart?: ((number: number) => void) | undefined;
  starting: boolean;
  onReview?: ProjectFactoryBoardPanelProps["onStartGitHubIssue"];
}) {
  const eligible =
    online &&
    !starting &&
    issue.state === "open" &&
    (issue.labels ?? []).some((label) => label.name === readyLabel);
  return (
    <DraggableCard id={`issue:${issue.id}`} enabled={eligible && onStart !== undefined}>
      <Button
        variant="ghost"
        className="h-auto w-full min-w-0 flex-col items-start gap-2 p-3 text-left"
        aria-label={`Open issue #${String(issue.number)}: ${issue.title}`}
        onClick={() => onOpen?.(issue.number)}
      >
        <span className="text-xs font-normal text-muted-foreground">
          GitHub issue #{issue.number}
        </span>
        <strong className="max-w-full break-words font-medium">{issue.title}</strong>
        <span className="flex max-w-full flex-wrap gap-1">
          {(issue.labels ?? []).map((label) => (
            <span
              key={label.name}
              className="rounded border border-border px-1.5 py-0.5 text-xs font-normal"
            >
              {label.name}
            </span>
          ))}
        </span>
        <span className="text-xs font-normal text-muted-foreground">
          {issue.commentCount ?? 0} comments
        </span>
      </Button>
      <div className="flex flex-wrap items-center justify-between border-t border-border px-2 py-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={!eligible || onStart === undefined}
          aria-label={`Start issue #${String(issue.number)}`}
          onClick={() => onStart?.(issue.number)}
        >
          {starting ? "Starting…" : "Start"}
        </Button>
        <a
          className="text-xs text-muted-foreground underline"
          href={issue.url}
          target="_blank"
          rel="noreferrer"
        >
          GitHub <ArrowUpRight className="inline size-3" aria-hidden="true" />
        </a>
      </div>
      {!eligible && onReview !== undefined ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={!online || starting}
          onClick={() => onReview(issue)}
          aria-label={`Review requirements: ${issue.title}`}
        >
          Review requirements
        </Button>
      ) : null}
      {!eligible && online && !starting ? (
        <p className="px-3 pb-2 text-xs text-muted-foreground">Requires {readyLabel}</p>
      ) : null}
    </DraggableCard>
  );
}

function WorkItemCard({
  feature,
  item,
  onOpenFeature,
  onOpenIssue,
  queued,
  onStart,
  disabled,
}: {
  onStart?: ProjectFactoryBoardPanelProps["onStartWorkItem"];
  disabled: boolean;
  feature: ProjectBoardWorkItem["feature"];
  item: ProjectBoardWorkItem["item"];
  onOpenFeature: ProjectFactoryBoardPanelProps["onOpenFeature"];
  onOpenIssue?: ((number: number) => void) | undefined;
  queued?: boolean | undefined;
}) {
  const contextId = useId();
  const hasContext = item.dependsOn.length > 0 || item.blocking !== null;
  return (
    <DraggableCard
      id={`work:${item.id}`}
      enabled={
        !disabled &&
        onStart !== undefined &&
        item.column === "todo" &&
        item.executionFeatureId == null &&
        item.blocking === null
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
        {queued ? (
          <span className="text-xs text-muted-foreground">Waiting for development</span>
        ) : null}
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
              onClick={(event) => {
                const number = Number(item.providerUrl?.split("/").at(-1));
                if (
                  onOpenIssue &&
                  Number.isSafeInteger(number) &&
                  event.button === 0 &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.shiftKey &&
                  !event.altKey
                ) {
                  event.preventDefault();
                  onOpenIssue(number);
                }
              }}
              target="_blank"
              rel="noreferrer"
              aria-label={"Open linked issue for " + item.title}
            >
              Linked issue <ArrowUpRight aria-hidden="true" />
            </a>
          </Button>
        </div>
      )}
    </DraggableCard>
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
  onStartWorkItem,
  onStartGitHubIssue,
  startingIssueId,
  startError,
  onOpenFeature,
  onRefresh,
  onOpenPullRequests,
  onOpenSettings,
  settingsHref,
  onOpenIssue,
  onStartIssue,
  onOpenStart,
  startingIssue,
  onCancelStart,
  onRetryStart,
}: ProjectFactoryBoardPanelProps) {
  const titleId = useId();
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<
    { kind: "issue"; id: string; number: number } | { kind: "work"; id: string } | null
  >(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const initialLoading = loading && snapshot === null;
  const planningFeatures = snapshot?.planningFeatures ?? [];
  const workItems = snapshot?.workItems ?? [];
  const availableGitHubIssues = snapshot?.github.issues ?? [];
  const githubIssueFailure = snapshot?.github.failure ?? null;
  const githubIssuesLimited = snapshot?.github.limited ?? false;
  useEffect(() => {
    if (optimistic === null) return;
    if (startError != null) {
      setOptimistic(null);
      return;
    }
    if (optimistic.kind === "issue") {
      if (
        (snapshot?.starts ?? []).some(
          (start) => start.issueNumber === optimistic.number && start.state !== "done",
        )
      )
        setOptimistic(null);
    } else if (workItems.some(({ item }) => item.id === optimistic.id && item.column !== "todo")) {
      setOptimistic(null);
    }
  }, [optimistic, startError, availableGitHubIssues, snapshot?.starts, workItems]);
  const pendingIssue =
    optimistic?.kind === "issue" && startError == null
      ? availableGitHubIssues.find((issue) => issue.id === optimistic.id)
      : undefined;
  const pendingWork =
    optimistic?.kind === "work" && startError == null
      ? workItems.find(({ item }) => item.id === optimistic.id)
      : undefined;
  const pendingVisible =
    (pendingIssue !== undefined &&
      !(snapshot?.starts ?? []).some(
        (start) => start.issueNumber === pendingIssue.number && start.state !== "done",
      )) ||
    (pendingWork !== undefined && pendingWork.item.column === "todo");
  function beginIssue(issue: (typeof availableGitHubIssues)[number]) {
    if (!online || startingIssueId != null || onStartIssue === undefined) return;
    setOptimistic({ kind: "issue", id: issue.id, number: issue.number });
    onStartIssue(issue.number);
  }
  function beginWork(entry: ProjectBoardWorkItem) {
    if (!online || startingIssueId != null || onStartWorkItem === undefined) return;
    setOptimistic({ kind: "work", id: entry.item.id });
    onStartWorkItem(entry);
  }
  function drop(event: DragEndEvent) {
    setDraggedId(null);
    if (!online || event.over?.id !== "in_progress") return;
    const id = String(event.active.id);
    if (id.startsWith("issue:")) {
      const issue = availableGitHubIssues.find((candidate) => `issue:${candidate.id}` === id);
      if (issue !== undefined) beginIssue(issue);
    } else if (id.startsWith("work:")) {
      const entry = workItems.find(
        ({ item }) => `work:${item.id}` === id && item.column === "todo",
      );
      if (entry !== undefined) beginWork(entry);
    }
  }
  const draggedIssue = availableGitHubIssues.find((issue) => `issue:${issue.id}` === draggedId);
  const draggedWork = workItems.find(({ item }) => `work:${item.id}` === draggedId);
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
      {snapshot?.github.fetchedAt ? (
        <p className="text-xs text-muted-foreground">
          GitHub updated {new Date(snapshot.github.fetchedAt).toLocaleString()}
          {snapshot.github.refreshing ? " · Refreshing…" : ""}
        </p>
      ) : null}
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
      {initialLoading ? (
        <p role="status" className="sr-only">
          Loading board…
        </p>
      ) : null}
      <DndContext
        sensors={sensors}
        onDragStart={(event) => setDraggedId(String(event.active.id))}
        onDragCancel={() => setDraggedId(null)}
        onDragEnd={drop}
      >
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {columns.map((column) => {
            const items = workItems.filter(
              ({ item }) =>
                item.column === column.id &&
                !(column.id === "todo" && pendingVisible && pendingWork?.item.id === item.id),
            );
            const drafts = column.id === "todo" ? planningFeatures : [];
            const providerIssues =
              column.id === "todo"
                ? availableGitHubIssues.filter(
                    (issue) =>
                      !(pendingVisible && pendingIssue?.id === issue.id) &&
                      !(snapshot?.starts ?? []).some(
                        (start) => start.state !== "done" && start.issueNumber === issue.number,
                      ),
                  )
                : [];
            const starts =
              column.id === "in_progress" || column.id === "completed"
                ? (snapshot?.starts ?? []).filter(
                    (start) =>
                      (column.id === "completed"
                        ? start.state === "done"
                        : start.state !== "done") &&
                      !(
                        start.state === "done" &&
                        availableGitHubIssues.some((issue) => issue.number === start.issueNumber)
                      ) &&
                      !workItems.some(({ feature }) => feature.id === start.featureId),
                  )
                : [];
            const optimisticHere = column.id === "in_progress" && pendingVisible;
            const count =
              items.length +
              drafts.length +
              providerIssues.length +
              starts.length +
              (optimisticHere ? 1 : 0);
            return (
              <BoardColumn key={column.id} id={column.id}>
                <header className="flex min-h-8 items-center justify-between gap-2">
                  <h2 className="text-sm font-medium">
                    {column.label}{" "}
                    {!initialLoading ? (
                      <span className="ml-1 text-muted-foreground">{count}</span>
                    ) : null}
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
                  initialLoading ? (
                    <div aria-hidden="true" className="space-y-3">
                      {[0, 1].map((index) => (
                        <div
                          key={index}
                          className="space-y-3 rounded-lg border border-border bg-card p-3"
                        >
                          <Skeleton className="h-3 w-16 motion-reduce:animate-none" />
                          <Skeleton className="h-4 w-full motion-reduce:animate-none" />
                          <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
                          <Skeleton className="h-5 w-24 rounded-full motion-reduce:animate-none" />
                        </div>
                      ))}
                    </div>
                  ) : (
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
                          <span className="text-xs font-normal text-muted-foreground">
                            Planning
                          </span>
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
                        readyLabel={snapshot?.settings?.readyLabel ?? "ready-for-agent"}
                        online={online}
                        onOpen={onOpenIssue}
                        onStart={onStartIssue === undefined ? undefined : () => beginIssue(issue)}
                        starting={startingIssue === issue.number || startingIssueId === issue.id}
                        onReview={onStartGitHubIssue}
                      />
                    ))}
                    {optimisticHere ? (
                      <li className="rounded-lg border border-primary/50 bg-card p-3" role="status">
                        <strong className="block break-words font-medium">
                          {pendingIssue
                            ? `#${String(pendingIssue.number)} ${pendingIssue.title}`
                            : pendingWork?.item.title}
                        </strong>
                        <span className="text-xs text-muted-foreground">Starting…</span>
                      </li>
                    ) : null}
                    {starts.map((start) => (
                      <li
                        key={start.id}
                        className="space-y-2 rounded-lg border border-border bg-card p-3 cursor-pointer"
                        onClick={(event) => {
                          if (!(event.target as HTMLElement).closest("button, a"))
                            onOpenStart?.(start.id);
                        }}
                      >
                        <button
                          className="block w-full text-left font-medium"
                          aria-label={`Open issue conversation #${String(start.issueNumber)}`}
                          onClick={() => onOpenStart?.(start.id)}
                        >
                          #{start.issueNumber} {start.title}
                          <span className="mt-2 block text-xs font-normal text-muted-foreground">
                            {start.state === "queued"
                              ? "Waiting for development"
                              : start.state === "preparing"
                                ? "Preparing development"
                                : start.state === "blocked"
                                  ? "Needs attention"
                                  : start.state === "done"
                                    ? "Work ended"
                                    : "Starting development"}
                          </span>
                          {start.message === null ? null : (
                            <span className="mt-2 block text-sm font-normal">{start.message}</span>
                          )}
                        </button>
                        {start.state === "blocked" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!online}
                            onClick={() => onRetryStart?.(start.id)}
                          >
                            Retry
                          </Button>
                        ) : null}
                        {start.state === "done" ? null : (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!online}
                            onClick={() => onCancelStart?.(start.id)}
                          >
                            Cancel queued work
                          </Button>
                        )}
                      </li>
                    ))}
                    {items.map(({ feature, item, queued }) => (
                      <WorkItemCard
                        key={item.id}
                        feature={feature}
                        item={item}
                        onOpenFeature={onOpenFeature}
                        onOpenIssue={onOpenIssue}
                        queued={queued}
                        onStart={onStartWorkItem === undefined ? undefined : beginWork}
                        disabled={!online || startingIssueId != null}
                      />
                    ))}
                  </ol>
                )}
              </BoardColumn>
            );
          })}
        </div>
        <DragOverlay>
          {draggedIssue || draggedWork ? (
            <div className="max-w-72 rounded-lg border border-primary bg-card p-3 shadow-lg">
              <span className="text-xs text-muted-foreground">Move to In progress</span>
              <strong className="block break-words font-medium">
                {draggedIssue
                  ? `#${String(draggedIssue.number)} ${draggedIssue.title}`
                  : draggedWork?.item.title}
              </strong>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </section>
  );
}
