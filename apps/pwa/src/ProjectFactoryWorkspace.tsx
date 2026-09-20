import { useEffect, useState } from "react";
import type { FactoryBoard, FactoryGitHubIssues, Feature } from "@kestrel/contracts";
import { fetchFactoryBoard, fetchFactoryGitHubIssues, fetchFeatures } from "./api.js";
import type { AppRoute } from "./app-route.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { ProjectFactoryBoardPanel } from "./ProjectFactoryBoardPanel.js";

const githubIssuePageLimit = 5;

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
  const [githubIssuePages, setGitHubIssuePages] = useState<FactoryGitHubIssues[]>([]);
  const [githubIssuesError, setGitHubIssuesError] = useState<string | null>(null);
  const [githubIssuesLoading, setGitHubIssuesLoading] = useState(true);
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

  useEffect(() => {
    if (!online) {
      setGitHubIssuesLoading(false);
      return;
    }
    const controller = new AbortController();
    setGitHubIssuesError(null);
    setGitHubIssuesLoading(true);
    const read = async () => {
      const pages: FactoryGitHubIssues[] = [];
      let page: number | null = 1;
      while (page !== null && pages.length < githubIssuePageLimit) {
        const result = await fetchFactoryGitHubIssues(projectId, page, controller.signal);
        if (controller.signal.aborted) return;
        const retained =
          pages.length === githubIssuePageLimit - 1 && result.nextPage !== null
            ? { ...result, nextPage: null, limited: true }
            : result;
        pages.push(retained);
        setGitHubIssuePages([...pages]);
        if (retained.state !== "available") return;
        page = retained.nextPage;
      }
    };
    void read()
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError(failure))
          setGitHubIssuesError(
            planningRequestError(
              failure,
              "GitHub issues could not be read. Refresh the board to retry.",
            ),
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setGitHubIssuesLoading(false);
      });
    return () => controller.abort();
  }, [projectId, online, generation, onAuthenticationError]);

  return (
    <ProjectFactoryBoardPanel
      projectId={projectId}
      projectName={projectName}
      features={features}
      boards={boards}
      githubIssuePages={githubIssuePages.filter((page) => page.projectId === projectId)}
      githubIssuesError={githubIssuesError}
      githubIssuesLoading={githubIssuesLoading}
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
