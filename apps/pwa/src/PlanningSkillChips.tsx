import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { FeaturePlanningSkills, SelectPlanningSkillsCommand } from "@kestrel/contracts";
import { ApiClientError } from "./api.js";
import { Button } from "./components/ui/button.js";
import { FormFeedback } from "./components/FormFeedback.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { selectPlanningSkills } from "./factory-skills-api.js";

export function PlanningSkillChips({
  projectId,
  featureId,
  selection,
  online,
  editable,
  onChanged,
  onAuthenticationError,
}: {
  projectId: string;
  featureId: string;
  selection: FeaturePlanningSkills;
  online: boolean;
  editable: boolean;
  onChanged: () => void | Promise<void>;
  onAuthenticationError: (error: unknown) => boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const attempt = useRef<SelectPlanningSkillsCommand | null>(null);
  const submitting = useRef(false);

  useEffect(() => {
    setError(null);
    setStale(false);
    attempt.current = null;
  }, [selection.version]);

  const remove = async (digest?: string) => {
    if (!online || !editable || submitting.current) return;
    if (digest !== undefined) {
      attempt.current = {
        requestId: crypto.randomUUID(),
        expectedVersion: selection.version,
        digests: selection.skills
          .filter((skill) => skill.contentDigest !== digest)
          .map((skill) => skill.contentDigest),
      };
    }
    const command = attempt.current;
    if (command === null) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    setStale(false);
    try {
      await selectPlanningSkills(projectId, featureId, command);
      attempt.current = null;
      await onChanged();
    } catch (failure) {
      if (failure instanceof ApiClientError && failure.status === 409) {
        attempt.current = null;
        setStale(true);
        setError("The active Skills changed. Refresh the conversation before removing a Skill.");
      } else if (!onAuthenticationError(failure)) {
        setError(
          planningRequestError(
            failure,
            "Removal could not be confirmed. Retry the same request safely.",
          ),
        );
      }
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  if (selection.skills.length === 0) return null;
  return (
    <section aria-label="Active Planning Skills" className="grid min-w-0 gap-2">
      <ul className="flex min-w-0 flex-wrap gap-2">
        {selection.skills.map((skill) => (
          <li
            key={skill.contentDigest}
            className="flex min-w-0 items-center gap-1 rounded-full border bg-muted px-2 py-1 text-sm"
          >
            <span className="break-all">${skill.name}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${skill.name}`}
              disabled={!online || !editable || pending || attempt.current !== null || stale}
              onClick={() => void remove(skill.contentDigest)}
            >
              <X aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      {!editable ? (
        <p className="text-xs text-muted-foreground">
          Skills can be removed after the current reply finishes.
        </p>
      ) : null}
      {pending ? (
        <FormFeedback kind="pending">Updating the Skills for the next message…</FormFeedback>
      ) : null}
      {error !== null ? (
        <div className="grid justify-items-start gap-2">
          <FormFeedback kind="error" focus>
            {error}
          </FormFeedback>
          {stale ? (
            <Button type="button" variant="outline" onClick={() => void onChanged()}>
              Refresh Skills
            </Button>
          ) : attempt.current !== null ? (
            <Button
              type="button"
              variant="outline"
              disabled={!online || !editable || pending}
              onClick={() => void remove()}
            >
              Retry removal
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
