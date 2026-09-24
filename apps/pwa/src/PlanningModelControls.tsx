import { useEffect, useState } from "react";
import {
  resolveLifecycleProfile,
  LifecycleSettingsSchema,
  type LifecycleProfileView,
  type PlanningComposerSettings,
} from "@kestrel/contracts";
import { fetchLifecycleProfile } from "./LifecycleProfilePanel.js";
import { FormFeedback } from "./components/FormFeedback.js";
import { Button } from "./components/ui/button.js";
import { NativeSelect } from "./components/ui/native-select.js";

export interface PlanningModelControlsProps {
  projectId: string;
  online: boolean;
  disabled: boolean;
  savedSettings?: PlanningComposerSettings;
  onSettingsChange: (settings: PlanningComposerSettings) => void;
  onReady: (ready: boolean) => void;
}

export function PlanningModelControls({
  projectId,
  online,
  disabled,
  savedSettings,
  onSettingsChange,
  onReady,
}: PlanningModelControlsProps) {
  const [view, setView] = useState<LifecycleProfileView | null>(null);
  const [draft, setDraft] = useState<PlanningComposerSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setView(null);
    setError(null);
    if (online)
      void fetchLifecycleProfile("planning", projectId, controller.signal)
        .then((next) => {
          if (!controller.signal.aborted) setView(next);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError("Models could not be loaded. Retry to reconnect.");
        });
    return () => controller.abort();
  }, [projectId, online, reload]);
  const settings = draft ?? savedSettings ?? {};
  let blocked = error;
  let resolved: ReturnType<typeof resolveLifecycleProfile> | null = null;
  if (view !== null) {
    try {
      resolved = resolveLifecycleProfile(
        view.defaults,
        { ...view.overrides, ...settings },
        view.models,
      );
      // An explicit chat choice can repair a stale model/effort default, not authentication or Skills.
      if (
        view.blocked !== null &&
        !/^The selected (model|effort) is unavailable/u.test(view.blocked)
      )
        blocked = view.blocked;
    } catch (failure) {
      blocked =
        failure instanceof Error
          ? failure.message.replace("in Lifecycle settings", "below")
          : "Choose an available model and effort.";
    }
  }
  const ready = online && view !== null && resolved !== null && blocked === null;
  useEffect(() => onReady(ready), [ready, onReady]);
  const requested =
    view === null
      ? null
      : LifecycleSettingsSchema.parse({ ...view.defaults, ...view.overrides, ...settings });
  const modelId =
    requested?.model.kind === "explicit" ? requested.model.value : (resolved?.modelId ?? "");
  const model = view?.models.find((item) => item.id === modelId);
  const effort = requested?.effort.kind === "explicit" ? requested.effort.value : "";
  const update = (next: PlanningComposerSettings) => {
    setDraft(next);
    onSettingsChange(next);
  };
  return (
    <div
      className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
      aria-label="Conversation model"
    >
      <span className="text-xs text-muted-foreground">Codex</span>
      <NativeSelect
        aria-label="Model"
        className="w-auto max-w-full flex-1 sm:flex-none"
        disabled={disabled || !online || view === null}
        value={modelId}
        onChange={(event) =>
          update({ ...settings, model: { kind: "explicit", value: event.target.value } })
        }
      >
        {modelId === "" ? <option value="">{online ? "Loading models…" : "Offline"}</option> : null}
        {modelId !== "" && model === undefined ? (
          <option value={modelId}>{modelId} · unavailable</option>
        ) : null}
        {view?.models.map((item) => (
          <option key={item.id} value={item.id}>
            {item.displayName}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Reasoning effort"
        className="w-auto max-w-full"
        value={effort}
        disabled={disabled || !online || model === undefined}
        onChange={(event) =>
          update({
            ...settings,
            effort:
              event.target.value === ""
                ? { kind: "runtime_default" }
                : { kind: "explicit", value: event.target.value },
          })
        }
      >
        <option value="">{model?.defaultReasoningEffort ?? "Default effort"} · default</option>
        {effort !== "" &&
        !model?.supportedReasoningEfforts?.some((item) => item.reasoningEffort === effort) ? (
          <option value={effort}>{effort} · unavailable</option>
        ) : null}
        {model?.supportedReasoningEfforts?.map((item) => (
          <option key={item.reasoningEffort} value={item.reasoningEffort}>
            {item.reasoningEffort}
          </option>
        ))}
      </NativeSelect>
      {blocked === null ? null : (
        <div className="basis-full">
          <FormFeedback kind="error">{blocked}</FormFeedback>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!online || disabled}
            onClick={() => setReload((value) => value + 1)}
          >
            Reload models
          </Button>
        </div>
      )}
    </div>
  );
}
