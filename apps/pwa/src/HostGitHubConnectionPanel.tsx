import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { HostGitHubConnection, ProjectInbox } from "@kestrel/contracts";

import { fetchHostGitHubConnection } from "./api.js";
import { Button } from "./components/ui/button.js";

type ConnectionReason = NonNullable<HostGitHubConnection["reason"]>;
type Project = ProjectInbox["projects"][number];
type LoadConnection = typeof fetchHostGitHubConnection;

const globalRemediation: Record<ConnectionReason, string> = {
  account_drift:
    "Run gh auth switch --hostname github.com, confirm the intended account, then verify again.",
  authentication_required:
    "Run gh auth login --hostname github.com on this workstation, then verify again.",
  cli_not_installed: "Install GitHub CLI with brew install gh, then verify again.",
  cli_version_unsupported: "Upgrade GitHub CLI with brew upgrade gh; Kestrel requires gh 2.40+.",
  project_access_denied: "Verify the active GitHub account, then retry from Project settings.",
  project_not_supported: "Attach a supported GitHub repository from Project settings.",
  rate_limited: "Wait for the GitHub API rate limit to reset, then verify again.",
  timed_out: "Confirm this workstation can reach github.com, then verify again.",
  unexpected_response:
    "Run gh auth status --hostname github.com on this workstation, correct the reported problem, then verify again.",
};

const projectRemediation: Record<ConnectionReason, string> = {
  ...globalRemediation,
  account_drift: "Confirm the intended host account in global Source control settings.",
  authentication_required: "Run gh auth login --hostname github.com on this workstation.",
  cli_not_installed: "Install GitHub CLI from global Source control settings, then verify again.",
  cli_version_unsupported:
    "Upgrade GitHub CLI from global Source control settings, then verify again.",
  project_access_denied:
    "Restore repository access, including organization SSO, for the host account, then verify again.",
  project_not_supported:
    "Attach a local repository with a github.com remote to this Project, then verify again.",
};

interface ConnectionProbeProps {
  loadConnection?: LoadConnection;
  onAuthenticationError?: (error: unknown) => boolean;
  online: boolean;
}

function useConnectionProbe({
  loadConnection = fetchHostGitHubConnection,
  onAuthenticationError,
  online,
  projectId,
}: ConnectionProbeProps & { projectId?: string }) {
  const [connection, setConnection] = useState<HostGitHubConnection | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef<AbortController | null>(null);

  const verify = useCallback(async () => {
    if (!online) return;
    const controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    setConnection(null);
    setFailed(false);
    setLoading(true);
    try {
      const result = await loadConnection(projectId, controller.signal);
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
  }, [loadConnection, onAuthenticationError, online, projectId]);

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

  return { connection, failed, loading, verify };
}

function ConnectionSection({
  children,
  heading,
  headingId,
  loading,
  state,
  stateLabel,
  verify,
  verifyDisabled,
}: {
  children: ReactNode;
  heading: string;
  headingId: string;
  loading: boolean;
  state: string;
  stateLabel: string;
  verify: () => Promise<void>;
  verifyDisabled: boolean;
}) {
  return (
    <section
      className="record-section github-connection"
      aria-busy={loading}
      aria-labelledby={headingId}
    >
      <div className="section-heading">
        <div>
          <h2 id={headingId} tabIndex={-1}>
            {heading}
          </h2>
        </div>
        <p className={`state-marker connection-${state}`} role="status">
          <span aria-hidden="true" />
          {stateLabel}
        </p>
      </div>
      {children}
      <Button
        variant="outline"
        className="secondary-action"
        type="button"
        disabled={verifyDisabled}
        onClick={() => void verify()}
      >
        Verify again
      </Button>
    </section>
  );
}

export type HostGitHubConnectionPanelProps = ConnectionProbeProps;

export function HostGitHubConnectionPanel(props: HostGitHubConnectionPanelProps) {
  const { connection, failed, loading, verify } = useConnectionProbe(props);
  const visibleState =
    !props.online || failed ? "unavailable" : loading ? "checking" : connection?.state;
  const stateLabel =
    visibleState === "ready"
      ? "Ready"
      : visibleState === "action_required"
        ? "Action required"
        : visibleState === "unavailable"
          ? "Unavailable"
          : "Checking";
  const cliLabel = !props.online
    ? "Not checked while offline"
    : failed
      ? "Probe unavailable"
      : connection?.cli === null
        ? "Not detected"
        : connection?.cli === undefined
          ? "Checking"
          : `Installed · ${connection.cli.version}`;
  const recovery = !props.online
    ? "Reconnect this workstation, then verify the host connection again."
    : failed
      ? "Kestrel could not complete the bounded host probe. Verify again."
      : connection?.reason === null || connection?.reason === undefined
        ? null
        : globalRemediation[connection.reason];

  return (
    <ConnectionSection
      heading="Source control"
      headingId="github-connection-title"
      loading={loading}
      state={visibleState ?? "checking"}
      stateLabel={stateLabel}
      verify={verify}
      verifyDisabled={!props.online || loading}
    >
      <dl className="fact-list connection-facts">
        <div>
          <dt>GitHub CLI</dt>
          <dd>{cliLabel}</dd>
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
    </ConnectionSection>
  );
}

export interface ProjectGitHubAccessPanelProps extends ConnectionProbeProps {
  project: Project;
}

export function ProjectGitHubAccessPanel({ project, ...props }: ProjectGitHubAccessPanelProps) {
  const { connection, failed, loading, verify } = useConnectionProbe({
    ...props,
    projectId: project.id,
  });
  const verified = connection?.projectAccess?.state === "verified";
  const visibleState =
    !props.online || failed
      ? "unavailable"
      : loading
        ? "checking"
        : verified
          ? "ready"
          : connection?.state === "action_required"
            ? "action_required"
            : "unavailable";
  const stateLabel =
    visibleState === "ready"
      ? "Verified"
      : visibleState === "action_required"
        ? "Action required"
        : visibleState === "unavailable"
          ? "Unavailable"
          : "Checking";
  const repository =
    connection?.projectAccess?.state === "verified"
      ? `${connection.projectAccess.repository.owner}/${connection.projectAccess.repository.name}`
      : project.repository === null
        ? "Repository identity unavailable"
        : `${project.repository.owner}/${project.repository.name}`;
  const recovery = !props.online
    ? "Reconnect this workstation, then verify repository access again."
    : failed
      ? "Kestrel could not complete the repository access probe. Verify again."
      : connection?.reason === null || connection?.reason === undefined
        ? null
        : projectRemediation[connection.reason];

  return (
    <ConnectionSection
      heading="GitHub repository access"
      headingId="github-project-access-title"
      loading={loading}
      state={visibleState}
      stateLabel={stateLabel}
      verify={verify}
      verifyDisabled={!props.online || loading}
    >
      <dl className="fact-list connection-facts">
        <div className="fact-wide">
          <dt>Repository</dt>
          <dd>{repository}</dd>
        </div>
        <div>
          <dt>Access</dt>
          <dd>{verified ? "Read access verified" : loading ? "Checking" : "Not verified"}</dd>
        </div>
        {connection === null ? null : (
          <div>
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
          This verifies only the current repository. Credentials remain in host custody.
        </p>
      ) : (
        <p className="connection-remediation">
          {recovery}{" "}
          <a href="/settings#github-connection-title">Open global Source control settings</a>.
        </p>
      )}
    </ConnectionSection>
  );
}
