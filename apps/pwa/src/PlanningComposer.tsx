import type { ComponentProps, ReactNode } from "react";
import { ArrowUp, Folder } from "lucide-react";
import { PlanningSkillComposer } from "./PlanningSkillComposer.js";
import { Button } from "./components/ui/button.js";

export function PlanningComposer({
  input,
  controls,
  skills,
  project,
  sendLabel,
  canSend,
}: {
  input: ComponentProps<typeof PlanningSkillComposer>;
  controls?: ReactNode;
  skills?: ReactNode;
  project: ReactNode;
  sendLabel: string;
  canSend: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="relative grid gap-3 rounded-xl border border-border bg-card p-3 focus-within:border-ring sm:p-4">
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
          <Button
            className="ml-auto shrink-0 rounded-full"
            size="icon"
            type="submit"
            aria-label={sendLabel}
            title={`${sendLabel} (⌘/Ctrl + Enter)`}
            disabled={!canSend}
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
