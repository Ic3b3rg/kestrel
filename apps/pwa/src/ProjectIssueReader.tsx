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
      <SheetContent className="w-full! overflow-y-auto sm:max-w-2xl!">
        <SheetHeader>
          <SheetTitle>{issue?.title ?? `Issue #${String(number)}`}</SheetTitle>
          <SheetDescription>
            Issue #{number} · {issue?.repository.owner}/{issue?.repository.name}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-4 pb-6">
          {error === null ? null : (
            <div role="alert" className="space-y-2">
              <p>{error}</p>
              <Button onClick={() => setRetry((value) => value + 1)}>Retry reading issue</Button>
            </div>
          )}
          {issue === undefined ? null : (
            <>
              <div className="flex flex-wrap gap-2">
                {issue.labels?.map((label) => (
                  <span className="rounded border px-2 py-1 text-xs" key={label.name}>
                    {label.name}
                  </span>
                ))}
              </div>
              <div className="whitespace-pre-wrap break-words leading-relaxed">
                {issue.body || "No description provided."}
              </div>
              <a className="text-sm underline" href={issue.url} target="_blank" rel="noreferrer">
                Open on GitHub
              </a>
              <h2 className="text-base font-semibold">
                Comments ({issue.commentCount ?? comments.length})
              </h2>
              {comments.map((comment) => (
                <article key={comment.id} className="space-y-2 border-t pt-4">
                  <a
                    href={comment.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium underline"
                  >
                    {comment.author ?? "GitHub user"}
                  </a>
                  <div className="whitespace-pre-wrap break-words leading-relaxed">
                    {comment.body}
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
            <p role="status">Reading issue…</p>
          ) : next != null ? (
            <Button onClick={() => setPage(next)}>Load more comments</Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
