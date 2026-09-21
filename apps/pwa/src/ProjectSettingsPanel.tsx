import type { DirectApiProfile, ProjectInbox } from "@kestrel/contracts";

import { projectLabel } from "./AuthenticatedShell.js";
import { DirectApiProfilePanel } from "./DirectApiProfilePanel.js";
import { ProjectGitHubAccessPanel } from "./HostGitHubConnectionPanel.js";

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
