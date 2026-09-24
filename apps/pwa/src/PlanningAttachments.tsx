import type { PlanningAttachmentSummary } from "@kestrel/contracts";
import { FileText, X } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { FormFeedback } from "./components/FormFeedback.js";
import type { PlanningAttachmentsDraft } from "./usePlanningAttachments.js";

export function PlanningAttachmentsPreview({
  draft,
  disabled,
}: {
  draft: PlanningAttachmentsDraft;
  disabled: boolean;
}) {
  return (
    <>
      {draft.files.length === 0 ? null : (
        <ul className="flex flex-wrap gap-2" aria-label="Attachments to send">
          {draft.files.map((file, index) => (
            <li
              key={index}
              className="relative max-w-full rounded-lg border bg-muted/30 p-2 pr-9 text-xs"
            >
              {file.kind === "image" ? (
                <img
                  className="mb-1 size-20 rounded object-cover"
                  src={`data:${file.mediaType};base64,${file.data}`}
                  alt={`Preview of ${file.name}`}
                />
              ) : (
                <FileText className="mb-1 size-6" aria-hidden="true" />
              )}
              <span className="block max-w-48 truncate" title={file.name}>
                {file.name}
              </span>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="absolute right-0 top-0"
                aria-label={`Remove attachment ${file.name}`}
                disabled={disabled || draft.busy}
                onClick={() => draft.remove(index)}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {draft.busy ? <FormFeedback kind="pending">Reading attachments…</FormFeedback> : null}
      {draft.error === null ? null : <FormFeedback kind="error">{draft.error}</FormFeedback>}
    </>
  );
}
export function PlanningMessageAttachments({
  files,
  projectId,
  featureId,
  messageId,
}: {
  files: PlanningAttachmentSummary[];
  projectId: string;
  featureId: string;
  messageId: string;
}) {
  if (files.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label="Message attachments">
      {files.map((file) => {
        const url = `/api/v1/projects/${encodeURIComponent(projectId)}/features/${encodeURIComponent(featureId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(file.id)}`;
        return (
          <li key={file.id}>
            <a
              className="block max-w-48 rounded-lg border p-2 text-xs underline"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              {file.kind === "image" ? (
                <img
                  className="mb-1 size-20 rounded object-cover"
                  src={url}
                  alt={file.name}
                  loading="lazy"
                />
              ) : (
                <FileText aria-hidden="true" className="mb-1 size-5" />
              )}
              <span className="block truncate">{file.name}</span>
              <span className="text-muted-foreground">{Math.ceil(file.byteLength / 1024)} KB</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
