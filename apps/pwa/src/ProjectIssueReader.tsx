import { CircleDot, CircleCheck, ExternalLink, MessageSquare } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent.js";
import { useEffect, useState } from "react";
import type { ProjectIssueDiscussion } from "@kestrel/contracts";
import { fetchProjectIssue } from "./project-issue-api.js";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "./components/ui/sheet.js";
import { Skeleton } from "./components/ui/skeleton.js";
import { Button } from "./components/ui/button.js";
import { planningRequestError } from "./FeatureNavigation.js";

export function ProjectIssueReader({
  projectId,
  number,
  onClose,
  onAuthenticationError,
}: {
  projectId: string;
  number: number;
  onClose: () => void;
  onAuthenticationError: (error: unknown) => boolean;
}) {
  const [pages, setPages] = useState<ProjectIssueDiscussion[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError(null);
    void fetchProjectIssue(projectId, number, page, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setPages((current) => {
            const updated = [...current];
            updated[page - 1] = result;
            return updated;
          });
          if (result.refreshing)
            refreshTimer = setTimeout(() => setRetry((value) => value + 1), 1000);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError(failure))
          setError(
            planningRequestError(
              failure,
              "This issue could not be read. Retry when GitHub is available.",
            ),
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      clearTimeout(refreshTimer);
    };
  }, [projectId, number, page, retry, onAuthenticationError]);
  const issue = pages[0]?.issue;
  const next = pages.at(-1)?.nextPage;
  const comments = pages.flatMap((value) => value.comments);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full! gap-0 overflow-y-auto sm:max-w-4xl!">
        <SheetHeader className="border-b border-border p-6 pr-12">
          <SheetDescription>
            {issue ? `${issue.repository.owner}/${issue.repository.name}` : "GitHub issue"}
          </SheetDescription>
          <SheetTitle className="text-2xl leading-snug">
            {issue?.title ?? "Issue"}{" "}
            <span className="font-normal text-muted-foreground">#{number}</span>
          </SheetTitle>
          {issue ? (
            <div className="flex flex-wrap items-center gap-3 pt-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 font-medium">
                {issue.state === "open" ? (
                  <CircleDot className="size-4" aria-hidden="true" />
                ) : (
                  <CircleCheck className="size-4" aria-hidden="true" />
                )}
                {issue.state === "open" ? "Open" : "Closed"}
              </span>
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <MessageSquare className="size-3.5" aria-hidden="true" />
                {issue.commentCount ?? comments.length} comments
              </span>
              <a
                className="inline-flex items-center gap-1 underline underline-offset-2"
                href={issue.url}
                target="_blank"
                rel="noreferrer"
              >
                Open on GitHub <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            </div>
          ) : null}
        </SheetHeader>
        <div className="space-y-6 p-6">
          {error === null ? null : (
            <div role="alert" className="space-y-2">
              <p>{error}</p>
              <Button onClick={() => setRetry((value) => value + 1)}>Retry reading issue</Button>
            </div>
          )}
          {issue === undefined ? null : (
            <>
              <div className="flex flex-wrap items-center gap-2" aria-label="Issue labels">
                <span className="mr-1 text-xs font-medium text-muted-foreground">Labels</span>
                {issue.labels?.length ? (
                  issue.labels.map((label) => (
                    <span
                      className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium"
                      key={label.name}
                    >
                      {label.name}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">None</span>
                )}
              </div>
              <article className="min-w-0 overflow-hidden rounded-lg border border-border">
                <h2 className="border-b border-border bg-muted/50 px-4 py-3 text-sm font-medium">
                  Description
                </h2>
                <div className="p-4 sm:p-6">
                  <MarkdownContent
                    body={issue.body || "No description provided."}
                    baseUrl={`${issue.url}/`}
                  />
                </div>
              </article>
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <MessageSquare className="size-4 text-muted-foreground" aria-hidden="true" />
                Comments ({issue.commentCount ?? comments.length})
              </h2>
              {comments.map((comment) => (
                <article
                  key={comment.id}
                  className="min-w-0 overflow-hidden rounded-lg border border-border"
                >
                  <header className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-3 text-sm">
                    <span
                      aria-hidden="true"
                      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold"
                    >
                      {(comment.author ?? "?").slice(0, 1).toUpperCase()}
                    </span>
                    <a
                      href={comment.url}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all font-semibold hover:underline"
                    >
                      {comment.author ?? "GitHub user"}
                    </a>
                    <span className="text-xs text-muted-foreground">commented</span>
                  </header>
                  <div className="p-4 sm:p-6">
                    <MarkdownContent body={comment.body} baseUrl={`${issue.url}/`} />
                  </div>
                </article>
              ))}
              {!loading && comments.length === 0 ? (
                <p className="text-muted-foreground">No comments yet.</p>
              ) : null}
              {pages.some((value) => value.failure !== null) ? (
                <p role="status">
                  Showing the last saved discussion. GitHub could not be refreshed.
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Read {new Date(pages[0]?.fetchedAt ?? Date.now()).toLocaleString()}
              </p>
            </>
          )}
          {loading && pages.length === 0 ? (
            <div role="status" className="space-y-4">
              <span className="sr-only">Reading issue…</span>
              <div aria-hidden="true" className="space-y-4 rounded-lg border border-border p-4">
                <Skeleton className="h-4 w-24 motion-reduce:animate-none" />
                <Skeleton className="h-4 w-full motion-reduce:animate-none" />
                <Skeleton className="h-4 w-5/6 motion-reduce:animate-none" />
                <Skeleton className="h-32 w-full motion-reduce:animate-none" />
              </div>
            </div>
          ) : next != null ? (
            <Button onClick={() => setPage(next)}>Load more comments</Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
