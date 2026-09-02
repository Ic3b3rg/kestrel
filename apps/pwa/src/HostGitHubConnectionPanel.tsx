import { useCallback, useEffect, useRef, useState } from "react";

import type { HostGitHubConnection, ProjectInbox } from "@kestrel/contracts";

import { fetchHostGitHubConnection } from "./api.js";
import { projectLabel } from "./AuthenticatedShell.js";

type ConnectionReason = NonNullable<HostGitHubConnection["reason"]>;
type Project = ProjectInbox["projects"][number];

const remediation: Record<ConnectionReason, string> = {
  account_drift:
    "Run gh auth switch --hostname github.com, confirm the intended account, then verify again.",
  authentication_required:
    "Run gh auth login --hostname github.com on this workstation, then verify again.",
  cli_not_installed: "Install GitHub CLI with brew install gh, then verify again.",
  cli_version_unsupported: "Upgrade GitHub CLI with brew upgrade gh; Kestrel requires gh 2.40+.",
  project_access_denied:
    "Restore repository access, including organization SSO, for the active account, then verify again.",
  project_not_supported:
    "Attach a local repository with a github.com remote to this Project, then verify again.",
  rate_limited: "Wait for the GitHub API rate limit to reset, then verify again.",
  timed_out: "Confirm this workstation can reach github.com, then verify again.",
  unexpected_response:
    "Run gh auth status --hostname github.com on this workstation, correct the reported problem, then verify again.",
};

export interface HostGitHubConnectionPanelProps {
  loadConnection?: (projectId?: string, signal?: AbortSignal) => Promise<HostGitHubConnection>;
  onAuthenticationError?: (error: unknown) => boolean;
  online: boolean;
  projects: Project[];
}

export function HostGitHubConnectionPanel({
  loadConnection = fetchHostGitHubConnection,
  onAuthenticationError,
  online,
  projects,
}: HostGitHubConnectionPanelProps) {
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.id ?? "");
  const [connection, setConnection] = useState<HostGitHubConnection | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    if (selectedProjectId !== "" && !projects.some(({ id }) => id === selectedProjectId)) {
      setSelectedProjectId(projects[0]?.id ?? "");
    } else if (selectedProjectId === "" && projects[0] !== undefined) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  const verify = useCallback(async () => {
    if (!online) return;
    const controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    setConnection(null);
    setFailed(false);
    setLoading(true);
    try {
      const result = await loadConnection(selectedProjectId || undefined, controller.signal);
      if (active.current === controller && !controller.signal.aborted) setConnection(result);
    } catch (error) {
      if (
        active.current === controller &&
        !controller.signal.aborted &&
        !(onAuthenticationError?.(error) ?? false)
      ) {
        setFailed(true);
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setLoading(false);
      }
    }
  }, [loadConnection, onAuthenticationError, online, selectedProjectId]);

  useEffect(() => {
    if (online) {
      void verify();
    } else {
      active.current?.abort();
      active.current = null;
      setConnection(null);
      setFailed(false);
      setLoading(false);
    }
    return () => active.current?.abort();
  }, [online, verify]);

  const visibleState = !online || failed ? "unavailable" : loading ? "checking" : connection?.state;
  const stateLabel =
    visibleState === "ready"
      ? "Ready"
      : visibleState === "action_required"
        ? "Action required"
        : visibleState === "unavailable"
          ? "Unavailable"
          : "Checking";
  const selectedProject = projects.find(({ id }) => id === selectedProjectId);
  const projectAccess = connection?.projectAccess;
  const projectAccessLabel =
    selectedProjectId === ""
      ? "No Project selected"
      : projectAccess?.state === "verified"
        ? `${projectAccess.repository.owner}/${projectAccess.repository.name}`
        : loading
          ? "Checking selected Project"
          : "Not verified";
  const recovery = !online
    ? "Reconnect this workstation, then verify the host connection again."
    : failed
      ? "Kestrel could not complete the bounded host probe. Verify again."
      : connection?.reason === null || connection?.reason === undefined
        ? null
        : remediation[connection.reason];

  return (
    <section
      className="record-section github-connection"
      aria-busy={loading}
      aria-labelledby="github-connection-title"
    >
      <div className="section-heading">
        <div>
          <p className="section-index">03 / CONNECTIONS</p>
          <h2 id="github-connection-title">GitHub CLI</h2>
        </div>
        <p className={`state-marker connection-${visibleState ?? "checking"}`} role="status">
          <span aria-hidden="true" />
          {stateLabel}
        </p>
      </div>

      <div className="connection-controls">
        <div className="form-field">
          <label htmlFor="github-connection-project">Project access</label>
          <select
            id="github-connection-project"
            value={selectedProjectId}
            disabled={!online || loading}
            onChange={(event) => setSelectedProjectId(event.currentTarget.value)}
          >
            <option value="" disabled={projects.length > 0}>
              {projects.length === 0 ? "No Projects available" : "Select a Project"}
            </option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {projectLabel(project)}
              </option>
            ))}
          </select>
        </div>
        <button
          className="secondary-action"
          type="button"
          disabled={!online || loading}
          onClick={() => void verify()}
        >
          Verify again
        </button>
      </div>

      <dl className="fact-list connection-facts">
        <div>
          <dt>GitHub CLI</dt>
          <dd>
            {connection?.cli === null
              ? "Not detected"
              : connection?.cli.version === undefined
                ? "Checking"
                : `Installed · ${connection.cli.version}`}
          </dd>
        </div>
        {connection?.identity === null || connection?.identity === undefined ? null : (
          <>
            <div>
              <dt>Host</dt>
              <dd>{connection.identity.host}</dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd>{connection.identity.account}</dd>
            </div>
          </>
        )}
        <div className="fact-wide">
          <dt>{selectedProject === undefined ? "Project" : projectLabel(selectedProject)}</dt>
          <dd>{projectAccessLabel}</dd>
        </div>
        {connection === null ? null : (
          <div className="fact-wide">
            <dt>Last verified</dt>
            <dd>
              <time dateTime={connection.checkedAt}>
                {new Date(connection.checkedAt).toLocaleString()}
              </time>
            </dd>
          </div>
        )}
      </dl>

      {recovery === null ? (
        <p className="connection-note">
          Read-only host verification. Credentials remain in GitHub CLI custody.
        </p>
      ) : (
        <p className="connection-remediation">{recovery}</p>
      )}
    </section>
  );
}
