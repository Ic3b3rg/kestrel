import type { ChangeOverview, ChangeOverviewWarning } from "@kestrel/contracts";

import { ShortObjectId } from "./ShortObjectId.js";

interface ChangeOverviewPanelProps {
  headingId: string;
  overview: ChangeOverview;
}

const statusLabels = {
  awaiting_source: "Awaiting exact source",
  generating: "Generating",
  ready: "Ready",
  unavailable: "Unavailable",
} as const;

const changedFileLabels = {
  added: "Added",
  deleted: "Deleted",
  modified: "Modified",
} as const;

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return `${String(value)} ${value === 1 ? singular : plural}`;
}

function warningText(warning: ChangeOverviewWarning): string {
  switch (warning.code) {
    case "changed_files_truncated":
      return `${pluralize(warning.omittedCount, "additional changed file")} omitted from the path list; the totals still cover the exact revision.`;
    case "path_areas_truncated":
      return `${pluralize(warning.omittedCount, "additional source area")} omitted from the area list.`;
    case "gitlink_not_expanded":
      return `${pluralize(warning.affectedFileCount, "Git submodule link")} changed, but linked repository content was not expanded.`;
    case "git_lfs_pointer_not_hydrated":
      return `Git LFS pointer content was not hydrated for ${pluralize(warning.affectedFileCount, "changed file")}.`;
  }
}

function PendingOverview({ overview }: { overview: Exclude<ChangeOverview, { state: "ready" }> }) {
  const detail =
    overview.state === "awaiting_source"
      ? "Retain this exact base and head before deterministic facts can be generated."
      : overview.state === "generating"
        ? "Kestrel is deriving facts from the verified retained base and head."
        : overview.reason === "facts_not_available"
          ? "This retained revision predates deterministic Change Overview facts. Retain the exact revision again to generate them."
          : "Deterministic facts could not be generated. Review the Revision State and retry this exact source.";
  return (
    <div className="change-overview-state">
      <p>{detail}</p>
      <dl>
        <div>
          <dt>Exact head</dt>
          <dd>
            <ShortObjectId label="Change Overview exact head" value={overview.exactHeadObjectId} />
          </dd>
        </div>
        <div>
          <dt>Source state</dt>
          <dd>{statusLabels[overview.state]}</dd>
        </div>
      </dl>
    </div>
  );
}

function ReadyOverview({ overview }: { overview: Extract<ChangeOverview, { state: "ready" }> }) {
  const { exactRevision, sourceFacts } = overview;
  const statistics = sourceFacts.fileStatistics;
  return (
    <div className="change-overview-ready">
      <dl className="change-overview-facts">
        <div>
          <dt>Exact base</dt>
          <dd>
            <span>{exactRevision.base.ref}</span>
            <ShortObjectId label="Change Overview exact base" value={exactRevision.base.objectId} />
            <small>
              {exactRevision.base.author ?? "Author unavailable"} ·{" "}
              {exactRevision.base.subject ?? "Subject unavailable"}
            </small>
          </dd>
        </div>
        <div>
          <dt>Exact head</dt>
          <dd>
            <span>{exactRevision.head.ref}</span>
            <ShortObjectId label="Change Overview exact head" value={exactRevision.head.objectId} />
            <small>
              {exactRevision.head.author ?? "Author unavailable"} ·{" "}
              {exactRevision.head.subject ?? "Subject unavailable"}
            </small>
          </dd>
        </div>
        <div>
          <dt>Change Intent v{overview.changeIntent.version}</dt>
          <dd>{overview.changeIntent.text}</dd>
        </div>
        <div>
          <dt>Provider observation</dt>
          <dd>
            {overview.providerObservation === null ? (
              "Not attached to this local proposal."
            ) : (
              <>
                <a href={overview.providerObservation.canonicalUrl}>
                  {overview.providerObservation.title}
                </a>
                <span>
                  {overview.providerObservation.description ?? "No provider description."}
                </span>
                <time dateTime={overview.providerObservation.observedAt}>
                  Observed {overview.providerObservation.observedAt}
                </time>
              </>
            )}
          </dd>
        </div>
      </dl>

      <section className="change-overview-group" aria-labelledby={`${exactRevision.id}-files`}>
        <h6 id={`${exactRevision.id}-files`}>Changed files</h6>
        <p className="change-overview-summary">
          <span>
            Base snapshot · {pluralize(sourceFacts.commitStatistics.baseTreeFileCount, "file")}
          </span>{" "}
          ·{" "}
          <span>
            Head snapshot · {pluralize(sourceFacts.commitStatistics.headTreeFileCount, "file")}
          </span>
        </p>
        <p className="change-overview-summary">
          {pluralize(statistics.total, "changed file")} · {String(statistics.added)} added ·{" "}
          {String(statistics.modified)} modified · {String(statistics.deleted)} deleted
        </p>
        {sourceFacts.changedFiles.length === 0 ? (
          <p>No committed file changes exist between the exact base and head.</p>
        ) : (
          <ul className="changed-file-list">
            {sourceFacts.changedFiles.map((file) => (
              <li key={file.path}>
                <strong>{changedFileLabels[file.status]}</strong>
                <code>{file.path}</code>
                <small>
                  {file.base === null
                    ? "No base entry"
                    : `${file.base.mode} · ${file.base.objectId.slice(0, 12)}`}
                  {" → "}
                  {file.head === null
                    ? "No head entry"
                    : `${file.head.mode} · ${file.head.objectId.slice(0, 12)}`}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>

      {sourceFacts.pathAreas.length === 0 ? null : (
        <section className="change-overview-group" aria-labelledby={`${exactRevision.id}-areas`}>
          <h6 id={`${exactRevision.id}-areas`}>Source areas</h6>
          <ul className="source-area-list">
            {sourceFacts.pathAreas.map((area) => (
              <li key={area.pathPrefix ?? "repository-root"}>
                <strong>{area.pathPrefix ?? "Repository root"}</strong>
                <span>{pluralize(area.changedFileCount, "changed file")}</span>
                <small>Samples: {area.samplePaths.join(", ")}</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sourceFacts.warnings.length === 0 ? null : (
        <section
          className="change-overview-warnings"
          aria-labelledby={`${exactRevision.id}-warnings`}
        >
          <h6 id={`${exactRevision.id}-warnings`}>Source warnings</h6>
          <ul>
            {sourceFacts.warnings.map((warning) => (
              <li key={warning.code}>{warningText(warning)}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function ChangeOverviewPanel({ headingId, overview }: ChangeOverviewPanelProps) {
  return (
    <section
      className="change-overview"
      aria-labelledby={headingId}
      {...(overview.state === "generating" ? { "aria-busy": true } : {})}
    >
      <div className="change-overview-heading">
        <div>
          <p>EXACT COMMITTED SOURCE</p>
          <h5 id={headingId}>Change Overview</h5>
        </div>
        <strong className={`change-overview-status change-overview-status-${overview.state}`}>
          {statusLabels[overview.state]}
        </strong>
      </div>
      <p className="change-overview-boundary">
        Deterministic orientation facts only. This is not a Conceptual Review, analysis, or verdict.
      </p>
      {overview.state === "ready" ? (
        <ReadyOverview overview={overview} />
      ) : (
        <PendingOverview overview={overview} />
      )}
    </section>
  );
}
