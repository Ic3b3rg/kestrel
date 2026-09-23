import { useEffect, useRef, useState } from "react";
import type { PlanningSkillBundle, PlanningSkillSummary } from "@kestrel/contracts";

import { Button } from "./components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog.js";
import { FormFeedback } from "./components/FormFeedback.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { fetchPlanningSkill, fetchPlanningSkillCatalog } from "./factory-skills-api.js";
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
