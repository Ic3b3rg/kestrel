import { useCallback, useEffect, useRef, useState } from "react";

import type {
  HostGitHubProjectInbox,
  HostGitHubPullRequestGroupState,
  HostGitHubPullRequestSummary,
  ProjectUpserted,
} from "@kestrel/contracts";

import { fetchHostGitHubProjectInbox, observeHostGitHubPullRequest } from "./api.js";

type Group = HostGitHubPullRequestSummary["group"];
type GroupFailureReason = NonNullable<HostGitHubPullRequestGroupState["failureReason"]>;

const groups = ["review_requested", "authored", "other"] as const;
const groupLabels: Record<Group, string> = {
  review_requested: "Review requested",
  authored: "Authored",
  other: "Others",
};
const groupFailureMessages: Record<GroupFailureReason, string> = {
  authentication_required: "Authentication required. Verify the host GitHub Connection.",
  project_access_denied: "The host account cannot read this Project repository.",
  rate_limited: "GitHub rate limit reached. Wait for the reset, then refresh.",
  timed_out: "GitHub did not answer within the bounded time. Refresh to retry.",
  unexpected_response: "GitHub returned an unavailable or invalid result. Refresh to retry.",
};

export interface HostGitHubProjectPanelProps {
  projectId: string;
  disabled: boolean;
  online: boolean;
  onAuthenticationError?: (error: unknown) => boolean;
  onObserved: (project: ProjectUpserted["project"]) => void;
  loadInbox?: typeof fetchHostGitHubProjectInbox;
  observePullRequest?: typeof observeHostGitHubPullRequest;
}

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function PullRequestGroup({
  disabled,
  group,
  groupState,
  loadFailed,
  loading,
  online,
  onSelect,
  projectId,
  pullRequests,
  selectingNumber,
}: {
  disabled: boolean;
  group: Group;
  groupState: HostGitHubPullRequestGroupState | null;
  loadFailed: boolean;
  loading: boolean;
  online: boolean;
  onSelect: (number: number) => void;
  projectId: string;
  pullRequests: HostGitHubPullRequestSummary[];
  selectingNumber: number | null;
}) {
  const label = groupLabels[group];
  const headingId = `host-github-${projectId}-${group}`;
  const unavailableMessage =
    groupState?.failureReason === null || groupState?.failureReason === undefined
      ? null
      : groupFailureMessages[groupState.failureReason];

  return (
    <section
      className="host-github-group"
      aria-busy={loading || undefined}
      aria-labelledby={headingId}
    >
      <div className="host-github-group-heading">
        <h5 id={headingId}>{label}</h5>
        {groupState?.state === "available" ? <span>{pullRequests.length}</span> : null}
      </div>
      {!online ? (
        <p className="host-github-group-state" role="status">
          Reconnect this workstation to load {label}.
        </p>
      ) : loadFailed ? (
        <p className="host-github-group-error" role="alert">
          This group could not be loaded. Refresh to retry.
        </p>
      ) : groupState === null ? (
        <p className="host-github-group-state" role="status">
          Loading {label}…
        </p>
      ) : groupState.state === "unavailable" ? (
        <p className="host-github-group-error" role="alert">
          {unavailableMessage}
        </p>
      ) : pullRequests.length === 0 ? (
        <p className="host-github-group-empty" role="status">
          No open pull requests in this group.
        </p>
      ) : (
        <ul className="host-github-pull-requests">
          {pullRequests.map((pullRequest) => (
            <li key={pullRequest.number}>
              <div>
                <p>#{pullRequest.number}</p>
                <h6>{pullRequest.title}</h6>
                <span>
                  {pullRequest.author === null ? "Author unavailable" : `By ${pullRequest.author}`}{" "}
                  · Updated {formatUpdatedAt(pullRequest.updatedAt)}
                </span>
              </div>
              <button
                type="button"
                className="secondary-action"
                disabled={disabled}
                onClick={() => onSelect(pullRequest.number)}
              >
                {selectingNumber === pullRequest.number
                  ? `Selecting PR #${String(pullRequest.number)}…`
                  : `Select PR #${String(pullRequest.number)}`}
              </button>
            </li>
          ))}
        </ul>
      )}
      {loading && groupState !== null ? (
        <p className="host-github-group-refresh" role="status">
          Refreshing {label}…
        </p>
      ) : null}
    </section>
  );
}

export function HostGitHubProjectPanel({
  projectId,
  disabled,
  online,
  onAuthenticationError,
  onObserved,
  loadInbox = fetchHostGitHubProjectInbox,
  observePullRequest = observeHostGitHubPullRequest,
}: HostGitHubProjectPanelProps) {
  const [inbox, setInbox] = useState<HostGitHubProjectInbox | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selectingNumber, setSelectingNumber] = useState<number | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const selectionController = useRef<AbortController | null>(null);
  const loadInboxRef = useRef(loadInbox);
  const authenticationErrorRef = useRef(onAuthenticationError);
  loadInboxRef.current = loadInbox;
  authenticationErrorRef.current = onAuthenticationError;

  const load = useCallback(
    (refresh: boolean) => {
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      setLoading(true);
      setLoadError(false);
      void loadInboxRef
        .current(projectId, refresh, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setInbox(result);
        })
        .catch((error: unknown) => {
          if (
            !controller.signal.aborted &&
            (authenticationErrorRef.current === undefined || !authenticationErrorRef.current(error))
          ) {
            setLoadError(true);
          }
        })
        .finally(() => {
          if (loadController.current === controller) {
            loadController.current = null;
            setLoading(false);
          }
        });
      return controller;
    },
    [projectId],
  );

  useEffect(() => {
    setInbox(null);
    setLoadError(false);
    setSelectionError(null);
    selectionController.current?.abort();
    setSelectingNumber(null);
    if (!online) {
      loadController.current?.abort();
      setLoading(false);
      return;
    }
    const controller = load(false);
    return () => controller.abort();
  }, [load, online, projectId]);

  useEffect(
    () => () => {
      loadController.current?.abort();
      selectionController.current?.abort();
    },
    [],
  );

  const select = (number: number) => {
    const controller = new AbortController();
    selectionController.current = controller;
    setSelectingNumber(number);
    setSelectionError(null);
    void observePullRequest(projectId, { number }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) onObserved(result.project);
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          (onAuthenticationError === undefined || !onAuthenticationError(error))
        ) {
          setSelectionError("The pull request could not be observed. Refresh the inbox and retry.");
        }
      })
      .finally(() => {
        if (selectionController.current === controller) {
          selectionController.current = null;
          setSelectingNumber(null);
        }
      });
  };

  const interactionDisabled = disabled || loading || selectingNumber !== null;
  const headingId = `host-github-inbox-${projectId}`;

  return (
    <section className="host-github-panel" aria-labelledby={headingId}>
      <div className="section-heading host-github-heading">
        <div>
          <p>HOST GITHUB CLI</p>
          <h4 id={headingId}>Pull request inbox</h4>
        </div>
        <button
          type="button"
          className="secondary-action"
          disabled={!online || interactionDisabled}
          onClick={() => load(true)}
        >
          {loading && inbox !== null ? "Refreshing…" : "Refresh pull requests"}
        </button>
      </div>

      {inbox?.status.account === null || inbox === null ? null : (
        <p className="host-github-identity">
          <strong>
            {inbox.status.account}@{inbox.status.host}
          </strong>
          <span>gh {inbox.status.executableVersion ?? "unavailable"}</span>
        </p>
      )}
      {inbox?.status.authentication === "needs_authentication" ? (
        <p className="host-github-session-error" role="alert">
          <strong>Authentication required.</strong> Run{" "}
          <code>gh auth login --hostname github.com</code>, then refresh.
        </p>
      ) : inbox?.status.authentication === "access_denied" ? (
        <p className="host-github-session-error" role="alert">
          <strong>Project access required.</strong> Restore access for the selected repository, then
          refresh.
        </p>
      ) : null}
      <p className="host-github-boundary">
        Host session, manual refresh only. Provider metadata never supplies source or starts Review.
      </p>

      {selectionError === null ? null : (
        <p className="host-github-session-error" role="alert">
          {selectionError}
        </p>
      )}

      <div className="host-github-groups">
        {groups.map((group) => {
          const groupState =
            inbox?.groupStates.find((candidate) => candidate.group === group) ?? null;
          const pullRequests =
            inbox?.pullRequests.filter((pullRequest) => pullRequest.group === group) ?? [];
          return (
            <PullRequestGroup
              disabled={interactionDisabled}
              group={group}
              groupState={groupState}
              key={group}
              loadFailed={loadError}
              loading={loading}
              online={online}
              onSelect={select}
              projectId={projectId}
              pullRequests={pullRequests}
              selectingNumber={selectingNumber}
            />
          );
        })}
      </div>
    </section>
  );
}
