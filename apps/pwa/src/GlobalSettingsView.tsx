import { SourceOnboardingPanel } from "./SourceOnboardingPanel.js";
import type { MouseEvent, ReactNode } from "react";

import type { ProjectInbox } from "@kestrel/contracts";

import { appPath, type SettingsSection } from "./app-route.js";
import { projectLabel } from "./AuthenticatedShell.js";
import { Button } from "./components/ui/button.js";
import { FormFeedback } from "./components/FormFeedback.js";

const sections: readonly { id: SettingsSection; label: string; description: string }[] = [
  { id: "profile", label: "Profile", description: "Your Operator account and credentials." },
  { id: "projects", label: "Projects", description: "Authorized repositories and Projects." },
  { id: "providers", label: "Providers", description: "Model access and preferences." },
  { id: "source-control", label: "Source control", description: "GitHub on this workstation." },
  { id: "skills", label: "Skills", description: "Installed procedures for Planning Sessions." },
];

function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.currentTarget.target !== "_blank"
  );
}

export function GlobalSettingsView({
  children,
  onNavigate,
  section,
}: {
  children?: ReactNode;
  onNavigate: (section: SettingsSection) => void;
  section: SettingsSection;
}) {
  const current = sections.find((candidate) => candidate.id === section);
  if (current === undefined) return null;

  return (
    <div className="settings-view global-settings-view">
      <header className="intro">
        <div>
          <h1 id="page-title">Settings</h1>
          <p className="lede">Choose what you want to configure.</p>
        </div>
      </header>
      <nav aria-label="Settings sections" className="settings-navigation">
        {sections.map((item) => (
          <a
            key={item.id}
            href={appPath({ kind: "settings", section: item.id })}
            aria-current={item.id === section ? "page" : undefined}
            onClick={(event) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              onNavigate(item.id);
            }}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <div className="settings-section">
        <div className="settings-section-heading">
          <h2 id="settings-section-title" tabIndex={-1}>
            {current.label}
          </h2>
          <p>{current.description}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

export function SettingsProjectLinks({
  error,
  loading,
  online,
  onNavigate,
  onRetry,
  projects,
}: {
  error: string | null;
  loading: boolean;
  online: boolean;
  onNavigate: (projectId: string) => void;
  onRetry: () => void;
  projects: ProjectInbox["projects"] | null;
}) {
  return (
    <section
      className="settings-project-links record-section"
      aria-labelledby="settings-projects-title"
    >
      <h2 id="settings-projects-title">Project settings</h2>
      <SourceOnboardingPanel disabled={!online} onAuthorized={onRetry} />
      {online && error !== null && projects !== null ? (
        <>
          <FormFeedback kind="error" title="Projects could not be refreshed">
            {error}
          </FormFeedback>
          <Button type="button" onClick={onRetry}>
            Retry Projects
          </Button>
        </>
      ) : null}
      {!online ? (
        <FormFeedback kind="error" title="Projects are offline">
          Reconnect this workstation to see your Projects.
        </FormFeedback>
      ) : error !== null && projects === null ? (
        <>
          <FormFeedback kind="error" title="Projects could not be loaded">
            {error}
          </FormFeedback>
          <Button type="button" onClick={onRetry}>
            Retry Projects
          </Button>
        </>
      ) : projects === null && loading ? (
        <FormFeedback kind="pending">Loading Projects…</FormFeedback>
      ) : projects === null || projects.length === 0 ? (
        <p>Open a repository to add your first Project.</p>
      ) : (
        <ul className="settings-project-list">
          {projects.map((project) => (
            <li key={project.id}>
              <span>{projectLabel(project)}</span>
              <a
                href={appPath({ kind: "project_settings", projectId: project.id })}
                aria-label={`Open settings for ${projectLabel(project)}`}
                onClick={(event) => {
                  if (!isPlainClick(event)) return;
                  event.preventDefault();
                  onNavigate(project.id);
                }}
              >
                Open Project settings
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
