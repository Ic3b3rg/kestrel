import type { LocalRepositoryInventory } from "@kestrel/contracts";

const AUTHORIZE_FOLDER_COMMAND = "kestrel authorize";

type RepositorySetupState =
  Exclude<LocalRepositoryInventory["inventoryState"], "ready"> | "discovery_failed" | "loading";

interface RepositorySetupStateProps {
  error?: string;
  headingLevel?: 3 | 4;
  state: RepositorySetupState;
}

export function AuthorizeFolderHelp() {
  return (
    <details className="repository-setup-action">
      <summary>Authorize a folder</summary>
      <div>
        <p>Open a terminal in the folder you want to authorize and run:</p>
        <code>{AUTHORIZE_FOLDER_COMMAND}</code>
        <p>Then refresh the repository list.</p>
      </div>
    </details>
  );
}

const stateContent: Record<
  Exclude<RepositorySetupState, "discovery_failed" | "loading">,
  { description: string; title: string }
> = {
  no_configured_roots: {
    description: "Authorize a folder on your computer to make its repositories available here.",
    title: "No folders authorized yet",
  },
  no_repositories_found: {
    description: "The authorized folders do not contain any Git repositories.",
    title: "No Git repositories were found",
  },
};

export function RepositorySetupState({
  error,
  headingLevel = 4,
  state,
}: RepositorySetupStateProps) {
  if (state === "loading") {
    return (
      <p className="repository-loading" role="status" aria-busy="true">
        Reading repositories…
      </p>
    );
  }

  const Heading = headingLevel === 3 ? "h3" : "h4";
  const failed = state === "discovery_failed";
  const content = failed
    ? {
        description: error ?? "Kestrel could not read your repositories. Try refreshing the list.",
        title: "Repository discovery failed",
      }
    : stateContent[state];

  return (
    <section
      className={`repository-setup-state${failed ? " repository-setup-failed" : ""}`}
      role={failed ? "alert" : "status"}
    >
      <Heading>{content.title}</Heading>
      <p>{content.description}</p>
      <AuthorizeFolderHelp />
    </section>
  );
}
