import { useEffect, useState } from "react";
import type { FactoryBoard, Feature } from "@kestrel/contracts";
import { fetchFactoryBoard, fetchFeatures } from "./api.js";
import type { AppRoute } from "./app-route.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { ProjectFactoryBoardPanel } from "./ProjectFactoryBoardPanel.js";

export interface ProjectFactoryWorkspaceProps {
  projectId: string;
  projectName: string;
  online: boolean;
  onNavigate: (route: Exclude<AppRoute, { kind: "not_found" }>) => void;
  onAuthenticationError: (error: unknown) => boolean;
}

export function ProjectFactoryWorkspace({
  projectId,
  projectName,
  online,
  onNavigate,
  onAuthenticationError,
}: ProjectFactoryWorkspaceProps) {
  const [features, setFeatures] = useState<Feature[]>([]);
  const [boards, setBoards] = useState<FactoryBoard[]>([]);
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
    const read = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchFeatures(projectId, controller.signal);
        const approved = result.features.filter((feature) => feature.state !== "planning");
        const readBoards: FactoryBoard[] = [];
        for (let index = 0; index < approved.length; index += 4) {
          if (controller.signal.aborted) return;
          readBoards.push(
            ...(await Promise.all(
              approved
                .slice(index, index + 4)
                .map((feature) => fetchFactoryBoard(projectId, feature.id, controller.signal)),
            )),
          );
        }
        if (controller.signal.aborted) return;
        setFeatures(result.features);
        setBoards(readBoards);
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
      projectName={projectName}
      features={features}
      boards={boards}
      online={online}
      loading={loading}
      error={error}
      onStartPlan={() =>
        onNavigate({ kind: "planning", projectId, requestId: crypto.randomUUID() })
      }
      onOpenFeature={(featureId, view) =>
        onNavigate({
          kind: "feature",
          projectId: features.find((feature) => feature.id === featureId)?.projectId ?? projectId,
          featureId,
          ...(view === "chat" ? {} : { view }),
        })
      }
      onRefresh={() => setGeneration((current) => current + 1)}
      onOpenPullRequests={() => onNavigate({ kind: "project", projectId, view: "pull_requests" })}
      onOpenSettings={() => onNavigate({ kind: "settings", projectId })}
    />
  );
}
