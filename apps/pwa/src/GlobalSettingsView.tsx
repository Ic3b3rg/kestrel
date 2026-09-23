import { SourceOnboardingPanel } from "./SourceOnboardingPanel.js";
import { LifecycleProfilePanel } from "./LifecycleProfilePanel.js";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

import type { ProjectInbox, Session } from "@kestrel/contracts";
import { ApiClientError, updateOperatorCredentials } from "./api.js";
import {
  OperatorSecurityPanel,
  type OperatorCredentialFormValue,
  type OperatorSecurityError,
} from "./OperatorSecurityPanel.js";
import { RepositoryAccessPanel } from "./RepositoryAccessPanel.js";
import { CodexSubscriptionConnectionPanel } from "./CodexSubscriptionConnectionPanel.js";
import { HostGitHubConnectionPanel } from "./HostGitHubConnectionPanel.js";
import { PlanningSkillLibrary } from "./PlanningSkillLibrary.js";

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

export interface GlobalSettingsRouteProps {
  section: SettingsSection;
  online: boolean;
  session: Session;
  sessionCommandBlocked: boolean;
  projects: ProjectInbox["projects"] | null;
  projectsError: string | null;
  projectsLoading: boolean;
  onRetryProjects: () => void;
  onNavigate: (section: SettingsSection) => void;
  onOpenProjectSettings: (projectId: string) => void;
  onAuthenticationError: (error: unknown) => boolean;
  onCredentialsChanged: (message: string) => void;
  onSessionCommandPending: (pending: boolean) => void;
}

function OperatorProfileSettings({
  online,
  session,
  sessionCommandBlocked,
  onAuthenticationError,
  onCredentialsChanged,
  onSessionCommandPending,
}: Pick<
  GlobalSettingsRouteProps,
  | "online"
  | "session"
  | "sessionCommandBlocked"
  | "onAuthenticationError"
  | "onCredentialsChanged"
  | "onSessionCommandPending"
>) {
  const command = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<OperatorSecurityError | null>(null);
  useEffect(() => {
    const cancel = () => {
      command.current?.abort();
      command.current = null;
      setPending(false);
      onSessionCommandPending(false);
    };
    if (!online) cancel();
    return cancel;
  }, [online, session.operator.id, session.credentialVersion, onSessionCommandPending]);

  const changeCredentials = async (value: OperatorCredentialFormValue) => {
    if (!online || sessionCommandBlocked || command.current !== null) return;
    const controller = new AbortController();
    command.current = controller;
    setPending(true);
    setError(null);
    onSessionCommandPending(true);
    try {
      await updateOperatorCredentials({ ...value, session }, controller.signal);
      if (!controller.signal.aborted && command.current === controller)
        onCredentialsChanged("Credentials changed. Sign in with your updated Operator account.");
    } catch (failure) {
      if (!controller.signal.aborted && !onAuthenticationError(failure))
        setError({
          action: "credentials",
          message:
            failure instanceof ApiClientError
              ? `${failure.details.message} Reference: ${failure.details.correlationId}`
              : "Kestrel could not change the Operator credentials.",
        });
    } finally {
      if (command.current === controller) {
        command.current = null;
        setPending(false);
        onSessionCommandPending(false);
      }
    }
  };
  return (
    <OperatorSecurityPanel
      online={online}
      session={session}
      pending={pending ? "credentials" : sessionCommandBlocked ? "logout" : null}
      error={error}
      onClearError={() => setError(null)}
      onChangeCredentials={changeCredentials}
    />
  );
}

export function GlobalSettingsRoute(props: GlobalSettingsRouteProps) {
  const projectLinks = (
    <SettingsProjectLinks
      projects={props.projects}
      error={props.projectsError}
      loading={props.projectsLoading}
      online={props.online}
      onRetry={props.onRetryProjects}
      onNavigate={props.onOpenProjectSettings}
    />
  );
  return (
    <GlobalSettingsView section={props.section} onNavigate={props.onNavigate}>
      {props.section === "profile" ? (
        <OperatorProfileSettings
          online={props.online}
          session={props.session}
          sessionCommandBlocked={props.sessionCommandBlocked}
          onAuthenticationError={props.onAuthenticationError}
          onCredentialsChanged={props.onCredentialsChanged}
          onSessionCommandPending={props.onSessionCommandPending}
        />
      ) : props.section === "projects" ? (
        <>
          <RepositoryAccessPanel
            online={props.online}
            onAuthenticationError={props.onAuthenticationError}
          />
          {projectLinks}
        </>
      ) : props.section === "providers" ? (
        <>
          <CodexSubscriptionConnectionPanel
            online={props.online}
            onAuthenticationError={props.onAuthenticationError}
          />
          <LifecycleProfilePanel online={props.online} />
        </>
      ) : props.section === "source-control" ? (
        <>
          <HostGitHubConnectionPanel
            online={props.online}
            onAuthenticationError={props.onAuthenticationError}
          />
          {projectLinks}
        </>
      ) : (
        <PlanningSkillLibrary
          online={props.online}
          onAuthenticationError={props.onAuthenticationError}
        />
      )}
    </GlobalSettingsView>
  );
}

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
