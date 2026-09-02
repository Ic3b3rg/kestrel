import { useId, useState, type SyntheticEvent } from "react";

import {
  OpenPublicGitHubPullRequestCommandSchema,
  type ChangeIntentVersionCreated,
  type DirectApiProfile,
  type ProjectInbox,
  type PublicGitHubPullRequestUrl,
  type ReviewRevisionAvailable,
} from "@kestrel/contracts";

import { OpenLocalRepositoryForm } from "./OpenLocalRepositoryForm.js";
import { HostGitHubProjectPanel } from "./HostGitHubProjectPanel.js";
import { AcquireObservedReviewRevisionForm } from "./AcquireObservedReviewRevisionForm.js";
import { ChangeIntentEditor } from "./ChangeIntentEditor.js";
import { ChangeOverviewPanel } from "./ChangeOverviewPanel.js";
import { ShortObjectId } from "./ShortObjectId.js";
import { ReviewPreparationPanel } from "./ReviewPreparationPanel.js";
import { DirectApiProfilePanel } from "./DirectApiProfilePanel.js";

interface ProjectInboxPanelProps {
  error: string | null;
  inbox: ProjectInbox | null;
  loading: boolean;
  online: boolean;
  pending: boolean;
  onAuthenticationError?: (error: unknown) => boolean;
  onLocalAvailable?: (result: ReviewRevisionAvailable) => void;
  onModelProfileChanged?: (projectId: string, profile: DirectApiProfile) => void;
  onIntentCreated?: (result: ChangeIntentVersionCreated) => void;
  onOpen: (url: PublicGitHubPullRequestUrl) => void;
  onHostObserved?: (project: Project) => void;
  onHostRefresh?: (projectId: string, number: number) => void;
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

const modelAccessLabels: Record<Project["modelAccess"], string> = {
  direct_api_available: "Direct API available",
  direct_api_stale: "Direct API stale",
  direct_api_unavailable: "Direct API unavailable",
  not_configured: "Not configured",
};

const reviewRevisionStateLabels = {
  acquiring: "Acquiring",
  available: "Available",
  unavailable: "Unavailable",
} as const;

const revisionFailureDetails: Record<
  NonNullable<ReviewRevisionAvailable["reviewRevision"]["failureReason"]>,
  { action: string; label: string }
> = {
  acquisition_interrupted: {
    action: "Retry this exact revision after Kestrel has recovered.",
    label: "Acquisition was interrupted during restart.",
  },
  artifact_finalization_failed: {
    action: "Retry this exact revision after checking local artifact storage.",
    label: "The retained artifact could not be finalized.",
  },
  base_revision_unresolvable: {
    action: "Retry if the captured object becomes available, or refresh the pull request.",
    label: "The captured base revision is no longer resolvable.",
  },
  head_revision_unresolvable: {
    action: "Retry if the captured object becomes available, or refresh the pull request.",
    label: "The captured head revision is no longer resolvable.",
  },
  object_missing: {
    action: "Retry after restoring access to the required committed object.",
    label: "A required committed object is missing.",
  },
  object_verification_failed: {
    action: "Inspect the source integrity before retrying this exact revision.",
    label: "A committed object could not be verified.",
  },
  provider_authentication_required: {
    action: "Restore host Git authentication or SSO access, then retry this exact revision.",
    label: "Host Git authentication is required for this repository.",
  },
  provider_resource_unavailable: {
    action: "Confirm repository access or availability, then retry this exact revision.",
    label: "The provider resource is unavailable or inaccessible.",
  },
  pull_ref_mismatch: {
    action: "Refresh the pull request to observe its current exact head.",
    label: "The pull request moved and its captured head could not be recovered.",
  },
  reference_not_available: {
    action: "Open the local repository again to select committed references.",
    label: "A selected reference is no longer available.",
  },
  revision_limit_exceeded: {
    action: "Adjust the configured revision limits before retrying.",
    label: "The configured revision size or object limit was exceeded.",
  },
  source_containment_violation: {
    action: "Correct the local-source safety condition before retrying.",
    label: "The local source failed safety validation.",
  },
  source_not_available: {
    action: "Reattach the matching Local Repository Source before retrying.",
    label: "The local source is unavailable.",
  },
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
          <strong>
            {provider === null
              ? "Not observed"
              : provider.kind === "host_gh"
                ? "GitHub through host session"
                : "Public GitHub pull request"}
          </strong>
          <span>
            {provider === null
              ? "No Provider observation is attached."
              : provider.kind === "host_gh"
                ? `Observed as ${provider.account} on ${provider.host}; Kestrel stores no token.`
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
              : "Refresh is Manual only; provider metadata alone never authorizes source."}
          </span>
        </dd>
      </div>
      <div>
        <dt>Model access</dt>
        <dd>
          <strong>{modelAccessLabels[project.modelAccess]}</strong>
          <span>
            {project.modelAccess === "not_configured"
              ? "No model route is available."
              : "The Project profile remains independent of source acquisition and Review readiness."}
          </span>
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
  const failure =
    revision.failureReason === null ? null : revisionFailureDetails[revision.failureReason];
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
      {failure === null ? null : (
        <div>
          <dt>Failure</dt>
          <dd>
            <strong>{failure.label}</strong>
            <span>{failure.action}</span>
          </dd>
        </div>
      )}
    </>
  );
}

function ChangeProposalRecord({
  canAcquire,
  changeProposal,
  disabled,
  onAuthenticationError,
  onAvailable,
  onIntentCreated,
  onRefresh,
  projectId,
}: {
  canAcquire: boolean;
  changeProposal: ChangeProposal;
  disabled: boolean;
  onAuthenticationError?: (error: unknown) => boolean;
  onAvailable: (result: ReviewRevisionAvailable) => void;
  onIntentCreated: (result: ChangeIntentVersionCreated) => void;
  onRefresh: () => void;
  projectId: string;
}) {
  const revision = changeProposal.reviewRevisions[0];
  const changeOverview = changeProposal.changeOverview ?? {
    exactHeadObjectId: changeProposal.head.objectId,
    state: "awaiting_source" as const,
  };
  const changeOverviewHeadingId = `change-overview-${changeProposal.id}`;
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
        <ChangeOverviewPanel headingId={changeOverviewHeadingId} overview={changeOverview} />
        <ChangeIntentEditor
          key={`${changeProposal.id}:${String(changeProposal.version)}`}
          disabled={disabled}
          projectId={projectId}
          proposal={changeProposal}
          {...(onAuthenticationError === undefined ? {} : { onAuthenticationError })}
          onCreated={onIntentCreated}
        />
        <ReviewPreparationPanel
          key={`${changeProposal.id}:${String(changeProposal.version)}:${String(changeProposal.changeIntent.version)}:${revision?.id ?? "none"}:${revision?.state ?? "none"}`}
          disabled={disabled}
          projectId={projectId}
          proposalId={changeProposal.id}
          {...(onAuthenticationError === undefined ? {} : { onAuthenticationError })}
        />
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
          onClick={onRefresh}
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
      <ChangeOverviewPanel headingId={changeOverviewHeadingId} overview={changeOverview} />
      <ChangeIntentEditor
        key={`${changeProposal.id}:${String(changeProposal.version)}`}
        disabled={disabled}
        projectId={projectId}
        proposal={changeProposal}
        {...(onAuthenticationError === undefined ? {} : { onAuthenticationError })}
        onCreated={onIntentCreated}
      />
      {canAcquire ? (
        <AcquireObservedReviewRevisionForm
          key={`${changeProposal.id}:${String(changeProposal.changeIntent?.version ?? 0)}:${revision?.id ?? "none"}:${revision?.state ?? "none"}`}
          disabled={disabled}
          projectId={projectId}
          proposal={changeProposal}
          {...(onAuthenticationError === undefined ? {} : { onAuthenticationError })}
          onAvailable={onAvailable}
        />
      ) : null}
      <ReviewPreparationPanel
        key={`${changeProposal.id}:${String(changeProposal.version)}:${String(changeProposal.changeIntent?.version ?? 0)}:${revision?.id ?? "none"}:${revision?.state ?? "none"}`}
        disabled={disabled}
        projectId={projectId}
        proposalId={changeProposal.id}
        {...(onAuthenticationError === undefined ? {} : { onAuthenticationError })}
      />
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
        <p className="credential-state">Credentials stay with host Git</p>
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
          GitHub metadata does not by itself authorize or acquire review source. No GitHub
          credentials are sent or stored, and only canonical github.com pull request URLs are
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
                      <p>
                        {project.providerObservation?.kind === "host_gh"
                          ? "GITHUB / HOST SESSION"
                          : "PUBLIC GITHUB / NO AUTHENTICATION"}
                      </p>
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
              <DirectApiProfilePanel
                disabled={unavailable}
                projectId={project.id}
                {...(props.onAuthenticationError === undefined
                  ? {}
                  : { onAuthenticationError: props.onAuthenticationError })}
                onChanged={(profile) => props.onModelProfileChanged?.(project.id, profile)}
              />
              {project.localRepositorySource?.state === "attached" ? (
                <HostGitHubProjectPanel
                  key={project.id}
                  projectId={project.id}
                  disabled={unavailable}
                  online={props.online}
                  {...(props.onAuthenticationError === undefined
                    ? {}
                    : { onAuthenticationError: props.onAuthenticationError })}
                  onObserved={(observed) => props.onHostObserved?.(observed)}
                />
              ) : null}
              <div className="proposal-list">
                {project.changeProposals.map((changeProposal) => (
                  <ChangeProposalRecord
                    canAcquire={project.localRepositorySource?.state === "attached"}
                    changeProposal={changeProposal}
                    disabled={unavailable}
                    key={changeProposal.id}
                    projectId={project.id}
                    {...(props.onAuthenticationError === undefined
                      ? {}
                      : { onAuthenticationError: props.onAuthenticationError })}
                    onAvailable={(result) => props.onLocalAvailable?.(result)}
                    onIntentCreated={(result) => props.onIntentCreated?.(result)}
                    onRefresh={() => {
                      if (
                        project.providerObservation?.kind === "host_gh" &&
                        isProviderChangeProposal(changeProposal)
                      ) {
                        props.onHostRefresh?.(project.id, changeProposal.number);
                        return;
                      }
                      if (isProviderChangeProposal(changeProposal)) {
                        props.onOpen(changeProposal.canonicalUrl);
                      }
                    }}
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
