import { useId } from "react";
import { ArrowUpRight, GitPullRequest, Plus, RefreshCw, Settings } from "lucide-react";
import type { FactoryBoard, FactoryWorkItem, Feature } from "@kestrel/contracts";
import { Button } from "./components/ui/button.js";

const columns = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "in_review", label: "In review" },
  { id: "completed", label: "Completed" },
] as const;

export interface ProjectFactoryBoardPanelProps {
  projectName: string;
  features: Feature[];
  boards: FactoryBoard[];
  online: boolean;
  loading: boolean;
  error: string | null;
  onStartPlan: () => void;
  onOpenFeature: (featureId: string, view: "chat" | "plan" | "board") => void;
  onRefresh: () => void;
  onOpenPullRequests: () => void;
  onOpenSettings: () => void;
}

function WorkItemCard({
  feature,
  item,
  onOpenFeature,
}: {
  feature: Feature;
  item: FactoryWorkItem;
  onOpenFeature: ProjectFactoryBoardPanelProps["onOpenFeature"];
}) {
  const contextId = useId();
  const hasContext = item.dependsOn.length > 0 || item.blocking !== null;
  return (
    <li className="min-w-0 rounded-lg border border-border bg-card">
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full min-w-0 flex-col items-start gap-2 p-3 text-left"
        aria-label={"Open Work Item: " + item.title + " · " + feature.title}
        aria-describedby={hasContext ? contextId : undefined}
        onClick={() => onOpenFeature(feature.id, "board")}
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
  projectName,
  features,
  boards,
  online,
  loading,
  error,
  onStartPlan,
  onOpenFeature,
  onRefresh,
  onOpenPullRequests,
  onOpenSettings,
}: ProjectFactoryBoardPanelProps) {
  const titleId = useId();
  const approvedBoards = boards.filter((board) => board.approvedVersion !== null);
  const planningFeatures = features.filter(
    (feature) =>
      feature.state === "planning" &&
      !approvedBoards.some((board) => board.feature.id === feature.id),
  );
  return (
    <section className="min-w-0 space-y-6" aria-labelledby={titleId} aria-busy={loading}>
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
          <Button type="button" variant="ghost" onClick={onOpenSettings}>
            <Settings aria-hidden="true" /> Settings
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
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {!online ? (
        <p role="status" className="text-sm text-muted-foreground">
          Reconnect to refresh this board.
        </p>
      ) : loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Updating board…
        </p>
      ) : null}
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {columns.map((column) => {
          const items = approvedBoards.flatMap((board) =>
            board.columns
              .filter((entry) => entry.id === column.id)
              .flatMap((entry) => entry.items.map((item) => ({ item, feature: board.feature }))),
          );
          const drafts = column.id === "todo" ? planningFeatures : [];
          const count = items.length + drafts.length;
          return (
            <section
              key={column.id}
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
                    aria-label="New plan"
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
                      ? "Start a plan to add work."
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
                  {items.map(({ feature, item }) => (
                    <WorkItemCard
                      key={item.id}
                      feature={feature}
                      item={item}
                      onOpenFeature={onOpenFeature}
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
