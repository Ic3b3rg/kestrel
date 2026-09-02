import type { MouseEvent, ReactNode } from "react";

import type { ProjectInbox } from "@kestrel/contracts";

import type { AppRoute } from "./app-route.js";
import type { PwaConnectionState } from "./InstallationView.js";

type NavigableRoute = Exclude<AppRoute, { kind: "not_found" }>;
type Project = ProjectInbox["projects"][number];

export interface AuthenticatedShellProps {
  announcement: string;
  children?: ReactNode;
  connection: PwaConnectionState;
  error: string | null;
  inbox: ProjectInbox | null;
  loading: boolean;
  online: boolean;
  openProjectControl: ReactNode;
  operatorUsername: string;
  route: AppRoute;
  onNavigate: (route: NavigableRoute) => void;
  onRetry: () => void;
}

const connectionLabels: Record<PwaConnectionState, string> = {
  connected: "Connected",
  connecting: "Connecting",
  "cursor-expired": "Refreshing history",
  disconnected: "Disconnected",
  offline: "Offline",
  reconnecting: "Reconnecting",
};

export function projectLabel(project: Project): string {
  if (project.repository !== null) {
    return `${project.repository.owner}/${project.repository.name}`;
  }
  return project.localRepositorySource?.displayName ?? `Project ${project.id.slice(0, 8)}`;
}

function shouldHandleNavigation(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.currentTarget.target !== "_blank"
  );
}

export function AuthenticatedShell(props: AuthenticatedShellProps) {
  const navigate = (route: NavigableRoute) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleNavigation(event)) return;
    event.preventDefault();
    props.onNavigate(route);
  };

  return (
    <>
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>
      <header className="site-header">
        <a className="wordmark wordmark-link" href="/" onClick={navigate({ kind: "projects" })}>
          <span aria-hidden="true">K</span> KESTREL
        </a>
        <div
          className={`connection connection-${props.connection}`}
          aria-label={`Event stream: ${connectionLabels[props.connection]}`}
        >
          <span className="connection-dot" aria-hidden="true" />
          <span>Event stream</span>
          <strong>{connectionLabels[props.connection]}</strong>
        </div>
      </header>

      <div className="authenticated-shell">
        <aside className="project-rail" aria-labelledby="project-rail-title">
          <div className="project-rail-heading">
            <div>
              <p className="section-index">WORKSPACE</p>
              <h2 id="project-rail-title">Projects</h2>
            </div>
            {props.openProjectControl}
          </div>

          {props.error === null ? null : (
            <div className="project-rail-state project-rail-error" role="alert">
              <p>{props.error}</p>
              <button
                className="secondary-action"
                type="button"
                disabled={!props.online}
                onClick={props.onRetry}
              >
                Retry Projects
              </button>
            </div>
          )}

          {!props.online ? (
            <div className="project-rail-state">
              <strong>Projects hidden offline</strong>
              <span>Reconnect to refresh durable Project records.</span>
            </div>
          ) : props.loading && props.inbox === null ? (
            <div className="project-rail-state" aria-busy="true">
              <strong>Reading Projects</strong>
              <span>Waiting for authoritative storage.</span>
            </div>
          ) : props.inbox?.projects.length === 0 ? (
            <div className="project-rail-state">
              <strong>No Projects yet</strong>
              <span>Open an authorized repository to create one.</span>
            </div>
          ) : null}

          {props.inbox !== null && props.inbox.projects.length > 0 ? (
            <nav className="project-navigation" aria-label="Projects">
              <ul>
                {props.inbox.projects.map((project) => {
                  const selected =
                    props.route.kind === "project" && props.route.projectId === project.id;
                  return (
                    <li key={project.id}>
                      <a
                        href={`/projects/${encodeURIComponent(project.id)}`}
                        aria-current={selected ? "page" : undefined}
                        onClick={navigate({ kind: "project", projectId: project.id })}
                      >
                        <strong>{projectLabel(project)}</strong>
                        <span>
                          {project.localRepositorySource?.state === "attached"
                            ? "Local source attached"
                            : project.providerObservation === null
                              ? "Source unavailable"
                              : "Provider context"}
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
              {props.loading ? <p className="project-rail-refresh">Refreshing Projects…</p> : null}
            </nav>
          ) : null}

          <nav className="settings-navigation" aria-label="Installation">
            <a
              href="/settings"
              aria-current={props.route.kind === "settings" ? "page" : undefined}
              onClick={navigate({ kind: "settings" })}
            >
              Settings
            </a>
          </nav>
        </aside>

        <main className="shell-workspace" id="workspace" tabIndex={-1}>
          {props.children}
          <p className="activity-line" role="status" aria-live="polite" aria-atomic="true">
            <span>Activity</span>
            {props.announcement}
          </p>
        </main>
      </div>

      <footer>
        <span>Kestrel V1</span>
        <span>Signed in as {props.operatorUsername}</span>
      </footer>
    </>
  );
}
