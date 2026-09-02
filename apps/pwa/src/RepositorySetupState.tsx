import type { LocalRepositoryInventory } from "@kestrel/contracts";

const TRUSTED_HOST_REPOSITORY_COMMAND = `LOCAL_REPOSITORY_ROOTS='["/absolute/path/to/authorized-parent"]' npm run dev`;

type RepositorySetupState =
  Exclude<LocalRepositoryInventory["inventoryState"], "ready"> | "discovery_failed" | "loading";

interface RepositorySetupStateProps {
  error?: string;
  state: RepositorySetupState;
}

const stateContent: Record<
  Exclude<RepositorySetupState, "discovery_failed">,
  { description: string; title: string }
> = {
  loading: {
    description: "Reading repositories… Kestrel is checking trusted-host configuration.",
    title: "Checking repository setup",
  },
  no_configured_roots: {
    description:
      "Kestrel has not been authorized to inspect any local parent directory. Local discovery remains disabled.",
    title: "No repository roots are configured",
  },
  no_repositories_found: {
    description:
      "The configured roots were loaded successfully, but they do not contain a discoverable Git repository.",
    title: "No Git repositories were found",
  },
};

export function RepositorySetupState({ error, state }: RepositorySetupStateProps) {
  const failed = state === "discovery_failed";
  const content = failed
    ? {
        description:
          error ??
          "Kestrel could not inspect the authorized roots. Check the trusted-host runtime.",
        title: "Repository discovery failed",
      }
    : stateContent[state];

  return (
    <section
      className={`repository-setup-state${failed ? " repository-setup-failed" : ""}`}
      role={failed ? "alert" : "status"}
      aria-busy={state === "loading" || undefined}
    >
      <p className="section-index">REPOSITORY SETUP</p>
      <h4>{content.title}</h4>
      <p>{content.description}</p>
      <div className="repository-setup-action">
        <strong>Trusted-host action</strong>
        <p>Stop Kestrel, authorize an explicit parent directory, then restart with:</p>
        <code>{TRUSTED_HOST_REPOSITORY_COMMAND}</code>
        <p>The browser never sends or receives the filesystem path.</p>
      </div>
    </section>
  );
}
