import { FormFeedback } from "./components/FormFeedback.js";
import { PlanningModelControls } from "./PlanningModelControls.js";
import { NativeSelect } from "./components/ui/native-select.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Feature,
  PlanningComposerSettings,
  PlanningAttachment,
  StartPlanningFeatureCommand,
} from "@kestrel/contracts";
import { ApiClientError } from "./api.js";
import { fetchPlanningFeatureRequest, startPlanningFeature } from "./factory-start-api.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { NewPlanningChatPanel } from "./NewPlanningChatPanel.js";
import { Button } from "./components/ui/button.js";
import type { AppRoute } from "./app-route.js";

export interface NewPlanningWorkspaceProps {
  projectId: string;
  projectName: string;
  projects?: { id: string; name: string }[];
  requestId: string;
  online: boolean;
  onStarted: (feature: Feature) => void;
  onNavigate: (route: Exclude<AppRoute, { kind: "not_found" }>) => void;
  onAuthenticationError: (error: unknown) => boolean;
  onDraftDirtyChange: (dirty: boolean) => void;
}

export function NewPlanningWorkspace({
  projectId,
  projectName,
  projects,
  requestId,
  online,
  onStarted,
  onNavigate,
  onAuthenticationError,
  onDraftDirtyChange,
}: NewPlanningWorkspaceProps) {
  const [planningSettings, setPlanningSettings] = useState<PlanningComposerSettings | undefined>();
  const [profileReady, setProfileReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<StartPlanningFeatureCommand | null>(null);
  const submitted = useRef(false);
  const ready = useRef(false);
  const alive = useRef(true);
  const enabled = useRef(online);
  enabled.current = online;
  const isEnabled = () => enabled.current;
  const identity = `${projectId}/${requestId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const activeRead = useRef<AbortController | null>(null);
  const hasDraft = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      activeRead.current?.abort();
      onDraftDirtyChange(false);
    };
  }, [onDraftDirtyChange]);

  const lookup = useCallback(async (): Promise<"missing" | "found" | "unavailable"> => {
    const controller = new AbortController();
    activeRead.current?.abort();
    activeRead.current = controller;
    setChecking(true);
    setReadError(null);
    try {
      const result = await fetchPlanningFeatureRequest(projectId, requestId, controller.signal);
      if (!alive.current || controller.signal.aborted || !enabled.current) return "unavailable";
      ready.current = true;
      if (result.feature !== null) {
        onStarted(result.feature);
        return "found";
      }
      return "missing";
    } catch (failure) {
      if (alive.current && !controller.signal.aborted && !onAuthenticationError(failure))
        setReadError(
          planningRequestError(
            failure,
            "Your saved conversation could not be checked. Retry before sending.",
          ),
        );
      return "unavailable";
    } finally {
      if (alive.current && activeRead.current === controller) setChecking(false);
    }
  }, [projectId, requestId, onStarted, onAuthenticationError]);

  useEffect(() => {
    ready.current = false;
    if (online) void lookup();
    return () => activeRead.current?.abort();
  }, [online, lookup]);

  const submit = async (text: string, attachments: PlanningAttachment[]) => {
    if (
      !online ||
      (!profileReady && attempt.current === null) ||
      submitted.current ||
      text.trim() === ""
    )
      return;
    submitted.current = true;
    setPending(true);
    setError(null);
    const canUpdate = () => alive.current && currentIdentity.current === identity;
    try {
      if (!ready.current && (await lookup()) !== "missing") return;
      if (!canUpdate() || !enabled.current) return;
      attempt.current ??= {
        requestId,
        text: text.trim(),
        skillDigests: [],
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(planningSettings === undefined ? {} : { planningSettings }),
      };
      // Accepted work belongs to the workstation; navigation cannot abort this command.
      const result = await startPlanningFeature(projectId, attempt.current);
      if (canUpdate() && isEnabled()) onStarted(result.feature);
    } catch (failure) {
      if (!canUpdate() || !enabled.current || onAuthenticationError(failure)) return;
      if ((await lookup()) === "found" || !canUpdate()) return;
      if (failure instanceof ApiClientError && (failure.status === 400 || failure.status === 409))
        attempt.current = null;
      setError(
        planningRequestError(
          failure,
          "Kestrel could not confirm your first message. Retry sends the same request safely.",
        ),
      );
    } finally {
      submitted.current = false;
      if (canUpdate()) setPending(false);
    }
  };

  return (
    <>
      {readError === null ? null : (
        <FormFeedback kind="error" className="mb-4 flex flex-wrap items-center gap-3 text-sm">
          <p>{readError}</p>
          <Button
            variant="outline"
            disabled={!online || checking || pending}
            onClick={() => void lookup()}
          >
            Check saved conversation
          </Button>
        </FormFeedback>
      )}
      <NewPlanningChatPanel
        controls={
          <PlanningModelControls
            key={projectId}
            projectId={projectId}
            online={online}
            disabled={pending || checking || attempt.current !== null}
            onReady={setProfileReady}
            onSettingsChange={setPlanningSettings}
          />
        }
        projectControl={
          projects === undefined ? (
            projectName
          ) : (
            <NativeSelect
              aria-label="Project"
              value={projectId}
              disabled={pending || checking || attempt.current !== null || !online}
              onChange={(event) => {
                const project = projects.find((item) => item.id === event.target.value);
                if (project !== undefined) {
                  onNavigate({ kind: "planning", projectId: project.id, requestId });
                  setPlanningSettings(undefined);
                  setProfileReady(false);
                }
              }}
            >
              {projects.map((project) => (
                <option value={project.id} key={project.id}>
                  {project.name}
                </option>
              ))}
            </NativeSelect>
          )
        }
        projectName={projectName}
        onAuthenticationError={onAuthenticationError}
        online={online}
        readyToSubmit={profileReady || attempt.current !== null}
        pending={pending || checking}
        error={error}
        locked={attempt.current !== null}
        pendingMessage={
          checking ? "Checking for your saved conversation…" : "Saving your first message…"
        }
        onSubmit={(text, attachments) => void submit(text, attachments)}
        onBack={() => onNavigate({ kind: "project", projectId })}
        onDraftChange={(text, hasAttachments) => {
          hasDraft.current = text.trim() !== "" || hasAttachments === true;
          onDraftDirtyChange(hasDraft.current);
        }}
      />
    </>
  );
}
