import { useEffect, useState } from "react";
import type { ProjectBoardSnapshot } from "@kestrel/contracts";
import { fetchProjectBoard } from "./api.js";
import { appPath, type AppRoute } from "./app-route.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { ProjectFactoryBoardPanel } from "./ProjectFactoryBoardPanel.js";

export interface ProjectFactoryWorkspaceProps {
  projectId: string;
  projectName: string;
  online: boolean;
  onNavigate: (route: Exclude<AppRoute, { kind: "not_found" }>) => void;
  onAuthenticationError: (error: unknown) => boolean;
}

export function ProjectFactoryWorkspace(props: ProjectFactoryWorkspaceProps) {
  return <ProjectFactoryWorkspaceContent key={props.projectId} {...props} />;
}

function ProjectFactoryWorkspaceContent({
  projectId,
  projectName,
  online,
  onNavigate,
  onAuthenticationError,
}: ProjectFactoryWorkspaceProps) {
  const [snapshot, setSnapshot] = useState<ProjectBoardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!online) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshProvider = generation > 0;
    const read = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchProjectBoard(projectId, controller.signal, refreshProvider);
        refreshProvider = false;
        if (controller.signal.aborted) return;
        setSnapshot(result);
        timer = setTimeout(() => void read(), 2_000);
      } catch (failure) {
        if (!controller.signal.aborted && !onAuthenticationError(failure))
          setError(
            planningRequestError(
              failure,
              "This Project board could not be refreshed. Its last read remains visible.",
            ),
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [projectId, online, generation, onAuthenticationError]);

  return (
    <ProjectFactoryBoardPanel
      projectId={projectId}
      projectName={projectName}
      snapshot={snapshot}
      online={online}
      loading={loading}
      error={error}
      onStartPlan={() =>
        onNavigate({ kind: "planning", projectId, requestId: crypto.randomUUID() })
      }
      onOpenFeature={(featureId, view) =>
        onNavigate({
          kind: "feature",
          projectId: snapshot?.projectId ?? projectId,
          featureId,
          ...(view === "chat" ? {} : { view }),
        })
      }
      onRefresh={() => setGeneration((current) => current + 1)}
      onOpenPullRequests={() => onNavigate({ kind: "project", projectId, view: "pull_requests" })}
      settingsHref={appPath({ kind: "project_settings", projectId })}
      onOpenSettings={() => onNavigate({ kind: "project_settings", projectId })}
    />
  );
}
