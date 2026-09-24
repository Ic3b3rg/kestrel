import { PlanningAttachmentsPreview } from "./PlanningAttachments.js";
import type { PlanningAttachmentsDraft } from "./usePlanningAttachments.js";
import { useRef, type ComponentProps, type ReactNode } from "react";
import { ArrowUp, Folder, Paperclip } from "lucide-react";
import { PlanningSkillComposer } from "./PlanningSkillComposer.js";
import { Button } from "./components/ui/button.js";

export function PlanningComposer({
  input,
  attachments,
  controls,
  skills,
  project,
  sendLabel,
  canSend,
}: {
  attachments?: PlanningAttachmentsDraft;
  input: ComponentProps<typeof PlanningSkillComposer>;
  controls?: ReactNode;
  skills?: ReactNode;
  project: ReactNode;
  sendLabel: string;
  canSend: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const disabled = input.disabled || attachments?.busy === true;
  return (
    <div
      className="min-w-0"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length > 0) {
          event.preventDefault();
          if (!disabled) void attachments?.add(Array.from(event.dataTransfer.files));
        }
      }}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files).filter((file) =>
          file.type.startsWith("image/"),
        );
        if (files.length > 0) {
          event.preventDefault();
          if (!disabled) void attachments?.add(files);
        }
      }}
    >
      <div className="relative grid gap-3 rounded-xl border border-border bg-card p-3 focus-within:border-ring sm:p-4">
        {attachments === undefined ? null : (
          <PlanningAttachmentsPreview draft={attachments} disabled={input.disabled} />
        )}
        {skills}
        <PlanningSkillComposer
          {...input}
          className="max-h-80 min-h-28 resize-y border-0 bg-transparent p-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
          onKeyDown={(event) => {
            input.onKeyDown?.(event);
            if (
              !event.defaultPrevented &&
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="flex flex-wrap items-end gap-2">
          {controls}
          {attachments === undefined ? null : (
            <>
              <input
                ref={picker}
                type="file"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-label="Attach files"
                disabled={disabled}
                accept="image/png,image/jpeg,image/webp,text/*,.md,.json,.csv,.yaml,.yml,.ts,.tsx,.js,.py,.rs,.go,.sql,.toml"
                onChange={(event) => {
                  void attachments.add(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="ml-auto shrink-0"
                disabled={disabled}
                aria-label="Add attachments"
                title="Images up to 2 MB; text up to 64 KB. Up to 4 files."
                onClick={() => picker.current?.click()}
              >
                <Paperclip aria-hidden="true" />
              </Button>
            </>
          )}
          <Button
            className="shrink-0 rounded-full"
            size="icon"
            type="submit"
            aria-label={sendLabel}
            title={`${sendLabel} (⌘/Ctrl + Enter)`}
            disabled={!canSend || attachments?.busy === true}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="mx-3 flex min-w-0 items-center gap-2 rounded-b-xl border border-t-0 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        <Folder className="size-4 shrink-0" aria-hidden="true" />
        {project}
      </div>
    </div>
  );
}
