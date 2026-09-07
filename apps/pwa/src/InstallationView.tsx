import { Button } from "./components/ui/button.js";
import type { ReactNode } from "react";

import type { InstallationSnapshot } from "@kestrel/contracts";

import type { EventConnectionState } from "./api.js";

export type PwaConnectionState = EventConnectionState | "disconnected" | "offline";
type DiagnosticStatus = NonNullable<InstallationSnapshot["diagnostic"]>["status"];

interface InstallationViewProps {
  commandPending: boolean;
  connection: PwaConnectionState;
  connectionControls: ReactNode;
  loading: boolean;
  online: boolean;
  operatorControls: ReactNode;
  repositoryControls: ReactNode;
  onRetry: () => void;
  onRunDiagnostic: () => void;
  requestError: string | null;
  showData: boolean;
  snapshot: InstallationSnapshot | null;
}

const diagnosticLabels: Record<DiagnosticStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
};

const stateLabels: Record<InstallationSnapshot["installation"]["state"], string> = {
  ready: "Ready",
  diagnostic_queued: "Diagnostic queued",
  diagnostic_running: "Diagnostic running",
  diagnostic_succeeded: "Diagnostic succeeded",
};

function formatTime(value: string | null): string {
  if (value === null) {
    return "Not yet recorded";
  }
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function TimeValue({ value }: { value: string | null }) {
  return value === null ? (
    <span>{formatTime(value)}</span>
  ) : (
    <time dateTime={value}>{formatTime(value)}</time>
  );
}

function LoadingState({ historyRefresh }: { historyRefresh: boolean }) {
  return (
    <section className="system-state" aria-busy="true" aria-label="Loading Installation data">
      <h2>{historyRefresh ? "Refreshing retained history" : "Reading Installation"}</h2>
      <p>Loading your installation status…</p>
      <div className="loading-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}

function InstallationRecord({ snapshot }: { snapshot: InstallationSnapshot }) {
  const { diagnostic, installation } = snapshot;
  return (
    <div className="record-layout">
      <section className="record-section" aria-labelledby="installation-record-title">
        <div className="section-heading">
          <div>
            <h2 id="installation-record-title">Durable identity</h2>
          </div>
          <p className={`state-marker state-${installation.state}`}>
            <span aria-hidden="true" />
            {stateLabels[installation.state]}
          </p>
        </div>
        <dl className="fact-list">
          <div className="fact-wide">
            <dt>Installation ID</dt>
            <dd>
              <code>{installation.id}</code>
            </dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd>{installation.revision}</dd>
          </div>
          <div>
            <dt>Event cursor</dt>
            <dd>{snapshot.eventCursor}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>
              <TimeValue value={installation.createdAt} />
            </dd>
          </div>
          <div>
            <dt>Last changed</dt>
            <dd>
              <TimeValue value={installation.updatedAt} />
            </dd>
          </div>
        </dl>
      </section>

      <section className="record-section diagnostic-section" aria-labelledby="diagnostic-title">
        <div className="section-heading">
          <div>
            <h2 id="diagnostic-title">Latest operation</h2>
          </div>
          {diagnostic ? (
            <strong className={`diagnostic-status status-${diagnostic.status}`}>
              {diagnosticLabels[diagnostic.status]}
            </strong>
          ) : null}
        </div>
        {diagnostic ? (
          <dl className="fact-list diagnostic-facts">
            <div className="fact-wide">
              <dt>Diagnostic ID</dt>
              <dd>
                <code>{diagnostic.id}</code>
              </dd>
            </div>
            <div>
              <dt>Requested</dt>
              <dd>
                <TimeValue value={diagnostic.requestedAt} />
              </dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>
                <TimeValue value={diagnostic.startedAt} />
              </dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>
                <TimeValue value={diagnostic.completedAt} />
              </dd>
            </div>
          </dl>
        ) : (
          <div className="empty-operation">
            <p>No diagnostic has been requested.</p>
            <p>Run a diagnostic to check that background work is available.</p>
          </div>
        )}
      </section>
    </div>
  );
}

export function InstallationView(props: InstallationViewProps) {
  const diagnosticActive =
    props.snapshot?.diagnostic?.status === "queued" ||
    props.snapshot?.diagnostic?.status === "running";
  const commandDisabled =
    !props.online || !props.showData || props.commandPending || diagnosticActive;

  return (
    <div className="settings-view">
      <section className="intro">
        <div>
          <h1 id="page-title">Settings</h1>
          <p className="lede">
            Installation, host connections, repository access, and Operator security.
          </p>
        </div>
        <div className="command-panel">
          <Button
            type="button"
            disabled={commandDisabled}
            aria-describedby="command-help"
            onClick={props.onRunDiagnostic}
          >
            {props.commandPending ? "Requesting…" : "Run diagnostic"}
          </Button>
          <p id="command-help">
            {!props.online
              ? "Unavailable while offline."
              : diagnosticActive
                ? "A diagnostic is already in progress."
                : "Check that background work is available."}
          </p>
        </div>
      </section>

      {props.requestError ? (
        <section className="error-state" role="alert">
          <div>
            <h2>Installation data is unavailable</h2>
            <p>{props.requestError}</p>
          </div>
          <Button type="button" onClick={props.onRetry} disabled={!props.online}>
            Try again
          </Button>
        </section>
      ) : null}

      {!props.online ? (
        <section className="system-state offline-state">
          <h2>Reconnect to view product data</h2>
          <p>Your data will return when the connection is restored.</p>
        </section>
      ) : props.loading ? (
        <LoadingState historyRefresh={props.connection === "cursor-expired"} />
      ) : props.showData && props.snapshot ? (
        <InstallationRecord snapshot={props.snapshot} />
      ) : null}

      {props.connectionControls}

      {props.repositoryControls}

      {props.operatorControls}
    </div>
  );
}
