import { FormFeedback } from "./components/FormFeedback.js";
import { Button } from "./components/ui/button.js";
import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";

import {
  RetainObservedReviewRevisionCommandSchema,
  type ProjectInbox,
  type RetainObservedReviewRevisionCommand,
  type ReviewRevisionAvailable,
} from "@kestrel/contracts";

import { ApiClientError, retainReviewRevision } from "./api.js";
import { currentReviewRevision } from "./current-review-revision.js";

type ProviderProposal = Extract<
  ProjectInbox["projects"][number]["changeProposals"][number],
  { kind: "provider_observed" }
>;

export interface AcquireObservedReviewRevisionFormProps {
  disabled: boolean;
  onAuthenticationError?: (error: unknown) => boolean;
  onAvailable: (result: ReviewRevisionAvailable) => void;
  projectId: string;
  proposal: ProviderProposal;
  retain?: (
    command: RetainObservedReviewRevisionCommand,
    signal?: AbortSignal,
  ) => Promise<ReviewRevisionAvailable>;
}

function safeError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.details.message} Reference: ${error.details.correlationId}`;
  }
  return "Kestrel could not acquire the exact observed pull request.";
}

export function AcquireObservedReviewRevisionForm({
  disabled,
  onAuthenticationError,
  onAvailable,
  projectId,
  proposal,
  retain = retainReviewRevision,
}: AcquireObservedReviewRevisionFormProps) {
  const recordedPurpose = proposal.changeIntent?.text;
  const changeIntent = recordedPurpose ?? proposal.title;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const active = useRef<AbortController | null>(null);
  const fieldId = useId();
  const helpId = `${fieldId}-help`;
  const errorId = `${fieldId}-error`;
  const normalizedIntent = changeIntent.trim();
  const intentBytes = new TextEncoder().encode(normalizedIntent).byteLength;
  const intentTooLarge = intentBytes > 20_000;
  const currentRevision = currentReviewRevision(proposal);

  useEffect(() => () => active.current?.abort(), []);

  if (currentRevision?.state === "available") return null;
  if (currentRevision?.state === "acquiring") {
    return (
      <p className="observed-acquisition-state" role="status">
        This exact pull request is already acquiring.
      </p>
    );
  }

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || active.current !== null) return;
    let command: RetainObservedReviewRevisionCommand;
    try {
      command = RetainObservedReviewRevisionCommandSchema.parse({
        changeIntent,
        changeProposalId: proposal.id,
        projectId,
      });
    } catch {
      setError(
        intentTooLarge
          ? "The review purpose must be 20,000 UTF-8 bytes or fewer."
          : "Add the purpose Kestrel should use for this review.",
      );
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(null);
    try {
      const result = await retain(command, controller.signal);
      if (active.current === controller && !controller.signal.aborted) onAvailable(result);
    } catch (requestError) {
      if (
        !controller.signal.aborted &&
        active.current === controller &&
        !(onAuthenticationError?.(requestError) ?? false)
      ) {
        setError(safeError(requestError));
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setPending(false);
      }
    }
  };

  return (
    <form className="observed-acquisition-form" onSubmit={(event) => void submit(event)} noValidate>
      <p className="text-sm text-muted-foreground">
        {recordedPurpose === undefined
          ? "Kestrel will retain this revision and record the GitHub-stated purpose shown above as your confirmation."
          : "Kestrel will use the purpose shown above."}{" "}
        Correct it there before retaining source if it does not describe the change.
      </p>
      <Button
        type="submit"
        disabled={disabled || pending || normalizedIntent.length === 0 || intentTooLarge}
        aria-describedby={`${helpId}${error !== null ? ` ${errorId}` : ""}`}
      >
        {pending
          ? "Retaining…"
          : currentRevision?.state === "unavailable"
            ? `Retry exact PR #${String(proposal.number)}`
            : recordedPurpose === undefined
              ? "Retain source and confirm purpose"
              : `Retain exact PR #${String(proposal.number)}`}
      </Button>
      <p id={helpId} className="form-help">
        {recordedPurpose === undefined
          ? "Retaining source also records this purpose as your confirmation. "
          : ""}
        Kestrel reads the attached repository first. Git may use a host credential helper only to
        fetch missing GitHub objects into temporary Kestrel-owned storage; Kestrel never receives or
        stores the credential. {intentBytes.toLocaleString("en-US")} / 20,000 UTF-8 bytes.
      </p>
      {pending ? (
        <FormFeedback kind="pending">Retaining source for this review…</FormFeedback>
      ) : null}
      {error === null ? null : (
        <FormFeedback id={errorId} className="project-form-error" kind="error" focus>
          {error}
        </FormFeedback>
      )}
    </form>
  );
}
