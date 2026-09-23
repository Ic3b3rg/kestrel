import { LifecycleProfilePanel } from "./LifecycleProfilePanel.js";
import type { DirectApiProfile, ProjectInbox } from "@kestrel/contracts";

import { projectLabel } from "./AuthenticatedShell.js";
import { DirectApiProfilePanel } from "./DirectApiProfilePanel.js";
import { ProjectGitHubAccessPanel } from "./HostGitHubConnectionPanel.js";
import { Button } from "./components/ui/button.js";
import { FormFeedback } from "./components/FormFeedback.js";

type Project = ProjectInbox["projects"][number];

const sourceAvailabilityLabels: Record<Project["sourceAvailability"], string> = {
  available: "Available",
  not_acquired: "Not acquired",
  unavailable: "Unavailable",
};

const localSourceStateLabels = {
  attached: "Attached",
  detached: "Detached",
} as const;

export function ProjectSettingsRoute({
  projectId,
  inbox,
  loading,
  error,
  online,
  onAuthenticationError,
  onRetry,
  onBack,
  onChanged,
}: {
  projectId: string;
  inbox: ProjectInbox | null;
  loading: boolean;
  error: string | null;
  online: boolean;
  onAuthenticationError: (error: unknown) => boolean;
  onRetry: () => void;
  onBack: () => void;
  onChanged: () => void;
}) {
  const project = inbox?.projects.find((candidate) => candidate.id === projectId);
  if (project !== undefined)
    return (
      <ProjectSettingsPanel
        key={project.id}
        project={project}
        online={online}
        onAuthenticationError={onAuthenticationError}
        onChanged={onChanged}
      />
    );
  if (!online)
    return (
      <section className="workspace-state space-y-4">
        <h1>Project settings</h1>
        <FormFeedback kind="error" title="Project settings are offline">
          Reconnect this workstation to read the selected Project.
        </FormFeedback>
      </section>
    );
  if (inbox === null && loading)
    return (
      <section className="workspace-state space-y-4" aria-busy="true">
        <h1>Reading Project settings</h1>
        <FormFeedback kind="pending">Loading the selected Project…</FormFeedback>
      </section>
    );
  if (inbox === null)
    return (
      <section className="workspace-state space-y-4">
        <h1>Project settings unavailable</h1>
        <FormFeedback focus kind="error" title="The Project could not be read">
          {error ?? "Retry the authoritative Project inventory."}
        </FormFeedback>
        <Button type="button" onClick={onRetry}>
          Retry Project
        </Button>
      </section>
    );
  return (
    <section className="workspace-state space-y-4">
      <h1>Project not found</h1>
      <FormFeedback kind="error" title="This Project is no longer available">
        Choose another Project from the sidebar.
      </FormFeedback>
      <Button type="button" onClick={onBack}>
        Back to Projects
      </Button>
    </section>
  );
}

export function ProjectSettingsPanel({
  project,
  online,
  onAuthenticationError,
  onChanged,
}: {
  project: Project;
  online: boolean;
  onAuthenticationError?: (error: unknown) => boolean;
  onChanged: (projectId: string, profile: DirectApiProfile) => void;
}) {
  const repository = project.repository;
  const localSource = project.localRepositorySource;

  return (
    <div className="project-settings-view space-y-6">
      <header className="project-workspace-header">
        <div>
          <p className="mb-1 text-sm text-muted-foreground">{projectLabel(project)}</p>
          <h1 id="page-title">Project settings</h1>
          <p className="lede">Repository access and model configuration for this Project only.</p>
        </div>
        <a href={`/projects/${encodeURIComponent(project.id)}`}>Back to Project</a>
      </header>

      <section
        className="record-section"
        aria-labelledby="repository-settings-title"
        id="repository-settings"
      >
        <div className="section-heading">
          <div>
            <h2 id="repository-settings-title" tabIndex={-1}>
              Project information
            </h2>
          </div>
        </div>
        <dl className="fact-list">
          <div className="fact-wide">
            <dt>Repository</dt>
            <dd>
              {repository === null ? (
                "Not yet identified"
              ) : (
                <a href={repository.canonicalUrl} target="_blank" rel="noreferrer">
                  {repository.owner}/{repository.name}
                </a>
              )}
            </dd>
          </div>
          <div>
            <dt>Local source</dt>
            <dd>
              <strong>
                {localSource === null ? "Not attached" : localSourceStateLabels[localSource.state]}
              </strong>
              {localSource === null ? null : <span>{localSource.displayName}</span>}
            </dd>
          </div>
          <div>
            <dt>Retained review source</dt>
            <dd>{sourceAvailabilityLabels[project.sourceAvailability]}</dd>
          </div>
        </dl>
      </section>

      <ProjectGitHubAccessPanel
        project={project}
        online={online}
        {...(onAuthenticationError === undefined ? {} : { onAuthenticationError })}
      />

      <LifecycleProfilePanel projectId={project.id} online={online} />
      <DirectApiProfilePanel
        key={project.id}
        projectId={project.id}
        disabled={!online}
        onChanged={(profile) => onChanged(project.id, profile)}
        {...(onAuthenticationError === undefined ? {} : { onAuthenticationError })}
      />
    </div>
  );
}
