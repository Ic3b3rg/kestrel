import { useEffect, useRef, useState } from "react";
import type {
  InstallPlanningSkillCommand,
  PlanningSkillBundle,
  PlanningSkillSummary,
} from "@kestrel/contracts";

import { ApiClientError } from "./api.js";
import { Button } from "./components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog.js";
import { FormFeedback } from "./components/FormFeedback.js";
import { Label } from "./components/ui/label.js";
import { NativeSelect } from "./components/ui/native-select.js";
import { planningRequestError } from "./FeatureNavigation.js";
import {
  fetchPlanningSkill,
  fetchPlanningSkillCandidates,
  fetchPlanningSkillCatalog,
  importPlanningSkill,
} from "./factory-skills-api.js";
import { GitHubPlanningSkillImport } from "./GitHubPlanningSkillImport.js";
import { PlanningSkillContents } from "./PlanningSkillContents.js";

export function PlanningSkillLibrary({
  online,
  onAuthenticationError,
}: {
  online: boolean;
  onAuthenticationError: (error: unknown) => boolean;
}) {
  const [catalog, setCatalog] = useState<PlanningSkillSummary[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [candidates, setCandidates] = useState<Array<{ candidateId: string; label: string }>>([]);
  const [candidatesConfigured, setCandidatesConfigured] = useState(false);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [candidatesRevision, setCandidatesRevision] = useState(0);
  const [candidate, setCandidate] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const importAttempt = useRef<InstallPlanningSkillCommand | null>(null);
  const [previewDigest, setPreviewDigest] = useState<string | null>(null);
  const [preview, setPreview] = useState<PlanningSkillBundle | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const inspectTrigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    setCatalog(null);
    setCatalogError(null);
    setCatalogLoading(true);
    void fetchPlanningSkillCatalog(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setCatalog(result.skills);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError(error))
          setCatalogError(planningRequestError(error, "The Skill Library could not be loaded."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });
    return () => controller.abort();
  }, [catalogRevision, online, onAuthenticationError]);

  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    setCandidatesError(null);
    setCandidatesLoading(true);
    void fetchPlanningSkillCandidates(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setCandidatesConfigured(result.configured);
        setCandidates(result.candidates);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError(error))
          setCandidatesError(
            planningRequestError(error, "Workstation Skills could not be loaded."),
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setCandidatesLoading(false);
      });
    return () => controller.abort();
  }, [candidatesRevision, online, onAuthenticationError]);

  const importCandidate = async (command?: InstallPlanningSkillCommand) => {
    if (!online || importing) return;
    if (command !== undefined) importAttempt.current = command;
    const current = importAttempt.current;
    if (current === null) return;
    setImporting(true);
    setImportError(null);
    setImportSuccess(null);
    try {
      const result = await importPlanningSkill(current);
      importAttempt.current = null;
      setImportSuccess(`Installed $${result.name} · ${result.contentDigest.slice(0, 12)}`);
      setCatalogRevision((value) => value + 1);
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      )
        importAttempt.current = null;
      if (!onAuthenticationError(error))
        setImportError(
          planningRequestError(
            error,
            "Import could not be confirmed. Retry the same request safely.",
          ),
        );
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    if (!online || previewDigest === null) return;
    const controller = new AbortController();
    setPreview(null);
    setPreviewError(null);
    void fetchPlanningSkill(previewDigest, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPreview(result);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError(error))
          setPreviewError(planningRequestError(error, "The retained Skill could not be loaded."));
      });
    return () => controller.abort();
  }, [online, onAuthenticationError, previewDigest, previewRevision]);

  return (
    <section aria-label="Installed Skills" className="grid min-w-0 gap-4 py-5">
      <div className="grid gap-1">
        <h3 className="text-lg font-medium">Installed Skills</h3>
        <p className="text-sm text-muted-foreground">
          Inspect the exact procedures available to Planning Sessions.
        </p>
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <GitHubPlanningSkillImport
          online={online}
          onAuthenticationError={onAuthenticationError}
          onInstalled={() => setCatalogRevision((value) => value + 1)}
        />
        <section
          className="grid content-start gap-3 rounded-lg border p-4"
          aria-label="Import from workstation"
        >
          <div>
            <h3 className="font-semibold">Import from the workstation</h3>
            <p className="text-sm text-muted-foreground">
              Install or refresh a Skill from an authorized folder. Kestrel retains its
              instructions; no installer or Skill script runs.
            </p>
          </div>
          {!online ? (
            <FormFeedback kind="error">Reconnect to import a workstation Skill.</FormFeedback>
          ) : candidatesLoading ? (
            <FormFeedback kind="pending">Loading workstation Skills…</FormFeedback>
          ) : candidatesError !== null ? (
            <div className="grid justify-items-start gap-2">
              <FormFeedback kind="error">{candidatesError}</FormFeedback>
              <Button variant="outline" onClick={() => setCandidatesRevision((value) => value + 1)}>
                Retry workstation Skills
              </Button>
            </div>
          ) : !candidatesConfigured ? (
            <p className="text-sm text-muted-foreground">
              No authorized Skill folder is configured. Set <code>KESTREL_PLANNING_SKILL_ROOT</code>{" "}
              when starting Kestrel.
            </p>
          ) : (
            <>
              <Label htmlFor="library-host-skill-candidate">Available Skills</Label>
              <NativeSelect
                id="library-host-skill-candidate"
                aria-label="Host Skill to import"
                value={candidate}
                disabled={importing || importAttempt.current !== null}
                onChange={(event) => setCandidate(event.currentTarget.value)}
              >
                <option value="">Choose a Skill</option>
                {candidates.map((item) => (
                  <option key={item.candidateId} value={item.candidateId}>
                    {item.label}
                  </option>
                ))}
              </NativeSelect>
              {candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No Skills found in the authorized folder.
                </p>
              ) : null}
              <Button
                variant="outline"
                className="justify-self-start"
                disabled={importing || (candidate === "" && importAttempt.current === null)}
                onClick={() =>
                  void importCandidate(
                    importAttempt.current ?? {
                      requestId: crypto.randomUUID(),
                      candidateId: candidate,
                    },
                  )
                }
              >
                {importing
                  ? "Importing…"
                  : importAttempt.current !== null
                    ? "Retry import"
                    : "Import Skill"}
              </Button>
            </>
          )}
          {importError !== null ? <FormFeedback kind="error">{importError}</FormFeedback> : null}
          {importSuccess !== null ? (
            <FormFeedback kind="success">{importSuccess}</FormFeedback>
          ) : null}
        </section>
      </div>
      {!online ? (
        <FormFeedback kind="error" title="Skill Library is offline">
          Reconnect this workstation to view installed Skills.
        </FormFeedback>
      ) : catalogLoading || (catalog === null && catalogError === null) ? (
        <FormFeedback kind="pending">Loading installed Skills…</FormFeedback>
      ) : catalogError !== null ? (
        <div className="grid justify-items-start gap-3">
          <FormFeedback kind="error" title="Skill Library unavailable">
            {catalogError}
          </FormFeedback>
          <Button variant="outline" onClick={() => setCatalogRevision((value) => value + 1)}>
            Retry Skill Library
          </Button>
        </div>
      ) : catalog?.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Planning Skills are installed yet.</p>
      ) : (
        <ul className="grid gap-3">
          {catalog?.map((skill) => (
            <li key={skill.contentDigest} className="grid min-w-0 gap-3 rounded-md border p-4">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="break-words font-medium">${skill.name}</h4>
                  <p className="break-words text-sm text-muted-foreground">{skill.description}</p>
                </div>
                <Button
                  variant="outline"
                  onClick={(event) => {
                    inspectTrigger.current = event.currentTarget;
                    setPreview(null);
                    setPreviewError(null);
                    setPreviewDigest(skill.contentDigest);
                  }}
                >
                  Inspect {skill.name}
                </Button>
              </div>
              <p className="break-words text-xs text-muted-foreground">
                {skill.source.kind === "host" ? "Workstation" : "GitHub"} · {skill.source.label} ·
                Version <code title={skill.contentDigest}>{skill.contentDigest.slice(0, 12)}</code>
              </p>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={previewDigest !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewDigest(null);
        }}
      >
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            inspectTrigger.current?.focus();
          }}
        >
          <DialogTitle>Installed Skill instructions</DialogTitle>
          <DialogDescription>
            This is the retained version Kestrel can use for planning.
          </DialogDescription>
          {!online ? (
            <FormFeedback kind="error">Reconnect to inspect this Skill.</FormFeedback>
          ) : previewError !== null ? (
            <div className="grid justify-items-start gap-3">
              <FormFeedback kind="error">{previewError}</FormFeedback>
              <Button variant="outline" onClick={() => setPreviewRevision((value) => value + 1)}>
                Retry instructions
              </Button>
            </div>
          ) : preview === null ? (
            <FormFeedback kind="pending">Loading retained instructions…</FormFeedback>
          ) : (
            <PlanningSkillContents key={preview.contentDigest} bundle={preview} />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
