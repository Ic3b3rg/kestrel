import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Feature,
  FeaturePlanningSkills,
  StartPlanningFeatureCommand,
} from "@kestrel/contracts";
import { ApiClientError } from "./api.js";
import { fetchPlanningFeatureRequest, startPlanningFeature } from "./factory-start-api.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { NewPlanningChatPanel } from "./NewPlanningChatPanel.js";
import { PlanningSkillsPanel } from "./PlanningSkillsPanel.js";
import { Button } from "./components/ui/button.js";
import type { AppRoute } from "./app-route.js";

export interface NewPlanningWorkspaceProps {
  projectId: string;
  projectName: string;
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
  requestId,
  online,
  onStarted,
  onNavigate,
  onAuthenticationError,
  onDraftDirtyChange,
}: NewPlanningWorkspaceProps) {
  const [skills, setSkills] = useState<FeaturePlanningSkills>({
    schemaVersion: 1,
    version: 0,
    skills: [],
  });
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

  const submit = async (text: string) => {
    if (!online || submitted.current || text.trim() === "") return;
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
        skillDigests: skills.skills.map((skill) => skill.contentDigest),
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
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm">
          <p>{readError}</p>
          <Button
            variant="outline"
            disabled={!online || checking || pending}
            onClick={() => void lookup()}
          >
            Check saved conversation
          </Button>
        </div>
      )}
      <NewPlanningChatPanel
        projectName={projectName}
        online={online}
        pending={pending || checking}
        error={error}
        locked={attempt.current !== null}
        pendingMessage={
          checking ? "Checking for your saved conversation…" : "Saving your first message…"
        }
        onSubmit={(text) => void submit(text)}
        onBack={() => onNavigate({ kind: "project", projectId })}
        onDraftChange={(text) => {
          hasDraft.current = text.trim() !== "";
          onDraftDirtyChange(hasDraft.current || skills.skills.length > 0);
        }}
        tools={
          <PlanningSkillsPanel
            projectId={projectId}
            online={online}
            editable={!pending && !checking && attempt.current === null}
            selection={skills}
            onAuthenticationError={onAuthenticationError}
            onDraftSelection={(selected) => {
              setSkills((current) => ({
                schemaVersion: 1,
                version: current.version + 1,
                skills: selected,
              }));
              onDraftDirtyChange(hasDraft.current || selected.length > 0);
            }}
          />
        }
      />
    </>
  );
}
