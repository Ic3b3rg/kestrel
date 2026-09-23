import { ManagedSourcesPanel } from "./ManagedSourcesPanel.js";
import { useEffect, useRef, useState } from "react";
import { SourceAuthorizationSchema, type SourceAuthorization } from "@kestrel/contracts";
import { ApiClientError, authenticatedMutationHeaders, requireJson } from "./api.js";
import { FormFeedback } from "./components/FormFeedback.js";
import { Button } from "./components/ui/button.js";

export async function authorizeLocalFolder(
  operation: "choose" | "confirm",
  previewId?: string,
  signal?: AbortSignal,
): Promise<SourceAuthorization> {
  return requireJson(
    await fetch(`/api/v1/local-repository-sources/${operation}`, {
      method: "POST",
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      body: JSON.stringify(operation === "choose" ? {} : { previewId }),
      signal: signal ?? null,
    }),
    SourceAuthorizationSchema,
    "Local folder authorization",
  );
}

export function SourceOnboardingPanel({
  disabled,
  onAuthorized,
  authorize = authorizeLocalFolder,
}: {
  disabled: boolean;
  onAuthorized: () => void | Promise<void>;
  authorize?: typeof authorizeLocalFolder;
}) {
  const [result, setResult] = useState<SourceAuthorization | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const run = async (operation: "choose" | "confirm") => {
    if (disabled || active.current !== null) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(null);
    if (operation === "choose") setResult(null);
    try {
      const outcome = await authorize(
        operation,
        result?.state === "preview" ? result.previewId : undefined,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setResult(outcome);
      if (outcome.state === "authorized") await onAuthorized();
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof ApiClientError
            ? failure.details.message
            : "The request could not be confirmed. Retry to reconcile the result.",
        );
    } finally {
      if (active.current === controller) {
        active.current = null;
        setPending(false);
      }
    }
  };
  return (
    <section className="grid min-w-0 gap-3" aria-label="Add a repository" aria-busy={pending}>
      <ManagedSourcesPanel disabled={disabled || pending} onAuthorized={onAuthorized} />
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || pending}
          onClick={() => void run("choose")}
        >
          Local folder
        </Button>
      </div>
      {pending ? (
        <FormFeedback kind="pending">
          {result?.state === "preview"
            ? "Authorizing repositories…"
            : "Choose a folder on this workstation…"}
        </FormFeedback>
      ) : null}
      {result?.state === "preview" ? (
        <div className="grid gap-3">
          <p>Authorize these repositories?</p>
          <ul>
            {result.repositories.map((repository) => (
              <li key={repository.repositoryId}>{repository.displayName}</li>
            ))}
          </ul>
          {result.skipped > 0 ? (
            <p>{result.skipped} unreadable or unsupported repositories were skipped.</p>
          ) : null}
          <p>Only the listed repositories become available. Opening them does not start work.</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={disabled || pending}
              onClick={() => void run("confirm")}
            >
              Authorize repositories
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setResult(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {result?.state === "cancelled" ? (
        <FormFeedback kind="success">
          Folder selection cancelled. No repositories were authorized.
        </FormFeedback>
      ) : null}
      {result?.state === "authorized" ? (
        <FormFeedback kind="success">
          Repositories authorized. Select a repository to open its Project.
        </FormFeedback>
      ) : null}
      {error === null ? null : (
        <FormFeedback kind="error" focus>
          {error}
        </FormFeedback>
      )}
    </section>
  );
}
