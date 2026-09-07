import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CodexReviewModelPreference,
  CodexSubscriptionConnection,
  SelectCodexReviewModelCommand,
} from "@kestrel/contracts";

import { fetchCodexReviewModelPreference, selectCodexReviewModel } from "./api.js";

export interface CodexReviewModelPanelProps {
  connection: CodexSubscriptionConnection | null;
  connectionLoading: boolean;
  loadPreference?: (signal?: AbortSignal) => Promise<CodexReviewModelPreference>;
  onAuthenticationError?: (error: unknown) => boolean;
  online: boolean;
  onVerify: () => void;
  selectPreference?: (
    command: SelectCodexReviewModelCommand,
    signal?: AbortSignal,
  ) => Promise<CodexReviewModelPreference>;
}

const connectionMessages: Partial<
  Record<NonNullable<CodexSubscriptionConnection["reason"]>, string>
> = {
  authentication_required:
    "Codex authentication is required before its model catalog is available.",
  chatgpt_subscription_required: "A ChatGPT subscription connection is required for this route.",
  cli_not_installed: "Install Codex before loading the model catalog.",
  cli_version_unsupported: "Update Codex before loading the model catalog.",
  model_catalog_empty:
    "No picker-visible models are available. Refresh the live catalog or update Codex.",
  protocol_unsupported: "Update Codex to a compatible App Server protocol.",
  timed_out: "The Codex model catalog timed out.",
  unexpected_response: "Codex returned an invalid model catalog.",
  usage_limit_reached: "Usage limit reached. The catalog remains visible, but reviews cannot run.",
  waiting_for_usage_reset: "Waiting for the trustworthy usage reset reported by Codex.",
};

export function CodexReviewModelPanel({
  connection,
  connectionLoading,
  loadPreference = fetchCodexReviewModelPreference,
  onAuthenticationError,
  online,
  onVerify,
  selectPreference = selectCodexReviewModel,
}: CodexReviewModelPanelProps) {
  const [preference, setPreference] = useState<CodexReviewModelPreference | null>(null);
  const [draftModelId, setDraftModelId] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const activeLoad = useRef<AbortController | null>(null);
  const activeSave = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!online) return;
    const controller = new AbortController();
    activeLoad.current?.abort();
    activeLoad.current = controller;
    setLoading(true);
    setFailed(false);
    try {
      const result = await loadPreference(controller.signal);
      if (activeLoad.current !== controller || controller.signal.aborted) return;
      setPreference(result);
      setDraftModelId(result.selectedModelId ?? "");
    } catch (error) {
      if (
        activeLoad.current === controller &&
        !controller.signal.aborted &&
        !(onAuthenticationError?.(error) ?? false)
      ) {
        setFailed(true);
      }
    } finally {
      if (activeLoad.current === controller) {
        activeLoad.current = null;
        setLoading(false);
      }
    }
  }, [loadPreference, onAuthenticationError, online]);

  useEffect(() => {
    if (online) void load();
    else {
      activeLoad.current?.abort();
      activeSave.current?.abort();
      setPreference(null);
      setDraftModelId("");
      setLoading(false);
      setSaving(false);
      setFailed(false);
      setSaveFailed(false);
      setSaved(false);
    }
    return () => {
      activeLoad.current?.abort();
      activeSave.current?.abort();
    };
  }, [load, online]);

  const models = connection?.models ?? [];
  const savedModel =
    preference?.selectedModelId === null || preference?.selectedModelId === undefined
      ? null
      : (models.find(({ id }) => id === preference.selectedModelId) ?? null);
  const draftAvailable = models.some(({ id }) => id === draftModelId);
  const connectionBlocked =
    connection === null ||
    (connection.state !== "ready" && connection.state !== "waiting_for_usage_reset");
  const unavailable = !online || failed || (!connectionLoading && connection === null);
  const actionRequired =
    !unavailable &&
    !connectionLoading &&
    !loading &&
    (connectionBlocked || preference?.selectedModelId === null || savedModel === null);
  const stateLabel = unavailable
    ? "Unavailable"
    : connectionLoading || loading
      ? "Checking"
      : connection?.state === "waiting_for_usage_reset"
        ? "Waiting for reset"
        : actionRequired
          ? preference?.selectedModelId === null && !connectionBlocked
            ? "Choose a model"
            : "Action required"
          : "Ready";
  const stateClass = unavailable
    ? "unavailable"
    : connectionLoading || loading
      ? "checking"
      : actionRequired
        ? "action_required"
        : (connection?.state ?? "checking");

  const save = async () => {
    if (!draftAvailable || saving) return;
    const controller = new AbortController();
    activeSave.current?.abort();
    activeSave.current = controller;
    setSaving(true);
    setSaveFailed(false);
    setSaved(false);
    try {
      const result = await selectPreference({ modelId: draftModelId }, controller.signal);
      if (activeSave.current === controller && !controller.signal.aborted) {
        setPreference(result);
        setDraftModelId(result.selectedModelId ?? "");
        setSaved(true);
      }
    } catch (error) {
      if (
        activeSave.current === controller &&
        !controller.signal.aborted &&
        !(onAuthenticationError?.(error) ?? false)
      ) {
        setSaveFailed(true);
      }
    } finally {
      if (activeSave.current === controller) {
        activeSave.current = null;
        setSaving(false);
      }
    }
  };

  const selectedRemoved =
    preference?.selectedModelId !== null &&
    preference?.selectedModelId !== undefined &&
    savedModel === null &&
    !connectionLoading &&
    models.length > 0;

  return (
    <section
      className="record-section review-model-settings"
      aria-busy={connectionLoading || loading || saving}
      aria-labelledby="review-model-title"
    >
      <div className="section-heading">
        <div>
          <p className="section-index">04 / REVIEW MODEL</p>
          <h2 id="review-model-title">Review model</h2>
        </div>
        <p className={`state-marker connection-${stateClass}`} role="status">
          <span aria-hidden="true" />
          {stateLabel}
        </p>
      </div>

      <p className="review-model-intro">
        Choose from the current Codex App Server catalog. This default is used only for future
        review preparation; active and completed work is never retargeted.
      </p>

      <div className="review-model-controls">
        <label className="form-field" htmlFor="codex-review-model">
          <span>Default for future reviews</span>
          <select
            id="codex-review-model"
            disabled={!online || connectionLoading || loading || models.length === 0 || saving}
            value={draftAvailable ? draftModelId : ""}
            onChange={(event) => {
              setDraftModelId(event.currentTarget.value);
              setSaveFailed(false);
              setSaved(false);
            }}
          >
            <option value="">Choose a current model</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </select>
        </label>
        <div className="review-model-actions">
          <button
            className="secondary-action"
            type="button"
            disabled={!online || connectionLoading}
            onClick={onVerify}
          >
            Refresh catalog
          </button>
          <button
            type="button"
            disabled={!draftAvailable || saving || draftModelId === preference?.selectedModelId}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save default"}
          </button>
        </div>
      </div>

      {selectedRemoved ? (
        <p className="connection-remediation" role="alert">
          Saved model <code>{preference.selectedModelId}</code> no longer appears in the current
          catalog. Choose another model; Kestrel did not select a fallback.
        </p>
      ) : connection?.reason === null || connection?.reason === undefined ? null : (
        <p className="connection-remediation">{connectionMessages[connection.reason]}</p>
      )}
      {failed ? (
        <p className="connection-remediation" role="alert">
          Kestrel could not read the saved review model. Try again after refreshing the page.
        </p>
      ) : null}
      {saveFailed ? (
        <p className="connection-remediation" role="alert">
          The model was not saved. Refresh the catalog and choose a currently available model.
        </p>
      ) : null}
      {saved ? (
        <p className="connection-note" role="status">
          Default saved for future review preparation.
        </p>
      ) : null}
    </section>
  );
}
