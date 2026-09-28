import { startFactoryWorkItem, prepareGitHubIssue } from "./factory-execution-api.js";
import { useEffect, useState, useRef } from "react";
import type {
  ProjectBoardSnapshot,
  ProjectBoardWorkItem,
  StartFactoryWorkItemCommand,
} from "@kestrel/contracts";
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
  const [startingIssueId, setStartingIssueId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const starts = useRef(new Map<string, StartFactoryWorkItemCommand>());
  const sending = useRef(false);
  const issueRequests = useRef(new Map<string, string>());
  const startGitHubIssue = async (issue: ProjectBoardSnapshot["github"]["issues"][number]) => {
    if (!online || sending.current) return;
    sending.current = true;
    setStartingIssueId(issue.id);
    setStartError(null);
    const requestId = issueRequests.current.get(issue.id) ?? crypto.randomUUID();
    issueRequests.current.set(issue.id, requestId);
    try {
      const feature = await prepareGitHubIssue(projectId, issue.number, requestId);
      onNavigate({ kind: "feature", projectId: feature.projectId, featureId: feature.id });
    } catch (failure) {
      if (!onAuthenticationError(failure))
        setStartError(
          planningRequestError(
            failure,
            "This issue needs requirements before it can start. Retry to open its linked interview.",
          ),
        );
    } finally {
      sending.current = false;
      setStartingIssueId(null);
    }
  };
  const startIssue = async ({ feature, item }: ProjectBoardWorkItem) => {
    if (!online || sending.current || item.approvedVersion == null) return;
    sending.current = true;
    setStartingIssueId(item.id);
    setStartError(null);
    const command = starts.current.get(item.id) ?? {
      requestId: crypto.randomUUID(),
      expectedVersion: item.approvedVersion,
    };
    starts.current.set(item.id, command);
    try {
      await startFactoryWorkItem(projectId, feature.id, item.id, command);
      starts.current.delete(item.id);
      setGeneration((current) => current + 1);
    } catch (failure) {
      if (!onAuthenticationError(failure))
        setStartError(
          planningRequestError(
            failure,
            "The issue start could not be confirmed. Retry Start issue; the same request is safe.",
          ),
        );
    } finally {
      sending.current = false;
      setStartingIssueId(null);
    }
  };
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
      onStartGitHubIssue={(issue) => void startGitHubIssue(issue)}
      onStartIssue={(entry) => void startIssue(entry)}
      startingIssueId={startingIssueId}
      startError={startError}
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
