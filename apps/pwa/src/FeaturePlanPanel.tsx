import { useCallback, useEffect, useRef, useState } from "react";
import {
  FeaturePlanDocumentSchema,
  validateFeaturePlan,
  type FeaturePlanDocument,
  type FeaturePlans,
  type FeaturePlanVersion,
  type SaveFeaturePlanCommand,
  type FactoryIssueImports,
} from "@kestrel/contracts";
import {
  ApiClientError,
  approveFeaturePlan,
  cancelFeature,
  cancelPlanningTurn,
  fetchFeaturePlans,
  fetchFactoryIssueImports,
  fetchFeaturePlanVersion,
  generateFeaturePlan,
  retryPlanningTurn,
  saveFeaturePlan,
} from "./api.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { DocumentInspector, failures, pendingTurn } from "./PlanningDetails.js";
import { ProposedDocumentsInspector } from "./FeaturePlanDocuments.js";
import {
  emptyFeaturePlan,
  FeaturePlanDocumentView,
  FeaturePlanEditor,
} from "./FeaturePlanDocument.js";
import { Button } from "./components/ui/button.js";
import { Label } from "./components/ui/label.js";
import { NativeSelect } from "./components/ui/native-select.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog.js";

type VersionCommand = { requestId: string; expectedVersion: number | null };
type PlanAttempt =
  | { kind: "save"; command: SaveFeaturePlanCommand }
  | { kind: "generate"; command: VersionCommand & { skillSelectionVersion?: number } }
  | { kind: "cancel"; command: VersionCommand }
  | { kind: "approve"; version: number; requestId: string }
  | { kind: "retry"; turnId: string; requestId: string }
  | { kind: "stop"; turnId: string };
type Draft = { plan: FeaturePlanDocument; baseVersion: number | null };

function planErrors(plan: FeaturePlanDocument): string[] {
  const parsed = FeaturePlanDocumentSchema.safeParse(plan);
  if (parsed.success) return validateFeaturePlan(parsed.data);
  const labels: Record<string, string> = {
    objective: "Objective",
    scope: "Scope",
    includes: "Included scope",
    excludes: "Excluded scope",
    acceptance: "Acceptance",
    outcome: "Outcome",
    workItems: "Work Item",
    key: "Key",
    title: "Title",
    description: "Description",
    requirementKeys: "Requirements",
    dependsOn: "Dependencies",
    verification: "Verification",
    program: "Program",
    args: "Arguments",
    cwd: "Project directory",
    timeoutSeconds: "Timeout",
    limits: "Execution limits",
    maxConcurrentProjects: "Concurrent Projects",
    maxActiveFeaturesPerProject: "Active features per Project",
    attemptTimeoutSeconds: "Attempt limit",
    proposedDocuments: "Proposed document",
    path: "Path",
    markdown: "Markdown",
    workItemKey: "Owning Work Item",
  };
  return parsed.error.issues.map(
    (issue) =>
      `${issue.path.map((part) => (typeof part === "number" ? String(part + 1) : (labels[String(part)] ?? String(part)))).join(" · ")}: ${issue.message}`,
  );
}

function PlanArtifacts({ version }: { version: FeaturePlanVersion }) {
  return (
    <div className="plan-actions">
      {(["Plan Markdown", "Spec Markdown"] as const).map((label) => (
        <Dialog key={label}>
          <DialogTrigger asChild>
            <Button variant="outline">{label}</Button>
          </DialogTrigger>
          <DialogContent className="planning-documents-dialog max-h-[85dvh] overflow-y-auto sm:max-w-4xl">
            <DialogTitle>
              {label} · version {version.version}
            </DialogTitle>
            <DialogDescription>
              Saved with this immutable version. Approval preserves these artifacts.
            </DialogDescription>
            <pre className="plan-artifact" tabIndex={0} aria-label={`${label} contents`}>
              {label === "Plan Markdown" ? version.planMarkdown : version.specMarkdown}
            </pre>
          </DialogContent>
        </Dialog>
      ))}
      <DocumentInspector
        context={version.sourceContext}
        label="Plan source documents"
        emptyMessage="No source snapshot was recorded for this plan version."
      />
      {(version.document.proposedDocuments?.length ?? 0) === 0 ? null : (
        <ProposedDocumentsInspector version={version} />
      )}
    </div>
  );
}

export interface FeaturePlanPanelProps {
  projectId: string;
  featureId: string;
  online: boolean;
  visible: boolean;
  conversationPending: boolean;
  onAuthenticationError: (error: unknown) => boolean;
  onChanged: () => void;
  onApproved: () => void;
  onDirtyChange: (dirty: boolean) => void;
  importsRevision?: number;
  skillSelectionVersion?: number;
  loadPlans?: typeof fetchFeaturePlans;
  loadImports?: typeof fetchFactoryIssueImports;
  savePlan?: typeof saveFeaturePlan;
  approvePlan?: typeof approveFeaturePlan;
}

export function FeaturePlanPanel({
  skillSelectionVersion,
  projectId,
  featureId,
  online,
  visible,
  conversationPending,
  onAuthenticationError,
  onChanged,
  onApproved,
  onDirtyChange,
  importsRevision = 0,
  loadPlans = fetchFeaturePlans,
  loadImports = fetchFactoryIssueImports,
  savePlan = saveFeaturePlan,
  approvePlan = approveFeaturePlan,
}: FeaturePlanPanelProps) {
  const [plans, setPlans] = useState<FeaturePlans | null>(null);
  const [imports, setImports] = useState<FactoryIssueImports | null>(null);
  const [displayed, setDisplayed] = useState<FeaturePlanVersion | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const alive = useRef(true);
  const activeRead = useRef<AbortController | null>(null);
  const command = useRef<PlanAttempt | null>(null);
  const submitting = useRef(false);
  const dirty =
    draft !== null &&
    (draft.baseVersion === null ||
      JSON.stringify(draft.plan) !== JSON.stringify(displayed?.document));
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      activeRead.current?.abort();
    };
  }, []);

  const refresh = useCallback(
    async (replaceDisplayed = false) => {
      if (!online) return;
      const controller = new AbortController();
      activeRead.current?.abort();
      activeRead.current = controller;
      setReading(true);
      setReadError(null);
      try {
        const [result, sources] = await Promise.all([
          loadPlans(projectId, featureId, controller.signal),
          loadImports(projectId, featureId, controller.signal),
        ]);
        if (!alive.current || controller.signal.aborted) return;
        if (result.feature.id !== featureId || sources.feature.id !== featureId)
          throw new Error("The response contains a different feature");
        setPlans(result);
        setImports(sources);
        setDisplayed((current) =>
          replaceDisplayed ? result.current : (current ?? result.current),
        );
      } catch (failure) {
        if (alive.current && !controller.signal.aborted && !onAuthenticationError(failure))
          setReadError(
            planningRequestError(failure, "The plan could not be loaded. Refresh to retry."),
          );
      } finally {
        if (alive.current && activeRead.current === controller) setReading(false);
      }
    },
    [online, loadPlans, loadImports, projectId, featureId, onAuthenticationError],
  );
  useEffect(() => {
    if (visible) void refresh();
  }, [visible, refresh, importsRevision]);
  const generation = plans?.generation;
  useEffect(() => {
    if (!visible || !online || !pendingTurn(generation ?? undefined) || readError !== null) return;
    const timer = window.setTimeout(() => void refresh(true), 1000);
    return () => window.clearTimeout(timer);
  }, [visible, online, generation, readError, refresh, plans]);

  const run = async (next?: PlanAttempt) => {
    if (!online || submitting.current) return;
    if (next !== undefined) command.current = next;
    const attempt = command.current;
    if (attempt === null) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      if (attempt.kind === "save") {
        const result = await savePlan(projectId, featureId, attempt.command);
        if (alive.current) {
          setDisplayed(result);
          setDraft(null);
        }
      } else if (attempt.kind === "generate")
        await generateFeaturePlan(projectId, featureId, attempt.command);
      else if (attempt.kind === "approve")
        await approvePlan(projectId, featureId, attempt.version, { requestId: attempt.requestId });
      else if (attempt.kind === "cancel")
        await cancelFeature(projectId, featureId, attempt.command);
      else if (attempt.kind === "retry")
        await retryPlanningTurn(projectId, featureId, attempt.turnId, {
          requestId: attempt.requestId,
        });
      else await cancelPlanningTurn(projectId, featureId, attempt.turnId);
      if (!alive.current) return;
      command.current = null;
      setUncertain(false);
      setCancelOpen(false);
      setValidation([]);
      await refresh(attempt.kind === "generate" || attempt.kind === "retry");
      onChanged();
      if (attempt.kind === "approve") onApproved();
    } catch (failure) {
      if (alive.current && !onAuthenticationError(failure)) {
        const rejected =
          failure instanceof ApiClientError && failure.status >= 400 && failure.status < 500;
        if (rejected) command.current = null;
        setUncertain(!rejected);
        setError(
          planningRequestError(
            failure,
            "Kestrel could not confirm this request. Retry the same request safely.",
          ),
        );
        void refresh();
        onChanged();
      }
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const loadLatest = () => {
    if (
      draft !== null &&
      !window.confirm("Discard unsaved plan edits and load the latest version?")
    )
      return;
    setDraft(null);
    setValidation([]);
    setError(null);
    setUncertain(false);
    command.current = null;
    void refresh(true);
  };
  const selectVersion = async (version: number) => {
    if (draft !== null && !window.confirm("Discard unsaved plan edits and open another version?"))
      return;
    const controller = new AbortController();
    activeRead.current?.abort();
    activeRead.current = controller;
    setReading(true);
    setReadError(null);
    try {
      const result = await fetchFeaturePlanVersion(
        projectId,
        featureId,
        version,
        controller.signal,
      );
      if (!alive.current || controller.signal.aborted) return;
      if (result.featureId !== featureId || result.version !== version)
        throw new Error("Unexpected plan version");
      setDisplayed(result);
      setDraft(null);
      setValidation([]);
      setError(null);
    } catch (failure) {
      if (alive.current && !controller.signal.aborted && !onAuthenticationError(failure))
        setReadError(planningRequestError(failure, "This version could not be loaded."));
    } finally {
      if (alive.current && activeRead.current === controller) setReading(false);
    }
  };
  const save = () => {
    if (draft === null) return;
    const errors = planErrors(draft.plan);
    setValidation(errors);
    if (errors.length > 0) return;
    void run({
      kind: "save",
      command: {
        requestId: crypto.randomUUID(),
        expectedVersion: draft.baseVersion,
        plan: draft.plan,
      },
    });
  };

  const planning = plans?.feature.state === "planning";
  const pending = conversationPending || pendingTurn(generation ?? undefined);
  const controlsDisabled = !online || busy || uncertain || reading || readError !== null;
  const currentVersion = plans?.current?.version ?? null;
  const latestDisplayed = displayed?.version === currentVersion;
  const visiblePlan = draft?.plan ?? displayed?.document;
  const assignmentProblems: string[] = [];
  if (visiblePlan !== undefined && imports !== null) {
    for (const source of imports.issues) {
      const count = visiblePlan.workItems.filter(
        (item) => item.importedIssueId === source.id,
      ).length;
      if (count === 0)
        assignmentProblems.push(
          `Assign #${String(source.issue.number)} · ${source.issue.title} to a Work Item`,
        );
      else if (count > 1)
        assignmentProblems.push(`Assign #${String(source.issue.number)} to only one Work Item`);
    }
    for (const item of visiblePlan.workItems) {
      if (
        item.importedIssueId !== null &&
        !imports.issues.some((source) => source.id === item.importedIssueId)
      )
        assignmentProblems.push(`Update the unavailable imported issue in ${item.key}`);
    }
  }
  return (
    <section className="feature-plan-panel" aria-label="Feature plan">
      <header className="plan-panel-header">
        <div>
          <h2>
            {draft === null
              ? displayed === null
                ? "No plan yet"
                : `Plan · version ${String(displayed.version)}`
              : "Unsaved draft"}
          </h2>
          <p>
            {draft !== null
              ? `Your edits are based on ${draft.baseVersion === null ? "a new plan" : `version ${String(draft.baseVersion)}`}. Save a new version before approval.`
              : displayed === null
                ? "Generate a plan from the conversation, or write one here."
                : `${displayed.author === "assistant" ? "Generated by Kestrel" : "Saved by you"} · ${new Date(displayed.createdAt).toLocaleString()}`}
          </p>
        </div>
        <Button variant="outline" disabled={!online || busy || reading} onClick={loadLatest}>
          Load latest version
        </Button>
      </header>
      {readError === null ? null : (
        <p role="alert" className="planning-error">
          {readError}
        </p>
      )}
      {plans === null && reading ? <p role="status">Loading the plan…</p> : null}
      {plans?.feature.state === "cancelled" ? (
        <p className="planning-notice">This feature is cancelled.</p>
      ) : plans?.approval == null ? null : (
        <p className="planning-notice">
          Version {plans.approval.version} is approved. Its scope and limits are frozen.
        </p>
      )}
      {displayed !== null && !latestDisplayed ? (
        <p className="planning-notice">
          A newer version is available. Load the latest version before editing or approval.
        </p>
      ) : null}
      {conversationPending && !pendingTurn(generation ?? undefined) ? (
        <p className="planning-notice" role="status">
          The conversation is still running. Wait for its reply, or stop planning in Chat.
        </p>
      ) : null}
      {generation == null || generation.state === "completed" ? null : (
        <div className="planning-turn-state" role="status">
          <strong>
            {pendingTurn(generation)
              ? "Generating the plan"
              : generation.failure === null
                ? "Plan generation stopped"
                : failures[generation.failure].title}
          </strong>
          <p>
            {pendingTurn(generation)
              ? "You can leave this page. Generation continues on the workstation."
              : generation.failure === null
                ? "Your saved plan is unchanged."
                : failures[generation.failure].detail}
          </p>
          {generation.question === null ? null : (
            <blockquote className="planning-question">{generation.question}</blockquote>
          )}
          {planning && draft === null ? (
            <div className="plan-actions">
              <Button
                variant="outline"
                disabled={controlsDisabled || (conversationPending && !pendingTurn(generation))}
                onClick={() =>
                  void run(
                    pendingTurn(generation)
                      ? { kind: "stop", turnId: generation.id }
                      : { kind: "retry", turnId: generation.id, requestId: crypto.randomUUID() },
                  )
                }
              >
                {pendingTurn(generation) ? "Stop generation" : "Retry generation"}
              </Button>
            </div>
          ) : null}
        </div>
      )}
      {error === null ? null : (
        <div role="alert" className="planning-command-error">
          <p>{error}</p>
          {draft === null ? null : <p>Your unsaved edits are retained.</p>}
          {uncertain ? (
            <Button variant="outline" disabled={!online || busy} onClick={() => void run()}>
              Retry request
            </Button>
          ) : null}
        </div>
      )}
      {validation.length === 0 ? null : (
        <div role="alert" className="planning-command-error">
          <p>Resolve these plan problems before saving:</p>
          <ul>
            {validation.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      {assignmentProblems.length === 0 ? null : (
        <div className="planning-notice" role="status">
          <p>Before approval:</p>
          <ul>
            {assignmentProblems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {draft !== null ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          noValidate
        >
          <FeaturePlanEditor
            plan={draft.plan}
            importedIssues={imports?.issues ?? []}
            disabled={controlsDisabled || !planning || pending}
            onChange={(plan) => setDraft({ ...draft, plan })}
          />
          <div className="plan-actions plan-save-actions">
            <Button type="submit" disabled={controlsDisabled || !planning || pending}>
              {busy ? "Saving…" : "Save new version"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || uncertain}
              onClick={() => {
                if (window.confirm("Discard these unsaved plan edits?")) {
                  setDraft(null);
                  setValidation([]);
                  setError(null);
                }
              }}
            >
              Discard edits
            </Button>
          </div>
        </form>
      ) : (
        <>
          {displayed === null ? null : (
            <>
              <PlanArtifacts version={displayed} />
              <FeaturePlanDocumentView
                plan={displayed.document}
                importedIssues={imports?.issues ?? []}
              />
            </>
          )}
          {planning ? (
            <div className="plan-actions">
              <Button
                variant={displayed === null ? "default" : "outline"}
                disabled={controlsDisabled || pending || (displayed !== null && !latestDisplayed)}
                onClick={() =>
                  void run({
                    kind: "generate",
                    command: {
                      requestId: crypto.randomUUID(),
                      expectedVersion: currentVersion,
                      ...(skillSelectionVersion === undefined ? {} : { skillSelectionVersion }),
                    },
                  })
                }
              >
                {displayed === null ? "Generate plan" : "Regenerate plan"}
              </Button>
              <Button
                variant="outline"
                disabled={controlsDisabled || pending || (displayed !== null && !latestDisplayed)}
                onClick={() => {
                  setDraft({
                    plan: displayed?.document ?? emptyFeaturePlan(),
                    baseVersion: currentVersion,
                  });
                  setError(null);
                }}
              >
                {displayed === null ? "Write a plan" : "Edit draft"}
              </Button>
            </div>
          ) : null}
          {displayed === null || plans?.approval != null || !planning ? null : (
            <section className="plan-approval" aria-label="Approve this plan">
              <h3>Approve this exact version</h3>
              <p>
                Authorize the scope, ordered Work Items and execution limits shown above. Approval
                queues this feature and publishes its GitHub issues. Imported issues are reused.
                Execution is not available yet.
              </p>
              <p>
                {displayed.document.workItems.length} Work Items ·{" "}
                {displayed.document.limits.maxConcurrentProjects} concurrent Projects · 1 active
                feature per Project · {displayed.document.limits.attemptTimeoutSeconds / 60} minutes
                per attempt
              </p>
              <Button
                disabled={
                  controlsDisabled ||
                  pending ||
                  !latestDisplayed ||
                  imports === null ||
                  assignmentProblems.length > 0 ||
                  planErrors(displayed.document).length > 0
                }
                onClick={() =>
                  void run({
                    kind: "approve",
                    version: displayed.version,
                    requestId: crypto.randomUUID(),
                  })
                }
              >
                Approve version {displayed.version}
              </Button>
            </section>
          )}
        </>
      )}
      {plans === null || plans.versions.length === 0 ? null : (
        <div className="plan-version-select">
          <Label htmlFor="plan-version">Saved version</Label>
          <NativeSelect
            id="plan-version"
            value={displayed?.version ?? ""}
            disabled={controlsDisabled}
            onChange={(event) => void selectVersion(Number(event.target.value))}
          >
            {plans.versions.map((version) => (
              <option key={version.version} value={version.version}>
                Version {version.version} · {version.author === "assistant" ? "Kestrel" : "You"}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      {plans === null || plans.feature.state === "cancelled" ? null : (
        <Dialog
          open={cancelOpen}
          onOpenChange={(open) => {
            if (!busy) setCancelOpen(open);
          }}
        >
          <DialogTrigger asChild>
            <Button
              className="justify-self-start"
              variant="outline"
              disabled={controlsDisabled || draft !== null}
            >
              Cancel feature
            </Button>
          </DialogTrigger>
          <DialogContent
            showCloseButton={!busy}
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (busy) event.preventDefault();
            }}
          >
            <DialogTitle>Cancel this feature?</DialogTitle>
            <DialogDescription>
              Stop its planning and queued work. Saved messages, plans and Work Items remain
              available for inspection.
            </DialogDescription>
            <p>
              Feature: {plans.feature.title}. Current plan:{" "}
              {currentVersion === null ? "none" : `version ${String(currentVersion)}`}.
            </p>
            {error === null ? null : (
              <p role="alert" className="planning-error">
                {error}
              </p>
            )}
            <Button
              disabled={!online || busy}
              onClick={() =>
                void run(
                  uncertain
                    ? undefined
                    : {
                        kind: "cancel",
                        command: {
                          requestId: crypto.randomUUID(),
                          expectedVersion: currentVersion,
                        },
                      },
                )
              }
            >
              {busy ? "Cancelling…" : "Cancel feature"}
            </Button>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
