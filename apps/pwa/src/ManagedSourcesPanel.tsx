import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { ManagedSourceSchema, ManagedSourcesSchema } from "@kestrel/contracts";
import { ApiClientError, authenticatedMutationHeaders, requireJson } from "./api.js";
import { FormFeedback } from "./components/FormFeedback.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Label } from "./components/ui/label.js";

export function ManagedSourcesPanel({
  disabled,
  onAuthorized,
}: {
  disabled: boolean;
  onAuthorized: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [sources, setSources] = useState<{ repositoryId: string; displayName: string }[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const inputId = useId();
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (!open || disabled) return;
    const controller = new AbortController();
    void fetch("/api/v1/managed-sources", { credentials: "same-origin", signal: controller.signal })
      .then((response) => requireJson(response, ManagedSourcesSchema, "Managed repositories"))
      .then((result) => {
        if (!controller.signal.aborted) setSources(result);
      })
      .catch(() => {
        /* The clone command reports actionable configuration failures locally. */
      });
    return () => controller.abort();
  }, [open, disabled]);
  const submit = async (action: "clone" | "refresh", repositoryId?: string) => {
    if (disabled || active.current !== null) return;
    if (action === "clone" && url.trim() === "") {
      setError("Enter an HTTPS or SSH Git URL.");
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await requireJson(
        await fetch(`/api/v1/managed-sources/${action}`, {
          method: "POST",
          credentials: "same-origin",
          headers: authenticatedMutationHeaders(),
          body: JSON.stringify(action === "clone" ? { url: url.trim() } : { repositoryId }),
          signal: controller.signal,
        }),
        ManagedSourceSchema,
        "Managed repository",
      );
      if (controller.signal.aborted) return;
      setSources((current) => [
        ...current.filter((source) => source.repositoryId !== result.repositoryId),
        result,
      ]);
      setSuccess(
        action === "clone"
          ? `${result.displayName} is ready. Select it to open its Project.`
          : `${result.displayName} has updated remote references. Select committed references when preparing a review.`,
      );
      await onAuthorized();
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof ApiClientError
            ? failure.details.message
            : "The remote outcome could not be confirmed. Retry the same URL to reconcile it.",
        );
    } finally {
      if (active.current === controller) {
        active.current = null;
        setPending(false);
      }
    }
  };
  const clone = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit("clone");
  };
  return (
    <section className="grid min-w-0 gap-3" aria-label="Managed repositories" aria-busy={pending}>
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || pending}
          onClick={() => setOpen((value) => !value)}
        >
          Clone from Git URL
        </Button>
      </div>
      {open ? (
        <>
          <form className="grid gap-3" onSubmit={clone}>
            <Label htmlFor={inputId}>Git URL</Label>
            <Input
              id={inputId}
              value={url}
              disabled={disabled || pending}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
                setSuccess(null);
              }}
              placeholder="https://github.com/owner/repository"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-sm text-muted-foreground">
              HTTPS or SSH. Git uses this workstation’s existing credentials. The managed copy stays
              separate from your checkout.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={disabled || pending}>
                Clone repository
              </Button>
              {pending ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    active.current?.abort();
                    setError(
                      "Cancellation requested. Refresh repositories or retry the same URL to confirm the outcome.",
                    );
                  }}
                >
                  Cancel remote operation
                </Button>
              ) : null}
            </div>
          </form>
          {sources.length === 0 ? null : (
            <ul className="grid gap-2">
              {sources.map((source) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-2"
                  key={source.repositoryId}
                >
                  <span>{source.displayName}</span>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled || pending}
                    onClick={() => void submit("refresh", source.repositoryId)}
                    aria-label={`Update remote references for ${source.displayName}`}
                  >
                    Update remote references
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      {pending ? (
        <FormFeedback kind="pending">Git is reading the remote repository…</FormFeedback>
      ) : null}
      {error === null ? null : (
        <FormFeedback kind="error" focus>
          {error}
        </FormFeedback>
      )}
      {success === null ? null : <FormFeedback kind="success">{success}</FormFeedback>}
    </section>
  );
}
