import { Button } from "./components/ui/button.js";
import { useEffect, useRef } from "react";

import {
  type ChangeIntentVersionCreated,
  type ProjectInbox,
  type ProjectUpserted,
  type PublicGitHubPullRequestUrl,
  type ReviewRevisionAvailable,
} from "@kestrel/contracts";

import { ProjectActions } from "./ProjectActions.js";
import { projectLabel } from "./AuthenticatedShell.js";
import { OpenProjectForm } from "./OpenProjectForm.js";
import { HostGitHubProjectPanel } from "./HostGitHubProjectPanel.js";
import { AcquireObservedReviewRevisionForm } from "./AcquireObservedReviewRevisionForm.js";
import { ChangeIntentEditor } from "./ChangeIntentEditor.js";
import { ChangeOverviewPanel } from "./ChangeOverviewPanel.js";
import { ExternalChangeIntentPanel } from "./ExternalChangeIntentPanel.js";
import { ExternalPullRequestReviewPanel } from "./ExternalPullRequestReviewPanel.js";
import { ShortObjectId } from "./ShortObjectId.js";
import { ReviewPreparationPanel } from "./ReviewPreparationPanel.js";
import { currentReviewRevision } from "./current-review-revision.js";
import { useProjectConnections } from "./use-project-connections.js";

interface ProjectInboxPanelProps {
  selectedProposalId?: string;
  selectedRevisionId?: string;
  onSelectProposal?: (proposalId: string | null) => void;
  error: string | null;
  inbox: ProjectInbox | null;
  loading: boolean;
  online: boolean;
  pending: boolean;
  onAuthenticationError?: (error: unknown) => boolean;
  onLocalAvailable?: (result: ReviewRevisionAvailable) => void;
  onProjectOpened?: (result: ProjectUpserted) => void;
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
        <dt>Provider Observation</dt>
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
              ? "No Provider Observation is attached."
              : provider.kind === "host_gh"
                ? `Observed as ${provider.account} on ${provider.host}; Kestrel stores no token.`
                : "Provider Observation is read without a GitHub account or token."}
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
              : "Refresh is Manual only; Provider Observation never authorizes source."}
          </span>
        </dd>
      </div>
      <div>
        <dt>Direct API model access</dt>
        <dd>
          <strong>{modelAccessLabels[project.modelAccess]}</strong>
          <span>
            {project.modelAccess === "not_configured"
              ? "No Direct API profile is configured. Codex readiness is shown with each PR."
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
  project,
  changeProposal,
  disabled,
  online,
  onAuthenticationError,
  onAvailable,
  onIntentCreated,
  onProjectOpened,
  onRefresh,
  projectId,
  requiredRevisionId,
}: {
  canAcquire: boolean;
  project: Project;
  changeProposal: ChangeProposal;
  disabled: boolean;
  online: boolean;
  onAuthenticationError?: (error: unknown) => boolean;
  onAvailable: (result: ReviewRevisionAvailable) => void;
  onIntentCreated: (result: ChangeIntentVersionCreated) => void;
  onProjectOpened: (result: ProjectUpserted) => void;
  onRefresh: () => void;
  projectId: string;
  requiredRevisionId?: string;
}) {
  const revision = currentReviewRevision(changeProposal, requiredRevisionId);
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
            <h2 id={`proposal-${changeProposal.id}`}>{changeProposal.title}</h2>
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
    <section
      className="change-proposal grid min-w-0 gap-4"
      aria-labelledby={`proposal-${changeProposal.id}`}
    >
      <div className="proposal-heading">
        <div>
          <p className="proposal-state">
            GitHub pull request · {proposalStateLabels[changeProposal.proposalState]}
          </p>
          <h2 id={`proposal-${changeProposal.id}`}>
            <a href={changeProposal.canonicalUrl}>
              #{changeProposal.number} · {changeProposal.title}
            </a>
          </h2>
        </div>
        <Button
          variant="outline"
          className="secondary-action proposal-refresh"
          type="button"
          disabled={disabled}
          onClick={onRefresh}
        >
          Refresh PR #{changeProposal.number}
        </Button>
      </div>

      <section
        className="grid min-w-0 gap-4 rounded-xl border border-border bg-card p-4 sm:p-5"
        aria-label="Pull request facts"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            GitHub facts
          </p>
          <h3 className="mt-1 font-semibold">The pull request Kestrel will review</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            These fields come from GitHub. Refreshing them never starts work or changes the pull
            request.
          </p>
        </div>
        <dl className="commit-pointer-list readiness-facts">
          <div>
            <dt>Repository</dt>
            <dd>
              <strong>
                {project.repository === null
                  ? projectLabel(project)
                  : `${project.repository.owner}/${project.repository.name}`}
              </strong>
              <a href={changeProposal.canonicalUrl}>Open PR on GitHub</a>
            </dd>
          </div>
          <div>
            <dt>Branches</dt>
            <dd>
              <strong>
                {changeProposal.base.ref} ← {changeProposal.head.ref}
              </strong>
              <span>Target and proposed branch</span>
            </dd>
          </div>
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
              <span>Observed {formatObservedAt(changeProposal.observedAt)}</span>
            </dd>
          </div>
          <div>
            <dt>Author</dt>
            <dd>{changeProposal.author?.login ?? "Unavailable from GitHub"}</dd>
          </div>
          <RevisionFacts revision={revision} />
        </dl>
      </section>

      <ExternalChangeIntentPanel
        key={`${changeProposal.id}:${String(changeProposal.version)}`}
        disabled={disabled}
        projectId={projectId}
        proposal={changeProposal}
        {...(onAuthenticationError === undefined ? {} : { onAuthenticationError })}
        onCreated={onIntentCreated}
      />

      <ChangeOverviewPanel headingId={changeOverviewHeadingId} overview={changeOverview} />

      <section
        id={`acquire-${changeProposal.id}`}
        className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:p-5"
        aria-labelledby={`source-${changeProposal.id}`}
        tabIndex={-1}
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Exact source
          </p>
          <h3 id={`source-${changeProposal.id}`} className="mt-1 font-semibold">
            {revision?.state === "available"
              ? "Exact pull request revision retained"
              : "Retain the exact pull request revision"}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            The independent review reads this frozen source. It never reviews a moving branch.
          </p>
        </div>
        {canAcquire ? (
          <AcquireObservedReviewRevisionForm
            key={`${changeProposal.id}:${String(changeProposal.changeIntent?.version ?? 0)}:${revision?.id ?? "none"}:${revision?.state ?? "none"}`}
            disabled={disabled}
            projectId={projectId}
            proposal={changeProposal}
            {...(onAuthenticationError === undefined ? {} : { onAuthenticationError })}
            onAvailable={onAvailable}
          />
        ) : project.localRepositorySource?.state !== "attached" &&
          revision?.state !== "available" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground">
              Attach the local repository so Kestrel can retain the exact commits.
            </p>
            <OpenProjectForm
              disabled={disabled}
              triggerLabel="Attach local repository"
              onOpened={onProjectOpened}
              {...(onAuthenticationError === undefined ? {} : { onAuthenticationError })}
            />
          </div>
        ) : null}
      </section>

      <ExternalPullRequestReviewPanel
        changeProposalId={changeProposal.id}
        disabled={disabled}
        online={online}
        projectId={projectId}
        onAuthenticationError={onAuthenticationError ?? (() => false)}
      />
    </section>
  );
}

export function ProjectInboxPanel(props: ProjectInboxPanelProps) {
  const unavailable = !props.online || props.pending || (props.loading && props.inbox === null);
  return (
    <section className="projects-section" aria-label="Selected Project">
      {props.error ? (
        <div className="project-error" role="alert">
          <p>{props.error}</p>
          <Button
            variant="outline"
            className="secondary-action"
            type="button"
            onClick={props.onRetry}
            disabled={!props.online}
          >
            Retry Project inbox
          </Button>
        </div>
      ) : null}

      {!props.online ? (
        <div className="project-empty">
          <h3>Projects hidden while offline</h3>
          <p>Kestrel will refetch the authoritative Project inbox after reconnection.</p>
        </div>
      ) : props.loading && props.inbox === null ? (
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
            <ProjectRecord
              key={project.id}
              project={project}
              props={props}
              unavailable={unavailable}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectRecord({
  project,
  props,
  unavailable,
}: {
  project: Project;
  props: ProjectInboxPanelProps;
  unavailable: boolean;
}) {
  const selectedId = props.selectedProposalId;
  const previousSelection = useRef<string | undefined>(undefined);
  const detail = useRef<HTMLDivElement>(null);
  const connections = useProjectConnections(project, props.online, props.onAuthenticationError);
  const repository =
    project.repository ??
    (connections.github.state === "checked" &&
    connections.github.value.projectAccess?.state === "verified"
      ? connections.github.value.projectAccess.repository
      : null);
  const label =
    repository === null ? projectLabel(project) : `${repository.owner}/${repository.name}`;
  const selectedProposal = project.changeProposals.find((proposal) => proposal.id === selectedId);
  const selectProposal = (id: string | null) => props.onSelectProposal?.(id);
  useEffect(() => {
    if (selectedProposal !== undefined) detail.current?.focus();
    else if (previousSelection.current !== undefined) {
      detail.current
        ?.closest("article")
        ?.querySelector<HTMLElement>(
          ".pr-filters [role=tab][aria-selected=true], .saved-changes summary",
        )
        ?.focus();
    }
    previousSelection.current = selectedProposal?.id;
  }, [selectedProposal?.id]);
  const actions = (
    <ProjectActions
      project={project}
      repository={repository}
      disabled={unavailable}
      onOpen={props.onOpen}
      onAvailable={(result) => {
        selectProposal(result.changeProposal.id);
        props.onLocalAvailable?.(result);
      }}
      {...(props.onAuthenticationError === undefined
        ? {}
        : { onAuthenticationError: props.onAuthenticationError })}
    />
  );
  return (
    <article className="project-workspace">
      {project.localRepositorySource?.state === "attached" ? (
        <HostGitHubProjectPanel
          key={project.id}
          projectId={project.id}
          projectLabel={label}
          projectActions={actions}
          disabled={unavailable}
          online={props.online}
          {...(props.onAuthenticationError === undefined
            ? {}
            : { onAuthenticationError: props.onAuthenticationError })}
          onObserved={(observed, number) => {
            const proposal = observed.changeProposals.find(
              (candidate) => isProviderChangeProposal(candidate) && candidate.number === number,
            );
            if (proposal !== undefined) selectProposal(proposal.id);
            props.onHostObserved?.(observed);
          }}
        />
      ) : (
        <header className="project-workspace-header">
          <div>
            <h1>{label}</h1>
            <p>Attach a local repository to load the GitHub inbox.</p>
          </div>
          {actions}
        </header>
      )}
      <details className="project-details">
        <summary>Repository details</summary>
        <ProjectFacts project={project} />
      </details>
      {project.changeProposals.length === 0 ? null : (
        <details className="saved-changes">
          <summary>Saved changes ({project.changeProposals.length})</summary>
          <ul>
            {project.changeProposals.map((proposal) => (
              <li key={proposal.id}>
                <Button
                  variant="outline"
                  type="button"
                  className="secondary-action"
                  onClick={() => selectProposal(proposal.id)}
                >
                  {isProviderChangeProposal(proposal) ? `#${String(proposal.number)} · ` : ""}
                  {proposal.title}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div
        className="proposal-list"
        ref={detail}
        tabIndex={-1}
        role={selectedProposal === undefined ? undefined : "region"}
        aria-label={selectedProposal === undefined ? undefined : "Selected change details"}
      >
        {selectedProposal === undefined ? null : (
          <Button
            variant="outline"
            type="button"
            className="secondary-action"
            onClick={() => selectProposal(null)}
          >
            Close change details
          </Button>
        )}

        {(selectedProposal === undefined ? [] : [selectedProposal]).map((changeProposal) => (
          <ChangeProposalRecord
            project={project}
            canAcquire={
              project.localRepositorySource?.state === "attached" &&
              props.selectedRevisionId === undefined
            }
            changeProposal={changeProposal}
            disabled={unavailable}
            online={props.online}
            key={changeProposal.id}
            projectId={project.id}
            {...(props.selectedRevisionId === undefined
              ? {}
              : { requiredRevisionId: props.selectedRevisionId })}
            {...(props.onAuthenticationError === undefined
              ? {}
              : { onAuthenticationError: props.onAuthenticationError })}
            onAvailable={(result) => props.onLocalAvailable?.(result)}
            onIntentCreated={(result) => props.onIntentCreated?.(result)}
            onProjectOpened={(result) => props.onProjectOpened?.(result)}
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
  );
}
