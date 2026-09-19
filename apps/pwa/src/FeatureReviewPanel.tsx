import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FactoryConceptualReviewBlocker,
  FactoryConceptualReviewCheck,
  FactoryConceptualReviewCheckCatalog,
  FactoryConceptualReviewPreparation,
  FactoryConceptualReviewSourceCatalog,
  FactoryConceptualReviewSourceLines,
} from "@kestrel/contracts";
import { CheckCircle2, FileCode2, GitPullRequest, RefreshCw, ShieldAlert } from "lucide-react";

import {
  fetchFactoryConceptualReviewCheck,
  fetchFactoryConceptualReviewChecks,
  fetchFactoryConceptualReviewPreparation,
  fetchFactoryConceptualReviewSourceCatalog,
  fetchFactoryConceptualReviewSourceLines,
} from "./conceptual-review-api.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";

const SOURCE_PAGE_SIZE = 200;
const CHECK_PAGE_SIZE = 100;

const blockers: Record<FactoryConceptualReviewBlocker, string> = {
  publication_not_ready: "Publish the cumulative Feature pull request before review.",
  approved_plan_mismatch: "The published Feature no longer matches its approved plan.",
  certificate_mismatch: "The final verification evidence does not match the published revision.",
  exact_revision_mismatch: "The retained source does not match the pull request base and head.",
  model_not_selected: "Choose a Codex review model in Settings before starting review.",
  review_runtime_unavailable:
    "The bounded review runner is not available yet. You can inspect every frozen input now.",
};

export interface FeatureReviewPanelProps {
  projectId: string;
  featureId: string;
  online: boolean;
  onAuthenticationError: (error: unknown) => boolean;
  loadPreparation?: typeof fetchFactoryConceptualReviewPreparation;
  loadSourceCatalog?: typeof fetchFactoryConceptualReviewSourceCatalog;
  loadSourceLines?: typeof fetchFactoryConceptualReviewSourceLines;
  loadChecks?: typeof fetchFactoryConceptualReviewChecks;
  loadCheck?: typeof fetchFactoryConceptualReviewCheck;
}

function shortId(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-7)}`;
}

function ExactInputs({ preparation }: { preparation: FactoryConceptualReviewPreparation }) {
  const publication = preparation.publication;
  if (publication === null) return null;
  return (
    <section className="grid min-w-0 gap-4 rounded-xl border border-border bg-card p-4 lg:grid-cols-2">
      <div className="min-w-0 space-y-2">
        <h3 className="flex items-center gap-2 font-semibold">
          <GitPullRequest className="size-4" aria-hidden="true" /> Published Feature
        </h3>
        <a
          className="block break-words text-sm font-medium underline underline-offset-4"
          href={publication.pullRequest.url}
          target="_blank"
          rel="noreferrer"
        >
          #{publication.pullRequest.number} · {publication.pullRequest.title}
        </a>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Target</dt>
            <dd>{publication.pullRequest.baseRef}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Feature branch</dt>
            <dd className="break-all">{publication.pullRequest.headRef}</dd>
          </div>
        </dl>
      </div>
      <div className="min-w-0 space-y-2">
        <h3 className="flex items-center gap-2 font-semibold">
          <CheckCircle2 className="size-4" aria-hidden="true" /> Exact review revision
        </h3>
        <dl className="grid gap-2 text-sm">
          <div>
            <dt className="text-muted-foreground">Base</dt>
            <dd className="break-all font-mono text-xs">{publication.revision.base.objectId}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Head</dt>
            <dd className="break-all font-mono text-xs">{publication.revision.head.objectId}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Retained revision</dt>
            <dd className="font-mono text-xs" title={publication.revision.id}>
              {shortId(publication.revision.id)}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function PreparationDetails({ preparation }: { preparation: FactoryConceptualReviewPreparation }) {
  const { configuration, evidence } = preparation;
  return (
    <section className="grid min-w-0 gap-4 rounded-xl border border-border bg-card p-4 lg:grid-cols-2">
      <div className="min-w-0 space-y-2">
        <h3 className="font-semibold">Frozen review preparation</h3>
        <dl className="grid gap-2 text-sm">
          <div>
            <dt className="text-muted-foreground">Preparation digest</dt>
            <dd className="break-all font-mono text-xs">
              {preparation.preparationDigest ?? "Unavailable until every exact input is ready"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Review model</dt>
            <dd>{configuration.model.modelId ?? "No model selected"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Runtime policy</dt>
            <dd>
              {configuration.runtimePolicy.status} · retained source read only · network off ·
              writes off
            </dd>
          </div>
        </dl>
      </div>
      <div className="min-w-0 space-y-2">
        <h3 className="font-semibold">Bounded resources and evidence</h3>
        <p className="text-sm text-muted-foreground">
          {configuration.resources.maximumAttempts} attempts ·{" "}
          {configuration.resources.timeoutSeconds} seconds ·{" "}
          {configuration.resources.maximumSourceReads} source reads ·{" "}
          {configuration.resources.maximumGraphNodes} graph nodes ·{" "}
          {configuration.resources.maximumOutputBytes} output bytes
        </p>
        {evidence === null ? (
          <p className="text-sm text-muted-foreground">
            Evidence limits become inspectable when the exact retained inputs match.
          </p>
        ) : (
          <div className="grid gap-2 text-sm">
            <p>
              Source: {evidence.source.limits.catalogPageEntries} paths per page ·{" "}
              {evidence.source.limits.lineRange} lines per read · {evidence.source.limits.fileBytes}{" "}
              bytes per file · {evidence.source.limits.responseBytes} bytes per response
            </p>
            <p>
              Checks: {evidence.checks.total} stored · {evidence.checks.limits.catalogPageEntries}{" "}
              per page · {evidence.checks.limits.outputBytesPerStream} bytes per output stream
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function SourceInspector({
  projectId,
  featureId,
  active,
  loadCatalog,
  loadLines,
  onAuthenticationError,
}: {
  projectId: string;
  featureId: string;
  active: boolean;
  loadCatalog: typeof fetchFactoryConceptualReviewSourceCatalog;
  loadLines: typeof fetchFactoryConceptualReviewSourceLines;
  onAuthenticationError: FeatureReviewPanelProps["onAuthenticationError"];
}) {
  const [catalog, setCatalog] = useState<FactoryConceptualReviewSourceCatalog | null>(null);
  const [lines, setLines] = useState<FactoryConceptualReviewSourceLines | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [startLine, setStartLine] = useState("1");
  const [endLine, setEndLine] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readCatalog = async (side: "base" | "head", offset = 0) => {
    if (!active || busy) return;
    setBusy(true);
    setError(null);
    setLines(null);
    setSelectedPath(null);
    try {
      setCatalog(await loadCatalog(projectId, featureId, side, offset, SOURCE_PAGE_SIZE));
    } catch (failure) {
      if (!onAuthenticationError(failure))
        setError(planningRequestError(failure, "The retained source catalog is unavailable."));
    } finally {
      setBusy(false);
    }
  };
  const readLines = async (path: string, requestedStart: number, requestedEnd: number) => {
    if (!active || busy || catalog === null) return;
    if (
      !Number.isSafeInteger(requestedStart) ||
      !Number.isSafeInteger(requestedEnd) ||
      requestedStart < 1 ||
      requestedEnd < requestedStart ||
      requestedEnd - requestedStart + 1 > SOURCE_PAGE_SIZE
    ) {
      setError(`Choose between 1 and ${String(SOURCE_PAGE_SIZE)} consecutive lines.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setSelectedPath(path);
      setLines(
        await loadLines(projectId, featureId, catalog.side, path, requestedStart, requestedEnd),
      );
    } catch (failure) {
      if (!onAuthenticationError(failure))
        setError(planningRequestError(failure, "This retained source range is unavailable."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4"
      aria-label="Retained source inspector"
    >
      <div>
        <h3 className="flex items-center gap-2 font-semibold">
          <FileCode2 className="size-4" aria-hidden="true" /> Retained source
        </h3>
        <p className="text-sm text-muted-foreground">
          Reads the immutable base or head captured for this review. Paths never come from a mutable
          checkout.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!active || busy}
          onClick={() => void readCatalog("head", 0)}
        >
          Browse head source
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!active || busy}
          onClick={() => void readCatalog("base", 0)}
        >
          Browse base source
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {catalog === null ? null : (
        <div className="grid min-w-0 gap-2 md:grid-cols-[minmax(12rem,0.8fr)_minmax(0,1.2fr)]">
          <div
            className="max-h-72 overflow-auto rounded-lg border border-border p-2"
            aria-label={`${catalog.side} source paths`}
          >
            {catalog.entries.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">No retained paths.</p>
            ) : null}
            {catalog.entries.map((entry) => (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto w-full justify-start whitespace-normal break-all text-left font-mono text-xs"
                key={`${entry.path}:${entry.objectId}`}
                disabled={busy}
                onClick={() => {
                  setStartLine("1");
                  setEndLine("1");
                  void readLines(entry.path, 1, 1);
                }}
              >
                {entry.path}
              </Button>
            ))}
          </div>
          <div className="min-w-0 rounded-lg border border-border bg-background p-3">
            {lines === null ? (
              <p className="text-sm text-muted-foreground">
                Choose a path and inspect an exact range.
              </p>
            ) : lines.status === "unsupported" ? (
              <p className="text-sm">This entry is {lines.reason.replaceAll("_", " ")}.</p>
            ) : (
              <>
                <p className="mb-2 break-all text-xs text-muted-foreground">
                  {lines.path} · lines {lines.startLine}–{lines.endLine} of {lines.totalLines}
                </p>
                <pre
                  className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs"
                  tabIndex={0}
                >
                  {lines.text}
                </pre>
              </>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-end gap-2 md:col-span-2">
            <p className="mr-auto text-xs text-muted-foreground">
              Paths {catalog.entries.length === 0 ? 0 : catalog.offset + 1}–
              {catalog.offset + catalog.entries.length} of {catalog.total}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || catalog.offset === 0}
              onClick={() =>
                void readCatalog(catalog.side, Math.max(0, catalog.offset - SOURCE_PAGE_SIZE))
              }
            >
              Previous source page
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || catalog.nextOffset === null}
              onClick={() =>
                catalog.nextOffset === null
                  ? undefined
                  : void readCatalog(catalog.side, catalog.nextOffset)
              }
            >
              Next source page
            </Button>
          </div>
          {selectedPath === null ? null : (
            <div className="grid min-w-0 gap-2 sm:grid-cols-[8rem_8rem_auto] sm:items-end md:col-span-2">
              <label className="grid gap-1 text-xs text-muted-foreground">
                Start line
                <Input
                  aria-label="Start line"
                  type="number"
                  min={1}
                  value={startLine}
                  onChange={(event) => setStartLine(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                End line
                <Input
                  aria-label="End line"
                  type="number"
                  min={1}
                  value={endLine}
                  onChange={(event) => setEndLine(event.target.value)}
                />
              </label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void readLines(selectedPath, Number(startLine), Number(endLine))}
              >
                Read source range
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CheckInspector({
  projectId,
  featureId,
  active,
  loadChecks,
  loadCheck,
  onAuthenticationError,
}: {
  projectId: string;
  featureId: string;
  active: boolean;
  loadChecks: typeof fetchFactoryConceptualReviewChecks;
  loadCheck: typeof fetchFactoryConceptualReviewCheck;
  onAuthenticationError: FeatureReviewPanelProps["onAuthenticationError"];
}) {
  const [catalog, setCatalog] = useState<FactoryConceptualReviewCheckCatalog | null>(null);
  const [detail, setDetail] = useState<FactoryConceptualReviewCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readCatalog = async (offset = 0) => {
    if (!active || busy) return;
    setBusy(true);
    setError(null);
    setDetail(null);
    try {
      setCatalog(await loadChecks(projectId, featureId, offset, CHECK_PAGE_SIZE));
    } catch (failure) {
      if (!onAuthenticationError(failure))
        setError(planningRequestError(failure, "Final verification records are unavailable."));
    } finally {
      setBusy(false);
    }
  };
  const readDetail = async (evidenceId: string) => {
    if (!active || busy) return;
    setBusy(true);
    setError(null);
    try {
      setDetail(await loadCheck(projectId, featureId, evidenceId));
    } catch (failure) {
      if (!onAuthenticationError(failure))
        setError(planningRequestError(failure, "This verification result is unavailable."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4"
      aria-label="Final verification inspector"
    >
      <div>
        <h3 className="font-semibold">Final verification</h3>
        <p className="text-sm text-muted-foreground">
          A passing command records what ran on the exact head. It does not by itself prove every
          product behavior.
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!active || busy}
        onClick={() => void readCatalog(0)}
      >
        Inspect final checks
      </Button>
      {error === null ? null : (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {catalog === null ? null : (
        <div className="grid gap-2">
          <ol className="grid gap-2">
            {catalog.checks.map((check) => (
              <li
                key={check.evidenceId}
                className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background p-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="break-words font-mono text-xs">
                    {[check.command.program, ...check.command.args].join(" ")}
                  </p>
                  <p className="text-muted-foreground">
                    {check.outcome} · {check.durationMs} ms ·{" "}
                    {check.origins.map(({ workItemKey }) => workItemKey).join(", ")}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void readDetail(check.evidenceId)}
                >
                  Open result
                </Button>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <p className="mr-auto text-xs text-muted-foreground">
              Checks {catalog.checks.length === 0 ? 0 : catalog.offset + 1}–
              {catalog.offset + catalog.checks.length} of {catalog.total}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || catalog.offset === 0}
              onClick={() => void readCatalog(Math.max(0, catalog.offset - CHECK_PAGE_SIZE))}
            >
              Previous checks page
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || catalog.nextOffset === null}
              onClick={() =>
                catalog.nextOffset === null ? undefined : void readCatalog(catalog.nextOffset)
              }
            >
              Next checks page
            </Button>
          </div>
        </div>
      )}
      {detail === null ? null : (
        <div className="min-w-0 rounded-lg border border-border bg-background p-3 text-sm">
          <p className="font-medium">Stored command result · {detail.result.outcome}</p>
          <dl className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
            <div>
              <dt>Head</dt>
              <dd className="break-all font-mono">{detail.result.headCommitId}</dd>
            </div>
            <div>
              <dt>Tree</dt>
              <dd className="break-all font-mono">{detail.result.treeId}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            stdout{detail.result.stdoutTruncated ? " · truncated" : ""}
          </p>
          <pre
            className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs"
            tabIndex={0}
          >
            {detail.result.stdout || "(empty)"}
          </pre>
          <p className="mt-3 text-xs text-muted-foreground">
            stderr{detail.result.stderrTruncated ? " · truncated" : ""}
          </p>
          <pre
            className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs"
            tabIndex={0}
          >
            {detail.result.stderr || "(empty)"}
          </pre>
        </div>
      )}
    </section>
  );
}

export function FeatureReviewPanel({
  projectId,
  featureId,
  online,
  onAuthenticationError,
  loadPreparation = fetchFactoryConceptualReviewPreparation,
  loadSourceCatalog = fetchFactoryConceptualReviewSourceCatalog,
  loadSourceLines = fetchFactoryConceptualReviewSourceLines,
  loadChecks = fetchFactoryConceptualReviewChecks,
  loadCheck = fetchFactoryConceptualReviewCheck,
}: FeatureReviewPanelProps) {
  const [preparation, setPreparation] = useState<FactoryConceptualReviewPreparation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const read = useCallback(async () => {
    if (!online) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = await loadPreparation(projectId, featureId, controller.signal);
      if (!controller.signal.aborted) setPreparation(result);
    } catch (failure) {
      if (!controller.signal.aborted && !onAuthenticationError(failure))
        setError(planningRequestError(failure, "Conceptual Review inputs are unavailable."));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [online, loadPreparation, projectId, featureId, onAuthenticationError]);
  useEffect(() => {
    void read();
    return () => request.current?.abort();
  }, [read]);

  if (preparation === null)
    return (
      <section className="workspace-state" aria-busy={loading}>
        <h2>
          {online
            ? loading
              ? "Preparing review"
              : "Review unavailable"
            : "Reconnect to inspect review"}
        </h2>
        {error === null ? null : <p role="alert">{error}</p>}
        <Button
          type="button"
          variant="outline"
          disabled={!online || loading}
          onClick={() => void read()}
        >
          Retry review inputs
        </Button>
      </section>
    );

  const basis = preparation.basis;
  const active = online && preparation.publication !== null && preparation.evidence !== null;
  const inspectionIdentity = [
    preparation.preparationDigest ?? "unprepared",
    preparation.publication?.revision.id ?? "no-revision",
    preparation.publication?.pullRequest.headCommitId ?? "no-head",
    preparation.evidence === null ? "blocked" : "inspectable",
  ].join(":");
  return (
    <div className="mx-auto grid w-full max-w-6xl min-w-0 gap-4 p-4 sm:p-6">
      <section className="grid gap-4 rounded-xl border border-border bg-card p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div className="min-w-0 space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Conceptual review
          </p>
          <h2 className="text-xl font-semibold">Did this Feature deliver what you approved?</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Outcome → behavior → evidence → problem. Start from each approved outcome, follow the
            implemented behavioral steps, inspect exact support, and see gaps or findings without an
            automatic repair.
          </p>
        </div>
        <div className="min-w-60 space-y-2">
          <Button
            type="button"
            className="w-full"
            disabled={!online || !preparation.readiness.startAllowed}
          >
            Start review
          </Button>
          {preparation.readiness.blockers.map((blocker) => (
            <p key={blocker} className="flex gap-2 text-xs text-muted-foreground">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{" "}
              {blockers[blocker]}
            </p>
          ))}
        </div>
      </section>
      {error === null ? null : (
        <p role="alert" className="rounded-lg border border-border p-3 text-sm">
          {error}
        </p>
      )}
      {basis === null ? (
        <section className="rounded-xl border border-border bg-card p-4">
          <h3 className="font-semibold">Approved purpose unavailable</h3>
          <p className="text-sm text-muted-foreground">
            Resolve the preparation blocker before this review can use an immutable Feature plan.
          </p>
        </section>
      ) : (
        <section className="grid gap-4 rounded-xl border border-border bg-card p-4">
          <div>
            <p className="text-xs text-muted-foreground">Approved purpose</p>
            <h3 className="text-lg font-semibold">{basis.objective}</h3>
          </div>
          <div>
            <h4 className="text-sm font-medium">Acceptance outcomes</h4>
            <ol className="mt-2 grid gap-2">
              {basis.outcomes.map((outcome) => (
                <li key={outcome.key} className="rounded-lg border border-border bg-background p-3">
                  <p className="font-medium">{outcome.outcome}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {outcome.key} · {outcome.intent.label}
                  </p>
                </li>
              ))}
            </ol>
          </div>
          <p className="text-xs text-muted-foreground">
            Approved version {basis.provenance.version} · {basis.provenance.author} plan · approved{" "}
            {new Date(basis.provenance.approvedAt).toLocaleString()}
          </p>
        </section>
      )}
      <ExactInputs preparation={preparation} />
      <PreparationDetails preparation={preparation} />
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <SourceInspector
          key={`source:${inspectionIdentity}`}
          projectId={projectId}
          featureId={featureId}
          active={active}
          loadCatalog={loadSourceCatalog}
          loadLines={loadSourceLines}
          onAuthenticationError={onAuthenticationError}
        />
        <CheckInspector
          key={`checks:${inspectionIdentity}`}
          projectId={projectId}
          featureId={featureId}
          active={active}
          loadChecks={loadChecks}
          loadCheck={loadCheck}
          onAuthenticationError={onAuthenticationError}
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-fit"
        disabled={!online || loading}
        onClick={() => void read()}
      >
        <RefreshCw className="size-4" aria-hidden="true" /> Refresh exact inputs
      </Button>
    </div>
  );
}
