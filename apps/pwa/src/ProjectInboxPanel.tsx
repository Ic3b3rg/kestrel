import { useId, useState, type SyntheticEvent } from "react";

import {
  OpenPublicGitHubPullRequestCommandSchema,
  type ProjectInbox,
  type PublicGitHubPullRequestUrl,
} from "@kestrel/contracts";

interface ProjectInboxPanelProps {
  error: string | null;
  inbox: ProjectInbox | null;
  loading: boolean;
  online: boolean;
  pending: boolean;
  onOpen: (url: PublicGitHubPullRequestUrl) => void;
  onRetry: () => void;
}

type Project = ProjectInbox["projects"][number];
type ChangeProposal = Project["changeProposals"][number];

const sourceAvailabilityLabels: Record<Project["sourceAvailability"], string> = {
  available: "Available",
  not_acquired: "Not acquired",
  unavailable: "Unavailable",
};

const proposalStateLabels: Record<ChangeProposal["proposalState"], string> = {
  closed: "Closed",
  merged: "Merged",
  open: "Open",
  unknown: "Unknown",
};

function formatObservedAt(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function ProjectFacts({ project }: { project: Project }) {
  return (
    <dl className="project-facts">
      <div>
        <dt>Source</dt>
        <dd>
          <strong>{sourceAvailabilityLabels[project.sourceAvailability]}</strong>
          <span>Base and head SHAs are identified; immutable source acquisition comes next.</span>
        </dd>
      </div>
      <div>
        <dt>Provider observation</dt>
        <dd>
          <strong>Public GitHub pull request</strong>
          <span>Read without a GitHub account or token.</span>
        </dd>
      </div>
      <div>
        <dt>Refresh</dt>
        <dd>
          <strong>Manual only</strong>
          <span>Kestrel contacts GitHub only when you open or refresh this pull request.</span>
        </dd>
      </div>
      <div>
        <dt>Model access</dt>
        <dd>
          <strong>Not configured</strong>
          <span>No model receives repository or pull request data in this slice.</span>
        </dd>
      </div>
    </dl>
  );
}

function ChangeProposalRecord({
  changeProposal,
  disabled,
  onRefresh,
}: {
  changeProposal: ChangeProposal;
  disabled: boolean;
  onRefresh: (url: PublicGitHubPullRequestUrl) => void;
}) {
  return (
    <section className="change-proposal" aria-labelledby={`proposal-${changeProposal.id}`}>
      <div className="proposal-heading">
        <div>
          <p className="proposal-state">{proposalStateLabels[changeProposal.proposalState]}</p>
          <h4 id={`proposal-${changeProposal.id}`}>
            <a href={changeProposal.canonicalUrl}>
              #{changeProposal.number} · {changeProposal.title}
            </a>
          </h4>
        </div>
        <button
          className="secondary-action proposal-refresh"
          type="button"
          disabled={disabled}
          onClick={() => onRefresh(changeProposal.canonicalUrl)}
        >
          Refresh PR #{changeProposal.number}
        </button>
      </div>
      <dl className="commit-pointer-list">
        <div>
          <dt>Base commit</dt>
          <dd>
            <span>{changeProposal.base.ref}</span>
            <code>{changeProposal.base.objectId}</code>
          </dd>
        </div>
        <div>
          <dt>Head commit</dt>
          <dd>
            <span>{changeProposal.head.ref}</span>
            <code>{changeProposal.head.objectId}</code>
          </dd>
        </div>
        <div>
          <dt>Author</dt>
          <dd>{changeProposal.author?.login ?? "Unavailable from GitHub"}</dd>
        </div>
        <div>
          <dt>Observed</dt>
          <dd>
            <time dateTime={changeProposal.observedAt}>
              {formatObservedAt(changeProposal.observedAt)}
            </time>
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function ProjectInboxPanel(props: ProjectInboxPanelProps) {
  const [url, setUrl] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const fieldId = useId();
  const helpId = `${fieldId}-help`;
  const errorId = `${fieldId}-error`;
  const unavailable = !props.online || props.loading || props.pending;

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    const parsed = OpenPublicGitHubPullRequestCommandSchema.safeParse({ url });
    if (!parsed.success) {
      setValidationError(
        "Enter a canonical public pull request URL such as https://github.com/owner/repository/pull/123.",
      );
      return;
    }
    setValidationError(null);
    props.onOpen(parsed.data.url);
  };

  return (
    <section className="projects-section" aria-labelledby="projects-title">
      <div className="section-heading projects-heading">
        <div>
          <p className="section-index">03 / PROJECTS</p>
          <h2 id="projects-title">Public pull requests</h2>
        </div>
        <p className="credential-state">No GitHub credentials</p>
      </div>

      <form className="project-form" onSubmit={handleSubmit} noValidate>
        <div className="form-field">
          <label htmlFor={fieldId}>Public GitHub pull request URL</label>
          <input
            id={fieldId}
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            required
            value={url}
            disabled={!props.online}
            aria-describedby={`${helpId}${validationError ? ` ${errorId}` : ""}`}
            aria-invalid={validationError !== null}
            onChange={(event) => {
              setUrl(event.currentTarget.value);
              setValidationError(null);
            }}
            placeholder="https://github.com/owner/repository/pull/123"
          />
        </div>
        <button type="submit" disabled={unavailable}>
          {props.pending ? "Opening…" : "Open pull request"}
        </button>
        <p id={helpId} className="form-help">
          No GitHub credentials are sent or stored. Only canonical github.com pull request URLs are
          accepted.
        </p>
        {validationError ? (
          <p id={errorId} className="project-form-error" role="alert">
            {validationError}
          </p>
        ) : null}
      </form>

      <p className="rate-limit-note">
        Public access shares GitHub’s limit of 60 unauthenticated GitHub API requests per hour per
        Installation IP. Kestrel does not fall back to credentials.
      </p>

      {props.error ? (
        <div className="project-error" role="alert">
          <p>{props.error}</p>
          <button
            className="secondary-action"
            type="button"
            onClick={props.onRetry}
            disabled={!props.online}
          >
            Retry Project inbox
          </button>
        </div>
      ) : null}

      {!props.online ? (
        <div className="project-empty">
          <h3>Projects hidden while offline</h3>
          <p>Kestrel will refetch the authoritative Project inbox after reconnection.</p>
        </div>
      ) : props.loading ? (
        <div className="project-empty" aria-busy="true">
          <h3>Reading Projects</h3>
          <p>Waiting for the authoritative Project inbox.</p>
        </div>
      ) : props.inbox === null ? null : props.inbox.projects.length === 0 ? (
        <div className="project-empty">
          <h3>No Projects yet</h3>
          <p>Paste a public pull request URL to create the first Project.</p>
        </div>
      ) : (
        <div className="project-list">
          {props.inbox.projects.map((project) => (
            <article className="project-card" key={project.id}>
              <div className="project-identity">
                <div>
                  <p>PUBLIC GITHUB / NO AUTHENTICATION</p>
                  <h3>
                    <a href={project.repository.canonicalUrl}>
                      {project.repository.owner}/{project.repository.name}
                    </a>
                  </h3>
                </div>
                <code>{project.id}</code>
              </div>
              <ProjectFacts project={project} />
              <div className="proposal-list">
                {project.changeProposals.map((changeProposal) => (
                  <ChangeProposalRecord
                    changeProposal={changeProposal}
                    disabled={unavailable}
                    key={changeProposal.id}
                    onRefresh={props.onOpen}
                  />
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
