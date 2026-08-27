import { useEffect, useState } from "react";

import type { HostGitHubProjectInbox, ProjectUpserted } from "@kestrel/contracts";
import { fetchHostGitHubProjectInbox, observeHostGitHubPullRequest } from "./api.js";

export function HostGitHubProjectPanel({
  projectId,
  disabled,
  onObserved,
}: {
  projectId: string;
  disabled: boolean;
  onObserved: (project: ProjectUpserted["project"]) => void;
}) {
  const [inbox, setInbox] = useState<HostGitHubProjectInbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const load = (refresh: boolean) => {
    const controller = new AbortController();
    setPending(true);
    setError(null);
    void fetchHostGitHubProjectInbox(projectId, refresh, controller.signal)
      .then(setInbox, () => setError("Host GitHub observation is unavailable."))
      .finally(() => setPending(false));
    return controller;
  };
  useEffect(() => {
    const controller = load(false);
    return () => controller.abort();
  }, [projectId]);
  return (
    <section className="host-github-panel" aria-label="Host GitHub pull request inbox">
      <div className="section-heading">
        <div>
          <p>HOST GITHUB CLI</p>
          <h4>Pull request inbox</h4>
        </div>
        <button
          type="button"
          className="secondary-action"
          disabled={disabled || pending}
          onClick={() => load(true)}
        >
          Refresh
        </button>
      </div>
      {inbox === null ? (
        <p>{pending ? "Checking the host GitHub session…" : (error ?? "No observation yet.")}</p>
      ) : (
        <>
          <p>
            <strong>
              {inbox.status.account}@{inbox.status.host}
            </strong>{" "}
            · gh {inbox.status.executableVersion} · Authenticated
          </p>
          <p>
            Route: host session. Manual refresh only; metadata never supplies source or starts
            Review.
          </p>
          <ul>
            {inbox.pullRequests.map((pull) => (
              <li key={pull.number}>
                <span>
                  <strong>
                    {pull.group === "review_requested"
                      ? "Review requested"
                      : pull.group === "authored"
                        ? "Authored"
                        : "Other"}
                  </strong>{" "}
                  · #{pull.number} {pull.title}
                </span>{" "}
                <button
                  type="button"
                  disabled={disabled || pending}
                  onClick={() => {
                    setPending(true);
                    void observeHostGitHubPullRequest(projectId, { number: pull.number })
                      .then(
                        (result) => onObserved(result.project),
                        () => setError("The pull request could not be observed."),
                      )
                      .finally(() => setPending(false));
                  }}
                >
                  Select
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
