import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";

import {
  RetainObservedReviewRevisionCommandSchema,
  type ProjectInbox,
  type RetainObservedReviewRevisionCommand,
  type ReviewRevisionAvailable,
} from "@kestrel/contracts";

import { ApiClientError, retainReviewRevision } from "./api.js";

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
  const [changeIntent, setChangeIntent] = useState(proposal.changeIntent?.text ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const active = useRef<AbortController | null>(null);
  const fieldId = useId();
  const helpId = `${fieldId}-help`;
  const errorId = `${fieldId}-error`;
  const normalizedIntent = changeIntent.trim();
  const intentBytes = new TextEncoder().encode(normalizedIntent).byteLength;
  const intentTooLarge = intentBytes > 20_000;
  const latestRevision = proposal.reviewRevisions[0];

  useEffect(() => () => active.current?.abort(), []);

  if (latestRevision?.state === "available") return null;
  if (latestRevision?.state === "acquiring") {
    return (
      <p className="observed-acquisition-state" role="status">
        This exact pull request is already acquiring.
      </p>
    );
  }

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
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
          ? "Change Intent must be 20,000 UTF-8 bytes or fewer."
          : "Confirm a Change Intent before acquiring this pull request.",
      );
      return;
    }
    const controller = new AbortController();
    active.current?.abort();
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
      <div className="form-field">
        <label htmlFor={fieldId}>Confirm Change Intent for PR #{proposal.number}</label>
        <textarea
          id={fieldId}
          rows={3}
          value={changeIntent}
          disabled={disabled || pending}
          aria-describedby={`${helpId}${error !== null ? ` ${errorId}` : ""}`}
          aria-invalid={intentTooLarge || error !== null ? "true" : undefined}
          onChange={(event) => {
            setChangeIntent(event.currentTarget.value);
            setError(null);
          }}
        />
      </div>
      <button
        type="submit"
        disabled={disabled || pending || normalizedIntent.length === 0 || intentTooLarge}
      >
        {pending
          ? "Acquiring…"
          : latestRevision?.state === "unavailable"
            ? `Retry exact PR #${String(proposal.number)}`
            : `Acquire exact PR #${String(proposal.number)}`}
      </button>
      <p id={helpId} className="form-help">
        Kestrel reads the attached repository first. Git may use a host credential helper only to
        fetch missing GitHub objects into temporary Kestrel-owned storage; Kestrel never receives or
        stores the credential. {intentBytes.toLocaleString("en-US")} / 20,000 UTF-8 bytes.
      </p>
      {error === null ? null : (
        <p id={errorId} className="project-form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
