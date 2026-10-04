import { useEffect, useRef, useState } from "react";
import { InterviewSkillPicker } from "./InterviewSkillPicker.js";
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
  onReadyChange,
  onAuthenticationError,
}: {
  projectId: string;
  featureId: string;
  selection: FeaturePlanningSkills;
  online: boolean;
  editable: boolean;
  onChanged: (
    selection?: FeaturePlanningSkills,
  ) => boolean | undefined | Promise<boolean | undefined>;
  onReadyChange?: (ready: boolean) => void;
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
    if (!submitting.current) onReadyChange?.(true);
  }, [selection.version, onReadyChange]);

  const select = async (digest?: string) => {
    if (!online || !editable || submitting.current) return;
    if (digest !== undefined) {
      attempt.current = {
        requestId: crypto.randomUUID(),
        expectedVersion: selection.version,
        digests: [digest],
      };
    }
    const command = attempt.current;
    if (command === null) return;
    submitting.current = true;
    onReadyChange?.(false);
    setPending(true);
    setError(null);
    setStale(false);
    let confirmed = false;
    try {
      const selected = await selectPlanningSkills(projectId, featureId, command);
      attempt.current = null;
      confirmed = (await onChanged(selected)) !== false;
      if (!confirmed) {
        setStale(true);
        setError("Refresh the conversation to confirm the Skills before sending a message.");
      }
    } catch (failure) {
      if (failure instanceof ApiClientError && failure.status === 409) {
        attempt.current = null;
        setStale(true);
        setError("The active Skills changed. Refresh the conversation before choosing a Skill.");
      } else if (!onAuthenticationError(failure)) {
        setError(
          planningRequestError(
            failure,
            "Selection could not be confirmed. Retry the same request safely.",
          ),
        );
      }
    } finally {
      submitting.current = false;
      setPending(false);
      onReadyChange?.(confirmed);
    }
  };

  const refreshSelection = async () => {
    if (!online || submitting.current) return;
    submitting.current = true;
    setPending(true);
    onReadyChange?.(false);
    let confirmed = false;
    try {
      confirmed = (await onChanged()) !== false;
      if (confirmed) {
        setStale(false);
        setError(null);
        attempt.current = null;
      }
    } catch (failure) {
      if (!onAuthenticationError(failure))
        setError(
          planningRequestError(failure, "The Skills could not be refreshed. Retry refresh."),
        );
    } finally {
      submitting.current = false;
      setPending(false);
      onReadyChange?.(confirmed);
    }
  };

  return (
    <section aria-label="Active interview skill" className="grid min-w-0 gap-2">
      <InterviewSkillPicker
        skills={selection.skills}
        online={online}
        disabled={!editable || pending || stale}
        onSelect={(skill) => void select(skill.contentDigest)}
        onAuthenticationError={onAuthenticationError}
      />
      {pending ? (
        <FormFeedback kind="pending">Updating the Skills for the next message…</FormFeedback>
      ) : null}
      {error !== null ? (
        <div className="grid justify-items-start gap-2">
          <FormFeedback kind="error" focus>
            {error}
          </FormFeedback>
          {stale ? (
            <Button
              type="button"
              variant="outline"
              disabled={!online || pending}
              onClick={() => void refreshSelection()}
            >
              Refresh Skills
            </Button>
          ) : attempt.current !== null ? (
            <Button
              type="button"
              variant="outline"
              disabled={!online || !editable || pending}
              onClick={() => void select()}
            >
              Retry selection
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
