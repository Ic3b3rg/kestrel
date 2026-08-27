import { useId, useState, type SyntheticEvent } from "react";

import {
  OpenPublicGitHubPullRequestCommandSchema,
  type ProjectInbox,
  type PublicGitHubPullRequestUrl,
  type ReviewRevisionAvailable,
} from "@kestrel/contracts";

import { OpenLocalRepositoryForm } from "./OpenLocalRepositoryForm.js";

interface ProjectInboxPanelProps {
  error: string | null;
  inbox: ProjectInbox | null;
  loading: boolean;
  online: boolean;
  pending: boolean;
  onAuthenticationError?: (error: unknown) => boolean;
  onLocalAvailable?: (result: ReviewRevisionAvailable) => void;
  onOpen: (url: PublicGitHubPullRequestUrl) => void;
  onRetry: () => void;
}

type Project = ProjectInbox["projects"][number];
type ChangeProposal = Project["changeProposals"][number];
type ProviderChangeProposal = Extract<ChangeProposal, { providerId: string }>;

const sourceAvailabilityLabels: Record<Project["sourceAvailability"], string> = {
  available: "Available",
  not_acquired: "Not acquired",
  unavailable: "Unavailable",
};

const reviewRevisionStateLabels = {
  acquiring: "Acquiring",
  available: "Available",
  unavailable: "Unavailable",
} as const;

const revisionFailureLabels: Record<
  NonNullable<ReviewRevisionAvailable["reviewRevision"]["failureReason"]>,
  string
> = {
  acquisition_interrupted: "Acquisition was interrupted during restart.",
  artifact_finalization_failed: "The retained artifact could not be finalized.",
  object_missing: "A required committed object is missing.",
  object_verification_failed: "A committed object could not be verified.",
  reference_not_available: "A selected reference is no longer available.",
  revision_limit_exceeded: "The configured revision size or object limit was exceeded.",
  source_containment_violation: "The local source failed safety validation.",
  source_not_available: "The local source is unavailable.",
};

const proposalStateLabels: Record<ProviderChangeProposal["proposalState"], string> = {
  closed: "Closed",
  merged: "Merged",
  open: "Open",
  unknown: "Unknown",
};

function isProviderChangeProposal(
  changeProposal: ChangeProposal,
): changeProposal is ProviderChangeProposal {
  return "providerId" in changeProposal;
}

function formatObservedAt(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function ShortObjectId({ label, value }: { label: string; value: string }) {
  return (
    <code title={value} aria-label={`${label} object ID ${value}`}>
      {value.slice(0, 12)}
    </code>
  );
}

function ProjectFacts({ project }: { project: Project }) {
  const source = project.localRepositorySource;
  const provider = project.providerObservation;
  return (
    <dl className="project-facts">
      <div>
        <dt>Local Repository Source</dt>
        <dd>
          <strong>
            {source === null
              ? "Not attached"
              : source.state === "attached"
                ? "Attached"
                : "Detached"}
          </strong>
          <span>{source?.displayName ?? "No local repository supplies source yet."}</span>
        </dd>
      </div>
      <div>
        <dt>Provider metadata</dt>
        <dd>
          <strong>{provider === null ? "Not observed" : "Public GitHub pull request"}</strong>
          <span>
            {provider === null
              ? "No Provider observation is attached."
              : "Provider observation is read without a GitHub account or token."}
          </span>
        </dd>
      </div>
      <div>
        <dt>Source availability</dt>
        <dd>
          <strong>{sourceAvailabilityLabels[project.sourceAvailability]}</strong>
          <span>
            {provider === null
              ? "Exact retained base and head commits are independent of repository attachment."
              : "Refresh is Manual only; provider metadata never supplies source."}
          </span>
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

function RevisionFacts({
  revision,
}: {
  revision: ReviewRevisionAvailable["reviewRevision"] | undefined;
}) {
  if (revision === undefined) {
    return (
      <div>
        <dt>Revision State</dt>
        <dd>Not acquired</dd>
      </div>
    );
  }
  const pointerLabel = revision.state === "available" ? "Retained" : "Revision";
  return (
    <>
      <div>
        <dt>Revision State</dt>
        <dd>{reviewRevisionStateLabels[revision.state]}</dd>
      </div>
      <div>
        <dt>{pointerLabel} base</dt>
        <dd>
          <span>{revision.base.ref}</span>
          <ShortObjectId label={`${pointerLabel} base`} value={revision.base.objectId} />
        </dd>
      </div>
      <div>
        <dt>{pointerLabel} head</dt>
        <dd>
          <span>{revision.head.ref}</span>
          <ShortObjectId label={`${pointerLabel} head`} value={revision.head.objectId} />
        </dd>
      </div>
      {revision.failureReason === null ? null : (
        <div>
          <dt>Failure</dt>
          <dd>
            <strong>{revisionFailureLabels[revision.failureReason]}</strong>
            <span>Open the local repository again to retry this exact revision.</span>
          </dd>
        </div>
      )}
    </>
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
  const revision = changeProposal.reviewRevisions[0];
  if (!isProviderChangeProposal(changeProposal)) {
    return (
      <section className="change-proposal" aria-labelledby={`proposal-${changeProposal.id}`}>
        <div className="proposal-heading">
          <div>
            <p className="proposal-state">Local change proposal</p>
            <h4 id={`proposal-${changeProposal.id}`}>{changeProposal.title}</h4>
          </div>
        </div>
        <dl className="commit-pointer-list">
          <div>
            <dt>Base commit</dt>
            <dd>
              <span>{changeProposal.base.ref}</span>
              <ShortObjectId label="Base commit" value={changeProposal.base.objectId} />
            </dd>
          </div>
          <div>
            <dt>Head commit</dt>
            <dd>
              <span>{changeProposal.head.ref}</span>
              <ShortObjectId label="Head commit" value={changeProposal.head.objectId} />
            </dd>
          </div>
          <div>
            <dt>Change Intent v{changeProposal.changeIntent.version}</dt>
            <dd>{changeProposal.changeIntent.text}</dd>
          </div>
          <RevisionFacts revision={revision} />
        </dl>
      </section>
    );
  }

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
          <dt>Observed base</dt>
          <dd>
            <span>{changeProposal.base.ref}</span>
            <ShortObjectId label="Observed base" value={changeProposal.base.objectId} />
          </dd>
        </div>
        <div>
          <dt>Observed head</dt>
          <dd>
            <span>{changeProposal.head.ref}</span>
            <ShortObjectId label="Observed head" value={changeProposal.head.objectId} />
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
        <div>
          <dt>
            Change Intent
            {changeProposal.changeIntent === null
              ? null
              : ` v${String(changeProposal.changeIntent.version)}`}
          </dt>
          <dd>{changeProposal.changeIntent?.text ?? "Not confirmed"}</dd>
        </div>
        <RevisionFacts revision={revision} />
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
  const unavailable = !props.online || props.pending || (props.loading && props.inbox === null);

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
          <h2 id="projects-title">Projects</h2>
        </div>
        <p className="credential-state">No GitHub credentials</p>
      </div>

      <OpenLocalRepositoryForm
        disabled={unavailable}
        projects={props.inbox?.projects ?? []}
        {...(props.onAuthenticationError === undefined
          ? {}
          : { onAuthenticationError: props.onAuthenticationError })}
        onAvailable={(result) => props.onLocalAvailable?.(result)}
      />

      <form className="project-form" onSubmit={handleSubmit} noValidate>
        <div className="form-field">
          <label htmlFor={fieldId}>Optional public GitHub pull request URL</label>
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
          {props.pending ? "Adding context…" : "Add provider context"}
        </button>
        <p id={helpId} className="form-help">
          Optional metadata only: GitHub never supplies review source. No GitHub credentials are
          sent or stored, and only canonical github.com pull request URLs are accepted.
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
          <p>Open an authorized local repository to create the first Project.</p>
        </div>
      ) : (
        <div className="project-list">
          {props.inbox.projects.map((project) => (
            <article className="project-card" key={project.id}>
              <div className="project-identity">
                <div>
                  {project.repository === null ? (
                    <>
                      <p>LOCAL REPOSITORY SOURCE</p>
                      <h3>{project.localRepositorySource?.displayName ?? "Local Project"}</h3>
                    </>
                  ) : (
                    <>
                      <p>PUBLIC GITHUB / NO AUTHENTICATION</p>
                      <h3>
                        <a href={project.repository.canonicalUrl}>
                          {project.repository.owner}/{project.repository.name}
                        </a>
                      </h3>
                    </>
                  )}
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
