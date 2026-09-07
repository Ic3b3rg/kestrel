import type { ReactNode } from "react";

import type { ProjectInbox } from "@kestrel/contracts";

import { projectLabel } from "./AuthenticatedShell.js";
import { currentReviewRevision } from "./current-review-revision.js";
import type { ProjectConnections } from "./use-project-connections.js";

type Project = ProjectInbox["projects"][number];
type Proposal = Extract<Project["changeProposals"][number], { kind: "provider_observed" }>;

const connectionStates = {
  ready: "Verified",
  waiting_for_usage_reset: "Waiting for usage reset",
  action_required: "Action required",
  unavailable: "Unavailable",
};

export function PrReadinessSummary({
  children,
  connections,
  disabled,
  project,
  proposal,
  sourceCorrection,
}: {
  children: ReactNode;
  connections: ProjectConnections;
  disabled: boolean;
  project: Project;
  proposal: Proposal;
  sourceCorrection: ReactNode;
}) {
  const { github, codex, model } = connections;
  const source = project.localRepositorySource;
  const revision = currentReviewRevision(proposal);
  const account = codex.state === "checked" ? codex.value.account : null;
  const savedModelId = model.state === "checked" ? model.value.selectedModelId : null;
  const selectedModel =
    codex.state === "checked"
      ? codex.value.models.find(({ id }) => id === savedModelId)
      : undefined;
  const modelLabel =
    model.state === "checking"
      ? "Checking saved default"
      : model.state === "unavailable"
        ? "Saved default unavailable"
        : savedModelId === null
          ? "Choose a model"
          : codex.state === "checking"
            ? "Checking live catalog"
            : codex.state !== "checked" || codex.value.account === null
              ? "Live catalog unavailable"
              : selectedModel === undefined
                ? "Action required — saved model is no longer available"
                : "Available in current catalog";
  const githubVerified =
    github.state === "checked" &&
    github.value.state === "ready" &&
    github.value.projectAccess?.state === "verified" &&
    github.value.projectAccess.projectId === project.id;
  const checking =
    github.state === "checking" || codex.state === "checking" || model.state === "checking";

  return (
    <section className="pr-readiness" aria-labelledby={`readiness-${proposal.id}`}>
      <div className="pr-readiness-heading">
        <div>
          <h3 id={`readiness-${proposal.id}`}>PR readiness</h3>
          <p>Independent prerequisites for a future review.</p>
        </div>
        <button
          className="secondary-action"
          type="button"
          disabled={disabled || checking}
          onClick={connections.refresh}
        >
          {checking ? "Checking connections…" : "Verify connections"}
        </button>
      </div>
      <dl className="commit-pointer-list readiness-facts">
        <div>
          <dt>Project / repository</dt>
          <dd>
            <strong>{projectLabel(project)}</strong>
            <span>Project {project.id}</span>
          </dd>
        </div>
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
            {source === null ? null : <span>{source.displayName}</span>}
            {source?.state === "attached" ? null : sourceCorrection}
            {source?.state !== "attached" && revision?.state === "available" ? (
              <span>The retained revision remains available.</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Provider proposal</dt>
          <dd>
            <span>
              PR #{proposal.number} · {proposal.proposalState}
            </span>
            <span>
              Last observed{" "}
              <time dateTime={proposal.observedAt}>
                {new Date(proposal.observedAt).toLocaleString()}
              </time>
            </span>
            <a href={proposal.canonicalUrl}>Open on GitHub</a>
          </dd>
        </div>
        {children}
        {revision?.state === "available" ? null : (
          <div>
            <dt>Revision correction</dt>
            <dd>
              {source?.state === "attached" ? (
                <a href={`#acquire-${proposal.id}`}>Inspect exact revision acquisition</a>
              ) : (
                sourceCorrection
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>GitHub access</dt>
          <dd aria-busy={github.state === "checking"}>
            <strong>
              {github.state === "checking"
                ? "Checking this Project"
                : githubVerified
                  ? "Verified for this Project"
                  : "Access not verified"}
            </strong>
            {github.state === "checked" && github.value.identity !== null ? (
              <span>
                {github.value.identity.account} on {github.value.identity.host}
              </span>
            ) : null}
            <span>
              {project.providerObservation?.kind === "public_github"
                ? "Public Provider Observation uses no host account."
                : "Host access is independent of retained source."}
            </span>
            {githubVerified ? null : (
              <a
                href={`/settings?projectId=${encodeURIComponent(project.id)}#github-connection-title`}
              >
                Correct GitHub connection
              </a>
            )}
          </dd>
        </div>
        <div>
          <dt>Codex account</dt>
          <dd aria-busy={codex.state === "checking"}>
            <strong>
              {codex.state === "checking"
                ? "Checking Codex"
                : codex.state === "unavailable"
                  ? "Unavailable"
                  : connectionStates[codex.value.state]}
            </strong>
            {account === null ? null : (
              <span>
                {account.email ?? "ChatGPT account (email not reported)"} · {account.plan}
              </span>
            )}
            {codex.state === "checked" ? (
              <span>
                Checked{" "}
                <time dateTime={codex.value.checkedAt}>
                  {new Date(codex.value.checkedAt).toLocaleString()}
                </time>
              </span>
            ) : null}
            {codex.state === "checked" && codex.value.state === "ready" ? null : (
              <a href="/settings#codex-connection-title">Correct Codex connection</a>
            )}
          </dd>
        </div>
        <div>
          <dt>Selected model</dt>
          <dd aria-busy={model.state === "checking" || codex.state === "checking"}>
            <strong>{modelLabel}</strong>
            {savedModelId === null ? null : (
              <span>
                {selectedModel?.displayName ?? savedModelId} · <code>{savedModelId}</code>
              </span>
            )}
            <span>Codex subscription · default for future reviews.</span>
            <a href="/settings#review-model-title">
              {selectedModel === undefined ? "Choose review model" : "Change review model"}
            </a>
          </dd>
        </div>
      </dl>
      <p className="pr-readiness-release">
        Review execution arrives in 0.2. These facts do not start a review.
      </p>
    </section>
  );
}
