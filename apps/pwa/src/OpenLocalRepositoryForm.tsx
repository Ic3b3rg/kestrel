import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./components/ui/dialog.js";
import { Button } from "./components/ui/button.js";
import { Textarea } from "./components/ui/textarea.js";
import { NativeSelect } from "./components/ui/native-select.js";
import { Label } from "./components/ui/label.js";
import { useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from "react";

import {
  RetainReviewRevisionCommandSchema,
  type LocalRepositoryInventory,
  type LocalRepositoryReferences,
  type ProjectInbox,
  type RetainReviewRevisionCommand,
  type ReviewRevisionAvailable,
} from "@kestrel/contracts";

import {
  ApiClientError,
  fetchLocalRepositories,
  fetchLocalRepositoryReferences,
  retainReviewRevision,
} from "./api.js";
import { RepositorySetupState } from "./RepositorySetupState.js";

interface RetainCommandFields {
  baseRef: string;
  changeIntent: string;
  changeProposalId?: string;
  headRef: string;
  repositoryId: string;
}

export function buildRetainCommand(
  inventory: LocalRepositoryReferences,
  fields: RetainCommandFields,
): RetainReviewRevisionCommand {
  if (inventory.repositoryId !== fields.repositoryId) {
    throw new Error("The repository reference inventory is stale");
  }
  const enumerated = new Set(inventory.references.map(({ ref }) => ref));
  if (!enumerated.has(fields.baseRef) || !enumerated.has(fields.headRef)) {
    throw new Error("Select two enumerated committed references");
  }
  if (fields.baseRef === fields.headRef) {
    throw new Error("Base and head references must be different");
  }
  return RetainReviewRevisionCommandSchema.parse({
    repositoryId: fields.repositoryId,
    baseRef: fields.baseRef,
    headRef: fields.headRef,
    changeIntent: fields.changeIntent,
    ...(fields.changeProposalId === undefined || fields.changeProposalId === ""
      ? {}
      : { changeProposalId: fields.changeProposalId }),
  });
}

export interface OpenLocalRepositoryFormProps {
  disabled: boolean;
  projects: ProjectInbox["projects"];
  boundRepository?: { repositoryId: string; displayName: string };
  loadRepositories?: (signal?: AbortSignal) => Promise<LocalRepositoryInventory>;
  loadReferences?: (
    repositoryId: string,
    signal?: AbortSignal,
  ) => Promise<LocalRepositoryReferences>;
  retain?: (
    command: RetainReviewRevisionCommand,
    signal?: AbortSignal,
  ) => Promise<ReviewRevisionAvailable>;
  onAuthenticationError?: (error: unknown) => boolean;
  onAvailable: (result: ReviewRevisionAvailable) => void;
}

export function findMatchingProposalOptions(
  projects: ProjectInbox["projects"],
  repositoryId: string,
  baseObjectId: string,
  headObjectId: string,
): { id: string; label: string }[] {
  return projects
    .flatMap((project) =>
      project.changeProposals
        .filter(
          (proposal) =>
            proposal.base.objectId === baseObjectId && proposal.head.objectId === headObjectId,
        )
        .map((proposal) => ({
          attached: project.localRepositorySource?.repositoryId === repositoryId,
          id: proposal.id,
          label:
            project.repository === null
              ? proposal.title
              : `${proposal.title} · ${project.repository.owner}/${project.repository.name}`,
        })),
    )
    .sort(
      (left, right) =>
        Number(right.attached) - Number(left.attached) ||
        left.label.localeCompare(right.label, "en") ||
        left.id.localeCompare(right.id, "en"),
    )
    .map(({ id, label }) => ({ id, label }));
}

function safeError(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) {
    return `${error.details.message} Reference: ${error.details.correlationId}`;
  }
  return fallback;
}

export function OpenLocalRepositoryForm({
  disabled,
  projects,
  boundRepository,
  loadRepositories = fetchLocalRepositories,
  loadReferences = fetchLocalRepositoryReferences,
  retain = retainReviewRevision,
  onAuthenticationError,
  onAvailable,
}: OpenLocalRepositoryFormProps) {
  const [open, setOpen] = useState(false);
  const [repositories, setRepositories] = useState<LocalRepositoryInventory | null>(null);
  const [references, setReferences] = useState<LocalRepositoryReferences | null>(null);
  const [repositoryId, setRepositoryId] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [headRef, setHeadRef] = useState("");
  const [changeIntent, setChangeIntent] = useState("");
  const [changeProposalId, setChangeProposalId] = useState("");
  const [loading, setLoading] = useState<"repositories" | "references" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const active = useRef<AbortController | null>(null);
  const completedRevision = useRef<ReviewRevisionAvailable | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => () => active.current?.abort(), []);

  const reset = () => {
    active.current?.abort();
    active.current = null;
    setOpen(false);
    setRepositories(null);
    setReferences(null);
    setRepositoryId("");
    setBaseRef("");
    setHeadRef("");
    setChangeIntent("");
    setChangeProposalId("");
    setLoading(null);
    setPending(false);
    setError(null);
  };

  useEffect(() => {
    if (disabled && open) {
      reset();
    }
  }, [disabled, open]);

  const loadRepositoryInventory = async () => {
    const controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    setRepositories(null);
    setReferences(null);
    setRepositoryId("");
    setBaseRef("");
    setHeadRef("");
    setChangeProposalId("");
    setLoading("repositories");
    setError(null);
    try {
      const result = await loadRepositories(controller.signal);
      if (active.current === controller && !controller.signal.aborted) {
        setRepositories(result);
      }
    } catch (requestError) {
      if (!controller.signal.aborted && !(onAuthenticationError?.(requestError) ?? false)) {
        setError(safeError(requestError, "Kestrel could not list authorized repositories."));
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setLoading(null);
      }
    }
  };

  const openDialog = async () => {
    if (disabled) {
      return;
    }
    setOpen(true);
    if (boundRepository === undefined) await loadRepositoryInventory();
    else await selectRepository(boundRepository.repositoryId);
  };

  const selectRepository = async (selectedRepositoryId: string) => {
    setRepositoryId(selectedRepositoryId);
    setReferences(null);
    setBaseRef("");
    setHeadRef("");
    setChangeProposalId("");
    setError(null);
    active.current?.abort();
    if (selectedRepositoryId === "") {
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setLoading("references");
    try {
      const result = await loadReferences(selectedRepositoryId, controller.signal);
      if (active.current === controller && !controller.signal.aborted) {
        setReferences(result);
      }
    } catch (requestError) {
      if (!controller.signal.aborted && !(onAuthenticationError?.(requestError) ?? false)) {
        setError(safeError(requestError, "Kestrel could not list committed references."));
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setLoading(null);
      }
    }
  };

  const base = references?.references.find(({ ref }) => ref === baseRef);
  const head = references?.references.find(({ ref }) => ref === headRef);
  const repository =
    boundRepository ??
    repositories?.repositories.find((candidate) => candidate.repositoryId === repositoryId);
  const matchingProposals = useMemo(() => {
    if (base === undefined || head === undefined) {
      return [];
    }
    return findMatchingProposalOptions(
      projects,
      repositoryId,
      base.commitObjectId,
      head.commitObjectId,
    );
  }, [base, head, projects, repositoryId]);
  const suggestions = [base?.commitSubjectSuggestion, head?.commitSubjectSuggestion].filter(
    (value, index, all): value is string =>
      value !== null && value !== undefined && all.indexOf(value) === index,
  );
  const normalizedIntent = changeIntent.trim();
  const intentBytes = new TextEncoder().encode(normalizedIntent).byteLength;
  const intentTooLarge = intentBytes > 20_000;
  const intentHelpId = `${titleId}-intent-help`;
  const intentErrorId = `${titleId}-intent-error`;
  const canSubmit =
    !disabled &&
    references !== null &&
    base !== undefined &&
    head !== undefined &&
    baseRef !== headRef &&
    normalizedIntent.length > 0 &&
    !intentTooLarge;

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || references === null) {
      setError("Select an authorized repository and wait for its committed references.");
      return;
    }
    let command: RetainReviewRevisionCommand;
    try {
      command = buildRetainCommand(references, {
        repositoryId,
        baseRef,
        headRef,
        changeIntent,
        ...(changeProposalId === "" ? {} : { changeProposalId }),
      });
    } catch (validationError) {
      setError(
        validationError instanceof Error
          ? validationError.message
          : "Complete every required Review Revision field.",
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
      if (active.current === controller && !controller.signal.aborted) {
        completedRevision.current = result;
        reset();
      }
    } catch (requestError) {
      if (!controller.signal.aborted && !(onAuthenticationError?.(requestError) ?? false)) {
        setError(safeError(requestError, "Kestrel could not retain the exact Review Revision."));
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setPending(false);
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) reset();
      }}
    >
      <div className="project-local-entry">
        <Button ref={trigger} type="button" disabled={disabled} onClick={() => void openDialog()}>
          Compare committed refs
        </Button>
        <p className="form-help">
          Select committed base and head references from an authorized read-only repository.
        </p>
        {open ? (
          <DialogContent
            showCloseButton={false}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              heading.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              trigger.current?.focus();
              const completed = completedRevision.current;
              completedRevision.current = null;
              if (completed !== null) onAvailable(completed);
            }}
            className="local-repository-dialog max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onInteractOutside={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              if (!pending) reset();
            }}
          >
            <div className="local-dialog-heading">
              <div>
                <DialogTitle id={titleId} ref={heading} tabIndex={-1}>
                  Retain an exact change
                </DialogTitle>
              </div>
              <Button
                variant="outline"
                className="secondary-action"
                type="button"
                disabled={disabled || pending}
                onClick={reset}
              >
                Close
              </Button>
            </div>
            <DialogDescription id={descriptionId}>
              Kestrel reads only committed Git objects and retains a verified base/head snapshot.
            </DialogDescription>
            {boundRepository === undefined ? (
              <div className="local-inventory-actions">
                <p>Inventory is read from the current trusted-host configuration.</p>
                <Button
                  variant="outline"
                  className="secondary-action"
                  type="button"
                  disabled={disabled || pending || loading === "repositories"}
                  onClick={() => void loadRepositoryInventory()}
                >
                  {loading === "repositories" ? "Refreshing repositories…" : "Refresh repositories"}
                </Button>
              </div>
            ) : null}
            {boundRepository === undefined && repositories?.inventoryState !== "ready" ? (
              <RepositorySetupState
                headingLevel={3}
                state={
                  loading === "repositories" || (repositories === null && error === null)
                    ? "loading"
                    : (repositories?.inventoryState ?? "discovery_failed")
                }
                {...(error === null ? {} : { error })}
              />
            ) : null}
            <form
              className="local-repository-form"
              hidden={boundRepository === undefined && repositories?.inventoryState !== "ready"}
              onSubmit={(event) => void submit(event)}
              noValidate
            >
              {boundRepository === undefined ? (
                <div className="form-field">
                  <Label htmlFor={`${titleId}-repository`}>Repository</Label>
                  <NativeSelect
                    id={`${titleId}-repository`}
                    value={repositoryId}
                    disabled={disabled || pending || loading === "repositories"}
                    onChange={(event) => void selectRepository(event.currentTarget.value)}
                  >
                    <option value="">Select an authorized repository</option>
                    {repositories?.repositories.map((repository) => (
                      <option key={repository.repositoryId} value={repository.repositoryId}>
                        {repository.displayName}
                        {repository.attachmentState === "attached" ? " · attached" : ""}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ) : (
                <p>
                  <strong>Repository:</strong> {boundRepository.displayName}
                </p>
              )}
              <fieldset
                disabled={disabled || pending || loading === "references" || references === null}
              >
                <legend>Exact committed revision</legend>
                <div className="local-ref-grid">
                  <div className="form-field">
                    <Label htmlFor={`${titleId}-base`}>Base reference</Label>
                    <NativeSelect
                      id={`${titleId}-base`}
                      value={baseRef}
                      required
                      onChange={(event) => {
                        setBaseRef(event.currentTarget.value);
                        setChangeProposalId("");
                      }}
                    >
                      <option value="">Select base</option>
                      {references?.references.map((reference) => (
                        <option key={reference.ref} value={reference.ref}>
                          {reference.displayName}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="form-field">
                    <Label htmlFor={`${titleId}-head`}>Head reference</Label>
                    <NativeSelect
                      id={`${titleId}-head`}
                      value={headRef}
                      required
                      onChange={(event) => {
                        setHeadRef(event.currentTarget.value);
                        setChangeProposalId("");
                      }}
                    >
                      <option value="">Select head</option>
                      {references?.references.map((reference) => (
                        <option key={reference.ref} value={reference.ref}>
                          {reference.displayName}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                </div>
              </fieldset>
              {suggestions.length > 0 ? (
                <section className="intent-suggestions" aria-labelledby={`${titleId}-suggestions`}>
                  <h3 id={`${titleId}-suggestions`}>Suggestions from commits</h3>
                  <p>
                    Commit subjects are suggestions only. Choose one explicitly or write your own
                    intent.
                  </p>
                  {suggestions.map((suggestion) => (
                    <Button
                      variant="outline"
                      className="secondary-action"
                      type="button"
                      key={suggestion}
                      disabled={disabled || pending}
                      onClick={() => setChangeIntent(suggestion)}
                    >
                      Use suggestion: {suggestion}
                    </Button>
                  ))}
                </section>
              ) : null}
              <div className="form-field">
                <Label htmlFor={`${titleId}-intent`}>Change Intent</Label>
                <Textarea
                  id={`${titleId}-intent`}
                  value={changeIntent}
                  maxLength={20_000}
                  required
                  disabled={disabled || pending}
                  aria-describedby={`${intentHelpId}${intentTooLarge ? ` ${intentErrorId}` : ""}`}
                  aria-invalid={intentTooLarge || undefined}
                  onChange={(event) => setChangeIntent(event.currentTarget.value)}
                />
                <p id={intentHelpId} className="form-help" aria-live="polite">
                  {intentBytes.toLocaleString("en-US")} / 20,000 UTF-8 bytes
                </p>
                {intentTooLarge ? (
                  <p id={intentErrorId} className="project-form-error" role="alert">
                    Change Intent must be 20,000 UTF-8 bytes or fewer.
                  </p>
                ) : null}
              </div>
              {matchingProposals.length > 0 ? (
                <div className="form-field">
                  <Label htmlFor={`${titleId}-proposal`}>Matching Change Proposal (optional)</Label>
                  <NativeSelect
                    id={`${titleId}-proposal`}
                    value={changeProposalId}
                    disabled={disabled || pending}
                    onChange={(event) => setChangeProposalId(event.currentTarget.value)}
                  >
                    <option value="">Match automatically</option>
                    {matchingProposals.map((proposal) => (
                      <option key={proposal.id} value={proposal.id}>
                        {proposal.label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ) : null}
              {base !== undefined && head !== undefined ? (
                <dl className="local-confirmation">
                  <div>
                    <dt>Repository</dt>
                    <dd>{repository?.displayName ?? "Authorized repository"}</dd>
                  </div>
                  <div>
                    <dt>Base commit</dt>
                    <dd>
                      <code>{base.commitObjectId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Head commit</dt>
                    <dd>
                      <code>{head.commitObjectId}</code>
                    </dd>
                  </div>
                </dl>
              ) : null}
              {loading === "references" ? <p role="status">Reading committed references…</p> : null}
              {error ? (
                <p className="project-form-error" role="alert">
                  {error}
                </p>
              ) : null}
              <Button
                type="submit"
                disabled={disabled || pending || loading !== null || !canSubmit}
              >
                {pending ? "Retaining…" : "Retain Review Revision"}
              </Button>
            </form>
          </DialogContent>
        ) : null}
      </div>
    </Dialog>
  );
}
