import type { PlanningAttachment } from "@kestrel/contracts";
import { usePlanningAttachments } from "./usePlanningAttachments.js";
import { FormFeedback } from "./components/FormFeedback.js";
import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Label } from "./components/ui/label.js";
import { PlanningComposer } from "./PlanningComposer.js";

export interface NewPlanningChatPanelProps {
  projectName: string;
  controls?: ReactNode;
  projectControl?: ReactNode;
  online: boolean;
  readyToSubmit?: boolean;
  pending: boolean;
  error: string | null;
  locked?: boolean;
  pendingMessage?: string;
  onDraftChange?: (text: string, hasAttachments?: boolean) => void;
  onAuthenticationError: (error: unknown) => boolean;
  onSubmit: (text: string, attachments: PlanningAttachment[]) => void;
  onBack: () => void;
}

export function NewPlanningChatPanel({
  projectName,
  controls,
  projectControl,
  online,
  readyToSubmit = true,
  pending,
  error,
  locked = false,
  pendingMessage = "Saving your first message…",
  onDraftChange,
  onAuthenticationError,
  onSubmit,
  onBack,
}: NewPlanningChatPanelProps) {
  const [draft, setDraft] = useState("");
  const attachments = usePlanningAttachments((files) => onDraftChange?.(draft, files.length > 0));
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
    if (!online || !readyToSubmit || pending || attachments.busy || text === "") return;
    onSubmit(text, attachments.files);
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
          <Label htmlFor={composerId} className="sr-only">
            Describe the change
          </Label>
          <PlanningComposer
            attachments={attachments}
            project={projectControl ?? projectName}
            controls={controls}
            sendLabel={pending ? "Starting…" : error === null ? "Start plan" : "Retry"}
            canSend={online && readyToSubmit && !pending && draft.trim() !== ""}
            input={{
              textareaRef: composer,
              id: composerId,
              online,
              onAuthenticationError,
              autoFocus: true,
              name: "prompt",
              rows: 5,
              maxLength: 16_000,
              value: draft,
              disabled: pending || locked,
              describedBy: helpId,
              placeholder: "A feature, a problem, or an idea…",
              onValueChange: (text) => {
                setDraft(text);
                onDraftChange?.(text, attachments.files.length > 0);
              },
            }}
          />
          {pending ? (
            <FormFeedback id={helpId} kind="pending">
              {pendingMessage}
            </FormFeedback>
          ) : (
            <p id={helpId} className="text-sm text-muted-foreground">
              {!online
                ? "Reconnect to start this plan. Your draft stays here."
                : "You will review and approve the plan before implementation starts."}
            </p>
          )}
          {error === null ? null : (
            <FormFeedback kind="error" focus className="grid justify-items-start gap-1 text-sm">
              <p>{error}</p>
              {error.includes("is not installed") ? (
                <a href="/settings/skills" className="underline">
                  Open Settings → Skills
                </a>
              ) : null}
            </FormFeedback>
          )}
        </form>
      </div>
    </section>
  );
}
