import { FormFeedback } from "./components/FormFeedback.js";
import { useEffect, useState } from "react";
import type { PlanningSkillBundle, PlanningSkillSummary } from "@kestrel/contracts";
import { Button } from "./components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { PlanningSkillContents } from "./PlanningSkillContents.js";
import { fetchPlanningSkill } from "./factory-skills-api.js";

const ignoreAuthenticationError = () => false;
export function SkillProvenance({
  skills,
  onAuthenticationError = ignoreAuthenticationError,
}: {
  skills: PlanningSkillSummary[];
  onAuthenticationError?: (error: unknown) => boolean;
}) {
  const [preview, setPreview] = useState<PlanningSkillBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  useEffect(() => {
    if (digest === null) return;
    const controller = new AbortController();
    setPreview(null);
    setError(null);
    void fetchPlanningSkill(digest, controller.signal)
      .then((bundle) => {
        if (!controller.signal.aborted) setPreview(bundle);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError(failure))
          setError(planningRequestError(failure, "The retained Skill could not be loaded."));
      });
    return () => controller.abort();
  }, [digest, onAuthenticationError]);
  if (skills.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 text-xs" aria-label="Skills used for this artifact">
      {skills.map((skill) => (
        <Button
          key={skill.contentDigest}
          size="sm"
          variant="ghost"
          onClick={() => setDigest(skill.contentDigest)}
        >
          Used ${skill.name} · {skill.contentDigest.slice(0, 8)}
        </Button>
      ))}
      <Dialog
        open={digest !== null}
        onOpenChange={(value) => {
          if (!value) setDigest(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
          <DialogTitle>Skill used for this artifact</DialogTitle>
          <DialogDescription>
            The retained instructions remain available when the catalog changes.
          </DialogDescription>
          {error === null ? (
            preview === null ? (
              <p role="status">Loading instructions…</p>
            ) : (
              <PlanningSkillContents bundle={preview} />
            )
          ) : (
            <FormFeedback kind="error" focus>
              {error}
            </FormFeedback>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
