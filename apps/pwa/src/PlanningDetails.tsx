import { useState } from "react";
import { FileText } from "lucide-react";
import type { FeatureChat, PlanningFailure, PlanningTurn } from "@kestrel/contracts";
import { SkillProvenance } from "./PlanningSkillsPanel.js";
import { Button } from "./components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog.js";

export const failures: Record<PlanningFailure, { title: string; detail: string }> = {
  unavailable: {
    title: "Codex is unavailable",
    detail: "Your message is saved. Check the workstation connection, then retry planning.",
  },
  authentication: {
    title: "Sign in to Codex",
    detail: "Your message is saved. Restore the Codex connection in Settings, then retry planning.",
  },
  usage_limit: {
    title: "Codex usage limit reached",
    detail: "Your message is saved. Retry when usage is available again.",
  },
  permission_required: {
    title: "A permission decision is required",
    detail: "Planning stopped at a permission request. Review the question before continuing.",
  },
  input_required: {
    title: "Kestrel needs your answer",
    detail: "Answer the question in the chat to continue planning.",
  },
  timeout: {
    title: "Planning timed out",
    detail: "Your message is saved. Retry this turn when you are ready.",
  },
  cancelled: {
    title: "Planning stopped",
    detail: "Your saved message remains in this conversation.",
  },
  interrupted: {
    title: "Planning was interrupted",
    detail: "Your message is saved. Retry explicitly to continue.",
  },
  invalid_response: {
    title: "The reply could not be read",
    detail: "Kestrel could not save a valid answer. Retry this turn.",
  },
  source_unavailable: {
    title: "Project documents are unavailable",
    detail: "Check the Project source in Settings before retrying.",
  },
};

export function pendingTurn(turn: PlanningTurn | undefined): boolean {
  return turn?.state === "queued" || turn?.state === "running";
}

export function DocumentInspector({
  context,
  label = "Project documents",
  emptyMessage = "Documents will be read when you send the first message.",
}: {
  context: FeatureChat["context"];
  label?: string;
  emptyMessage?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">
          <FileText aria-hidden="true" />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="planning-documents-dialog max-h-[85dvh] overflow-y-auto sm:max-w-4xl">
        <DialogTitle>{label}</DialogTitle>
        <DialogDescription>
          Committed Markdown read for this conversation. These documents remain unchanged by
          planning.
        </DialogDescription>
        <ProjectDocumentContents context={context} emptyMessage={emptyMessage} />
      </DialogContent>
    </Dialog>
  );
}

export function ProjectDocumentContents({
  context,
  emptyMessage,
}: {
  context: FeatureChat["context"];
  emptyMessage: string;
}) {
  const [selectedPath, setSelectedPath] = useState("");
  const selected =
    context?.documents.find(({ path }) => path === selectedPath) ?? context?.documents[0];
  return (
    <>
      {context?.notice === null || context?.notice === undefined ? null : (
        <p className="planning-notice">{context.notice}</p>
      )}
      {context?.commitId === null || context?.commitId === undefined ? null : (
        <p className="planning-source-commit">
          Source commit <code>{context.commitId}</code>
        </p>
      )}
      <SkillProvenance skills={context?.skills ?? []} />
      {context === null ? (
        <p>{emptyMessage}</p>
      ) : context.documents.length === 0 ? (
        <p>No committed Markdown documents were available for this turn.</p>
      ) : (
        <div className="planning-documents-layout">
          <div className="planning-document-list" role="group" aria-label="Choose a document">
            {context.documents.map((document) => (
              <Button
                key={document.path}
                variant={document.path === selected?.path ? "secondary" : "ghost"}
                className="justify-start whitespace-normal text-left"
                aria-pressed={document.path === selected?.path}
                onClick={() => setSelectedPath(document.path)}
              >
                {document.path}
              </Button>
            ))}
          </div>
          {selected === undefined ? null : (
            <section className="planning-document" aria-label={selected.path}>
              <h3>{selected.path}</h3>
              <pre tabIndex={0} aria-label={`Contents of ${selected.path}`}>
                {selected.content}
              </pre>
            </section>
          )}
        </div>
      )}
    </>
  );
}
