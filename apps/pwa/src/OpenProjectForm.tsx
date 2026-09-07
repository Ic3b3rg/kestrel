import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./components/ui/dialog.js";
import { Button } from "./components/ui/button.js";
import { NativeSelect } from "./components/ui/native-select.js";
import { Label } from "./components/ui/label.js";
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
  triggerLabel?: string;
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
  triggerLabel = "Open Project",
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
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) reset();
      }}
    >
      <div className="open-project-entry">
        <Button ref={trigger} type="button" disabled={disabled} onClick={() => void show()}>
          {triggerLabel}
        </Button>
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
            }}
            className="local-repository-dialog open-project-dialog max-h-[85dvh] overflow-y-auto sm:max-w-xl"
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
                <DialogTitle ref={heading} id={titleId} tabIndex={-1}>
                  Open an authorized repository
                </DialogTitle>
              </div>
              <Button
                variant="outline"
                className="secondary-action"
                type="button"
                disabled={pending}
                onClick={reset}
              >
                Close
              </Button>
            </div>
            <DialogDescription id={descriptionId}>
              Choose a local repository to open its Project.
            </DialogDescription>
            <div className="local-inventory-actions">
              <p>Repositories you have already opened keep their Project history.</p>
              <Button
                variant="outline"
                className="secondary-action"
                type="button"
                disabled={pending || loading}
                onClick={() => void readInventory()}
              >
                {loading ? "Refreshing repositories…" : "Refresh repositories"}
              </Button>
            </div>
            {inventory?.inventoryState !== "ready" ? (
              <RepositorySetupState
                headingLevel={3}
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
                  <Label htmlFor={repositoryIdField}>Repository</Label>
                  <NativeSelect
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
                  </NativeSelect>
                </div>
                <Button type="submit" disabled={pending || repositoryId === ""}>
                  {pending ? "Opening Project…" : "Open selected Project"}
                </Button>
                {error === null ? null : (
                  <p className="project-form-error" role="alert">
                    {error}
                  </p>
                )}
              </form>
            )}
          </DialogContent>
        ) : null}
      </div>
    </Dialog>
  );
}
