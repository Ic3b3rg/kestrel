import { Button } from "./components/ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

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
  onObserved: (project: ProjectUpserted["project"], number: number) => void;
  projectLabel?: string;
  projectActions?: ReactNode;
  loadInbox?: typeof fetchHostGitHubProjectInbox;
  observePullRequest?: typeof observeHostGitHubPullRequest;
}

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function HostGitHubProjectPanel({
  projectId,
  projectLabel,
  projectActions,
  disabled,
  online,
  onAuthenticationError,
  onObserved,
  loadInbox = fetchHostGitHubProjectInbox,
  observePullRequest = observeHostGitHubPullRequest,
}: HostGitHubProjectPanelProps) {
  const [filter, setFilter] = useState<"all" | "review_requested" | "authored">("all");
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
    setFilter("all");
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
        if (!controller.signal.aborted) onObserved(result.project, number);
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

  const interactionDisabled = disabled || !online || loading || selectingNumber !== null;
  const headingId = `host-github-inbox-${projectId}`;
  const account = inbox?.status.authentication === "authenticated" ? inbox.status.account : null;
  const rows = (selected: typeof filter) =>
    (inbox?.pullRequests ?? []).filter(
      (pr) =>
        selected === "all" ||
        (selected === "review_requested"
          ? pr.group === selected
          : account !== null && pr.author?.toLowerCase() === account.toLowerCase()),
    );
  const complete = (selected: typeof filter) =>
    inbox !== null &&
    !loadError &&
    online &&
    (selected !== "authored" || account !== null) &&
    groups
      .filter(
        (group) =>
          selected === "all" ||
          group === "review_requested" ||
          (selected === "authored" && group === "authored"),
      )
      .every(
        (group) => inbox.groupStates.find((state) => state.group === group)?.state === "available",
      );
  const failures = inbox?.groupStates.filter((state) => state.state === "unavailable") ?? [];
  const pullRequests = online && !loadError ? rows(filter) : [];
  const stateLabel = !online
    ? "Offline"
    : loading
      ? "Loading pull requests…"
      : loadError || inbox === null
        ? "Inbox unavailable"
        : complete("all")
          ? "Inbox loaded"
          : failures.length === groups.length
            ? "Inbox unavailable"
            : "Partial inbox";

  return (
    <section className="host-github-panel" aria-labelledby={headingId}>
      <header className="project-workspace-header">
        <div>
          {projectLabel === undefined ? (
            <h2 id={headingId}>Pull request inbox</h2>
          ) : (
            <>
              <h1>{projectLabel}</h1>
              <h2 className="visually-hidden" id={headingId}>
                Pull request inbox
              </h2>
            </>
          )}
          <p className="host-github-identity" role="status">
            <strong>GitHub · {stateLabel}</strong>
            {account !== null && !loadError && online ? (
              <span>
                {account}@{inbox?.status.host}
              </span>
            ) : null}
          </p>
        </div>
        <div className="project-header-actions">
          <Button
            variant="outline"
            type="button"
            className="secondary-action"
            disabled={interactionDisabled}
            onClick={() => load(true)}
          >
            {loading && inbox !== null ? "Refreshing…" : "Refresh pull requests"}
          </Button>
          {projectActions}
        </div>
      </header>
      {inbox?.status.authentication === "needs_authentication" ? (
        <p className="host-github-session-error" role="alert">
          <strong>Authentication required.</strong> Run{" "}
          <code>gh auth login --hostname github.com</code>, then refresh.{" "}
          <a href={`/settings?projectId=${projectId}`}>Open Connections</a>
        </p>
      ) : inbox?.status.authentication === "access_denied" ? (
        <p className="host-github-session-error" role="alert">
          <strong>Project access required.</strong> Restore access for the selected repository, then
          refresh. <a href={`/settings?projectId=${projectId}`}>Open Connections</a>
        </p>
      ) : null}
      {!online ? (
        <p role="status">Reconnect this workstation to load pull requests.</p>
      ) : loadError ? (
        <p className="host-github-session-error" role="alert">
          The inbox could not be loaded. Refresh to retry.
        </p>
      ) : (
        failures.map((state) => (
          <p className="host-github-session-error" role="alert" key={state.group}>
            <strong>{groupLabels[state.group]} unavailable.</strong>{" "}
            {state.failureReason === null
              ? "Refresh to retry."
              : groupFailureMessages[state.failureReason]}
          </p>
        ))
      )}
      {selectionError === null ? null : (
        <p className="host-github-session-error" role="alert">
          {selectionError}
        </p>
      )}
      <Tabs
        value={filter}
        onValueChange={(value) => {
          if (value === "all" || value === "review_requested" || value === "authored")
            setFilter(value);
        }}
      >
        <TabsList className="pr-filters" aria-label="Pull request filters">
          {(["all", "review_requested", "authored"] as const).map((choice) => {
            const count = rows(choice).length;
            const countLabel = loading
              ? "…"
              : complete(choice)
                ? String(count)
                : count > 0 && online && !loadError
                  ? `${String(count)}+`
                  : "Unavailable";
            return (
              <TabsTrigger value={choice} key={choice} onClick={() => setFilter(choice)}>
                {choice === "all" ? "All" : groupLabels[choice]} <span>{countLabel}</span>
              </TabsTrigger>
            );
          })}
        </TabsList>
        <TabsContent value={filter} className="pr-table-container" aria-busy={loading}>
          <table className="pr-table">
            <caption className="visually-hidden">
              {filter === "all" ? "All" : groupLabels[filter]} fetched pull requests
            </caption>
            <thead>
              <tr>
                <th scope="col">Pull request</th>
                <th scope="col">Author</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {pullRequests.map((pr) => (
                <tr key={pr.number}>
                  <td>
                    <Button
                      type="button"
                      variant="ghost"
                      className="pr-selection h-auto min-h-14 w-full justify-start whitespace-normal p-3 text-left"
                      disabled={interactionDisabled}
                      aria-label={`Select PR #${String(pr.number)}: ${pr.title}`}
                      onClick={() => select(pr.number)}
                    >
                      <span className="pr-number">#{pr.number}</span>
                      <strong>{pr.title}</strong>
                      {selectingNumber === pr.number ? <span>Opening…</span> : null}
                    </Button>
                  </td>
                  <td>{pr.author ?? "Unavailable"}</td>
                  <td>
                    <time dateTime={pr.updatedAt}>{formatUpdatedAt(pr.updatedAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pullRequests.length > 0 ? null : (
            <p className="pr-table-state" role="status">
              {loading
                ? "Loading pull requests…"
                : complete(filter)
                  ? "No open pull requests in this fetched list."
                  : "Pull requests unavailable for this filter. Refresh to retry."}
            </p>
          )}
        </TabsContent>
      </Tabs>
      <details className="inbox-limitations">
        <summary>About this fetched list</summary>
        <p>
          This bounded list may not include every open pull request in the repository. Refresh is
          manual.
        </p>
        <p>
          Selecting a PR reads its provider context. Retaining source and starting Review require
          explicit actions.
        </p>
        {inbox?.limitations.map((limitation) => (
          <p key={limitation}>{limitation}</p>
        ))}
      </details>
    </section>
  );
}
