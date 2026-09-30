import { useEffect, useState, useRef } from "react";
import type { ProjectBoardSnapshot } from "@kestrel/contracts";
import { ProjectIssueReader } from "./ProjectIssueReader.js";
import { startProjectIssue, changeProjectIssueStart } from "./project-issue-api.js";
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
  const [openedIssue, setOpenedIssue] = useState<number | null>(null);
  const [startingIssue, setStartingIssue] = useState<number | null>(null);
  const starting = useRef(false);
  const requests = useRef(new Map<number, string>());
  const refreshRequested = useRef(false);
  const start = async (number: number) => {
    if (!online || starting.current) return;
    starting.current = true;
    setStartingIssue(number);
    setError(null);
    const requestId = requests.current.get(number) ?? crypto.randomUUID();
    requests.current.set(number, requestId);
    try {
      const accepted = await startProjectIssue(projectId, number, requestId);
      requests.current.delete(number);
      onNavigate({ kind: "issue", projectId, startId: accepted.id });
    } catch (failure) {
      if (!onAuthenticationError(failure))
        setError(
          planningRequestError(
            failure,
            "This issue could not be started. Retry to recover the same request.",
          ),
        );
    } finally {
      starting.current = false;
      setStartingIssue(null);
    }
  };
  const changeStart = async (id: string, action: "cancel" | "retry") => {
    try {
      await changeProjectIssueStart(projectId, id, action);
      setGeneration((value) => value + 1);
    } catch (failure) {
      if (!onAuthenticationError(failure))
        setError(planningRequestError(failure, "This queued work could not be changed."));
    }
  };
  useEffect(() => {
    if (!online) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshProvider = refreshRequested.current;
    refreshRequested.current = false;
    const read = async () => {
      if (refreshProvider) setLoading(true);
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
    <>
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
        onOpenFeature={(featureId, view) => {
          const issue = snapshot?.starts?.find((start) => start.featureId === featureId);
          onNavigate(
            issue === undefined
              ? {
                  kind: "feature",
                  projectId: snapshot?.projectId ?? projectId,
                  featureId,
                  ...(view === "chat" ? {} : { view }),
                }
              : { kind: "issue", projectId, startId: issue.id },
          );
        }}
        onOpenStart={(startId) => onNavigate({ kind: "issue", projectId, startId })}
        onRefresh={() => {
          refreshRequested.current = true;
          setGeneration((current) => current + 1);
        }}
        onOpenIssue={setOpenedIssue}
        onStartIssue={(number) => void start(number)}
        startingIssue={startingIssue}
        onCancelStart={(id) => void changeStart(id, "cancel")}
        onRetryStart={(id) => void changeStart(id, "retry")}
        onOpenPullRequests={() => onNavigate({ kind: "project", projectId, view: "pull_requests" })}
        settingsHref={appPath({ kind: "project_settings", projectId })}
        onOpenSettings={() => onNavigate({ kind: "project_settings", projectId })}
      />
      {openedIssue === null ? null : (
        <ProjectIssueReader
          key={openedIssue}
          projectId={projectId}
          number={openedIssue}
          onClose={() => setOpenedIssue(null)}
          onAuthenticationError={onAuthenticationError}
        />
      )}
    </>
  );
}
