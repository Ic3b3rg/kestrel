import { useEffect, useRef, useState } from "react";
import { CircleDot } from "lucide-react";
import type {
  FactoryGitHubIssue,
  FactoryGitHubIssues,
  FactoryIssueImports,
  FactoryProviderFailure,
  ImportedFactoryIssue,
  ImportFactoryIssuesCommand,
} from "@kestrel/contracts";
import {
  ApiClientError,
  fetchFactoryGitHubIssues,
  fetchFactoryIssueImports,
  importFactoryIssues,
} from "./api.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { Button } from "./components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog.js";

const providerFailures: Record<FactoryProviderFailure, string> = {
  unavailable: "The workstation could not reach GitHub. Check its connection and retry.",
  needs_authentication: "The workstation needs a GitHub sign-in before continuing.",
  access_denied:
    "The host GitHub account cannot access this repository. Check repository permissions.",
  rate_limited: "GitHub has limited requests. Wait for the limit to reset before retrying.",
  invalid_response: "GitHub returned an unexpected response. The saved work is retained.",
  timeout: "GitHub did not respond in time. The saved work is retained.",
  cancelled: "This GitHub operation was cancelled. Existing issue links are retained.",
  project_not_supported: "Connect a local repository with a github.com remote to this Project.",
  repository_changed:
    "The repository identity changed. Check the Project connection before continuing.",
  uncertain_write:
    "GitHub may have accepted the write. Retry checks the existing result; it does not recreate the issue.",
  issue_already_bound:
    "An issue is already linked to another active feature. Review that feature before reusing it.",
  reconciliation_limit:
    "The bounded GitHub check could not confirm the earlier write. Inspect GitHub; retry checks for the existing result.",
};

export function FactoryProviderProblem({
  failure,
  projectId,
}: {
  failure: FactoryProviderFailure;
  projectId: string;
}) {
  return (
    <div className="github-provider-problem">
      <p>{providerFailures[failure]}</p>
      {failure === "needs_authentication" ||
      failure === "access_denied" ||
      failure === "unavailable" ||
      failure === "project_not_supported" ||
      failure === "repository_changed" ? (
        <a href={`/settings?projectId=${projectId}#github-connection-title`}>
          Check GitHub connection
        </a>
      ) : null}
    </div>
  );
}

function IssueSnapshot({ issue, importedAt }: { issue: FactoryGitHubIssue; importedAt?: string }) {
  return (
    <section
      className="github-issue-snapshot"
      aria-label={`Issue snapshot #${String(issue.number)}`}
    >
      <h3>
        #{issue.number} · {issue.title}
      </h3>
      <p>
        <a href={issue.url} target="_blank" rel="noreferrer">
          {issue.repository.owner}/{issue.repository.name} · #{issue.number}
        </a>
      </p>
      <p>
        {importedAt === undefined
          ? "Current issue preview"
          : `Snapshot imported ${new Date(importedAt).toLocaleString()}`}{" "}
        · {issue.state}
      </p>
      <p className="planning-notice">
        Untrusted planning context. Only the approved plan authorizes work.
      </p>
      <pre tabIndex={0} aria-label={`Issue #${String(issue.number)} body`}>
        {issue.body || "No issue description."}
      </pre>
      <h4>GitHub dependencies</h4>
      {issue.dependencies === null ? (
        <p>Dependency metadata was unavailable.</p>
      ) : issue.dependencies.length === 0 ? (
        <p>No dependencies were recorded.</p>
      ) : (
        <ul>
          {issue.dependencies.map((dependency) => (
            <li key={dependency.id}>
              <a href={dependency.url} target="_blank" rel="noreferrer">
                #{dependency.number} · {dependency.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ImportedIssueReference({ source }: { source: ImportedFactoryIssue }) {
  return (
    <div className="github-import-reference">
      <a href={source.issue.url} target="_blank" rel="noreferrer">
        #{source.issue.number} · {source.issue.title}
      </a>
      <Dialog>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            Inspect imported snapshot
          </Button>
        </DialogTrigger>
        <DialogContent className="planning-documents-dialog max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
          <DialogTitle>Imported issue #{source.issue.number}</DialogTitle>
          <DialogDescription>
            This retained source informs planning. The approved plan determines the work.
          </DialogDescription>
          <IssueSnapshot issue={source.issue} importedAt={source.importedAt} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

export interface FeatureGitHubIssuesPanelProps {
  projectId: string;
  featureId: string;
  online: boolean;
  onAuthenticationError: (error: unknown) => boolean;
  onChanged: () => void;
  loadImports?: typeof fetchFactoryIssueImports;
  loadIssues?: typeof fetchFactoryGitHubIssues;
  importIssues?: typeof importFactoryIssues;
}

export function FeatureGitHubIssuesPanel({
  projectId,
  featureId,
  online,
  onAuthenticationError,
  onChanged,
  loadImports = fetchFactoryIssueImports,
  loadIssues = fetchFactoryGitHubIssues,
  importIssues = importFactoryIssues,
}: FeatureGitHubIssuesPanelProps) {
  const [open, setOpen] = useState(false);
  const [imports, setImports] = useState<FactoryIssueImports | null>(null);
  const [catalog, setCatalog] = useState<FactoryGitHubIssues | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number[]>([]);
  const [inspected, setInspected] = useState<{ imported: boolean; number: number } | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [generation, setGeneration] = useState(0);
  const alive = useRef(true);
  const submitting = useRef(false);
  const attempt = useRef<ImportFactoryIssuesCommand | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open || !online) return;
    const controller = new AbortController();
    const isActive = () => !controller.signal.aborted;
    setReading(true);
    setReadError(null);
    void (async () => {
      try {
        const result = await loadImports(projectId, featureId, controller.signal);
        if (!isActive()) return;
        if (result.feature.id !== featureId) throw new Error("Unexpected feature imports");
        setImports(result);
        setSelected((current) =>
          current.filter(
            (number) => !result.issues.some((source) => source.issue.number === number),
          ),
        );
        if (result.canImport) {
          const issues = await loadIssues(projectId, page, controller.signal);
          if (isActive()) setCatalog(issues);
        } else setCatalog(null);
      } catch (failure) {
        if (isActive() && !onAuthenticationError(failure))
          setReadError(
            planningRequestError(failure, "GitHub issues could not be read. Refresh to retry."),
          );
      } finally {
        if (isActive()) setReading(false);
      }
    })();
    return () => controller.abort();
  }, [
    open,
    online,
    projectId,
    featureId,
    page,
    generation,
    loadImports,
    loadIssues,
    onAuthenticationError,
  ]);

  const run = async () => {
    if (!online || submitting.current) return;
    if (attempt.current === null) {
      if (imports?.canImport !== true || selected.length === 0) return;
      attempt.current = {
        requestId: crypto.randomUUID(),
        issueNumbers: [...selected].sort((a, b) => a - b),
      };
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await importIssues(projectId, featureId, attempt.current);
      if (!alive.current) return;
      if (result.feature.id !== featureId) throw new Error("Unexpected feature imports");
      setImports(result);
      setSelected([]);
      setInspected(null);
      attempt.current = null;
      setUncertain(false);
      setGeneration((value) => value + 1);
      onChanged();
    } catch (failure) {
      if (alive.current && !onAuthenticationError(failure)) {
        const rejected =
          failure instanceof ApiClientError && failure.status >= 400 && failure.status < 500;
        if (rejected) attempt.current = null;
        setUncertain(!rejected);
        setError(
          planningRequestError(
            failure,
            "Kestrel could not confirm the import. Retry the same request safely.",
          ),
        );
        setGeneration((value) => value + 1);
        onChanged();
      }
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const imported =
    inspected?.imported === false
      ? undefined
      : (imports?.issues.find(({ issue }) => issue.number === inspected?.number) ??
        imports?.issues[0]);
  const preview =
    imported?.issue ??
    catalog?.issues.find((issue) => issue.number === inspected?.number) ??
    catalog?.issues[0];
  const disabled = !online || busy || uncertain || reading || readError !== null;
  const remaining = 20 - (imports?.issues.length ?? 0);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy || value) setOpen(value);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <CircleDot aria-hidden="true" />
          GitHub issues
        </Button>
      </DialogTrigger>
      <DialogContent className="github-issues-dialog max-h-[85dvh] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-5xl">
        <DialogTitle>GitHub issues</DialogTitle>
        <DialogDescription>
          Import selected open issues before the first saved plan. Every imported issue must be
          linked to a Work Item before approval.
        </DialogDescription>
        <div className="plan-actions">
          <Button
            variant="outline"
            disabled={!online || reading || busy}
            onClick={() => setGeneration((value) => value + 1)}
          >
            Refresh issues
          </Button>
        </div>
        {!online ? (
          <p className="planning-notice">
            Offline. Previously read snapshots are retained; reconnect to import.
          </p>
        ) : null}
        {reading ? <p role="status">Reading GitHub issues…</p> : null}
        {readError === null ? null : (
          <p role="alert" className="planning-error">
            {readError}
          </p>
        )}
        {error === null ? null : (
          <div role="alert" className="planning-command-error">
            <p>{error}</p>
            {uncertain ? (
              <Button variant="outline" disabled={!online || busy} onClick={() => void run()}>
                Retry import
              </Button>
            ) : null}
          </div>
        )}
        {imports?.canImport === false ? (
          <p className="planning-notice">
            Import is unavailable while a turn is active or after the first saved plan. Saved
            snapshots remain available.
          </p>
        ) : null}
        <div className="github-issues-layout">
          <div className="github-issue-choices">
            <section aria-label="Imported issues">
              <h3>
                Imported snapshots{imports === null ? "" : ` · ${String(imports.issues.length)}`}
              </h3>
              {imports?.issues.length === 0 ? <p>No issues imported yet.</p> : null}
              {imports?.issues.map((source) => (
                <Button
                  key={source.id}
                  variant="outline"
                  className="github-issue-choice h-auto w-full justify-start whitespace-normal text-left"
                  onClick={() => setInspected({ imported: true, number: source.issue.number })}
                >
                  #{source.issue.number} · {source.issue.title}
                </Button>
              ))}
            </section>
            {imports?.canImport !== true ? null : (
              <section aria-label="Open GitHub issues">
                <h3>
                  Open issues
                  {catalog?.repository == null
                    ? ""
                    : ` · ${catalog.repository.owner}/${catalog.repository.name}`}
                </h3>
                {catalog?.failure == null ? null : (
                  <FactoryProviderProblem failure={catalog.failure} projectId={projectId} />
                )}
                {catalog?.state !== "available" ? null : (
                  <>
                    {catalog.issues.length === 0 ? <p>No open issues on this page.</p> : null}
                    <ul className="github-issue-options">
                      {catalog.issues.map((issue) => {
                        const alreadyImported = imports.issues.some(
                          (source) => source.issue.id === issue.id,
                        );
                        const checked = selected.includes(issue.number);
                        return (
                          <li key={issue.id}>
                            <label>
                              <input
                                type="checkbox"
                                aria-label={`Select issue #${String(issue.number)}`}
                                checked={checked || alreadyImported}
                                disabled={
                                  disabled ||
                                  alreadyImported ||
                                  (!checked && selected.length >= remaining) ||
                                  issue.state !== "open"
                                }
                                onChange={() =>
                                  setSelected((current) =>
                                    checked
                                      ? current.filter((number) => number !== issue.number)
                                      : [...current, issue.number],
                                  )
                                }
                              />
                              {alreadyImported ? "Imported" : `#${String(issue.number)}`}
                            </label>
                            <Button
                              variant="ghost"
                              className="github-issue-choice h-auto w-full justify-start whitespace-normal text-left"
                              onClick={() =>
                                setInspected({ imported: false, number: issue.number })
                              }
                            >
                              {issue.title}
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                    {catalog.limited ? (
                      <p>
                        The bounded issue list may omit other issues. Up to five pages can be read.
                      </p>
                    ) : null}
                    <p>
                      {selected.length} selected · {remaining} import slots available
                    </p>
                    {selected.length === 0 ? null : (
                      <p>
                        Selected issues: {selected.map((number) => `#${String(number)}`).join(", ")}
                      </p>
                    )}
                    <Button
                      disabled={disabled || selected.length === 0 || selected.length > remaining}
                      onClick={() => void run()}
                    >
                      {busy ? "Importing…" : `Import selected issues (${String(selected.length)})`}
                    </Button>
                  </>
                )}
                <div className="plan-actions">
                  <Button
                    variant="outline"
                    disabled={!online || busy || uncertain || reading || page <= 1}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    Previous page
                  </Button>
                  <span>Page {page}</span>
                  <Button
                    variant="outline"
                    disabled={disabled || catalog?.page !== page || catalog.nextPage === null}
                    onClick={() => {
                      if (catalog?.nextPage != null) setPage(catalog.nextPage);
                    }}
                  >
                    Next page
                  </Button>
                </div>
              </section>
            )}
          </div>
          {preview === undefined ? null : (
            <IssueSnapshot
              issue={preview}
              {...(imported === undefined ? {} : { importedAt: imported.importedAt })}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
