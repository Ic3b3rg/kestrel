import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { ArrowLeft, ArrowUp } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Label } from "./components/ui/label.js";
import { Textarea } from "./components/ui/textarea.js";

export interface NewPlanningChatPanelProps {
  projectName: string;
  online: boolean;
  pending: boolean;
  error: string | null;
  locked?: boolean;
  pendingMessage?: string;
  tools?: ReactNode;
  onDraftChange?: (text: string) => void;
  onSubmit: (text: string) => void;
  onBack: () => void;
}

export function NewPlanningChatPanel({
  projectName,
  online,
  pending,
  error,
  locked = false,
  pendingMessage = "Saving your first message…",
  tools,
  onDraftChange,
  onSubmit,
  onBack,
}: NewPlanningChatPanelProps) {
  const [draft, setDraft] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null);
  const composerId = useId();
  const titleId = useId();
  const helpId = useId();
  useEffect(() => {
    if (!pending && !locked && document.activeElement === document.body)
      composer.current?.focus({ preventScroll: true });
  }, [pending, locked]);
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!online || pending || text === "") return;
    onSubmit(text);
  };
  return (
    <section className="flex min-h-96 min-w-0 flex-1 flex-col" aria-labelledby={titleId}>
      <div>
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden="true" /> Back to board
        </Button>
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-6 py-12 sm:py-20">
        <header className="space-y-2">
          <p className="break-words text-sm text-muted-foreground">{projectName} · New plan</p>
          <h1 id={titleId} className="text-2xl font-medium tracking-tight sm:text-3xl">
            What would you like to build?
          </h1>
          <p className="text-sm text-muted-foreground">
            Describe the change. Shape the plan together.
          </p>
        </header>
        <form onSubmit={submit} className="space-y-3" aria-busy={pending}>
          <div className="rounded-xl border border-border bg-card p-3 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50 sm:p-4">
            <Label htmlFor={composerId} className="sr-only">
              Describe the change
            </Label>
            <Textarea
              ref={composer}
              id={composerId}
              autoFocus
              name="prompt"
              rows={5}
              maxLength={16_000}
              value={draft}
              disabled={pending || locked}
              aria-describedby={helpId}
              placeholder="A feature, a problem, or an idea…"
              className="max-h-80 min-h-32 resize-y border-0 bg-transparent p-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                onDraftChange?.(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.ctrlKey || event.metaKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                {tools}
                <p className="text-xs text-muted-foreground">Ctrl or ⌘ + Enter to send</p>
              </div>
              <Button type="submit" disabled={!online || pending || draft.trim() === ""}>
                {pending ? "Starting…" : error === null ? "Start plan" : "Retry"}
                <ArrowUp aria-hidden="true" />
              </Button>
            </div>
          </div>
          <p id={helpId} role="status" className="text-sm text-muted-foreground">
            {!online
              ? "Reconnect to start this plan. Your draft stays here."
              : pending
                ? pendingMessage
                : "You will review and approve the plan before implementation starts."}
          </p>
          {error === null ? null : (
            <p role="alert" className="text-sm">
              {error}
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
