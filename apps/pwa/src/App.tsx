import { FormFeedback } from "./components/FormFeedback.js";
import { Button } from "./components/ui/button.js";
import { WorkspaceSuspendedContext } from "./components/ui/workspace-suspension.js";
import { FeatureNavigation } from "./FeatureNavigation.js";
import { FeatureChatPanel } from "./FeatureChatPanel.js";
import { ProjectFactoryWorkspace } from "./ProjectFactoryWorkspace.js";
import { NewPlanningWorkspace } from "./NewPlanningWorkspace.js";
import { readFeatureNavigation, saveFeatureNavigation } from "./feature-navigation.js";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  Feature,
  ChangeIntentVersionCreated,
  LoginCommand,
  ProjectInbox,
  ProjectUpserted,
  ReviewRevisionAvailable,
  PublicGitHubPullRequestUrl,
  Session,
} from "@kestrel/contracts";

import {
  ApiClientError,
  fetchProjectInbox,
  fetchSession,
  loginOperator,
  logoutOperator,
  openPublicGitHubPullRequest,
  observeHostGitHubPullRequest,
} from "./api.js";
import { ProjectSettingsRoute } from "./ProjectSettingsPanel.js";
import { AuthenticatedShell, projectLabel } from "./AuthenticatedShell.js";
import { appPath, readAppRoute, type AppRoute } from "./app-route.js";
import { GlobalSettingsRoute } from "./GlobalSettingsView.js";
import { LoginView } from "./LoginView.js";
import { OpenProjectForm } from "./OpenProjectForm.js";
import { ProjectInboxPanel } from "./ProjectInboxPanel.js";

const PROJECT_ERROR_MESSAGE = "Kestrel could not read the authoritative Project inbox. Try again.";
const SESSION_ERROR_MESSAGE = "Kestrel could not verify the Operator session. Try again.";

function withUpsertedProject(
  current: ProjectInbox | null,
  project: ProjectUpserted["project"],
): ProjectInbox {
  const projects = current?.projects ?? [];
  const existingIndex = projects.findIndex((candidate) => candidate.id === project.id);
  if (existingIndex === -1) {
    return { schemaVersion: 1, projects: [...projects, project] };
  }
  return {
    schemaVersion: 1,
    projects: projects.map((candidate, index) => (index === existingIndex ? project : candidate)),
  };
}

function withCreatedIntent(
  current: ProjectInbox | null,
  result: ChangeIntentVersionCreated,
): ProjectInbox | null {
  if (current === null) return null;
  return {
    schemaVersion: 1,
    projects: current.projects.map((project) =>
      project.id !== result.projectId
        ? project
        : {
            ...project,
            changeProposals: project.changeProposals.map((proposal) =>
              proposal.id !== result.changeProposalId
                ? proposal
                : {
                    ...proposal,
                    changeIntent: result.changeIntent,
                    version: result.proposalVersion,
                  },
            ),
          },
    ),
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) {
    return `${error.details.message} Reference: ${error.details.correlationId}`;
  }
  return fallback;
}

function requiresAuthentication(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    (error.details.code === "AUTHENTICATION_FAILED" ||
      error.details.code === "AUTHENTICATION_REQUIRED")
  );
}

function readHistoryPosition(state: unknown): number | null {
  return typeof state === "object" &&
    state !== null &&
    "kestrelPosition" in state &&
    typeof state.kestrelPosition === "number" &&
    Number.isSafeInteger(state.kestrelPosition) &&
    state.kestrelPosition >= 0
    ? state.kestrelPosition
    : null;
}

function hasPendingChangeOverviewRendering(inbox: ProjectInbox | null): boolean {
  return (
    inbox?.projects.some((project) =>
      project.changeProposals.some((proposal) => {
        const overview = proposal.changeOverview;
        return (
          overview?.state === "ready" &&
          (overview.modelRendering.state === "queued" ||
            overview.modelRendering.state === "rendering")
        );
      }),
    ) ?? false
  );
}

export function App() {
  const [projectFeatureIds, setProjectFeatureIds] = useState(readFeatureNavigation);
  const [planDirty, setPlanDirty] = useState(false);
  const [route, setRoute] = useState<AppRoute>(() =>
    readAppRoute(window.location.pathname, window.location.search, window.location.hash),
  );
  const [networkOnline, setNetworkOnline] = useState(() => navigator.onLine);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [sessionChecking, setSessionChecking] = useState(true);
  const [sessionCheckError, setSessionCheckError] = useState<string | null>(null);
  const [sessionCheckGeneration, setSessionCheckGeneration] = useState(0);
  const online = networkOnline && !sessionChecking && sessionCheckError === null;
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginSuccess, setLoginSuccess] = useState<string | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [sessionCommandPending, setSessionCommandPending] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [projectInbox, setProjectInbox] = useState<ProjectInbox | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [openProjectTrigger, setOpenProjectTrigger] = useState<HTMLDivElement | null>(null);
  const [projectPending, setProjectPending] = useState(false);
  const [projectReloadGeneration, setProjectReloadGeneration] = useState(0);
  const loginController = useRef<AbortController | null>(null);
  const projectCommandController = useRef<AbortController | null>(null);
  const projectInboxController = useRef<AbortController | null>(null);
  const logoutController = useRef<AbortController | null>(null);
  const historyPosition = useRef(readHistoryPosition(window.history.state) ?? 0);
  const restoringHistory = useRef(false);
  const handleSessionCommandPending = useCallback((pending: boolean) => {
    setSessionCommandPending(pending);
    if (pending) {
      projectCommandController.current?.abort();
      setProjectPending(false);
    }
  }, []);

  useEffect(() => {
    window.history.replaceState({ kestrelPosition: historyPosition.current }, "");
  }, []);

  useEffect(() => {
    if (
      (route.kind !== "project_settings" && route.kind !== "settings") ||
      window.location.pathname !== "/settings"
    )
      return;
    window.history.replaceState(
      window.history.state,
      "",
      `${appPath(route)}${window.location.hash}`,
    );
  }, [route]);

  useEffect(() => {
    saveFeatureNavigation(projectFeatureIds);
  }, [projectFeatureIds]);
  useEffect(() => {
    setLogoutError(null);
  }, [route]);
  useEffect(() => {
    if (session === null)
      setProjectFeatureIds((current) => (Object.keys(current).length === 0 ? current : {}));
  }, [session]);
  const rememberFeature = useCallback(
    (feature: Feature) => {
      const aliasedProject =
        route.kind === "feature" &&
        route.featureId === feature.id &&
        route.projectId !== feature.projectId;
      setProjectFeatureIds((current) => {
        if (!aliasedProject && current[feature.projectId] === feature.id) return current;
        const retained = aliasedProject
          ? Object.fromEntries(Object.entries(current).filter(([id]) => id !== route.projectId))
          : current;
        return { ...retained, [feature.projectId]: feature.id };
      });
      if (aliasedProject) {
        const canonicalRoute = {
          kind: "feature" as const,
          projectId: feature.projectId,
          featureId: feature.id,
          ...(route.view === undefined ? {} : { view: route.view }),
          ...(route.artifactId === undefined ? {} : { artifactId: route.artifactId }),
        };
        window.history.replaceState(window.history.state, "", appPath(canonicalRoute));
        setRoute(canonicalRoute);
      }
    },
    [route],
  );
  const forgetFeature = useCallback((projectId: string, featureId: string) => {
    setProjectFeatureIds((current) =>
      current[projectId] !== featureId
        ? current
        : Object.fromEntries(Object.entries(current).filter(([id]) => id !== projectId)),
    );
  }, []);

  const navigate = useCallback(
    (nextRoute: Exclude<AppRoute, { kind: "not_found" }>) => {
      const sameFeature =
        route.kind === "feature" &&
        nextRoute.kind === "feature" &&
        route.projectId === nextRoute.projectId &&
        route.featureId === nextRoute.featureId;
      if (
        planDirty &&
        !sameFeature &&
        !window.confirm(
          route.kind === "planning"
            ? "Discard this unsent prompt and leave planning?"
            : "Discard unsaved plan edits and leave this feature?",
        )
      )
        return;
      const path = appPath(nextRoute);
      if (`${window.location.pathname}${window.location.search}` !== path) {
        historyPosition.current += 1;
        window.history.pushState({ kestrelPosition: historyPosition.current }, "", path);
      }

      setRoute(nextRoute);
    },
    [planDirty, route],
  );

  const planningStarted = useCallback((feature: Feature) => {
    setPlanDirty(false);
    setProjectFeatureIds((current) => ({ ...current, [feature.projectId]: feature.id }));
    const next = { kind: "feature" as const, projectId: feature.projectId, featureId: feature.id };
    window.history.replaceState(window.history.state, "", appPath(next));
    setRoute(next);
  }, []);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (restoringHistory.current) {
        restoringHistory.current = false;
        return;
      }
      // Native fragment navigation creates an entry without an application position.
      const nextPosition = readHistoryPosition(event.state) ?? historyPosition.current + 1;
      const nextRoute = readAppRoute(
        window.location.pathname,
        window.location.search,
        window.location.hash,
      );
      const sameFeature =
        route.kind === "feature" &&
        nextRoute.kind === "feature" &&
        route.projectId === nextRoute.projectId &&
        route.featureId === nextRoute.featureId;
      if (
        planDirty &&
        route.kind !== "not_found" &&
        !sameFeature &&
        !window.confirm(
          route.kind === "planning"
            ? "Discard this unsent prompt and leave planning?"
            : "Discard unsaved plan edits and leave this feature?",
        )
      ) {
        restoringHistory.current = true;
        window.history.go(historyPosition.current - nextPosition);
        return;
      }
      historyPosition.current = nextPosition;
      if (readHistoryPosition(event.state) === null)
        window.history.replaceState({ kestrelPosition: nextPosition }, "");

      setRoute(nextRoute);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [planDirty, route]);

  useEffect(() => {
    if (!planDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [planDirty]);

  useEffect(() => {
    if ((route.kind !== "settings" && route.kind !== "project_settings") || session == null) return;
    const target = document.getElementById(window.location.hash.slice(1));
    if (target === null) return;
    target.focus();
    const revealTarget = () => {
      if (document.activeElement === target) target.scrollIntoView({ block: "start" });
    };
    revealTarget();
    // Connection facts arrive asynchronously above the linked section. Keep the requested
    // heading visible until the Operator takes over navigation.
    const observer = new ResizeObserver(revealTarget);
    observer.observe(target.closest(".settings-view, .project-settings-view") ?? target);
    const stopFollowing = () => observer.disconnect();
    const navigationEvents = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const event of navigationEvents) {
      window.addEventListener(event, stopFollowing, { once: true, passive: true });
    }
    return () => {
      observer.disconnect();
      for (const event of navigationEvents) window.removeEventListener(event, stopFollowing);
    };
  }, [route, session]);

  const resetProjectState = useCallback(() => {
    projectInboxController.current?.abort();
    projectInboxController.current = null;
    setProjectInbox(null);
    setProjectLoading(false);
    setProjectPending(false);
    setProjectError(null);
  }, []);

  const requireAuthentication = useCallback(
    (message: string | null) => {
      projectCommandController.current?.abort();
      logoutController.current?.abort();
      setSession(null);
      setSessionChecking(false);
      setSessionCheckError(null);
      resetProjectState();
      setLoginError(message);
      setLoginSuccess(null);
      setLogoutError(null);
    },
    [resetProjectState],
  );

  const handleAuthenticationBoundaryError = useCallback(
    (error: unknown): boolean => {
      if (!requiresAuthentication(error)) {
        return false;
      }
      requireAuthentication("The Operator session expired. Sign in again.");
      return true;
    },
    [requireAuthentication],
  );

  useEffect(() => {
    const handleOnline = () => {
      setSessionChecking(true);
      setNetworkOnline(true);
    };
    const handleOffline = () => {
      loginController.current?.abort();
      projectCommandController.current?.abort();
      logoutController.current?.abort();
      setNetworkOnline(false);
      setSessionChecking(true);
      projectInboxController.current?.abort();
      projectInboxController.current = null;
      setProjectLoading(false);
      setProjectPending(false);
      setProjectError(null);
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      loginController.current?.abort();
      projectCommandController.current?.abort();
      logoutController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!networkOnline) {
      return;
    }
    const controller = new AbortController();
    let active = true;
    setSessionChecking(true);
    setSessionCheckError(null);
    setLoginError(null);

    void fetchSession(controller.signal).then(
      (currentSession) => {
        if (active) {
          setSession(currentSession);
          setSessionChecking(false);
        }
      },
      (error: unknown) => {
        if (!active || controller.signal.aborted) {
          return;
        }
        if (requiresAuthentication(error)) requireAuthentication(null);
        else setSessionCheckError(errorMessage(error, SESSION_ERROR_MESSAGE));
        setSessionChecking(false);
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [networkOnline, sessionCheckGeneration, requireAuthentication]);

  useEffect(() => {
    if (!online || session === null || session === undefined) {
      return;
    }

    const controller = new AbortController();
    let active = true;
    projectInboxController.current?.abort();
    projectInboxController.current = controller;
    setProjectLoading(true);
    setProjectError(null);

    const requiredRevision =
      route.kind === "project" && route.revisionId !== undefined
        ? {
            projectId: route.projectId,
            revisionId: route.revisionId,
          }
        : undefined;
    void fetchProjectInbox(controller.signal, requiredRevision).then(
      (inbox) => {
        if (!active || controller.signal.aborted || projectInboxController.current !== controller) {
          return;
        }
        projectInboxController.current = null;
        setProjectInbox(inbox);
        setProjectLoading(false);
      },
      (error: unknown) => {
        if (!active || controller.signal.aborted || projectInboxController.current !== controller) {
          return;
        }
        projectInboxController.current = null;
        setProjectLoading(false);
        if (!handleAuthenticationBoundaryError(error)) {
          setProjectError(errorMessage(error, PROJECT_ERROR_MESSAGE));
        }
      },
    );

    return () => {
      active = false;
      controller.abort();
      if (projectInboxController.current === controller) {
        projectInboxController.current = null;
      }
    };
  }, [
    handleAuthenticationBoundaryError,
    online,
    projectReloadGeneration,
    route.kind === "project" || route.kind === "project_settings" ? route.projectId : undefined,
    route.kind === "project" ? route.revisionId : undefined,
    session,
  ]);

  useEffect(() => {
    if (
      !online ||
      session === null ||
      session === undefined ||
      projectLoading ||
      !hasPendingChangeOverviewRendering(projectInbox)
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      setProjectReloadGeneration((generation) => generation + 1);
    }, 1_000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [online, projectInbox, projectLoading, session]);

  const handleLogin = async (command: LoginCommand): Promise<void> => {
    const controller = new AbortController();
    loginController.current?.abort();
    loginController.current = controller;
    setLoginPending(true);
    setLoginError(null);
    setLoginSuccess(null);
    try {
      const created = await loginOperator(command, controller.signal);
      setSession(created);
      setSessionChecking(false);
      setSessionCheckError(null);
    } catch (error) {
      if (!controller.signal.aborted) {
        setLoginError(errorMessage(error, SESSION_ERROR_MESSAGE));
      }
    } finally {
      if (loginController.current === controller) {
        loginController.current = null;
        setLoginPending(false);
      }
    }
  };

  const handleOpenPublicPullRequest = async (url: PublicGitHubPullRequestUrl): Promise<void> => {
    const controller = new AbortController();
    projectCommandController.current?.abort();
    projectCommandController.current = controller;
    setProjectPending(true);
    setProjectError(null);

    try {
      const result = await openPublicGitHubPullRequest({ url }, controller.signal);
      controller.signal.throwIfAborted();
      setProjectInbox((current) => withUpsertedProject(current, result.project));
      const number = Number(new URL(url).pathname.split("/").at(-1));
      const proposal = result.project.changeProposals.find(
        (candidate) => candidate.kind === "provider_observed" && candidate.number === number,
      );
      navigate({
        kind: "project",
        projectId: result.project.id,
        ...(proposal === undefined ? {} : { proposalId: proposal.id }),
      });
    } finally {
      if (projectCommandController.current === controller) {
        projectCommandController.current = null;
        setProjectPending(false);
      }
    }
  };

  const handleProjectOpened = (result: ProjectUpserted): void => {
    projectInboxController.current?.abort();
    projectInboxController.current = null;
    setProjectInbox((current) => withUpsertedProject(current, result.project));
    setProjectReloadGeneration((generation) => generation + 1);
    setProjectError(null);
    navigate({
      kind: "project",
      projectId: result.project.id,
      ...(route.kind === "project" &&
      route.projectId === result.project.id &&
      route.proposalId !== undefined
        ? {
            proposalId: route.proposalId,
            ...(route.revisionId === undefined ? {} : { revisionId: route.revisionId }),
          }
        : {}),
    });
  };

  const handleLocalRevisionAvailable = (result: ReviewRevisionAvailable): void => {
    setProjectInbox((current) => withUpsertedProject(current, result.project));
    setProjectReloadGeneration((current) => current + 1);
    setProjectError(null);
  };

  const handleHostPullRequestRefresh = async (projectId: string, number: number): Promise<void> => {
    const controller = new AbortController();
    projectCommandController.current?.abort();
    projectCommandController.current = controller;
    setProjectPending(true);
    setProjectError(null);
    try {
      const result = await observeHostGitHubPullRequest(projectId, { number }, controller.signal);
      controller.signal.throwIfAborted();
      setProjectInbox((current) => withUpsertedProject(current, result.project));
    } finally {
      if (projectCommandController.current === controller) {
        projectCommandController.current = null;
        setProjectPending(false);
      }
    }
  };

  const handleLogout = async (): Promise<void> => {
    if (logoutController.current !== null || sessionCommandPending) return;
    const controller = new AbortController();
    projectCommandController.current?.abort();
    logoutController.current = controller;
    setProjectPending(false);
    setLogoutPending(true);
    setLogoutError(null);
    setLoginSuccess(null);
    try {
      const outcome = await logoutOperator(controller.signal);
      setLoginError(
        outcome.auditError === null
          ? null
          : `This browser is signed out. ${outcome.auditError.message} Reference: ${outcome.auditError.correlationId}`,
      );
      setLoginSuccess(outcome.auditError === null ? "Signed out from this browser." : null);
      setSession(null);
      resetProjectState();
    } catch (error) {
      if (!controller.signal.aborted && !handleAuthenticationBoundaryError(error)) {
        setLogoutError(errorMessage(error, "Kestrel could not sign out this browser."));
      }
    } finally {
      if (logoutController.current === controller) {
        logoutController.current = null;
        setLogoutPending(false);
      }
    }
  };

  if (session === null || session === undefined) {
    return (
      <LoginView
        checking={sessionChecking}
        error={loginError ?? sessionCheckError}
        online={networkOnline}
        pending={loginPending}
        success={loginSuccess}
        onClearFeedback={() => {
          setLoginError(null);
          setLoginSuccess(null);
        }}
        onSubmit={handleLogin}
      />
    );
  }

  const selectedProject =
    route.kind === "project" || route.kind === "feature" || route.kind === "project_settings"
      ? (projectInbox?.projects.find((project) => project.id === route.projectId) ?? null)
      : null;
  const navigationProjectId = "projectId" in route ? route.projectId : undefined;
  const navigationProject = projectInbox?.projects.find(({ id }) => id === navigationProjectId);
  const projectWorkspace =
    selectedProject === null ? null : (
      <ProjectInboxPanel
        key={selectedProject.id}
        selectedProposalId={route.kind === "project" ? (route.proposalId ?? "") : ""}
        {...(route.kind === "project" && route.revisionId !== undefined
          ? { selectedRevisionId: route.revisionId }
          : {})}
        onSelectProposal={(proposalId) =>
          navigate({
            kind: "project",
            projectId: selectedProject.id,
            ...(proposalId === null ? { view: "pull_requests" as const } : { proposalId }),
          })
        }
        error={null}
        inbox={{ schemaVersion: 1, projects: [selectedProject] }}
        loading={false}
        online={online}
        pending={projectPending}
        onAuthenticationError={handleAuthenticationBoundaryError}
        onOpen={handleOpenPublicPullRequest}
        onHostObserved={(project) => {
          setProjectInbox((current) => withUpsertedProject(current, project));
        }}
        onHostRefresh={handleHostPullRequestRefresh}
        onIntentCreated={(result) => {
          setProjectInbox((current) => withCreatedIntent(current, result));
          setProjectReloadGeneration((generation) => generation + 1);
          setProjectError(null);
        }}
        onLocalAvailable={handleLocalRevisionAvailable}
        onProjectOpened={handleProjectOpened}
        onRetry={() => setProjectReloadGeneration((generation) => generation + 1)}
      />
    );
  const workspace = (() => {
    switch (route.kind) {
      case "projects":
        return (
          <section className="workspace-landing" aria-labelledby="workspace-title">
            <h1 id="workspace-title">Projects</h1>
            <p className="lede">
              Select a Project in the sidebar, or open a repository to get started.
            </p>
          </section>
        );
      case "settings":
        return (
          <GlobalSettingsRoute
            section={route.section}
            online={online}
            session={session}
            sessionCommandBlocked={logoutPending}
            projects={projectInbox?.projects ?? null}
            projectsError={projectError}
            projectsLoading={projectLoading}
            onRetryProjects={() => setProjectReloadGeneration((generation) => generation + 1)}
            onNavigate={(section) => navigate({ kind: "settings", section })}
            onOpenProjectSettings={(projectId) => navigate({ kind: "project_settings", projectId })}
            onAuthenticationError={handleAuthenticationBoundaryError}
            onSessionCommandPending={handleSessionCommandPending}
            onCredentialsChanged={(message) => {
              setLoginError(null);
              setLoginSuccess(message);
              setSession(null);
              resetProjectState();
            }}
          />
        );
      case "project_settings":
        return (
          <ProjectSettingsRoute
            projectId={route.projectId}
            inbox={projectInbox}
            online={online}
            loading={projectLoading}
            error={projectError}
            onAuthenticationError={handleAuthenticationBoundaryError}
            onRetry={() => setProjectReloadGeneration((generation) => generation + 1)}
            onBack={() => navigate({ kind: "projects" })}
            onChanged={() => setProjectReloadGeneration((generation) => generation + 1)}
          />
        );
      case "project":
        if (selectedProject !== null) {
          if (route.proposalId !== undefined || route.view === "pull_requests")
            return projectWorkspace;
          return (
            <ProjectFactoryWorkspace
              key={selectedProject.id}
              projectId={selectedProject.id}
              projectName={projectLabel(selectedProject)}
              online={online}
              onNavigate={navigate}
              onAuthenticationError={handleAuthenticationBoundaryError}
            />
          );
        }
        if (projectInbox === null && projectLoading) {
          return (
            <section className="workspace-state" aria-busy="true">
              <h1>Reading selected Project</h1>
              <p>Loading your Project…</p>
            </section>
          );
        }
        if (projectInbox === null) {
          return (
            <section className="workspace-state">
              <h1>Project unavailable</h1>
              <p>Reconnect or retry Projects in the sidebar.</p>
            </section>
          );
        }
        return (
          <section className="workspace-state">
            <h1>Project not found</h1>
            <p>This Project could not be found. Choose another Project in the sidebar.</p>
            <Button type="button" onClick={() => navigate({ kind: "projects" })}>
              Back to Projects
            </Button>
          </section>
        );
      case "planning":
        return (
          <NewPlanningWorkspace
            key={`${route.projectId}/${route.requestId}`}
            projectId={route.projectId}
            projectName={
              navigationProject === undefined ? "Project" : projectLabel(navigationProject)
            }
            requestId={route.requestId}
            online={online}
            onStarted={planningStarted}
            onNavigate={navigate}
            onAuthenticationError={handleAuthenticationBoundaryError}
            onDraftDirtyChange={setPlanDirty}
          />
        );
      case "feature":
        return (
          <FeatureChatPanel
            key={`${route.projectId}/${route.featureId}`}
            projectId={route.projectId}
            projectName={
              navigationProject === undefined ? "Project" : projectLabel(navigationProject)
            }
            featureId={route.featureId}
            {...(route.view === undefined ? {} : { view: route.view })}
            {...(route.artifactId === undefined ? {} : { artifactId: route.artifactId })}
            onPlanDirtyChange={setPlanDirty}
            online={online}
            onNavigate={navigate}
            onAuthenticationError={handleAuthenticationBoundaryError}
            onFeatureRead={rememberFeature}
            onFeatureUnavailable={forgetFeature}
          />
        );
      case "not_found":
        return (
          <section className="workspace-state">
            <h1>Page not found</h1>
            <p>Choose Projects or Settings in the sidebar to continue.</p>
            <Button type="button" onClick={() => navigate({ kind: "projects" })}>
              Back to Projects
            </Button>
          </section>
        );
    }
  })();

  const sessionPaused = networkOnline && (sessionChecking || sessionCheckError !== null);
  return (
    <>
      {sessionPaused ? (
        <main className="login-main">
          <section className="system-state" aria-busy={sessionChecking}>
            <h1>{sessionChecking ? "Checking Operator session" : "Session check unavailable"}</h1>
            <p>
              Your unsaved edits are retained. The workspace resumes after session verification.
            </p>
            {sessionCheckError === null ? null : (
              <>
                <FormFeedback kind="error">{sessionCheckError}</FormFeedback>
                <Button onClick={() => setSessionCheckGeneration((current) => current + 1)}>
                  Retry session check
                </Button>
              </>
            )}
          </section>
        </main>
      ) : null}
      <WorkspaceSuspendedContext.Provider value={sessionPaused}>
        <div hidden={sessionPaused}>
          <OpenProjectForm
            key={`onboarding:${session.operator.id}/${session.credentialVersion}/${session.issuedAt}`}
            triggerContainer={openProjectTrigger}
            disabled={!online || projectPending}
            onAuthenticationError={handleAuthenticationBoundaryError}
            onOpened={handleProjectOpened}
          />
          <AuthenticatedShell
            key={`${session.operator.id}/${session.credentialVersion}/${session.issuedAt}`}

            error={projectError}
            inbox={projectInbox}
            loading={projectLoading}
            logoutDisabled={logoutPending || sessionCommandPending}
            logoutError={logoutError}
            logoutPending={logoutPending}
            online={online}
            openProjectControl={<div ref={setOpenProjectTrigger} />}
            route={route}
            projectFeatureIds={projectFeatureIds}
            projectNavigation={
              navigationProject === undefined ? null : (
                <FeatureNavigation
                  key={navigationProject.id}
                  projectId={navigationProject.id}
                  {...(route.kind === "feature" ? { selectedFeatureId: route.featureId } : {})}
                  online={online}
                  onNavigate={navigate}
                  onAuthenticationError={handleAuthenticationBoundaryError}
                />
              )
            }
            onClearLogoutError={() => setLogoutError(null)}
            onLogout={handleLogout}
            onNavigate={navigate}
            onRetry={() => setProjectReloadGeneration((generation) => generation + 1)}
          >
            {workspace}
          </AuthenticatedShell>
        </div>
      </WorkspaceSuspendedContext.Provider>
    </>
  );
}
