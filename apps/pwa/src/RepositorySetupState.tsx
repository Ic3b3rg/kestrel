import type { LocalRepositoryInventory } from "@kestrel/contracts";

export const TRUSTED_HOST_REPOSITORY_COMMAND =
  "npm run authorize-repository-root -- /absolute/path/to/authorized-parent";

type RepositorySetupState =
  Exclude<LocalRepositoryInventory["inventoryState"], "ready"> | "discovery_failed" | "loading";

interface RepositorySetupStateProps {
  error?: string;
  state: RepositorySetupState;
}

export function TrustedHostRepositoryAction() {
  return (
    <div className="repository-setup-action">
      <strong>Trusted-host action</strong>
      <p>Authorize an explicit parent directory from a trusted-host terminal:</p>
      <code>{TRUSTED_HOST_REPOSITORY_COMMAND}</code>
      <p>Then refresh repositories here or restart Kestrel. The browser never receives the path.</p>
    </div>
  );
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
      <TrustedHostRepositoryAction />
    </section>
  );
}
