import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";

import {
  OpenLocalProjectCommandSchema,
  type LocalRepositoryInventory,
  type OpenLocalProjectCommand,
  type ProjectUpserted,
} from "@kestrel/contracts";

import { ApiClientError, fetchLocalRepositories, openLocalProject } from "./api.js";
import { RepositorySetupState } from "./RepositorySetupState.js";

export interface OpenProjectFormProps {
  disabled: boolean;
  loadRepositories?: (signal?: AbortSignal) => Promise<LocalRepositoryInventory>;
  onAuthenticationError?: (error: unknown) => boolean;
  onOpened: (result: ProjectUpserted) => void;
  openProject?: (
    command: OpenLocalProjectCommand,
    signal?: AbortSignal,
  ) => Promise<ProjectUpserted>;
}

function safeError(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) {
    return `${error.details.message} Reference: ${error.details.correlationId}`;
  }
  return fallback;
}

export function OpenProjectForm({
  disabled,
  loadRepositories = fetchLocalRepositories,
  onAuthenticationError,
  onOpened,
  openProject = openLocalProject,
}: OpenProjectFormProps) {
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<LocalRepositoryInventory | null>(null);
  const [repositoryId, setRepositoryId] = useState("");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  const repositoryIdField = useId();

  const reset = () => {
    active.current?.abort();
    active.current = null;
    setOpen(false);
    setInventory(null);
    setRepositoryId("");
    setLoading(false);
    setPending(false);
    setError(null);
  };

  useEffect(() => () => active.current?.abort(), []);

  useEffect(() => {
    if (open) {
      if (dialog.current !== null && !dialog.current.open) dialog.current.showModal();
      heading.current?.focus();
    } else if (wasOpen.current) {
      trigger.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (disabled && open) reset();
  }, [disabled, open]);

  const readInventory = async () => {
    const controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    setInventory(null);
    setRepositoryId("");
    setLoading(true);
    setError(null);
    try {
      const result = await loadRepositories(controller.signal);
      if (active.current === controller && !controller.signal.aborted) setInventory(result);
    } catch (requestError) {
      if (!controller.signal.aborted && !(onAuthenticationError?.(requestError) ?? false)) {
        setError(safeError(requestError, "Kestrel could not list authorized repositories."));
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setLoading(false);
      }
    }
  };

  const show = async () => {
    if (disabled) return;
    setOpen(true);
    await readInventory();
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const command = OpenLocalProjectCommandSchema.safeParse({ repositoryId });
    if (!command.success) {
      setError("Select an authorized repository.");
      return;
    }
    const controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    setPending(true);
    setError(null);
    try {
      const result = await openProject(command.data, controller.signal);
      if (active.current === controller && !controller.signal.aborted) {
        onOpened(result);
        reset();
      }
    } catch (requestError) {
      if (!controller.signal.aborted && !(onAuthenticationError?.(requestError) ?? false)) {
        setError(safeError(requestError, "Kestrel could not open the selected Project."));
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setPending(false);
      }
    }
  };

  return (
    <div className="open-project-entry">
      <button ref={trigger} type="button" disabled={disabled} onClick={() => void show()}>
        Open Project
      </button>
      {open ? (
        <dialog
          ref={dialog}
          className="local-repository-dialog open-project-dialog"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onCancel={(event) => {
            event.preventDefault();
            if (!pending) reset();
          }}
        >
          <div className="local-dialog-heading">
            <div>
              <p className="section-index">PROJECT / LOCAL SOURCE</p>
              <h3 ref={heading} id={titleId} tabIndex={-1}>
                Open an authorized repository
              </h3>
            </div>
            <button className="secondary-action" type="button" disabled={pending} onClick={reset}>
              Close
            </button>
          </div>
          <p id={descriptionId}>
            Choose a repository discovered from trusted-host configuration. Browser state never
            stores or submits its filesystem path.
          </p>
          <div className="local-inventory-actions">
            <p>The durable Project will reuse an existing match when one is already open.</p>
            <button
              className="secondary-action"
              type="button"
              disabled={pending || loading}
              onClick={() => void readInventory()}
            >
              {loading ? "Refreshing repositories…" : "Refresh repositories"}
            </button>
          </div>
          {inventory?.inventoryState !== "ready" ? (
            <RepositorySetupState
              state={
                loading || (inventory === null && error === null)
                  ? "loading"
                  : (inventory?.inventoryState ?? "discovery_failed")
              }
              {...(error === null ? {} : { error })}
            />
          ) : (
            <form className="open-project-form" onSubmit={(event) => void submit(event)}>
              <div className="form-field">
                <label htmlFor={repositoryIdField}>Repository</label>
                <select
                  id={repositoryIdField}
                  value={repositoryId}
                  disabled={pending}
                  required
                  onChange={(event) => {
                    setRepositoryId(event.currentTarget.value);
                    setError(null);
                  }}
                >
                  <option value="">Select a repository</option>
                  {inventory.repositories.map((repository) => (
                    <option key={repository.repositoryId} value={repository.repositoryId}>
                      {repository.displayName}
                      {repository.attachmentState === "attached" ? " · already open" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" disabled={pending || repositoryId === ""}>
                {pending ? "Opening Project…" : "Open selected Project"}
              </button>
              {error === null ? null : (
                <p className="project-form-error" role="alert">
                  {error}
                </p>
              )}
            </form>
          )}
        </dialog>
      ) : null}
    </div>
  );
}
